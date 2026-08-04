'use strict'

const PLUGIN_ID = (location.pathname.split('/').filter(Boolean)[0]) || 'signalk-navico-autopilot-bridge'
const STATUS_URL = '/signalk/v1/api/navico-autopilot-bridge/status'
const STATUS_FALLBACK = '/plugins/' + PLUGIN_ID + '/status'
const CONFIG_URL = '/admin/#/serverConfiguration/plugins/' + PLUGIN_ID
const POLL_MS = 2000

const $ = (id) => document.getElementById(id)
let busy = false

document.addEventListener('DOMContentLoaded', () => {
  $('cfg').href = CONFIG_URL
  tick()
  setInterval(tick, POLL_MS)
})

async function fetchStatus (url) {
  const res = await fetch(url, { credentials: 'include', cache: 'no-store' })
  if (!res.ok) { throw new Error('HTTP ' + res.status) }
  return res.json()
}

async function tick () {
  if (busy) { return }   // skip overlapping polls so a slow response can't render out of order
  busy = true
  try {
    let data
    // Always try the read-honouring route first each tick; only this tick falls back to the
    // admin-gated plugin route (so a single transient failure doesn't strand a non-admin).
    try { data = await fetchStatus(STATUS_URL) } catch (e) { data = await fetchStatus(STATUS_FALLBACK) }
    render(data)
    setConn(true)
  } catch (e) { setConn(false, e.message) } finally { busy = false }
}

function setConn (ok, msg) {
  $('dot').className = 'dot ' + (ok ? 'live' : 'dead')
  $('dot-t').textContent = ok ? 'connected' : ('no data (' + (msg || 'offline') + ')')
}

const EV_LABEL = {
  'standby': 'Standby', 'auto': 'Auto', 'wind': 'Wind',
  'route-pending': 'Track — pending', 'route-engaged': 'Track'
}
const EV_ST = {
  'standby': '', 'auto': 'st-auto', 'wind': 'st-wind',
  'route-pending': 'st-pending', 'route-engaged': 'st-engaged'
}

function cls (el, base, extra) { el.className = base + (extra ? ' ' + extra : '') }
function setV (id, val, k) { const el = $(id); el.textContent = val; el.className = 'v' + (id === 's-v2' ? ' mono' : '') + (k ? ' ' + k : '') }

// name + bus liveness. presence: online | offline | missing | null (not an N2K device,
// or no address resolved yet -- then the dot is hidden and only the name shows).
// 'missing' (never heard since we started) reads as offline too: for the user a
// powered-down device and one that went quiet are the same thing.
function setIdent (id, name, presence) {
  const el = $(id)
  if (!el) { return }
  const silent = presence === 'offline' || presence === 'missing'
  el.classList.toggle('none', !name)
  el.dataset.pres = name && presence ? (silent ? 'offline' : presence) : ''
  el.querySelector('.nm').textContent = name || ''
  el.querySelector('.pres').textContent = silent ? 'offline' : ''
}

// Metres for anything close enough to matter at the helm, nautical miles beyond that. A leg is
// read while deciding whether to press a button, so the unit that needs no conversion wins.
function fmtDist (m) {
  if (m === null || m === undefined) { return null }
  return m < 1000 ? Math.round(m) + ' m' : (m / 1852).toFixed(2) + ' NM'
}

function fmtBrg (deg) {
  if (deg === null || deg === undefined) { return null }
  return String(Math.round(deg)).padStart(3, '0') + '\u00b0'
}

// The destination, its name and where it lies. Blank until something is actually navigating --
// the plotter keeps sending 129284 with everything unavailable when it is not, and Signal K never
// clears a path, so anything stale here would read as a live leg that does not exist.
function renderCourse (c) {
  if (!c || !c.branch) {
    setV('s-route', '—'); setV('s-wp', '—'); setV('s-navsrc', 'nothing navigating')
    return
  }

  setV('s-route', c.routeName || 'no route (single destination)', c.routeName ? '' : 'mut')

  const bits = []
  if (c.nextPointName) { bits.push(c.nextPointName) }
  const d = fmtDist(c.distanceM)
  const b = fmtBrg(c.bearingDeg)
  if (d && b) { bits.push(d + ' at ' + b) } else if (d) { bits.push(d) } else if (b) { bits.push(b) }
  setV('s-wp', bits.length ? bits.join(' \u00b7 ') : '—')

  // Two live publishers means two navigators are running and the model shows whichever spoke
  // last. That is the state behind a destination that jumps between two places, and it is
  // invisible everywhere else in Signal K.
  if (c.contested) {
    setV('s-navsrc', c.writers.map(w => w.src).join(' + ') + ' \u2014 two navigators!', 'err')
  } else {
    const age = c.ageMs === null ? '' : ' \u00b7 ' + (c.ageMs / 1000).toFixed(1) + 's ago'
    setV('s-navsrc', (c.source || 'unknown') + age + ' \u00b7 ' + c.branch, '')
  }
}

function render (d) {
  const evState = d.evPilotState
  const pending = evState === 'route-pending' || d.navPending
  const engaged = evState === 'route-engaged'

  // resolved device names (from the server's N2K source registry), empty = hidden
  setIdent('mfd-id', d.mfdName, d.mfdPresence)
  setIdent('pilot-id', d.pilotName, d.pilotPresence)
  setIdent('acu-id', d.acuName, d.acuPresence)
  setIdent('head-id', d.controlHeadName, d.headPresence)
  // the provider is a SignalK plugin, not a bus device -- no liveness dot
  setIdent('prov-id', d.noProvider ? '' : ('Signal K autopilot' + (d.providerId ? ' · ' + d.providerId : '')), null)

  // bridge node
  const bcls = { 'live': 'st-live', 'dry-run': 'st-dry', 'off': 'st-off' }[d.bridge] || 'st-off'
  cls($('n-bridge'), 'node primary', bcls)
  $('b-bridge').textContent = 'bridge: ' + d.bridge
  $('b-bridge').style.color = tone(d.bridge === 'live' ? 'ok' : d.bridge === 'dry-run' ? 'warn' : 'mut')
  $('bridge-sub').textContent = 'Emulated ' + (d.acModel || 'AC') + ' — decodes 130850, firehoses state.'

  // provider node
  cls($('n-prov'), 'node', d.noProvider ? 'dim' : '')
  $('b-prov').textContent = d.noProvider ? 'no provider!' : 'provider ready'
  $('b-prov').style.color = tone(d.noProvider ? 'err' : 'ok')

  // pilot node
  cls($('n-pilot'), 'node', (EV_ST[evState] || '') + (pending ? ' beat' : ''))
  $('b-pilot').textContent = 'pilot: ' + (evState ? EV_LABEL[evState] || evState : (d.skState || 'unknown'))
  $('b-pilot').style.color = tone(engaged ? 'ok' : pending ? 'warn' : (evState === 'auto' || evState === 'wind') ? 'accent' : 'mut')

  // MFD + wires
  cls($('n-mfd'), 'node', pending && !engaged ? 'beat' : '')
  cls($('w-mfd'), 'wire cmd', engaged ? 'go' : pending ? 'hot' : '')
  cls($('w-pilot'), 'wire cmd', engaged ? 'go' : '')

  // top pill + banner
  const canSteer = d.bridge === 'live' && d.hasToken && !d.noProvider
  const pill = $('steer')
  if (d.noProvider) { cls(pill, 'pill', 'err'); pill.textContent = 'no autopilot' }
  else if (d.bridge === 'off') { cls(pill, 'pill', ''); pill.textContent = 'off' }
  else if (d.bridge === 'dry-run') { cls(pill, 'pill', 'warn'); pill.textContent = 'dry-run' }
  else if (!d.hasToken) { cls(pill, 'pill', 'err'); pill.textContent = 'no token' }
  else {
    // Live and able to steer: show the pilot's actual mode. Green = the pilot is
    // steering (auto/wind/track), amber = confirm pending, neutral = standby.
    const st = evState || (d.skStale ? null : d.skState)
    if (!st) { cls(pill, 'pill', ''); pill.textContent = 'ready' }
    else { pill.textContent = EV_LABEL[st] || st; cls(pill, 'pill', engaged ? 'ok' : pending ? 'warn' : st === 'standby' ? '' : 'ok') }
  }

  const b = $('banner')
  // A downgraded display outranks the rest: standby on the MFD while the pilot may well still be
  // steering is the one state that reads as the opposite of what it means.
  if (d.noProvider) { cls(b, 'banner', 'err'); b.textContent = 'No autopilot provider found — install and configure a SignalK V2 autopilot provider. The bridge binds the MFD and decodes buttons but cannot steer.' }
  else if (d.displayDowngraded) { cls(b, 'banner', 'err'); b.textContent = 'Cannot verify the pilot is engaged (' + (d.commandedMode || '?') + ' commanded, broadcasting ' + (d.displayMode || 'standby') + ') — the MFD is being told standby because nothing here can confirm otherwise. The pilot may still be steering: check the control head.' }
  else if (d.bridge === 'live' && !d.hasToken) { cls(b, 'banner', 'err'); b.textContent = 'Live but no API token — approve the access request under Security → Access Requests so the bridge can steer.' }
  else if (d.bridge === 'dry-run') { cls(b, 'banner', 'warn'); b.textContent = 'Dry-run: buttons are decoded and logged but not sent to the pilot. Set the bridge to live in the config to steer.' }
  else if (d.bridge === 'off') { cls(b, 'banner', 'warn'); b.textContent = 'Bridge is off: incoming MFD commands are ignored.' }
  else { cls(b, 'banner', 'hidden'); b.textContent = '' }

  // stats
  setV('s-bridge', d.bridge, d.bridge === 'live' ? 'ok' : d.bridge === 'dry-run' ? 'warn' : '')
  setV('s-steer', canSteer ? 'yes' : 'no', canSteer ? 'ok' : 'warn')
  setV('s-pilot', evState ? EV_LABEL[evState] || evState : (d.skStale ? 'stale' : d.skState || '—'), engaged ? 'ok' : pending ? 'warn' : '')
  setV('s-pending', d.navPending ? 'pending — confirm on MFD' : 'idle', d.navPending ? 'warn' : '')
  setV('s-cmds', d.cmdCount == null ? '—' : String(d.cmdCount))
  setV('s-last', d.lastEvent || '—')
  renderCourse(d.course)

  const v2 = d.lastV2Result || '—'
  setV('s-v2', v2, /(^2\d\d|COMPLETED|APPLIED)/.test(v2) ? 'ok' : /(^4\d\d|^5\d\d|ERR|NO TOKEN|FAILED)/.test(v2) ? 'err' : '')
}

function tone (name) {
  const map = { ok: '--ok', warn: '--warn', err: '--err', accent: '--accent', mut: '--mut' }
  return getComputedStyle(document.documentElement).getPropertyValue(map[name] || '--mut').trim() || 'currentColor'
}
