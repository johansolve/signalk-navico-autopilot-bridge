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

test('STNG wind 65341 waits for 0x84 instead of painting live AWA/TWA', () => {
  const heading = 5.0198
  const awa = 0.3
  const ac = new ACEmulator(quietApp((p) => {
    if (p === 'steering.autopilot.target.value') { return heading }
    if (p === 'environment.wind.angleApparent.value') { return awa }
    return undefined
  }), { acModel: 'AC12' })
  ac.pilotKind = 'stng'
  ac.commandedMode = 'wind'
  ac.state.skApState = 'wind'
  ac.state.lastSkStateMs = Date.now()
  assert.strictEqual(ac.apTargetRad('wind'), null)
  assert.strictEqual(ac.windTargetRad(), null)
  const sent = []
  ac.send = (prio, pgn, bytes) => sent.push({ pgn, bytes })
  ac.send65341()
  assert.strictEqual(sent.length, 1)
  assert.strictEqual(sent[0].bytes, '41,9f,ff,ff,03,ff,ff,ff')
})

test('STNG Wind engage 65341 follows 0x84, not a rounded live AWA', () => {
  const live = 306.4 * Math.PI / 180
  const lock = 53558 * 0.0001
  const ac = new ACEmulator(quietApp((p) => {
    if (p === 'environment.wind.angleApparent.value') { return live }
    return undefined
  }), { acModel: 'AC12' })
  ac.pilotKind = 'stng'
  ac.commandedMode = 'wind'
  ac.state.skApState = 'wind'
  ac.state.lastSkStateMs = Date.now()
  ac.send65341()
  feed84(ac, lock)
  const sent = []
  ac.send = (prio, pgn, bytes) => sent.push({ pgn, bytes })
  ac.send65341()
  assert.ok(Math.abs(ac.windDatumRad - lock) < 1e-4)
  assert.strictEqual(sent[0].bytes, `41,9f,ff,ff,03,ff,${ac.rad16(lock)}`)
})

test('STNG ±1 updates the locked wind angle Zeus reads on 65341', () => {
  const ac = new ACEmulator(quietApp(), { acModel: 'AC12' })
  ac.pilotKind = 'stng'
  ac.commandedMode = 'wind'
  ac.windDatumRad = ac.unsignedRad(17 * Math.PI / 180)
  ac.windDatumAt = Date.now()
  ac.stngWindLock = true
  ac.nudgeStngWindLock(Math.PI / 180)
  const sent = []
  ac.send = (prio, pgn, bytes) => sent.push({ pgn, bytes })
  ac.send65341()
  assert.strictEqual(sent[0].bytes, `41,9f,ff,ff,03,ff,${ac.rad16(18 * Math.PI / 180)}`)
})

test('126720 0x84 caches the Seatalk1 wind lock', () => {
  const ac = new ACEmulator(quietApp(), { acModel: 'AC12' })
  feed84(ac, 53558 * 0.0001)
  assert.strictEqual(ac.pilotKind, 'stng')
  assert.ok(ac.stngWindLock)
  assert.ok(Math.abs(ac.windDatumRad - 5.3558) < 1e-4)
})

test('126720 0x7f does not become the wind lock', () => {
  const ac = new ACEmulator(quietApp(), { acModel: 'AC12' })
  feed7f(ac, 36257 * 0.0001)
  assert.strictEqual(ac.pilotKind, 'stng')
  assert.strictEqual(ac.windDatumRad, null)
  assert.ok(!ac.stngWindLock)
})

function stngWindAc () {
  const ac = new ACEmulator(quietApp(), { bridge: 'live', acModel: 'AC12' })
  ac.sk.token = 'test'
  ac.pilotKind = 'stng'
  ac.commandedMode = 'wind'
  ac.state.skApState = 'wind'
  ac.state.lastSkStateMs = Date.now()
  ac.windDatumRad = ac.unsignedRad(83 * Math.PI / 180)
  ac.windDatumAt = Date.now()
  ac.stngWindLock = true
  return ac
}

function feedStngKey (ac, keyHex) {
  const kb = keyHex.split(',').map((h) => parseInt(h, 16))
  const payload = [0x3b, 0x9f, 0xf0, 0x81, 0x86, 0x21, kb[0], kb[1], 0x07, 0x01, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00]
  ac.onRawFrame({
    pgn: { pgn: 126720, src: 115 },
    data: Buffer.from([0x00, payload.length, ...payload.slice(0, 6)])
  })
  ac.onRawFrame({
    pgn: { pgn: 126720, src: 115 },
    data: Buffer.from([0x01, ...payload.slice(6)])
  })
}

function feed7f (ac, rad) {
  const raw = Math.round(rad / 0.0001)
  ac.onRawFrame({
    pgn: { pgn: 126720, src: 115 },
    data: Buffer.from([0x00, 0x08, 0x3b, 0x9f, 0xf0, 0x81, 0x7f, raw & 0xff])
  })
  ac.onRawFrame({
    pgn: { pgn: 126720, src: 115 },
    data: Buffer.from([0x01, (raw >> 8) & 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  })
}

function feed84 (ac, rad, modeByte) {
  const raw = Math.round(rad / 0.0001) & 0xffff
  const mode = modeByte === undefined ? 0x46 : modeByte
  const payload = [0x3b, 0x9f, 0xf0, 0x81, 0x84, raw & 0xff, (raw >> 8) & 0xff, 0x33, mode, 0x00, 0xeb, 0x02, 0x06]
  ac.onRawFrame({
    pgn: { pgn: 126720, src: 115 },
    data: Buffer.from([0x00, payload.length, ...payload.slice(0, 6)])
  })
  ac.onRawFrame({
    pgn: { pgn: 126720, src: 115 },
    data: Buffer.from([0x01, ...payload.slice(6)])
  })
}

function zeusCourse (ac, dirByte) {
  ac.state.lastApRaw = {
    src: 16,
    at: Date.now(),
    group: 0x0a,
    key: 0x1a,
    hex: '41,9f,23,ff,ff,0a,1a,00,' + dirByte + ',ae,00,00'
  }
  ac.handleIncomingAP({ pgn: 130850, src: 16, dst: 255, fields: {} })
}

function zeusPlus1 (ac) { zeusCourse(ac, '03') }
function zeusMinus1 (ac) { zeusCourse(ac, '02') }

function stngAutoAc () {
  const ac = new ACEmulator(quietApp(), { bridge: 'live', acModel: 'AC12' })
  ac.sk.token = 'test'
  ac.pilotKind = 'stng'
  ac.commandedMode = 'auto'
  ac.state.skApState = 'auto'
  ac.state.lastSkStateMs = Date.now()
  ac.pilotSrc = 115
  return ac
}

test('STNG heading hold Zeus −1 sends Seatalk 05,fa without V2', () => {
  const ac = stngAutoAc()
  const tx = []
  const v2 = []
  ac.send = (prio, pgn, bytes, dst) => tx.push({ prio, pgn, bytes, dst })
  ac.applyV2 = (desc) => v2.push(desc)
  zeusMinus1(ac)
  assert.strictEqual(tx.length, 1)
  assert.ok(tx[0].bytes.includes('86,21,05,fa'))
  assert.strictEqual(tx[0].dst, 115)
  assert.deepStrictEqual(v2, [])
})

test('STNG heading hold Zeus +10 sends Seatalk 08,f7', () => {
  const ac = stngAutoAc()
  const tx = []
  ac.send = (prio, pgn, bytes, dst) => tx.push({ prio, pgn, bytes, dst })
  ac.state.lastApRaw = {
    src: 16,
    at: Date.now(),
    group: 0x0a,
    key: 0x1a,
    hex: '41,9f,23,ff,ff,0a,1a,00,03,d1,06,00'
  }
  ac.handleIncomingAP({ pgn: 130850, src: 16, dst: 255, fields: {} })
  assert.strictEqual(tx.length, 1)
  assert.ok(tx[0].bytes.includes('86,21,08,f7'))
})

test('STNG heading hold does not invert Zeus −1', () => {
  const ac = stngAutoAc()
  ac.windDatumRad = ac.unsignedRad(307 * Math.PI / 180)
  ac.stngWindLock = true
  const tx = []
  ac.send = (prio, pgn, bytes, dst) => tx.push({ prio, pgn, bytes, dst })
  zeusMinus1(ac)
  assert.ok(tx[0].bytes.includes('86,21,05,fa'))
  assert.strictEqual(Math.round(ac.windDatumRad * 180 / Math.PI), 307)
})

function feed65360 (ac, magRad) {
  const mag = Math.round(magRad / 0.0001) & 0xffff
  ac.onRawFrame({
    pgn: { pgn: 65360, src: 115 },
    data: Buffer.from([0x3b, 0x9f, 0xff, 0xff, 0xff, mag & 0xff, (mag >> 8) & 0xff, 0xff])
  })
}

test('STNG heading 65341 waits for 65360 instead of painting live compass', () => {
  const compass = 5.0198
  const ac = new ACEmulator(quietApp((p) => {
    if (p === 'navigation.headingMagnetic.value') { return compass }
    return undefined
  }), { acModel: 'AC12' })
  ac.pilotKind = 'stng'
  ac.commandedMode = 'auto'
  ac.state.skApState = 'auto'
  ac.state.lastSkStateMs = Date.now()
  ac.pilotSrc = 115
  assert.strictEqual(ac.apTargetRad('heading'), null)
  const sent = []
  ac.send = (prio, pgn, bytes) => sent.push({ pgn, bytes })
  ac.send65341()
  assert.strictEqual(sent[0].bytes, '41,9f,ff,ff,02,ff,ff,ff')
})

test('STNG heading 65360 on CAN is the 65341 lock Zeus reads', () => {
  const lock = 5.3341
  const ac = stngAutoAc()
  feed65360(ac, lock)
  assert.ok(Math.abs(ac.headingDatumRad - lock) < 1e-4)
  const sent = []
  ac.send = (prio, pgn, bytes) => sent.push({ pgn, bytes })
  ac.send65341()
  assert.strictEqual(sent[0].bytes, `41,9f,ff,ff,02,ff,${ac.rad16(lock)}`)
})

test('STNG heading hold Zeus −1 nudges the locked heading one degree', () => {
  const ac = stngAutoAc()
  feed65360(ac, 180 * Math.PI / 180)
  const tx = []
  ac.send = (prio, pgn, bytes, dst) => tx.push({ prio, pgn, bytes, dst })
  zeusMinus1(ac)
  assert.strictEqual(Math.round(ac.headingDatumRad * 180 / Math.PI), 179)
  assert.ok(tx[0].bytes.includes('86,21,05,fa'))
  const sent = []
  ac.send = (prio, pgn, bytes) => sent.push({ pgn, bytes })
  ac.send65341()
  assert.strictEqual(sent[0].bytes, `41,9f,ff,ff,02,ff,${ac.rad16(ac.headingDatumRad)}`)
})

test('STNG heading ±1 still sends Seatalk when V2 poll says standby', () => {
  const ac = stngAutoAc()
  ac.state.skApState = 'standby'
  const tx = []
  ac.send = (prio, pgn, bytes, dst) => tx.push({ prio, pgn, bytes, dst })
  zeusMinus1(ac)
  assert.strictEqual(tx.length, 1)
  assert.ok(tx[0].bytes.includes('86,21,05,fa'))
})

test('STNG stale 65360 does not overwrite a Zeus heading nudge', () => {
  const ac = stngAutoAc()
  feed65360(ac, 180 * Math.PI / 180)
  zeusMinus1(ac)
  assert.strictEqual(Math.round(ac.headingDatumRad * 180 / Math.PI), 179)
  feed65360(ac, 180 * Math.PI / 180)
  assert.strictEqual(Math.round(ac.headingDatumRad * 180 / Math.PI), 179)
  feed65360(ac, 179 * Math.PI / 180)
  assert.strictEqual(Math.round(ac.headingDatumRad * 180 / Math.PI), 179)
  assert.strictEqual(ac.stngHeadingDirty, false)
})
test('STNG 0x7f heartbeat does not move an existing lock', () => {
  const ac = stngWindAc()
  feed7f(ac, ac.unsignedRad(80 * Math.PI / 180))
  assert.strictEqual(Math.round(ac.windDatumRad * 180 / Math.PI), 83)
})

test('STNG 65341 field 03 uses 0x84 lock not 0x7f', () => {
  const ac = new ACEmulator(quietApp(), { acModel: 'AC12' })
  ac.pilotKind = 'stng'
  ac.commandedMode = 'wind'
  ac.state.skApState = 'wind'
  ac.state.lastSkStateMs = Date.now()
  feed7f(ac, 36257 * 0.0001)
  feed84(ac, 53558 * 0.0001)
  const sent = []
  ac.send = (prio, pgn, bytes) => sent.push({ pgn, bytes })
  ac.send65341()
  assert.strictEqual(sent[0].bytes, `41,9f,ff,ff,03,ff,${ac.rad16(5.3558)}`)
})

test('STNG webapp Seatalk +1 nudges the lock one degree without a second V2', () => {
  const ac = stngWindAc()
  const v2 = []
  ac.applyV2 = (desc) => v2.push(desc)
  feedStngKey(ac, '07,f8')
  assert.strictEqual(Math.round(ac.windDatumRad * 180 / Math.PI), 84)
  assert.deepStrictEqual(v2, [])
})

test('STNG Zeus ChangeCourse plus Seatalk 07,f8 is still one degree', () => {
  const ac = stngWindAc()
  const tx = []
  ac.send = (prio, pgn, bytes, dst) => tx.push({ prio, pgn, bytes, dst })
  zeusPlus1(ac)
  feedStngKey(ac, '07,f8')
  feed7f(ac, ac.unsignedRad(86 * Math.PI / 180))
  assert.strictEqual(tx.filter((t) => t.pgn === 126720).length, 1)
  assert.strictEqual(Math.round(ac.windDatumRad * 180 / Math.PI), 84)
})

test('STNG ChangeCourse 400ms after 0x7f is a real Zeus click, 1 degree', () => {
  const ac = stngWindAc()
  feed7f(ac, ac.unsignedRad(83 * Math.PI / 180))
  ac.stngWind7fAt = Date.now() - 400
  const tx = []
  ac.send = (prio, pgn, bytes, dst) => tx.push({ prio, pgn, bytes, dst })
  zeusPlus1(ac)
  assert.strictEqual(tx.length, 1)
  assert.strictEqual(tx[0].pgn, 126720)
  assert.ok(tx[0].bytes.includes('86,21,07,f8'))
  assert.strictEqual(tx[0].dst, 115)
  assert.strictEqual(Math.round(ac.windDatumRad * 180 / Math.PI), 84)
})

test('STNG Zeus −1 sends Seatalk 05,fa without inverting', () => {
  const ac = stngWindAc()
  const tx = []
  ac.send = (prio, pgn, bytes, dst) => tx.push({ prio, pgn, bytes, dst })
  zeusMinus1(ac)
  assert.strictEqual(tx.length, 1)
  assert.ok(tx[0].bytes.includes('86,21,05,fa'))
  assert.strictEqual(Math.round(ac.windDatumRad * 180 / Math.PI), 82)
})

test('STNG Zeus −1 on port tack inverts 65341 (307→308) so signed |AWA| follows the − button', () => {
  const ac = stngWindAc()
  ac.windDatumRad = ac.unsignedRad(307 * Math.PI / 180)
  ac.pilotSrc = 115
  const tx = []
  ac.send = (prio, pgn, bytes, dst) => tx.push({ prio, pgn, bytes, dst })
  zeusMinus1(ac)
  assert.strictEqual(tx.length, 1)
  assert.ok(tx[0].bytes.includes('86,21,07,f8'))
  assert.strictEqual(Math.round(ac.windDatumRad * 180 / Math.PI), 308)
})

test('STNG Zeus minus on port (−34) via ChangeCourse + byte is −35', () => {
  const ac = stngWindAc()
  ac.windDatumRad = ac.unsignedRad(326 * Math.PI / 180)
  ac.pilotSrc = 115
  const tx = []
  ac.send = (prio, pgn, bytes, dst) => tx.push({ prio, pgn, bytes, dst })
  zeusPlus1(ac)
  assert.strictEqual(Math.round(ac.windDatumRad * 180 / Math.PI), 325)
  assert.ok(tx[0].bytes.includes('86,21,05,fa'))
})

test('STNG stale 0x84 does not restore the lock after Zeus −1', () => {
  const ac = stngWindAc()
  ac.windDatumRad = ac.unsignedRad(307 * Math.PI / 180)
  ac.send = () => {}
  zeusMinus1(ac)
  assert.strictEqual(Math.round(ac.windDatumRad * 180 / Math.PI), 308)
  feed84(ac, 307 * Math.PI / 180)
  assert.strictEqual(Math.round(ac.windDatumRad * 180 / Math.PI), 308)
})

test('STNG 0x84 that matches the nudged lock is accepted', () => {
  const ac = stngWindAc()
  ac.windDatumRad = ac.unsignedRad(307 * Math.PI / 180)
  ac.send = () => {}
  zeusMinus1(ac)
  feed84(ac, 308 * Math.PI / 180)
  assert.strictEqual(Math.round(ac.windDatumRad * 180 / Math.PI), 308)
  assert.ok(!ac.stngWindDirty)
})

test('STNG rapid Zeus −1 clicks each move one degree', () => {
  const ac = stngWindAc()
  ac.windDatumRad = ac.unsignedRad(307 * Math.PI / 180)
  ac.send = () => {}
  zeusMinus1(ac)
  ac.stngCourseAt = Date.now() - 250
  zeusMinus1(ac)
  ac.stngCourseAt = Date.now() - 250
  zeusMinus1(ac)
  assert.strictEqual(Math.round(ac.windDatumRad * 180 / Math.PI), 310)
})

test('STNG duplicate ChangeCourse frames only apply one degree', () => {
  const ac = stngWindAc()
  const tx = []
  ac.send = (prio, pgn, bytes, dst) => tx.push({ prio, pgn, bytes, dst })
  zeusPlus1(ac)
  zeusPlus1(ac)
  zeusPlus1(ac)
  assert.strictEqual(tx.length, 1)
  assert.strictEqual(Math.round(ac.windDatumRad * 180 / Math.PI), 84)
})

test('STNG 0x7f after Zeus ChangeCourse does not add extra degrees', () => {
  const ac = stngWindAc()
  const tx = []
  ac.send = (prio, pgn, bytes, dst) => tx.push({ prio, pgn, bytes, dst })
  zeusPlus1(ac)
  feed7f(ac, ac.unsignedRad(86 * Math.PI / 180))
  assert.strictEqual(tx.length, 1)
  assert.strictEqual(Math.round(ac.windDatumRad * 180 / Math.PI), 84)
})

test('STNG stale ChangeCourse raw from the previous press is not reused', () => {
  const ac = stngWindAc()
  const tx = []
  ac.send = (prio, pgn, bytes, dst) => tx.push({ prio, pgn, bytes, dst })
  ac.state.lastApRaw = {
    src: 16,
    at: Date.now() - 600,
    group: 0x0a,
    key: 0x1a,
    hex: '41,9f,23,ff,ff,0a,1a,00,02,ae,00,00'
  }
  ac.handleIncomingAP({ pgn: 130850, src: 16, dst: 255, fields: {} })
  assert.deepStrictEqual(tx, [])
  assert.strictEqual(Math.round(ac.windDatumRad * 180 / Math.PI), 83)
})

test('STNG ChangeCourse applies when the raw packet completes without a parsed PGN', () => {
  const ac = stngWindAc()
  const tx = []
  ac.send = (prio, pgn, bytes, dst) => tx.push({ prio, pgn, bytes, dst })
  const payload = [0x41, 0x9f, 0x23, 0xff, 0xff, 0x0a, 0x1a, 0x00, 0x03, 0xae, 0x00, 0x00]
  ac.onRawFrame({
    pgn: { pgn: 130850, src: 16, dst: 255 },
    data: Buffer.from([0x00, payload.length, ...payload.slice(0, 6)])
  })
  ac.onRawFrame({
    pgn: { pgn: 130850, src: 16, dst: 255 },
    data: Buffer.from([0x01, ...payload.slice(6)])
  })
  assert.strictEqual(tx.length, 1)
  assert.ok(tx[0].bytes.includes('86,21,07,f8'))
  assert.strictEqual(Math.round(ac.windDatumRad * 180 / Math.PI), 84)
})
