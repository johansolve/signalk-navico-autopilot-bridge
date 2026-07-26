'use strict'

const test = require('node:test')
const assert = require('node:assert')
const ACEmulator = require('../lib/ac-emulator')

// Regression guard for the silent 3.x button drop: the decode read the group and
// key out of canboatjs 2.10's field names (fields.Event / fields["Unused B"]),
// which 3.x does not produce -- so on a 3.x host every MFD button was counted and
// then dropped as "non-AP-group (ignored)" while the plugin looked healthy.
// Both decodes are now driven off the raw frame, which is version-independent.
//
// A real Vulcan standby press, as one fast-packet sequence: frame 0 carries the
// total length (12) then the first 6 bytes, frame 1 the remaining 6.
// Payload: 41,9f,<ac>,ff,ff,0a,<key>,00,ff,ff,ff,ff -- group 0x0a at byte 5.
function pressFrames (key, src = 7) {
  const payload = [0x41, 0x9f, 0x23, 0xff, 0xff, 0x0a, key, 0x00, 0xff, 0xff, 0xff, 0xff]
  return [
    { pgn: { pgn: 130850, src, dst: 255 }, data: Buffer.from([0x00, payload.length, ...payload.slice(0, 6)]) },
    { pgn: { pgn: 130850, src, dst: 255 }, data: Buffer.from([0x01, ...payload.slice(6)]) }
  ]
}

function emulator () {
  const ac = new ACEmulator({ debug () {} }, { bridge: 'dry-run' })
  // start() would need canboatjs and a live CAN interface; the decode path under
  // test only needs the frame handlers and the state they share.
  ac.sk.token = null
  return ac
}

function press (ac, key, src) {
  for (const f of pressFrames(key, src)) { ac.onRawFrame(f) }
}

test('decodes a button from the raw frame when canboat 3.x field names are present', () => {
  const ac = emulator()
  press(ac, 0x06)
  // canboatjs 3.x fields: no Event, no "Unused B" -- a field-only decode drops this.
  ac.handleIncomingAP({
    pgn: 130850,
    src: 7,
    fields: { manufacturerCode: 'Simrad', proprietaryId: 'Autopilot', commandType: 'AP Command', event: 'Standby' }
  })
  assert.match(ac.state.lastMappedEvent, /^Standby/)
})

test('still decodes on canboat 2.10 field names when no raw frame was captured', () => {
  const ac = emulator()
  ac.handleIncomingAP({ pgn: 130850, src: 7, fields: { Event: 'Nav mode', 'Unused B': 0x09 } })
  assert.match(ac.state.lastMappedEvent, /^Auto/)
})

test('ignores a non-AP group', () => {
  const ac = emulator()
  const frames = pressFrames(0x06)
  frames[0].data[7] = 0x0b // group byte -> not 0x0a
  for (const f of frames) { ac.onRawFrame(f) }
  ac.handleIncomingAP({ pgn: 130850, src: 7, fields: {} })
  assert.strictEqual(ac.state.lastMappedEvent, 'non-AP-group (ignored)')
})

test('ignores the plugin own commissioning head instead of steering on it', () => {
  // control-head.js broadcasts a real AP-group standby every 2 s to hold the MFD's
  // commissioning gate open, from headAddress -- which onParsedPgn does not filter
  // (it only excludes the AC's own address). Decoding it as a press would drop the
  // pilot to standby every other second for as long as commissioning mode is on.
  const ac = new ACEmulator({ debug () {} }, {
    bridge: 'dry-run', enableCommissioningHead: true, headAddress: 44
  })
  const calls = []
  ac.applyV2 = (desc) => calls.push(desc)
  press(ac, 0x06, 44)
  ac.handleIncomingAP({ pgn: 130850, src: 44, fields: {} })
  assert.strictEqual(ac.state.lastMappedEvent, 'own-src Standby (ignored)')
  assert.deepStrictEqual(calls, [])
  assert.strictEqual(ac.mfdSrc, null)
})

test('answers the commissioning readback under both canboat field spellings', () => {
  // No raw tap exists for 130845, so this one is read by field name -- which canboat
  // renders camelCase (useCamel, the default) or Title Case. Reading only the latter
  // meant the MFD's dockside reads went unanswered on a 3.x host and its wizard stayed
  // on "commissioning required".
  for (const fields of [{ address: 35, key: 20 }, { Address: 35, Key: 20 }]) {
    const ac = new ACEmulator({ debug () {} }, { bridge: 'dry-run', preferredAddress: 35 })
    const sent = []
    ac.myAddr = () => 35
    ac.canbus = { sendPGN: (s) => sent.push(s) }
    ac.onParsedPgn({ pgn: 130845, src: 7, fields })
    assert.strictEqual(sent.length, 1, `no reply for ${JSON.stringify(fields)}`)
    assert.match(sent[0], /,130845,/)
  }
})

test('does not answer a commissioning read addressed to another device', () => {
  // A real AC on the same bus must keep its own dockside config: answering reads
  // aimed at it would feed the MFD our canned values for someone else's autopilot.
  const ac = new ACEmulator({ debug () {} }, { bridge: 'dry-run', preferredAddress: 35 })
  const sent = []
  ac.myAddr = () => 35
  ac.canbus = { sendPGN: (s) => sent.push(s) }
  ac.onParsedPgn({ pgn: 130845, src: 7, fields: { address: 36, key: 20 } })
  assert.deepStrictEqual(sent, [])
})

test('caches the pilot wind datum under both canboat field spellings', () => {
  // 65345 carries the pilot's LOCKED apparent wind angle. Read under one spelling
  // only, it never cached on a 3.x host and tack/gybe fell back to live AWA.
  for (const fields of [{ windDatum: 1.5 }, { 'Wind Datum': 1.5 }]) {
    const ac = emulator()
    ac.onParsedPgn({ pgn: 65345, src: 204, fields })
    assert.strictEqual(ac.windDatumRad, 1.5, `not cached from ${JSON.stringify(fields)}`)
  }
})

test('does not pair a parsed PGN with another source raw frame', () => {
  const ac = emulator()
  press(ac, 0x06, 7)
  // A different device's parsed 130850 must not inherit source 7's key. With no
  // usable 2.x fields either, it falls through as a non-AP group.
  ac.handleIncomingAP({ pgn: 130850, src: 12, fields: {} })
  assert.strictEqual(ac.state.lastMappedEvent, 'non-AP-group (ignored)')
})
