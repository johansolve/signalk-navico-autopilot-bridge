'use strict'

const fs = require('fs')
const path = require('path')
const ACEmulator = require('./lib/ac-emulator')
const ControlHead = require('./lib/control-head')
const AccessRequest = require('./lib/access-request')

module.exports = function (app) {
  let emulator = null
  let head = null
  let accessReq = null

  // Persist the granted device token (and its clientId) outside the plugin
  // config so an admin approval survives restarts without rewriting config.
  function tokenFile () {
    try { return path.join(app.getDataDirPath(), 'access.json') } catch (e) { return null }
  }
  function readSaved () {
    const f = tokenFile()
    if (!f) { return {} }
    try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { return {} }
  }
  function writeSaved (obj) {
    const f = tokenFile()
    if (!f) { return }
    try { fs.writeFileSync(f, JSON.stringify(obj, null, 2)) } catch (e) { app.debug('could not save token: ' + (e && e.message)) }
  }

  const plugin = {
    id: 'signalk-navico-autopilot-bridge',
    name: 'Navico autopilot bridge (Simrad AC emulator)',
    description:
      'Emulates a Simrad AC12/AC42 autopilot computer so a Navico MFD (B&G ' +
      'Vulcan/Zeus, Simrad, Lowrance) binds to it and sends its autopilot ' +
      'control-view button presses as Simnet 130850 commands. Those are decoded ' +
      'and translated into the SignalK Autopilot V2 API, driving whichever pilot ' +
      'backs it (e.g. a Raymarine EV-200 via signalk-raymarine-autopilot). ' +
      'ALPHA: see README for verified behaviour and known limitations.'
  }

  plugin.schema = {
    type: 'object',
    required: ['canInterface', 'acModel', 'preferredAddress', 'bridge'],
    properties: {
      canInterface: {
        type: 'string',
        title: 'CAN interface',
        description: 'SocketCAN interface the NMEA 2000 bus is on.',
        default: 'can0'
      },
      acModel: {
        type: 'string',
        title: 'Emulated AC model',
        description: 'Identity broadcast to the MFD. AC12 is what a Libelle ' +
          'Vulcan 7 was verified to bind to; AC42 matches the reference capture.',
        enum: ['AC42', 'AC12'],
        default: 'AC42'
      },
      preferredAddress: {
        type: 'number',
        title: 'Preferred N2K source address',
        description: 'Address the emulated AC claims on the bus.',
        default: 35
      },
      enableFirehose: {
        type: 'boolean',
        title: 'Broadcast the AC firehose',
        description: 'Send the full Simrad AP state/telemetry broadcast a real ' +
          'AC emits. Required for the MFD to bind and for the control view to ' +
          'unlock. Leave on.',
        default: true
      },
      enableStdPgns: {
        type: 'boolean',
        title: 'Also send standard nav PGNs (advanced, A/B only)',
        description: 'Emit 127245/127237/127250 as the real AC also does. These ' +
          'DUPLICATE other bus sources (rudder/heading/track) and can cause ' +
          'conflicting data — only enable for protocol A/B testing.',
        default: false
      },
      bridge: {
        type: 'string',
        title: 'Bridge mode',
        description: 'off = ignore incoming commands; dry-run = decode and log ' +
          'only (no steering); live = translate commands to the autopilot. ' +
          'Default dry-run for safety — set live deliberately.',
        enum: ['off', 'dry-run', 'live'],
        default: 'dry-run'
      },
      autopilotId: {
        type: 'string',
        title: 'Target autopilot id (V2 API)',
        description: 'Which autopilots/<id> the V2 API drives. Usually _default.',
        default: '_default'
      },
      skHost: {
        type: 'string',
        title: 'SignalK host',
        description: 'Host for the loopback V2 API calls.',
        default: '127.0.0.1'
      },
      skPort: {
        type: 'number',
        title: 'SignalK port',
        description: 'Port for the loopback V2 API calls.',
        default: 3000
      },
      token: {
        type: 'string',
        title: 'API token (optional manual override)',
        description: 'Normally leave EMPTY. In live mode the plugin requests a ' +
          'readwrite token automatically via an access request you approve under ' +
          'Security → Access Requests, and stores it. Set this only to force a ' +
          'specific token (must be a valid JWT; a non-JWT value is ignored).'
      },
      enableCommissioningHead: {
        type: 'boolean',
        title: 'Commissioning mode (emulate a control head)',
        description: 'Emulate a B&G keypad on a second address to open the MFD ' +
          '"press standby" gate for FIRST commissioning. Enable only while ' +
          'commissioning, then turn it off — not needed for normal operation.',
        default: false
      },
      headAddress: {
        type: 'number',
        title: 'Commissioning head N2K address',
        description: 'Source address the emulated control head claims (only used ' +
          'when commissioning mode is on).',
        default: 44
      }
    }
  }

  // A SignalK token is a JWT (three dot-separated parts). Ignore anything else
  // pasted into the config field so a stray value can't shadow a valid token.
  function validJwt (t) { return typeof t === 'string' && t.split('.').length === 3 }

  plugin.start = function (options) {
    const o = options || {}
    try {
      // Token precedence: a VALID config token > previously granted token.
      const saved = readSaved()
      let configToken = null
      if (o.token) {
        if (validJwt(o.token)) { configToken = o.token } else { app.error('Configured token is not a JWT — ignoring it (using the granted device token if present)') }
      }
      const token = configToken || saved.token || null
      emulator = new ACEmulator(app, Object.assign({}, o, { token }))
      emulator.start()

      // No token and we intend to steer -> request device access; an admin
      // approves it under Security -> Access Requests, then we store + use it.
      if (!token && o.bridge === 'live') {
        accessReq = new AccessRequest({
          host: o.skHost || '127.0.0.1',
          port: o.skPort || 3000,
          description: 'Navico autopilot bridge (needs readwrite to steer)',
          clientId: saved.clientId,
          debug: app.debug
        })
        writeSaved({ clientId: accessReq.clientId, token: saved.token || null })
        app.debug('no token configured -- requesting device access (approve under Security -> Access Requests)')
        accessReq.start((newToken) => {
          if (emulator) { emulator.setToken(newToken) }
          writeSaved({ clientId: accessReq.clientId, token: newToken })
          app.setPluginStatus('Access approved -- token stored, bridge can steer')
        })
      }

      if (o.enableCommissioningHead) {
        head = new ControlHead(app, {
          canInterface: o.canInterface || 'can0',
          headAddress: (typeof o.headAddress === 'number') ? o.headAddress : 44,
          acAddress: (typeof o.preferredAddress === 'number') ? o.preferredAddress : 35
        })
        head.start()
      }
      app.setPluginStatus('Starting Simrad ' + (o.acModel || 'AC42') +
        ' emulator on ' + (o.canInterface || 'can0') +
        (o.enableCommissioningHead ? ' + commissioning head' : '') + '…')
    } catch (e) {
      app.setPluginError('Failed to start: ' + (e && e.message))
      app.error(e)
    }
  }

  plugin.stop = function () {
    if (accessReq) {
      accessReq.stop()
      accessReq = null
    }
    if (head) {
      head.stop()
      head = null
    }
    if (emulator) {
      emulator.stop()
      emulator = null
    }
    app.setPluginStatus('Stopped')
  }

  return plugin
}
