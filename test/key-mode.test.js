'use strict'

const test = require('node:test')
const assert = require('node:assert')
const ACEmulator = require('../lib/ac-emulator')

// Why this exists: on 2026-08-04 a '-' nudge pressed 1.23 s after Auto came out of wind mode was
// wind-inverted anyway, and the target heading went UP ten degrees, twice, before the poll caught
// up and the same key started working. The pilot's mode was read from state.skApState, a 2 s poll
// of the V2 API, so for up to a poll cycle after a mode key it still named the mode we just left
// -- and the sign of the nudge was chosen against it.
//
// keyMode() prefers the commanded mode until the pilot is known to have taken it. What makes that
// safe rather than merely optimistic is which event closes the window, so that is what these
// tests pin: a poll returning the OLD mode must not close it (the V2 state is not optimistic --
// it only moves when the EV-200 broadcasts, so such a reply is stale, not evidence), a poll
// returning the commanded mode must close it for good, and a commanded standby is never trusted.

function emulator () {
  const ac = new ACEmulator({ debug () {} }, { bridge: 'live' })
  ac.sk.token = 'test'
  return ac
}

function polled (ac, state) {
  ac.state.skApState = state
  ac.state.lastSkStateMs = Date.now()
}

// A mode key pressed `agoMs` ago, not yet confirmed by any poll.
function pressedMode (ac, mode, agoMs) {
  ac.commandMode(mode)
  ac.commandedAt -= (agoMs || 0)
  ac.commandedModeAt = ac.commandedAt
}

// Run the real pollState with a stubbed V2 API, so the latch is exercised where it lives.
function pollReturns (ac, state) {
  ac.sk.getAutopilots = (cb) => cb(null, { raymarineN2K: { isDefault: true } })
  ac.sk.getState = (cb) => cb(null, state)
  ac.pollState()
}

test('a mode key beats a poll that still shows the mode we left', () => {
  const ac = emulator()
  polled(ac, 'wind')
  pressedMode(ac, 'auto', 1230)     // the press from the sea trial
  assert.equal(ac.keyMode(), 'auto')
})

test('a poll returning the old mode does not close the window', () => {
  // The V2 state only moves when the EV-200 broadcasts its own 65379, so a poll issued between
  // our PUT and that broadcast returns the old mode legitimately. Treating its arrival as the
  // pilot having spoken would hand the stale mode back and reinstate the inversion.
  const ac = emulator()
  pressedMode(ac, 'auto', 300)
  pollReturns(ac, 'wind')
  assert.equal(ac.keyMode(), 'auto')
})

test('a poll returning the commanded mode closes the window', () => {
  const ac = emulator()
  pressedMode(ac, 'auto', 300)
  pollReturns(ac, 'auto')
  assert.equal(ac.commandedModeSeen, true)
  assert.equal(ac.keyMode(), 'auto', 'same answer, now on the pilot\'s authority')
})

test('once the pilot has been seen in the mode, leaving it is believed at once', () => {
  // The p70s beside the wheel can change mode without us asking. After the latch the poll is
  // authoritative again, so that has to show up immediately rather than wait out MODE_ADOPT_MS.
  const ac = emulator()
  pressedMode(ac, 'auto', 300)
  pollReturns(ac, 'auto')
  pollReturns(ac, 'wind')
  assert.equal(ac.keyMode(), 'wind')
})

test('a commanded mode the pilot never takes expires', () => {
  const ac = emulator()
  polled(ac, 'wind')
  pressedMode(ac, 'auto', 6000)     // past MODE_ADOPT_MS, no poll ever agreed
  assert.equal(ac.keyMode(), 'wind')
})

test('a commanded standby is not trusted, because engaged() still reads the poll', () => {
  // Standby is a mode key like any other and sets commandedMode. But the nudge branch is gated on
  // engaged(), which reads the poll -- so between the press and the next poll engaged() says wind
  // and lets a nudge through. Answering 'standby' there would drop the inversion and turn the boat
  // the wrong way for a pilot physically still in wind vane.
  const ac = emulator()
  polled(ac, 'wind')
  pressedMode(ac, 'standby', 100)
  assert.equal(ac.keyMode(), 'wind')
})

test('a Nav press that bumps commandedAt alone opens no window', () => {
  // Two Nav paths bump commandedAt without commanding a mode, which is why commandMode() owns the
  // fields together: bumping commandedAt alone must not revive a mode nobody just asked for.
  // navPending holds off pollState's reconciliation, which would otherwise rewrite commandedMode
  // to the polled value and make this pass whatever keyMode did.
  const ac = emulator()
  pressedMode(ac, 'wind', 8000)
  ac.navPending = true
  pollReturns(ac, 'auto')
  assert.equal(ac.commandedMode, 'wind', 'the stale command is still standing')
  ac.commandedAt = Date.now()       // as the Nav arming path does
  assert.equal(ac.keyMode(), 'auto')
})

test('a refused mode key stops outranking the poll', () => {
  // applyV2's failure path restores the mode the pilot is actually in. The window has to close
  // with it: the pilot may reach the commanded mode later by another route -- off the p70s, or
  // because the PUT landed and only its reply died -- and answering with the rolled-back mode
  // then signs a nudge against a mode nobody is in.
  const ac = emulator()
  pressedMode(ac, 'auto', 1000)
  ac.withdrawMode('wind')           // as onFail does, with the poll still reading wind
  assert.equal(ac.commandedModeSeen, true)
  pollReturns(ac, 'auto')           // the pilot got there anyway
  assert.equal(ac.keyMode(), 'auto')
})

test('withdrawing a mode does not restamp the key press', () => {
  // commandedAt gates the display reconciliation and the Nav engage proof, both measured from the
  // press. A refused command must not buy itself another five seconds of either.
  const ac = emulator()
  pressedMode(ac, 'auto', 3000)
  const at = ac.commandedAt
  ac.withdrawMode('wind')
  assert.equal(ac.commandedAt, at)
})

test('route is commanded without optimism, so a nudge keeps the wind inversion', () => {
  // confirmNav commands 'route' before the pilot has left wind vane -- it reaches Track on its own
  // schedule, via the MFD dialog. Claiming route in that gap would drop the inversion out from
  // under a nudge and turn the boat the wrong way, the very failure this file exists for.
  const ac = emulator()
  polled(ac, 'wind')
  ac.commandMode('route', true)
  assert.equal(ac.keyMode(), 'wind')
})

test('keyMode falls back to the poll before any mode key', () => {
  const ac = emulator()
  polled(ac, 'wind')
  assert.equal(ac.keyMode(), 'wind', 'the assumed standby must not open a window of its own')
})

test('keyMode is null when the poll has never returned a usable state', () => {
  assert.equal(emulator().keyMode(), null)
})
