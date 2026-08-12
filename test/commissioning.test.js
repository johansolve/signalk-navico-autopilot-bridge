'use strict'

const test = require('node:test')
const assert = require('node:assert')
const ACEmulator = require('../lib/ac-emulator')

// Commissioning parameter 65, the boat type: the one commissioning value with a visible
// effect on the MFD (the turn patterns versus the sailing Tack control). Wire values are
// 0 Sail, 1 Outboard, 2 Displacement, 3 Planing.
const BOAT_TYPE_KEY = 0x0a18
const OTHER_KEY = 0x0918
const AC_ADDR = 35

// A 130845 as the MFD sends it, in the two fast-packet frames the tap reassembles:
//   41 9f <ac> ff ff ff <klo> <khi> 00 <op> <value>
function frames (key, op, value, src = 7) {
  const payload = [0x41, 0x9f, AC_ADDR, 0xff, 0xff, 0xff,
                   key & 0xff, (key >> 8) & 0xff, 0x00, op, value]
  return [
    { pgn: { pgn: 130845, src, dst: AC_ADDR }, data: Buffer.from([0x00, payload.length, ...payload.slice(0, 6)]) },
    { pgn: { pgn: 130845, src, dst: AC_ADDR }, data: Buffer.from([0x01, ...payload.slice(6)]) }
  ]
}

function emulator (options) {
  const ac = new ACEmulator({ debug () {} }, Object.assign({ bridge: 'dry-run' }, options))
  // start() would need canboatjs and a live CAN interface; the commissioning path under
  // test only needs an address to answer from and somewhere to put the reply.
  ac.myAddr = () => AC_ADDR
  ac.sent = []
  ac.canbus = { sendPGN: (s) => ac.sent.push(s) }
  return ac
}

// Drive one MFD request all the way through: the raw tap, which reads the op byte and the
// key off the wire, and then the parsed PGN, which answers it -- as onRawFrame and
// handleIncoming do on the bus. `parsedKey` is what canboatjs put in the parsed field,
// which for a key its dictionary names is that name rather than the number.
function request (ac, key, op, value, { src = 7, parsedKey = key } = {}) {
  for (const f of frames(key, op, value, src)) { ac.onRawFrame(f) }
  ac.reply130845({ pgn: 130845, src, fields: { address: AC_ADDR, key: parsedKey } })
}

// The single value byte of the last reply: payload 41,9f,<ac>,ff,ff,ff,<klo>,<khi>,00,02,<value>
function replied (ac) {
  const p = ac.sent[ac.sent.length - 1].split(',').slice(6)
  return parseInt(p[10], 16)
}

test('the configured boat type is what the MFD reads back', () => {
  for (const [configured, wire] of [['Sail', 0], ['Outboard', 1], ['Displacement', 2], ['Planing', 3]]) {
    const ac = emulator({ boatType: configured })
    request(ac, BOAT_TYPE_KEY, 0x00, 0x00)
    assert.strictEqual(replied(ac), wire, configured)
  }
})

test('no boat type configured leaves the captured AC42 value alone', () => {
  for (const configured of [undefined, '', 'Trimaran', 9]) {
    const ac = emulator({ boatType: configured })
    request(ac, BOAT_TYPE_KEY, 0x00, 0x00)
    assert.strictEqual(replied(ac), 0, String(configured))
  }
})

test('a write from the dockside wizard is applied, not answered with the old value', () => {
  const saved = []
  const ac = emulator({ boatType: 'Sail', onBoatTypeChange: (n) => saved.push(n) })
  request(ac, BOAT_TYPE_KEY, 0x01, 0x02)          // set Displacement
  assert.strictEqual(replied(ac), 2)              // answered with what was written
  assert.strictEqual(ac.boatType, 2)
  assert.deepStrictEqual(saved, ['Displacement']) // and handed back for the plugin config
  request(ac, BOAT_TYPE_KEY, 0x00, 0x00)          // reopening the wizard reads it back
  assert.strictEqual(replied(ac), 2)
  assert.deepStrictEqual(saved, ['Displacement']) // and an unchanged value is not re-saved
})

test('a read is never mistaken for a write', () => {
  const ac = emulator({ boatType: 'Planing' })
  request(ac, BOAT_TYPE_KEY, 0x00, 0x00)
  assert.strictEqual(replied(ac), 3)
  assert.strictEqual(ac.boatType, 3)
})

test('a write to another key does not move the boat type', () => {
  const saved = []
  const ac = emulator({ boatType: 'Planing', onBoatTypeChange: (n) => saved.push(n) })
  request(ac, OTHER_KEY, 0x01, 0x07)
  assert.strictEqual(replied(ac), 7)              // the other key took the write
  assert.strictEqual(ac.boatType, 3)              // the boat type did not
  assert.deepStrictEqual(saved, [])
  request(ac, BOAT_TYPE_KEY, 0x00, 0x00)
  assert.strictEqual(replied(ac), 3)
})

test('a stale raw record is not applied to a later read', () => {
  const ac = emulator({ boatType: 'Sail' })
  for (const f of frames(BOAT_TYPE_KEY, 0x01, 0x03)) { ac.onRawFrame(f) }
  ac.lastCommissionRaw.at -= 5000                 // the write frame is a lifetime ago
  ac.reply130845({ pgn: 130845, src: 7, fields: { address: AC_ADDR, key: BOAT_TYPE_KEY } })
  assert.strictEqual(replied(ac), 0)
  assert.strictEqual(ac.boatType, 0)
})

test('a record from another device is not applied either', () => {
  const ac = emulator({ boatType: 'Sail' })
  for (const f of frames(BOAT_TYPE_KEY, 0x01, 0x03, 9)) { ac.onRawFrame(f) }
  ac.reply130845({ pgn: 130845, src: 7, fields: { address: AC_ADDR, key: BOAT_TYPE_KEY } })
  assert.strictEqual(replied(ac), 0)
})

// canboatjs renders 130845's key through canboat's dynamic-key dictionary, so a key it has
// a name for arrives as that name. The number is taken off the wire instead.
test('a key canboatjs names rather than numbers is still read and written', () => {
  const ac = emulator({ boatType: 'Sail' })
  request(ac, BOAT_TYPE_KEY, 0x00, 0x00, { parsedKey: 'Boat type' })
  assert.strictEqual(replied(ac), 0)
  request(ac, BOAT_TYPE_KEY, 0x01, 0x03, { parsedKey: 'Boat type' })
  assert.strictEqual(replied(ac), 3)
  assert.strictEqual(ac.boatType, 3)
})

test('the reply keeps the captured row width', () => {
  const ac = emulator({ boatType: 'Sail' })
  request(ac, BOAT_TYPE_KEY, 0x01, 0x03)
  const len = ac.sent[ac.sent.length - 1].split(',').slice(6).length
  assert.strictEqual(len, 14)                     // 41,9f,<ac> + the 11-byte row
})
