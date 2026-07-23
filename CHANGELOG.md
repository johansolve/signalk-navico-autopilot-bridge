# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.2-beta] - 2026-07-23

### Fixed
- **Wind-mode course nudge was inverted on port tack.** In the EV's wind-vane mode a
  native `+` keystroke turns the boat to port on **both** tacks (it reads as bearing away
  on starboard and luffing on port, but it is the same bow-to-port turn either way), so
  the Vulcan's `+` — which always means "nudge to starboard" — must be inverted throughout
  wind mode. The previous release inverted only on starboard tack, leaving port tack
  turning the wrong way. A dockside test could only ever exercise starboard, where both
  the old and the new logic behave identically; port tack needed the water to tell them
  apart. Both tacks confirmed on the water. The nudge branch no longer reads the wind
  angle at all.

## [0.7.1-beta] - 2026-07-22

### Added
- **The MFD's No Drift button now engages the pilot** instead of being logged and dropped.
  Key `0x0c` had been carried as a guess since the first capture; it was confirmed dockside
  2026-07-22 from the bridge's own diagnostic log, sent with the same key-press envelope and
  frame layout as Auto and Wind. It maps to plain **auto**: Raymarine's No Drift is a
  COG-referenced heading hold, but nothing in the SignalK chain can ask for it —
  `SeatalkPilotMode16` `0x0181` ("No Drift, COG referenced") is decoded to `route` by
  `@signalk/n2k-signalk`, and `signalk-autopilot` already uses that same `0x0181` as its
  waypoint advance, so firing No Drift would mean sending track-engage. The pilot holds a
  heading, it just does not compensate for drift. Verified dockside: both the MFD and the
  control head report Auto after the press, so button and display stay consistent.
- **`lastV2Call` and `apRawRing` in the status API.** The last autopilot request now sits
  next to its result, instead of the status showing an answer with no question; and the
  ring of recent autopilot-group frames — byte-exact, newest last — is exposed for
  reconstructing a button sequence after the fact, where `lastRawHex` only survives until
  the next frame. Both were already tracked internally and simply never surfaced. The ring
  is filtered to the autopilot group: the bus streams other 130850 groups continuously and
  would otherwise rotate a button press out within seconds.

### Changed
- **Stopped sending the `65340` and `65302` state frames.** Both per-mode tables came from
  htool's reverse engineering (the route rows were explicitly guesses) and a real NAC-3 emits
  neither PGN. A dockside test 2026-07-22 suppressed both: the MFD still bound and the mode
  label still tracked every state change, so the guesses were dropped rather than shipped.
  `TX_PGNS` still declares both, as a real AC does — only the transmission is gone.

### Removed
- **The `Route diagnostic log path` option.** It was a temporary passive capture added to
  solve waypoint advance, which it did (and it also confirmed the No Drift key above). It
  reached npm in 0.7.0-beta only because `npm publish` packages the working tree; it was never
  in the tagged source. Inert unless a path was set.
- **Three dead state counters** (`txCounts`, `commissionReads`, `missingKeys`). All three
  were written on every send, commissioning read or missing key and then never read by
  anything — not the status endpoint, not the webapp. The information that mattered is
  already covered elsewhere (`cmdCount` for traffic, a debug line for each missing key).

## [0.7.0-beta] - 2026-07-15

### Added
- **Automatic waypoint advance for small course changes (opt-in).** In Track mode the
  Raymarine pilot enters Track-pending at each waypoint and waits for a confirm (normally a
  control-head Yes). When the new option **Auto-confirm Track waypoint advance up to (degrees)**
  is set above 0, the bridge measures the course change to the next leg — from
  `navigation.courseGreatCircle.bearingTrackTrue`, the server's decode of the plotter's
  route data — and confirms the advance automatically when the turn is within the limit, so
  small turns need no control-head press. Larger turns are left for a manual confirm. Off by
  default (0); requires Bridge mode = live. The measurement is gated so an unmeasurable or
  stale turn always falls back to manual, and it never fires against an already-engaged pilot.
  Sea-trialled 2026-07-15: a 7° advance auto-confirmed (pilot engaged in ~70 ms, unnoticed);
  a 21° advance was correctly left for a manual confirm. This closes the last unproven item
  (multi-leg waypoint advance).

## [0.6.2-beta] - 2026-07-14

### Fixed
- **Regression: course nudges dead in both Auto and Wind, and every device shown offline**, after
  a host canboatjs upgrade. canboatjs' `Canbus.pipe()` switches the bus stream to Actisense **text**
  when the destination lacks a `.fromPgn` marker. The plugin's own parse stream had no such
  marker, so the bus emitted strings instead of frame objects; the PGN parser accepts both (so
  mode/tack/wind kept working) but the raw-frame tap expects an object and silently no-oped —
  which left the ChangeCourse magnitude undecoded (nudges rejected) and the device-liveness
  timestamps unset (every device drawn offline). The parse stream now exposes `.fromPgn`, exactly
  as canboatjs' own `fromPgnStream` does, keeping the bus in object mode.
- **Wind-mode course nudge turned the wrong way on starboard tack.** In the pilot's wind-vane
  mode the Seatalk +/- keystroke nudges the wind angle by magnitude (bear away), whose physical
  port/starboard sense depends on the tack, so a green `+` fell off to port on starboard tack
  instead of luffing to starboard. The nudge sign is now inverted on starboard tack so green `+`
  turns the boat to starboard on both tacks. Verified dockside on starboard tack; port tack still
  to be confirmed under way.
- **Nav/Track engage from Wind reverted to Wind on the MFD confirm.** The MFD's engage-nav dialog
  sends confirm key `0x10`, not a second Nav key as previously assumed; it was unhandled, so
  confirming did nothing and only a second Nav press engaged. The bridge now treats `0x10` as the
  confirm (inside the confirm window only), so a single **Nav → OK** on the MFD engages Track,
  including from Wind. Verified dockside.

## [0.6.1-beta] - 2026-07-13

### Fixed
- **Load failure on canboatjs 3.x.** The plugin required the peer dependency's internal
  `@canboat/canboatjs/lib/fromPgnStream` subpath, which canboatjs 3.x moved to `dist/` when
  it was rewritten in TypeScript. On a host server bundling canboatjs 3.x (e.g. the current
  Docker image) the plugin failed to start with `Cannot find module
  '@canboat/canboatjs/lib/fromPgnStream'`. It now builds the PGN parse stream on top of the
  public root export `FromPgn`, which both canboatjs 2.x and 3.x expose, so it is
  independent of the peer's internal file layout. Reported from a Docker install.

## [0.6.0-beta] - 2026-07-11

**Feature complete — promoted from alpha to beta.** Sea-trialled 2026-07-11: **Tack and
Gybe both performed exemplarily under way**, the last button manoeuvre left to prove. Auto,
±course, Wind, the abort/failsafe path and Nav/Track engage are all proven on the water too,
so every mode and manoeuvre the bridge drives has now been exercised on a real rig (B&G
Vulcan 7 → SignalK V2 → Raymarine EV-200); only multi-leg waypoint advance along a route
remains unproven. The changes below carry over from the unreleased 0.5.2-alpha.

### Added
- **Device liveness.** Every identified device now shows whether it is actually on the bus.
  Each received CAN frame stamps its source address (no extra traffic, no extra API calls);
  a device silent for more than 5 s is drawn with a hollow dot and an `offline` badge, on
  the status webapp and in the plugin-config device list. A Navico plotter claims several
  addresses and the one that sends the button presses (`130850`) is otherwise quiet for up
  to 60 s, so liveness pools **all** of the plotter's addresses — its iGPS/Navigator/Display
  functions chatter continuously. Measured worst-case inter-frame gap for a pooled device is
  ~1.5 s, hence the 5 s threshold.
- **AppStore dependencies.** `signalk.recommends` so the plugin page lists the V2 autopilot
  providers the bridge can be driven through. None is *required*: the bridge only asks
  `/signalk/v2/api/vessels/self/autopilots` and does not care which provider answers.
- **Device identification.** The status webapp and the plugin-config page now show the
  **real N2K devices** by name instead of generic roles — the MFD, the pilot's course
  computer, its actuator control unit, the control head, and the V2 autopilot provider
  instance — resolved from the server's source registry (PGN 60928 address claim +
  126996 product info) via a read-only loopback read. No extra bus traffic. On the config
  page each detected device is woven (as markdown) into the field it relates to — the bound
  MFD under the AC-model field, and the course computer / actuator / control head / provider
  as a list under the target-autopilot-id field (refreshed on page load); the webapp updates
  it live. Resolved names are sticky (a sparse registry read never blanks a known name) and
  exclude our own emulated AC and commissioning head.

### Fixed
- The MFD name no longer leaks a sub-function suffix (`B & G Vulcan 7 iGPS`): it is taken
  from the plotter's Display-class address when its command address has not latched yet, and
  `iGPS` / `Echo (This unit)` / `Pilot Controller` are stripped like `MFD` already was.
- Status webapp header showed the old plugin name; both the page title and heading now
  read **Autopilot — Navico bridge**, and the bundled screenshot is refreshed to match.

## [0.5.1-alpha] - 2026-07-05

### Changed
- Display name is now **Autopilot — Navico bridge** everywhere — both the AppStore
  listing (`signalk.displayName`) and the Plugin Config entry (`plugin.name`, the
  `(Simrad AC emulator)` suffix dropped) — so it sorts under Autopilot consistently.

## [0.5.0-alpha] - 2026-07-05

### Added
- **Nav/Track engage from the MFD's own confirm dialog — no separate P70 press.** Nav is
  a two-press flow: the first press arms the confirm window (pilot → Track-pending, the
  MFD raises its "engage nav?" dialog); the confirm (second press) fires the SignalK
  **V1 `steering.autopilot.actions.advanceWaypoint`** action, engaging Track-to-waypoint
  (`65379 → 0x0181`), byte-identical to the P70's Track confirm. Dockside-proven
  2026-07-05. Uses V1 advanceWaypoint deliberately — the V2 `courseNextPoint` action is
  unimplemented (`throw 'Not implemented!'`) in `@signalk/signalk-autopilot` 2.6.0.
- **Sniff the EV-200's own PGN `65379`** off the bus to distinguish Track-pending
  (`0x0180`) from Track-engaged (`0x0181`) — SignalK maps both to `route`, so this is the
  only way to latch the MFD confirm dialog on the real engage and to clear it if the
  pilot bails.
- **Bundled read-only status webapp** (`public/`) that draws the live data path
  (MFD → bridge → SignalK → provider → pilot) and shows the bridge mode, the pilot's real
  state, nav-confirm status, provider presence and the last button/result. Registered
  with a helm `appIcon` and served read-only via `signalKApiRoutes`.
- **`NO AUTOPILOT PROVIDER` detection.** With no V2 autopilot provider registered the
  bridge still binds the MFD but cannot steer; it detects this from an empty `/autopilots`
  list (the `/autopilots/<id>` endpoint returns 500, not 404) and reports it as a **red
  plugin-error status** (as it does for live-without-a-token) so a green badge never sits
  next to "cannot steer".

### Changed
- Plugin display name is now **Autopilot — Navico bridge (Simrad AC emulator)** so it
  sorts under Autopilot in the Server → Plugin Config list. The plugin id is unchanged.

### Fixed
- **Route/Nav no longer crashes the MFD's AP view (dockside-proven 2026-07-05).**
  In route the emulator reports `65341` field `0x0a` (zero value) instead of falling
  through to the field-`0x02` heading frame, and the `65305` route frames are corrected
  to NAC-3 ground truth (selector-`0x02` `0x0110`, selector-`0x0a` status word `0x0040`).
  The auto/heading field under an active route is what crashed the Vulcan 7's AP view.
  Opening the AP view during an active route, and engaging/confirming Nav from the AP
  view's own dialog, both work with no crash.

## [0.4.0-alpha] - 2026-07-02

### Added
- **Wind-mode support.** Report the commanded apparent wind angle on the MFD via
  `65341` field `0x03` (radians × 10000, LE16 unsigned — same encoding and 0–360°
  convention as `130306`), pinned from a real NAC-3 wind capture, and suppress the
  field-`0x02` heading frame in wind mode as the real AP does.
- Consume the EV-200's `65345` **Pilot Wind Datum** as the locked wind setpoint
  echoed back to the MFD, falling back to the live apparent wind when it goes stale.
- Decode the Vulcan **Tack/Gybe** button (Simnet `130850` key `0x11`) and drive the
  SK V2 tack endpoint, deriving the turn side from the apparent wind angle (tack into
  the wind, gybe away). Requires the p70's Gybe Inhibit set to *Allow Gybe* to gybe.

### Fixed
- Corrected the `65305` wind status word to `0x0400` (was `0x0406`, an htool guess)
  to match the NAC-3 ground truth.
- **Crash hardening.** Guard the native `sendPGN` throw (bus-off/ENOBUFS) in both
  `send()` paths, wrap the loopback HTTP client (`sk-autopilot`, `access-request`)
  in try/catch with a single-fire callback and a `res` error handler, and reject
  NaN/Infinity in `selfPathNum` — any of these could otherwise surface as an
  uncaught exception from a timer and take the SignalK server down.
- Stop the socketcan channel in `stop()` (not just `end()`) so a plugin restart no
  longer leaves a zombie AC on the bus re-claiming the same address.
- Harden fast-packet reassembly: sanity-check the frame-0 length and drop stale
  abandoned sequences so a wrapped sequence id can't corrupt a packet.
- Derive the Tack/Gybe turn side from the EV-200's locked wind datum when fresh
  (stable) instead of the momentary apparent wind, which jitters across the ±90°
  tack/gybe boundary in a seaway.

### Changed
- Replaced the legacy large-ChangeCourse tack heuristic (`TACK_MIN_DEG`) with the
  dedicated `0x11` key; ChangeCourse now only carries ±1/±10 nudges.
- Surface the last V2 command result in the plugin status line.
- Remove dead `setBridge()`/`stbySent`; route `setToken` through `SkAutopilot`.

## [0.3.5-alpha] - 2026-06-23

### Fixed
- Declare `@canboat/canboatjs` as an **optional** peer dependency
  (`peerDependenciesMeta`). It is provided by the host Signal K server (already
  compiled), so npm no longer auto-installs it standalone. This clears the
  plugin-ci native-addon failure (the appstore installs with `--ignore-scripts`
  and cannot compile native addons) without changing on-board behaviour.

## [0.3.4-alpha] - 2026-06-23

### Added
- Reusable SignalK plugin-ci GitHub Actions workflow, so the App Store Indicators tab
  shows a per-platform pass/fail matrix and PRs get structure/lifecycle/schema validation.

## [0.3.3-alpha] - 2026-06-22

### Fixed
- Plugin now loads in the Signal K plugin registry even when the `@canboat/canboatjs`
  peer dependency is absent: `canboatjs` is required lazily inside `start()` instead of
  at module top level, so the module export no longer throws on `require`.

### Added
- Smoke test suite (Node.js built-in test runner, `npm test` → `node --test`) verifying
  the plugin loads, exports a valid `{id, name, start, stop}` object, and activates with
  schema defaults without throwing.
- This changelog.

## [0.3.2-alpha] - 2026-06-22

### Changed
- Source-priority documentation made version-aware for Signal K 2.28.

## [0.3.1-alpha]

### Changed
- Trimmed npm description under 255 chars for the appstore.

## [0.3.0-alpha]

### Added
- Show the set heading on the MFD via a populated PGN 127237.

## [0.2.0-alpha]

### Fixed
- Answer ISO requests so the MFD binds to the emulated AC.

## [0.1.0-alpha]

### Added
- Initial release: Simrad AC12/AC42 emulator bridging a Navico MFD's autopilot control
  view to the Signal K Autopilot V2 API.
