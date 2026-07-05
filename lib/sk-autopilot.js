'use strict'

const http = require('http')

// Minimal client for the SignalK V2 Autopilot API over HTTP loopback. Drives
// whichever provider backs autopilots/<id> (on Libelle: raymarinen2k -> EV-200).
// In-process calls would avoid the token, but there is no clean documented way
// for a non-provider plugin to set V2 state, so loopback HTTP is the proven path.
class SkAutopilot {
  constructor (opts) {
    const o = opts || {}
    this.host = o.host || '127.0.0.1'
    this.port = o.port || 3000
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
      const req = http.request({ host: this.host, port: this.port, method, path, headers }, (res) => {
        let b = ''
        res.on('data', (c) => { b += c })
        res.on('error', (e) => { finish(e) })   // premature socket close emits on res, not req
        res.on('end', () => { finish(null, res.statusCode, b) })
      })
      req.on('error', (e) => { finish(e) })
      req.setTimeout(5000, () => { req.destroy(new Error('timeout')) })
      if (data) { req.write(data) }
      req.end()
    } catch (e) {
      // http.request throws synchronously on a bad host/out-of-range port; called
      // from the 2s poll timer that would be an uncaught exception -> crash loop.
      finish(e)
    }
  }

  getState (cb) {
    this.request('GET', '', null, (e, code, b) => {
      if (e || code !== 200) { return cb && cb(e || new Error('HTTP ' + code)) }
      try { cb && cb(null, JSON.parse(b).state) } catch (x) { cb && cb(x) }
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
