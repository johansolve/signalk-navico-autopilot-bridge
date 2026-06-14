# signalk-navico-autopilot-bridge

> **Status: 0.1.0-alpha.** The core loop is proven on the water-adjacent dock
> (a real B&G Vulcan 7 driving a Raymarine EV-200 through this bridge), but
> several modes are not yet fully decoded or sea-trialled. See
> [Known limitations](#known-limitations). Use at your own risk and only with the
> boat secured.

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

## Install

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

## Configuration

| option | default | notes |
|---|---|---|
| CAN interface | `can0` | SocketCAN interface |
| Emulated AC model | `AC42` | `AC12` is what a Vulcan 7 was verified to bind to |
| Preferred N2K address | `35` | address the emulated AC claims |
| Broadcast the firehose | `true` | required for binding — leave on |
| Standard nav PGNs | `false` | duplicates other sources; A/B testing only |
| **Bridge mode** | **`dry-run`** | `off` / `dry-run` (decode+log) / `live` (steer) |
| Target autopilot id | `_default` | which `autopilots/<id>` the V2 API drives |
| SignalK host / port | `127.0.0.1` / `3000` | loopback API target |
| API token | — | Bearer token for `live` PUTs (Security → Access Requests) |
| Commissioning mode | `false` | emulate a control head to open the first-commissioning gate (see below) |
| Commissioning head address | `44` | address the emulated head claims (commissioning only) |

### ⚠️ Safety

- **Default is `dry-run`** — it decodes and logs commands but never steers. You
  must set `live` deliberately.
- Only switch to `live` with the **boat secured, engine off, and the pilot's own
  control head to hand** to drop to standby.
- Do **not** run this on a bus that already has a real Simrad/B&G AC — two devices
  broadcasting AP state will confuse control heads.

## On the MFD: enable the autopilot first

The MFD only shows its autopilot control view once it has discovered an AC. When
the emulator's firehose is running, a Navico MFD auto-detects it and adds an
**Autopilot** icon to the Settings menu. If the icon does not appear, run the
MFD's **source selection / auto select** so it picks up the autopilot source —
this is a prerequisite, the control view is unreachable until the autopilot is
enabled on the MFD. (See your Navico MFD's install manual — e.g. the B&G
Vulcan's *Software Setup → autopilot commissioning*.)

## First commissioning

A Navico MFD needs a control head on the bus to **start** its very first
commissioning of an AC. The plugin can emulate one (a B&G keypad on a second
address) so you can open the **"press standby"** gate without any physical Simrad
hardware:

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

## Verified behaviour (dockside, Vulcan 7 → EV-200)

- MFD binds to the emulator and raises a *lost-autopilot* alarm the instant the
  firehose stops.
- "Press standby" commissioning gate opens; dockside config fields populate.
- Control view reachable and live **without finishing the wizard**.
- Standby / Auto / Wind / Nav(Track) / ±course button presses decode and, in
  `live`, drive the EV-200 (clutch engages, rudder moves, P70 and the Vulcan
  overlay reflect the mode).

## Known limitations

This is an alpha; these are open:

- **Mode display in Wind/Track is a test candidate.** Per-mode firehose frames
  (from htool) are now sent so the overlay should follow auto/wind/route, but htool
  had not fully verified this and some frames are guesses — needs on-board
  confirmation. If wrong, the pilot is still in the correct mode (confirm on its
  own control head); only the Navico MFD's mode label may be off.
- **Tack is a test candidate.** Decoded as a ~90° ChangeCourse and mapped to the
  V2 tack endpoint, but never captured at the dock and dependent on the backing
  provider supporting tack.
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

MIT.
