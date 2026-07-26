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

test('does not pair a parsed PGN with another source raw frame', () => {
  const ac = emulator()
  press(ac, 0x06, 7)
  // A different device's parsed 130850 must not inherit source 7's key. With no
  // usable 2.x fields either, it falls through as a non-AP group.
  ac.handleIncomingAP({ pgn: 130850, src: 12, fields: {} })
  assert.strictEqual(ac.state.lastMappedEvent, 'non-AP-group (ignored)')
})
