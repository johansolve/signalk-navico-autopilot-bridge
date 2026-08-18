'use strict'

const test = require('node:test')
const assert = require('node:assert')
const translate = require('../lib/ap-mode-translate')
const ACEmulator = require('../lib/ac-emulator')

// Why this exists: reported 2026-08-15 against a pypilot rig -- the pilot showed as engaged on
// the plotter for a second or two, then the plugin went to "error 500, invalid state supplied",
// while dry-run looked perfect (dry-run sends nothing, so it cannot fail). The bridge was PUTting
// `standby|auto|wind|route` as V2 STATES, which is @signalk/signalk-autopilot's vocabulary and
// nobody else's: pypilot-autopilot-provider declares two states (enabled/disabled) and puts the
// steering reference in `mode`, and its apSetState throws `Invalid state supplied!` on anything
// else. The delay was the HTTP round trip; the engaged display was the optimism that precedes it.
//
// So these tests pin the translation against the three provider vocabularies that actually exist,
// taken from their published sources rather than invented:
//
//   signalk-autopilot   states standby/auto/wind/route, modes []        (one dimension: state)
//   pypilot 1.1.x       states enabled/disabled,        modes compass/gps/nav/wind/true wind
//   garmin 0.2.x        states auto/standby,            modes compass/wind/route
//
// The garmin one is the reason the state is never read first: its `auto` state means "engaged in
// the CURRENT mode", so it reports state `auto` while holding a wind angle.

const SK_AUTOPILOT = {
  states: [
    { name: 'standby', engaged: false },
    { name: 'auto', engaged: true },
    { name: 'wind', engaged: true },
    { name: 'route', engaged: true }
  ],
  modes: []
}

const PYPILOT = {
  states: [
    { name: 'enabled', engaged: true },
    { name: 'disabled', engaged: false }
  ],
  modes: ['compass', 'gps', 'nav', 'wind', 'true wind']
}

const GARMIN = {
  states: [
    { name: 'auto', engaged: true },
    { name: 'standby', engaged: false }
  ],
  modes: ['compass', 'wind', 'route']
}

// ---- reading the pilot's state back ----

test('pypilot: every mode it can report reads as an AC mode', () => {
  // The five choices pypilot publishes in ap.mode. gps is a course-over-ground hold -- the AC's
  // NoDrift, which KEY_STATE already maps to auto -- and must NOT read as route, or a Nav press
  // would look satisfied by a pilot steering past the waypoint.
  assert.strictEqual(translate.acModeOf('enabled', 'compass', PYPILOT), 'auto')
  assert.strictEqual(translate.acModeOf('enabled', 'gps', PYPILOT), 'auto')
  assert.strictEqual(translate.acModeOf('enabled', 'nav', PYPILOT), 'route')
  assert.strictEqual(translate.acModeOf('enabled', 'wind', PYPILOT), 'wind')
  assert.strictEqual(translate.acModeOf('enabled', 'true wind', PYPILOT), 'wind')
})

test('pypilot: disabled is standby whatever mode it is left in', () => {
  // pypilot keeps ap.mode across a disengage, so the mode alone would claim the pilot is steering.
  for (const m of PYPILOT.modes) {
    assert.strictEqual(translate.acModeOf('disabled', m, PYPILOT), 'standby', 'mode ' + m)
  }
})

test('signalk-autopilot: the state still carries the mode when no modes are declared', () => {
  assert.strictEqual(translate.acModeOf('standby', null, SK_AUTOPILOT), 'standby')
  assert.strictEqual(translate.acModeOf('auto', null, SK_AUTOPILOT), 'auto')
  assert.strictEqual(translate.acModeOf('wind', null, SK_AUTOPILOT), 'wind')
  assert.strictEqual(translate.acModeOf('route', null, SK_AUTOPILOT), 'route')
})

test('garmin: the mode outranks a state that is itself an AC mode name', () => {
  // `auto` + `wind` is a wind-angle hold. Reading the state first would put that angle into
  // 127237's Heading-To-Steer as if it were a compass course.
  assert.strictEqual(translate.acModeOf('auto', 'wind', GARMIN), 'wind')
  assert.strictEqual(translate.acModeOf('auto', 'route', GARMIN), 'route')
  assert.strictEqual(translate.acModeOf('auto', 'compass', GARMIN), 'auto')
  assert.strictEqual(translate.acModeOf('standby', 'wind', GARMIN), 'standby')
})

test('an unusable state is null, not standby and not a mode', () => {
  // off-line means the provider cannot reach the pilot. Nothing may be commanded on it, and it
  // must not be mistaken for standby -- see the SeaTalk1 report behind normalizeMode.
  assert.strictEqual(translate.acModeOf('off-line', 'compass', PYPILOT), null)
  assert.strictEqual(translate.acModeOf('off-line', null, SK_AUTOPILOT), null)
  // A state the provider never declared is equally unusable.
  assert.strictEqual(translate.acModeOf('enabled', 'compass', SK_AUTOPILOT), null)
  assert.strictEqual(translate.acModeOf('', null, PYPILOT), null)
  assert.strictEqual(translate.acModeOf(null, null, PYPILOT), null)
})

test('before any options are known, the AC names still read as themselves', () => {
  // The first poll has not landed yet; refusing to read anything until it does would blank the
  // MFD on every restart.
  assert.strictEqual(translate.acModeOf('auto', null, null), 'auto')
  assert.strictEqual(translate.acModeOf('standby', null, null), 'standby')
  assert.strictEqual(translate.acModeOf('enabled', 'compass', null), null)
})

// ---- commanding a mode ----

test('pypilot: a mode key becomes a mode PUT and an engage, in that order', () => {
  assert.deepStrictEqual(translate.writesFor('auto', PYPILOT), [
    { path: 'mode', value: 'compass' }, { path: 'state', value: 'enabled' }
  ])
  // Apparent wind, not true wind: the AC's wind mode is apparent-referenced.
  assert.deepStrictEqual(translate.writesFor('wind', PYPILOT), [
    { path: 'mode', value: 'wind' }, { path: 'state', value: 'enabled' }
  ])
  assert.deepStrictEqual(translate.writesFor('route', PYPILOT), [
    { path: 'mode', value: 'nav' }, { path: 'state', value: 'enabled' }
  ])
})

test('pypilot: standby is the disengaged state and nothing else', () => {
  // No mode write: it would be meaningless, and pypilot would reject `standby` as a mode.
  assert.deepStrictEqual(translate.writesFor('standby', PYPILOT), [{ path: 'state', value: 'disabled' }])
})

test('signalk-autopilot: still a single state PUT, byte for byte as before', () => {
  for (const m of ['standby', 'auto', 'wind', 'route']) {
    assert.deepStrictEqual(translate.writesFor(m, SK_AUTOPILOT), [{ path: 'state', value: m }], m)
  }
})

test('garmin: Auto writes the compass mode too, because its auto state keeps the old one', () => {
  assert.deepStrictEqual(translate.writesFor('auto', GARMIN), [
    { path: 'mode', value: 'compass' }, { path: 'state', value: 'auto' }
  ])
  assert.deepStrictEqual(translate.writesFor('standby', GARMIN), [{ path: 'state', value: 'standby' }])
})

test('a mode the provider cannot do is refused, not sent as something else', () => {
  // A pilot with no wind mode must not be engaged on a heading by a Wind press.
  const noWind = { states: PYPILOT.states, modes: ['compass', 'nav'] }
  assert.strictEqual(translate.writesFor('wind', noWind), null)
  assert.deepStrictEqual(translate.writesFor('auto', noWind), [
    { path: 'mode', value: 'compass' }, { path: 'state', value: 'enabled' }
  ])
})

test('with no options at all, the historical single state PUT is what goes out', () => {
  assert.deepStrictEqual(translate.writesFor('auto', null), [{ path: 'state', value: 'auto' }])
  assert.deepStrictEqual(translate.writesFor('route', { states: [] }), [{ path: 'state', value: 'route' }])
})

// ---- end to end through the emulator ----

function emulator (options) {
  const ac = new ACEmulator({ debug () {} }, { bridge: 'live' })
  ac.sk.token = 'test'
  ac.apOptions = options
  return ac
}

// The poll, with a stubbed V2 API, so the options are stored where they really are.
function poll (ac, state, mode, options) {
  ac.sk.getAutopilots = (cb) => cb(null, { 'pypilot-sk': { isDefault: true } })
  ac.sk.getState = (cb) => cb(null, state, mode, options)
  ac.pollState()
}

test('the poll learns the vocabulary from the same response it reads the state from', () => {
  const ac = emulator(null)
  poll(ac, 'enabled', 'compass', PYPILOT)
  // The gate that decides a poll is usable depends on the options, so storing them after the
  // gate would deadlock: `enabled` would never normalise, every poll would be "unusable", and
  // the options would never be stored.
  assert.deepStrictEqual(ac.apOptions, PYPILOT)
  assert.strictEqual(ac.state.skApState, 'enabled')
  assert.strictEqual(ac.normalizeMode('enabled'), 'auto')
  assert.ok(ac.engaged())
})

test('a pypilot pilot in standby is not read as engaged', () => {
  const ac = emulator(null)
  poll(ac, 'disabled', 'compass', PYPILOT)
  assert.strictEqual(ac.normalizeMode('disabled'), 'standby')
  assert.strictEqual(ac.engaged(), false)
})

test('a mode key on a pypilot rig sends mode + state, not an invalid state', () => {
  const ac = emulator(PYPILOT)
  const sent = []
  ac.sk.request = (method, path, body, cb) => {
    sent.push(method + ' ' + path + ' ' + JSON.stringify(body))
    cb(null, 200, '')
  }
  ac.commandV2Mode('wind')
  assert.deepStrictEqual(sent, [
    'PUT /mode {"value":"wind"}',
    'PUT /state {"value":"enabled"}'
  ])
  assert.match(ac.state.lastV2Result, /^200/)
})

test('a failed first write stops the second and is reported as the failure', () => {
  // Engaging after a refused mode change is the one thing that must not happen: it would steer
  // to whatever reference the pilot was last left in.
  const ac = emulator(PYPILOT)
  const sent = []
  ac.sk.request = (method, path, body, cb) => {
    sent.push(path)
    cb(null, 500, 'Invalid mode supplied!')
  }
  let refused = null
  ac.commandV2Mode('route', (why) => { refused = why })
  assert.deepStrictEqual(sent, ['/mode'])
  assert.match(refused, /500/)
})

test('a mode the provider cannot do rolls the display back instead of steering', () => {
  const ac = emulator({ states: PYPILOT.states, modes: ['compass'] })
  ac.sk.request = () => { throw new Error('nothing may be sent') }
  let refused = null
  ac.commandV2Mode('wind', (why) => { refused = why })
  assert.strictEqual(refused, 'no wind mode')
  assert.match(ac.state.lastV2Result, /NOT SENT/)
})

test('garmin: a wind hold reported as state auto reads as wind through the emulator too', () => {
  // acModeOf got this right all along; normalizeMode used to short-circuit on the AC name
  // `auto` before ever consulting the mode, so keyMode() said auto forever, un-inverting
  // wind-mode nudges and gating Tack off on a pilot that was in wind.
  const ac = emulator(null)
  poll(ac, 'auto', 'wind', GARMIN)
  assert.strictEqual(ac.normalizeMode(ac.state.skApState), 'wind')
  assert.strictEqual(ac.keyMode(), 'wind')
  assert.ok(ac.engaged())
})

test('a declared state without an engaged flag falls back to the name heuristic', () => {
  // `{name: 'auto'}` with the flag omitted must not read as standby forever; the bare-string
  // form of the same declaration never did.
  const flagless = { states: [{ name: 'auto' }, { name: 'standby' }], modes: [] }
  assert.strictEqual(translate.acModeOf('auto', null, flagless), 'auto')
  assert.strictEqual(translate.acModeOf('standby', null, flagless), 'standby')
})
