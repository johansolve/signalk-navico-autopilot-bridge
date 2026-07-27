'use strict'

const EventEmitter = require('events')
const { createPgnStream, requireCanboat } = require('./canboat-compat')

// canboatjs comes from the host server. requireCanboat() (canboat-compat) finds it
// beside the plugin or, failing that, in the server's own tree. Called lazily from
// start() so the module still loads (and the registry can score it) when it is absent.

// Optional commissioning helper: a minimal fake B&G Triton2 Pilot Keypad
// (Device Function 140 = Mode Controller) on its OWN N2K address, separate from
// the emulated AC. Its only job is to open the MFD's "press standby"
// commissioning gate, which the gate accepts as a single 130850 standby
// (key 0x0006) from a control head. The MFD's own pilot-controller can do this
// once an AC is present, but a Navico MFD needs a head on the bus to START the
// very first commissioning, which is what this provides.
//
// Default OFF. Enable it during first commissioning, then disable — it is not
// needed for normal operation (the emulated AC + the MFD's own buttons suffice).
//
// It sends the 65305 Device Status Request heartbeat a real keypad emits and,
// while running, re-sends the standby command at a low rate so the gate opens
// whenever the wizard reaches the "press standby" step. A single standby is
// enough; the low repeat just removes the timing dependency.
class ControlHead {
  constructor (app, opts) {
    this.app = app
    this.debug = (app && typeof app.debug === 'function') ? app.debug.bind(app) : (() => {})
    const o = opts || {}
    this.canInterface = o.canInterface || 'can0'
    this.headAddress = (typeof o.headAddress === 'number') ? o.headAddress : 44
    this.acAddress = (typeof o.acAddress === 'number') ? o.acAddress : 35

    this.addressClaim = {
      pgn: 60928, dst: 255, prio: 6,
      'Unique Number': 30006,
      'Manufacturer Code': 381,        // B&G (Navico family)
      'Device Function': 140,          // Mode Controller (control head)
      'Device Class': 40,              // Steering and Control surfaces
      'Device Instance Lower': 0,
      'Device Instance Upper': 0,
      'System Instance': 0,
      'Industry Group': 4,
      'Reserved1': 1,
      'Reserved2': 2
    }
    this.productInfo = {
      pgn: 126996, dst: 255,
      'NMEA 2000 Version': 1.200,   // 0.001/bit -- see ac-emulator: 1200 wrapped to 20.352
      'Product Code': 151216,
      'Model ID': 'Triton2 Pilot Keypad',
      'Software Version Code': '1.4.13.00',
      'Model Version': '',
      'Model Serial Code': '030006',
      'Certification Level': 1,
      'Load Equivalency': 1
    }

    this.canbus = null
    this.parser = null
    this.timers = []
    this.bootDone = false
  }

  myAddr () { return this.canbus && this.canbus.candevice && this.canbus.candevice.address }

  send (prio, pgn, bytes) {
    if (!this.canbus) { return }
    const len = bytes.split(',').length
    // Guard the native sendPGN throw (bus-off/ENOBUFS) so a timer callback can't
    // take the server down -- same reasoning as the emulator's send().
    try {
      this.canbus.sendPGN(`${new Date().toISOString()},${prio},${pgn},0,255,${len},${bytes}`)
    } catch (e) {
      this.debug('send PGN ' + pgn + ' failed: ' + (e && e.message))
    }
  }

  // 65305 Simnet Device Status Request: 41,9f | Model | Report=03 | spare ff*4
  statusRequest () { this.send(3, 65305, '41,9f,00,03,ff,ff,ff,ff') }

  // 130850 STANDBY to the AC. Byte-exact match to a real head in the reference
  // capture: 12 bytes, group 0x0a, key 0x0006 (LE16), off2 = the AC's address.
  standby () {
    const acHex = this.acAddress.toString(16).padStart(2, '0')
    this.send(2, 130850, `41,9f,${acHex},ff,ff,0a,06,00,ff,ff,ff,ff`)
  }

  start () {
    const Canbus = requireCanboat().canbus
    const bus = new EventEmitter()
    this.canbus = new Canbus({
      canDevice: this.canInterface,
      app: bus,
      addressClaim: this.addressClaim,
      productInfo: this.productInfo,
      preferredAddress: this.headAddress,
      transmitPGNs: [65305, 126993, 130850]
    })
    this.parser = createPgnStream(this.debug)
    // Feed incoming PGNs to candevice so it answers ISO requests / address claims.
    this.canbus.pipe(this.parser)
    this.parser.on('data', (pgn) => { try { bus.emit('N2KAnalyzerOut', pgn) } catch (e) {} })

    bus.on('nmea2000OutAvailable', () => {
      if (this.bootDone || !this.canbus) { return }
      this.bootDone = true
      this.debug(`commissioning head claim done, addr=${this.myAddr()} -- ` +
                 `65305 heartbeat 1Hz + standby to AC addr ${this.acAddress}`)
      this.timers.push(setInterval(() => this.statusRequest(), 1000))
      this.timers.push(setInterval(() => this.standby(), 2000))
      this.standby()
    })
  }

  stop () {
    for (const t of this.timers) { clearInterval(t) }
    this.timers = []
    // Stop the socketcan channel too, not just end() -- otherwise the candevice
    // keeps claiming the head address after stop. API-guarded (no-op if absent).
    try {
      if (this.canbus && this.canbus.channel && typeof this.canbus.channel.stop === 'function') { this.canbus.channel.stop() }
    } catch (e) {}
    try { if (this.canbus) { this.canbus.end() } } catch (e) {}
    this.canbus = null
    this.parser = null
    this.bootDone = false
  }
}

module.exports = ControlHead
