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
