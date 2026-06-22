'use strict'

const test = require('node:test')
const assert = require('node:assert')

// Mock just enough of the SignalK ServerAPI for load + activate.
function mockApp () {
  return {
    getDataDirPath: () => '/tmp',
    debug () {},
    error () {},
    setPluginStatus () {},
    setPluginError () {}
  }
}

test('module exports a constructor returning a valid plugin', () => {
  const ctor = require('..')
  assert.strictEqual(typeof ctor, 'function')
  const plugin = ctor(mockApp())
  assert.strictEqual(typeof plugin.id, 'string')
  assert.strictEqual(typeof plugin.name, 'string')
  assert.strictEqual(typeof plugin.start, 'function')
  assert.strictEqual(typeof plugin.stop, 'function')
  assert.strictEqual(typeof plugin.schema, 'object')
})

test('start() with schema defaults does not throw', () => {
  const plugin = require('..')(mockApp())
  const defaults = Object.fromEntries(
    Object.entries(plugin.schema.properties || {}).map(([k, v]) => [k, v.default])
  )
  // canboatjs/can0 are absent here; start() must catch internally and not throw.
  assert.doesNotThrow(() => plugin.start(defaults))
  assert.doesNotThrow(() => plugin.stop())
})
