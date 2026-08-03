# Autopilot — Navico bridge

`signalk-navico-autopilot-bridge` · a Simrad AC12/AC42 emulator

> **Status: 0.8.3-beta — feature complete.** Sea-trialled on a real rig (B&G Vulcan 7
> → SignalK V2 → Raymarine EV-200) across **several outings in varied conditions**:
> engaging and holding Auto, ±course nudges, holding Wind, and the abort / failsafe path
> all worked on the water. **Tack and Gybe were sea-trialled on 2026-07-11 and performed
> exemplarily**. Nav/Track engage from the MFD's own confirm dialog — driving the pilot
> into Track without a separate control-head press — is **proven dockside (2026-07-05) and
> confirmed under way**. **Multi-leg route sailing including waypoint advance was
> sea-trialled 2026-07-15 and again 2026-08-03**, with optional
> [automatic advance](#nav-engage--confirm) of small course changes. A bundled
> [status webapp](#status-webapp) shows the live data path. See
> [Requirements](#requirements), [Known limitations](#known-limitations) and the
> [Disclaimer](#disclaimer--no-warranty) before using it.

**New in 0.8.3-beta — much improved automatic waypoint advance.** An advance is now taken
from the *destination moving* rather than from the course changing, and the turn is sized
from the waypoint geometry as well as the bearing, keeping whichever reads larger.
Autorouted routes scatter waypoints along straight stretches where the course never
changes, and those legs used to cost a control-head press each. Sea-trialled 2026-08-03:
eleven decisions, ten of them automatic. See the [changelog](CHANGELOG.md) for the
measurements behind that and for the known limitations.

Emulate a **Simrad AC12/AC42 autopilot computer** so a **Navico MFD** (B&G
Vulcan/Zeus, Simrad, Lowrance) binds to it and exposes its own **autopilot
control view**. The button presses that view puts on the NMEA 2000 bus (Simnet
`130850`) are decoded and translated into the **SignalK Autopilot V2 API**, which
drives whichever pilot backs it through an Autopilot V2 provider — for example a
Raymarine EV-200 via
[`signalk-autopilot`](https://github.com/SignalK/signalk-autopilot).

In other words: **press the autopilot buttons on a Navico plotter, steer a
non-Navico pilot.** The bridge is Navico/Simrad/B&G-specific on the *input* side
(only Navico MFDs bind to a Simrad AC) and **provider-agnostic on the output side**
(anything that implements the SignalK V2 Autopilot API).

![The bundled status webapp showing the live data path from the Navico MFD through the bridge and SignalK to the autopilot, with the pilot holding Wind after a Tack and every device live on the bus.](screenshot.png?v=0.6.0-beta)

*The bundled [status webapp](#status-webapp) — a read-only live view that gives a clear
overview of how the pieces connect and what the pilot is doing. It is a monitor only, with
**no control function**: steering is always done from the MFD's own autopilot buttons.*

## Roles & tested hardware

The bridge is written for generic **roles**. Where the rest of this README names a specific
unit, that is the rig it was proven on — read it as your own equivalent.

| Role | What it means | Tested on |
|---|---|---|
| **MFD** | The Navico chart plotter (B&G Vulcan/Zeus, Simrad, Lowrance) with the autopilot control view — the screen you press the buttons on. | B&G Vulcan 7 |
| **Autopilot** / *the pilot* | The course computer that actually steers the boat, reached through a SignalK V2 autopilot provider. | Raymarine EV-200 (EV-1 + ACU-200), **sailboat** boat type |
| **Control head** | The pilot's own keypad — engages, confirms and drops to standby independently of the MFD. | Raymarine **p70S** |
| **Provider** | The SignalK **V2 autopilot provider** that drives the pilot. | [`@signalk/signalk-autopilot`](https://github.com/SignalK/signalk-autopilot) (`raymarineN2K`) |
| **AC** | The **autopilot computer** the bridge *emulates* on the bus so the MFD binds to it. | Simrad AC42 / AC12 (emulated) |
| **Bridge** | This plugin — decodes the MFD's buttons and translates them to the provider. | — |

Only Navico MFDs bind to a Simrad AC (the input side is Navico-specific); the output side is
**provider-agnostic**, though the Nav/Track engage path is currently tuned to the Raymarine
pilot (see [Nav engage & confirm](#nav-engage--confirm)). Combinations other than the tested
one should work but are unverified.

## Requirements

- A **Navico/B&G MFD** (Vulcan/Zeus, Simrad, Lowrance) with an autopilot control view.
- An **Autopilot V2 provider** registered in SignalK with a **default pilot** — this is
  what the bridge actually steers. On a Raymarine rig that is
  [`@signalk/signalk-autopilot`](https://github.com/SignalK/signalk-autopilot)
  (provider `raymarineN2K` → EV-200). **Without a provider the bridge still binds the
  MFD and decodes its buttons, but cannot steer** — the plugin status turns red with
  `NO AUTOPILOT PROVIDER` (detected from an empty SignalK autopilots list) and steer
  commands fail. The bridge is provider-agnostic: any pilot reachable through the
  SignalK autopilot API that supports `state` and the `advanceWaypoint` action works.
- A SignalK server on the same NMEA 2000 bus (SocketCAN, `can0` by default).

## Disclaimer / no warranty

**An autopilot steers the boat. This software can move the rudder.** Read this
before you install it.

- **Beta, experimental, unofficial.** This is a reverse-engineered emulation of
  a proprietary Simrad device, built from bus captures — not from any
  manufacturer specification. It is not affiliated with, endorsed by, or
  supported by Navico, B&G, Simrad, Lowrance, Raymarine, or the SignalK project.
  Behaviour may change or break with any firmware, plugin, or canboatjs update.
- **Not safety-rated.** It is **not** certified for marine navigation and must
  **not** be relied on as a primary or sole means of steering or watchkeeping. A
  competent helmsman must remain at the helm, keep a proper lookout, and be ready
  to take manual control and drop the pilot to standby at all times.
- **It can fail silently or behave unexpectedly** — wrong mode, wrong course,
  no response, or a course change at the wrong moment. **Automatic waypoint advance,
  if you enable it, confirms course changes on its own** — keep it within a limit you
  are comfortable with and watch each advance. Some MFD display frames are unverified.
  Do not trust it where a failure could cause a collision, grounding, injury, or loss
  of life.
- **You are responsible.** By installing or running this software you accept full
  responsibility for any consequences. Only ever use it with the **boat secured,
  the engine off, and the pilot's own control head to hand**, until you have
  personally sea-trialled every mode you intend to rely on.
- **No warranty.** Provided "AS IS", without warranty of any kind, express or
  implied, including but not limited to fitness for a particular purpose. To the
  maximum extent permitted by law the authors accept no liability for any damage,
  injury, or loss arising from its use. See [License](#license).

## Why an emulator (the "firehose")

A real AC is anything but quiet: it broadcasts a full set of proprietary
state/telemetry PGNs (`65340` Pilot State, `65305` Device Status, `65341` AP
Angle, `65302`/`65420`/`130860`/`128275`, …) at 1–2 Hz. A near-silent fake is
ranked below a live pilot and never selected, and the commissioning "press
standby" gate is satisfied by the AC's *own* continuous state broadcast. This
plugin reproduces that broadcast (byte templates taken verbatim from a real AC42 in
`canboat/samples/ac42-commissioning.raw`), which is what makes the MFD bind to it and
unlock the control view. Not every frame a real AC42 sends turned out to be needed:
`65340` and `65302` were dropped in testing without costing the binding or the mode
display, so the emitted set is the *verified* subset, not the full one.

The emulator runs as a **second N2K device** on the bus (its own address claim,
default address 35), alongside the SignalK server's own canboat connection and any
real pilot. It opens its own SocketCAN socket — it does **not** route through
SignalK's N2K output, because the firehose must be sent *as the emulated AC*, not
as the server.

## How it works

1. **Firehose** — broadcasts the AC's proprietary AP state/telemetry so the MFD
   binds and keeps the control view live. Mode bytes follow the live SignalK
   autopilot state (read back over the loopback API).
2. **Commissioning readback** — answers the MFD's `130845` dockside-config reads
   with byte-exact values from the reference AC42, so the wizard fields populate.
   The control view unlocks **without finishing the wizard**: the values you key
   in (rudder calibration, drive voltage, rudder test, …) are not consumed by
   anything that steers — the backing pilot has its own commissioning — so they
   can be left at defaults or skipped. The one setting that matters is **boat
   type**: set it to **Sail** so the MFD exposes wind mode and the tack buttons
   (per the MFD manual those functions require a Sail boat type).
3. **Input bridge** — reassembles incoming `130850` commands, decodes the Simnet
   key byte, and (in `live` mode) calls the V2 Autopilot API.

The byte-level command and mode-display decoding lives in
[Protocol details](#protocol-details).

## Setup

Do the steps below in order:

1. [Install](#1-install) the plugin from source.
2. [Configure](#2-configure-the-plugin) it (start in `dry-run`).
3. [Enable the autopilot on the MFD](#3-enable-the-autopilot-on-the-mfd).
4. [Run first commissioning](#4-first-commissioning) to bind the MFD and unlock
   the control view.
5. [Set source priorities](#5-source-priorities-required) so the emulator can't
   shadow the real pilot.

### 1. Install

Install it from the **SignalK app store**: in the SignalK admin UI open
**Appstore → Available**, search for *Navico autopilot bridge*, install it, and
restart the server. It then appears under **Server → Plugin Config** as
**Autopilot — Navico bridge**. It is published as a **beta** — read the
[Disclaimer](#disclaimer--no-warranty) first.

`@canboat/canboatjs` is an optional peerDependency, so npm does not install it. The
plugin looks for it beside itself first and otherwise falls back to the copy the
SignalK server it runs under already bundles, so normally there is nothing to install.
If the plugin status reports it missing on both paths, install it next to the plugin:

```sh
npm install @canboat/canboatjs --prefix ~/.signalk
```

To install from source instead (e.g. for development):

```sh
cd ~/.signalk/node_modules
git clone https://github.com/johansolve/signalk-navico-autopilot-bridge.git
```

Restart the SignalK server, then enable and configure the plugin under
**Server → Plugin Config**.

### 2. Configure the plugin

| option | default | notes |
|---|---|---|
| CAN interface | `can0` | SocketCAN interface |
| Emulated AC model | `AC42` | both `AC42` and `AC12` bind the MFD; the model only sets the reported product info, not whether it binds |
| Preferred N2K address | `35` | address the emulated AC claims |
| Broadcast AC autopilot state | `true` | the firehose; required for binding — leave on |
| Standard nav PGNs | `false` | duplicates other sources; A/B testing only |
| **Bridge mode** | **`dry-run`** | `off` / `dry-run` (decode+log) / `live` (steer) |
| Target autopilot id | `_default` | which `autopilots/<id>` the V2 API drives |
| SignalK host / port | `127.0.0.1` / `3000` | loopback API target |
| API token | — | leave empty — auto-requested, you approve it once (see [Access & token](#access--token)) |
| Commissioning mode | `false` | emulate a control head to open the first-commissioning gate (see below) |
| Commissioning head address | `44` | address the emulated head claims (commissioning only) |

#### ⚠️ Safety

- **Default is `dry-run`** — it decodes and logs commands but never steers. You
  must set `live` deliberately.
- Only switch to `live` with a **competent helmsman at the helm and the pilot's
  own control head to hand** to drop to standby. Do **first commissioning and any
  untested mode** at the dock with the boat secured.
- Do **not** run this on a bus that already has a real Simrad/B&G AC — two devices
  broadcasting AP state will confuse control heads.

#### Access & token

In `live` mode the bridge has to PUT commands to the Autopilot V2 API, which needs
a read/write token. You normally **leave the API token field empty** and let the
plugin obtain one through SignalK's standard device access-request flow:

1. On first start in `live`, the plugin submits an access request (it asks for
   `readwrite`) and prints `requesting device access` in its log.
2. In the SignalK admin UI, open **Security → Access Requests**. A pending entry
   appears, described as *"Navico autopilot bridge (needs readwrite to steer)"*.
   **Approve** it with **read/write** permission.
3. The granted token is stored in the plugin's data directory (`access.json`) and
   reused across restarts, so you only approve once. The bridge now shows up under
   **Security → Devices** and can be revoked there at any time.

If you **deny** the request the bridge stays read-only until you reconfigure and
restart it. If the request expires, or you later revoke the device, the plugin
automatically submits a fresh request to approve again.

To use a specific token instead, paste it into the **API token** field — it must
be a valid SignalK JWT; any non-JWT value is ignored and the auto-request is used.

### 3. Enable the autopilot on the MFD

The MFD only shows its autopilot control view once the autopilot is enabled on
the MFD — this is a prerequisite. Per the Navico manual, *"a device connected to
the NMEA 2000 network should automatically be identified by the system. If not,
enable the feature from the advanced option in the System settings dialog."*

> **Not yet verified with the emulator.** On this boat the Autopilot feature was
> enabled **manually** from System settings when the project started. Whether a
> running emulator now triggers fully automatic identification, or the feature
> still has to be enabled by hand, is untested — if the control view does not
> appear, enable it manually from System settings (advanced option).

### 4. First commissioning

A Navico MFD needs a control head on the bus to **start** its very first
commissioning of an AC. The plugin can emulate one (a B&G keypad on a second
address) so you can open the **"press standby"** gate without any physical Simrad
hardware. (See your Navico MFD's install manual — e.g. the B&G Vulcan's
*Software Setup → autopilot commissioning*.)

1. Enable **Commissioning mode** in the plugin config and save. SignalK restarts
   the plugin automatically when you save config — no manual restart needed.
2. On the MFD, run the autopilot commissioning wizard. When it asks you to press
   standby, the emulated head is already putting the standby command on the bus,
   so the gate opens; the dockside config fields populate from the AC readback.
3. Bail out of the wizard before the rudder test / sea-trial — the control view
   unlocks anyway. Only **boat type** matters (set **Sail** for wind/tack); the
   rudder calibration, drive voltage and rudder-test values are ignored.
4. **Disable Commissioning mode** and save. It is not needed afterwards — the
   emulated AC plus the MFD's own buttons run normal operation.

The emulated head only sends the keypad heartbeat (`65305`) and the standby
command (`130850` key `0x0006`); it never steers.

### 5. Source priorities (required)

The emulator is a second "autopilot" on the same NMEA 2000 bus your SignalK server
already reads. Its firehose includes Simnet `65305`/`65341`, which canboat maps to
`steering.autopilot.state` and `steering.autopilot.target.headingMagnetic` — the
same paths your **real** pilot writes. With two sources on one path, SignalK's
source arbitration can pick the emulator's value (`65305` decodes to `heading`, not
`auto`), and the V2 provider's `putAdjustHeading` then rejects a course change with
**`400 "Autopilot not in auto or wind mode"`** because the path it reads is no
longer `auto`/`wind`.

Symptom: state changes (standby/auto/wind) work, but **a course change is refused
in auto** (and intermittently in wind), even though the pilot really is in auto.

Fix: pin the real pilot as the authoritative source for these paths, with an
**empty timeout** so the emulator can never take over. **How you do this depends on
your server version** — SignalK **2.28** reworked the source-priority mechanism
(config moved to its own file, sources are now keyed by a stable CAN Name, and a
Data Browser UI was added). Check yours under **Server → … → Version**.

First, find `<real-pilot-source>` — the source that reports the **correct mode**
(`auto`/`wind`/`standby`), not the emulator's `heading`. Read the path and look at
the entries under `values`:

```sh
curl -s http://localhost:3000/signalk/v1/api/vessels/self/steering/autopilot/state
```

On 2.28 the source refs are CAN Names (e.g. the real pilot reports `state` via pgn
`126720` under a ref like `can00.c0509635e76d9500`; the emulator is a separate ref
that publishes pgn `65305`). These are **stable across bus changes** — unlike the
old address-based `can0.<n>` refs.

**SignalK ≥ 2.28 (recommended: Data Browser UI)**

1. Open **Data Browser**, find `steering.autopilot.state`, and use the source-
   priority control to rank the **real pilot first** with **no timeout**, the
   emulator below it (or disable the emulator as a source for this path).
2. Repeat for `steering.autopilot.target.headingMagnetic`.

The UI writes `~/.signalk/priorities.json` under `priorityOverrides` — equivalent
to editing it directly:

```json
"priorityOverrides": {
  "steering.autopilot.state": [
    { "sourceRef": "<real-pilot-source>", "timeout": "" }
  ],
  "steering.autopilot.target.headingMagnetic": [
    { "sourceRef": "<real-pilot-source>", "timeout": "" }
  ]
}
```

**SignalK < 2.28 (settings.json)**

Pin the source in `~/.signalk/settings.json` under `sourcePriorities`:

```json
"sourcePriorities": {
  "steering.autopilot.state": [
    { "sourceRef": "<real-pilot-source>", "timeout": "" }
  ],
  "steering.autopilot.target.headingMagnetic": [
    { "sourceRef": "<real-pilot-source>", "timeout": "" }
  ]
}
```

Either way, a non-empty timeout (e.g. `10000`) is **not** enough: the real pilot
may not re-publish state every few seconds at rest, so the emulator's ~2 Hz
firehose wins again between updates. Use `""`. Restart the server after editing.

## Protocol details

Reference for the reverse-engineered N2K layer; not needed to set the plugin up.
The full command/response catalogue — every `130850` key and the per-mode
`65341`/`65305`/`65340` state frames, with a ground-truth source tag per row — is
in **[PROTOCOL-REFERENCE.md](PROTOCOL-REFERENCE.md)**. The summary below is the gist.

### Command decoding

canboatjs 2.10 has an incomplete `130850` definition for this Simnet layout, so
the bridge decodes on the raw **key byte**, gated by group `0x0a`, not on
canboat's mislabeled `Event` field. Keys verified live against the MFD:

| key (byte 6) | command | maps to |
|---|---|---|
| `0x06` | Standby | `PUT state {standby}` |
| `0x09` | Auto | `PUT state {auto}` |
| `0x0f` | Wind | `PUT state {wind}` |
| `0x0a` | Nav / Track | `PUT state {route}` (two-press engage, see [Nav engage & confirm](#nav-engage--confirm)) |
| `0x1a` | ChangeCourse | `PUT target/adjust` (±1° / ±10°) |
| `0x11` | Tack / Gybe | `POST tack/{port\|starboard}` (wind mode only) |
| `0x0c` | No Drift | `PUT state {auto}` (see [Known limitations](#known-limitations)) |
| `0x1c` | key-press envelope | ignored (precedes every command) |

**ChangeCourse** (`0x1a`): byte 8 = direction (`0x03` starboard/+, `0x02`
port/−), bytes 9–10 = magnitude LE16 at `0.0001 rad/bit` (10° = 1745, 1° = 174).
canboat's `Angle` reads bytes 8–9 (off-by-one) and is wrong for this command, so
the bridge decodes from the reassembled raw frame. The V2 `adjustTarget` floors
`radiansToDegrees`, and some providers accept only exactly ±10/±1, so the magnitude
is rounded to a whole degree `N` and sent as `(N+0.5)°` in radians, landing the
floor exactly on `N`.

**Tack / Gybe** is its own key `0x11` (no direction or magnitude in the frame — the
MFD picks the *label* Tack/Gybe but sends the same key). The bridge fires it only in
wind mode with the pilot engaged, deriving the turn side from the pilot's locked
wind datum (`65345`) when fresh, else the live apparent wind, and mapping to
`POST tack/{port|starboard}` — the pilot mirrors the wind angle to the other side (a
tack when the wind is forward, a gybe when aft). **Requires the pilot's *Gybe Inhibit*
set to *Allow Gybe*** to gybe. Sea-trialled 2026-07-11. Byte layout in
[PROTOCOL-REFERENCE §2.4](PROTOCOL-REFERENCE.md).

### Mode display (firehose)

The MFD's displayed mode is driven by the firehose, not by the button press: the
plugin sends per-mode `65305` frames plus a mode-change announce, and the overlay
followed standby/auto/wind/route correctly on the sea trials. The `65305` and `65341`
frames for auto/wind/route are pinned to real NAC-3 captures (ground truth). The
`65340`/`65302` frames were htool guesses and are **no longer sent** — a dockside test
(2026-07-22) confirmed the MFD binds and the mode label still tracks every state change
without them. Per-mode byte values and source tags are in
[PROTOCOL-REFERENCE §3](PROTOCOL-REFERENCE.md).

### Set heading (127237)

When engaged the emulator broadcasts `127237` Heading/Track Control with the
locked heading in the *Heading-To-Steer* field (Steering Mode = Heading Control,
Heading Reference = Magnetic), so the MFD shows the set heading. A real AC
re-broadcasts this; without it the MFD shows "- - -". It is sent at **5 Hz**
because the boat's other devices broadcast `127237` with an *empty*
Heading-To-Steer at 10–20 Hz, which otherwise blanks the value and makes the
display flicker. The value is `steering.autopilot.target.headingMagnetic` (the
locked heading), falling back to `navigation.headingMagnetic`. It is sent as
Magnetic; the MFD converts to its configured heading reference (e.g. True) using
the bus magnetic variation, so set the MFD's heading units to match the rest of
the boat.

## Verified behaviour (on the tested rig)

- MFD binds to the emulator and raises a *lost-autopilot* alarm the instant the
  firehose stops.
- "Press standby" commissioning gate opens; dockside config fields populate.
- Control view reachable and live **without finishing the wizard**.
- Standby / Auto / Wind / Nav(Track) / ±course button presses decode and, in
  `live`, drive the pilot (clutch engages, rudder moves, the control head and the
  MFD overlay reflect the mode). The overlay label followed the pilot in every mode
  during the sea trials.
- **Set heading** displays on the MFD (both the overlay and the AP view) via the
  populated `127237`; ±course on the MFD changes it and is confirmed on the
  MFD without touching the pilot's own head.
- **Track restart** from the MFD's autopilot control works fine. The MFD
  handles it internally (it does not require the bridge to act on a distinct
  command), so nothing extra is decoded on this side.

### Sea trials (on the water, several outings in varied conditions)

- **Auto holds course** with way on; the abort path is sound: **standby on the control
  head frees the helm immediately**, and standby from the MFD drops the pilot.
- **±1° / ±10°** nudges alter heading by the right amount and direction; a
  cumulative ~60° alteration came round without an accidental tack.
- **Wind** engaged and **held the apparent wind angle**, overlay showed *Wind*.
- **Tack and Gybe** (2026-07-11) both fired from the MFD and the pilot came round
  cleanly to the mirrored wind angle on either side — performed exemplarily under way.
- **Nav/Track engage** from the MFD's own confirm dialog drove the pilot into Track
  under way, without a separate control-head press (also dockside-proven 2026-07-05).
- **Multi-leg route sailing including waypoint advance** was sea-trialled 2026-07-15;
  with [automatic advance](#nav-engage--confirm) enabled a 7° advance was auto-confirmed
  (pilot engaged in ~70 ms, unnoticed) and a 21° advance was left for a manual confirm.
- **Destination-based advance** was sea-trialled 2026-08-03 on an autorouted route: eleven
  decisions, ten of them automatic, and twice the geometry alone carried a step the bearing
  read as 0°. The single manual confirm was a route change, not a waypoint step. Two MFD
  Restarts were auto-confirmed on the same trip.

> **Wind-mode course nudge on port tack is not confirmed under way.** The nudge
> direction in wind vane mode was corrected (green `+` turns to starboard on both
> tacks) and verified dockside on starboard tack; the port-tack case is still to be
> checked on the water.

## Nav engage & confirm

Engaging Nav is a **two-press** flow, so the MFD raises its own confirm dialog and
the confirmation on the MFD engages the pilot — **no separate press on the pilot's own
control head** (dockside-proven 2026-07-05, and confirmed under way):

1. **Press Nav** on the MFD. The bridge arms the confirm window and puts the pilot
   into route: the pilot goes to **Track-pending** and the MFD raises its *engage
   nav?* dialog. (The pilot beeps here — it is waiting for confirmation.)
2. **Confirm on the MFD.** The dialog's OK sends the confirm key (`0x10`); the bridge fires
   the engage and the pilot latches **Track-engaged** — the same thing its own control head's
   Track confirm does. (A second **Nav** press confirms too.) This works whatever mode you
   engaged Nav from, **including from Wind** (dockside-proven 2026-07-14).

Under the hood the engage uses the SignalK **V1 `steering.autopilot.actions.advanceWaypoint`**
action (it emits the Raymarine Track-to-waypoint command, `65379 → 0x0181`). It does
**not** use the V2 `courseNextPoint` action, which `@signalk/signalk-autopilot` 2.6.0
leaves unimplemented. Because SignalK maps both Track-pending and Track-engaged to the
same `route` state, the bridge **sniffs the pilot's own `65379`** off the bus to tell
the two apart — so the MFD dialog clears exactly when the pilot really engages, and a
control-head confirm (if you use it instead) clears it too. Requires the pilot to have accepted
route first; if it hasn't, the engage is safely rejected rather than fired blind.

### Automatic waypoint advance (opt-in)

At each waypoint of a route the pilot enters Track-pending again and waits for the same
confirm. Under **Track waypoint advance**, set **Auto-confirm waypoint advance up to
(degrees)** above 0 and the bridge confirms that automatically when the course change to the
next leg is within the limit — so small turns sail through with no control-head press. Off by
default; larger turns always fall through to a manual confirm on the control head, and an
advance is never confirmed against an already-engaged pilot.

**What counts as an advance** is the destination moving, not the course changing.
`navigation.courseGreatCircle.nextPoint.position` stepping to a new waypoint is the signal.
That matters on autorouted routes, which scatter waypoints evenly along straight stretches:
those legs turn nothing at all, and a rule that required a measurable turn refused exactly the
waypoints that need no judgement.

**How the turn is sized** is from two sources, keeping whichever reads larger. One is the
change in `bearingTrackTrue`. The other is geometric — the bearing from the previous
destination to the new one, which is the new leg's course and does not depend on when the
plotter republishes anything. Neither is reliable alone. The bearing reads zero whenever the
plotter publishes the new destination a sample ahead of the new bearing, which is the common
case, so trusting it would let a large turn pass as "0°". The geometry overstates inside a
burst of destination changes, where the previous destination is not the new leg's origin. The
maximum of the two means a real turn cannot hide behind a stale bearing, and a geometry that is
wrong errs toward asking.

If neither source can size the turn against a leg change coincident with the pending, the
advance is left for a manual confirm.

### Automatic Track restart (opt-in)

Engaging Nav while off the rhumb line makes the pilot swing hard to intercept it. Pressing
**Restart** on the MFD re-origins the active leg onto the boat, so it steers straight at the
same waypoint instead — but the pilot treats that as a course change and goes Track-pending,
asking for a control-head Yes just as it does at a waypoint. Under **Track restart**, enable
**Auto-confirm a Track restart (leg re-origin)** and the bridge answers it, so the Restart
takes effect without touching the pilot's own head.

A restart is told apart from a waypoint advance by the **destination**: a re-origin keeps the
same waypoint, an advance moves to the next one, so the bridge compares
`navigation.courseGreatCircle.nextPoint.position` across the bearing jump. Distance to the
waypoint deliberately is *not* used — at an advance it steps from the arrival radius to the
next leg's length, which for closely spaced marks is barely a step at all, exactly the tight
water where the advance limit matters most.

Two limits stay in force whatever the setting. The turn is capped at **90°**: with the waypoint
abaft the beam a re-origin asks for a near-reciprocal turn, which is an involuntary gybe, and
that case is left on the control head. And the leg being re-origined must have been settled for
at least 5 s, so a re-origin landing inside a route-activation burst is not acted on.

> A Restart pressed a long way down a leg may move the bearing too little to register as a
> turn — 30 m off a 4.9 km leg is 0.3° — and with the destination unchanged there is nothing
> else to size it against, so that Restart still needs a control-head press.

This
setting is **independent of the waypoint-advance limit above** — you can have every waypoint
turn confirmed by hand and still not be asked for the restart you just pressed for. With it off,
behaviour is exactly as it was before the setting existed. Off by default; requires `live`.

> Course paths are only read while they are **fresh** (10 s). SignalK keeps a path's last value
> in the model forever after its source stops, so without that guard a deactivated route's leg
> would sit there and the first turn of the *next* route would be sized against it.

## Status webapp

The plugin bundles a small **status webapp** — open it from the SignalK **Webapps**
menu ("Navico autopilot bridge"). It draws the live data path — MFD → bridge → SignalK
→ provider → pilot, with its control head — and shows the current bridge mode, the pilot's
real state (standby / auto / wind / route-pending / route-engaged), whether a nav
confirm is pending, whether an autopilot provider is present, and the last button and
steer result. Each node is labelled with the **actual device** resolved off the bus —
the MFD, the pilot's course computer and actuator, the control head, and the V2 provider
instance — read from the server's N2K source registry (PGN 60928 + 126996), so you see
your real hardware, not generic roles. It is **read-only** (no settings; a link takes you
to the plugin config) and updates every 2 s.

## Known limitations

This is a beta; these are open:

- **No Drift maps to plain auto.** Raymarine's No Drift is a COG-referenced heading
  hold — where Auto holds a compass heading and lets leeway and current push the boat
  off the ground track — but nothing in the SignalK chain can ask for it:
  `SeatalkPilotMode16` `0x0181` ("No Drift, COG referenced") is decoded to `route` by
  `@signalk/n2k-signalk`, and `signalk-autopilot` already uses that same `0x0181` as its
  waypoint advance. So the button engages auto: the pilot holds a heading, it just does
  not compensate for drift.
- **Not every condition or pilot is covered.** Auto, ±course, Wind and the abort path
  are proven on the water across several outings in varied conditions, Tack/Gybe on one
  (2026-07-11), and Nav/Track engage plus multi-leg route sailing with waypoint advance
  under way (2026-07-15) — but behaviour may differ on other backing pilots. (How well
  the pilot *holds* a course is the pilot's own business; the bridge only commands the
  mode.)
- **The emulated AC can show up with empty Name and Serial in the MFD's device list** —
  and the MFD's commissioning wizard may not complete — if the CAN interface's transmit
  queue is too short. This is an **interface setting, not a plugin bug**; see
  [Empty name and serial](#empty-name-and-serial-in-the-device-list) below for the
  one-line fix.
- **Output is via loopback HTTP** with a configured token. There is no in-process
  **V2** path for a non-provider plugin: the whole command surface lives inside the
  server's express handlers, and `app.autopilotApi` exposes only provider registration.
  (SignalK's V1 PUT API is reachable in-process and would reach the same provider
  handlers without a token, but only because a plugin PUT bypasses the security check —
  the bridge does not take that route.)

## Troubleshooting

### Empty name and serial in the device list

If the emulated AC appears in the MFD's (or a Triton's) device list as a row with the
right manufacturer and function but **no Model Name and no Serial Number**, and the
commissioning wizard will not complete, the CAN interface's **transmit queue is too
short** to hold the product-info burst.

```sh
sudo ip link set can0 txqueuelen 128
```

Make it persistent next to wherever `ip link set can0 up` runs.

The plugin checks the queue and will tell you: the status line carries
`txqueuelen <n> -- too short for product info, raise to 128` while it is too short, and
the server log gets the full explanation once at startup. The check re-reads the value, so
raising the queue clears the warning without restarting anything. The queue belongs to the
host, so this is all the plugin can do about it.

Product info (`126996`) is 134 bytes, i.e. **20 fast-packet frames** sent back to back.
Many SocketCAN drivers default to `txqueuelen 10` — notably `mcp251x`, the driver behind
the common Raspberry Pi SPI CAN HATs — so the queue fills around frame 11 and the kernel
drops the rest. The drops are silent because canboatjs sends on a non-blocking socket
and does not inspect the `write()` result, so nothing surfaces as an error. Model ID and
the start of Software Version Code fit in the frames that do get out, which is why the
row appears at all; the Model Version tail, the whole Model Serial Code, Certification
Level and Load Equivalency sit past the cut and never reach the bus.

The default comes from the driver, so whether it bites depends on the adapter. A gateway
that is not a SocketCAN interface at all — an Actisense NGT over USB serial, say — cannot
hit this. Don't assume from the product name: the PiCAN boards are MCP2515 parts driven by
`mcp251x` like the cheap HATs. Check the interface itself:

```sh
ip -details link show can0    # look at qlen
```

Diagnosed by a user on a Pi 5 with an `mcp251x` HAT; the same default was then found on
the development boat, where raising it filled in the missing name and serial immediately.

This is **not specific to this plugin**. Anything broadcasting a long fast-packet on a
short transmit queue loses the tail — the SignalK server's own product info is the same
134 bytes, and it appeared as a nameless row in the MFD's device list until the queue was
raised, after which it listed as `signalk-server` with its serial.

## Scope

This emulates the **AC (the commanded device)** to capture an MFD's autopilot
control and re-target it. It does **not** implement a real Simrad pilot's steering
or active-controller takeover logic — it accepts and translates commands. The
commissioning values an MFD writes are never consumed by anything that steers;
the value here is the discovery/command protocol, not the commissioning data.

## License

MIT. The software is provided "as is", without warranty of any kind and without
liability on the part of the authors — see the
[Disclaimer](#disclaimer--no-warranty).
