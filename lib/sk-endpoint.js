'use strict'

const http = require('http')
const https = require('https')

// Where the SignalK server this plugin runs inside is actually listening, and how to
// talk to it.
//
// The loopback clients used to hardcode http://127.0.0.1:3000. On a server with SSL
// enabled that is not the API at all: the primary listener moves to `sslport` (3443 by
// default) and port 3000 becomes a pure redirect server that answers 302 to everything.
// Every V2 poll then returns 302 instead of 200, so the firehose degrades to standby;
// every steer command reads as refused and rolls the display back; and the access
// request never sees a token, so it retries forever and the plugin sits on NO TOKEN.
// Setting skPort to 3443 does not rescue it either -- an http request against a TLS
// listener fails at the socket. The net effect is that the bridge cannot work at all on
// an SSL server, while presenting as several unrelated faults (issue #4).
//
// The truth is in app.config.settings, which the plugin already has. Read it, and treat
// the config fields as an override for the unusual case of talking to a DIFFERENT
// server rather than as the primary source.
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3000
const DEFAULT_SSL_PORT = 3443

function intOrNull (v) {
  const n = parseInt(v, 10)
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : null
}

// Mirrors the server's own precedence (src/ports.ts): environment first, then
// settings, then the built-in default.
function resolveEndpoint (app, opts) {
  const o = opts || {}
  const settings = (app && app.config && app.config.settings) || {}
  const ssl = !!settings.ssl
  const envPort = intOrNull(process.env.PORT)
  const envSslPort = intOrNull(process.env.SSLPORT)
  const serverPort = ssl
    ? (envSslPort || intOrNull(settings.sslport) || DEFAULT_SSL_PORT)
    : (envPort || intOrNull(settings.port) || DEFAULT_PORT)

  // Only the HOST server's settings say anything about the host server. Pointed at
  // another machine, we know nothing about how it listens, so take the configured
  // values as given rather than assuming it mirrors this one -- that assumption is the
  // same class of mistake as the one being fixed here.
  const host = o.host || DEFAULT_HOST
  const isLoopback = host === DEFAULT_HOST || host === 'localhost' || host === '::1'

  // An explicitly configured port wins -- it is the only way to reach a server other
  // than the host one -- but the bare default must not: 3000 is what the field has
  // always defaulted to, and honouring it on an SSL server would reinstate the bug for
  // everyone who never touched the setting.
  const configured = intOrNull(o.port)
  const port = isLoopback
    ? ((configured && configured !== DEFAULT_PORT) ? configured : serverPort)
    : (configured || DEFAULT_PORT)
  const useTls = isLoopback && ssl && port === serverPort

  return {
    host,
    port,
    protocol: useTls ? 'https' : 'http',
    transport: useTls ? https : http,
    // SignalK generates a self-signed certificate unless the user installed their own,
    // and this is a loopback call to the process we are running inside. Verifying it
    // would fail for the common case and protects nothing here.
    rejectUnauthorized: false,
    describe () { return `${useTls ? 'https' : 'http'}://${host}:${port}` }
  }
}

// Whether the host server runs without security. Such a server issues no tokens -- it
// answers 404 to an access request ("Access requests not available. Server security is
// not enabled.") and its ACL permits everything -- so waiting for one means never
// steering, and telling the user to approve it points at a menu they do not have.
//
// A plain function rather than a line inside start(), because the alternative is a test
// that calls plugin.start() to reach it: on a machine that HAS canboatjs and a real CAN
// interface, that puts a second emulator on the boat's bus. It did, once.
function isOpenServer (app) {
  const ss = app && app.securityStrategy
  if (!ss || typeof ss.isDummy !== 'function') { return false }
  try { return !!ss.isDummy() } catch (e) { return false }
}

module.exports = { resolveEndpoint, isOpenServer, DEFAULT_PORT, DEFAULT_SSL_PORT }
