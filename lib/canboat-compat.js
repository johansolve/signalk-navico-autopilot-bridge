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

module.exports = { createPgnStream, requireCanboat }
