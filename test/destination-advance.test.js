'use strict'

const test = require('node:test')
const assert = require('node:assert')
const ACEmulator = require('../lib/ac-emulator')

// The advance is the destination changing, not the course changing. These pin that, and pin the
// two things it must not break: a re-origin (destination unchanged) still takes the restart path,
// and the baselines still move in lockstep so the NEXT leg change is sized against this leg.
//
// The waypoints below are consecutive points from an autorouted leg recorded under way on
// 2026-08-03, roughly 220 m apart, where the bearing sat at 150.0 deg across five of them.

const WP1 = { latitude: 57.84531, longitude: 11.65718 }
const WP2 = { latitude: 57.84354, longitude: 11.65910 }
const WP3 = { latitude: 57.84177, longitude: 11.66102 }

function emulator (opts) {
  const ac = new ACEmulator({ debug () {} },
    Object.assign({ bridge: 'live', autoAdvanceMaxDeg: 25 }, opts))
  ac.sk.token = 'test'
  ac.commandedMode = 'route'
  ac.sent = []
  ac.applyV2 = (desc) => { ac.sent.push(desc) }
  return ac
}

// Point the emulator's view of the SK model at one bearing/destination pair.
function shows (ac, brgDeg, wp, cogDeg) {
  const ts = new Date().toISOString()
  const cog = cogDeg === undefined ? brgDeg : cogDeg   // on the leg unless a test says otherwise
  ac.app.getSelfPath = (path) => {
    if (path === 'navigation.courseGreatCircle.bearingTrackTrue') {
      return brgDeg === null ? null : { value: brgDeg * Math.PI / 180, timestamp: ts }
    }
    if (path === 'navigation.courseGreatCircle.nextPoint.position') {
      return wp === null ? null : { value: wp, timestamp: ts }
    }
    if (path === 'navigation.courseOverGroundTrue') {
      return cog === null ? null : { value: cog * Math.PI / 180, timestamp: ts }
    }
    if (path === 'navigation.speedOverGround') {
      return { value: ac.sog === undefined ? 3 : ac.sog, timestamp: ts }   // m/s, making way
    }
    return null
  }
}

// Establish a settled leg, then show the next one. Winds the clock back so the leg being left
// reads as held rather than momentary, which is what the restart path still asks for.
function legThen (ac, brg1, wp1, brg2, wp2, heldMs) {
  shows(ac, brg1, wp1)
  ac.sampleTrackBrg()
  ac.legSince = Date.now() - (heldMs === undefined ? 20000 : heldMs)
  shows(ac, brg2, wp2)
}

test('a new destination on an unchanged bearing is an advance', () => {
  const ac = emulator()
  legThen(ac, 150, WP1, 150, WP2)
  ac.sampleTrackBrg()
  assert.equal(ac.lastTurnKind, 'advance')
  assert.ok(ac.lastTurnDeg < 0.01, 'a straight route turns zero degrees, and that is not a refusal')
})

test('and it auto-advances, which is the whole point', () => {
  const ac = emulator()
  legThen(ac, 150, WP1, 150, WP2)
  ac.maybeAutoAdvance()
  const d = ac.statusJson().lastDecision
  assert.match(d.outcome, /Auto-advance 0deg <= 25deg/)
  assert.equal(ac.sent.length, 1, 'the confirm went out without a control-head press')
})

test('a new destination that does turn is still sized against the limit', () => {
  const ac = emulator()
  legThen(ac, 150, WP1, 190, WP2)
  ac.maybeAutoAdvance()
  const d = ac.statusJson().lastDecision
  assert.equal(d.turnKind, 'advance')
  assert.ok(Math.abs(d.turnDeg - 40) < 0.001)
  // 41, not 40: the refusal rounds the turn UP so a limit is never reported as less than it was.
  assert.match(d.outcome, /Advance 41deg > 25deg/, 'reading the destination did not disable the limit')
  assert.deepEqual(ac.sent, [])
})

test('an unchanged destination on a new bearing is still a re-origin', () => {
  const ac = emulator({ autoConfirmRestart: true })
  legThen(ac, 150, WP1, 165, WP1)
  ac.maybeAutoAdvance()
  const d = ac.statusJson().lastDecision
  assert.equal(d.turnKind, 'restart')
  assert.match(d.outcome, /Track restart 15deg \(same waypoint\)/)
})

test('a destination that is merely unknown still fails to the guarded path', () => {
  const ac = emulator()
  legThen(ac, 150, WP1, 165, null)
  ac.sampleTrackBrg()
  assert.equal(ac.lastTurnKind, 'advance', 'unknown is called an advance, never a re-origin')
})

test('a destination nudged less than the same-waypoint tolerance is not an advance', () => {
  const ac = emulator()
  const nudged = { latitude: WP1.latitude + 0.00002, longitude: WP1.longitude }  // ~2 m
  legThen(ac, 150, WP1, 150, nudged)
  ac.sampleTrackBrg()
  assert.equal(ac.lastTurnDeg, null, 'neither the course nor the destination actually moved')
})

test('the baselines move together, so the next turn is sized against THIS leg', () => {
  // The failure this guards is the one that was reverted under way once already: adopting a new
  // destination while keeping the old bearing makes the following real turn compare the new
  // waypoint against itself and read as a re-origin.
  const ac = emulator()
  legThen(ac, 150, WP1, 150, WP2)
  ac.sampleTrackBrg()
  assert.equal(ac.lastTurnKind, 'advance')
  ac.legSince = Date.now() - 20000
  shows(ac, 172, WP3)
  ac.sampleTrackBrg()
  assert.equal(ac.lastTurnKind, 'advance', 'not a re-origin')
  assert.ok(Math.abs(ac.lastTurnDeg - 22) < 0.001, `sized from 150, not from an older leg: ${ac.lastTurnDeg}`)
})

// The plotter publishes the new destination a sample BEFORE the new bearing (56 % of 133 recorded
// changes; never the other way round). Sizing such an advance from the bearing alone reads zero on
// a turn that has not been published yet, which would walk a 60 deg turn straight through
// autoAdvanceMaxDeg unattended. These are the tests for that.

// A point `metres` away from `from` on `brgDeg`, so a test can state the turn it means.
function along (from, brgDeg, metres) {
  const r = brgDeg * Math.PI / 180
  const dLat = metres * Math.cos(r) / 6371000 * 180 / Math.PI
  const dLon = metres * Math.sin(r) / 6371000 * 180 / Math.PI / Math.cos(from.latitude * Math.PI / 180)
  return { latitude: from.latitude + dLat, longitude: from.longitude + dLon }
}

test('a turn the bearing has not published yet is sized from the geometry', () => {
  const ac = emulator()
  const turned = along(WP1, 190, 220)          // the new leg runs 40 deg off the old one
  legThen(ac, 150, WP1, 150, turned)           // ... but the bearing still reads the old 150
  ac.sampleTrackBrg()
  assert.equal(ac.lastTurnKind, 'advance')
  assert.ok(Math.abs(ac.lastTurnDeg - 40) < 0.5, `sized ${ac.lastTurnDeg}, expected ~40`)
  assert.equal(Math.round(ac.lastTurnJumpDeg), 0, 'the bearing on its own saw nothing')
})

test('and a big one is refused rather than taken as zero degrees', () => {
  const ac = emulator()
  legThen(ac, 150, WP1, 150, along(WP1, 210, 220))   // 60 deg, bearing not caught up
  ac.maybeAutoAdvance()
  const d = ac.statusJson().lastDecision
  assert.match(d.outcome, /> 25deg -> manual confirm/, 'this is the one that must never auto-confirm')
  assert.deepEqual(ac.sent, [])
})

test('the geometry never shrinks a turn the bearing already saw', () => {
  // Bursts of destination changes make the geometry overstate: the previous destination is not the
  // new leg's origin there. Taking the maximum keeps that error pointing at a manual confirm.
  const ac = emulator()
  legThen(ac, 150, WP1, 175, WP2)              // bearing says 25, geometry says 0
  ac.sampleTrackBrg()
  assert.ok(Math.abs(ac.lastTurnDeg - 25) < 0.5, `sized ${ac.lastTurnDeg}, expected 25`)
  assert.ok(ac.lastTurnGeoDeg < 1)
})

test('the bearing arriving late is not mistaken for a re-origin', () => {
  // This is the regression that got an earlier attempt reverted under way: the advance is taken on
  // the destination, then the bearing catches up on an unchanged waypoint and looks exactly like
  // the MFD's Restart. It must be absorbed silently, not reported as a turn nobody made.
  const ac = emulator({ autoConfirmRestart: true })
  const turned = along(WP1, 190, 220)
  legThen(ac, 150, WP1, 150, turned)
  ac.sampleTrackBrg()
  assert.equal(ac.lastTurnKind, 'advance')
  ac.lastTurnDeg = null                        // a pending consumed it, as maybeAutoAdvance would
  ac.lastTurnKind = null
  shows(ac, 190, turned)                       // the bearing finally lands
  ac.sampleTrackBrg()
  assert.equal(ac.lastTurnKind, null, 'no phantom re-origin was recorded')
  assert.ok(Math.abs(ac.legBrg * 180 / Math.PI - 190) < 0.001, 'but the bearing was adopted')
})

test('a re-origin well after the advance is still a re-origin', () => {
  const ac = emulator({ autoConfirmRestart: true })
  legThen(ac, 150, WP1, 150, WP2)
  ac.sampleTrackBrg()
  ac.legAdvancedAt = Date.now() - 30000        // long past the catch-up window
  ac.legSince = Date.now() - 30000
  shows(ac, 165, WP2)
  ac.sampleTrackBrg()
  assert.equal(ac.lastTurnKind, 'restart')
})

test('a leg too short to have settled no longer blocks an advance', () => {
  // Waypoints 200 m apart produce these continuously. The gate that refused them was written when
  // the turn was the signal; it survives on the re-origin path, where it still means something.
  const ac = emulator()
  legThen(ac, 150, WP1, 150, WP2, 2000)
  ac.maybeAutoAdvance()
  assert.match(ac.statusJson().lastDecision.outcome, /Auto-advance/)
  assert.equal(ac.sent.length, 1)
})

test('but a re-origin off a leg that never settled is still refused', () => {
  const ac = emulator({ autoConfirmRestart: true })
  legThen(ac, 150, WP1, 165, WP1, 2000)
  ac.maybeAutoAdvance()
  assert.match(ac.statusJson().lastDecision.outcome, /re-origin not trustworthy/)
  assert.deepEqual(ac.sent, [])
})

test('a stale leg change still cannot answer a pending', () => {
  const ac = emulator()
  legThen(ac, 150, WP1, 150, WP2)
  ac.sampleTrackBrg()
  ac.lastTurnAt = Date.now() - 9000
  ac.app.getSelfPath = () => null          // nothing new to sample at the pending moment
  ac.maybeAutoAdvance()
  assert.match(ac.statusJson().lastDecision.outcome, /not sizeable/)
  assert.deepEqual(ac.sent, [])
})

test('five collinear advances in a row are all taken', () => {
  // The recorded sequence: bearing 150.0 throughout, destination stepping evenly down the leg.
  // Every one of these was a manual confirm before this change.
  const ac = emulator()
  const wps = [WP1, WP2, WP3,
    { latitude: 57.84000, longitude: 11.66293 },
    { latitude: 57.83822, longitude: 11.66485 }]
  shows(ac, 150, wps[0])
  ac.sampleTrackBrg()
  for (let i = 1; i < wps.length; i++) {
    ac.legSince = Date.now() - 70000
    shows(ac, 150, wps[i])
    ac.maybeAutoAdvance()
    assert.match(ac.statusJson().lastDecision.outcome, /Auto-advance 0deg/, `waypoint ${i}`)
  }
  assert.equal(ac.sent.length, 4, 'four advances, no presses')
})

test('a re-origin inside the catch-up window is not swallowed by it', () => {
  // Swallowing on timing alone would let this 120 deg swing be answered by the advance's own
  // "0 deg" measurement. Only the bearing the geometry predicted may be absorbed.
  const ac = emulator({ autoConfirmRestart: true })
  legThen(ac, 150, WP1, 150, WP2)
  ac.sampleTrackBrg()
  assert.equal(ac.lastTurnKind, 'advance')
  shows(ac, 270, WP2)                          // nothing like the predicted 150
  ac.sampleTrackBrg()
  assert.equal(ac.lastTurnKind, 'restart', 'a re-origin, not a late bearing')
  assert.ok(ac.lastTurnDeg > 100)
})

test('the size halves do not outlive the decision that consumed them', () => {
  const ac = emulator()
  legThen(ac, 150, WP1, 150, WP2)
  ac.maybeAutoAdvance()
  assert.equal(ac.statusJson().lastDecision.turnMovedM > 100, true, 'this decision has them')
  ac.app.getSelfPath = () => null
  ac.maybeAutoAdvance()
  const d = ac.statusJson().lastDecision
  assert.equal(d.turnDeg, null)
  assert.equal(d.turnGeoDeg, null, 'and the next one does not inherit them')
  assert.equal(d.turnMovedM, null)
})

// A leg that has held the same destination and bearing long enough that a late bearing would have
// landed. The pilot asking here is asking to carry on, and the size of "carry on" is the angle
// between where the boat points and where the leg runs -- measured, not assumed. Recorded
// 2026-08-03: Restart pressed 30 m off a 4.9 km leg moved the bearing 0.3 deg, far too little to
// register as a turn, and left the pending with nothing to answer it.

test('an unchanged leg is answered on the boat course, not on the leg standing still', () => {
  const ac = emulator()
  shows(ac, 150, WP1, 153)                     // 3 deg off the leg, as after a Restart on track
  ac.sampleTrackBrg()
  ac.legSince = Date.now() - 20000
  ac.maybeAutoAdvance()
  const d = ac.statusJson().lastDecision
  assert.equal(d.turnDeg, null, 'no measurement existed, and none was invented')
  assert.match(d.outcome, /Unchanged leg, 3deg off the leg <= 25deg -> engage track/)
  assert.equal(ac.sent.length, 1)
})

test('a Restart that swings hard is refused even though the leg looks unchanged', () => {
  // The failure the previous version of this branch had: a Restart off track re-origins the leg
  // onto the boat and swings, but the destination does not move, so no geometry exists to catch a
  // bearing that has not been republished. Only the boat's own course sees it.
  const ac = emulator()
  shows(ac, 150, WP1, 270)                     // bearing still says 150; the boat is 120 deg off
  ac.sampleTrackBrg()
  ac.legSince = Date.now() - 20000
  ac.maybeAutoAdvance()
  assert.match(ac.statusJson().lastDecision.outcome, /120deg off it > 25deg -> manual confirm/)
  assert.deepEqual(ac.sent, [], 'this is the involuntary gybe, and it must ask')
})

test('a stale measurement is not what answers an unchanged leg', () => {
  const ac = emulator()
  shows(ac, 150, WP1, 152)
  ac.sampleTrackBrg()
  ac.legSince = Date.now() - 20000
  ac.lastTurnDeg = 10.25                       // a route change from 20 s ago
  ac.lastTurnKind = 'advance'
  ac.lastTurnAt = Date.now() - 20000
  ac.maybeAutoAdvance()
  assert.match(ac.statusJson().lastDecision.outcome, /Unchanged leg, 2deg/)
  assert.match(ac.sent[0], /unchanged leg/, 'not sized off a turn that belonged elsewhere')
})

test('it answers once per leg, not once per pending edge', () => {
  // The other paths self-limit by consuming their measurement. This condition is standing, so
  // without a latch a pilot flapping in and out of pending would be commanded repeatedly.
  const ac = emulator()
  shows(ac, 150, WP1, 151)
  ac.sampleTrackBrg()
  ac.legSince = Date.now() - 20000
  ac.maybeAutoAdvance()
  ac.maybeAutoAdvance()
  ac.maybeAutoAdvance()
  assert.equal(ac.sent.length, 1, 'three pending edges, one command')
  assert.match(ac.statusJson().lastDecision.outcome, /already answered once/)
})

test('a new leg re-arms it', () => {
  const ac = emulator()
  shows(ac, 150, WP1, 151)
  ac.sampleTrackBrg()
  ac.legSince = Date.now() - 20000
  ac.maybeAutoAdvance()
  shows(ac, 150, WP2, 151)                     // advanced onto the next waypoint
  ac.sampleTrackBrg()
  ac.legSince = Date.now() - 20000
  ac.lastTurnDeg = null
  ac.lastTurnKind = null
  ac.maybeAutoAdvance()
  assert.equal(ac.sent.length, 2, 'the latch belongs to the leg, not to the session')
})

test('a leg not yet settled is still asked about', () => {
  const ac = emulator()
  legThen(ac, 150, WP1, 150, along(WP1, 210, 220))
  ac.sampleTrackBrg()
  ac.lastTurnDeg = null
  ac.lastTurnKind = null
  ac.maybeAutoAdvance()
  assert.match(ac.statusJson().lastDecision.outcome, /not sizeable/)
  assert.deepEqual(ac.sent, [])
})

test('a destination the model no longer publishes is not answered from cache', () => {
  // Null Island during route re-activation, or the Course API taking over the path: legWp still
  // holds the old waypoint and legSince is old, but there is no live destination to stand on.
  const ac = emulator()
  shows(ac, 150, WP1, 151)
  ac.sampleTrackBrg()
  ac.legSince = Date.now() - 20000
  shows(ac, 150, { latitude: 0, longitude: 0 }, 151)
  ac.maybeAutoAdvance()
  assert.match(ac.statusJson().lastDecision.outcome, /not sizeable/)
  assert.deepEqual(ac.sent, [])
})

test('without a course over ground it asks rather than guesses', () => {
  const ac = emulator()
  shows(ac, 150, WP1, null)
  ac.sampleTrackBrg()
  ac.legSince = Date.now() - 20000
  ac.maybeAutoAdvance()
  assert.match(ac.statusJson().lastDecision.outcome, /not sizeable/)
  assert.deepEqual(ac.sent, [])
})

test('drifting too slowly for COG to be a course, it asks', () => {
  const ac = emulator()
  ac.sog = 0.3                                 // m/s, well under a knot
  shows(ac, 150, WP1, 151)
  ac.sampleTrackBrg()
  ac.legSince = Date.now() - 20000
  ac.maybeAutoAdvance()
  assert.match(ac.statusJson().lastDecision.outcome, /not sizeable/)
  assert.deepEqual(ac.sent, [])
})

test('a stale COG is not a COG', () => {
  const ac = emulator()
  shows(ac, 150, WP1, 151)
  ac.sampleTrackBrg()
  ac.legSince = Date.now() - 20000
  const live = ac.app.getSelfPath
  ac.app.getSelfPath = (path) => {
    const n = live(path)
    if (path === 'navigation.courseOverGroundTrue' && n) {
      return { value: n.value, timestamp: new Date(Date.now() - 60000).toISOString() }
    }
    return n
  }
  ac.maybeAutoAdvance()
  assert.match(ac.statusJson().lastDecision.outcome, /not sizeable/)
  assert.deepEqual(ac.sent, [])
})

test('the swing wraps through north instead of the long way round', () => {
  const ac = emulator()
  shows(ac, 355, WP1, 5)                       // 10 deg apart, not 350
  ac.sampleTrackBrg()
  ac.legSince = Date.now() - 20000
  ac.maybeAutoAdvance()
  assert.match(ac.statusJson().lastDecision.outcome, /Unchanged leg, 10deg off the leg <= 25deg/)
})

test('a published re-origin is refused by the settled gate, not let through by COG', () => {
  // This is the invariant the whole safety argument rests on: when a Restart DOES move the
  // bearing, the restart path re-baselines the leg, and the unchanged-leg branch is then out of
  // reach for LEG_SETTLED_MS. Lower that constant and the hole reopens.
  const ac = emulator({ autoConfirmRestart: true })
  shows(ac, 150, WP1, 151)
  ac.sampleTrackBrg()
  ac.legSince = Date.now() - 60000
  ac.legAdvancedAt = 0
  shows(ac, 210, WP1, 151)                     // the re-origin lands, 60 deg
  ac.sampleTrackBrg()
  assert.equal(ac.lastTurnKind, 'restart', 'the restart path claimed it')
  ac.lastTurnDeg = null                        // and a pending consumed it
  ac.lastTurnKind = null
  ac.maybeAutoAdvance()
  assert.match(ac.statusJson().lastDecision.outcome, /not sizeable/, 'the leg is fresh, so no free answer')
  assert.deepEqual(ac.sent, [])
})

test('a refusal does not spend the leg its answer', () => {
  const ac = emulator()
  shows(ac, 150, WP1, 241)                     // 91 deg off, refused
  ac.sampleTrackBrg()
  ac.legSince = Date.now() - 20000
  ac.maybeAutoAdvance()
  assert.deepEqual(ac.sent, [])
  shows(ac, 150, WP1, 151)                     // back on course
  ac.maybeAutoAdvance()
  assert.equal(ac.sent.length, 1, 'coming back onto the leg still earns an answer')
})

test('a second edge on a spent leg says so, rather than blaming the measurement', () => {
  const ac = emulator()
  shows(ac, 150, WP1, 151)
  ac.sampleTrackBrg()
  ac.legSince = Date.now() - 20000
  ac.maybeAutoAdvance()
  ac.maybeAutoAdvance()
  assert.match(ac.statusJson().lastDecision.outcome, /already answered once/)
})
