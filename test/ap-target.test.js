'use strict'

const test = require('node:test')
const assert = require('node:assert')
const ACEmulator = require('../lib/ac-emulator')

// Why this exists: issue #10. A pilot whose provider speaks only the V2 Autopilot API showed the
// right mode on the plotter and "Set Heading - - -" beside it, forever, while the API was serving
// a target the whole time. The bridge only ever read the V1 sub-paths -- target.headingMagnetic
// and target.windAngleApparent -- and V2 has neither: it carries ONE steering.autopilot.target
// whose meaning is the engaged mode's.
//
// apTargetRad() reads it, so what these tests pin is the part that can go wrong quietly: the
// meaning is taken from the mode the PROVIDER reports, so a wind angle can never be handed to a
// caller that asked for a heading (that one steers the boat), and a V1 provider must be left
// exactly as it was.

function emulator () {
  const ac = new ACEmulator({ debug () {} }, { bridge: 'live' })
  ac.sk.token = 'test'
  return ac
}

// The SK model as this pilot's provider publishes it. Keys are full paths as selfPathNum asks
// for them; anything unlisted is ABSENT, which is the whole point of the V2/V1 distinction.
function model (ac, paths) {
  ac.app.getSelfPath = (p) => (p in paths ? paths[p] : undefined)
}

function inMode (ac, state) {
  ac.state.skApState = state
  ac.state.lastSkStateMs = Date.now()
}

// The reported case: target = 2.0944 rad = 120 deg, and nothing under target.*
const V2_ONLY = { 'steering.autopilot.target.value': 2.0944 }

test('a V2-only provider yields the heading it is holding', () => {
  const ac = emulator()
  inMode(ac, 'auto')
  model(ac, V2_ONLY)
  assert.equal(ac.apTargetRad('heading'), 2.0944)
})

test('a V2-only provider yields the wind angle it is holding', () => {
  const ac = emulator()
  inMode(ac, 'wind')
  model(ac, { 'steering.autopilot.target.value': -0.7854 })
  assert.equal(ac.apTargetRad('wind'), -0.7854)
})

test('route reads the single target as a heading', () => {
  const ac = emulator()
  inMode(ac, 'route')
  model(ac, V2_ONLY)
  assert.equal(ac.apTargetRad('heading'), 2.0944)
})

// The one that matters. In wind mode the single target is an apparent wind angle; handing it to
// a caller that asked for a heading would put it in 127237's Heading-To-Steer and on the MFD as
// a course to steer. -0.7854 rad would read as 315 deg magnetic.
test('a wind-mode target is never served as a heading', () => {
  const ac = emulator()
  inMode(ac, 'wind')
  model(ac, { 'steering.autopilot.target.value': -0.7854 })
  assert.equal(ac.apTargetRad('heading'), null)
})

test('a heading-mode target is never served as a wind angle', () => {
  const ac = emulator()
  inMode(ac, 'auto')
  model(ac, V2_ONLY)
  assert.equal(ac.apTargetRad('wind'), null)
})

// Standby has no setpoint for the target to be, and providers have been seen to park it at 0.
// The callers' own fallbacks (live heading, live AWA) are better answers than a hard 0 deg.
test('standby does not read the single target at all', () => {
  const ac = emulator()
  inMode(ac, 'standby')
  model(ac, { 'steering.autopilot.target.value': 0 })
  assert.equal(ac.apTargetRad('heading'), null)
})

// `off-line` is a legal V2 state and not a mode (see normalizeMode), so the target cannot be
// interpreted against it.
test('a state that is not a mode does not read the single target', () => {
  const ac = emulator()
  inMode(ac, 'off-line')
  model(ac, V2_ONLY)
  assert.equal(ac.apTargetRad('heading'), null)
})

test('a V1 provider is read exactly as before', () => {
  const ac = emulator()
  inMode(ac, 'auto')
  model(ac, { 'steering.autopilot.target.headingMagnetic.value': 1.5708 })
  assert.equal(ac.apTargetRad('heading'), 1.5708)

  inMode(ac, 'wind')
  model(ac, { 'steering.autopilot.target.windAngleApparent.value': -0.5236 })
  assert.equal(ac.apTargetRad('wind'), -0.5236)
})

// A provider publishing both shapes: V2 wins, because our own firehose decodes back into
// target.headingMagnetic unless source priorities have been pinned (README §5), while nothing
// writes the V2 path but the provider.
test('the single target outranks the V1 sub-path when both are published', () => {
  const ac = emulator()
  inMode(ac, 'auto')
  model(ac, {
    'steering.autopilot.target.value': 2.0944,
    'steering.autopilot.target.headingMagnetic.value': 1.0472
  })
  assert.equal(ac.apTargetRad('heading'), 2.0944)
})

// V1 is still the fallback when the mode says V2 applies but the provider has not published it.
test('an unpublished single target falls through to the V1 sub-path', () => {
  const ac = emulator()
  inMode(ac, 'auto')
  model(ac, { 'steering.autopilot.target.headingMagnetic.value': 1.0472 })
  assert.equal(ac.apTargetRad('heading'), 1.0472)
})

test('the wind-mode 65341 setpoint comes from the single target when the datum is stale', () => {
  const ac = emulator()
  inMode(ac, 'wind')
  model(ac, { 'steering.autopilot.target.value': -0.7854, 'environment.wind.angleApparent.value': -0.9 })
  ac.windDatumRad = null
  assert.equal(ac.windTargetRad(), -0.7854)
})

// The EV-200's own locked datum is still the truth when it is fresh -- the target must not
// displace it.
test('a fresh wind datum still outranks the single target', () => {
  const ac = emulator()
  inMode(ac, 'wind')
  model(ac, { 'steering.autopilot.target.value': -0.7854 })
  ac.windDatumRad = 5.4978
  ac.windDatumAt = Date.now()
  assert.equal(ac.windTargetRad(), 5.4978)
})

// End to end, at the symptom: the Heading-To-Steer field of 127237 is what the plotter reads for
// "Set Heading", and with a V2-only provider it used to carry the live heading (or nothing).
// 2.0944 rad / 0.0001 = 20944 = 0x51d0, LE.
test('127237 carries the V2 target as the set heading', () => {
  const ac = emulator()
  inMode(ac, 'auto')
  model(ac, V2_ONLY)
  const sent = []
  ac.send = (prio, pgn, bytes) => sent.push({ pgn, bytes })
  ac.send127237()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].pgn, 127237)
  assert.equal(sent[0].bytes.split(',').slice(5, 7).join(','), 'd0,51')
})

// The nav-confirm dialog shows the course it is about to steer; same read, same gap.
test('the nav-pending 65341 carries the V2 target', () => {
  const ac = emulator()
  inMode(ac, 'auto')
  model(ac, V2_ONLY)
  ac.navPending = true
  const sent = []
  ac.send = (prio, pgn, bytes) => sent.push({ pgn, bytes })
  ac.send65341()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].bytes, '41,9f,ff,ff,0d,ff,d0,51')
})
