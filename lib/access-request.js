'use strict'

const http = require('http')
const crypto = require('crypto')

// SignalK device access-request flow: POST a request, then poll until an admin
// approves it under Security -> Access Requests, and receive a device token.
// This is the correct way for a plugin to obtain write access without a manually
// created token; the plugin then appears as its own device that can be revoked.
class AccessRequest {
  constructor (opts) {
    const o = opts || {}
    this.host = o.host || '127.0.0.1'
    this.port = o.port || 3000
    this.description = o.description || 'plugin'
    this.debug = o.debug || (() => {})
    this.clientId = o.clientId || crypto.randomUUID()
    this.pollMs = o.pollMs || 6000
    this.timer = null
    this.stopped = false
    this.href = null
  }

  request (method, path, body, cb) {
    const data = body ? JSON.stringify(body) : null
    const headers = { 'Content-Type': 'application/json' }
    if (data) { headers['Content-Length'] = Buffer.byteLength(data) }
    const req = http.request({ host: this.host, port: this.port, method, path, headers }, (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => {
        let parsed = null
        try { parsed = b ? JSON.parse(b) : null } catch (e) {}
        cb(null, res.statusCode, parsed)
      })
    })
    req.on('error', (e) => { cb(e) })
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')) })
    if (data) { req.write(data) }
    req.end()
  }

  // onToken(token) is called once, when an admin approves the request.
  start (onToken) {
    this.stopped = false
    this.submit(onToken)
  }

  submit (onToken) {
    if (this.stopped) { return }
    this.request('POST', '/signalk/v1/access/requests',
      { clientId: this.clientId, description: this.description, permissions: 'readwrite' }, (err, code, res) => {
        if (this.stopped) { return }
        if (err) {
          this.debug('access request POST failed: ' + err.message + ' -- retrying')
          this.timer = setTimeout(() => this.submit(onToken), this.pollMs)
          return
        }
        if (res && res.href) {
          this.href = res.href
          this.debug(`access request submitted (clientId ${this.clientId}) -- approve under Security -> Access Requests`)
          this.poll(onToken)
        } else if (res && res.token) {
          this.deliver(res.token, onToken)
        } else {
          this.debug('access request POST unexpected response (HTTP ' + code + ') -- retrying')
          this.timer = setTimeout(() => this.submit(onToken), this.pollMs)
        }
      })
  }

  poll (onToken) {
    if (this.stopped || !this.href) { return }
    this.request('GET', this.href, null, (err, code, res) => {
      if (this.stopped) { return }
      if (err) {
        this.timer = setTimeout(() => this.poll(onToken), this.pollMs)
        return
      }
      if (code === 404) {
        // the request expired / was cleared -- submit a fresh one
        this.href = null
        this.timer = setTimeout(() => this.submit(onToken), this.pollMs)
        return
      }
      const ar = res && res.accessRequest
      const state = res && res.state
      if (ar && ar.permission === 'APPROVED' && ar.token) {
        this.deliver(ar.token, onToken)
        return
      }
      if (ar && ar.permission === 'DENIED') {
        this.debug('access request DENIED by admin -- bridge will stay read-only until reconfigured')
        return
      }
      if (state === 'COMPLETED' && !(ar && ar.token)) {
        // completed without a token (e.g. revoked) -- resubmit a fresh request
        this.href = null
        this.timer = setTimeout(() => this.submit(onToken), this.pollMs)
        return
      }
      this.timer = setTimeout(() => this.poll(onToken), this.pollMs)
    })
  }

  deliver (token, onToken) {
    this.debug('access request APPROVED -- token received')
    try { onToken(token) } catch (e) { this.debug('onToken handler error: ' + (e && e.message)) }
  }

  stop () {
    this.stopped = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }
}

module.exports = AccessRequest
