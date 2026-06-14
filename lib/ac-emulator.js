'use strict'

const EventEmitter = require('events')
const Canbus = require('@canboat/canboatjs').canbus
const FromPgnStream = require('@canboat/canboatjs/lib/fromPgnStream')
const SkAutopilot = require('./sk-autopilot')

// Identity presets. AC42 values are read from a real device's 126996 in
// canboat/samples/ac42-commissioning.raw (src 13); AC12 follows htool's
// reverse engineering and is the identity a Libelle Vulcan 7 bound to.
const MODELS = {
  AC42: { product: 'AC42 _Autopilot', sw: '1100', version: '130300', code: 13798, serial: '003024#' },
  AC12: { product: 'AC12 Autopilot', sw: '1.3.03.00', version: '', code: 18846, serial: '014817' }
}

// Byte-exact 130845 op=02 replies, extracted from a real AC42 (src 13) in the
// commissioning capture. The dockside wizard reads each key via 130845 op=00;
// an unanswered key renders greyed-out (NA). The reply MUST start 41 9F.
const COMMISSION_RAW = [
  'ff,ff,ff,14,09,00,02,c1,0a,00,00',
  'ff,ff,ff,18,09,00,02,07,00,ff,ff',
  'ff,ff,ff,1c,09,00,02,04,00,ff,ff',
  'ff,ff,ff,1a,0e,00,02,90,01,ff,ff',
  'ff,ff,ff,18,06,00,02,01,ff,ff,ff',
  'ff,ff,ff,22,1a,00,02,88,13,ff,ff',
  'ff,ff,ff,22,0b,00,02,17,13,ff,ff',
  'ff,ff,ff,19,0d,00,02,3e,00,ff,ff',
  'ff,ff,ff,19,0e,00,02,90,01,ff,ff',
  'ff,ff,ff,1b,0c,00,02,a2,0d,ff,ff',
  'ff,ff,ff,18,0c,00,02,34,01,ff,ff',
  'ff,ff,ff,21,19,00,02,aa,c7,0c,00',
  'ff,ff,ff,14,06,00,02,00,00,ff,ff',
  'ff,ff,ff,1a,11,00,02,02,ff,ff,ff',
  'ff,ff,ff,18,0b,00,02,1d,47,ff,ff',
  'ff,ff,ff,14,01,00,02,64,ff,ff,ff',
  'ff,ff,ff,18,02,00,02,00,00,ff,ff',
  'ff,ff,ff,20,0b,00,02,17,13,ff,ff',
  'ff,ff,ff,04,2d,00,02,00,00,ff,ff',
  'ff,ff,ff,1c,11,00,02,01,ff,ff,ff',
  'ff,ff,ff,1a,0d,00,02,37,00,ff,ff',
  'ff,ff,ff,19,0f,00,02,32,00,ff,ff',
  'ff,ff,ff,23,0d,00,02,05,ff,ff,ff',
  'ff,ff,ff,19,10,00,02,ab,1e,33,00',
  'ff,ff,ff,1f,1a,00,02,d0,07,ff,ff',
  'ff,ff,ff,1e,1a,00,02,88,13,ff,ff',
  'ff,ff,ff,1c,01,00,02,68,12,ff,ff',
  'ff,ff,ff,1f,1b,00,02,d0,07,ff,ff',
  'ff,ff,ff,19,11,00,02,01,ff,ff,ff',
  'ff,ff,ff,1a,0f,00,02,32,00,ff,ff',
  'ff,ff,ff,23,0b,00,02,00,00,ff,ff',
  'ff,ff,ff,14,1d,00,02,60,09,ff,ff',
  'ff,ff,ff,1c,08,00,02,78,00,ff,ff',
  'ff,ff,ff,1a,10,00,02,c8,a3,3b,00',
  'ff,ff,ff,18,0a,00,02,00,ff,ff,ff',
  'ff,ff,ff,20,1b,00,02,d0,07,ff,ff',
  'ff,ff,ff,1c,02,00,02,68,12,ff,ff',
  'ff,ff,ff,09,01,00,02,dc,17,ff,ff',
  'ff,ff,ff,09,02,00,02,24,e8,ff,ff',
  // keys the capture's AC never answered but kept as harmless fallbacks
  'ff,ff,ff,3a,00,00,02,00,00,ff,ff',
  'ff,ff,ff,06,00,00,02,00,00,ff,ff',
  'ff,ff,ff,14,00,00,02,00,00,ff,ff',
  'ff,ff,ff,21,09,00,02,aa,c7,ff,ff',
  'ff,ff,ff,22,b0,00,02,17,13,ff,ff',
  'ff,ff,ff,04,0d,00,02,00,00,ff,ff'
]

// INPUT decode. canboatjs 2.10 has an incomplete 130850 definition for this
// Simnet layout: it decodes the GROUP byte (0x0a) as fields.Event ("Nav mode")
// and the real command KEY byte as fields["Unused B"]. Decode on the key,
// gated by group 0x0a. Keys verified live against a Vulcan 7 (2026-06-13).
const KEY_STATE = { 0x06: 'standby', 0x09: 'auto', 0x0f: 'wind', 0x0a: 'route' }
const KEY_NAME = {
  0x06: 'Standby', 0x09: 'Auto', 0x0a: 'Nav/Track', 0x0c: 'NoDrift',
  0x0f: 'Wind', 0x11: 'Tack', 0x1a: 'ChangeCourse', 0x1c: '(key-press envelope)'
}
const KEY_GUESS = new Set([0x0c, 0x11])   // nodrift/tack key 0x11: log only, never fire
const CHANGE_COURSE = 0x1a
// Tack arrives as a ChangeCourse (key 0x1a) at the Vulcan's configured tack
// angle, not a separate key (htool saw 0x3d5b=90deg; the Vulcan UI default is
// 100deg, and it is user-configurable). A single ± button press is only ±1/±10,
// so any single ChangeCourse well above 10deg is a tack, not a course nudge.
const TACK_MIN_DEG = 20

// Per-mode firehose frames derived from htool/RaymarineAPtoFakeNavicoAutoPilot.
// htool found that 65305 "00,1d,.." sets the mode the MFD DISPLAYS and "00,0a,.."
// sets state (standby/engaged); we previously only sent 0a, so the overlay stuck
// on "auto". NOTE: htool had NOT got the wind/route overlay fully working and
// several of these are his guesses — these are TEST CANDIDATES, not proven.
const MODE_65340 = {
  standby: '41,9f,00,00,fe,f8,00,80',
  auto: '41,9f,10,01,fe,fa,00,80',     // heading hold
  wind: '41,9f,10,03,fe,fa,00,80',
  route: '41,9f,10,06,fe,f8,00,80'     // navigation
}
const MODE_65302 = {
  standby: '41,9f,0a,6b,00,00,00,ff',
  auto: '41,9f,0a,69,00,00,28,ff',
  wind: '41,9f,0a,69,00,00,30,ff',
  route: '41,9f,0a,6b,00,00,28,ff'     // htool: "guessing"
}
// 65305 reports per engaged mode; route needs TWO frames (status + mode).
const MODE_65305_ENGAGED = {
  auto: ['41,9f,00,0a,16,00,00,00'],
  wind: ['41,9f,00,0a,06,04,00,00'],
  route: ['41,9f,00,02,02,00,00,00', '41,9f,00,0a,f0,00,80,00']
}
const STANDBY_65305 = ['41,9f,00,02,02,00,00,00', '41,9f,00,0a,0a,00,00,00']
// Mode-change announce frames (htool: 00,1d drives the displayed mode label).
const MODE_CHANGE_65305 = ['41,9f,00,1d,81,00,00,00', '41,9f,00,1d,80,00,00,00']

const TX_PGNS = [65302, 65305, 65340, 65341, 65420, 126993, 127237,
                 127245, 127250, 128275, 130845, 130850, 130851, 130860]

class ACEmulator {
  constructor (app, options) {
    this.app = app
    this.debug = (app && typeof app.debug === 'function') ? app.debug.bind(app) : (() => {})
    const o = options || {}
    this.canInterface = o.canInterface || 'can0'
    this.acModel = (o.acModel || 'AC42').toUpperCase()
    this.preferredAddress = (typeof o.preferredAddress === 'number') ? o.preferredAddress : 35
    this.enableFirehose = o.enableFirehose !== false
    this.enableStdPgns = !!o.enableStdPgns
    this.bridge = o.bridge || 'dry-run'     // off | dry-run | live

    this.sk = new SkAutopilot({
      host: o.skHost || '127.0.0.1',
      port: o.skPort || 3000,
      autopilotId: o.autopilotId || '_default',
      token: o.token || null
    })

    const model = MODELS[this.acModel] || MODELS.AC42
    this.addressClaim = {
      pgn: 60928, dst: 255, prio: 6,
      'Unique Number': 1751521,
      'Manufacturer Code': 1857,        // Simrad (Navico)
      'Device Function': 150,           // Autopilot
      'Device Class': 40,               // Steering and Control surfaces
      'Device Instance Lower': 0,
      'Device Instance Upper': 0,
      'System Instance': 0,
      'Industry Group': 4,
      'Reserved1': 1,
      'Reserved2': 2
    }
    this.productInfo = {
      pgn: 126996, dst: 255,
      'NMEA 2000 Version': 1200,
      'Product Code': model.code,
      'Model ID': model.product,
      'Software Version Code': model.sw,
      'Model Version': model.version,
      'Model Serial Code': model.serial,
      'Certification Level': 1,
      'Load Equivalency': 1
    }

    this.commission = {}
    for (const v of COMMISSION_RAW) {
      const b = v.split(',')
      const lo = parseInt(b[3], 16); const hi = parseInt(b[4], 16)
      if (!isNaN(lo) && !isNaN(hi)) { this.commission[(hi << 8) | lo] = v }
    }

    this.timers = []
    this.canbus = null
    this.parser = null
    this.bootDone = false
    this.fpBuf = {}             // fast-packet reassembly: src*8+seq -> {total,bytes}
    this.angleField = 0
    this.lastBroadcastMode = null   // for the 65305 mode-change announce
    // Mode shown by the firehose. Driven OPTIMISTICALLY by the button press the
    // MFD sends (so it updates instantly and works without a token), then
    // corrected by the SK state poll when that is readable (the pilot is
    // authoritative if it drops a mode on its own).
    this.commandedMode = 'standby'
    this.commandedAt = 0            // when commandedMode was last set from a button
    this.pollWarned = false

    this.state = {
      address: undefined,
      skApState: null,          // standby | auto | wind | route
      lastSkStateMs: null,
      lastApRaw: null,
      apRawRing: [],
      lastMappedEvent: null,
      lastV2Call: null,
      lastV2Result: null,
      ap130850Count: 0,
      commissionReads: 0,
      missingKeys: [],
      txCounts: {}
    }
  }

  // ---- lifecycle ----
  start () {
    const bus = new EventEmitter()
    this.canbus = new Canbus({
      canDevice: this.canInterface,
      app: bus,
      addressClaim: this.addressClaim,
      productInfo: this.productInfo,
      preferredAddress: this.preferredAddress,
      transmitPGNs: TX_PGNS
    })
    this.parser = new FromPgnStream()

    // Raw-frame tap with fast-packet reassembly. Canbus pushes ONE CAN frame at
    // a time as {pgn:<parsedCanId>, length, data:<8B>} -- not a number pgn and
    // not the reassembled payload. 130850 is multi-frame, so reassemble here
    // (data[0]=(seq<<5)|frame; frame 0 holds total length in data[1] + 6 bytes;
    // later frames 7 bytes). MUST be registered BEFORE pipe so it sets lastApRaw
    // before the pipe drives parser -> handleIncomingAP for the same PGN.
    this.canbus.on('data', (msg) => this.onRawFrame(msg))
    this.canbus.pipe(this.parser)
    this.parser.on('data', (pgn) => {
      // Feed the candevice so it answers ISO requests (60928 address claim,
      // 126996 product info). canboatjs' CanDevice listens on app's
      // 'N2KAnalyzerOut'; without this it only does the initial claim and is
      // deaf to requests, so the MFD never sees an autopilot computer.
      try { bus.emit('N2KAnalyzerOut', pgn) } catch (e) {}
      this.onParsedPgn(pgn)
    })

    bus.on('nmea2000OutAvailable', () => {
      // A late claim on a bus from a previous (stopped) instance must not arm
      // timers: stop() nulls this.canbus, so bail if we are no longer running.
      if (this.bootDone || !this.canbus) { return }
      this.bootDone = true
      this.state.address = this.myAddr()
      this.debug(`address claim done, addr=${this.myAddr()} model=${this.acModel} ` +
                 `bridge=${this.bridge} firehose=${this.enableFirehose} std=${this.enableStdPgns}`)
      this.timers.push(setInterval(() => this.firehose1Hz(), 1000))
      this.timers.push(setInterval(() => this.firehose2Hz(), 500))
      this.timers.push(setInterval(() => this.std1Hz(), 1000))
      this.timers.push(setInterval(() => this.std4Hz(), 250))
      this.timers.push(setInterval(() => this.pollState(), 2000))
      this.timers.push(setInterval(() => this.updateStatus(), 1000))
      this.pollState()
      this.updateStatus()
    })
  }

  stop () {
    for (const t of this.timers) { clearInterval(t) }
    this.timers = []
    try { if (this.canbus) { this.canbus.end() } } catch (e) {}
    this.canbus = null
    this.parser = null
    this.bootDone = false
  }

  setBridge (mode) {
    if (mode === 'off' || mode === 'dry-run' || mode === 'live') { this.bridge = mode }
  }

  setToken (token) {
    this.sk.token = token || null
  }

  // ---- helpers ----
  myAddr () { return this.canbus && this.canbus.candevice && this.canbus.candevice.address }

  send (prio, pgn, bytes) {
    if (!this.canbus) { return }   // a late timer/listener after stop() must not touch a closed bus
    const len = bytes.split(',').length
    this.canbus.sendPGN(`${new Date().toISOString()},${prio},${pgn},0,255,${len},${bytes}`)
    this.state.txCounts[pgn] = (this.state.txCounts[pgn] || 0) + 1
  }

  selfPathNum (path) {
    try {
      const v = this.app.getSelfPath(path)
      return (typeof v === 'number') ? v : null
    } catch (e) { return null }
  }

  headingRad () { return this.selfPathNum('navigation.headingMagnetic.value') }
  rudderRad () { return this.selfPathNum('steering.rudderAngle.value') }

  skFresh () { return this.state.lastSkStateMs !== null && (Date.now() - this.state.lastSkStateMs) < 10000 }
  engaged () { return this.skFresh() && this.state.skApState && this.state.skApState !== 'standby' }

  pollState () {
    this.sk.getState((err, st) => {
      if (!err && st) {
        this.state.skApState = st
        this.state.lastSkStateMs = Date.now()
        this.pollWarned = false
        // Correct the firehose to the pilot's actual state ONLY in live mode
        // (in dry-run we don't drive the pilot, so its state is unrelated to the
        // buttons), and only after a grace period so the pilot has time to adopt
        // a just-commanded mode before we second-guess the optimistic display.
        if (this.bridge === 'live' && (Date.now() - this.commandedAt > 5000) && st !== this.commandedMode) {
          this.debug(`SK state ${st} != commanded ${this.commandedMode} -- correcting firehose`)
          this.commandedMode = st
        }
      } else if (err) {
        // 401 without a token, etc. The firehose still follows button presses,
        // so this is non-fatal -- log once, not every 2 s.
        if (!this.pollWarned) {
          this.debug('AP state poll failed (' + (err.message || err) + ') -- firehose follows button presses only')
          this.pollWarned = true
        }
      }
    })
  }

  // unsigned 16-bit LE, radians at 0.0001 rad/bit
  rad16 (v) {
    let n = Math.round((((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / 0.0001)
    if (n < 0) { n = 0 }
    if (n > 0xfffe) { n = 0xfffe }
    return `${(n & 0xff).toString(16).padStart(2, '0')},${((n >> 8) & 0xff).toString(16).padStart(2, '0')}`
  }

  // signed 16-bit LE, radians at 0.0001 rad/bit (rudder can be negative)
  srad16 (v) {
    let n = Math.round(v / 0.0001)
    if (n < -32767) { n = -32767 }
    if (n > 32767) { n = 32767 }
    if (n < 0) { n += 0x10000 }
    return `${(n & 0xff).toString(16).padStart(2, '0')},${((n >> 8) & 0xff).toString(16).padStart(2, '0')}`
  }

  // ---- firehose: Simnet AP-proprietary state/telemetry ----
  // The firehose mode is the optimistic commanded mode (button-driven), so it
  // updates instantly and does not depend on a readable SK state / token.
  currentMode () {
    return this.commandedMode || 'standby'
  }

  // 65305 reports, with the htool mode-change announce when the mode flips.
  send65305 () {
    const mode = this.currentMode()
    if (mode !== this.lastBroadcastMode) {
      for (const f of MODE_CHANGE_65305) { this.send(7, 65305, f) }
      this.lastBroadcastMode = mode
      this.debug('firehose mode change -> ' + mode)
    }
    const frames = (mode === 'standby') ? STANDBY_65305 : (MODE_65305_ENGAGED[mode] || STANDBY_65305)
    for (const f of frames) { this.send(7, 65305, f) }
  }

  send65341 () {
    const h = this.headingRad()
    if (this.commandedMode !== 'standby' && h !== null) {
      this.send(7, 65341, `41,9f,ff,ff,02,ff,${this.rad16(h)}`)
    } else {
      const ANGLE_STATIC = ['41,9f,ff,ff,0d,ff,ff,7f', '41,9f,ff,ff,0c,ff,ff,ff',
                            '41,9f,ff,ff,0b,ff,00,00', '41,9f,ff,ff,03,ff,ff,ff']
      this.send(7, 65341, ANGLE_STATIC[this.angleField % ANGLE_STATIC.length])
      this.angleField++
    }
  }

  firehose1Hz () {
    if (!this.enableFirehose || !this.bootDone) { return }
    const mode = this.currentMode()
    this.send(3, 65340, MODE_65340[mode] || MODE_65340.standby)
    this.send(7, 65302, MODE_65302[mode] || MODE_65302.standby)
    this.send(6, 65420, '41,9f,ff,ff,ff,ff,f1,ff')
    this.send(7, 130860, '41,9f,ff,ff,ff,ff,7f,ff,ff,ff,7f,ff,ff,ff,ff,ff,ff,ff,7f,ff,ff,ff,7f')
    this.send(6, 128275, 'ff,ff,ff,ff,ff,ff,ff,ff,ff,ff,ff,ff,ff,ff')
  }

  firehose2Hz () {
    if (!this.enableFirehose || !this.bootDone) { return }
    this.send65305()
    this.send65341()
  }

  // ---- std nav PGNs (DUPLICATE other sources -- A/B only) ----
  std1Hz () {
    if (!this.enableStdPgns || !this.bootDone) { return }
    this.send(2, 127237, 'ff,3f,ff,ff,7f,ff,ff,00,00,ff,ff,ff,ff,ff,7f,ff,7f,ff,7f,ff,ff')
    const h = this.headingRad()
    if (h !== null) { this.send(2, 127250, `ff,${this.rad16(h)},ff,ff,ff,ff,fd`) }
  }

  std4Hz () {
    if (!this.enableStdPgns || !this.bootDone) { return }
    const r = this.rudderRad()
    const pos = (r !== null) ? this.srad16(r) : 'ff,7f'
    this.send(2, 127245, `ff,ff,ff,7f,${pos},ff,ff`)
  }

  // ---- commissioning readback ----
  reply130845 (pgn) {
    const f = pgn.fields || {}
    if (this.myAddr() === undefined || f.Address !== this.myAddr()) { return }
    const key = f.Key
    const val = this.commission[key]
    this.state.commissionReads++
    if (val === undefined) {
      if (!this.state.missingKeys.includes(key)) { this.state.missingKeys.push(key) }
      this.debug(`130845 MISSING key ${key} from src ${pgn.src}`)
      return
    }
    // Reply payload must start 41 9F (Simrad header check 0x9F41).
    const addrHex = this.myAddr().toString(16).padStart(2, '0')
    const data = `41,9f,${addrHex},${val}`
    const len = data.split(',').length
    this.canbus.sendPGN(`${new Date().toISOString()},3,130845,0,255,${len},${data}`)
  }

  // ---- INPUT bridge ----
  isApGroup (f) { return f.Event === 'Nav mode' || f.Event === 10 }

  applyV2 (desc, fn) {
    if (this.bridge === 'dry-run') {
      this.state.lastV2Call = 'DRY: ' + desc
      this.state.lastV2Result = 'dry-run (not sent)'
      this.debug(`BRIDGE dry-run WOULD ${desc}`)
      return
    }
    this.state.lastV2Call = desc
    if (!this.sk.token) {
      this.state.lastV2Result = 'NO TOKEN (set token in config)'
      this.debug(`BRIDGE live but NO TOKEN - ${desc}`)
      return
    }
    this.debug(`BRIDGE live -> ${desc}`)
    fn((err, code, bdy) => {
      const body = bdy || ''
      let res
      if (err) {
        res = 'ERR ' + err.message
      } else if (code === 400 && body.includes('Did not receive change confirmation')) {
        // dockside verifyChange timeout: command IS applied but no confirmation
        // delta seen. Narrow to this exact string -- any other 4xx/5xx is real.
        res = '400 verifyChange-timeout (command likely APPLIED) ' + body.slice(0, 60)
      } else {
        res = code + ' ' + body.slice(0, 80)
      }
      this.state.lastV2Result = res
      this.debug(`BRIDGE result ${res}`)
    })
  }

  handleIncomingAP (pgn) {
    const f = pgn.fields || {}
    this.state.ap130850Count++
    this.debug(`RX 130850 src ${pgn.src} dst ${pgn.dst} ${JSON.stringify(f)} ` +
               `raw ${this.state.lastApRaw ? this.state.lastApRaw.hex : '(none)'}`)
    if (this.bridge === 'off') { return }
    if (!this.isApGroup(f)) { this.state.lastMappedEvent = 'non-AP-group (ignored)'; return }
    const key = (typeof f['Unused B'] === 'number') ? f['Unused B'] : undefined
    if (key === undefined) { this.state.lastMappedEvent = 'group 0x0a, no key'; return }
    this.state.lastMappedEvent = (KEY_NAME[key] || ('key 0x' + key.toString(16))) + ' (' + key + ')'
    if (KEY_GUESS.has(key)) {
      // nodrift/tack are guessed -- log so a capture confirms the key, never fire.
      this.debug(`GUESSED key ${key} (${KEY_NAME[key]}) -- logged, NOT fired`)
      return
    }
    if (key in KEY_STATE) {
      const st = KEY_STATE[key]
      this.commandedMode = st   // optimistic: drive the firehose display immediately
      this.commandedAt = Date.now()
      this.applyV2(`PUT /state {value:"${st}"}`, (cb) => this.sk.setState(st, cb))
    } else if (key === CHANGE_COURSE) {
      // Decode the REAL delta from the raw frame (canboat's f.Angle is off-by-one).
      // byte8 = direction (0x03 stbd/+, 0x02 port/-), bytes9-10 = magnitude LE16
      // at 0.0001 rad/bit. Simrad encodes 10deg as 1745 (=9.997deg); the SK V2
      // adjustTarget floors radiansToDegrees and putAdjustHeading accepts only
      // +-10/+-1, so 9.997 floors to 9 and is rejected. Round to whole-degree N,
      // then send (N+0.5)deg in rad so the plugin's floor lands exactly on N.
      const raw = this.state.lastApRaw
      const by = raw ? raw.hex.split(',').map((h) => parseInt(h, 16)) : []
      if (by.length >= 11 && (by[8] === 0x03 || by[8] === 0x02)) {
        const sign = by[8] === 0x03 ? 1 : -1
        const mag = by[9] | (by[10] << 8)
        const degMag = mag * 0.0001 * 180 / Math.PI
        if (!this.engaged()) {
          // Only act when SK state is FRESH and engaged (engaged() requires
          // skFresh() and a non-standby mode). A stale poll or a standby pilot
          // must never be tacked or nudged.
          this.state.lastMappedEvent = `ChangeCourse ${Math.round(degMag)}deg while not engaged (ignored)`
          this.debug(`ChangeCourse ${Math.round(degMag)}deg but not engaged (state=${this.state.skApState} fresh=${this.skFresh()}) -- ignored`)
        } else if (degMag >= TACK_MIN_DEG) {
          // htool: tack is a ChangeCourse of ~90deg (0x3d5b). The magnitude is
          // DISCARDED on purpose: in wind mode a tack must mirror the apparent
          // wind angle to the other tack (so the real course change depends on
          // AWA, not a fixed 90deg). We only detect "this is a tack" and delegate
          // to the pilot's own tack endpoint, which does the AWA mirroring; we
          // must NOT apply the magnitude as a target adjustment.
          // A tack/gybe only has meaning in WIND mode: a tack crosses the wind
          // (bow through the wind), a gybe crosses dead downwind (stern through
          // the wind). Outside wind mode there is no wind line to cross, so a big
          // ChangeCourse is not a tack -- don't fire.
          if (this.state.skApState === 'wind') {
            // Derive the tack direction from SK's apparent wind angle, not the
            // (unverified, htool-inverted) Vulcan dir byte. SK AWA is positive to
            // starboard, and a tack turns toward the side the wind is on: AWA > 0
            // (on starboard tack) -> tack to starboard; AWA < 0 -> tack to port.
            // The resulting COG change is ~2*AWA. NOTE: the tack/<dir> turn
            // convention and gybe (through dead downwind) still need on-board
            // verification. Falls back to the dir byte if no wind data.
            const awa = this.selfPathNum('environment.wind.angleApparent.value')
            const dir = (awa !== null && awa !== 0)
              ? (awa > 0 ? 'starboard' : 'port')
              : (sign > 0 ? 'starboard' : 'port')
            const awaDeg = (awa !== null) ? Math.round(awa * 180 / Math.PI) : null
            this.applyV2(`POST /tack/${dir} (AWA ${awaDeg === null ? '?' : awaDeg}deg, ~${awaDeg === null ? '?' : Math.abs(awaDeg * 2)}deg COG)`,
                         (cb) => this.sk.tack(dir, cb))
          } else {
            this.state.lastMappedEvent = `large ChangeCourse ${Math.round(degMag)}deg outside wind mode (ignored)`
            this.debug(`large ChangeCourse ${Math.round(degMag)}deg but state=${this.state.skApState} -- not a tack, ignored`)
          }
        } else {
          const degN = sign * Math.round(degMag)
          const delta = (degN + 0.5) * Math.PI / 180
          this.applyV2(`PUT /target/adjust {value:${delta.toFixed(4)}} (-> ${degN}deg)`,
                       (cb) => this.sk.adjustTarget(delta, cb))
        }
      } else {
        this.state.lastMappedEvent = 'ChangeCourse: unrecognized bytes ' + (raw ? raw.hex : '(none)')
        this.debug(`CHANGECOURSE unrecognized ${raw ? raw.hex : '(none)'}`)
      }
    }
  }

  // ---- stream handlers ----
  onRawFrame (msg) {
    // Runs inside the canbus 'data' emit; an unhandled throw here would surface
    // as an uncaught exception and take down the SignalK server, so guard it.
    try {
      if (!msg || !msg.pgn || msg.pgn.pgn !== 130850 || !msg.data) { return }
      const src = msg.pgn.src
      const b = Buffer.isBuffer(msg.data) ? msg.data : Buffer.from(msg.data)
      if (b.length < 1) { return }
      const seq = b[0] >> 5; const frame = b[0] & 0x1f
      const fk = src * 8 + seq
      if (frame === 0) {
        this.fpBuf[fk] = { total: b[1], bytes: Array.from(b.slice(2)) }
      } else if (this.fpBuf[fk]) {
        this.fpBuf[fk].bytes.push(...Array.from(b.slice(1)))
      } else {
        return   // missed frame 0
      }
      const e = this.fpBuf[fk]
      if (e.bytes.length < e.total) { return }
      const p = e.bytes.slice(0, e.total)
      delete this.fpBuf[fk]
      const rec = {
        ts: new Date().toISOString(),
        src,
        group: p.length > 5 ? p[5] : null,
        key: p.length > 6 ? p[6] : null,
        val16: (p.length > 9) ? (p[8] | (p[9] << 8)) : null,
        hex: p.map((x) => x.toString(16).padStart(2, '0')).join(',')
      }
      this.state.lastApRaw = rec
      this.state.apRawRing.push(rec)
      if (this.state.apRawRing.length > 16) { this.state.apRawRing.shift() }
    } catch (e) {
      this.debug('onRawFrame error: ' + (e && e.message))
    }
  }

  onParsedPgn (pgn) {
    if (!pgn) { return }
    try {
      if (pgn.pgn === 130845 && pgn.fields && pgn.fields.Address === this.myAddr()) { this.reply130845(pgn); return }
      if (pgn.pgn === 130850 && pgn.src !== this.myAddr()) { this.handleIncomingAP(pgn) }
    } catch (e) { this.debug('handler error: ' + (e && e.message)) }
  }

  // ---- status surfaced to the plugin ----
  statusSummary () {
    const s = this.state
    const addr = s.address === undefined ? '?' : s.address
    return `${this.acModel} @addr ${addr} | bridge ${this.bridge} | ` +
           `mode ${this.commandedMode} | ` +
           `SK ${this.skFresh() ? (s.skApState || '?') : 'stale'} | ` +
           `cmds ${s.ap130850Count} | last ${s.lastMappedEvent || '-'}`
  }

  updateStatus () {
    if (this.app && typeof this.app.setPluginStatus === 'function') {
      this.app.setPluginStatus(this.statusSummary())
    }
  }
}

module.exports = ACEmulator
