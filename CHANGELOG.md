# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.2-alpha] - 2026-07-05

### Added
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
- Sea-trial test protocol (`SEA-TRIAL.md`).

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
