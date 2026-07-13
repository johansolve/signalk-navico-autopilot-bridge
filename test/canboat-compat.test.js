'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { createPgnStream } = require('../lib/canboat-compat')

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
