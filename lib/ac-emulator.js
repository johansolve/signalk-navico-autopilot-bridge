'use strict'

const EventEmitter = require('events')
const fs = require('fs')
const SkAutopilot = require('./sk-autopilot')
const { createPgnStream, requireCanboat } = require('./canboat-compat')

// canboatjs comes from the host server. requireCanboat() (canboat-compat) finds it
// beside the plugin or, failing that, in the server's own tree. Called lazily from
// start() so the module still loads (and the registry can score it) when it is absent.

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

// INPUT decode. The group and key bytes are read from the RAW frame (onRawFrame
// reassembles it and stores group=byte5, key=byte6 in state.lastApRaw before the
// parsed PGN reaches here), so the decode does not depend on how the host's
// canboatjs version names the fields. That matters: canboatjs 2.10 has an
// incomplete definition for this Simnet layout, decoding the GROUP byte (0x0a)
// as fields.Event ("Nav mode") and the real command KEY byte as fields["Unused B"],
// while 3.x resolves each key to its own PGN variant (simnetCommandApStandby etc.)
// with camelCase fields and NEITHER of those names -- so a 2.x-only field decode
// silently drops every button on a 3.x host. The canboat fields stay as a fallback
// for the case where no raw frame was captured (2.x naming; on 3.x the fallback
// yields nothing, which is no worse than the old behaviour).
// Keys verified live against a Vulcan 7 (2026-06-13).
// NoDrift (0x0c) deliberately maps to plain auto: nothing in the SignalK chain can
// ask for a COG-referenced hold, and its mode word is already taken by the waypoint
// advance. Rationale in PROTOCOL-REFERENCE §2.2, consequences in README.
const KEY_STATE = { 0x06: 'standby', 0x09: 'auto', 0x0c: 'auto', 0x0f: 'wind', 0x0a: 'route' }
const KEY_NAME = {
  0x06: 'Standby', 0x09: 'Auto', 0x0a: 'Nav/Track', 0x0c: 'NoDrift',
  0x0f: 'Wind', 0x11: 'Tack', 0x1a: 'ChangeCourse', 0x1c: '(key-press envelope)',
  // 0x2b: a bus-wide announce emitted right after each mode change (broadcast,
  //   b2=0xff b4=0x64, seen in Kees' NAC-3 nav-mode capture 2026-06-30), not a command
  //   directed at the AC and not in KEY_STATE, so it never fires. 0x10 is the MFD's
  //   nav-confirm Yes, handled via CONFIRM_KEY below.
  0x10: 'Nav confirm (MFD Yes)', 0x2b: '(bus mode-change announce)'
}
const CHANGE_COURSE = 0x1a
// The Vulcan's Tack/Gybe button sends key 0x11 with NO direction or magnitude.
// Both dockside captures 2026-07-02 show it as: 41 9F <ac> FF FF 0A 11 00 00.
// The MFD picks the button LABEL (Tack when the wind is forward, Gybe when aft)
// but sends the same key either way -- the pilot derives tack-vs-gybe and the
// turn side from the wind. So we fire it in wind mode and let the EV-200 mirror
// the apparent wind angle to the other side (a tack upwind, a gybe downwind).
const TACK_KEY = 0x11
// The MFD's nav-confirm "Yes" sends key 0x10 (decimal 16) -- NOT a second Nav/Track
// key (0x0a) as first assumed. Dockside 2026-07-14: from wind, Nav #1 (0x0a) armed
// route-pending and raised the MFD dialog, the dialog's Yes emitted 0x10, and the old
// code (0x10 unhandled) dropped it, so the confirm reverted to Wind and only a SECOND
// 0x0a engaged. Treat 0x10 as the confirm, but only while navPending -- outside that
// window it stays an ignored one-off (advanceWaypoint is also server-guarded by
// state==='route', so a stray confirm can never engage a non-armed pilot).
const CONFIRM_KEY = 0x10

// Per-mode firehose frames derived from htool/RaymarineAPtoFakeNavicoAutoPilot.
// htool found that 65305 "00,1d,.." sets the mode the MFD DISPLAYS and "00,0a,.."
// sets state (standby/engaged); we previously only sent 0a, so the overlay stuck
// on "auto". (65340/65302 were sent per mode too until 2026-07-22, when a dockside
// test showed the MFD binds and labels modes correctly without them -- dropped, see
// PROTOCOL-REFERENCE §3.3. TX_PGNS still declares both, as a real AC does. Briefly
// restored 2026-08-01 on a hunch that the MFD's "no AP computer" alarm was a timeout
// on a declared-but-absent PGN; the alarm turned out to be a SignalK event-loop stall
// with an unrelated cause, so they went back out the same day.)
//
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
// Hold the MFD's confirm dialog at least this long before the pilot's own mode may latch it
// away. The pilot promotes itself into track-cog unprompted and faster than the dialog renders,
// which is exactly how the confirm went missing (2026-07-30).
// A human confirm may land before the pilot has reached track at all: the confirm then sends
// PUT route (0x0180 TrackMode) and the pilot wants the second half, 0x0181, a moment later --
// which is exactly what the P70 chirps for. Completing that is finishing the skipper's OWN
// action, already given on the MFD, not answering for them. Once, inside this window.
// The four real Autopilot V2 modes. Anything else the API reports (notably `off-line`) is a
// status, not a mode -- see normalizeMode.
const AP_MODES = ['standby', 'auto', 'wind', 'route']
// Consecutive failed state polls (0.5 Hz) before the firehose stops claiming an engagement it
// cannot verify. Hysteresis matters more than speed here: currentMode drives both the 65305
// mode-change announce and 127237, so flapping across the threshold would have the MFD raise a
// lost-autopilot alarm over and over -- and an indicator that cries wolf stops being read.
// Recovery is deliberately immediate, only the downgrade is damped.
const DOWNGRADE_AFTER_POLLS = 3
// A pilot-mode observation must postdate our own command by this much before it says anything
// about whether that command landed: 65379 is broadcast at 1 Hz.
const PILOT_PROOF_MS = 1200
const ENGAGE_FOLLOWUP_MS = 15000
// The EV-200 sometimes does not act on our 65379 mode write, and the skipper is then left
// answering at the control head after 8-10 s of chirping. Measured over all 14 pending episodes
// of 2026-08-01: of six writes that landed within 200 ms of the pilot entering Track-pending,
// four were obeyed and two were not -- including two writes 14 ms after the edge with OPPOSITE
// outcomes, same bytes, same kind of turn. So the loss is not a timing threshold, and a delay
// before answering (tried that afternoon, reverted) cannot fix it. What it looks like is a lost
// frame or a failed fast-packet reassembly, which is silent and indistinguishable from "ignored".
// Resending while the pilot is demonstrably still asking covers that, and covers a timing effect
// too if one exists -- and costs nothing at all when the first write lands, which is the usual case.
// Between attempts. The pilot broadcasts its mode at 1 Hz, so anything near 1000 ms leaves no room
// for a NEW mode word to arrive and prove the question is still open. Three attempts inside the
// window is plenty: four of six first attempts were obeyed outright, so a fourth and fifth only
// add exposure.
const ADVANCE_RETRY_GAP_MS = 2000
const ADVANCE_RETRY_WINDOW_MS = 6000     // give up well before the skipper would
const NAV_PENDING_MIN_MS = 2500
const NAV_PENDING_MS = 20000             // anti-stuck fallback only; normally cleared by the MFD confirm (2nd Nav) or the pilot reaching Track-engaged (0x0181)
// Telling the MFD's "Restart" (leg re-origin) apart from a waypoint advance. Both jump the
// leg bearing and both put the EV into Track-pending, but a restart keeps the SAME
// destination waypoint. Comparing the destination POSITION is the direct test. Distance to
// it is NOT: at an advance the distance steps from the arrival radius to the new leg's
// length, so a next leg roughly as long as the arrival radius is no step at all -- exactly
// the tight-water geometry where the advance size limit matters most. 10 m sits far below
// any real waypoint spacing and absorbs representation noise.
const RESTART_SAME_WP_TOL_M = 10
// A backstop on the re-origin: with the waypoint abaft the beam it asks for a near-reciprocal
// turn, and auto-confirming that is an involuntary gybe. (The bridge cannot actually tell a
// skipper-pressed Restart from a plotter-initiated one -- re-origins have been observed at
// 15 m of cross-track error -- so the press is not evidence of intent to swing.) Every
// genuine "drop the intercept swing" case has the waypoint forward of the beam, so 90 deg
// costs nothing there and leaves the hard-over case on the control head.
const RESTART_MAX_DEG = 90
// The EV can be slower to raise the pending after a re-origin than after an advance (it
// re-derives the leg instead of stepping to a stored one), so the restart path gets a more
// generous coincidence window than the advance path's 3 s.
const RESTART_PENDING_MS = 8000
// SignalK never nulls a path when its source stops -- bearingTrackTrue keeps serving the last
// leg indefinitely after a route is deactivated. So the leg state has to be aged out
// explicitly; without it the first sample of a NEW route sizes its "turn" against a leg from
// the previous one, and the held-duration gate waves that through (a frozen leg is old).
const LEG_MAX_AGE_MS = 10000
// How long after an advance a bearing jump on the same destination is read as that destination's
// bearing arriving late rather than as a re-origin. 129284 publishes at 1 Hz, so this is a couple
// of samples' grace; erring long only costs a manual confirm on a Restart pressed inside it.
const BRG_CATCHUP_MS = 3000
// ...and how far from the geometry's prediction that late bearing may land. Wide enough for the
// equirectangular approximation and a plotter rounding to a tenth, far too narrow for a re-origin.
const BRG_CATCHUP_TOL_DEG = 10
// How long a leg must have held the same destination AND the same bearing before "nothing has
// changed" is evidence rather than absence of evidence. Comfortably past BRG_CATCHUP_MS, so a
// bearing still on its way can never be mistaken for a bearing that stayed put.
const LEG_SETTLED_MS = 5000
// Below this the course over ground is not a course. One knot, in m/s.
const COG_MIN_SOG_MS = 0.514
const STANDBY_65305 = ['41,9f,00,02,02,00,00,00', '41,9f,00,0a,0a,00,00,00']
// Mode-change announce frames (htool: 00,1d drives the displayed mode label).
const MODE_CHANGE_65305 = ['41,9f,00,1d,81,00,00,00', '41,9f,00,1d,80,00,00,00']

const TX_PGNS = [65302, 65305, 65340, 65341, 65420, 126993, 127237,
                 127245, 127250, 128275, 130845, 130850, 130851, 130860]

// 126996 is 134 bytes: one first frame carrying 6 data bytes, then 7 bytes each.
const PRODUCT_INFO_FRAMES = 20
// Anything below this cannot hold the burst. 32 rather than exactly 20, so a queue that
// only just fits -- and would still drop frames whenever anything else is transmitting --
// is flagged too.
const TX_QUEUE_MIN = 32

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
    // Auto-confirm of a Track waypoint advance: when the pilot enters Track-pending at a
    // waypoint (EV mode 0x0180 while already in route), confirm it automatically if the
    // leg-to-leg course change is at most this many degrees -- so no control-head press
    // is needed for small turns. 0 = off (every advance needs a manual confirm).
    this.autoAdvanceMaxDeg = (typeof o.autoAdvanceMaxDeg === 'number' && o.autoAdvanceMaxDeg > 0) ? o.autoAdvanceMaxDeg : 0
    this.legBrg = null          // last-seen active leg bearingTrackTrue (rad), from the SK model
    this.legWp = null           // last-seen destination position, to tell restart from advance
    this.legSince = 0           // when the current leg was baselined, by bearing OR by destination
    this.lastTurnJumpDeg = null // the bearing's own reading of the turn, before the geometry
    this.lastTurnGeoDeg = null  // the turn as the two destinations describe it
    this.lastTurnMovedM = null  // how far the destination moved, i.e. why this is called an advance
    this.lastTurnDeg = null     // size of the most recent leg-to-leg course change (deg)
    this.lastTurnKind = null    // 'restart' (same waypoint, re-origined) or 'advance' (new waypoint)
    this.lastTurnOldHeldMs = 0  // how long the pre-turn leg had been held (trust gate)
    this.lastTurnAt = 0         // when that leg change happened
    this.legAdvancedAt = 0      // when this leg was advanced onto (to spot a late-arriving bearing)
    this.legGeoBrg = null       // the bearing the geometry predicts for it, to recognise that one
    this.legSettledUsed = false // the unchanged-leg answer is available once per leg, not per edge
    // Auto-confirm of an MFD "Restart" (leg re-origin), on its own switch so a skipper can want
    // every waypoint turn confirmed by hand and still not be asked for the re-origin they just
    // pressed for. It is not simply a widening: with this OFF a re-origin falls through to the
    // advance path and is judged by autoAdvanceMaxDeg (no 90 deg cap, 3 s coincidence window);
    // with it ON, RESTART_MAX_DEG and RESTART_PENDING_MS apply instead. Either can be the
    // stricter of the two depending on how autoAdvanceMaxDeg is set.
    this.autoConfirmRestart = !!o.autoConfirmRestart
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
      // The field has 0.001 resolution, so canboat multiplies by 1000 on encode:
      // 1200 became 1_200_000, wrapped the u16 to 20352 and read back as version
      // 20.352. Give it the actual version, 1.2, which encodes to raw 1200.
      'NMEA 2000 Version': 1.200,
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
    this.navClearedBy = null        // why the MFD dialog last went away (diagnostics)
    this.engageAuthedAt = 0         // human confirmed the engage; pilot not yet in track
    this.advanceRetryUntil = 0      // an auto-confirm is out; resend until the pilot stops asking
    this.advanceRetryAt = 0         // earliest next attempt
    this.advanceSentAt = 0          // our last attempt; the pilot must speak after it to count
    this.advanceRetryDesc = ''      // what we are retrying, for the status page
    this.cmdSeq = 0                 // orders commands so a late refusal can't undo a newer one
    this.pollFails = 0              // consecutive unreadable state polls (currentMode hysteresis)
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
      lastDecision: null,       // inputs + outcome of the last auto-advance decision
      lastV2Call: null,
      lastV2Result: null,
      ap130850Count: 0
    }
  }

  // Product info (126996) is 134 bytes -- 20 fast-packet frames sent back to back. Many
  // SocketCAN drivers default to txqueuelen 10 (mcp251x, i.e. the usual Raspberry Pi SPI
  // CAN HATs), so the queue fills around frame 11 and the kernel drops the rest. Silently:
  // canboatjs writes to a non-blocking socket without checking the result. The MFD then
  // lists the AC with no name or serial and its commissioning wizard may never complete.
  // Nothing here can fix it -- the queue belongs to the host, not to the plugin -- but
  // reading the length costs one sysfs file and turns a multi-day hunt into a status line.
  // Returns the length, or null when it cannot be read (non-Linux, no such interface) or
  // when there is no queue to speak of: qlen 0 means the noqueue qdisc, as on vcan, where
  // nothing is ever queued and so nothing can overflow. Treating 0 as "too short" would
  // fire the warning on exactly the virtual interface used to bench-test this plugin.
  // baseDir is a seam for the tests; nothing in the plugin passes it.
  readTxQueueLen (baseDir = '/sys/class/net') {
    if (!/^[\w.-]+$/.test(this.canInterface || '')) { return null }
    try {
      const n = parseInt(fs.readFileSync(`${baseDir}/${this.canInterface}/tx_queue_len`, 'utf8').trim(), 10)
      return (Number.isFinite(n) && n > 0) ? n : null
    } catch (e) { return null }
  }

  // Re-read periodically rather than caching the start() value: the whole point is to be
  // told to raise the queue, and someone who does must see the warning clear without
  // restarting the plugin. Cheap enough at this interval that the status callers can just
  // ask. Returns null when unknown -- callers must not treat that as "too short".
  txQueueLen () {
    const now = Date.now()
    if (this.txqAt === undefined || (now - this.txqAt) > 10000) {
      this.txq = this.readTxQueueLen()
      this.txqAt = now
    }
    return this.txq
  }

  txQueueTooShort () {
    const n = this.txQueueLen()
    return n !== null && n < TX_QUEUE_MIN
  }

  // ---- lifecycle ----
  start () {
    if (this.txQueueTooShort()) {
      const msg = `${this.canInterface} txqueuelen is ${this.txQueueLen()}, too short for the ` +
        `${PRODUCT_INFO_FRAMES}-frame product info burst -- the MFD will list this AC without a ` +
        `name or serial and its commissioning wizard may not complete. Fix on the host: ` +
        `sudo ip link set ${this.canInterface} txqueuelen 128 (make it persistent where the ` +
        `interface is brought up).`
      if (this.app && typeof this.app.error === 'function') { this.app.error(msg) } else { this.debug(msg) }
    }
    const Canbus = requireCanboat().canbus
    const bus = new EventEmitter()
    this.canbus = new Canbus({
      canDevice: this.canInterface,
      app: bus,
      addressClaim: this.addressClaim,
      productInfo: this.productInfo,
      preferredAddress: this.preferredAddress,
      transmitPGNs: TX_PGNS
    })
    this.parser = createPgnStream(this.debug)

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

  // Value of a numeric path, but only while it is still being published. SignalK keeps a path's
  // last value in the model forever after its source stops, so a bare read cannot tell a live
  // leg from one abandoned half an hour ago. getSelfPath is a lodash get on the self model, so
  // asking for the path WITHOUT the trailing .value yields the node with its timestamp.
  selfPathNumFresh (path, maxAgeMs) {
    try {
      const n = this.app.getSelfPath(path)
      if (!n || !Number.isFinite(n.value)) { return null }
      const t = Date.parse(n.timestamp)
      return (Number.isFinite(t) && (Date.now() - t) <= maxAgeMs) ? n.value : null
    } catch (e) { return null }
  }

  // The active leg's destination, used to tell a re-origin from a waypoint advance. Normally the
  // merged value is the answer: the model is last-writer-wins and the plotter's 129284 publishes
  // it at 1 Hz. It reads null only when there genuinely is no leg -- or, transiently, when
  // another writer of the same path (the server's Course API) lands a cleared course while the
  // plotter is still publishing. Hence the fallback below, which is dead code in normal
  // operation. Returns {latitude, longitude} or null.
  nextPointPos (maxAgeMs) {
    // Null Island is a sentinel, not a waypoint: this plotter has been seen publishing
    // {latitude: 0, longitude: 0} while re-activating a route, and two such samples either side
    // of a bearing jump would compare equal and read as a re-origin on a leg with no real
    // destination at all.
    const at = (n) => {
      const p = n && n.value
      if (!p || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) { return null }
      if (p.latitude === 0 && p.longitude === 0) { return null }
      const t = Date.parse(n.timestamp)
      return (Number.isFinite(t) && (Date.now() - t) <= maxAgeMs) ? { pos: p, at: t } : null
    }
    try {
      const node = this.app.getSelfPath('navigation.courseGreatCircle.nextPoint.position')
      if (!node) { return null }
      const merged = at(node)
      if (merged) { return merged.pos }
      // Fall back to the freshest source that carries a fix -- NOT the first one enumerated.
      // Key order is model-insertion order, so a lagging writer can legitimately come first and
      // hand back a position half a second stale, which is exactly long enough to straddle a jump.
      let best = null
      for (const k of Object.keys(node.values || {})) {
        const c = at(node.values[k])
        if (c && (!best || c.at > best.at)) { best = c }
      }
      return best ? best.pos : null
    } catch (e) { return null }
  }

  // Metres between two {latitude, longitude} fixes. Equirectangular: sub-millimetre error at the
  // tens of metres this is ever compared against. The antimeridian is deliberately not wrapped,
  // so a re-origin sat exactly on +-180 reads as half a world and is called an advance -- the
  // guarded path, i.e. it fails safe.
  posDistM (a, b) {
    if (!a || !b) { return null }
    const la = a.latitude * Math.PI / 180
    const lb = b.latitude * Math.PI / 180
    const x = (b.longitude - a.longitude) * Math.PI / 180 * Math.cos((la + lb) / 2)
    return Math.sqrt(x * x + (lb - la) * (lb - la)) * 6371000
  }

  // True bearing from a to b, radians, or null if they coincide. Same equirectangular
  // approximation as posDistM: over the hundreds of metres between consecutive route waypoints the
  // error is orders of magnitude below the degree it is compared at. This is what lets a leg be
  // sized without waiting for the plotter to republish a bearing.
  //
  // It does NOT inherit posDistM's fail-safe behaviour at the antimeridian, though: an unwrapped
  // Δlon there makes the distance enormous (safe, reads as an advance) but turns the BEARING
  // through 180 deg, which can put a real turn under the limit. Irrelevant in the Kattegat and not
  // worth wrapping until this sails somewhere it matters, but do not assume it is covered.
  posBrgRad (a, b) {
    if (!a || !b) { return null }
    const la = a.latitude * Math.PI / 180
    const lb = b.latitude * Math.PI / 180
    const x = (b.longitude - a.longitude) * Math.PI / 180 * Math.cos((la + lb) / 2)
    const y = lb - la
    if (x === 0 && y === 0) { return null }
    return Math.atan2(x, y)
  }

  // Leg sampling feeds both auto-confirm features, so it runs when EITHER is enabled.
  legTrackingOn () { return this.autoAdvanceMaxDeg > 0 || this.autoConfirmRestart }

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

  // The V2 API reports a state that is NOT always one of the four modes: the spec has a provider
  // return `off-line` when it cannot reach the pilot (@signalk/server-api autopilotapi.d.ts, on
  // getState). Anything outside AP_MODES is "no usable state", never a mode -- so it can neither
  // count as engaged nor be copied into commandedMode. Reported by a user whose SeaTalk1 bridge
  // drops out: `off-line` is not `standby`, so a bare !== 'standby' test let course nudges through
  // to a pilot the provider had just declared unreachable.
  normalizeMode (st) { return AP_MODES.indexOf(st) !== -1 ? st : null }

  engaged () {
    if (!this.skFresh() || this.noProvider) { return false }
    const m = this.normalizeMode(this.state.skApState)
    return m !== null && m !== 'standby'
  }

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
      if (!err && st && this.normalizeMode(st) !== null) {
        this.state.skApState = st
        this.state.lastSkStateMs = Date.now()
        this.pollWarned = false
        this.pollFails = 0          // a readable state -- recovery is immediate, see currentMode
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
        // Compare and copy the NORMALIZED state: `off-line` is not a mode, and assigning it would
        // both put a non-mode in commandedMode and make this branch fire on every poll forever,
        // since the copy could never equal a real mode.
        const norm = this.normalizeMode(st)
        if (this.bridge === 'live' && !this.navPending && norm !== null &&
            (Date.now() - this.commandedAt > 5000) && norm !== this.commandedMode) {
          this.debug(`SK state ${norm} != commanded ${this.commandedMode} -- correcting firehose`)
          this.commandedMode = norm
        }
      } else {
        // 401 without a token, a 500 when the provider is gone, a 200 whose body carries no
        // state -- and `off-line`, which is the very case normalizeMode exists for. All of them
        // are "no readable mode", and all must count towards the downgrade: resetting the counter
        // on an off-line provider would leave the firehose claiming an engagement that provider
        // has just said it cannot deliver. The firehose still follows button presses, so this is
        // non-fatal -- log once, not every 2 s. Provider presence is tracked separately.
        this.pollFails++
        if (!this.pollWarned) {
          this.debug('AP state poll unusable (' + (err ? (err.message || err) : ('state=' + st)) +
                     ') -- firehose follows button presses only')
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
    const optimistic = this.commandedMode || 'standby'
    // off and dry-run stay purely optimistic: nothing is being steered, and dry-run has to work
    // without a token at all.
    if (this.bridge !== 'live' || optimistic === 'standby') { return optimistic }
    // Live, and we cannot verify the engagement: no provider, or a state poll that has been
    // unreadable for the whole freshness window AND has failed repeatedly (the hysteresis).
    // Claiming "engaged" here is the more dangerous lie -- the firehose would keep broadcasting
    // an engaged 65305 and a heading-to-steer while nothing is steering, and it has no
    // "don't know" mode to fall back on, so standby is the only honest signal available.
    if (this.pollFails >= DOWNGRADE_AFTER_POLLS && (this.noProvider || !this.skFresh())) {
      return 'standby'
    }
    return optimistic
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
      const w = ((this.currentMode() === 'wind') ? 0x0400 : 0x0010) | 0x0080
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
    if (this.currentMode() === 'wind') {
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
    if (this.currentMode() === 'route') {
      this.send(7, 65341, '41,9f,ff,ff,0a,ff,00,00')
      return
    }
    const h = this.headingRad()
    if (this.currentMode() !== 'standby' && h !== null) {
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
    this.send(6, 65420, '41,9f,ff,ff,ff,ff,f1,ff')
    this.send(7, 130860, '41,9f,ff,ff,ff,ff,7f,ff,ff,ff,7f,ff,ff,ff,ff,ff,ff,ff,7f,ff,ff,ff,7f')
    this.send(6, 128275, 'ff,ff,ff,ff,ff,ff,ff,ff,ff,ff,ff,ff,ff,ff')
  }

  firehose2Hz () {
    // Not firehose output, and not gated with it: the auto-confirm that arms this fires from
    // onPilotMode, which runs whether or not we broadcast. This is only the 2 Hz clock it borrows.
    this.retryAdvance()
    if (!this.enableFirehose || !this.bootDone) { return }
    this.sampleTrackBrg()
    this.reconcileNavPending()
    this.completeAuthorisedEngage()
    this.send65305()
    this.send65341()
  }

  // Finish an engage the skipper already authorised on the MFD. Deliberately narrow: armed only
  // by confirmNav, fires at most once, only while still in route, only on a fresh 0x0180, and
  // only inside ENGAGE_FOLLOWUP_MS. This is not the auto-confirm machinery -- consent exists.
  completeAuthorisedEngage () {
    if (!this.engageAuthedAt) { return }
    if (this.bridge !== 'live' || this.commandedMode !== 'route') { this.engageAuthedAt = 0; return }
    if ((Date.now() - this.engageAuthedAt) > ENGAGE_FOLLOWUP_MS) {
      this.engageAuthedAt = 0
      this.state.lastMappedEvent = 'Engage authorised but the pilot never reached track -> use the control head'
      this.debug('authorised engage timed out waiting for the pilot to reach track')
      return
    }
    const evFresh = this.evPilotMode !== null && (Date.now() - this.evPilotAt) < 5000
    if (!evFresh) { return }
    if (this.evPilotMode === 0x0181) { this.engageAuthedAt = 0; return }   // got there on its own
    if (this.evPilotMode !== 0x0180) { return }                            // not in track yet
    // 65379 is broadcast at 1 Hz and the pilot promotes itself 0x0180 -> 0x0181 in well under one
    // period, so a mode word that PREDATES our PUT says nothing about where the pilot is now.
    // Acting on a cached 0x0180 would assert track-cog at a pilot already steering -- which is
    // the one way this could advance a waypoint instead of completing an engage.
    if ((this.evPilotAt - this.engageAuthedAt) < PILOT_PROOF_MS) { return }
    const prevMode = this.commandedMode
    const seq = ++this.cmdSeq
    this.engageAuthedAt = 0
    this.state.lastMappedEvent = 'Engage confirmed on the MFD -> track-cog'
    this.debug('pilot reached track after an authorised confirm -- asserting track-cog')
    this.applyV2('complete authorised engage (V1 advanceWaypoint)',
                 (cb) => this.sk.advanceWaypoint(cb),
                 (why) => {
                   if (seq !== this.cmdSeq) { return }
                   this.commandedMode = prevMode
                   this.state.lastMappedEvent = `Engage refused (${why}) -> display back to ${this.currentMode()}`
                   this.debug(`authorised engage refused: ${why}`)
                 })
  }

  // Angular difference between two bearings (rad), folded to 0..180, returned in degrees.
  angDiffDeg (aRad, bRad) {
    let d = Math.abs(aRad - bRad) % (2 * Math.PI)
    if (d > Math.PI) { d = 2 * Math.PI - d }
    return d * 180 / Math.PI
  }

  // Track the active leg's course (navigation.courseGreatCircle.bearingTrackTrue, decoded by
  // the server from the plotter's 129284/129285) so a waypoint advance -- which jumps the
  // bearing to the next leg at the same instant the pilot goes Track-pending -- can be sized
  // as the leg-to-leg change, and so a leg RE-ORIGIN (the MFD's Restart), which jumps the same
  // bearing without changing the destination, can be told from it. Sampled at 2 Hz (and again at
  // the pending moment). On the jump, record the turn size, which of the two it was, how long the
  // OLD leg had been held, and when. On a bearing that has gone stale or absent (route
  // deactivated / GPS gap) drop the leg state so a later bearing can never be sized against a
  // value from a different route.
  sampleTrackBrg () {
    if (!this.legTrackingOn()) { return }
    const b = this.selfPathNumFresh('navigation.courseGreatCircle.bearingTrackTrue', LEG_MAX_AGE_MS)
    const wp = this.nextPointPos(LEG_MAX_AGE_MS)
    const now = Date.now()
    if (b === null) {
      this.legBrg = null; this.legWp = null; this.legSince = 0; this.legSettledUsed = false
      this.lastTurnDeg = null; this.lastTurnKind = null
      return
    }
    if (this.legBrg === null) {
      this.legBrg = b; this.legWp = wp; this.legSince = now; this.legSettledUsed = false
      return
    }
    const jump = this.angDiffDeg(b, this.legBrg)
    const moved = this.posDistM(wp, this.legWp)
    // The destination moving IS the advance, whatever the course does. Autorouting scatters
    // waypoints at even spacing along straight stretches -- Navionics and Orca both do it -- and
    // advancing through those carries no course change at all: five destinations in six minutes
    // with the bearing pinned at 150.0 deg, measured under way 2026-08-03. Sizing an advance by its turn therefore
    // refuses precisely the legs that need no judgement, and every one of those refusals cost a
    // press at the control head. Tested before the bearing branch so a collinear advance can
    // never be read as a re-origin, and both baselines move together so the lockstep invariant
    // documented below still holds.
    if (moved !== null && moved > RESTART_SAME_WP_TOL_M) {
      // Size it from BOTH the bearing and the geometry, and keep the larger. Neither is
      // trustworthy alone. `jump` reads zero whenever the plotter publishes the new destination
      // a sample before the new bearing, which the measurement below records as the majority
      // case (56 % older, 44 % equal, never newer) -- believing it would auto-confirm a 40 deg
      // turn as "0 deg" and walk straight through autoAdvanceMaxDeg. The geometry is exact when
      // the route steps sequentially (22 of 34 legs matched the settled bearing to within 0.1 deg
      // on 2026-08-03) but overstates the turn in a burst of destination changes, where the
      // previous destination is not the new leg's origin. Taking the maximum means a real turn
      // can never hide behind a stale bearing, and a geometry that is wrong is wrong toward a
      // manual confirm. Measured over that day's 57 destination changes: 41 auto, 16 asked, and
      // every one of the 16 fell inside a burst.
      const geoBrg = this.posBrgRad(this.legWp, wp)
      const geoTurn = (geoBrg === null) ? null : this.angDiffDeg(geoBrg, this.legBrg)
      this.lastTurnKind = 'advance'
      this.lastTurnDeg = (geoTurn === null) ? jump : Math.max(jump, geoTurn)
      // Kept apart for the record: which of the two sized this advance, and by how far they
      // disagreed, is the whole question if one of these ever has to be re-tuned.
      this.lastTurnJumpDeg = jump
      this.lastTurnGeoDeg = geoTurn
      this.lastTurnMovedM = moved
      this.lastTurnOldHeldMs = now - this.legSince
      this.lastTurnAt = now
      this.legBrg = b
      this.legWp = wp
      this.legSince = now
      this.legSettledUsed = false
      this.legAdvancedAt = now
      this.legGeoBrg = geoBrg          // what the bearing should become, to recognise it arriving
      return
    }
    // The bearing arriving a sample after the destination it belongs to looks exactly like a
    // re-origin from here: destination unchanged, bearing jumped. It is not one, and calling it
    // one is the failure that got an earlier version reverted under way -- the advance had
    // already been taken, and the phantom re-origin that followed reported a turn nobody made.
    // Adopt the bearing silently instead. The measurement above already sized this leg from the
    // geometry, so nothing is lost.
    //
    // Only the bearing the geometry PREDICTED is swallowed, not any bearing that happens to arrive
    // in the window. Swallowing on timing alone would let a re-origin pressed a second after an
    // advance be answered by that advance's measurement -- a 120 deg swing confirmed as "0 deg",
    // which is the involuntary gybe RESTART_MAX_DEG exists to prevent.
    if (jump > 1 && moved !== null && (now - this.legAdvancedAt) < BRG_CATCHUP_MS &&
        this.legGeoBrg !== null && this.angDiffDeg(b, this.legGeoBrg) <= BRG_CATCHUP_TOL_DEG) {
      this.legBrg = b
      return
    }
    if (jump > 1) {                              // course moved, destination did not -> re-origin
      // Getting here means the destination is either unchanged (the MFD's Restart re-origining
      // the leg on the boat) or unknown. Unknown is still called an advance, so the guarded path
      // stays the default whenever the classification is not solid.
      this.lastTurnKind = (moved !== null) ? 'restart' : 'advance'
      this.lastTurnDeg = jump
      // No destination moved, so there is no geometry to size this against: clear the pair rather
      // than let a reader pick up the previous advance's numbers alongside this turn.
      this.lastTurnJumpDeg = jump
      this.lastTurnGeoDeg = null
      this.lastTurnMovedM = moved
      this.lastTurnOldHeldMs = now - this.legSince
      this.lastTurnAt = now
      this.legBrg = b
      // legWp still moves only alongside legBrg, in this branch and in the advance one above, so
      // the comparison is always "destination now vs destination when this leg was baselined".
      // Re-baselining it on every sample instead would let an advance whose bearing settles across
      // two frames compare the new waypoint against itself and read as a re-origin, handing a real
      // advance the restart path's gates. That failure is now caught twice over: the advance branch
      // claims such a leg on the destination alone, and the catch-up branch above absorbs the
      // bearing when it follows.
      this.legWp = wp
      this.legSince = now
      this.legSettledUsed = false
    }
    // A sub-degree branch that claimed a near-collinear advance from the destination alone lived
    // here for one afternoon and was reverted the same day, under way. It re-baselined legWp onto
    // the new waypoint while legBrg still held the OLD bearing, because the plotter published the
    // new destination one sample BEFORE the new bearing (measured 11:15:23Z vs 11:15:24Z). The next
    // sample's real 4 deg jump then compared the new waypoint against itself, read 'restart', and
    // the re-origin gates refused it -- turning a routine advance into a manual confirm at the
    // control head. The lockstep invariant above is what prevents that, and nothing may adopt a new
    // destination without the bearing that belongs to it.
    //
    // A SECOND attempt (2026-08-02) tracked the leg's identity on separate state so the baseline
    // here stayed untouched, and gated it on the two samples' own timestamps. Reviewed against
    // 36 h of recorded model data and dropped without ever being deployed. Both attempts tried to
    // INFER a collinear advance from the bearing; the branch above instead reads the destination
    // directly and does not care what the bearing did, which is why it needs none of the
    // machinery below. Keep the findings anyway -- they still describe this data:
    //
    //   * bearingTrackTrue and nextPoint.position are fields 9 and 13/14 of the SAME PGN (129284).
    //     They are written by one delta and normally share a timestamp, so ordering them by
    //     timestamp proves nothing: over 133 destination changes the bearing was NEVER the newer
    //     of the two -- 44 % equal, 56 % older. A bearing that was republished without being
    //     recomputed carries a fresh stamp and an old value, which is the exact case such a gate
    //     is supposed to catch. Two changes had equal stamps with a stale bearing (real turns of
    //     2.24 and 1.54 deg measured as zero).
    //   * A size limit computed from the BEARING on a collinear branch is decorative: a bearing
    //     within 1 deg of legBrg can only ever yield a sub-degree answer, which is not a
    //     measurement of the turn. This is why the branch above sizes from the geometry instead,
    //     and keeps whichever of the two reads larger.
    //   * The collinear case looked rare in the 2026-08-01 data: 1 qualifying advance in 3.7 h.
    //     That was a beat, where almost every leg turns. It does not generalise. On an autorouted
    //     passage the next day, 6 of 9 refusals in nine minutes were collinear. How common this is
    //     is a property of the route, not of the boat, so do not re-derive it from one trip.
    //
    // On reading the recorded decisions: lastTurnDeg is only cleared when a pending consumes it,
    // so 'deg === null' means "nobody has measured anything since the last pending", not "the
    // bearing recorded nothing" -- a value 422 s old was observed still latched. The matching
    // turnAgeMs is what tells the two apart.
  }

  // Fired when the EV enters Track-pending (0x0180) at a waypoint (not a fresh nav engage).
  // Auto-confirm only when the just-measured leg-to-leg turn is trustworthy AND within the
  // limit; anything uncertain is left for a manual confirm (the safe direction).
  maybeAutoAdvance () {
    // A new pending episode invalidates any older resend, the same invariant the turn-measurement
    // consumption below expresses: only THIS episode's own decision may arm one. Belt to the
    // edge-driven teardown's braces -- either alone would do, and this is not a place to be thrifty.
    this.advanceRetryUntil = 0
    // Sample now too, in case the bearing jump landed between 2 Hz ticks, so the size is
    // coupled to this pending moment rather than a stale sample.
    this.sampleTrackBrg()
    const now = Date.now()
    const deg = this.lastTurnDeg
    const kind = this.lastTurnKind
    // A turn measurement sizes AT MOST one pending: consume it so a later pending can never
    // reuse this delta (the rapid-waypoint / route-reactivation stale-reuse races).
    this.lastTurnDeg = null
    this.lastTurnKind = null
    // The two halves of the size go with it. Leaving them behind would report the previous
    // episode's numbers beside a turnDeg of null, which is the exact latching this file already
    // warns about once -- and this is the log that gets read after the trip.
    const jumpDeg = this.lastTurnJumpDeg
    const geoDeg = this.lastTurnGeoDeg
    const movedM = this.lastTurnMovedM
    this.lastTurnJumpDeg = null
    this.lastTurnGeoDeg = null
    this.lastTurnMovedM = null
    // Snapshot of what this decision is being taken ON, recorded here because the measurement is
    // consumed two lines up: exposing the live fields instead means a reader always finds them
    // already cleared, which is exactly what the first attempt at this got wrong. Every branch
    // below reports through decide(), so the inputs and the outcome are written together and
    // cannot drift apart -- lastMappedEvent alone is later overwritten by unrelated button
    // traffic, which is why the outcome is duplicated in here rather than paired up by a reader.
    const snap = {
      at: new Date().toISOString(),
      turnDeg: deg,
      turnKind: kind,
      // Ages relative to THIS decision. lastTurnAt is never cleared, so these are meaningful
      // only alongside turnDeg -- when that is null they describe a measurement already spent.
      turnJumpDeg: jumpDeg,
      turnGeoDeg: geoDeg,
      turnMovedM: (movedM === null || movedM === undefined) ? null : Math.round(movedM),
      turnAgeMs: this.lastTurnAt ? (now - this.lastTurnAt) : null,
      oldHeldMs: this.lastTurnAt ? this.lastTurnOldHeldMs : null,
      legHeldMs: this.legSince ? (now - this.legSince) : null,
      maxDeg: this.autoAdvanceMaxDeg,
      restartOn: this.autoConfirmRestart,
      outcome: null
    }
    this.state.lastDecision = snap
    const decide = (event) => { snap.outcome = event; this.state.lastMappedEvent = event }
    // A leg re-origin (the MFD's Restart) steers straight at the waypoint the pilot was already
    // bound for, so the advance path's SIZE limit does not apply -- that one guards the
    // unattended advance, and a re-origin is answered under RESTART_MAX_DEG instead. Every other
    // gate still applies (see inside). With the feature off this falls through to the advance
    // path untouched, so enabling nothing changes nothing: a re-origin small enough for
    // autoAdvanceMaxDeg is auto-confirmed exactly as it was before this branch existed.
    if (kind === 'restart' && this.autoConfirmRestart) {
      // The held-duration gate DOES apply here, unlike the size limit. It is what says the
      // pre-jump leg was settled rather than a transient mid-burst value, and the destination
      // comparison is only as good as the leg it compares against. A real Restart costs nothing:
      // the leg it re-origins has been held since the route was activated.
      if ((now - this.lastTurnAt) > RESTART_PENDING_MS || this.lastTurnOldHeldMs < 5000) {
        decide('Track restart, re-origin not trustworthy -> manual confirm needed')
        this.debug('restart: no settled recent re-origin to act on -- manual confirm')
        return
      }
      if (deg > RESTART_MAX_DEG) {
        decide(`Track restart ${Math.ceil(deg)}deg > ${RESTART_MAX_DEG}deg -> manual confirm needed`)
        this.debug(`restart re-origin ${deg.toFixed(1)}deg exceeds ${RESTART_MAX_DEG}deg -- manual confirm`)
        return
      }
      decide(`Track restart ${deg.toFixed(0)}deg (same waypoint) -> engage track`)
      this.debug(`restart re-origin ${deg.toFixed(1)}deg, destination unchanged -- auto-confirming`)
      const rdesc = `restart re-origin ${deg.toFixed(1)}deg (V1 advanceWaypoint)`
      this.applyV2(rdesc, (cb) => this.sk.advanceWaypoint(cb))
      this.armAdvanceRetry(rdesc)
      return
    }
    if (this.autoAdvanceMaxDeg <= 0) {
      decide('Advance pending -> manual confirm needed (auto-advance off)')
      return
    }
    // Require a leg change coincident with this pending (<=3 s), which is what binds the
    // measurement to THIS episode rather than a stale one from an earlier route.
    //
    // A second gate used to demand that the leg being left had stood for 5 s, on the reasoning
    // that a short-lived leg cannot be trusted to size a turn. That was written when the turn WAS
    // the signal. Now that the destination is, short legs are the ordinary case and not the
    // suspicious one: a route with waypoints 200 m apart produces them continuously, and the gate
    // refused an advance 3 s after the previous one on 2026-08-03 for no reason beyond its own
    // arithmetic. The re-origin path above keeps its copy of this gate, where the reasoning still
    // applies -- there the destination is unchanged, so a settled leg is the only evidence there is.
    if (deg === null || (now - this.lastTurnAt) > 3000) {
      // No recent leg change to size -- which is not the same as not knowing the answer. If the
      // leg has held the SAME destination and the SAME bearing for long enough that a late
      // bearing would have landed, then the turn being asked about is zero: the pilot is asking
      // permission to carry on exactly as it already is, and there is nothing to judge.
      //
      // Seen 2026-08-03: the EV dropped back into Track-pending three seconds after engaging nav,
      // on a leg that had stood 20 s unchanged, and the only measurement around was the 20 s old
      // route change -- correctly rejected as stale, correctly refusing to answer for a pending it
      // had nothing to do with. The result was a control-head press to continue straight ahead.
      // This is also the shape of the nine pendings-with-no-destination-change recorded on
      // 2026-08-02 that were never explained.
      // Three things have to be true, and "the leg looks unchanged" is the weakest of them.
      //
      // The turn is MEASURED, from the boat's own course to the leg's bearing, not inferred from
      // the leg having sat still. That distinction is the whole safety of this branch: a Restart
      // pressed while off track re-origins the leg onto the boat and swings hard, but the
      // destination does not move, so no geometry exists to catch a bearing that has not been
      // republished yet. The leg would read "unchanged for 20 s" while a 120 deg swing was
      // already under way. What the pilot is about to do is turn from where the boat is pointing
      // onto the leg, so that is the angle to hold against the limit.
      //
      // The destination is re-read LIVE rather than trusted from legWp, which survives a model
      // that has just published Null Island or had the path taken over by the Course API.
      //
      // And it fires once per leg. The other paths are self-limiting because they consume their
      // measurement; this condition is standing and would otherwise re-answer every pending edge
      // on the same leg, unattended, with no upper bound.
      // COG is only a course while the boat is actually making way. Below a knot it is noise, and
      // the dangerous form of that noise is the sticky one: a receiver holding its last good value
      // while the bow has already swung off. Then swing reads zero on a boat pointing elsewhere.
      const cog = this.selfPathNumFresh('navigation.courseOverGroundTrue', LEG_MAX_AGE_MS)
      const sog = this.selfPathNumFresh('navigation.speedOverGround', LEG_MAX_AGE_MS)
      const liveWp = this.nextPointPos(LEG_MAX_AGE_MS)
      if (this.legWp && this.legBrg !== null && this.legSince && !this.legSettledUsed &&
          (now - this.legSince) >= LEG_SETTLED_MS &&
          liveWp && this.posDistM(liveWp, this.legWp) <= RESTART_SAME_WP_TOL_M &&
          cog !== null && sog !== null && sog >= COG_MIN_SOG_MS) {
        const swing = this.angDiffDeg(cog, this.legBrg)
        if (swing <= this.autoAdvanceMaxDeg) {
          this.legSettledUsed = true
          decide(`Unchanged leg, ${swing.toFixed(0)}deg off the leg <= ${this.autoAdvanceMaxDeg}deg -> engage track`)
          this.debug(`auto-advance: leg unchanged, boat ${swing.toFixed(1)}deg off it -- auto-confirming`)
          const sdesc = `unchanged leg ${swing.toFixed(1)}deg (V1 advanceWaypoint)`
          this.applyV2(sdesc, (cb) => this.sk.advanceWaypoint(cb))
          this.armAdvanceRetry(sdesc)
          return
        }
        decide(`Unchanged leg but ${Math.ceil(swing)}deg off it > ${this.autoAdvanceMaxDeg}deg -> manual confirm needed`)
        this.debug(`auto-advance: leg unchanged but boat ${swing.toFixed(1)}deg off it -- manual confirm`)
        return
      }
      if (this.legSettledUsed) {
        decide('Advance pending, unchanged leg already answered once -> manual confirm needed')
        this.debug('auto-advance: this leg has had its unattended answer -- manual confirm')
        return
      }
      decide('Advance pending, turn not sizeable -> manual confirm needed')
      this.debug('auto-advance: no trustworthy recent leg change to size the turn -- manual confirm')
      return
    }
    if (deg <= this.autoAdvanceMaxDeg) {
      decide(`Auto-advance ${deg.toFixed(0)}deg <= ${this.autoAdvanceMaxDeg}deg -> engage track`)
      const adesc = `auto-advance ${deg.toFixed(1)}deg (V1 advanceWaypoint)`
      this.applyV2(adesc, (cb) => this.sk.advanceWaypoint(cb))
      this.armAdvanceRetry(adesc)
    } else {
      decide(`Advance ${Math.ceil(deg)}deg > ${this.autoAdvanceMaxDeg}deg -> manual confirm needed`)
      this.debug(`auto-advance: turn ${deg.toFixed(1)}deg exceeds ${this.autoAdvanceMaxDeg}deg -- manual confirm`)
    }
  }

  // Resolve the nav-confirm pending window against the EV-200's real state (sniffed 65379),
  // which SK cannot give us -- the V2 API maps both Track-pending (0x0180) and Track-engaged
  // (0x0181) to 'route'. Runs at 2 Hz from the firehose.
  reconcileNavPending () {
    if (!this.navPending) { return }
    const evFresh = this.evPilotMode !== null && (Date.now() - this.evPilotAt) < 5000
    // navPending is a HUMAN dialog state, so the pilot's own mode must not silently answer it.
    // The pilot reaching 0x0181 used to clear it outright -- but it promotes itself there
    // unprompted and faster than the dialog can be read, which is what made the MFD merely
    // chirp instead of asking (2026-07-30). Latch on it only once the dialog has had time to be
    // seen; before that, hold it and let a human answer. Past the minimum this still covers the
    // case where the skipper confirms on the P70 instead of the MFD.
    if (evFresh && this.evPilotMode === 0x0181 &&
        (Date.now() - this.navPendingAt) > NAV_PENDING_MIN_MS) {
      this.navPending = false
      this.navClearedBy = 'pilot reached track-cog'
      this.commandedMode = 'route'
      this.commandedAt = Date.now()
      this.debug('pilot in track-cog past the minimum dialog time -- latching MFD nav display')
      return
    }
    // There is deliberately NO "the pilot left the flow" branch here. One existed, to drop the
    // dialog if the skipper bailed out on the P70 -- but the abandon case is already covered
    // where it actually belongs: any other mode key from the MFD cancels a pending nav outright
    // (see handleIncomingAP), and the timeout below catches the rest. As a pilot-state test it
    // was pure downside: Nav #1 commands nothing now, so the pilot legitimately sits in
    // standby/auto for the whole dialog, and the branch tore it down mid-decision. Dockside
    // 2026-07-30 it fired 4 s after arming, so the MFD's Yes arrived with nothing pending and was
    // ignored; only a second Nav press got through. Do not reintroduce it.
    // Anti-stuck fallback: no confirm and no pilot signal within the timeout.
    if ((Date.now() - this.navPendingAt) > NAV_PENDING_MS) {
      this.navPending = false
      this.navClearedBy = 'timeout'
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
  // 130845 has no raw tap (only 130850 and 65379 are reassembled), so read its two
  // fields by name -- but under BOTH canboat spellings. canboatjs renders field names
  // camelCase when useCamel is on, which is the default our parser gets, and Title Case
  // when it is off; 2.x only ever produced the latter. Reading just one spelling meant
  // the emulator silently never answered the MFD's dockside-config reads on a 3.x host,
  // leaving its commissioning wizard stuck on "commissioning required" while everything
  // else looked fine. Both are plain numbers here, so there is no enum text to track.
  static field (f, camel, titled) {
    return (f[camel] !== undefined) ? f[camel] : f[titled]
  }

  reply130845 (pgn) {
    const f = pgn.fields || {}
    if (this.myAddr() === undefined || ACEmulator.field(f, 'address', 'Address') !== this.myAddr()) { return }
    const key = ACEmulator.field(f, 'key', 'Key')
    const val = this.commission[key]
    if (val === undefined) {
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
  // The raw record captured for this very frame, or null. Guarded on source and
  // age so a parsed PGN can never be paired with an older device's record when a
  // reassembly was missed (a frame 0 lost mid-packet leaves the previous record
  // in place).
  rawForSrc (src) {
    const raw = this.state.lastApRaw
    if (!raw || raw.src !== src || raw.key == null) { return null }
    return (Date.now() - raw.at) < 1000 ? raw : null
  }

  isApGroup (f, raw) {
    if (raw) { return raw.group === 0x0a }
    return f.Event === 'Nav mode' || f.Event === 10
  }

  apKey (f, raw) {
    if (raw) { return raw.key }
    return (typeof f['Unused B'] === 'number') ? f['Unused B'] : undefined
  }

  // onFail(reason) fires whenever the command did NOT reach the pilot: transport error, non-2xx,
  // or live-without-token. Callers use it to undo the optimistic display, because otherwise a
  // refusal is invisible -- the outcome only ever reached lastV2Result, and the one thing that
  // could correct the display (the state poll) fails for largely the SAME reasons that stop the
  // PUT: no token, provider gone, server restarting. The display would then sit on "engaged"
  // while nothing steers. Not called in dry-run: there is nothing to undo.
  applyV2 (desc, fn, onFail) {
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
      if (onFail) { onFail('no token') }
      return
    }
    this.debug(`BRIDGE live -> ${desc}`)
    fn((err, code, bdy) => {
      const body = bdy || ''
      let res
      let failed = false
      if (err) {
        res = 'ERR ' + err.message
        failed = true
      } else if (code === 400 && body.includes('Did not receive change confirmation')) {
        // dockside verifyChange timeout: command IS applied but no confirmation
        // delta seen. Narrow to this exact string -- any other 4xx/5xx is real.
        res = '400 verifyChange-timeout (command likely APPLIED) ' + body.slice(0, 60)
      } else {
        res = code + ' ' + body.slice(0, 80)
        failed = !(code >= 200 && code < 300)
      }
      this.state.lastV2Result = res
      this.debug(`BRIDGE result ${res}`)
      // The verifyChange 400 above is deliberately NOT a failure: the pilot took the command,
      // only the confirmation delta went missing (dockside quirk).
      if (failed && onFail) { onFail(res) }
    })
  }

  handleIncomingAP (pgn) {
    const f = pgn.fields || {}
    this.state.ap130850Count++
    const raw = this.rawForSrc(pgn.src)
    // Log the record the decode will actually use, not whatever was captured last:
    // an unrelated device's frame in the log reads as if this press decoded from it.
    this.debug(`RX 130850 src ${pgn.src} dst ${pgn.dst} ${JSON.stringify(f)} ` +
               `raw ${raw ? raw.hex : '(none)'}`)
    if (this.bridge === 'off') { return }
    if (!this.isApGroup(f, raw)) { this.state.lastMappedEvent = 'non-AP-group (ignored)'; return }
    const key = this.apKey(f, raw)
    if (key === undefined) { this.state.lastMappedEvent = 'group 0x0a, no key'; return }
    // Our own emulated commissioning head puts real AP-group commands on the bus --
    // a standby every 2 s (control-head.js) to hold the MFD's commissioning gate
    // open. onParsedPgn only filters out the AC's own address, so without this those
    // would decode as genuine presses and drop the pilot to standby every other
    // second for as long as commissioning mode is enabled. Named rather than silent: during
    // commissioning it is useful to see the head's own traffic being recognised.
    if (this.isOwnSrc(pgn.src)) {
      this.state.lastMappedEvent = 'own-src ' + (KEY_NAME[key] || ('key 0x' + key.toString(16))) + ' (ignored)'
      return
    }
    this.state.lastMappedEvent = (KEY_NAME[key] || ('key 0x' + key.toString(16))) + ' (' + key + ')'
    // Latch the MFD source only on a genuine actionable command -- not the 0x2b bus
    // mode-change announce (a broadcast that can originate from a differently-named
    // Navico function address) -- so the resolved name tracks the address that
    // actually drives the pilot. Our own addresses are already gone by here.
    if ((key in KEY_STATE) || key === TACK_KEY || key === CHANGE_COURSE) {
      this.mfdSrc = pgn.src
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
            // A second Nav press also confirms (the MFD's own Yes is CONFIRM_KEY 0x10).
            this.confirmNav('2nd Nav 0x0a')
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
          // Nav #1 ARMS the MFD's confirm dialog and sends the pilot nothing at all.
          //
          // It used to PUT route here. That writes 0x0180 (TrackMode) -- and the pilot then
          // promotes itself to 0x0181 on its own, in under a second, at which point it steers
          // the leg. So one press really could put the boat into Track on any course change,
          // with the dialog torn down by the promotion before it could be read. Observed under
          // way 2026-07-30 with a very large course change.
          //
          // Arming is now purely local: the 65305 pending bit raises the dialog, and the pilot
          // is commanded only from confirmNav, i.e. only after a human answers.
          this.navPending = true
          this.navPendingAt = Date.now()
          this.commandedAt = Date.now()
          this.state.lastMappedEvent = 'Nav armed -> confirm on the MFD to engage (pilot untouched)'
          this.debug('Nav key 0x0a -> armed the MFD confirm dialog; nothing sent to the pilot yet')
        }
      } else {
        // Any other mode key cancels a pending nav and switches mode immediately.
        this.navPending = false
        this.engageAuthedAt = 0   // skipper chose another mode: the engage is off
        this.navClearedBy = 'mode key ' + st
        const prevMode = this.commandedMode
        const seq = ++this.cmdSeq
        this.commandedMode = st   // optimistic: drive the firehose display immediately
        this.commandedAt = Date.now()
        this.applyV2(`PUT /state {value:"${st}"}`, (cb) => this.sk.setState(st, cb), (why) => {
          // Refused: undo the optimism. The sequence check keeps a late failure from clobbering a
          // newer press -- HTTP timeouts are seconds long and the skipper may well have pressed
          // again by then. Prefer the pilot's real state if the poll is readable; otherwise fall
          // back to what was displayed before.
          if (seq !== this.cmdSeq) { return }
          const real = this.skFresh() ? this.normalizeMode(this.state.skApState) : null
          this.commandedMode = real || prevMode
          this.state.lastMappedEvent = `${st} refused (${why}) -> display back to ${this.currentMode()}`
          this.debug(`PUT ${st} refused: ${why} -- display rolled back to ${this.currentMode()}`)
        })
      }
    } else if (key === CONFIRM_KEY) {
      // MFD nav-confirm "Yes" (see CONFIRM_KEY). Engage only inside the confirm
      // window; outside it 0x10 is an ignored one-off.
      if (this.navPending) {
        if ((Date.now() - this.navPendingAt) < 400) {
          this.debug('Confirm 0x10 within 400ms of arming -- treated as duplicate, ignored')
        } else {
          this.confirmNav('MFD Yes 0x10')
        }
      } else {
        this.state.lastMappedEvent = 'Nav confirm 0x10 but nothing pending (ignored)'
        this.debug('Confirm key 0x10 (16) but navPending false -- ignored')
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
      // Same source- and age-guarded record the key came from: pairing the nudge
      // magnitude with an unrelated older frame would steer the wrong amount.
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
          //
          // The nudge reaches the EV-200 as a physical Seatalk +1/+10/-1/-10
          // keystroke (adjustTarget -> putAdjustHeading -> changeHeadingByKey). In
          // AUTO that keystroke turns the boat to starboard for '+', proven on the
          // water. In the EV's WIND VANE mode a native '+' instead turns the boat to
          // PORT -- on BOTH tacks. It reads as |AWA| up (bearing away) on starboard and
          // |AWA| down (luffing) on port, but it is the same bow-to-port turn either
          // way, so the constant is the turn DIRECTION, not the wind-angle sign. The
          // Vulcan '+' always means "nudge to starboard", so invert throughout wind
          // mode, regardless of tack -- no AWA/tack read needed.
          //
          // History: a dockside test proved the flip on starboard and we shipped a
          // starboard-only flip. But starboard alone cannot distinguish "flip starboard"
          // from "flip both" -- both flip starboard identically; only port tack
          // discriminates, and it needs the water. Sailing showed starboard correct and
          // port still inverted, which pins it to flip-both.
          let effSign = sign
          if (this.state.skApState === 'wind') { effSign = -sign }
          const degN = effSign * Math.round(degMag)
          const delta = (degN + 0.5) * Math.PI / 180
          const flipped = effSign !== sign ? ', wind-inverted' : ''
          this.applyV2(`PUT /target/adjust {value:${delta.toFixed(4)}} (-> ${degN}deg${flipped})`,
                       (cb) => this.sk.adjustTarget(delta, cb))
        }
      } else {
        this.state.lastMappedEvent = 'ChangeCourse: unrecognized bytes ' + (raw ? raw.hex : '(none)')
        this.debug(`CHANGECOURSE unrecognized ${raw ? raw.hex : '(none)'}`)
      }
    }
  }

  // Shared nav-confirm engage, fired by the MFD confirm key (0x10) or a second Nav
  // press (0x0a) while a route arm is pending. Sends the Track engage unless the pilot
  // is already engaged (0x0181), in which case just latch the display -- re-sending
  // advanceWaypoint against an engaged pilot would advance to the next waypoint.
  // The human answered the dialog: only now may the pilot be commanded. This is the ONLY place a
  // Nav press turns into Track, so a single press can never do it. `setState('route')` writes
  // 0x0180 and advanceWaypoint writes 0x0181 (canboat SeatalkPilotMode16) -- two sub-modes of the
  // same register, so this picks whichever the pilot is not already in rather than treating
  // either as an "answer".
  confirmNav (via) {
    // Tighter than the usual 5 s: this picks between asserting track-cog and PUTting route, and a
    // cached 0x0180 from a pilot that has since promoted itself would make the former an advance.
    const evFresh = this.evPilotMode !== null && (Date.now() - this.evPilotAt) < 1500
    const prevMode = this.commandedMode
    const pendingAt = this.navPendingAt
    const seq = ++this.cmdSeq
    // A refused engage must not leave the display latched on route with nothing steering. Put the
    // dialog back so the skipper can answer again -- keeping the ORIGINAL navPendingAt, so the
    // anti-stuck timeout still expires on schedule and a refusal loop cannot hold it open forever.
    const refused = (why) => {
      if (seq !== this.cmdSeq) { return }
      this.navPending = true
      this.navPendingAt = pendingAt
      this.navClearedBy = null
      this.engageAuthedAt = 0
      this.commandedMode = prevMode
      this.state.lastMappedEvent = `Nav confirm refused (${why}) -> back to pending`
      this.debug(`Nav confirm refused: ${why} -- dialog re-armed`)
    }
    this.navPending = false
    this.navClearedBy = 'confirm ' + via
    this.commandedMode = 'route'
    this.commandedAt = Date.now()
    if (evFresh && this.evPilotMode === 0x0181) {
      this.state.lastMappedEvent = `Nav confirm (${via}) -> pilot already in track-cog, latched`
    } else if (evFresh && this.evPilotMode === 0x0180) {
      this.state.lastMappedEvent = `Nav confirm (${via}) -> track-cog`
      this.applyV2('engage track (V1 advanceWaypoint)', (cb) => this.sk.advanceWaypoint(cb), refused)
    } else {
      // The pilot is not in track yet, so this only gets it there; completeAuthorisedEngage
      // finishes the job when it arrives.
      this.engageAuthedAt = Date.now()
      this.state.lastMappedEvent = `Nav confirm (${via}) -> PUT route`
      this.applyV2('PUT /state {value:"route"}', (cb) => this.sk.setState('route', cb), refused)
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
    // Both canboat spellings, as in reply130845: on a 3.x host the Title-Case-only
    // read left windDatumRad unset, silently degrading tack/gybe direction to the
    // fluctuating live AWA -- the exact jitter the cache exists to avoid.
    const v = pgn.fields && ACEmulator.field(pgn.fields, 'windDatum', 'Wind Datum')
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
    const prevMode = this.evPilotMode
    this.evPilotMode = b[2] | (b[3] << 8)
    this.evPilotAt = Date.now()
    // Tear the resend down on the EDGE, not on a tick that samples this latched value. The pilot
    // broadcasts at 1 Hz while the tick runs at 2 Hz, and Node drains timers before I/O: a stall
    // can queue "left pending" and "entered pending again, next waypoint" behind a tick that then
    // resends against a pending episode the skipper has never been shown. Leaving pending ends the
    // episode, full stop -- whatever comes next must arm on its own decision.
    if (this.evPilotMode !== 0x0180) { this.advanceRetryUntil = 0 }
    // subMode (bytes 4-5) is captured but not acted on. It is the one field left that could
    // carry a genuine "waiting for the skipper" flag -- signalk-autopilot already uses it as a
    // command channel for tack -- and the mode word alone demonstrably cannot tell an arrival
    // prompt from the pilot's own promotion. Log it before theorising about either again.
    this.evPilotSubMode = (b.length >= 6) ? (b[4] | (b[5] << 8)) : null
    this.evPilotHex = b.slice(0, Math.min(b.length, 8)).toString('hex')
    if (msg.pgn && typeof msg.pgn.src === 'number') { this.pilotSrc = msg.pgn.src }
    // NB: reconcileNavPending is deliberately NOT called from here. It was, briefly, to resolve
    // the pending window a poll sooner; measured worth was <=500 ms and it fixed nothing. The
    // dialog's lifetime is now governed by NAV_PENDING_MIN_MS instead, which is the real fix.
    // Waypoint-advance auto-confirm: the EV just entered Track-pending (0x0180) while we are
    // already in route and did NOT arm a nav-engage (navPending false) -- i.e. a waypoint
    // advance, not an initial Nav press. Edge-triggered (prevMode != 0x0180) so it fires once
    // per pending episode. Live mode only. maybeAutoAdvance() decides on the turn size.
    if (this.legTrackingOn() && this.bridge === 'live' &&
        this.evPilotMode === 0x0180 && prevMode !== 0x0180 &&
        this.commandedMode === 'route' && !this.navPending &&
        // An authorised engage is in flight: THIS 0x0180 is the pilot arriving on our own PUT,
        // not a waypoint advance. Without this both completeAuthorisedEngage and the advance
        // logic fire on the same edge, and two advanceWaypoints in a row skip a waypoint.
        !this.engageAuthedAt) {
      this.maybeAutoAdvance()
    }
  }

  // Resend an auto-confirm the pilot has not acted on. Runs off the 2 Hz tick, but deliberately
  // OUTSIDE the firehose gate: onPilotMode can auto-confirm with the firehose disabled, so the
  // resend has to be reachable wherever the first attempt was.
  //
  // Every guard is about one thing: never answer a question nobody is asking. The teardown that
  // matters is NOT here though -- it is edge-driven in onPilotMode, because this method samples a
  // latched 1 Hz value and a tick that reads it in the wrong order would miss the pilot leaving
  // pending entirely. What remains here is the standing proof: the pilot must still be in pending,
  // must have SAID so recently, and must have said it AFTER our last attempt. Without that last
  // clause the ~1 s blind spot between mode broadcasts is wide enough for the skipper to press
  // Standby at the head and have us put the pilot straight back into Track.
  retryAdvance () {
    if (!this.advanceRetryUntil) { return }
    const now = Date.now()
    // 1500 ms, not the 5000 used for read-only checks elsewhere: this one authorises a write.
    const evFresh = this.evPilotMode !== null && (now - this.evPilotAt) < 1500
    if (!evFresh || this.evPilotMode !== 0x0180 || this.bridge !== 'live' ||
        this.commandedMode !== 'route' || this.navPending || this.engageAuthedAt) {
      this.advanceRetryUntil = 0
      return
    }
    if (now > this.advanceRetryUntil) {
      this.advanceRetryUntil = 0
      this.state.lastMappedEvent = `${this.advanceRetryDesc} -- pilot never took it, confirm on the control head`
      this.debug(`auto-confirm not taken after ${ADVANCE_RETRY_WINDOW_MS} ms -- leaving it to the control head`)
      return
    }
    if (now < this.advanceRetryAt) { return }
    // The observation must postdate our own last command, or it says nothing about whether that
    // command landed -- the same rule completeAuthorisedEngage and the Nav re-confirm already use.
    if ((this.evPilotAt - this.advanceSentAt) < PILOT_PROOF_MS) { return }
    this.advanceRetryAt = now + ADVANCE_RETRY_GAP_MS
    this.advanceSentAt = now
    this.applyV2(`${this.advanceRetryDesc} (resend)`, (cb) => this.sk.advanceWaypoint(cb),
                 // A refusal is not "the pilot did not take it": a 400 "Autopilot not in track
                 // mode" means the server disagrees that it is in pending at all, which is exactly
                 // when to stop asking. Keep the real reason on the status page.
                 (why) => {
                   this.advanceRetryUntil = 0
                   this.state.lastMappedEvent = `${this.advanceRetryDesc} refused (${why}) -> confirm on the control head`
                 })
  }

  // Arm the resend. Called only where an auto-confirm has just been sent, so consent for THIS
  // engagement already exists and a resend adds no new decision -- it repeats one already made.
  armAdvanceRetry (desc) {
    const now = Date.now()
    this.advanceRetryUntil = now + ADVANCE_RETRY_WINDOW_MS
    this.advanceRetryAt = now + ADVANCE_RETRY_GAP_MS
    this.advanceSentAt = now
    this.advanceRetryDesc = desc
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
        at: Date.now(),
        src,
        group: p.length > 5 ? p[5] : null,
        key: p.length > 6 ? p[6] : null,
        val16: (p.length > 9) ? (p[8] | (p[9] << 8)) : null,
        hex: p.map((x) => x.toString(16).padStart(2, '0')).join(',')
      }
      this.state.lastApRaw = rec
      // Ring the AP group (0x0a) only. The bus streams other 130850 groups continuously,
      // which would rotate a button press out of a 16-slot ring within seconds and leave
      // it empty exactly when it is wanted. lastApRaw stays unfiltered -- the ChangeCourse
      // decode reads it for the byte-exact nudge direction and magnitude.
      if (rec.group === 0x0a) {
        this.state.apRawRing.push(rec)
        if (this.state.apRawRing.length > 16) { this.state.apRawRing.shift() }
      }
    } catch (e) {
      this.debug('onRawFrame error: ' + (e && e.message))
    }
  }

  onParsedPgn (pgn) {
    if (!pgn) { return }
    try {
      if (pgn.pgn === 130845 && pgn.fields) { this.reply130845(pgn); return }   // address checked there, under both field spellings
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
    // Only while the queue is actually too short; a healthy interface adds nothing, and
    // the value is re-read, so raising it clears this without a restart.
    const txq = this.txQueueTooShort()
      ? ` | ${this.canInterface} txqueuelen ${this.txQueueLen()} -- too short for product info, raise to 128` : ''
    // Device identities live in the schema description block (and the webapp), so keep the
    // status line to live operational state only -- no MFD/pilot names, which duplicated it.
    // Spell out a downgrade rather than just showing standby: the difference between "the pilot
    // disengaged" and "we cannot confirm it is engaged" is the whole point of the downgrade.
    const dm = this.currentMode()
    const dg = (dm !== (this.commandedMode || 'standby'))
      ? ` -> BROADCASTING ${dm} (engagement unverifiable -- pilot may still be steering)` : ''
    return `${this.acModel} @addr ${addr} | bridge ${this.bridge}${np}${txq} | ` +
           `mode ${this.commandedMode}${dg}${pend} | ` +
           `SK ${this.skFresh() ? (s.skApState || '?') : 'stale'} | ` +
           `cmds ${s.ap130850Count} | last ${s.lastMappedEvent || '-'}${wd}${ev}${v2}`
  }

  // Structured status for the status webapp (served read-only via the plugin router).
  statusJson () {
    const s = this.state
    const evFresh = this.evPilotMode !== null && (Date.now() - this.evPilotAt) < 5000
    // 0x0180 and 0x0181 are canboat SeatalkPilotMode16 TrackMode and
    // NoDriftCogReferencedInTrackCourseChanges: two co-equal Track SUB-MODES of one shared
    // register, NOT a question and its answer. They were called route-pending/route-engaged
    // here until 2026-07-30, and that wording cost a day: it reads as a handshake the bridge
    // takes part in, so every symptom got explained as a timing or retry problem. It is not a
    // handshake. `PUT /state route` writes 0x0180 and advanceWaypoint writes 0x0181 -- the very
    // values then sniffed back off the pilot's own broadcast and read as "its reply". The pilot
    // also promotes itself 0x0180 -> 0x0181 unprompted, in well under one broadcast period.
    const EV = { 0x0000: 'standby', 0x0040: 'auto', 0x0100: 'wind', 0x0180: 'track', 0x0181: 'track-cog' }
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
      commandedMode: this.commandedMode,
      // What the firehose is ACTUALLY broadcasting. Diverges from commandedMode when live and the
      // engagement cannot be verified -- without showing it, a display that drops to standby reads
      // as if the pilot disengaged itself.
      displayMode: this.currentMode(),
      displayDowngraded: this.currentMode() !== (this.commandedMode || 'standby'),
      navPending: this.navPending,         // MFD nav-confirm dialog armed
      autoAdvanceMaxDeg: this.autoAdvanceMaxDeg, // 0 = off, else auto-confirm turns <= this
      autoConfirmRestart: this.autoConfirmRestart,
      skState: this.skFresh() ? (s.skApState || null) : null,
      skStale: !this.skFresh(),
      evPilotMode: evFresh ? this.evPilotMode : null,
      evPilotState: evFresh ? (EV[this.evPilotMode] || ('0x' + this.evPilotMode.toString(16).padStart(4, '0'))) : null,
      navClearedBy: this.navClearedBy,
      evPilotSubMode: evFresh ? this.evPilotSubMode : null,
      evPilotHex: evFresh ? this.evPilotHex : null,
      windDatumDeg: wdFresh ? Math.round(this.windDatumRad * 180 / Math.PI) : null,
      // null when unknown or not applicable; txQueueTooShort is the flag to render on.
      txQueueLen: this.txQueueLen(),
      txQueueTooShort: this.txQueueTooShort(),
      cmdCount: s.ap130850Count,
      // Diagnostics for the auto-advance decision. lastEvent below is that decision's OUTPUT;
      // these are its INPUTS, so a refusal can be read back afterwards instead of reconstructed
      // from the model at 1 Hz and guessed at. Added 2026-08-02 because two rounds of work on
      // this decision were spent on a cause that turned out to account for one refusal in
      // sixteen, while nine of them had no destination change behind them at all and nothing
      // recorded why. Purely read-only: nothing in the decision path reads these back.
      //
      // The last auto-advance decision, inputs and outcome recorded together at the moment it was
      // taken (see maybeAutoAdvance). A poller cannot reconstruct this from live state: the turn
      // measurement is consumed by the decision itself, so anything read afterwards finds it
      // already cleared. Null until the pilot has raised a pending at least once.
      lastDecision: s.lastDecision || null,
      // Live leg state, which is a different question: what the bridge is tracking RIGHT NOW,
      // as opposed to what the last decision was taken on.
      legHeldMs: this.legSince ? (Date.now() - this.legSince) : null,
      legBrgDeg: this.legBrg === null ? null : Math.round(this.legBrg * 1800 / Math.PI) / 10,
      legWp: this.legWp || null,
      lastEvent: s.lastMappedEvent || null,
      lastV2Call: s.lastV2Call || null,    // what we last asked the V2 API for; pairs with lastV2Result
      lastV2Result: s.lastV2Result || null,
      lastRawHex: s.lastApRaw ? s.lastApRaw.hex : null,
      // The last 16 AP frames, byte-exact and newest last, for reconstructing a button
      // sequence after the fact -- lastRawHex only survives until the next press.
      apRawRing: s.apRawRing
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
