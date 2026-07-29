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
    name: 'Autopilot — Navico bridge',
    description:
      'Emulates a Simrad AC12/AC42 autopilot computer so a Navico MFD (B&G ' +
      'Vulcan/Zeus, Simrad, Lowrance) binds to it and sends its autopilot ' +
      'control-view button presses as Simnet 130850 commands. Those are decoded ' +
      'and translated into the SignalK Autopilot V2 API, driving whichever pilot ' +
      'backs it (e.g. a Raymarine EV-200 via signalk-autopilot). ' +
      'ALPHA: see README for verified behaviour and known limitations.'
  }

  // Which flat option belongs in which config-page group. The grouping is presentation only:
  // flatten() turns it back into the single flat object the emulator and this file already take,
  // and start() rewrites a pre-0.8.1 flat config into the grouped shape once, so upgrading does
  // not silently reset anyone's settings to the defaults the empty groups would show.
  const GROUPS = {
    n2k: ['canInterface', 'acModel', 'preferredAddress', 'enableFirehose', 'enableStdPgns'],
    pilot: ['bridge', 'autopilotId', 'skHost', 'skPort', 'token'],
    advance: ['autoAdvanceMaxDeg'],
    restart: ['autoConfirmRestart'],
    commissioning: ['enableCommissioningHead', 'headAddress']
  }
  const OPTION_KEYS = Object.keys(GROUPS).reduce((a, g) => a.concat(GROUPS[g]), [])

  const baseSchema = {
    type: 'object',
    properties: {
      n2k: {
        type: 'object',
        title: 'NMEA 2000 and emulated device',
        required: ['canInterface', 'acModel', 'preferredAddress'],
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
            description: 'Identity broadcast to the MFD. Both AC42 and AC12 bind a ' +
              'Vulcan 7; the model only sets the reported product info, not whether ' +
              'it binds. AC42 matches the reference capture.',
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
            title: 'Broadcast AC autopilot state (required)',
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
          }
        }
      },
      pilot: {
        type: 'object',
        title: 'Pilot control via SignalK',
        required: ['bridge'],
        properties: {
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
            description: 'Which `autopilots/<id>` the V2 API drives. Usually `_default`.',
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
          }
        }
      },
      // A checkbox renders its title as the label BELOW its own description, and the admin UI's
      // markdown option is read by the field template, which the checkbox widget bypasses -- so
      // a boolean cannot get a heading of its own. The group title is the only heading available
      // to it, which is why the two Track confirmations are separate groups rather than one:
      // it puts a heading above the restart explanation instead of leaving it floating under the
      // waypoint-advance input, reading as part of that field.
      advance: {
        type: 'object',
        title: 'Track waypoint advance',
        description: 'At each waypoint of a route the pilot enters Track-pending and normally ' +
          'waits for a control-head Yes before turning onto the next leg. Requires Bridge ' +
          'mode = live.',
        properties: {
          autoAdvanceMaxDeg: {
            type: 'number',
            title: 'Auto-confirm waypoint advance up to (degrees; 0 = off)',
            description: 'Answer that automatically when the course change to the next leg is ' +
              'at most this many degrees, so small turns need no control-head press. Larger ' +
              'turns are left for a manual confirm. 0 disables it (every advance is manual). ' +
              'Set deliberately.',
            default: 0
          }
        }
      },
      restart: {
        type: 'object',
        title: 'Track restart',
        description: 'Engaging Nav while off the rhumb line makes the pilot swing hard to ' +
          'intercept it. Pressing Restart on the MFD re-origins the leg onto the boat so it ' +
          'steers straight at the same waypoint instead — and the pilot asks for a ' +
          'control-head Yes for that too. Requires Bridge mode = live.',
        properties: {
          autoConfirmRestart: {
            type: 'boolean',
            title: 'Auto-confirm a Track restart (leg re-origin)',
            description: 'Answer it automatically, up to a 90° turn. Beyond that (the waypoint ' +
              'abaft the beam a re-origin asks for a near-reciprocal turn) it stays manual. ' +
              'Its own switch, not a widening of the waypoint-advance setting — see the README.',
            default: false
          }
        }
      },
      // Last on the page on purpose: needed once, at first commissioning, and off ever after.
      commissioning: {
        type: 'object',
        title: 'Commissioning',
        description: 'Only for FIRST commissioning against a new MFD. Leave off in normal use.',
        properties: {
          enableCommissioningHead: {
            type: 'boolean',
            title: 'Commissioning mode (emulate a control head)',
            description: 'Emulate a B&G keypad on a second address to open the MFD ' +
              '"press standby" gate. Enable only while commissioning, then turn it off.',
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
    }
  }

  // The config-page schema is built fresh each time the admin UI requests it, so the
  // device names resolved live off the N2K bus can be woven into the relevant field
  // descriptions (SignalK only re-reads the schema on page load, so this is not live --
  // the status webapp shows the same info live). Falls back to the base schema on any error.
  plugin.schema = function () {
    try {
      const s = JSON.parse(JSON.stringify(baseSchema))
      const d = (emulator && typeof emulator.statusJson === 'function') ? emulator.statusJson() : null
      if (d) {
        // Weave each detected device into the field it relates to, formatted as markdown
        // (enabled per field via plugin.uiSchema) so it renders as a clean list rather than
        // run-on text -- the admin UI only renders markdown in field descriptions, not the
        // root/top block. MFD -> the AC-model field (which binds it); pilot chain -> the
        // target-autopilot-id field (which selects the V2 provider that drives it).
        // A device that is in the source registry but silent on the bus is flagged, so the
        // list never implies a powered-down plotter is still there. 'missing' (never heard
        // since start) reads as offline too -- same thing from the user's side.
        const mark = (name, presence) => name + ((presence === 'offline' || presence === 'missing') ? ' _(offline)_' : '')
        const acModel = s.properties.n2k && s.properties.n2k.properties.acModel
        const autopilotId = s.properties.pilot && s.properties.pilot.properties.autopilotId
        if (d.mfdName && acModel) {
          acModel.description += '\n\n**Bound MFD:** ' + mark(d.mfdName, d.mfdPresence)
        }
        if (autopilotId) {
          const rows = []
          if (d.pilotName) { rows.push('- Course computer: ' + mark(d.pilotName, d.pilotPresence)) }
          if (d.acuName) { rows.push('- Actuator: ' + mark(d.acuName, d.acuPresence)) }
          if (d.controlHeadName) { rows.push('- Control head: ' + mark(d.controlHeadName, d.headPresence)) }
          if (d.providerId) { rows.push('- Provider: ' + d.providerId) }
          if (rows.length) {
            autopilotId.description += '\n\n**Detected pilot hardware**\n\n' + rows.join('\n')
          }
        }
      }
      return s
    } catch (e) { return baseSchema }
  }

  // Render markdown in the two field descriptions the schema function augments, so the
  // detected-device lists show as formatted lists instead of literal ** and - text.
  // Render markdown in the two field descriptions the schema function augments, so the
  // detected-device lists show as formatted lists instead of literal ** and - text. Only these
  // two: the option is read by the admin UI's FIELD TEMPLATE, so it works for a text or select
  // field but does nothing on a checkbox, whose widget renders its own description -- asking for
  // it there just prints the asterisks.
  const md = { 'ui:options': { enableMarkdownInDescription: true } }
  plugin.uiSchema = {
    n2k: { acModel: md },
    pilot: { autopilotId: md }
  }

  // The groups are a config-page device only; everything downstream takes one flat object.
  // Collect the known option keys wherever they sit -- top level, or inside any group object.
  // Deliberately shape-agnostic rather than keyed to one past layout: the grouping has already
  // been rearranged once, and this keeps a config written by ANY version readable.
  function flatten (options) {
    const out = {}
    const take = (obj) => {
      if (!obj || typeof obj !== 'object') { return }
      for (const k of Object.keys(obj)) {
        if (OPTION_KEYS.indexOf(k) !== -1) { out[k] = obj[k] } else { take(obj[k]) }
      }
    }
    take(options)
    return out
  }

  // A config saved under an older layout -- flat, or an earlier grouping -- must be rewritten
  // into the current one BEFORE anyone opens the page. Left alone the admin UI renders the
  // groups it cannot find from their defaults, and the first save commits those over the live
  // settings: bridge would quietly drop back to dry-run. savePluginOptions only writes the file
  // (no plugin restart), and the rewritten config then equals the canonical form, so the test
  // below is false on the next start and it cannot loop.
  function needsRegroup (options, canonical) {
    if (!options || typeof options !== 'object') { return false }
    if (Object.keys(flatten(options)).length === 0) { return false }   // nothing saved yet
    return JSON.stringify(options) !== JSON.stringify(canonical)
  }

  function regroup (flat) {
    const out = {}
    for (const g of Object.keys(GROUPS)) {
      out[g] = {}
      for (const k of GROUPS[g]) {
        if (k in flat) { out[g][k] = flat[k] }
      }
    }
    return out
  }

  // A SignalK token is a JWT (three dot-separated parts). Ignore anything else
  // pasted into the config field so a stray value can't shadow a valid token.
  function validJwt (t) { return typeof t === 'string' && t.split('.').length === 3 }

  plugin.start = function (options) {
    const o = flatten(options)
    try {
      const canonical = regroup(o)
      if (needsRegroup(options, canonical) && typeof app.savePluginOptions === 'function') {
        app.savePluginOptions(canonical, (err) => {
          if (err) { app.error('could not rewrite config into the current layout: ' + (err.message || err)) } else { app.debug('rewrote config into the current grouped layout') }
        })
      }
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
        writeSaved({ clientId: accessReq.clientId, token: null })   // this branch only runs when no token exists yet
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

  // Read-only JSON status for the bundled status webapp (public/).
  function statusHandler (_req, res) {
    if (!emulator) { return res.status(503).json({ error: 'plugin not started' }) }
    res.json(emulator.statusJson())
  }
  // Primary: mounted under /signalk/v1/api/... which honours read access (no admin
  // token needed), so the webapp works for any logged-in user, not just admins.
  plugin.signalKApiRoutes = function (router) {
    router.get('/navico-autopilot-bridge/status', statusHandler)
    return router
  }
  // Fallback: /plugins/<id>/status (admin-gated) for direct/manual access.
  plugin.registerWithRouter = function (router) {
    router.get('/status', statusHandler)
  }

  return plugin
}
