'use strict'

// The AC has four mode keys. An Autopilot V2 provider declares its own vocabulary instead:
// `options.states`, each with an `engaged` flag, and `options.modes` for the steering
// reference. This translates between the two, in both directions, and knows nothing of PGNs.

const AC_MODES = ['standby', 'auto', 'wind', 'route']

const MODE_PATTERNS = {
  auto: [/^compass$/i, /^heading$/i, /^auto$/i, /compass|heading|magnetic/i],
  // Apparent before true wind: the AC's wind mode is apparent-referenced, and pypilot
  // declares both.
  wind: [/^wind$/i, /apparent/i, /wind/i],
  // `gps` is excluded on purpose: in pypilot it is a course-over-ground hold, not waypoint
  // following, so a Nav press that engaged it would steer straight past the waypoint.
  route: [/^nav$/i, /^route$/i, /^track$/i, /nav|route|track|waypoint/i]
}

// `auto` is deliberately not tested here: it is the fallback for an engaged pilot that is
// steering to neither the wind nor a route, whatever it calls that reference.
function acModeOfMode (mode) {
  if (typeof mode !== 'string' || mode === '') { return null }
  for (const ac of ['wind', 'route']) {
    for (const p of MODE_PATTERNS[ac]) { if (p.test(mode)) { return ac } }
  }
  return null
}

function states (options) {
  const raw = (options && Array.isArray(options.states)) ? options.states : []
  const out = []
  for (const s of raw) {
    // A bare string list carries no `engaged` flag, so the name is all there is to go on.
    if (typeof s === 'string') {
      out.push({ name: s, engaged: !/^(standby|disabled|off|off-line|offline)$/i.test(s) })
    } else if (s && typeof s.name === 'string') {
      out.push({ name: s.name, engaged: s.engaged === true })
    }
  }
  return out
}

function modes (options) {
  const raw = (options && Array.isArray(options.modes)) ? options.modes : []
  return raw.filter((m) => typeof m === 'string' && m !== '')
}

function pickMode (acMode, options) {
  const pats = MODE_PATTERNS[acMode]
  const list = modes(options)
  if (!pats || list.length === 0) { return null }
  for (const p of pats) {
    for (const m of list) { if (p.test(m)) { return m } }
  }
  return null
}

function stateNamed (options, name) {
  for (const s of states(options)) { if (s.name.toLowerCase() === name) { return s } }
  return null
}

function firstState (options, engaged) {
  for (const s of states(options)) { if (s.engaged === engaged) { return s } }
  return null
}

// A polled (state, mode) pair as an AC mode. null is "no usable state" -- neither engaged nor
// standby -- which callers must not act on: the spec has a provider report `off-line` when it
// cannot reach the pilot.
function acModeOf (state, mode, options) {
  if (typeof state !== 'string' || state === '') { return null }
  const s = state.toLowerCase()
  if (/^off-?line$/i.test(s)) { return null }
  const def = stateNamed(options, s)
  // With no list to check against (first poll not back), the AC's own names are the best
  // guess available; an undeclared name against a real list is unusable.
  const engaged = def ? def.engaged
    : (states(options).length === 0 && AC_MODES.indexOf(s) !== -1) ? (s !== 'standby') : null
  if (engaged === null) { return null }
  if (!engaged) { return 'standby' }
  // The mode names the steering reference, so it outranks the state: the Garmin provider
  // reports state `auto` while holding a wind angle in mode `wind`. Read only on an engaged
  // pilot -- pypilot keeps `ap.mode` across a disengage.
  const fromMode = acModeOfMode(mode)
  if (fromMode) { return fromMode }
  // signalk-autopilot declares `modes: []` and carries the reference in the state instead.
  if (AC_MODES.indexOf(s) !== -1) { return s }
  return 'auto'
}

// The V2 writes that put the provider into an AC mode, in the order they must be sent, or null
// when it cannot be asked for at all.
function writesFor (acMode, options) {
  const list = states(options)
  // Nothing declared, or the first poll has not landed: keep the historical single PUT rather
  // than refuse to steer.
  if (list.length === 0) { return [{ path: 'state', value: acMode }] }
  if (acMode === 'standby') {
    const off = stateNamed(options, 'standby') || firstState(options, false)
    return off ? [{ path: 'state', value: off.name }] : null
  }
  const on = firstState(options, true)
  const m = pickMode(acMode, options)
  if (on && m) {
    // Mode before state, so the pilot is never engaged on the reference it was last left in
    // for the length of an HTTP round trip. Written even when a state of the same name exists,
    // because the Garmin provider's `auto` state means "engaged in the CURRENT mode".
    return [{ path: 'mode', value: m }, { path: 'state', value: on.name }]
  }
  const direct = stateNamed(options, acMode)
  if (direct) { return [{ path: 'state', value: direct.name }] }
  return null
}

function describe (options) {
  const st = states(options).map((s) => s.name + (s.engaged ? '*' : '')).join('/')
  const md = modes(options).join('/')
  if (!st && !md) { return 'no options declared' }
  return `states ${st || '-'} modes ${md || '-'}`
}

module.exports = { AC_MODES, states, modes, pickMode, acModeOf, writesFor, describe }
