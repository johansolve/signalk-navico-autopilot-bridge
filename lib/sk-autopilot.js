'use strict'

const { resolveEndpoint } = require('./sk-endpoint')

// Minimal client for the SignalK V2 Autopilot API over HTTP loopback. Drives
// whichever provider backs autopilots/<id> (on Libelle: raymarinen2k -> EV-200).
// In-process calls would avoid the token, but there is no clean documented way
// for a non-provider plugin to set V2 state, so loopback HTTP is the proven path.
class SkAutopilot {
  constructor (opts) {
    const o = opts || {}
    // Where the server actually listens, not where it listened in 2023 -- see sk-endpoint.
    this.endpoint = resolveEndpoint(o.app, { host: o.host, port: o.port })
    this.host = this.endpoint.host
    this.port = this.endpoint.port
    this.id = o.autopilotId || '_default'
    this.token = o.token || null
    this.base = `/signalk/v2/api/vessels/self/autopilots/${this.id}`
  }

  setToken (token) {
    this.token = token || null
  }

  request (method, subpath, body, cb) {
    // Single-fire the callback: a late 'error' (e.g. socket reset after 'end')
    // must not call cb twice.
    let done = false
    const finish = (err, code, b) => { if (done) { return } done = true; cb && cb(err, code, b) }
    try {
      const data = body ? JSON.stringify(body) : null
      const headers = { 'Content-Type': 'application/json' }
      if (this.token) { headers['Authorization'] = 'Bearer ' + this.token }
      if (data) { headers['Content-Length'] = Buffer.byteLength(data) }
      // An absolute /signalk/... subpath is used verbatim (e.g. a V1 action endpoint);
      // anything else is relative to the V2 autopilots/<id> base.
      const path = subpath.indexOf('/signalk/') === 0 ? subpath : this.base + subpath
      const req = this.endpoint.transport.request({
        host: this.host,
        port: this.port,
        method,
        path,
        headers,
        rejectUnauthorized: this.endpoint.rejectUnauthorized
      }, (res) => {
        let b = ''
        res.on('data', (c) => { b += c })
        res.on('error', (e) => { finish(e) })   // premature socket close emits on res, not req
        res.on('end', () => { finish(null, res.statusCode, b) })
      })
      req.on('error', (e) => { finish(e) })
      // 10 s, not 5: the provider's verifyChange retries once a second and only replies on the
      // 6th-7th tick, so a 5 s client timeout always fired first -- the 400 'Did not receive
      // change confirmation' carve-out could never match, and a slow-but-successful command was
      // read as a refusal. That was harmless when the result only reached the status line; it is
      // not now that a refusal rolls the display back.
      req.setTimeout(10000, () => { req.destroy(new Error('timeout')) })
      if (data) { req.write(data) }
      req.end()
    } catch (e) {
      // http.request throws synchronously on a bad host/out-of-range port; called
      // from the 2s poll timer that would be an uncaught exception -> crash loop.
      finish(e)
    }
  }

  // The V2 spec separates `state` (standby/auto/...) from `mode` (compass/gps/wind): a
  // spec-conforming provider steering to a wind angle reports state 'auto' and mode 'wind',
  // and the state alone cannot tell you what its single `target` MEANS. The whole autopilot
  // object already comes back in this response, so the mode is free -- take it too, and let
  // callers that care read it. signalk-autopilot declares `modes: []` and puts wind among its
  // states instead, so mode is frequently absent; that is why it is reported separately rather
  // than folded into the state.
  getState (cb) {
    this.request('GET', '', null, (e, code, b) => {
      if (e || code !== 200) { return cb && cb(e || new Error('HTTP ' + code)) }
      try {
        const o = JSON.parse(b)
        cb && cb(null, o.state, (typeof o.mode === 'string' && o.mode !== '') ? o.mode : null)
      } catch (x) { cb && cb(x) }
    })
  }

  // The V2 autopilots list: an object keyed by autopilot id, or {} when no provider is
  // registered. This is the reliable "is there a pilot to steer?" check -- /autopilots/<id>
  // 500s rather than 404s when the provider is gone, so we key provider-presence off this.
  getAutopilots (cb) {
    this.request('GET', '/signalk/v2/api/vessels/self/autopilots', null, (e, code, b) => {
      if (e || code !== 200) { return cb && cb(e || new Error('HTTP ' + code)) }
      try { cb && cb(null, JSON.parse(b)) } catch (x) { cb && cb(x) }
    })
  }

  setState (value, cb) {
    this.request('PUT', '/state', { value }, cb)
  }

  // The server's per-source N2K device registry (from PGN 60928 address claim +
  // 126996 product info): { <bus>: { <src>: { n2k: { manufacturerCode, modelId,
  // modelVersion, deviceClass, ... } } } }. Read-only, no token needed. Used to put
  // real device names (MFD, pilot) on the status page instead of generic labels.
  getSources (cb) {
    this.request('GET', '/signalk/v1/api/sources', null, (e, code, b) => {
      if (e || code !== 200) { return cb && cb(e || new Error('HTTP ' + code)) }
      try { cb && cb(null, JSON.parse(b)) } catch (x) { cb && cb(x) }
    })
  }

  // delta in radians; the caller has already applied the (N+0.5)deg rounding fix
  adjustTarget (deltaRad, cb) {
    this.request('PUT', '/target/adjust', { value: deltaRad, units: 'rad' }, cb)
  }

  // direction: 'port' | 'starboard'. Whether the backing provider supports tack
  // is provider-specific (test candidate for the EV-200).
  tack (direction, cb) {
    this.request('POST', '/tack/' + direction, null, cb)
  }

  // Engage Track-to-waypoint on the Raymarine provider (65379 -> 0x0181, the command the
  // P70's Track confirm sends). NB: use the V1 PUT action, NOT the V2 courseNextPoint POST
  // -- @signalk/signalk-autopilot 2.6.0 (what runs on Libelle) stubs the V2 action with
  // `throw 'Not implemented!'` (500), but registers the V1 handler on
  // steering.autopilot.actions.advanceWaypoint -> putAdvanceWaypoint, which emits the 0x0181
  // engage and is guarded by state==='route'. The V1 path exists in the fork too, so it is
  // the portable choice. Value is ignored by the handler.
  advanceWaypoint (cb) {
    this.request('PUT', '/signalk/v1/api/vessels/self/steering/autopilot/actions/advanceWaypoint', { value: 1 }, cb)
  }
}

module.exports = SkAutopilot
