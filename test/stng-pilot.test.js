'use strict'

const test = require('node:test')
const assert = require('node:assert')
const ACEmulator = require('../lib/ac-emulator')

const quietApp = (selfPath) => ({
  debug () {},
  error () {},
  setPluginStatus () {},
  setPluginError () {},
  getSelfPath: selfPath || (() => null)
})

const boatnetSources = {
  'canbus-canboatjse': {
    0: {
      n2k: {
        manufacturerCode: 'Simrad',
        modelVersion: 'AC12 Autopilot',
        deviceClass: 'Steering and Control surfaces',
        deviceFunction: 150
      }
    },
    16: {
      n2k: {
        manufacturerCode: 'B & G',
        modelVersion: 'Zeus3S 12 Pilot Controller',
        deviceClass: 'Steering and Control surfaces',
        deviceFunction: 140
      }
    },
    115: {
      n2k: {
        manufacturerCode: 'Raymarine',
        modelId: 'E22158',
        modelVersion: 'SeaTalk-STNG-Converter',
        deviceClass: 'Internetwork device',
        deviceFunction: 20
      }
    }
  }
}

test('STNG converter is found by product name under both field spellings', () => {
  const ac = new ACEmulator(quietApp(), { acModel: 'AC12' })
  const found = ac.findStngConverter(boatnetSources)
  assert.ok(found)
  assert.strictEqual(found.src, 115)
  assert.match(found.label, /SeaTalk-STNG-Converter/)

  const title = {
    bus: {
      115: {
        n2k: {
          'Manufacturer Code': 'Raymarine',
          'Model Version': 'SeaTalk-STNG-Converter',
          'Device Class': 'Internetwork device',
          'Device Function': 20
        }
      }
    }
  }
  assert.strictEqual(ac.findStngConverter(title).src, 115)
})

test('refreshDevices treats the converter as S1 + Seatalk1 head, not the Zeus Pilot Controller', () => {
  const ac = new ACEmulator(quietApp(), { acModel: 'AC12' })
  ac.sk = { getSources (cb) { cb(null, boatnetSources) } }
  ac.refreshDevices()
  assert.strictEqual(ac.pilotKind, 'stng')
  assert.strictEqual(ac.pilotSrc, 115)
  assert.match(ac.pilotName, /SeaTalk-STNG-Converter/)
  assert.strictEqual(ac.controlHeadName, 'Seatalk1 control head')
  assert.strictEqual(ac.headSrc, 115)
  assert.strictEqual(ac.acuName, null)
})

test('126720 with Raymarine 3b,9f header latches the converter as the pilot', () => {
  const ac = new ACEmulator(quietApp(), { acModel: 'AC12' })
  ac.onRawFrame({
    pgn: { pgn: 126720, src: 115 },
    data: Buffer.from([0x40, 0x16, 0x3b, 0x9f, 0xf0, 0x81, 0x84, 0x00])
  })
  assert.strictEqual(ac.pilotSrc, 115)
  assert.strictEqual(ac.pilotKind, 'stng')
})

test('Evolution 65379 still outranks an STNG converter on the same bus', () => {
  const ac = new ACEmulator(quietApp(), { acModel: 'AC12' })
  ac.onPilotMode({
    pgn: { pgn: 65379, src: 204 },
    data: Buffer.from([0x3b, 0x9f, 0x00, 0x00])
  })
  ac.onRawFrame({
    pgn: { pgn: 126720, src: 115 },
    data: Buffer.from([0x40, 0x16, 0x3b, 0x9f, 0xf0, 0x81, 0x84, 0x00])
  })
  ac.sk = { getSources (cb) { cb(null, boatnetSources) } }
  ac.refreshDevices()
  assert.strictEqual(ac.pilotKind, '65379')
  assert.strictEqual(ac.pilotSrc, 204)
  assert.notStrictEqual(ac.controlHeadName, 'Seatalk1 control head')
})

test('Seatalk1 V1 state is read from 126720 / src 115, not the 65305 firehose', () => {
  const node = {
    value: 'standby',
    pgn: 65305,
    values: {
      'canbus-canboatjse.115': { value: 'auto', pgn: 126720 },
      'canbus-canboatjse.0': { value: 'standby', pgn: 65305 }
    }
  }
  const ac = new ACEmulator(quietApp(() => node), { acModel: 'AC12' })
  ac.pilotSrc = 115
  assert.strictEqual(ac.seatalkStateFromSk(), 'auto')
})

test('Seatalk1 locked heading (65360 / src 115) outranks the AC12 127237 compass echo', () => {
  const locked = 5.3341
  const compass = 5.3079
  const paths = {
    'steering.autopilot.target.headingMagnetic': {
      value: compass,
      pgn: 127237,
      values: {
        'canbus-canboatjse.115': { value: locked, pgn: 65360 },
        'canbus-canboatjse.0': { value: compass, pgn: 127237 }
      }
    },
    'steering.autopilot.target.headingMagnetic.value': compass,
    'steering.autopilot.target.value': compass
  }
  const ac = new ACEmulator(quietApp((p) => paths[p]), { acModel: 'AC12' })
  ac.pilotSrc = 115
  ac.pilotKind = 'stng'
  ac.state.skApState = 'auto'
  ac.state.lastSkStateMs = Date.now()
  assert.strictEqual(ac.seatalkHeadingTargetFromSk(), locked)
  assert.strictEqual(ac.apTargetRad('heading'), locked)
})

test('pinned converter winner is used when SK omits values', () => {
  const ac = new ACEmulator(quietApp((p) => {
    if (p === 'steering.autopilot.state') { return { value: 'auto', pgn: 126720 } }
    if (p === 'steering.autopilot.target.headingMagnetic') { return { value: 5.3341, pgn: 65360 } }
    return undefined
  }), { acModel: 'AC12' })
  ac.pilotSrc = 115
  assert.strictEqual(ac.seatalkStateFromSk(), 'auto')
  assert.strictEqual(ac.seatalkHeadingTargetFromSk(), 5.3341)
})

test('Seatalk1 state is read when getSelfPath unwraps to a string', () => {
  const ac = new ACEmulator(quietApp((p) => {
    if (p === 'steering.autopilot.state') { return 'auto' }
    if (p === 'steering.autopilot.state.value') { return 'auto' }
    return undefined
  }), { acModel: 'AC12' })
  ac.pilotSrc = 115
  assert.strictEqual(ac.seatalkStateFromSk(), 'auto')
})

test('pollState follows 126720 auto when V2 state is null', () => {
  const ac = new ACEmulator(quietApp((p) => {
    if (p === 'steering.autopilot.state') { return { value: 'auto', pgn: 126720, $source: 'canbus-canboatjse.115' } }
    return undefined
  }), { bridge: 'live', acModel: 'AC12' })
  ac.sk.token = 'test'
  ac.pilotSrc = 115
  ac.sk.getAutopilots = (cb) => cb(null, { raySTNGConv: { isDefault: true } })
  ac.sk.getState = (cb) => cb(null, null, null, {
    states: [
      { name: 'standby', engaged: false },
      { name: 'auto', engaged: true }
    ],
    modes: []
  })
  ac.pollState()
  assert.strictEqual(ac.state.skApState, 'auto')
  assert.strictEqual(ac.commandedMode, 'auto')
  assert.strictEqual(ac.currentMode(), 'auto')
})

test('pollState follows 126720 auto when V2 says standby', () => {
  const ac = new ACEmulator(quietApp((p) => {
    if (p === 'steering.autopilot.state') {
      return {
        value: 'standby',
        pgn: 65305,
        values: {
          'canbus-canboatjse.115': { value: 'auto', pgn: 126720 },
          'canbus-canboatjse.0': { value: 'standby', pgn: 65305 }
        }
      }
    }
    return undefined
  }), { bridge: 'live', acModel: 'AC12' })
  ac.sk.token = 'test'
  ac.pilotKind = 'stng'
  ac.pilotSrc = 115
  ac.sk.getAutopilots = (cb) => cb(null, { raySTNGConv: { isDefault: true } })
  ac.sk.getState = (cb) => cb(null, 'standby', null, {
    states: [
      { name: 'standby', engaged: false },
      { name: 'auto', engaged: true }
    ],
    modes: []
  })
  ac.pollState()
  assert.strictEqual(ac.state.skApState, 'auto')
  assert.strictEqual(ac.commandedMode, 'auto')
  assert.strictEqual(ac.currentMode(), 'auto')
})

// emulate.js log: 16,3b,9f,f0,81,84,36,d1,33,42,... → heading hold engaged.
function feedStngPilotMode (ac, modeByte) {
  ac.onRawFrame({
    pgn: { pgn: 126720, src: 115 },
    data: Buffer.from([0x00, 0x16, 0x3b, 0x9f, 0xf0, 0x81, 0x84, 0x36])
  })
  ac.onRawFrame({
    pgn: { pgn: 126720, src: 115 },
    data: Buffer.from([0x01, 0xd1, 0x33, modeByte, 0x00, 0xf3, 0x02, 0x06])
  })
  ac.onRawFrame({
    pgn: { pgn: 126720, src: 115 },
    data: Buffer.from([0x02, 0x8a, 0x91, 0xd6, 0xaf, 0x66, 0x01, 0x22])
  })
  ac.onRawFrame({
    pgn: { pgn: 126720, src: 115 },
    data: Buffer.from([0x03, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff])
  })
}

test('126720 0x84 heading-hold sets auto before any SK poll', () => {
  const ac = new ACEmulator(quietApp(), { bridge: 'live', acModel: 'AC12' })
  feedStngPilotMode(ac, 0x42)
  assert.strictEqual(ac.pilotKind, 'stng')
  assert.strictEqual(ac.stngMode, 'auto')
  assert.strictEqual(ac.commandedMode, 'auto')
  assert.strictEqual(ac.currentMode(), 'auto')
  assert.strictEqual(ac.state.skApState, 'auto')
})

test('canonical 65305 standby does not override a fresh 126720 auto', () => {
  const ac = new ACEmulator(quietApp((p) => {
    if (p === 'steering.autopilot.state') {
      return { value: 'standby', pgn: 65305 }
    }
    return undefined
  }), { bridge: 'live', acModel: 'AC12' })
  ac.sk.token = 'test'
  ac.sk.getAutopilots = (cb) => cb(null, { raySTNGConv: { isDefault: true } })
  ac.sk.getState = (cb) => cb(null, 'standby', null, {
    states: [
      { name: 'standby', engaged: false },
      { name: 'auto', engaged: true }
    ],
    modes: []
  })
  feedStngPilotMode(ac, 0x42)
  ac.pollState()
  assert.strictEqual(ac.seatalkStateFromSk(), 'auto')
  assert.strictEqual(ac.commandedMode, 'auto')
  assert.strictEqual(ac.currentMode(), 'auto')
})

test('auto 65305 announces 00,1d then keeps 00,0a status', () => {
  const ac = new ACEmulator(quietApp(), { bridge: 'live', acModel: 'AC12' })
  ac.bootDone = true
  ac.commandedMode = 'auto'
  ac.state.skApState = 'auto'
  ac.state.lastSkStateMs = Date.now()
  const sent = []
  ac.send = (prio, pgn, bytes) => sent.push(bytes)
  ac.send65305()
  assert.ok(sent.includes('41,9f,00,1d,81,00,00,00'))
  assert.ok(sent.includes('41,9f,00,1d,80,00,00,00'))
  assert.ok(sent.includes('41,9f,00,0a,16,00,00,00'))
  sent.length = 0
  ac.send65305()
  assert.ok(!sent.some((b) => b.startsWith('41,9f,00,1d')))
  assert.ok(sent.includes('41,9f,00,0a,16,00,00,00'))
})

test('AC12 firehose1Hz emits 65340 auto', () => {
  const ac = new ACEmulator(quietApp(), { bridge: 'live', acModel: 'AC12', enableFirehose: true })
  ac.bootDone = true
  ac.commandedMode = 'auto'
  const sent = []
  ac.send = (prio, pgn, bytes) => sent.push({ pgn, bytes })
  ac.firehose1Hz()
  assert.ok(sent.some((s) => s.pgn === 65340 && s.bytes === '41,9f,10,01,fe,fa,00,80'))
})

test('AC 127250 is sent with enableStdPgns off, like emulate.js', () => {
  const heading = 5.3254
  const ac = new ACEmulator(quietApp((p) => (
    p === 'navigation.headingMagnetic.value' ? heading : undefined
  )), { acModel: 'AC12', enableStdPgns: false })
  ac.bootDone = true
  const sent = []
  ac.send = (prio, pgn, bytes) => sent.push({ prio, pgn, bytes })
  ac.send127250()
  assert.strictEqual(sent.length, 1)
  assert.strictEqual(sent[0].pgn, 127250)
  assert.strictEqual(sent[0].prio, 3)
  assert.strictEqual(sent[0].bytes, `00,${ac.rad16(heading)},ff,7f,ff,7f,fd`)
})

test('65341 field 0x0b is 00,00 (computer present)', () => {
  const ac = new ACEmulator(quietApp(), { acModel: 'AC12', enableFirehose: true })
  ac.bootDone = true
  const sent = []
  ac.send = (prio, pgn, bytes) => sent.push({ pgn, bytes })
  ac.send65341Extras()
  const b = sent.find((s) => s.bytes.startsWith('41,9f,ff,ff,0b,'))
  assert.ok(b)
  assert.strictEqual(b.bytes, '41,9f,ff,ff,0b,ff,00,00')
})

test('mode firehose does not wait for 126720', () => {
  const ac = new ACEmulator(quietApp(), { bridge: 'live', acModel: 'AC12', enableFirehose: true })
  ac.bootDone = true
  const sent = []
  ac.send = (prio, pgn, bytes) => sent.push({ pgn, bytes })
  ac.firehose2Hz()
  assert.ok(sent.some((s) => s.pgn === 65305))
})

test('replayModeEdge paints standby then auto without commanding the S1', async () => {
  const ac = new ACEmulator(quietApp(), { bridge: 'live', acModel: 'AC12', enableFirehose: true })
  ac.bootDone = true
  ac.commandedMode = 'auto'
  ac.state.skApState = 'auto'
  ac.state.lastSkStateMs = Date.now()
  const sent = []
  ac.send = (prio, pgn, bytes) => sent.push({ pgn, bytes })
  ac.replayModeEdge()
  assert.strictEqual(ac.commandedMode, 'auto')
  assert.ok(sent.some((s) => s.pgn === 65305 && s.bytes === '41,9f,00,0a,0a,00,00,00'))
  assert.ok(sent.some((s) => s.pgn === 65340 && s.bytes === '41,9f,00,00,fe,f8,00,80'))
  await new Promise((r) => setTimeout(r, 600))
  assert.strictEqual(ac.commandedMode, 'auto')
  assert.ok(sent.some((s) => s.bytes === '41,9f,00,0a,16,00,00,00'))
  assert.ok(sent.some((s) => s.bytes === '41,9f,00,1d,81,00,00,00'))
})

test('mode-edge replay arms once, then again when the MFD comes back', () => {
  const ac = new ACEmulator(quietApp(), { bridge: 'live', acModel: 'AC12', enableFirehose: true })
  ac.bootDone = true
  ac.commandedMode = 'auto'
  ac.armModeEdgeReplay()
  ac.armModeEdgeReplay()
  assert.strictEqual(ac.modeEdgeArmed, true)
  ac.mfdSrcs = [16]
  ac.seen[16] = Date.now() - 10000
  ac.lastMfdPresence = 'offline'
  ac.seen[16] = Date.now()
  ac.modeEdgeArmed = true
  ac.watchMfdForModeEdge()
  assert.strictEqual(ac.modeEdgeArmed, true)
  assert.strictEqual(ac.lastMfdPresence, 'online')
})
