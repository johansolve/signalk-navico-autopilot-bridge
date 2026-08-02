'use strict'

const test = require('node:test')
const assert = require('node:assert')
const ACEmulator = require('../lib/ac-emulator')

// Why this exists: the first attempt at recording the auto-advance decision exposed the LIVE turn
// measurement in the status payload. maybeAutoAdvance() consumes that measurement as part of
// deciding, so every sample a poller took afterwards reported it as null -- the field said "no
// turn was measured" for decisions that were taken on a 41 degree turn. A whole sea trial's data
// had the size of every turn missing. The snapshot is written at the moment of the decision, and
// these tests pin the two properties that make it trustworthy: the inputs are the ones the
// decision actually used, and the outcome recorded beside them is that same decision's.

function emulator (opts) {
  const ac = new ACEmulator({ debug () {} },
    Object.assign({ bridge: 'live', autoAdvanceMaxDeg: 25 }, opts))
  ac.sk.token = 'test'
  ac.commandedMode = 'route'
  ac.sent = []
  ac.applyV2 = (desc) => { ac.sent.push(desc) }
  ac.sampleTrackBrg = () => {}      // the measurement is injected by each test instead
  return ac
}

function measured (ac, deg, kind, opts) {
  const o = opts || {}
  ac.lastTurnDeg = deg
  ac.lastTurnKind = kind
  ac.lastTurnAt = Date.now() - (o.ageMs || 0)
  ac.lastTurnOldHeldMs = o.oldHeldMs === undefined ? 20000 : o.oldHeldMs
}

test('the snapshot keeps the turn the decision was taken on, after it is consumed', () => {
  const ac = emulator()
  measured(ac, 17.4, 'advance')
  ac.maybeAutoAdvance()
  assert.equal(ac.lastTurnDeg, null, 'the live measurement is consumed, as before')
  const d = ac.statusJson().lastDecision
  assert.equal(d.turnDeg, 17.4, 'but the decision still knows what it ruled on')
  assert.equal(d.turnKind, 'advance')
  assert.equal(d.maxDeg, 25)
  assert.match(d.outcome, /Auto-advance 17deg <= 25deg/)
  assert.equal(ac.sent.length, 1)
})

test('every refusal records its own reason, not the previous decision', () => {
  const cases = [
    { setup: (ac) => measured(ac, 4, 'advance', { ageMs: 9000 }), re: /not sizeable/ },
    { setup: (ac) => measured(ac, 4, 'advance', { oldHeldMs: 2000 }), re: /not sizeable/ },
    { setup: (ac) => measured(ac, 40, 'advance'), re: /Advance 40deg > 25deg/ },
    { setup: (ac) => measured(ac, null, null), re: /not sizeable/ }
  ]
  for (const c of cases) {
    const ac = emulator()
    c.setup(ac)
    ac.maybeAutoAdvance()
    const d = ac.statusJson().lastDecision
    assert.match(d.outcome, c.re)
    assert.deepEqual(ac.sent, [], 'a refusal sends nothing')
    assert.equal(d.outcome, ac.state.lastMappedEvent, 'outcome and event agree')
  }
})

test('the restart path records through the same snapshot', () => {
  const ac = emulator({ autoConfirmRestart: true })
  measured(ac, 6.8, 'restart')
  ac.maybeAutoAdvance()
  const d = ac.statusJson().lastDecision
  assert.equal(d.turnKind, 'restart')
  assert.equal(d.turnDeg, 6.8)
  assert.equal(d.restartOn, true)
  assert.match(d.outcome, /Track restart 7deg \(same waypoint\)/)
})

test('a later decision replaces the snapshot rather than merging into it', () => {
  const ac = emulator()
  measured(ac, 17.4, 'advance')
  ac.maybeAutoAdvance()
  measured(ac, 40, 'advance')
  ac.maybeAutoAdvance()
  const d = ac.statusJson().lastDecision
  assert.equal(d.turnDeg, 40, 'the newer turn')
  assert.match(d.outcome, /> 25deg/, 'and the newer outcome')
})

test('unrelated button traffic cannot overwrite the decision outcome', () => {
  // lastMappedEvent is shared with the button decoder, so it does not survive as a record of the
  // decision. That is the reason the outcome is duplicated into the snapshot.
  const ac = emulator()
  measured(ac, 17.4, 'advance')
  ac.maybeAutoAdvance()
  ac.state.lastMappedEvent = 'Auto (9)'
  const d = ac.statusJson().lastDecision
  assert.match(d.outcome, /Auto-advance 17deg/, 'the decision record is intact')
})

test('status carries no decision before the pilot has ever asked', () => {
  assert.equal(emulator().statusJson().lastDecision, null)
})

test('the age fields describe this decision, and count in the right direction', () => {
  // These are the fields the whole change exists for: the open question is whether a refusal was
  // a stale measurement or no measurement. A sign error here would pass every other test in this
  // file while making the recorded data useless, which is how the last round was wasted.
  const ac = emulator()
  measured(ac, 4, 'advance', { ageMs: 9000, oldHeldMs: 31000 })
  ac.legSince = Date.now() - 47000
  const before = Date.now()
  ac.maybeAutoAdvance()
  const d = ac.statusJson().lastDecision
  assert.ok(d.turnAgeMs >= 9000 && d.turnAgeMs < 10000, `turnAgeMs ${d.turnAgeMs} should be ~9000`)
  assert.equal(d.oldHeldMs, 31000)
  assert.ok(d.legHeldMs >= 47000 && d.legHeldMs < 48000, `legHeldMs ${d.legHeldMs} should be ~47000`)
  assert.ok(Date.parse(d.at) >= before && Date.parse(d.at) <= Date.now(), 'at is this decision')
  assert.match(d.outcome, /not sizeable/, 'and 9 s old is indeed too stale to act on')
})

test('the three refusal branches the other tests never reach', () => {
  // Two of these are the only branches that tell the restart path apart from the advance path,
  // so they are exactly what would notice if a gate were moved between them.
  const off = emulator({ autoAdvanceMaxDeg: 0 })
  measured(off, 4, 'advance')
  off.maybeAutoAdvance()
  assert.match(off.statusJson().lastDecision.outcome, /auto-advance off/)
  assert.deepEqual(off.sent, [])

  const stale = emulator({ autoConfirmRestart: true })
  measured(stale, 4, 'restart', { ageMs: 20000 })   // beyond RESTART_PENDING_MS
  stale.maybeAutoAdvance()
  assert.match(stale.statusJson().lastDecision.outcome, /re-origin not trustworthy/)
  assert.deepEqual(stale.sent, [])

  const wide = emulator({ autoConfirmRestart: true })
  measured(wide, 120, 'restart')                    // beyond RESTART_MAX_DEG
  wide.maybeAutoAdvance()
  assert.match(wide.statusJson().lastDecision.outcome, /Track restart 120deg > \d+deg/)
  assert.deepEqual(wide.sent, [], 'a near-reciprocal swing is never taken unattended')
})

test('the snapshot is taken AFTER the sampler runs, not before', () => {
  // The real order is sampleTrackBrg() first, and it clears the measurement when the bearing has
  // gone stale. Every other test here stubs the sampler out, which hides exactly the ordering
  // question that sank an earlier attempt: a snapshot taken from pre-sampling state would record
  // a turn the decision did not actually have.
  const ac = new ACEmulator({ debug () {} }, { bridge: 'live', autoAdvanceMaxDeg: 25 })
  ac.sk.token = 'test'
  ac.commandedMode = 'route'
  ac.sent = []
  ac.applyV2 = (desc) => { ac.sent.push(desc) }
  measured(ac, 17.4, 'advance')
  // No bearing in the model at all -> the sampler ages the leg out and drops the measurement.
  ac.app.getSelfPath = () => null
  ac.maybeAutoAdvance()
  const d = ac.statusJson().lastDecision
  assert.equal(d.turnDeg, null, 'the sampler cleared it before the decision saw it')
  assert.match(d.outcome, /not sizeable/)
  assert.deepEqual(ac.sent, [], 'and nothing was sent on a measurement that no longer existed')
})
