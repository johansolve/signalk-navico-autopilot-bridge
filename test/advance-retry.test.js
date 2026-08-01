'use strict'

const test = require('node:test')
const assert = require('node:assert')
const ACEmulator = require('../lib/ac-emulator')

// Guards for the two ways a resend could engage Track without the skipper saying yes. Both were
// found by review, not by running the code, and neither is reachable from the input-decode tests:
//
//  1. A resend armed for waypoint A answering the pending of waypoint B. The pilot broadcasts its
//     mode at 1 Hz and the resend runs at 2 Hz, so a teardown that only samples the latched mode
//     can miss the pilot leaving pending and re-entering it for the next leg -- one the auto-confirm
//     logic may have deliberately refused. Teardown therefore happens on the mode EDGE.
//  2. A resend landing in the ~1 s blind spot after the skipper pressed Standby at the control
//     head. The cure is the same rule the engage path already uses: the pilot must have spoken
//     AFTER our own last command before that command counts as unanswered.

function emulator () {
  const ac = new ACEmulator({ debug () {} }, { bridge: 'live', autoAdvanceMaxDeg: 25 })
  ac.sk.token = 'test'
  ac.commandedMode = 'route'
  ac.sent = []
  // applyV2 is the boundary to SignalK; the retry logic under test is everything above it.
  ac.applyV2 = (desc) => { ac.sent.push(desc) }
  return ac
}

function pilotMode (ac, mode) {
  const b = Buffer.from([0x3b, 0x9f, mode & 0xff, (mode >> 8) & 0xff, 0, 0, 0x02, 0xff])
  ac.onPilotMode({ pgn: { pgn: 65379, src: 204 }, data: b })
}

// The order matters and is the real one: the pilot enters pending, onPilotMode runs
// maybeAutoAdvance, and only that decision arms a resend. Arming before the edge would be a
// sequence the code can never produce -- and maybeAutoAdvance clears older arms, so it would
// also silently test nothing.
function enterPendingAndArm (ac) {
  pilotMode(ac, 0x0180)
  ac.armAdvanceRetry('auto-advance 5deg')
}

// The gap and proof windows are real durations; reach into the clock fields rather than sleep.
function gapElapsed (ac) { ac.advanceRetryAt = Date.now() - 1 }
function pilotSpokeAfterOurCommand (ac) { ac.advanceSentAt = Date.now() - 5000 }

test('leaving Track-pending disarms the resend on the mode edge', () => {
  for (const left of [0x0181, 0x0000, 0x0040]) {
    const ac = emulator()
    enterPendingAndArm(ac)
    assert.ok(ac.advanceRetryUntil > 0, 'still pending, resend stays armed')
    pilotMode(ac, left)
    assert.equal(ac.advanceRetryUntil, 0, `mode 0x${left.toString(16)} must end the episode`)
  }
})

test('a resend armed for one waypoint cannot answer the next pending', () => {
  const ac = emulator()
  enterPendingAndArm(ac)
  // The pilot takes it, then arrives at the next waypoint and asks again. That second pending is
  // its own episode: the skipper has not been shown it and maybeAutoAdvance has not ruled on it
  // (here it cannot even size the turn, so it refuses). Nothing may answer it.
  pilotMode(ac, 0x0181)
  pilotMode(ac, 0x0180)
  gapElapsed(ac)
  pilotSpokeAfterOurCommand(ac)
  ac.retryAdvance()
  assert.deepEqual(ac.sent, [], 'the stale arm must not answer the new pending')
  assert.equal(ac.advanceRetryUntil, 0)
})

test('a new pending episode invalidates any older arm', () => {
  const ac = emulator()
  enterPendingAndArm(ac)
  ac.maybeAutoAdvance()
  assert.equal(ac.advanceRetryUntil, 0)
})

test('no resend until the pilot has spoken after our own command', () => {
  const ac = emulator()
  enterPendingAndArm(ac)
  gapElapsed(ac)
  ac.retryAdvance()
  assert.deepEqual(ac.sent, [], 'observation predates our command, it proves nothing')

  pilotSpokeAfterOurCommand(ac)
  ac.retryAdvance()
  assert.equal(ac.sent.length, 1, 'a pending confirmed after our command is unanswered, resend')
  assert.match(ac.sent[0], /resend/)
})

test('a stale pilot mode word never authorises a resend', () => {
  const ac = emulator()
  enterPendingAndArm(ac)
  gapElapsed(ac)
  pilotSpokeAfterOurCommand(ac)
  ac.evPilotAt = Date.now() - 4000     // pilot fell off the bus; the latched 0x0180 is a leftover
  ac.retryAdvance()
  assert.deepEqual(ac.sent, [])
  assert.equal(ac.advanceRetryUntil, 0, 'silence ends the episode rather than pausing it')
})

test('the resend gives up and hands back to the control head', () => {
  const ac = emulator()
  enterPendingAndArm(ac)
  ac.advanceRetryUntil = Date.now() - 1
  ac.retryAdvance()
  assert.deepEqual(ac.sent, [])
  assert.match(ac.state.lastMappedEvent, /control head/)
})
