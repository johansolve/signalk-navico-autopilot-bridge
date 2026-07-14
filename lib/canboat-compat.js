'use strict'

const { Transform } = require('stream')

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
  const { FromPgn } = require('@canboat/canboatjs')
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

module.exports = { createPgnStream }
