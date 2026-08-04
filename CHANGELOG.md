# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.4-beta] - 2026-08-04

### Changed
- **A Restart is now recognised by cross-track error collapsing, not only by the bearing moving.**
  The re-origin branch needed more than 1° of bearing movement, and how far a Restart moves the
  bearing depends entirely on where along the leg it is pressed — nothing about the manoeuvre
  guarantees it is measurable. It read 0.3° on a 4.9 km leg (2026-08-03) and 0.940° on
  2026-08-04, and both cost a control-head press. Re-laying the leg from the boat is what a
  Restart *does*, so cross-track error falling to zero is the manoeuvre itself, whatever the
  bearing shows. Over 2026-08-04 that signature appeared exactly three times — 21.7 m, 28.9 m and
  35.1 m, each collapsing to under half a metre — and all three were genuine, each preceded by a
  Track-pending. The bearing rule caught two and missed the third.

  The size comes from the boat's own position, which for a re-origin is the definition rather
  than an approximation: the new leg runs from the boat to the destination it was already bound
  for. Checked against the 2026-08-04 restart — geometry 152.200°, plotter published 152.218°.
  The maximum of bearing and geometry governs, which is what keeps the dangerous case safe: a
  Restart with the waypoint abaft the beam asks for a near-reciprocal turn, and if the bearing has
  not caught up `jump` reads zero while the geometry reads 180° and `RESTART_MAX_DEG` refuses it.

  Without a vessel fix the branch produces **no measurement at all** rather than falling back on
  the bearing. `jump <= 1` is the condition for entering it, so a fallback there could only ever
  report a sub-degree turn — auto-confirming precisely the case the geometry exists to catch.

### Added
- **The status page shows what is being navigated and by whom.** The active route name from the
  plotter's 129285, the next waypoint with its distance and bearing, and the source publishing
  the destination with its age. When more than one source publishes it live the row turns red and
  names them: two navigators running at once is the state behind a destination that jumps between
  two places, and Signal K exposes it nowhere else — the Course API tracks the owning source
  internally as `cmdSource` but does not publish it.

  Both calculation branches are read, not just the one the leg tracker follows, because the
  plotter chooses the branch through a field in 129284 and n2k-signalk maps anything that is not
  exactly `Great Circle` onto `courseRhumbline`, including *unavailable*. A destination must also
  be an actual fix rather than a recent write: the plotter publishes 129284 at 1 Hz whether or not
  it is navigating, and the not-navigating form decodes to `{latitude: null, longitude: null}`.

### Fixed
- **"Invalid Command" was wrongly blamed on the resend.** 0.8.2 recorded it as a known cosmetic
  effect of a resend the pilot rejects. The timing does not support that: of the nine alarms on
  2026-08-04, eight arrived 0.08–0.39 s after a destination change and eight arrived 0.07–0.12 s
  before the pilot raised its pending — seven did both, and in every case where a pending followed
  at all the alarm came first, i.e. before the bridge had anything to answer. What does cause it
  is not established here; the README says so in those terms. The 0.8.2 note is withdrawn.

### Known limitations
- **A waypoint advance can still be refused for a turn it is not making.** Sizing one from the
  waypoint geometry requires the leg's origin, and it is guessed as the destination just left.
  Inside a burst of closely spaced waypoints that guess is wrong, and wrong toward refusing: over
  2026-08-04's twenty destination changes it put seven over the limit, six of them falsely — five
  inside a single ten-second burst as the route was re-activated, where no pending was raised at
  all, and one at 10:48 that cost a control-head press (77° measured, 14.6° real).

  The plotter publishes what it actually used as `previousPoint.position`, and a branch that
  re-measured against it was written and reverted the same day. Two reasons, both worth recording.
  The plotter does not always republish it at an advance — seven of that day's destination changes
  had no new plotter-sourced value within four seconds, including the 10:48 one. And the freshest
  value on the path is often not the plotter's at all but the server's own Course API, which
  writes the boat's position there and converges onto the leg origin over about three seconds.
  Knowing *when* that value can be trusted is the unsolved part; a timestamp cannot tell, because
  129285 is republished at 1 Hz and an unchanged value carries a fresh stamp.
- Everything under 0.8.3-beta still applies, except the "Invalid Command" note withdrawn above.

## [0.8.3-beta] - 2026-08-03

### Changed
- **A waypoint advance is now taken from the destination moving, not from the course changing.**
  Autorouting scatters waypoints evenly along straight stretches — Navionics and Orca both do it —
  and stepping through those turns nothing at all, so a rule that required a measurable turn
  refused precisely the legs that need no judgement. Measured under way: five destinations in six
  minutes with `bearingTrackTrue` pinned at 150.0°, every one of them a press at the control head.
  Six of nine refusals in nine minutes were this.

- **The turn is sized from the waypoint geometry as well as the bearing, and the larger wins.**
  Neither source is trustworthy alone. The bearing reads zero whenever the plotter publishes the
  new destination a sample before the new bearing, which the recorded data says is the majority
  case (56 % older, 44 % equal, never newer) — believing it would confirm a 40° turn as "0°" and
  walk straight through the configured limit. The geometry is exact when the route steps
  sequentially (22 of 34 legs matched the settled bearing to within 0.1°) but overstates inside a
  burst of destination changes, where the previous destination is not the new leg's origin. Taking
  the maximum means a real turn cannot hide behind a stale bearing, and a wrong geometry is wrong
  in the direction of asking. Over that day's 57 destination changes: 41 automatic, 16 asked, and
  every one of the 16 fell inside a burst.

- **A bearing that arrives after the destination it belongs to is no longer mistaken for a
  re-origin.** It is absorbed silently, but only when it lands where the geometry predicted, so an
  MFD Restart pressed within the window cannot be answered by the preceding advance's measurement.
  Answering a 120° swing with a measurement of "0°" is the involuntary gybe `RESTART_MAX_DEG`
  exists to prevent.

- **The 5 s settled-leg gate no longer applies to the advance path.** It was written when the turn
  was the signal; with the destination as the signal, short legs are the ordinary case rather than
  the suspicious one, and the gate refused an advance 3 s after the previous one for no reason
  beyond its own arithmetic. The re-origin path keeps its copy, where a settled leg is still the
  only evidence there is.

### Added
- The recorded auto-advance decision now carries both halves of the size — what the bearing saw,
  what the geometry saw, and how far the destination moved — so a refusal can be explained after a
  trip rather than reconstructed.

### Known limitations
- **The geometry can understate a turn inside a burst.** It assumes the new leg's origin is the old
  destination. In an S-bend where two destination changes land within the bearing's update period,
  the measurement becomes cumulative from a leg two steps back and reads low. It needs two changes
  inside roughly a second; the bursts observed were about three seconds apart.
- **A destination change that is not a sequential advance produces an arbitrary angle.** Switching
  routes, a goto, or dragging the active waypoint on the plotter all move the destination without
  advancing along a route. The angle is usually large enough to ask, but that is a property of the
  geometry rather than a guarantee.
- **The Course API writes the same path as the plotter.** With no priority rule for
  `navigation.courseGreatCircle.*`, a server that also navigates through the Course API — Freeboard,
  for instance — registers as a second writer of `nextPoint.position`. The plotter normally wins on
  frequency, publishing at 1 Hz against the API's write-on-activation, but if the plotter falls
  silent past the priority fallback the destination can jump. A priority rule favouring the plotter
  closes it.
- **A pending can still arrive with nothing to size it.** Seen once: a Restart pressed 30 m off a
  4.9 km leg moved the bearing 0.3°, far too little to register, and the destination did not move at
  all, so the pending found nothing and cost a press. A branch answering that case on the boat's
  own course over ground was written, reviewed and held back from this release because it has never
  taken a decision under way.
- ~~**A resend can draw "Invalid Command" from the pilot.**~~ Withdrawn in 0.8.4-beta: the alarm
  arrives before the pilot raises its pending, so the bridge cannot be its cause. See that entry.

## [0.8.2-beta] - 2026-08-01

### Fixed
- **An auto-confirm the pilot ignores is now resent instead of being left to the control head.**
  The EV-200 does not always act on the `SeatalkPilotMode16` write that answers a Track-pending
  prompt, and the skipper was left confirming on the p70 after 8–10 seconds of chirping. Measured
  across all 14 pending episodes of a day under way: of six writes that landed within 200 ms of the
  pilot entering pending, four were obeyed and two were not — including two writes 14 ms after the
  edge with **opposite** outcomes, identical bytes and the same kind of turn. The loss is therefore
  not a timing threshold, and a delay before answering (written and reverted the same afternoon)
  cannot address it; a dropped frame or a failed fast-packet reassembly fits the data, and is
  silent and indistinguishable from being ignored. The confirm is now repeated every 2 s for up to
  6 s while the pilot is demonstrably still asking, which covers a lost frame and covers a timing
  effect too if one exists, and costs nothing when the first write lands.
- No consent is widened by this: a resend repeats a decision already made for that pending episode
  and never makes a new one. Leaving Track-pending ends the episode on the mode **edge**, not on a
  sampled value — the pilot broadcasts at 1 Hz while the resend runs at 2 Hz, so a server stall can
  queue "left pending" and "arrived at the next waypoint" behind a tick that would otherwise answer
  an episode the skipper never saw, and possibly one the auto-confirm logic had refused. A resend
  also requires a pilot observation that **postdates the bridge's own command**, the same rule the
  engage path and the Nav re-confirm use; without it the ~1 s blind spot between mode broadcasts is
  wide enough for a Standby press on the control head to be answered by putting the pilot back into
  Track. A provider refusal ends the resend and keeps its real reason on the status page.

### Notes
- Near-collinear waypoint advances (two legs within 1° of each other, roughly one waypoint in nine
  on a densely pointed route) still ask for a manual confirm. A fix that read the advance from the
  destination alone was sea-tested and reverted the same day: the plotter publishes the new
  destination one sample **before** the new bearing, so the leg baseline mixed a new waypoint with
  an old bearing and a routine advance was misread as a leg re-origin. Solving it properly needs
  the leg's identity tracked apart from its bearing.
- 65340/65302 were briefly restored while chasing intermittent "no AP computer" alarms on the MFD.
  The alarms were a SignalK event-loop stall with an unrelated cause, so both PGNs went back out
  and the documentation stands: they are declared in `TX_PGNS` and not sent.

## [0.8.1-beta] - 2026-07-30

### Changed
- **A single Nav press can no longer engage Track.** It used to `PUT /state route` on the first
  press, on the belief that this only walked the pilot to a pending state and left the engage to
  the confirm. That belief was wrong: `PUT /state route` writes `SeatalkPilotMode16` **0x0180
  TrackMode** and `advanceWaypoint` writes **0x0181 NoDriftCogReferencedInTrackCourseChanges** —
  two co-equal Track *sub-modes* of one shared register, not a request and its answer. The pilot
  promotes itself 0x0180 → 0x0181 unprompted and faster than the MFD's dialog renders, and the
  dialog was cleared on 0x0181, so it was torn down before it could be read. Under way this let
  one press take the boat into Track on a very large course change with nothing to confirm.
  Now the first press only *arms* the dialog and sends the pilot nothing; the confirm is the only
  path that commands route; the dialog is held a minimum time before the pilot's own mode may
  latch it; and a follow-up completes an engage the skipper already authorised once the pilot
  actually reaches Track. The two states are named `track` / `track-cog` rather than
  `route-pending` / `route-engaged` — the old wording read as a handshake the bridge takes part
  in, and that framing cost a day of wrong theories.

### Fixed

The next four were reported, diagnosed against the source and specified in detail by **Magnus**,
who runs the bridge against a SeaTalk1 pilot through a Raymarine E22158 whose SeaTalk-to-N2K
side drops out — which is how the whole "the display says engaged but nothing is steering" class
of problem came to light. The design call to treat an unverifiable engagement as `standby`, and
the hysteresis on it, are his.

- **Course nudges reached a pilot the provider had declared unreachable.** The V2 spec has a
  provider return `off-line` when it cannot reach the pilot (`@signalk/server-api`,
  `autopilotapi.d.ts`, on `getState`). `off-line` is not `standby`, so a bare `!== 'standby'`
  test passed it and `engaged()` let ±1°/±10° through. `engaged()` now requires one of the four
  real modes and a present provider, and a `normalizeMode()` helper keeps non-modes out of
  `commandedMode` and out of the state comparison — which also stops that comparison from
  correcting and logging on every poll forever.
- **A refused command left the display claiming an engagement that never happened.** The mode was
  set optimistically before the call and the outcome only ever reached `lastV2Result`; the one
  thing that could correct it — the state poll — fails for largely the *same* reasons that stop
  the command: no token, provider gone, server restarting. The MFD would sit on "engaged", with
  the firehose broadcasting an engaged state and a heading-to-steer, while nothing steered.
  Commands now report failure, a refused mode press rolls the display back (to the pilot's real
  state if it is readable, else to what was shown before), and a refused confirm returns to the
  dialog with its original timestamp so the anti-stuck timeout still expires. A sequence counter
  keeps a late failure from undoing a newer press.
- **The bridge no longer claims an engagement it cannot verify.** In `live`, with no provider or
  a state poll that has been unusable for the whole freshness window, the firehose broadcasts
  `standby`. An unverifiable "engaged" is the more dangerous lie: the pilot keeps steering
  whatever the display says, and there is no "don't know" to broadcast. Damped by several
  consecutive failed polls so it cannot flap the MFD's lost-autopilot alarm — recovery is
  immediate, only the downgrade is delayed. `displayMode` and `displayDowngraded` appear in the
  status API, the plugin status line, and as a webapp banner, so a display dropping to standby
  is not read as the pilot disengaging itself.
- **Two ways to skip a waypoint**, found in review before either reached the water: the
  waypoint-advance logic fired on the same pilot-state edge as an authorised engage, sending a
  second `advanceWaypoint` at an already-engaged pilot; and the engage follow-up acted on a mode
  word up to 5 s old, while the pilot changes mode in well under one 1 Hz broadcast period. Both
  now require the observation to postdate the bridge's own command.
- **A slow but successful command read as a refusal.** The provider's `verifyChange` only replies
  on its sixth or seventh retry, so the client's 5 s timeout always fired first and the
  `400 Did not receive change confirmation` carve-out could never match. Harmless while that only
  reached a status line; not once a refusal rolls the display back. The timeout is now 10 s.
- **An upgrade could silently reset the config of a disabled plugin.** The grouped-layout rewrite
  ran only in `start()`, so a plugin that was disabled when the new version landed never got it —
  its config page then rendered the groups it could not find from their defaults, and the first
  save committed those over real settings, dropping `bridge` back to `dry-run`. The rewrite now
  runs at load time. Doing it from `schema()` would have been one page-load too late: the server
  reads the saved config and calls `schema()` within the same request.

## [0.8.0-beta] - 2026-07-29

### Added
- **Auto-confirm a Track restart (leg re-origin), opt-in.** Engaging Nav off the rhumb line
  makes the pilot swing hard to intercept it; pressing **Restart** on the MFD re-origins the
  leg onto the boat so it steers straight at the same waypoint, but the pilot reads that as a
  course change, goes Track-pending and asks for a control-head Yes. The new **Auto-confirm a
  Track restart** setting answers it. A re-origin is told from a waypoint advance by the
  destination position across the bearing jump, not by distance to the waypoint: at an advance
  the distance steps from the arrival radius to the next leg's length, so closely spaced marks
  barely step at all — precisely the tight water where the advance limit matters. Capped at
  **90°** regardless (with the waypoint abaft the beam a re-origin asks for a near-reciprocal
  turn, i.e. an involuntary gybe) and the re-origined leg must have been settled ≥5 s.
  Independent of the waypoint-advance limit; off by default; `live` only. With it off,
  behaviour is unchanged from before.

### Changed
- **The config page is grouped into sections** — *NMEA 2000 and emulated device*, *Pilot
  control via SignalK*, *Track waypoint advance*, *Track restart*, *Commissioning* — instead of
  one flat list of fourteen fields where nothing said which setting belonged with which.
  Commissioning is last: it is needed once, at first commissioning, and off ever after. The two
  Track confirmations are separate sections rather than one because a checkbox cannot carry a
  heading of its own — the admin UI renders a boolean's title as the label *below* its
  description, and its markdown option is read by the field template, which the checkbox widget
  bypasses. A group title is the only heading available, so without the split the restart
  explanation floated under the waypoint-advance input and read as part of that field. The
  grouping is presentation only; the plugin still takes one flat object internally, and a config
  saved under any older layout is rewritten into the current one at startup. Without that the
  page would render the groups it cannot find from their defaults and the first save would
  commit them over live settings — `bridge` would quietly fall back to `dry-run`.

### Fixed
- **Leg state could be sized against a route that was no longer active.** SignalK never nulls
  a path when its source stops, so `navigation.courseGreatCircle.bearingTrackTrue` keeps
  serving the last leg indefinitely — observed 29 minutes stale on a live server. Deactivating
  a route and activating another therefore sized the first "turn" against a leg from the
  previous route, and the held-duration trust gate waved it through because a frozen leg is by
  definition old. Course paths are now read only while fresh (10 s), verified against the real
  1 Hz publication rate (worst in-passage gap 4.9 s). Affects the pre-existing automatic
  waypoint advance, not just the new restart path.
- **The nav-confirm window is now resolved on the 65379 frame itself** rather than at the next
  2 Hz poll, so the pilot passing through Track-engaged and back into pending — which a Restart
  pressed right after the confirm does — no longer risks leaving the pending flag set.

## [0.7.3-beta] - 2026-07-27

### Fixed
- **Every MFD button was silently dropped on a host bundling canboatjs 3.x.** The
  `130850` decode read the group and key out of canboatjs **2.10's** field names
  (`fields.Event` and `fields["Unused B"]`, which is how that version renders this
  Simnet layout). 3.x resolves each key to its own PGN variant instead
  (`simnetCommandApStandby`, `simnetCommandApNav`, …) with camelCase fields and
  neither of those names, so `isApGroup()` rejected every frame: the command counter
  rose, `Last event` stuck on *non-AP-group (ignored)*, and nothing reached the pilot
  while the plugin looked healthy. 0.6.1-beta made the plugin *load* under 3.x but
  left the *decode* 2.x-only, which turned a visible startup crash into a silent
  failure. Both group and key now come from the raw frame the plugin already
  reassembles, guarded on source and age, with the canboat fields kept as a fallback.
  Reported from an install that had picked up canboatjs 3.x.
- **The advertised NMEA 2000 version was nonsense on the wire.** The field has 0.001
  resolution, so canboat multiplies on encode: `1200` became 1 200 000, wrapped the
  u16 to 20352 and read back as version *20.352*. It is now given as `1.200`, which
  encodes to raw 1200. Cosmetic — no MFD rejects the claim over it — but it was wrong
  data. Reported by a user reading the emulator's product info off the bus.
- **The pilot's locked wind angle was ignored on canboatjs 3.x**, for the same
  field-spelling reason: `65345` was read as `Wind Datum` only, so `windDatumRad` never
  cached. Tack and gybe then derived their turn side from the fluctuating live apparent
  wind instead of the pilot's setpoint — the exact jitter the cache exists to avoid,
  which can flip the chosen side near ±90° — and the `65341` echo showed live AWA
  rather than the locked angle.
- **The commissioning readback went unanswered on canboatjs 3.x**, so an MFD's wizard
  could sit on *commissioning required* while every other value on the page was live.
  `130845` is read by field name (it has no raw tap), and only the Title Case spelling
  was checked — canboat renders field names camelCase when `useCamel` is on, which is
  the default our parser runs with, and 2.x only ever produced Title Case. Both
  spellings are now accepted. Reported from a Triton² that would not clear its
  commissioning banner.
- **The plugin's own commissioning head steered the pilot.** With commissioning mode
  enabled the emulated control head broadcasts a real AP-group `130850` standby every
  2 s to hold the MFD's gate open, from its own address — which the incoming filter did
  not exclude (it only skipped the AC's address). In `live` that decoded as a genuine
  press and dropped the pilot to standby every other second for as long as
  commissioning mode was on, so it could never stay engaged. Own addresses are now rejected before
  any command is applied, and shown as *own-src … (ignored)* rather than silently, since
  seeing the head's own traffic recognised is useful while commissioning. Found by a
  user who ran with the commissioning head enabled.
- **A fresh install could not find canboatjs at all.** It is an optional
  peerDependency (npm does not auto-install it — the appstore's plugin-ci runs
  `--ignore-scripts` and fails on native addons, which canboatjs pulls in via
  socketcan), and the host server's own copy is unreachable from
  `~/.signalk/node_modules`: Node resolves upward from the plugin and never enters the
  globally installed server tree. Startup died with `Cannot find module
  '@canboat/canboatjs'`. Resolution now falls back to a require rooted at the server's
  entry file, which reaches the copy the server bundles. Safe on either major, since
  the button decode reads raw bytes and the remaining field reads accept both canboat
  spellings. If both paths fail the plugin
  status now says so and gives the install command instead of showing a bare module
  error.

### Added
- **A warning when the CAN transmit queue is too short for the product-info burst.** The
  plugin reads `/sys/class/net/<iface>/tx_queue_len`; below 32 it logs the full explanation
  once at startup and carries `txqueuelen <n> -- too short for product info, raise to 128`
  in the plugin status line. The value is re-read periodically, so raising the queue clears
  the warning without restarting anything. `txQueueLen` and `txQueueTooShort` are in the
  status API too. A queue length of 0 (the noqueue qdisc, e.g. `vcan`) counts as
  not applicable, not as too short. The queue belongs to the host — the plugin cannot raise it — but
  the failure it causes (an MFD listing the AC with no name or serial, and a commissioning
  wizard that will not complete) is otherwise invisible and cost two users several days
  each to track down. Silent when the file cannot be read, e.g. off Linux.

### Documentation
- **Troubleshooting: empty Name and Serial in the MFD device list**, which also keeps a
  commissioning wizard from completing. Product info (`126996`) is 134 bytes, i.e. 20
  fast-packet frames back to back, and many SocketCAN drivers default to `txqueuelen 10`
  — notably `mcp251x`, behind the common Raspberry Pi SPI CAN HATs — so the queue fills
  around frame 11 and the kernel drops the rest. Silently, because canboatjs sends on a
  non-blocking socket without inspecting the `write()` result. `ip link set can0
  txqueuelen 128` fixes it; no code change anywhere. Diagnosed by a user on a Pi 5 after
  first suspecting the encoder, and the same qlen default turned out to be present on
  the development boat.

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
