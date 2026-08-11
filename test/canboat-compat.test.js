'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { createPgnStream, pickAddressClaim } = require('../lib/canboat-compat')

// Regression guard for the 0.6.1-beta load failure: the plugin required an
// internal canboatjs subpath (lib/fromPgnStream) that 3.x moved to dist/, so it
// failed to start on any server bundling canboatjs 3.x. createPgnStream() now
// builds the parse stream on the public root export FromPgn instead. This drives
// it against the REAL canboatjs (a devDependency, pinned to 3.x -- the layout
// that broke) so a future root-API change breaks this test rather than every
// user's server. plugin.test.js can't cover this: it runs start() with canboatjs
// ABSENT, so the require never executes there. Skipped if the peer is missing.
let hasCanboat = true
try { require('@canboat/canboatjs') } catch (e) { hasCanboat = false }

test('createPgnStream parses a PGN via the public canboatjs API',
  { skip: hasCanboat ? false : 'canboatjs not installed' }, async () => {
    const stream = createPgnStream()
    const parsed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no PGN emitted')), 1000)
      stream.once('data', (pgn) => { clearTimeout(timer); resolve(pgn) })
      stream.once('error', (err) => { clearTimeout(timer); reject(err) })
      // 127245 Rudder, canonical Actisense serial format
      stream.write('2016-04-09T16:41:39.628Z,3,127245,204,255,8,fc,f8,ff,7f,ff,7f,ff,ff')
    })
    assert.strictEqual(parsed.pgn, 127245)
  })

// The address claim has to reach the bus intact on BOTH canboatjs generations, and
// the two shapes that achieve it are mutually incompatible: 3.19+ injects a `fields`
// object into a caller-supplied claim and then encodes from it alone, while 2.x
// encodes an all-ones frame the moment `fields` is present. pickAddressClaim probes
// the encoder to decide. This drives the probe against the REAL canboatjs so a future
// change in either direction breaks the test rather than a user's first commissioning
// -- the original bug was invisible short of a candump (issue #1).
//
// The injection is what has to be reproduced here, NOT just the encoding. toPgn alone
// encodes both shapes correctly on 3.x, so a test that only called toPgn would pass
// with the fix removed on every 3.x host -- i.e. on the machine this suite normally
// runs on, which is exactly the blind spot that let the bug ship. What follows mirrors
// n2kDevice's constructor: create `fields` if absent, carry the unique number across,
// and leave every other top-level key behind. Reaching into canboatjs' own n2kDevice
// instead would re-introduce the internal-subpath fragility that broke 0.6.1-beta.
function asN2kDeviceWouldSendIt (claim) {
  const c = JSON.parse(JSON.stringify(claim))
  const fields = (c.fields = c.fields || {})
  if (fields.uniqueNumber === undefined) {
    const legacy = c.uniqueNumber ?? c['Unique Number']
    if (legacy !== undefined) { fields.uniqueNumber = legacy }
  }
  return c
}

test('pickAddressClaim yields a claim the resolved canboatjs encodes correctly',
  { skip: hasCanboat ? false : 'canboatjs not installed' }, () => {
    const { toPgn } = require('@canboat/canboatjs')
    const ACEmulator = require('../lib/ac-emulator')
    const ControlHead = require('../lib/control-head')
    const app = { debug: () => {}, error: () => {} }
    const cases = [
      [new ACEmulator(app, { acModel: 'AC42' }), 'e1b93ae8009651c0'],
      [new ControlHead(app, {}), '3675a02f008c51c0']
    ]

    // Two DIFFERENT version boundaries, and conflating them is a mistake this test
    // has already made once: `fields` has been encoded since 3.0, while n2kDevice
    // only began injecting one in 3.19. Between those the plugin must pick the
    // nested shape even though nothing injects.
    //
    // Whether the encoder honours `fields` is MEASURED here, not read off a version
    // number, and measured without going through the plugin's probe -- a test that
    // asked the probe what to expect would agree with it even when it is wrong,
    // which is the one failure that matters. The injection boundary has no such
    // observable, so it comes from the version.
    const [acObj, acHex] = cases[0]
    const honoursFields =
      toPgn(JSON.parse(JSON.stringify(acObj.fieldsClaim))).toString('hex') === acHex
    const [major, minor] = require('@canboat/canboatjs/package.json')
      .version.split('.').map(Number)
    const injects = major > 3 || (major === 3 && minor >= 19)

    for (const [obj, expected] of cases) {
      const picked = pickAddressClaim(obj.fieldsClaim, obj.addressClaim)
      assert.strictEqual(Object.prototype.hasOwnProperty.call(picked, 'fields'), honoursFields,
        'the nested shape must be picked exactly where the encoder reads one')
      // Correct as picked: 2.x reads the top-level names, 3.x reads either.
      assert.strictEqual(toPgn(JSON.parse(JSON.stringify(picked))).toString('hex'), expected)
      // And correct through the injection, which is where a top-level claim is lost.
      if (injects) {
        assert.strictEqual(toPgn(asN2kDeviceWouldSendIt(picked)).toString('hex'), expected)
      }
    }
  })

// canboatjs 2.7.0-3.16.4 assign their own package version over a caller-supplied product
// info's Software Version Code. pinField holds the intended value against it.
test('product info keeps its Software Version Code when canboatjs assigns over it', () => {
  const ACEmulator = require('../lib/ac-emulator')
  const app = { debug: () => {}, error: () => {} }
  const pi = new ACEmulator(app, { acModel: 'AC42' }).productInfo
  assert.strictEqual(pi['Software Version Code'], '1100')
  pi['Software Version Code'] = '2.10.0'          // what CanDevice does
  assert.strictEqual(pi['Software Version Code'], '1100')
  assert.strictEqual(JSON.parse(JSON.stringify(pi))['Software Version Code'], '1100')
})

// A commissioning head that could not get its configured address transmits from
// wherever canboatjs put it, and it sends a real AP-group standby to the AC every 2 s.
// If isOwnSrc only knew the configured address, that would decode as a genuine press
// and drop the pilot to standby for as long as commissioning mode is on.
//
// The real callers (bestMfd, findSteeringRole) pass Object.keys(devices), i.e. STRINGS,
// so every case is asserted both ways -- a numeric-only comparison would pass a
// number-only test and still let every device through in the status view.
test('isOwnSrc excludes the address the commissioning head actually claimed', () => {
  const ACEmulator = require('../lib/ac-emulator')
  const app = { debug: () => {}, error: () => {} }
  const ac = new ACEmulator(app, { enableCommissioningHead: true, headAddress: 44 })
  const own = (src) => {
    const n = ac.isOwnSrc(src)
    assert.strictEqual(ac.isOwnSrc(String(src)), n, `string and number must agree for ${src}`)
    return n
  }
  assert.strictEqual(own(44), true, 'configured head address')
  assert.strictEqual(own(45), false, 'not ours until the head says so')
  ac.setCommissioningHead({ myAddr: () => 45 })   // canboatjs moved it: 44 was taken
  assert.strictEqual(own(45), true, 'claimed head address')
  assert.strictEqual(own(44), true, 'configured address stays excluded')

  // The AC's own address, once it has claimed one. Without the stub myAddr() is
  // undefined and every assertion below would pass for the wrong reason.
  assert.strictEqual(own(35), false, 'a foreign device before the AC has claimed')
  ac.canbus = { candevice: { address: 35 } }
  assert.strictEqual(own(35), true, "the AC's own claimed address")
  assert.strictEqual(own(36), false, 'a real device is still a real device')
  assert.strictEqual(ac.isOwnSrc(null), false, 'no source is not our source')
})

// The head's targeted 130850 standby has to reach the AC where the AC ACTUALLY is.
// If the AC's configured address was taken, canboatjs moved it, and a standby sent to
// the configured one is addressed at whatever device kept it -- the MFD's commissioning
// gate then never opens, silently. Same class of bug as isOwnSrc above, and it survived
// the review that fixed isOwnSrc.
test('the commissioning head targets the AC address the emulator actually claimed', () => {
  const ControlHead = require('../lib/control-head')
  const app = { debug: () => {}, error: () => {} }
  const frames = []
  const mk = (opts) => {
    const h = new ControlHead(app, opts)
    h.canbus = { sendPGN: (s) => frames.push(s) }
    return h
  }
  // Before the AC has claimed, the configured address is all there is.
  mk({ acAddress: 35, acAddrFn: () => null }).standby()
  assert.match(frames.pop(), /,130850,.*41,9f,23,/, 'falls back to the configured address')
  // Once it has claimed elsewhere, follow it.
  mk({ acAddress: 35, acAddrFn: () => 36 }).standby()
  assert.match(frames.pop(), /,130850,.*41,9f,24,/, 'follows the claimed address')
  // No getter at all (plugin did not wire one) must not throw.
  mk({ acAddress: 35 }).standby()
  assert.match(frames.pop(), /,130850,.*41,9f,23,/, 'no getter is not a crash')
})

// The head's product info needs the same pin as the AC's -- canboatjs 2.7.0-3.16.4 would
// otherwise stamp its own version over it.
test('the commissioning head keeps its Software Version Code too', () => {
  const ControlHead = require('../lib/control-head')
  const pi = new ControlHead({ debug: () => {}, error: () => {} }, {}).productInfo
  pi['Software Version Code'] = '2.10.0'
  assert.strictEqual(pi['Software Version Code'], '1.4.13.00')
})
