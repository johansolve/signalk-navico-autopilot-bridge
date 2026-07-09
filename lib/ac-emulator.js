'use strict'

const EventEmitter = require('events')
const SkAutopilot = require('./sk-autopilot')

// canboatjs is a peerDependency provided by the host server. Require it lazily
// in start() so the module still loads (and the registry can score it) when the
// peer is absent.

// How long a bus device may stay silent before the status page calls it offline.
// Measured on Libelle's bus, every device we identify (once its addresses are
// pooled, see bestMfdLabel) has a worst-case inter-frame gap of ~1.5 s.
const DEVICE_STALE_MS = 5000

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
  0x0f: 'Wind', 0x11: 'Tack', 0x1a: 'ChangeCourse', 0x1c: '(key-press envelope)',
  // Recognized-but-unhandled, seen in Kees' NAC-3 nav-mode capture 2026-06-30.
  // Named only so the log reads cleanly; neither is in KEY_STATE so neither fires.
  // 0x10: a single occurrence from a second head during a failed nav-from-wind
  //   attempt, drove no AP state change -- unknown, do not act on it.
  // 0x2b: a bus-wide announce emitted right after each mode change (broadcast,
  //   b2=0xff b4=0x64), not a command directed at the AC.
  0x10: '(unknown one-off key)', 0x2b: '(bus mode-change announce)'
}
const KEY_GUESS = new Set([0x0c])         // nodrift key 0x0c: log only, never fire
const CHANGE_COURSE = 0x1a
// The Vulcan's Tack/Gybe button sends key 0x11 with NO direction or magnitude.
// Both dockside captures 2026-07-02 show it as: 41 9F <ac> FF FF 0A 11 00 00.
// The MFD picks the button LABEL (Tack when the wind is forward, Gybe when aft)
// but sends the same key either way -- the pilot derives tack-vs-gybe and the
// turn side from the wind. So we fire it in wind mode and let the EV-200 mirror
// the apparent wind angle to the other side (a tack upwind, a gybe downwind).
const TACK_KEY = 0x11

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
  // selector-0x0a status word (LE) is a per-mode bitfield, ground truth from Kees
  // NAC-3 captures: standby 0x0008 / auto 0x0010 / wind 0x0400 / route 0x0040.
  // Was 0x0406 (wind) from htool's guess -- the spare bits 1-2 weren't in the ground
  // truth, so drop them to match the real AP.
  wind: ['41,9f,00,0a,00,04,00,00'],
  // route corrected from Kees NAC-3 nav-mode capture 2026-06-30: selector-0x02 value
  // 0x0110 and selector-0x0a status word 0x0040 (htool guessed 0x02 / 0x00f0,80).
  route: ['41,9f,00,02,10,01,00,00', '41,9f,00,0a,40,00,00,00']
}
// Nav-confirm PENDING: the transient state between the first Nav press and the
// confirm (second Nav press). Ground truth from Kees' NAC-3 nav-mode capture
// 2026-06-30: the AP reports selector-0x0a status word 0x0090 (auto 0x0010 + the
// pending/confirm bit 0x0080) and 65341 selector 0x0d carrying the course-to-steer,
// until a second Nav latches it to route (0x0040 / selector 0x0a). The MFD's own
// "engage nav?" confirm dialog is driven by that 0x0080 pending bit -- the bridge
// used to show it only because htool's guessed route status word (0x00f0) had the
// bit permanently set; the correct fix is to emit it transiently (see send65305,
// which derives the word from the current engaged mode | 0x0080).
const NAV_PENDING_MS = 20000               // anti-stuck fallback only; normally cleared by the MFD confirm (2nd Nav) or the pilot reaching Track-engaged (0x0181)
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
    // Our own emulated commissioning control head (control-head.js) also puts 130850 +
    // product info on the bus; exclude its address from device resolution so it is never
    // mistaken for the real MFD or control head.
    this.commissioningHead = !!o.enableCommissioningHead
    this.headAddress = (typeof o.headAddress === 'number') ? o.headAddress : 44

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
    this.windDatumRad = null     // EV-200 PGN 65345 locked wind angle (rad, 0..2pi)
    this.windDatumAt = 0         // when windDatumRad was last refreshed
    this.lastBroadcastMode = null   // for the 65305 mode-change announce
    // Mode shown by the firehose. Driven OPTIMISTICALLY by the button press the
    // MFD sends (so it updates instantly and works without a token), then
    // corrected by the SK state poll when that is readable (the pilot is
    // authoritative if it drops a mode on its own).
    this.commandedMode = 'standby'
    this.commandedAt = 0            // when commandedMode was last set from a button
    this.navPending = false         // armed by the first Nav press, cleared on confirm/timeout
    this.navPendingAt = 0           // when navPending was armed (for the timeout)
    this.evPilotMode = null         // EV-200's own PGN 65379 mode word (0x0000 standby /
    this.evPilotAt = 0              //   0x0180 Track-pending / 0x0181 Track-engaged), sniffed
    this.noProvider = false         // set from the empty V2 autopilots list: no pilot to steer
    this.providerId = null          // the default V2 autopilot instance id (e.g. raymarineN2K)
    this.pollWarned = false
    this.mfdSrc = null              // N2K source addr of the MFD sending our 130850 commands
    this.pilotSrc = null            // N2K source addr of the pilot broadcasting 65379
    this.mfdName = null             // resolved MFD product name (from the server's source registry)
    this.pilotName = null           // resolved pilot product name
    this.pilotMfr = null            // pilot manufacturer (scopes the control-head / actuator lookup)
    this.controlHeadName = null     // resolved control-head product name (e.g. Raymarine p70s)
    this.acuName = null             // resolved actuator control unit / course-computer box (e.g. Raymarine ACU200);
                                    // the physical drive unit (ram/motor) is analog, not on the N2K bus
    this.seen = Object.create(null) // N2K src -> ms of the last frame seen from it (liveness)
    this.mfdSrcs = []               // EVERY address the plotter claims: its command address only
                                    // speaks when a button is pressed, so liveness needs the pool
    this.acuSrc = null              // addr behind acuName (for liveness)
    this.headSrc = null             // addr behind controlHeadName (for liveness)

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
    const Canbus = require('@canboat/canboatjs').canbus
    const FromPgnStream = require('@canboat/canboatjs/lib/fromPgnStream')
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
      this.timers.push(setInterval(() => this.firehose5Hz(), 200))
      this.timers.push(setInterval(() => this.std1Hz(), 1000))
      this.timers.push(setInterval(() => this.std4Hz(), 250))
      this.timers.push(setInterval(() => this.pollState(), 2000))
      this.timers.push(setInterval(() => this.updateStatus(), 1000))
      this.timers.push(setInterval(() => this.refreshDevices(), 15000))
      this.pollState()
      this.refreshDevices()
      this.updateStatus()
    })
  }

  stop () {
    for (const t of this.timers) { clearInterval(t) }
    this.timers = []
    // end() only kills an eventual writer subprocess; the socketcan channel and
    // candevice keep listening and re-claiming our address, so a plugin restart
    // (a config change is enough) leaves a zombie AC on the bus fighting the new
    // instance for the same address. Stop the channel too. API-guarded -- verify
    // against the on-board canboatjs; a no-op if the method is absent.
    try {
      if (this.canbus && this.canbus.channel && typeof this.canbus.channel.stop === 'function') { this.canbus.channel.stop() }
    } catch (e) {}
    try { if (this.canbus) { this.canbus.end() } } catch (e) {}
    this.canbus = null
    this.parser = null
    this.bootDone = false
  }

  setToken (token) {
    this.sk.setToken(token)
  }

  // ---- helpers ----
  myAddr () { return this.canbus && this.canbus.candevice && this.canbus.candevice.address }

  send (prio, pgn, bytes) {
    if (!this.canbus) { return }   // a late timer/listener after stop() must not touch a closed bus
    const len = bytes.split(',').length
    // canboatjs' sendPGN -> native channel.send() throws synchronously on
    // ENOBUFS/ENETDOWN/bus-off. We call this ~10x/s from setInterval timers, so an
    // unguarded throw (a glitching N2K cable at sea) would surface as an uncaught
    // exception and take the whole SignalK server down. Swallow and log instead.
    try {
      this.canbus.sendPGN(`${new Date().toISOString()},${prio},${pgn},0,255,${len},${bytes}`)
      this.state.txCounts[pgn] = (this.state.txCounts[pgn] || 0) + 1
    } catch (e) {
      this.debug('send PGN ' + pgn + ' failed: ' + (e && e.message))
    }
  }

  selfPathNum (path) {
    try {
      const v = this.app.getSelfPath(path)
      // Number.isFinite rejects NaN/Infinity too: typeof NaN === 'number' would
      // pass a bare typeof check, and rad16(NaN) sends 0 rad -- a misleading 0deg
      // heading/wind angle on the MFD instead of NA.
      return Number.isFinite(v) ? v : null
    } catch (e) { return null }
  }

  headingRad () { return this.selfPathNum('navigation.headingMagnetic.value') }
  rudderRad () { return this.selfPathNum('steering.rudderAngle.value') }

  // Commanded wind angle for the wind-mode 65341 field-0x03 frame. Prefer the EV-200's
  // own locked wind datum (PGN 65345) -- the true setpoint the pilot holds, and already
  // in the AP's 0..2pi convention so rad16() passes it through unchanged. It is only
  // broadcast while holding a wind angle, so fall back through the V2 target to live
  // apparent wind when it goes stale (>5 s).
  windTargetRad () {
    if (this.windDatumRad !== null && (Date.now() - this.windDatumAt) < 5000) {
      return this.windDatumRad
    }
    const t = this.selfPathNum('steering.autopilot.target.windAngleApparent.value')
    if (t !== null) { return t }
    return this.selfPathNum('environment.wind.angleApparent.value')
  }

  // Signed apparent wind angle (rad, +starboard) for the tack/gybe turn-side
  // decision. Prefer the EV-200's fresh locked wind datum (65345) -- the setpoint
  // the pilot actually holds -- over the momentary live AWA, which jitters across
  // the +-90deg tack/gybe boundary in a seaway and could flip the derived turn
  // side vs what the MFD's button label promised. windDatumRad is unsigned 0..2pi;
  // fold it to signed. Fall back to live AWA when no fresh datum.
  windAngleSigned () {
    if (this.windDatumRad !== null && (Date.now() - this.windDatumAt) < 5000) {
      const wd = ((this.windDatumRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      return wd > Math.PI ? wd - 2 * Math.PI : wd
    }
    return this.selfPathNum('environment.wind.angleApparent.value')
  }

  skFresh () { return this.state.lastSkStateMs !== null && (Date.now() - this.state.lastSkStateMs) < 10000 }
  engaged () { return this.skFresh() && this.state.skApState && this.state.skApState !== 'standby' }

  pollState () {
    // Provider presence: the V2 autopilots list is {} when no provider is registered.
    // (A disabled/absent provider makes /autopilots/<id> return 500, not 404, so we can't
    // key off getState's failure -- the list is the reliable signal.)
    this.sk.getAutopilots((err, list) => {
      if (!err && list && typeof list === 'object') {
        const keys = Object.keys(list)
        this.noProvider = keys.length === 0
        // The V2 API is provider-agnostic -- any plugin can register. Show which one is
        // actually steering: the default instance id (else the first), e.g. raymarineN2K.
        let sel = null
        for (const k of keys) { if (list[k] && list[k].isDefault) { sel = k; break } }
        this.providerId = sel || (keys.length ? keys[0] : null)
      }
    })
    this.sk.getState((err, st) => {
      if (!err && st) {
        this.state.skApState = st
        this.state.lastSkStateMs = Date.now()
        this.pollWarned = false
        this.noProvider = false     // a state came back -> an autopilot V2 provider is present
        // NB: do NOT latch the nav-confirm dialog on SK state == 'route'. The V2 API reports
        // 'route' optimistically the instant we PUT it -- and maps both Track-pending (0x0180)
        // and Track-engaged (0x0181) to 'route' -- so latching on it makes the MFD dialog
        // vanish ~2 s after the first Nav press (capture 2026-07-04) while the pilot is still
        // only pending. reconcileNavPending() latches instead on the EV-200's real 65379
        // Track-engaged (0x0181), which is the ground truth SK cannot give us.
        // Correct the firehose to the pilot's actual state ONLY in live mode
        // (in dry-run we don't drive the pilot, so its state is unrelated to the
        // buttons), and only after a grace period so the pilot has time to adopt
        // a just-commanded mode before we second-guess the optimistic display.
        // Skip the correction while a nav-confirm is pending: SK maps the EV-200's
        // Track-pending (0x0180) to 'route', so correcting here would set commandedMode
        // 'route' mid-pending -- flipping the pending status word and, if the sniffer is
        // stale and the timeout fires, reviving the old dead-end (next Nav read as
        // "already engaged"). reconcileNavPending owns the transition out of pending.
        if (this.bridge === 'live' && !this.navPending &&
            (Date.now() - this.commandedAt > 5000) && st !== this.commandedMode) {
          this.debug(`SK state ${st} != commanded ${this.commandedMode} -- correcting firehose`)
          this.commandedMode = st
        }
      } else if (err) {
        // 401 without a token, a 500 when the provider is gone, etc. The firehose still
        // follows button presses, so this is non-fatal -- log once, not every 2 s. Provider
        // presence is tracked separately from the autopilots list (above), not from here.
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
    // In the nav-confirm window the AP holds the pending status word (0x0090) so the
    // MFD raises its "engage nav?" dialog; treat pending as its own broadcast mode so
    // the mode-change announce fires on entering and leaving it.
    const bcast = this.navPending ? 'route-pending' : this.currentMode()
    if (bcast !== this.lastBroadcastMode) {
      for (const f of MODE_CHANGE_65305) { this.send(7, 65305, f) }
      this.lastBroadcastMode = bcast
      this.debug('firehose mode change -> ' + bcast)
    }
    if (this.navPending) {
      // Pending status word = the current engaged mode's bits | the pending bit 0x0080
      // (NAC-3 ground truth: pending-from-auto 0x0090, pending-from-wind 0x0480). From
      // standby the MFD engages auto first, so the auto base (0x0010) is the right default.
      const w = ((this.commandedMode === 'wind') ? 0x0400 : 0x0010) | 0x0080
      const lo = (w & 0xff).toString(16).padStart(2, '0')
      const hi = ((w >> 8) & 0xff).toString(16).padStart(2, '0')
      this.send(7, 65305, `41,9f,00,0a,${lo},${hi},00,00`)
      return
    }
    const mode = this.currentMode()
    const frames = (mode === 'standby') ? STANDBY_65305 : (MODE_65305_ENGAGED[mode] || STANDBY_65305)
    for (const f of frames) { this.send(7, 65305, f) }
  }

  send65341 () {
    // Nav-confirm PENDING (ground truth Kees NAC-3 nav-mode capture): while awaiting the
    // confirm the AP sends selector 0x0d carrying the course-to-steer, not a mode field.
    // Populate it with the target/current heading so the MFD's confirm dialog shows a
    // sensible course; falls back to NA if no heading is available.
    if (this.navPending) {
      const t = this.selfPathNum('steering.autopilot.target.headingMagnetic.value')
      const h = (t !== null) ? t : this.headingRad()
      this.send(7, 65341, h !== null ? `41,9f,ff,ff,0d,ff,${this.rad16(h)}` : '41,9f,ff,ff,0d,ff,ff,ff')
      return
    }
    // Ground truth (Kees NAC-3 wind capture 2026-06-30): which 65341 field is carried
    // depends on mode. In WIND the AP sends ONLY field 0x03 = commanded apparent wind
    // angle (rad*10000 LE16 UNSIGNED, same scaling+convention as 130306); field 0x02
    // stays NA and the heading-to-steer rides 127237 instead. Proof: at wind engage the
    // field-03 value matched the live 130306 AWA to the bit (b3,61 = 143.3deg) and then
    // tracked the change-course commands. So in wind we emit field 0x03 and suppress the
    // field-02 heading frame.
    if (this.commandedMode === 'wind') {
      const wa = this.windTargetRad()
      // rad16's unsigned wrap maps SK's signed AWA (-pi..pi, port negative) onto the
      // AP's 0..2pi convention (starboard 0..180, port 180..360) -- direction-correct.
      this.send(7, 65341, wa !== null ? `41,9f,ff,ff,03,ff,${this.rad16(wa)}` : '41,9f,ff,ff,03,ff,ff,ff')
      return
    }
    // Ground truth (Kees NAC-3 nav-mode capture 2026-06-30): in ROUTE the AP sends ONLY
    // 65341 field 0x0a with a zero value (41 9f ff ff 0a ff 00 00, x881 over the 3.5-min
    // leg); the heading-to-steer rides 127237. Previously route fell through to the
    // field-0x02 (heading) branch below, so the AP-status PGN reported an auto/heading
    // field while route was engaged -- that inconsistency crashed the Vulcan's AP view
    // when opened from scratch in Nav (README known-limitation).
    if (this.commandedMode === 'route') {
      this.send(7, 65341, '41,9f,ff,ff,0a,ff,00,00')
      return
    }
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

  // 127237 Heading/Track Control with a populated Heading-To-Steer. A real AC
  // re-broadcasts this and the Navico MFD reads the set heading from it; without
  // it the MFD shows "- - -". Steering Mode = Heading Control, Heading Reference
  // = Magnetic (byte1 0x44); Heading-To-Steer = locked heading (bytes 5-6).
  // Sent at 5 Hz (firehose5Hz): the boat's other devices broadcast 127237 with
  // an empty Heading-To-Steer at 10-20 Hz, which blanks our value if we only send
  // at 1 Hz, so the set-heading display flickers. A higher rate keeps ours current.
  send127237 () {
    const t = this.selfPathNum('steering.autopilot.target.headingMagnetic.value')
    const h = (t !== null) ? t : this.headingRad()
    if (h === null) { return }
    this.send(2, 127237, `ff,44,ff,ff,7f,${this.rad16(h)},00,00,ff,ff,ff,ff,ff,7f,ff,7f,ff,7f,ff,ff`)
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
    this.reconcileNavPending()
    this.send65305()
    this.send65341()
  }

  // Resolve the nav-confirm pending window against the EV-200's real state (sniffed 65379),
  // which SK cannot give us -- the V2 API maps both Track-pending (0x0180) and Track-engaged
  // (0x0181) to 'route'. Runs at 2 Hz from the firehose.
  reconcileNavPending () {
    if (!this.navPending) { return }
    const evFresh = this.evPilotMode !== null && (Date.now() - this.evPilotAt) < 5000
    // The pilot actually engaged Track-to-waypoint (via our advanceWaypoint or a P70 Yes):
    // latch the MFD display to route.
    if (evFresh && this.evPilotMode === 0x0181) {
      this.navPending = false
      this.commandedMode = 'route'
      this.commandedAt = Date.now()
      this.debug('EV-200 reached Track-engaged (0x0181) -- latching MFD nav display')
      return
    }
    // The pilot left the route-engage flow (e.g. Standby on the P70) after we armed: drop
    // the pending dialog. 3 s grace covers PUT + EV reaction + the 1 Hz 65379 broadcast so a
    // single dropped frame can't trip a premature clear on the pre-0x0180 state.
    if (evFresh && (Date.now() - this.navPendingAt) > 3000 &&
        this.evPilotMode !== 0x0180 && this.evPilotMode !== 0x0181) {
      this.navPending = false
      this.debug('EV-200 left route-engage (mode 0x' + this.evPilotMode.toString(16) + ') -- clearing pending')
      return
    }
    // Anti-stuck fallback: no confirm and no pilot signal within the timeout.
    if ((Date.now() - this.navPendingAt) > NAV_PENDING_MS) {
      this.navPending = false
      this.debug('Nav pending expired without confirm -- reverting to ' + this.currentMode())
    }
  }

  firehose5Hz () {
    if (!this.enableFirehose || !this.bootDone) { return }
    if (this.currentMode() !== 'standby') { this.send127237() }
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
      this.state.lastV2Result = 'NO TOKEN (approve access under Security -> Access Requests)'
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
    // Latch the MFD source only on a genuine actionable command -- not the 0x2b bus
    // mode-change announce (a broadcast that can originate from a differently-named
    // Navico function address) and not our own commissioning head -- so the resolved
    // name tracks the address that actually drives the pilot.
    if (((key in KEY_STATE) || key === TACK_KEY || key === CHANGE_COURSE) && !this.isOwnSrc(pgn.src)) {
      this.mfdSrc = pgn.src
    }
    if (KEY_GUESS.has(key)) {
      // nodrift (0x0c) is guessed -- log so a capture confirms the key, never fire.
      this.debug(`GUESSED key ${key} (${KEY_NAME[key]}) -- logged, NOT fired`)
      return
    }
    if (key in KEY_STATE) {
      const st = KEY_STATE[key]
      if (st === 'route') {
        // Nav engage is a two-step. Nav #1 PUTs route -> the EV-200 goes to Track-PENDING
        // (65379 mode 0x0180) and the MFD raises its "engage nav?" dialog. Nav #2 is the MFD
        // confirm: it fires the SK V1 advanceWaypoint action (NOT the V2 courseNextPoint, which
        // @signalk/signalk-autopilot 2.6.0 leaves unimplemented), which for the Raymarine
        // provider emits the Track-to-waypoint engage (65379 -> 0x0181) -- byte-identical to the
        // P70's physical Yes -- so the pilot engages without a separate P70 press. It
        // is guarded server-side by state==='route', a free safety: if the route PUT never
        // took (no token / rejected) the engage 400s instead of firing blind. The display
        // also latches on the observed 0x0181 (see reconcileNavPending), so a P70-only
        // confirm clears the dialog too.
        const evFresh = this.evPilotMode !== null && (Date.now() - this.evPilotAt) < 5000
        if (this.navPending) {
          if ((Date.now() - this.navPendingAt) < 400) {
            // Duplicate/echoed Nav frame right after arming -- ignore so a doubled
            // fast-packet can't self-confirm and engage the pilot.
            this.debug('Nav 0x0a within 400ms of arming -- treated as duplicate, ignored')
          } else {
            this.navPending = false
            this.commandedMode = 'route'
            this.commandedAt = Date.now()
            if (evFresh && this.evPilotMode === 0x0181) {
              // The pilot already engaged (e.g. a P70 Yes landed inside the confirm window):
              // just latch the display, do NOT re-send the engage -- against an engaged
              // pilot that command advances to the next waypoint.
              this.state.lastMappedEvent = 'Nav confirm on MFD -> pilot already engaged, latched'
            } else {
              this.state.lastMappedEvent = 'Nav confirm on MFD -> engage track'
              this.applyV2('engage track (V1 advanceWaypoint)', (cb) => this.sk.advanceWaypoint(cb))
            }
          }
        } else if (this.commandedMode === 'route') {
          // Display already shows route. Only re-send the engage if the pilot is STILL
          // Track-pending (0x0180) a full 65379 broadcast period (>1.2 s) AFTER our last
          // engage command. A shorter window can't tell "still pending" from a stale 0x0180
          // broadcast that predates the engage taking effect -- so a fast repeat-tap would
          // POST a second advanceWaypoint against a just-engaged pilot and skip a waypoint.
          // Any other case (engaged 0x0181, or no fresh proof of still-pending) is a stray
          // press -- ignore.
          if (evFresh && this.evPilotMode === 0x0180 && (this.evPilotAt - this.commandedAt) > 1200) {
            this.commandedAt = Date.now()
            this.state.lastMappedEvent = 'Nav re-confirm (pilot still pending) -> engage track'
            this.applyV2('re-engage track (V1 advanceWaypoint)', (cb) => this.sk.advanceWaypoint(cb))
          } else {
            this.state.lastMappedEvent = 'Nav while already in route (ignored)'
            this.debug('Nav key 0x0a but already in route / no fresh pending proof -- ignored')
          }
        } else {
          // Nav #1: arm the MFD confirm dialog and ask the EV-200 to engage route now (it
          // goes to Track-pending 0x0180). The display stays pending until the MFD confirm
          // (Nav #2) or the pilot reaching 0x0181 (reconcileNavPending latches on either).
          this.navPending = true
          this.navPendingAt = Date.now()
          this.commandedAt = Date.now()
          this.state.lastMappedEvent = 'Nav pending + PUT route (confirm on MFD to engage)'
          this.debug('Nav key 0x0a -> pending + PUT route; confirm (2nd Nav) fires V1 advanceWaypoint engage')
          this.applyV2('PUT /state {value:"route"}', (cb) => this.sk.setState('route', cb))
        }
      } else {
        // Any other mode key cancels a pending nav and switches mode immediately.
        this.navPending = false
        this.commandedMode = st   // optimistic: drive the firehose display immediately
        this.commandedAt = Date.now()
        this.applyV2(`PUT /state {value:"${st}"}`, (cb) => this.sk.setState(st, cb))
      }
    } else if (key === TACK_KEY) {
      // Vulcan Tack/Gybe button. No direction in the frame -- derive the turn
      // side from the wind angle (windAngleSigned: the EV-200's locked wind datum
      // when fresh, else live AWA; positive to starboard) and delegate to the SK
      // V2 tack endpoint, which the EV-200 turns into a wind-angle mirror: a tack
      // when the wind is forward, a gybe when it is aft. Only meaningful in wind
      // mode, and only when the pilot is engaged and SK state is fresh (never tack
      // a standby or a stale poll).
      if (!this.engaged()) {
        this.state.lastMappedEvent = 'Tack/Gybe key while not engaged (ignored)'
        this.debug(`Tack/Gybe key 0x11 but not engaged (state=${this.state.skApState} fresh=${this.skFresh()}) -- ignored`)
      } else if (this.state.skApState !== 'wind') {
        this.state.lastMappedEvent = 'Tack/Gybe key outside wind mode (ignored)'
        this.debug(`Tack/Gybe key 0x11 but state=${this.state.skApState} -- only valid in wind mode, ignored`)
      } else {
        const awa = this.windAngleSigned()
        if (awa === null) {
          this.state.lastMappedEvent = 'Tack/Gybe key but no wind angle (ignored)'
          this.debug('Tack/Gybe key 0x11 but no wind angle (datum or live) -- cannot derive direction, ignored')
        } else if (awa === 0) {
          // Wind dead ahead: turn side is genuinely ambiguous, don't guess. (null
          // above already covers missing data; ===0 is the legitimate head-on case.)
          this.state.lastMappedEvent = 'Tack/Gybe key: wind dead ahead, ambiguous (ignored)'
          this.debug('Tack/Gybe key 0x11 but wind is dead ahead (AWA 0) -- turn side ambiguous, ignored')
        } else {
          // Raymarine AutoTack (p70 manual, "Using AutoTack in wind vane mode" +
          // "Accidental gybes"): the commanded side IS the physical turn
          // direction -- +1+10 (POST /tack/starboard) turns to starboard, -1-10
          // (/tack/port) to port. A TACK turns INTO the wind, a GYBE turns AWAY
          // from it, so for a given wind side the two need OPPOSITE sides:
          //   tack -> turn toward the wind side (awa>0 -> starboard)
          //   gybe -> turn away from the wind   (awa>0 -> port)
          // Wind aft (|AWA| > 90deg) => gybe. Confirmed against the EV-200 capture
          // 2026-07-02 (locked heading moved +135deg on /tack/starboard, -135 on
          // /tack/port). NB: a gybe only EXECUTES if the p70's Gybe Inhibit is set
          // to Allow Gybe -- Prevent Gybe blocks any AutoTack away from the wind.
          const isGybe = Math.abs(awa) > Math.PI / 2
          const dir = ((awa > 0) === isGybe) ? 'port' : 'starboard'
          const awaDeg = Math.round(awa * 180 / Math.PI)
          const kind = isGybe ? 'gybe' : 'tack'
          this.applyV2(`POST /tack/${dir} (Vulcan Tack key: ${kind}, AWA ${awaDeg}deg)`,
                       (cb) => this.sk.tack(dir, cb))
        }
      }
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
          // must never be nudged.
          this.state.lastMappedEvent = `ChangeCourse ${Math.round(degMag)}deg while not engaged (ignored)`
          this.debug(`ChangeCourse ${Math.round(degMag)}deg but not engaged (state=${this.state.skApState} fresh=${this.skFresh()}) -- ignored`)
        } else {
          // ChangeCourse only ever carries a ±1/±10 nudge from the Vulcan; a
          // tack/gybe comes as TACK_KEY (0x11), not a large ChangeCourse. Apply
          // the nudge as a target adjustment. A large value (never seen in the
          // wild) would fall here too and be rejected by the plugin, which
          // accepts only ±1/±10 -- harmless.
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

  // The Raymarine EV-200 broadcasts PGN 65345 "Pilot Wind Datum" only while it is
  // holding a wind angle. canboatjs decodes field "Wind Datum" as the locked commanded
  // apparent wind angle (unsigned 0..2pi, 0.0001 rad/bit -- same convention as our 65341
  // field-03 and 130306). That is exactly the setpoint to echo back to the Vulcan instead
  // of the fluctuating live AWA, so cache it with a timestamp for windTargetRad(). The SK
  // core already maps this PGN to steering.autopilot.target.windAngleApparent, so we only
  // consume it here -- no need to re-publish a path the server already owns.
  onWindDatum (pgn) {
    const v = pgn.fields && pgn.fields['Wind Datum']
    if (typeof v === 'number') {
      this.windDatumRad = v
      this.windDatumAt = Date.now()
    }
  }

  // Sniff the EV-200's own PGN 65379 (Raymarine mfr header 3b,9f) off the bus to learn the
  // pilot's real state, which SK cannot resolve: the V2 API maps both Track-pending (mode
  // word 0x0180) and Track-engaged (0x0181) to 'route'. Mode word (LE16 at bytes 2-3):
  // 0x0000 standby / 0x0180 Track-pending (waiting for the P70's -- or our advanceWaypoint --
  // confirm) / 0x0181 Track-engaged. reconcileNavPending() uses it to latch the MFD display
  // on the real engage and to drop a pending dialog if the pilot bails.
  onPilotMode (msg) {
    const b = Buffer.isBuffer(msg.data) ? msg.data : Buffer.from(msg.data)
    if (b.length < 4 || b[0] !== 0x3b || b[1] !== 0x9f) { return }
    this.evPilotMode = b[2] | (b[3] << 8)
    this.evPilotAt = Date.now()
    if (msg.pgn && typeof msg.pgn.src === 'number') { this.pilotSrc = msg.pgn.src }
  }

  // ---- stream handlers ----
  onRawFrame (msg) {
    // Runs inside the canbus 'data' emit; an unhandled throw here would surface
    // as an uncaught exception and take down the SignalK server, so guard it.
    try {
      if (!msg || !msg.pgn) { return }
      // Every frame on the bus passes here (canbus filters out only our own address),
      // so this is the cheapest and most accurate liveness signal we have.
      if (typeof msg.pgn.src === 'number') { this.seen[msg.pgn.src] = Date.now() }
      if (!msg.data) { return }
      if (msg.pgn.pgn === 65379) { this.onPilotMode(msg); return }
      if (msg.pgn.pgn !== 130850) { return }
      const src = msg.pgn.src
      const b = Buffer.isBuffer(msg.data) ? msg.data : Buffer.from(msg.data)
      if (b.length < 1) { return }
      const seq = b[0] >> 5; const frame = b[0] & 0x1f
      const fk = src * 8 + seq
      if (frame === 0) {
        // frame 0 carries the total byte length in b[1]; a runt frame (no length
        // byte) or an out-of-range total is corrupt -- drop it rather than build a
        // bad packet whose bytes ChangeCourse would later misdecode.
        if (b.length < 2 || b[1] < 2 || b[1] > 223) { return }
        this.fpBuf[fk] = { total: b[1], at: Date.now(), bytes: Array.from(b.slice(2)) }
      } else if (this.fpBuf[fk] && (Date.now() - this.fpBuf[fk].at) < 1000) {
        this.fpBuf[fk].bytes.push(...Array.from(b.slice(1)))
      } else {
        // No live frame 0 for this seq: either genuinely missed, or an abandoned
        // stale sequence (frame 0 dropped) that a wrapped seq would otherwise get
        // appended onto, corrupting the packet. Discard so it can't accumulate.
        delete this.fpBuf[fk]
        return
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
      if (pgn.pgn === 65345) { this.onWindDatum(pgn); return }
      if (pgn.pgn === 130850 && pgn.src !== this.myAddr()) { this.handleIncomingAP(pgn) }
    } catch (e) { this.debug('handler error: ' + (e && e.message)) }
  }

  // ---- device identification (for the status page / plugin config) ----
  // Find a source's N2K device record in the server's source registry
  // ({ <bus>: { <src>: { n2k: {...} } } }).
  findN2k (sources, src) {
    if (src == null || !sources) { return null }
    const key = String(src)
    for (const bus of Object.keys(sources)) {
      const devs = sources[bus]
      if (devs && typeof devs === 'object' && devs[key] && devs[key].n2k) { return devs[key].n2k }
    }
    return null
  }

  // True for our own emulated addresses (the AC itself and, when enabled, the
  // commissioning control head) so they are never resolved as a real bus device.
  isOwnSrc (src) {
    if (src == null) { return false }
    const a = this.myAddr()
    if (a !== undefined && Number(src) === a) { return true }
    if (this.commissioningHead && Number(src) === this.headAddress) { return true }
    return false
  }

  // A human label for a device: its product name (modelVersion is usually the
  // friendly string, else modelId), prefixed with the manufacturer unless the
  // product name already starts with it; falls back to manufacturer + class.
  deviceLabel (n) {
    if (!n) { return null }
    const prod = (n.modelVersion && String(n.modelVersion).trim()) ||
                 (n.modelId && String(n.modelId).trim()) || null
    const mfr = n.manufacturerCode ? String(n.manufacturerCode).trim() : ''
    if (prod) {
      const w = mfr.split(' ')[0].toLowerCase()
      if (mfr && w && prod.toLowerCase().indexOf(w) !== 0) { return mfr + ' ' + prod }
      return prod
    }
    return mfr ? (mfr + (n.deviceClass ? ' · ' + n.deviceClass : '')) : null
  }

  // Best MFD name plus EVERY address that plotter claims. The address that sends our
  // 130850 only speaks when a button is pressed (a Vulcan 7's is otherwise silent for
  // ~60 s at a time), so liveness has to pool the plotter's other addresses -- its
  // iGPS/Navigator/Display functions chatter continuously. They share the manufacturer
  // and the model name once the sub-function suffix is stripped, which is how they pool
  // (canName differs per address, so identity cannot).
  bestMfd (sources) {
    const NAVICO = new Set(['B & G', 'Simrad', 'Navico', 'Lowrance'])
    const MFD_RE = /vulcan|zeus|nss|nso|nsx|hds|lowrance|\bgo\b/i
    // A Navico MFD claims several function addresses (…MFD / …Navigator / …iGPS /
    // …Echo (This unit) / …Pilot Controller); drop the sub-function suffix so any of
    // them reads as the plotter model, e.g. "Vulcan 7".
    const clean = (p) => p
      .replace(/\s*\(this unit\)$/i, '')
      .replace(/\s+(MFD|Navigator|Display|Chartplotter|Plotter|Pilot Controller|iGPS|GPS|Echo|Sonar|Radar)$/i, '')
      .trim() || p
    const prodOf = (n) => (n && ((n.modelVersion && String(n.modelVersion).trim()) ||
                                 (n.modelId && String(n.modelId).trim()))) || null

    const cands = []
    for (const bus of Object.keys(sources)) {
      const devs = sources[bus]
      if (!devs || typeof devs !== 'object') { continue }
      for (const k of Object.keys(devs)) {
        if (this.isOwnSrc(k)) { continue }
        const n = devs[k] && devs[k].n2k
        if (!n || !NAVICO.has(n.manufacturerCode)) { continue }
        const prod = prodOf(n)
        if (!prod || !MFD_RE.test(prod)) { continue }
        cands.push({ src: Number(k), model: clean(prod), mfr: n.manufacturerCode, display: n.deviceClass === 'Display' })
      }
    }

    // Model precedence: the bound command address, else the Display-class address (the
    // scan runs in address order, which would otherwise hit a sub-function first).
    let model = null
    let mfr = null
    let fallback = null
    if (this.mfdSrc != null) {
      const n = this.findN2k(sources, this.mfdSrc)
      const prod = prodOf(n)
      if (prod) {
        model = MFD_RE.test(prod) ? clean(prod) : prod
        mfr = n.manufacturerCode
      } else {
        fallback = this.deviceLabel(n)
      }
    }
    if (!model) {
      const pick = cands.find((c) => c.display) || cands[0]
      if (pick) { model = pick.model; mfr = pick.mfr }
    }
    // pooled=false means this cycle carried no product info, so srcs is NOT the plotter's
    // full address set and must not replace the pool we already resolved (a sparse cycle
    // would otherwise shrink it to the button address alone, which is silent for ~60 s).
    if (!model) { return { label: fallback, srcs: [], pooled: false } }

    const key = model.toLowerCase()
    const srcs = cands.filter((c) => c.model.toLowerCase() === key).map((c) => c.src)
    if (this.mfdSrc != null && srcs.indexOf(this.mfdSrc) < 0) { srcs.push(this.mfdSrc) }
    return { label: this.deviceLabel({ modelVersion: model, manufacturerCode: mfr }), srcs, pooled: true }
  }

  // A device in the "Steering and Control surfaces" class with a given device
  // function (150 autopilot, 140 control head, 130 actuator/drive) that advertises
  // a product name -- so the MFD's nameless AP-control function is skipped. Prefer a
  // match from the pilot's own manufacturer (the control head and drive belong to
  // the pilot, not to some other brand's steering device on the bus).
  findSteeringRole (sources, funcCode, preferMfr) {
    let fallback = null
    for (const bus of Object.keys(sources)) {
      const devs = sources[bus]
      if (!devs || typeof devs !== 'object') { continue }
      for (const k of Object.keys(devs)) {
        if (this.isOwnSrc(k)) { continue }
        const n = devs[k] && devs[k].n2k
        if (!n || String(n.deviceClass || '').indexOf('Steering') !== 0) { continue }
        if (n.deviceFunction !== funcCode) { continue }
        const prod = (n.modelVersion && String(n.modelVersion).trim()) || (n.modelId && String(n.modelId).trim())
        if (!prod) { continue }
        const found = { label: this.deviceLabel(n), src: Number(k) }
        if (preferMfr && n.manufacturerCode === preferMfr) { return found }
        if (!fallback) { fallback = found }
      }
    }
    return fallback
  }

  // Refresh the resolved device names from the server's source registry. Read-only
  // loopback GET; safe if it fails (names just stay as they were / null).
  refreshDevices () {
    if (!this.sk) { return }
    this.sk.getSources((err, sources) => {
      if (err || !sources || typeof sources !== 'object') { return }
      try {
        // Sticky: only overwrite a resolved name with a new NON-null value. A single
        // getSources cycle that comes back sparse (product info not yet re-broadcast)
        // must not blank a name we already have -- otherwise the config-page "Detected"
        // block flickers away a few seconds after it appears.
        const mfd = this.bestMfd(sources)
        if (mfd.label) { this.mfdName = mfd.label }
        if (mfd.pooled && mfd.srcs.length) { this.mfdSrcs = mfd.srcs }
        // the button address may latch after the pool was built -- keep it in there
        if (this.mfdSrc != null && this.mfdSrcs.indexOf(this.mfdSrc) < 0) { this.mfdSrcs.push(this.mfdSrc) }
        const pilotN = this.pilotSrc != null ? this.findN2k(sources, this.pilotSrc) : null
        if (pilotN && pilotN.manufacturerCode) { this.pilotMfr = String(pilotN.manufacturerCode).trim() }
        const pilot = this.deviceLabel(pilotN)
        if (pilot) { this.pilotName = pilot }
        // control head = function 140, actuator control unit = function 130, scoped to the pilot's brand.
        const head = this.findSteeringRole(sources, 140, this.pilotMfr)
        if (head) { this.controlHeadName = head.label; this.headSrc = head.src }
        const acu = this.findSteeringRole(sources, 130, this.pilotMfr)
        if (acu) { this.acuName = acu.label; this.acuSrc = acu.src }
      } catch (e) { this.debug('device resolve failed: ' + (e && e.message)) }
    })
  }

  // Liveness of a device from the frames it puts on the bus, given the address(es) it
  // claims. 'missing' = in the server's registry (so we can name it) but silent since we
  // started -- a powered-down plotter; 'offline' = it was there and went quiet.
  // null = no address resolved yet, so there is nothing to say.
  presenceOf (srcs) {
    const list = (Array.isArray(srcs) ? srcs : [srcs]).filter((s) => s != null)
    if (!list.length) { return null }
    let last = 0
    for (const s of list) {
      const t = this.seen[s]
      if (t && t > last) { last = t }
    }
    if (!last) { return 'missing' }
    return (Date.now() - last) <= DEVICE_STALE_MS ? 'online' : 'offline'
  }

  // ---- status surfaced to the plugin ----
  statusSummary () {
    const s = this.state
    const addr = s.address === undefined ? '?' : s.address
    const wd = (this.windDatumRad !== null && (Date.now() - this.windDatumAt) < 5000)
      ? ` | wndDatum ${Math.round(this.windDatumRad * 180 / Math.PI)}deg` : ''
    const v2 = (this.bridge !== 'off' && s.lastV2Result) ? ` | v2 ${s.lastV2Result}` : ''
    const ev = (this.evPilotMode !== null && (Date.now() - this.evPilotAt) < 5000)
      ? ` | ev 0x${this.evPilotMode.toString(16).padStart(4, '0')}` : ''
    const pend = this.navPending ? ' | NAV-PENDING' : ''
    const np = this.noProvider ? ' | NO AUTOPILOT PROVIDER (install/configure one -- cannot steer)' : ''
    // Device identities live in the schema description block (and the webapp), so keep the
    // status line to live operational state only -- no MFD/pilot names, which duplicated it.
    return `${this.acModel} @addr ${addr} | bridge ${this.bridge}${np} | ` +
           `mode ${this.commandedMode}${pend} | ` +
           `SK ${this.skFresh() ? (s.skApState || '?') : 'stale'} | ` +
           `cmds ${s.ap130850Count} | last ${s.lastMappedEvent || '-'}${wd}${ev}${v2}`
  }

  // Structured status for the status webapp (served read-only via the plugin router).
  statusJson () {
    const s = this.state
    const evFresh = this.evPilotMode !== null && (Date.now() - this.evPilotAt) < 5000
    const EV = { 0x0000: 'standby', 0x0040: 'auto', 0x0100: 'wind', 0x0180: 'route-pending', 0x0181: 'route-engaged' }
    const wdFresh = this.windDatumRad !== null && (Date.now() - this.windDatumAt) < 5000
    return {
      acModel: this.acModel,
      address: s.address === undefined ? null : s.address,
      mfdSrc: this.mfdSrc,                 // MFD source addr (null until it sends a command)
      mfdName: this.mfdName,               // resolved MFD product name, or null
      pilotSrc: this.pilotSrc,             // pilot source addr (null until it broadcasts 65379)
      pilotName: this.pilotName,           // resolved pilot (course computer) product name, or null
      acuName: this.acuName,               // resolved actuator control unit (e.g. ACU200), or null
      controlHeadName: this.controlHeadName, // resolved control head (e.g. p70s), or null
      // per-device liveness off the bus: online | offline | missing | null (unresolved)
      mfdPresence: this.presenceOf(this.mfdSrcs),
      pilotPresence: this.presenceOf(this.pilotSrc),
      acuPresence: this.presenceOf(this.acuSrc),
      headPresence: this.presenceOf(this.headSrc),
      bridge: this.bridge,                 // off | dry-run | live
      noProvider: this.noProvider,         // true = no autopilot V2 provider to steer
      providerId: this.providerId,         // the default V2 autopilot instance id, or null
      hasToken: !!(this.sk && this.sk.token),
      commandedMode: this.commandedMode,   // firehose display mode
      navPending: this.navPending,         // MFD nav-confirm dialog armed
      skState: this.skFresh() ? (s.skApState || null) : null,
      skStale: !this.skFresh(),
      evPilotMode: evFresh ? this.evPilotMode : null,
      evPilotState: evFresh ? (EV[this.evPilotMode] || ('0x' + this.evPilotMode.toString(16).padStart(4, '0'))) : null,
      windDatumDeg: wdFresh ? Math.round(this.windDatumRad * 180 / Math.PI) : null,
      cmdCount: s.ap130850Count,
      lastEvent: s.lastMappedEvent || null,
      lastV2Result: s.lastV2Result || null,
      lastRawHex: s.lastApRaw ? s.lastApRaw.hex : null
    }
  }

  updateStatus () {
    if (!this.app) { return }
    const summary = this.statusSummary()
    // NO AUTOPILOT PROVIDER (nothing to steer) or live-without-a-token means the bridge
    // cannot do its job -- report it as a plugin ERROR (red) so a green badge never
    // sits next to "cannot steer". Deliberate off / dry-run stays a normal status.
    const cannotSteer = this.noProvider || (this.bridge === 'live' && !(this.sk && this.sk.token))
    if (cannotSteer && typeof this.app.setPluginError === 'function') {
      this.app.setPluginError(summary)
    } else if (typeof this.app.setPluginStatus === 'function') {
      this.app.setPluginStatus(summary)
    }
  }
}

module.exports = ACEmulator
