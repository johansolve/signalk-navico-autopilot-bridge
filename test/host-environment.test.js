'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { resolveEndpoint, isOpenServer, DEFAULT_PORT, DEFAULT_SSL_PORT } = require('../lib/sk-endpoint')
const { canboatVersion } = require('../lib/canboat-compat')
const ACEmulator = require('../lib/ac-emulator')

let hasCanboat = true
try { require('@canboat/canboatjs') } catch (e) { hasCanboat = false }

// Everything here covers a host configuration the development rig does not have, which
// is why none of it could be caught by running the plugin on the boat. Each of these
// shipped broken for months.
const quietApp = (settings) => ({
  debug () {},
  error () {},
  setPluginStatus () {},
  setPluginError () {},
  config: settings ? { settings } : undefined
})

// A server with SSL enabled does not serve the API on 3000 at all -- that port becomes a
// redirect server answering 302 to everything, so every V2 poll, every steer command and
// the access request all fail in different-looking ways (issue #4).
test('the endpoint follows the server, not the 2023 default', () => {
  const cases = [
    ['no app at all', undefined, {}, 'http', DEFAULT_PORT],
    ['plain server', { port: 3000 }, {}, 'http', 3000],
    ['plain server on another port', { port: 8080 }, {}, 'http', 8080],
    ['ssl server', { ssl: true, sslport: 3443 }, {}, 'https', 3443],
    ['ssl server, sslport unset', { ssl: true }, {}, 'https', DEFAULT_SSL_PORT],
    // The bare default must never win over the server: 3000 is what the config field has
    // always held, so honouring it would leave every untouched install broken.
    ['ssl, skPort left at its default', { ssl: true, sslport: 3443 }, { port: DEFAULT_PORT }, 'https', 3443],
    // ...but an explicitly different port is the only way to reach another server.
    ['ssl, skPort deliberately set', { ssl: true, sslport: 3443 }, { port: 9000 }, 'http', 9000]
  ]
  for (const [name, settings, opts, protocol, port] of cases) {
    const ep = resolveEndpoint(quietApp(settings), opts)
    assert.strictEqual(ep.protocol, protocol, `${name}: protocol`)
    assert.strictEqual(ep.port, port, `${name}: port`)
    assert.strictEqual(typeof ep.transport.request, 'function', `${name}: transport`)
  }
})

// Only the host server's settings describe the host server. Pointed elsewhere, assuming
// the remote mirrors this one would be the same class of mistake being fixed here.
test('a non-loopback host is taken as given, not derived from our own settings', () => {
  const ep = resolveEndpoint(quietApp({ ssl: true, sslport: 3443 }), { host: '192.168.1.5' })
  assert.strictEqual(ep.protocol, 'http')
  assert.strictEqual(ep.port, DEFAULT_PORT)
  assert.strictEqual(ep.host, '192.168.1.5')
})

test('both loopback clients use the resolved endpoint', () => {
  const app = quietApp({ ssl: true, sslport: 3443 })
  const ac = new ACEmulator(app, { acModel: 'AC42' })
  assert.strictEqual(ac.sk.port, 3443)
  assert.strictEqual(ac.sk.endpoint.protocol, 'https')
  const AccessRequest = require('../lib/access-request')
  const ar = new AccessRequest({ app })
  assert.strictEqual(ar.port, 3443)
  assert.strictEqual(ar.endpoint.protocol, 'https')
})

// With security disabled the server 404s the access request ("Server security is not
// enabled") and its ACL permits everything. Refusing to steer without a token left the
// bridge permanently dead while pointing the user at a menu their server does not have
// (issue #5).
test('an open server steers without a token instead of waiting for one', () => {
  const open = new ACEmulator(quietApp(), { acModel: 'AC42', bridge: 'live', openServer: true })
  const closed = new ACEmulator(quietApp(), { acModel: 'AC42', bridge: 'live' })

  let sent = false
  open.sk.setState = (v, cb) => { sent = true; cb(null, 200, '') }
  open.applyV2('test', (cb) => open.sk.setState('auto', cb))
  assert.ok(sent, 'an open server must send the command')
  assert.notStrictEqual(open.statusJson().lastV2Result, 'NO TOKEN (approve access under Security -> Access Requests)')

  let sentClosed = false
  closed.sk.setState = (v, cb) => { sentClosed = true; cb(null, 200, '') }
  closed.applyV2('test', (cb) => closed.sk.setState('auto', cb))
  assert.ok(!sentClosed, 'a secured server with no token must still refuse')
})

// canboatjs reports an unopenable bus through setProviderError on the app it was given
// and then retries forever. With a bare EventEmitter that call was a no-op, so nothing
// surfaced: no claim, no timers, and a GREEN status line frozen on "Starting ..."
// (issue #6).
test('a CAN interface that never opens becomes a plugin error naming the interface', () => {
  const errors = []
  const app = Object.assign(quietApp(), { setPluginError: (m) => errors.push(m) })
  const ac = new ACEmulator(app, { acModel: 'AC42', canInterface: 'can404' })
  ac.canbusError('probe')
  assert.strictEqual(errors.length, 1)
  assert.match(errors[0], /CAN bus not available/)
  assert.match(errors[0], /can404/, 'must name the interface that failed')
  assert.match(errors[0], /does not exist/, 'a missing interface is worth saying outright')
  assert.strictEqual(ac.statusJson().canbusError, errors[0], 'and it must reach the status page')
})

// Whether the message may promise a retry turns on the canboatjs major, and reading that
// version was itself subject to the bug this release is about: a bare
// require('@canboat/canboatjs/package.json') resolves from the PLUGIN, so it throws on
// every stock install, where canboatjs exists only in the server's tree. The version read
// as unknown, and 3.x hosts -- which do retry every 5 s -- were told nothing.
//
// Running the assertion in THIS process proves nothing: canboatjs is a devDependency
// sitting beside the plugin here, which is the one layout where the bug cannot occur. So
// build the layout that breaks -- canboatjs only in a server tree, none beside the plugin
// -- and read the version from a child whose require.main is that server's entry file.
test('the canboatjs version is read through the resolver that found it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navico-resolver-'))
  try {
    const pkg = path.join(dir, 'srv', 'node_modules', '@canboat', 'canboatjs')
    fs.mkdirSync(pkg, { recursive: true })
    fs.writeFileSync(path.join(pkg, 'package.json'),
      '{"name":"@canboat/canboatjs","version":"9.9.9","main":"index.js"}')
    fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = { toPgn: () => null }\n')

    // The plugin, with nothing resolvable beside it: a copy under a bare temp directory,
    // so require() walks up and finds no node_modules at all.
    const lib = path.join(dir, 'plugin', 'lib')
    fs.mkdirSync(lib, { recursive: true })
    fs.copyFileSync(path.join(__dirname, '..', 'lib', 'canboat-compat.js'),
      path.join(lib, 'canboat-compat.js'))

    const bin = path.join(dir, 'srv', 'bin', 'server.js')
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin,
      `const { canboatVersion } = require(${JSON.stringify(path.join(lib, 'canboat-compat.js'))})\n` +
      'process.stdout.write(String(canboatVersion()))\n')

    const seen = execFileSync(process.execPath, [bin], { encoding: 'utf8' })
    assert.strictEqual(seen, '9.9.9',
      'the version must be read through whichever resolver found canboatjs, not the plugin\'s own')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// Wiring only: that the version actually reaches the message. It cannot detect the
// resolver bug -- both sides of the comparison come from canboatVersion() -- which is what
// the fixture above is for.
test('the resolved major decides whether a retry is promised',
  { skip: hasCanboat ? false : 'canboatjs not installed' }, () => {
    const major = parseInt(String(canboatVersion()).split('.')[0], 10)
    const errors = []
    const ac = new ACEmulator(Object.assign(quietApp(), { setPluginError: (m) => errors.push(m) }),
      { acModel: 'AC42', canInterface: 'can404' })
    ac.canbusError('probe')
    if (major >= 3) {
      assert.match(errors[0], /Retrying in the background/, '3.x does retry, so say so')
    } else {
      // Not /Retrying/: canboatjs 2.x's own text ("Stopped, Retrying...") is interpolated
      // into the same message, so the loose pattern would fail for an unrelated reason.
      assert.doesNotMatch(errors[0], /Retrying in the background/,
        '2.x does not retry a bus it could not open, so promising it would be a lie')
    }
  })

// start() needs canboatjs and a live CAN interface, so the watchdog is driven through the
// method start() actually calls. An earlier version of this test set claimWatchdog by hand
// and so proved only that stop() clears it -- the arming could have been deleted outright
// without failing anything.
test('the claim watchdog is armed and cleared on stop', () => {
  const ac = new ACEmulator(quietApp(), { acModel: 'AC42', canInterface: 'can404' })
  const timer = ac.armClaimWatchdog()
  assert.ok(timer, 'arming must return a live timer')
  assert.strictEqual(ac.claimWatchdog, timer)
  ac.stop()
  assert.strictEqual(ac.claimWatchdog, null, 'a pending watchdog must not outlive stop()')

  // It must also not fire against a bus that came up in the meantime.
  const ok = new ACEmulator(quietApp(), { acModel: 'AC42', canInterface: 'can404' })
  ok.canbus = { on () {}, pipe () {}, end () {} }
  ok.armClaimWatchdog()
  ok.onClaimDone()
  assert.strictEqual(ok.claimWatchdog, null, 'a completed claim disarms it')
  ok.stop()
})

// canboatjs' own retry timer outlives end(), so its error callback keeps firing long after
// the plugin stopped: a disabled plugin painting itself red every few seconds forever, one
// loop per restart.
test('a stopped plugin stops reporting CAN errors', () => {
  const errors = []
  const app = Object.assign(quietApp(), { setPluginError: (m) => errors.push(m) })
  const ac = new ACEmulator(app, { acModel: 'AC42', canInterface: 'can404' })
  ac.canbusError('while running')
  assert.strictEqual(errors.length, 1)
  ac.stop()
  ac.canbusError('canboatjs retry after stop')
  assert.strictEqual(errors.length, 1, 'nothing may be reported after stop()')
})

// canboatjs calls both hooks as (providerId, msg). Taking only the first argument is how
// the first attempt at this reported "CAN bus not available: undefined".
test('the canboatjs error hook reads the message, not the provider id', () => {
  const errors = []
  const app = Object.assign(quietApp(), { setPluginError: (m) => errors.push(m) })
  const ac = new ACEmulator(app, { acModel: 'AC42', canInterface: 'can404' })
  const bus = ac.makeCanbusApp()
  bus.setProviderError('n2k-on-ve.can-socket', 'Failed to load native canSocket module')
  assert.match(errors[0], /Failed to load native canSocket module/)
  assert.doesNotMatch(errors[0], /undefined/)
  assert.doesNotMatch(errors[0], /n2k-on-ve\.can-socket/, 'the provider id is not the reason')
})

// A transient channel drop reports through the same hook while the bus is healthy. Clearing
// the flag only after the bootDone guard left a working bus flagged broken for the session.
test('a reconnect clears the CAN error rather than leaving it stuck', () => {
  const ac = new ACEmulator(quietApp(), { acModel: 'AC42', canInterface: 'can404' })
  ac.bootDone = true
  ac.canbus = { on () {}, pipe () {}, end () {} }
  ac.canbusError('Stopped unexpectedly, Retrying...')
  assert.ok(ac.statusJson().canbusError, 'a live drop is worth reporting')
  ac.onClaimDone()
  assert.strictEqual(ac.statusJson().canbusError, null, 'and must clear when it comes back')
})

// The V1 advanceWaypoint action is registered by signalk-autopilot. The providers this
// plugin recommends do not have it, and the server answers 405 -- with the whole Nav and
// Track half of the bridge silently unavailable (issue #9).
test('a 405 on advanceWaypoint is reported, not just logged', () => {
  const ac = new ACEmulator(quietApp(), { acModel: 'AC42', bridge: 'live', openServer: true })
  assert.ok(!ac.statusSummary().includes('NO advanceWaypoint'))
  ac.applyV2('re-engage track (V1 advanceWaypoint)', (cb) => cb(null, 405, 'Method Not Allowed'))
  assert.ok(ac.noAdvanceAction, 'a 405 there means the provider has no handler')
  assert.match(ac.statusSummary(), /NO advanceWaypoint/)
  // A 405 from something else must not be blamed on the action.
  const other = new ACEmulator(quietApp(), { acModel: 'AC42', bridge: 'live', openServer: true })
  other.applyV2('set state auto', (cb) => cb(null, 405, 'Method Not Allowed'))
  assert.ok(!other.noAdvanceAction)

  // A provider installed or reconfigured while the plugin runs makes the action appear;
  // without clearing, the warning would stand for the rest of the process.
  ac.applyV2('auto-advance 12deg (V1 advanceWaypoint)', (cb) => cb(null, 200, ''))
  assert.ok(!ac.noAdvanceAction, 'a later success must clear the warning')
  assert.ok(!ac.statusSummary().includes('NO advanceWaypoint'))
})

// A boat whose only heading source is a GPS compass publishes headingTrue alone, and got
// no 127237, no 127250 and no 65341 heading at all -- the MFD showed "- - -". It can be
// served, but only by converting: every frame here declares its heading magnetic, so a
// true one in them would be a wrong reference on the bus, and with enableStdPgns the
// server reads our own 127250 back as headingMagnetic and feeds it to us again.
test('heading is converted to magnetic, never mislabelled', () => {
  const ac = new ACEmulator(quietApp(), { acModel: 'AC42' })
  const vals = {}
  ac.selfPathNum = (p) => (vals[p] === undefined ? null : vals[p])
  assert.strictEqual(ac.headingRad(), null, 'no heading at all stays null')
  vals['navigation.headingTrue.value'] = 1.5
  assert.strictEqual(ac.headingRad(), null, 'true alone must NOT go out as magnetic')
  vals['navigation.magneticVariation.value'] = 0.1
  assert.ok(Math.abs(ac.headingRad() - 1.4) < 1e-9, 'true minus variation is magnetic')
  vals['navigation.headingMagnetic.value'] = 1.2
  assert.strictEqual(ac.headingRad(), 1.2, 'a real magnetic heading still wins')
  // East of the agonic line the difference is negative and must wrap, not go below zero.
  delete vals['navigation.headingMagnetic.value']
  vals['navigation.headingTrue.value'] = 0.05
  vals['navigation.magneticVariation.value'] = 0.2
  const h = ac.headingRad()
  assert.ok(h > 6.1 && h < 6.2, `wrapped into range, got ${h}`)
})

// The source registry carries raw canboat fields, so their spelling follows whichever
// canboatjs the SERVER bundles: camelCase on 3.x, Title Case on 2.x. Reading one only
// meant no device names at all on the other.
test('device names resolve under both canboat field spellings', () => {
  const ac = new ACEmulator(quietApp(), { acModel: 'AC42' })
  const camel = { manufacturerCode: 'B & G', modelId: 'Triton2', deviceClass: 'Display' }
  const title = { 'Manufacturer Code': 'B & G', 'Model ID': 'Triton2', 'Device Class': 'Display' }
  assert.strictEqual(ac.deviceLabel(camel), 'B & G Triton2')
  assert.strictEqual(ac.deviceLabel(title), 'B & G Triton2', '2.x spelling must work too')

  const sources = (n) => ({ 'n2k-on-ve.can-socket': { 44: { n2k: n } } })
  const headCamel = { manufacturerCode: 'Raymarine', modelId: 'p70s', deviceClass: 'Steering and Control surfaces', deviceFunction: 140 }
  const headTitle = { 'Manufacturer Code': 'Raymarine', 'Model ID': 'p70s', 'Device Class': 'Steering and Control surfaces', 'Device Function': 140 }
  assert.strictEqual(ac.findSteeringRole(sources(headCamel), 140, null).src, 44)
  assert.strictEqual(ac.findSteeringRole(sources(headTitle), 140, null).src, 44, '2.x spelling must work too')
})

// The one part of #5 that has to agree with the SERVER is the security-state reading, and
// it was the one part no test touched: openServer could be hardcoded either way without
// failing anything.
//
// Deliberately NOT driven through plugin.start(): on a machine that has canboatjs and a
// real CAN interface -- i.e. the boat -- that opens the bus and puts a second emulator on
// it, claiming the same address as the running one. It did, once.
test('security state is read from the server, not assumed', () => {
  const mk = (ss) => isOpenServer(ss === undefined ? {} : { securityStrategy: ss })
  assert.strictEqual(mk({ isDummy: () => true }), true, 'a dummy strategy means no token is needed')
  assert.strictEqual(mk({ isDummy: () => false }), false, 'a secured server must not be treated as open')
  assert.strictEqual(mk({}), false, 'a strategy without isDummy() must not be assumed open')
  assert.strictEqual(mk(undefined), false, 'no strategy at all must not be assumed open')
  assert.strictEqual(mk({ isDummy () { throw new Error('boom') } }), false, 'a throw is not consent')
})
