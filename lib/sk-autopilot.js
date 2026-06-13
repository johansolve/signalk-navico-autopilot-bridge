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

  request (method, subpath, body, cb) {
    const data = body ? JSON.stringify(body) : null
    const headers = { 'Content-Type': 'application/json' }
    if (this.token) { headers['Authorization'] = 'Bearer ' + this.token }
    if (data) { headers['Content-Length'] = Buffer.byteLength(data) }
    const req = http.request({ host: this.host, port: this.port, method, path: this.base + subpath, headers }, (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => { cb && cb(null, res.statusCode, b) })
    })
    req.on('error', (e) => { cb && cb(e) })
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')) })
    if (data) { req.write(data) }
    req.end()
  }

  getState (cb) {
    this.request('GET', '', null, (e, code, b) => {
      if (e || code !== 200) { return cb && cb(e || new Error('HTTP ' + code)) }
      try { cb && cb(null, JSON.parse(b).state) } catch (x) { cb && cb(x) }
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
}

module.exports = SkAutopilot
