# signalk-navico-autopilot-bridge

> **Status: 0.3.0-alpha.** The core loop is proven at the dock (a real B&G
> Vulcan 7 driving a Raymarine EV-200 through this bridge), but several modes
> are not yet fully decoded or sea-trialled. See
> [Known limitations](#known-limitations) and the
> [Disclaimer](#disclaimer--no-warranty) before using it.

Emulate a **Simrad AC12/AC42 autopilot computer** so a **Navico MFD** (B&G
Vulcan/Zeus, Simrad, Lowrance) binds to it and exposes its own **autopilot
control view**. The button presses that view puts on the NMEA 2000 bus (Simnet
`130850`) are decoded and translated into the **SignalK Autopilot V2 API**, which
drives whichever pilot backs it — for example a Raymarine EV-200 via
[`signalk-raymarine-autopilot`](https://github.com/SignalK/signalk-raymarine-autopilot).

In other words: **press the autopilot buttons on a Navico plotter, steer a
non-Navico pilot.** The bridge is Navico/Simrad-specific on the *input* side (only
Navico MFDs bind to a Simrad AC) and **provider-agnostic on the output side**
(anything that implements the SignalK V2 Autopilot API).

## Disclaimer / no warranty

**An autopilot steers the boat. This software can move the rudder.** Read this
before you install it.

- **Alpha, experimental, unofficial.** This is a reverse-engineered emulation of
  a proprietary Simrad device, built from bus captures — not from any
  manufacturer specification. It is not affiliated with, endorsed by, or
  supported by Navico, B&G, Simrad, Lowrance, Raymarine, or the SignalK project.
  Behaviour may change or break with any firmware, plugin, or canboatjs update.
- **Not safety-rated.** It is **not** certified for marine navigation and must
  **not** be relied on as a primary or sole means of steering or watchkeeping. A
  competent helmsman must remain at the helm, keep a proper lookout, and be ready
  to take manual control and drop the pilot to standby at all times.
- **It can fail silently or behave unexpectedly** — wrong mode, wrong course,
  no response, or a course change at the wrong moment. Several modes (Wind,
  Track, Tack) are unverified test candidates. Do not trust it where a failure
  could cause a collision, grounding, injury, or loss of life.
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
plugin reproduces that broadcast faithfully (byte templates taken verbatim from a
real AC42 in `canboat/samples/ac42-commissioning.raw`), which is what makes the
MFD bind to it and unlock the control view.

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
   (per the Vulcan manual those functions require a Sail boat type).
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

This is an alpha and not (yet) in the SignalK app store. Install from source into
the server's plugin directory:

```sh
cd ~/.signalk/node_modules
git clone <repo> signalk-navico-autopilot-bridge
# @canboat/canboatjs is a peerDependency and is already present in a SignalK
# server install; no separate npm install is needed.
```

Restart the SignalK server, then enable and configure the plugin under
**Server → Plugin Config**.

### 2. Configure the plugin

| option | default | notes |
|---|---|---|
| CAN interface | `can0` | SocketCAN interface |
| Emulated AC model | `AC42` | both `AC42` and `AC12` bind a Vulcan 7; the model only sets the reported product info, not whether it binds |
| Preferred N2K address | `35` | address the emulated AC claims |
| Broadcast the firehose | `true` | required for binding — leave on |
| Standard nav PGNs | `false` | duplicates other sources; A/B testing only |
| **Bridge mode** | **`dry-run`** | `off` / `dry-run` (decode+log) / `live` (steer) |
| Target autopilot id | `_default` | which `autopilots/<id>` the V2 API drives |
| SignalK host / port | `127.0.0.1` / `3000` | loopback API target |
| API token | — | Bearer token for `live` PUTs (Security → Access Requests) |
| Commissioning mode | `false` | emulate a control head to open the first-commissioning gate (see below) |
| Commissioning head address | `44` | address the emulated head claims (commissioning only) |

#### ⚠️ Safety

- **Default is `dry-run`** — it decodes and logs commands but never steers. You
  must set `live` deliberately.
- Only switch to `live` with the **boat secured, engine off, and the pilot's own
  control head to hand** to drop to standby.
- Do **not** run this on a bus that already has a real Simrad/B&G AC — two devices
  broadcasting AP state will confuse control heads.

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

Fix: pin the real pilot as the authoritative source for these paths in
`~/.signalk/settings.json` (`sourcePriorities`), with an **empty timeout** so the
emulator can never take over:

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

Find `<real-pilot-source>` by reading the path and picking the source in `values`
that reports the correct mode (not the emulator's `heading`):

```sh
curl -s http://localhost:3000/signalk/v1/api/vessels/self/steering/autopilot/state
```

A non-empty timeout (e.g. `10000`) is **not** enough: the real pilot may not
re-publish state every few seconds at rest, so the emulator's ~2 Hz firehose wins
again between updates. Use `""`. Restart the server after editing.

## Protocol details

Reference for the reverse-engineered N2K layer; not needed to set the plugin up.

### Command decoding

canboatjs 2.10 has an incomplete `130850` definition for this Simnet layout, so
the bridge decodes on the raw **key byte**, gated by group `0x0a`, not on
canboat's mislabeled `Event` field. Keys verified live against a Vulcan 7:

| key (byte 6) | command | maps to |
|---|---|---|
| `0x06` | Standby | `PUT state {standby}` |
| `0x09` | Auto | `PUT state {auto}` |
| `0x0f` | Wind | `PUT state {wind}` |
| `0x0a` | Nav / Track | `PUT state {route}` |
| `0x1a` | ChangeCourse / Tack | `PUT target/adjust`, or `POST tack/*` for ~90° |
| `0x0c` | No Drift | decoded, not fired (no V2 state) |
| `0x1c` | key-press envelope | ignored (precedes every command) |

**ChangeCourse** (`0x1a`): byte 8 = direction (`0x03` starboard/+, `0x02`
port/−), bytes 9–10 = magnitude LE16 at `0.0001 rad/bit` (10° = 1745, 1° = 174).
canboat's `Angle` reads bytes 8–9 (off-by-one) and is wrong for this command, so
the bridge decodes from the reassembled raw frame. The V2 `adjustTarget` floors
`radiansToDegrees`, and some providers accept only exactly ±10/±1, so the magnitude
is rounded to a whole degree `N` and sent as `(N+0.5)°` in radians, landing the
floor exactly on `N`.

**Tack** rides the same `0x1a` channel at the MFD's configured tack angle
(B&G Vulcan UI default 100°; htool saw 90°), not a separate key. A single
ChangeCourse well above the buttons' ±10 is treated as a tack — but **only in
wind mode**, where a tack crosses the wind (a gybe crosses dead downwind);
outside wind mode a big ChangeCourse is ignored. The magnitude is discarded: the
pilot mirrors the apparent wind angle itself. The tack **direction is derived
from SK's `environment.wind.angleApparent`** (positive to starboard → tack to
starboard), not the unverified MFD dir byte, and mapped to
`POST tack/port|tack/starboard`
(channel per [htool](https://github.com/htool/RaymarineAPtoFakeNavicoAutoPilot)).
Test candidate — depends on the backing provider supporting tack, and the
turn-direction convention still needs on-board verification.

### Mode display (firehose)

The MFD's displayed mode is driven by the firehose, not by the button press. Per
htool, `65305` `00,1d,..` sets the displayed mode and `00,0a,..` the state; the
plugin sends distinct per-mode `65340`/`65302`/`65305` frames (auto `10,01`, wind
`10,03`, nav `10,06`) plus a mode-change announce. **Test candidates** — htool had
not fully verified the wind/route overlay and some frames are his guesses.

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

## Verified behaviour (dockside, Vulcan 7 → EV-200)

- MFD binds to the emulator and raises a *lost-autopilot* alarm the instant the
  firehose stops.
- "Press standby" commissioning gate opens; dockside config fields populate.
- Control view reachable and live **without finishing the wizard**.
- Standby / Auto / Wind / Nav(Track) / ±course button presses decode and, in
  `live`, drive the EV-200 (clutch engages, rudder moves, P70 and the Vulcan
  overlay reflect the mode).
- **Set heading** displays on the MFD (both the overlay and the AP view) via the
  populated `127237`; ±course on the Vulcan changes it and is confirmed on the
  MFD without touching the pilot's own head.

## Known limitations

This is an alpha; these are open:

- **Route/Track display crashes the MFD's AP view.** Opening the dedicated
  autopilot view from scratch while in Nav crashes a Vulcan 7 (it recovers and
  rebinds). The cause is confirmed to be the unverified route display frames
  (`65302`/`65305`, htool guesses): substituting the proven auto frames stops the
  crash, but showing "Auto" while tracking is poor UX so the route frames are kept.
  Steering in Nav works, and *switching* to Nav while the AP view is already open
  works — only opening the view from scratch in Nav crashes it. A correct fix needs
  a capture of a real Simrad AC in route mode. Until then, avoid opening the AP view
  while in Nav.
- **Wind-mode values are not emitted, which disables Tack.** In Wind the MFD shows
  no commanded wind angle and no true wind direction (TWD), and **greys out the
  Tack button**, because the emulator's `65341` always carries heading, not a wind
  reference. Tack is decoded (~90° ChangeCourse → V2 tack endpoint) but cannot be
  triggered from the MFD until the wind angle is reported. Needs a capture of a real
  Simrad AC in wind mode to get the right frame/field.
- **Mode label in Wind/Track is otherwise a test candidate.** Per-mode firehose
  frames (from htool) are sent so the overlay should follow auto/wind/route, but
  some frames are guesses. If wrong, the pilot is still in the correct mode (confirm
  on its own control head); only the Navico MFD's mode label may be off.
- **No Drift (`0x0c`) has no V2 equivalent** — the V2 states are only
  standby/auto/wind/route. Logged, never fired.
- **±course / Wind / Track are only exercised at the dock.** The EV-200 does
  engage and hold Auto at the dock (it moves the rudder), so the command path
  itself is verified — but actual course-, wind- and route-holding *quality* can
  only be judged with way on, so the full envelope still needs a sea trial. (Auto
  hold-at-dock behaviour may differ on other pilots.)
- **Output is via loopback HTTP** with a configured token. An in-process V2 call
  would remove the token requirement but there is no clean documented path for a
  non-provider plugin to set V2 state; this is a candidate for a later version.

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
