'use strict'

const { Transform } = require('stream')
const { createRequire } = require('module')

// Resolve @canboat/canboatjs. It is declared an OPTIONAL peerDependency, which npm
// does not auto-install (deliberately: the appstore's plugin-ci runs --ignore-scripts
// and fails on any tree carrying a native addon, and canboatjs pulls in socketcan).
// So on a stock install there is no copy under ~/.signalk/node_modules at all, and the
// host server's own copy is unreachable: Node resolves upward from the plugin
// directory and never enters the globally installed signalk-server tree. Falling back
// to a require rooted at the SERVER's entry file reaches exactly that copy. Safe
// regardless of which major it bundles: the 130850 button decode reads raw frame
// bytes, and what is still read by field name (130845, 65345) accepts both the
// camelCase and Title Case spellings canboat renders -- see ac-emulator.
let canboat = null
function requireCanboat () {
  if (canboat) { return canboat }
  try {
    canboat = require('@canboat/canboatjs')
    return canboat
  } catch (e) { /* fall through to the host server's tree */ }
  // require.main is the server's bin script, resolved to its real path -- which is
  // what puts the server's node_modules on the lookup chain when the bin is a symlink
  // (the usual global install). process.argv[1] is a weaker second try: it keeps the
  // symlink, and may even be relative, in which case createRequire throws and the
  // candidate is simply skipped.
  for (const entry of [require.main && require.main.filename, process.argv[1]]) {
    if (!entry) { continue }
    try {
      canboat = createRequire(entry)('@canboat/canboatjs')
      return canboat
    } catch (e) { /* try the next candidate */ }
  }
  throw new Error(
    '@canboat/canboatjs not found, neither alongside the plugin nor in the SignalK ' +
    'server it runs under. Install it next to the plugin: ' +
    'npm install @canboat/canboatjs --prefix ~/.signalk'
  )
}

// Build a raw-frame -> parsed-PGN Transform from canboatjs' PUBLIC root export
// FromPgn (the Parser class), which both canboatjs 2.x and 3.x expose as
// require('@canboat/canboatjs').FromPgn. This reproduces canboatjs' own internal
// fromPgnStream wrapper (identical in both versions: new Parser(opts), push on
// 'pgn', parse(chunk) in _transform) WITHOUT requiring its version-specific file
// layout -- the wrapper moved from lib/fromPgnStream (2.x) to dist/fromPgnStream
// (3.x) and reaching that subpath directly breaks on the version the host server
// happens to bundle. Require lazily (from the caller's start()) so the module
// still loads, and the plugin registry can score it, when the peer is absent.
function createPgnStream (debug) {
  const log = (typeof debug === 'function') ? debug : () => {}
  const { FromPgn } = requireCanboat()
  const parser = new FromPgn({})
  const stream = new Transform({
    objectMode: true,
    transform (chunk, encoding, done) {
      parser.parse(chunk)
      done()
    }
  })
  parser.on('pgn', (pgn) => stream.push(pgn))
  // A Parser 'error' with no listener crashes the process (EventEmitter default),
  // so both handlers are mandatory, not just for logging -- canboatjs emits these
  // on malformed frames, which a glitching N2K cable at sea will produce.
  parser.on('warning', (pgn, w) => log(`canboat warning ${pgn && pgn.pgn}: ${w}`))
  parser.on('error', (pgn, e) => log(`canboat error ${pgn && pgn.pgn}: ${e}`))
  // canboatjs' Canbus overrides pipe(): pipe(dest) sets this.plainText = true when
  // dest lacks a .fromPgn property, flipping canbus from emitting frame OBJECTS
  // ({pgn,length,data}) to actisense STRINGS. FromPgn.parse() accepts both, so the
  // parsed pipe keeps working either way -- but the emulator's raw tap
  // (canbus.on('data') -> onRawFrame) needs msg.pgn, which a string lacks, so it
  // silently no-ops: no lastApRaw (ChangeCourse nudge dies) and no seen[] liveness
  // (every device shows offline). Expose the parser as .fromPgn, exactly like
  // canboatjs' own fromPgnStream, so pipe() keeps canbus in object mode.
  stream.fromPgn = parser
  return stream
}

// Pick the shape an address claim has to have for the canboatjs actually resolved.
//
// A PGN's values live in a nested `fields` object under canboat's camelCase ids, and
// toPgn has encoded from there for the whole 3.x line -- but it also still encodes a
// claim written with its fields at the TOP level, so that shape was never the problem
// by itself. What changed in 3.19 sits upstream of the encoder: n2kDevice takes a
// caller-supplied addressClaim verbatim, creates `fields` on it and migrates exactly
// ONE key into it -- uniqueNumber. From then on toPgn sees a `fields` and encodes from
// it alone, so a top-level claim loses every other field to its "not available"
// sentinel and goes out as e1 b9 fa ff ff ff ff ff: manufacturer 2047, device function
// 255, device class 127. No MFD can classify that as an autopilot computer, though it
// still lists the device and still lets it be picked as a source, because product info
// rides in 126996 and nothing injects `fields` there.
//
// 2.x does not merely ignore `fields`, it is broken by its presence: the same claim
// carrying both shapes encodes to ff ff ff ff ff ff ff ff, which is worse. So there is
// no single object that works on both, and which one is needed cannot be inferred from
// the plugin's own dependencies -- the resolved copy may be the server's.
//
// Probe the encoder instead of reading a version number: encode a claim only a
// fields-aware toPgn can satisfy and read Device Function and Device Class back out of
// bytes 5 and 6. Both present means `fields` is honoured; the 0xff sentinel in either
// means it is not. Failure to resolve canboatjs is NOT cached, so the plugin can still
// be loaded and scored by the registry without the optional peer present -- start() is
// where its absence is meant to be fatal.
//
// A probe that fails for some FUTURE reason -- a toPgn that throws on a signature it no
// longer accepts, say -- falls back to the top-level shape, which on a 3.19+ host is
// precisely the bug being fixed here, and just as invisible: the MFD lists the device,
// product info is intact, and only a candump shows it. That is why the outcome is
// logged rather than decided silently. It cost three weeks the first time.
// Device Class sits in the top 7 bits of byte 6; the low bit is reserved and canboat
// currently sends it as 1 (0x51 for class 40). Read the class out MASKED rather than
// comparing the whole byte: the reserved bit is not ours to depend on -- the real
// AC42's NAME template in PROTOCOL-REFERENCE has it as 0 -- and a probe that fails
// because an encoder stopped setting a reserved bit would fall back to the top-level
// shape, i.e. silently reinstate this very bug on a 3.19+ host.
const PROBE_DEVICE_FUNCTION = 150
const PROBE_DEVICE_CLASS = 40
let claimUsesFields = null
function canboatUsesFieldsClaim (debug) {
  const log = (typeof debug === 'function') ? debug : () => {}
  if (claimUsesFields !== null) {
    // Log every start(), not only the first: the cache is module-global and outlives a
    // plugin restart, which is exactly when someone has just turned debug on to look.
    log(`address claim: using the ${claimUsesFields ? 'nested fields' : 'top-level'} shape (cached probe)`)
    return claimUsesFields
  }
  const { toPgn } = requireCanboat()
  let ok = false
  let seen = 'none'
  try {
    const buf = toPgn({
      pgn: 60928,
      dst: 255,
      prio: 6,
      fields: {
        uniqueNumber: 1,
        manufacturerCode: 1857,
        deviceFunction: PROBE_DEVICE_FUNCTION,
        deviceClass: PROBE_DEVICE_CLASS,
        deviceInstanceLower: 0,
        deviceInstanceUpper: 0,
        systemInstance: 0,
        industryGroup: 4,
        arbitraryAddressCapable: 1
      }
    })
    if (buf && typeof buf.length === 'number') { seen = Buffer.isBuffer(buf) ? buf.toString('hex') : String(buf) }
    ok = !!(buf && buf.length === 8 &&
            buf[5] === PROBE_DEVICE_FUNCTION && (buf[6] >> 1) === PROBE_DEVICE_CLASS)
  } catch (e) {
    seen = `threw: ${e && e.message}`
  }
  claimUsesFields = ok
  log(`address claim: canboatjs probe encoded ${seen} -- using the ` +
      `${ok ? 'nested fields' : 'top-level'} shape`)
  return claimUsesFields
}

// Given both shapes of the same claim, return the one this canboatjs encodes correctly.
function pickAddressClaim (fieldsClaim, legacyClaim, debug) {
  return canboatUsesFieldsClaim(debug) ? fieldsClaim : legacyClaim
}

// Hold a product-info field against canboatjs overwriting it.
//
// canboatjs 2.7.0 through 3.16.4 assign their OWN package version over a caller-supplied
// product info's Software Version Code, unconditionally and outside the branch that takes
// the object by reference (lib/candevice.js, moved to lib/n2kDevice.js in 2.11), so the
// emulated AC advertised "2.10.0" where a real AC42 advertises "1100". 2.0 through 2.6
// never did it and 3.17.0 dropped it again. That
// left the identity an MFD reads during commissioning differing between hosts purely by
// canboatjs version, and differing only on the version the reference boat runs, which is
// the worst place for a difference to hide.
//
// Reassigning after `new Canbus()` does not work: CanDevice is constructed later and
// asynchronously (behind a setTimeout in one branch, from connect() in the other), so the
// overwrite lands after any fix-up. An accessor with a no-op setter holds regardless of
// when it is attempted, and without throwing under strict mode the way a non-writable
// data property would.
function pinField (obj, key) {
  const value = obj[key]
  Object.defineProperty(obj, key, {
    get: () => value,
    set: () => {},
    enumerable: true,
    configurable: true
  })
  return obj
}

module.exports = { createPgnStream, requireCanboat, canboatUsesFieldsClaim, pickAddressClaim, pinField }
