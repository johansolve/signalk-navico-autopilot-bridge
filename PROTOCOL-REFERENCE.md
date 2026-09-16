# Protocol reference — Simnet autopilot over NMEA 2000

What the bridge decodes from a Navico/B&G MFD and what it emits back as a fake
autopilot computer (AC). This is the consolidated reference; the byte constants
live in `lib/ac-emulator.js` and the higher-level rationale in the `README.md`
[Known limitations](README.md#known-limitations).

All PGNs here are **proprietary to Navico** (Manufacturer Code **1857**, Industry
Code **4 = Marine**). There is no public NMEA spec; every field below is
reverse-engineered from bus captures. Autopilot control is **Simnet**, not Naviop.

**Source tags** used in the tables:

| tag | meaning |
|---|---|
| `sea-trial` | proven live against the EV-200 on the water / at the dock |
| `nac3-wind` | Kees' NAC-3 wind capture `candump/nac3_wind.raw` (2026-06-30) |
| `nac3-nav` | Kees' NAC-3 nav-mode capture `candump/nac3_nav_mode.raw` (2026-06-30) |
| `ac42-comm` | Kees' AC42 commissioning capture `ac42-commissioning.raw` (src 13) |
| `merrimac` | Kees' `candump/AUTOPILOT_CONTROL.md` (merrimac-rs, a *different* MFD dialect) |
| `htool-guess` | inherited from htool/RaymarineAPtoFakeNavicoAutoPilot, unverified |
| `code` | read out of canboatjs / this plugin's own source, not off a bus |
| `vulcan9-set` | Vulcan 9 `Settings → Autopilot` writes, captured against this emulator and cross-checked against the AC's readback |
| `issue-1` | reported by a user on issue #1 (a Vulcan 9 and a Triton²) |

> **Kees' raw candumps are unfiltered — never commit `nac3_wind.raw`,
> `nac3_nav_mode.raw`, or `AUTOPILOT_CONTROL.md` into any repo without his ok.**
> This file distils findings from them; the raw frames stay out.

---

## 1. Addressing & identity

- The AC claims an address and answers ISO requests so the MFD binds to it.
  **PGN 60928 ISO Address Claim** with **Device Function 150** = autopilot; the
  MFD discovers the AC by scanning for a live, complete pilot (not by a fixed
  address). `sea-trial`
- The bridge's fake-AC uses `preferredAddress` **35 (0x23)**; a real NAC-3 in the
  capture sits at **17 (0x11)**. This address is the **target byte** in every
  130850 command (see below).
- NAME template `0xC0509600E8200000` (devFunc 150, devClass 40, IndustryGroup 4,
  mfr 1857, arbitrary-address-capable). Product model `"AC42"` / `"AC12"`, SW
  `"1100"`. The real AC42 sends no **126993** heartbeat and no **126998**
  `ac42-comm`; for **126464** the evidence is the firmware, not the capture — no
  literals for it in the image (`n2k_research SUBSYS-can-nmea2000 §5.6`).
- **The emulator is not identical to that, and the difference comes from canboatjs
  rather than from this code.** Its `CanDevice` sends a **126993** heartbeat on a
  60 s timer and answers an ISO request for **126464** with its transmit list, on
  2.x and 3.x alike. Only **126998** really is absent, and on 3.x not for the reason
  2.x makes it absent: up to 3.16 it is built from a `serverUrl` / `serverVersion` this
  plugin does not pass, and from 3.17 from `app.config` — which is missing because the
  plugin hands `Canbus` a bare `EventEmitter` as its `app`. Nothing has ever suggested
  an MFD objects to the two extra PGNs, but the line above describes the real AC42, not
  what goes on the wire here. `code`
- The address claim is handed to canboatjs in the shape the resolved version
  encodes, chosen by probing the encoder at startup — see `pickAddressClaim` in
  `lib/canboat-compat.js`. Getting this wrong is silent and total: from canboatjs
  3.19 a top-level claim reaches the bus as `e1 b9 fa ff ff ff ff ff` (manufacturer
  2047, device function 255, device class 127) `code`. The device still lists and can
  still be selected as a source, and neither display that has met it — a Vulcan 9 and a
  Triton² — ever accepted it as a live pilot. `issue-1`
- **The transmit list is not a statement about what this emulator sends.** The
  plugin does not set `disableDefaultTransmitPGNs`, so canboatjs unions `TX_PGNS`
  with its own device and default lists: the 126464 reply advertises **38 PGNs, of
  which 24 are never transmitted** with the shipped defaults. Those are canboatjs'
  own defaults (127488, 129025, 130306 …), **130851** — the AC's command reply, which
  `TX_PGNS` declares for identity and the emulator does not implement — and 127245 /
  127250, which only go out with `enableStdPgns` on. Nothing has ever asked for any of
  them. `code`

---

## 2. INPUT — 130850 command frames (MFD → AC)

### 2.1 Byte layout

Mode command, frame **targeted at the AC** (12 bytes, fast-packet):

```
b0  41    Mfr+Industry low  (1857 / ind 4)
b1  9F    Mfr+Industry high
b2  <ac>  Controlling device = target AC address (0x23 bridge, 0x11 NAC-3)
b3  FF    reserved
b4  FF    reserved
b5  0A    group  (canboat decodes this as fields.Event "Nav mode")
b6  <key> command  (canboat decodes this as fields["Unused B"])  <-- THE COMMAND
b7  00    spare  (key is nominally LE16 b6..b7; b7 is always 00 here)
b8..b11   FF     (mode commands carry no payload)
```

> **canboat 2.10 quirk:** its 130850 definition for this layout mislabels the
> command. It puts the group byte (`0x0a`) in `fields.Event` and the real command
> byte in `fields["Unused B"]`. **Decode on `Unused B`, gated on group `0x0a`.**
> Early versions that read `fields.Event` mapped *every* command to "route".

### 2.2 Command / key catalog

`key` = byte 6. What the **B&G/Navico MFD** (Vulcan 7, Triton²) sends:

| key | name | bridge action | fires? | source |
|---|---|---|---|---|
| `0x06` | Standby | `PUT /state {standby}` | yes | `sea-trial` |
| `0x09` | Auto | `PUT /state {auto}` | yes | `sea-trial` `nac3-nav` |
| `0x0a` | Nav/Track | `PUT /state {route}` | yes | `sea-trial` `nac3-nav` |
| `0x0f` | Wind | `PUT /state {wind}` | yes | `sea-trial` `nac3-nav` |
| `0x11` | Tack/Gybe | derive side from AWA → `POST /tack/{dir}` | yes (wind, engaged) | `sea-trial` |
| `0x1a` | ChangeCourse | ±angle → `PUT /target/adjust` | yes | `sea-trial` `nac3-nav` |
| `0x0c` | NoDrift | `PUT /state {auto}` | yes | dockside 2026-07-22 |
| `0x10` | Nav confirm (MFD Yes) | `advanceWaypoint` (only while nav-pending) | yes | dockside 2026-07-14 |
| `0x1c` | key-press envelope | — (precedes every command) | ignored | `sea-trial` |
| `0x2b` | *(bus mode-change announce)* | — (broadcast, not to the AC) | ignored | `nac3-nav` |

Notes:
- `0x0c` was long carried as a guess (logged, never fired). Confirmed 2026-07-22 from
  the bridge's own diagnostic log: the Vulcan sent it with the same `0x1c` envelope and
  the same frame layout as Auto and Wind, in a sequence with both. It maps to plain
  **auto**, because the EV-200 has no COG-referenced hold to ask for: `SeatalkPilotMode16`
  carries four modes on distinct high bits, and `0x0181` is `Track | 1`, the Track-engaged
  sub-mode (§5) that `signalk-autopilot` sends as its `advanceWaypoint`. Auto is the
  honest approximation: the pilot holds a heading, it just does not compensate for drift.
  Confirmed dockside the same day: pressing No Drift engages the pilot, and **both** the
  MFD and the p70s report Auto. Whether the plotter can latch a No Drift label of its own
  is untested — the bridge was reporting `auto` at the time, so it was never given
  anything else to show. A provider that *does* offer a COG hold is not asked for it
  either: the key maps to `auto` before any provider vocabulary is involved (#17).
- `0x10` was first seen as a single undecodable sample from a second head. It is the
  **MFD's nav-confirm Yes**, proven dockside 2026-07-14: one press takes the pilot from
  Track-pending (`0x0180`) to Track-engaged (`0x0181`). It only fires while nav-pending.
- `0x2b` is emitted **broadcast** (b2=`0xFF`, b4=`0x64`) right after each mode
  change — a bus-wide announce, not a command directed at the AC.

### 2.3 ChangeCourse (`0x1a`) payload

```
b6  1A    ChangeCourse
b7  00    spare
b8  <dir> 0x03 = starboard / +,  0x02 = port / -
b9  <lo>  magnitude LE16 @ 0.0001 rad/bit
b10 <hi>
b11 FF
```

10° = 1745 = `0x06D1`, 1° = 174 = `0x00AE`. canboat's `Angle` field reads b8-b9
(off-by-one) and folds in the direction byte → **garbage, do not use `f.Angle`**.

> **Rounding fix (critical):** SK V2 `adjustTarget` does
> `Math.floor(radiansToDegrees(value))` and `putAdjustHeading` (raymarinen2k.ts)
> only accepts exactly ±10/±1. Simnet's 1745 = 9.997° floors to 9 → "Invalid
> adjustment: 9". The bridge rounds to whole degrees N and sends `(N+0.5)°` in
> radians so the floor lands on N.

### 2.4 Tack/Gybe (`0x11`)

`41 9F <ac> FF FF 0A 11 00 00` — **no direction, no magnitude**. The MFD picks the
button *label* (Tack when the wind is forward, Gybe when aft) but sends the same
key; the pilot derives tack-vs-gybe and the turn side from the wind. The bridge,
only in wind mode with the pilot engaged and SK state fresh, derives
`isGybe = |AWA| > 90°` and `dir = (AWA>0) === isGybe ? 'port' : 'starboard'`, then
`POST /tack/{dir}`. **Requires the pilot's Gybe Inhibit = *Allow Gybe*** to gybe
away from the wind. `sea-trial`

### 2.5 MFD dialects diverge — this bridge follows B&G

`merrimac`'s `AUTOPILOT_CONTROL.md` documents a **different** command encoding
(what merrimac-rs *sends*): standby 6, heading 9, **wind 11 (`0x0b`), nav 13
(`0x0d`), nodrift 15 (`0x0f`)**, changecourse 26. The **B&G MFD** the bridge
listens to instead sends **wind `0x0f`, nav `0x0a`**, re-confirmed by `nac3-nav`.
The catalog in §2.2 is the B&G dialect. Don't cross-wire the two.

---

## 3. OUTPUT — state/telemetry frames (AC → bus)

The AC firehoses these so the MFD binds and shows the mode. The bridge emulates an
**AC12/AC42**; a real **NAC-3** differs in what it emits (noted per PGN). Frames
below are the bridge's current constants unless a ground-truth column says otherwise.

### 3.1 PGN 65341 — AP angle/mode (2 Hz)

Field selector at **byte 4**; value LE16 at bytes 6-7 (rad × 10000, unsigned).

| mode | frame | selector | value | source |
|---|---|---|---|---|
| wind | `41 9f ff ff 03 ff <awa_lo> <awa_hi>` | `0x03` | commanded apparent wind angle | `nac3-wind` |
| auto | `41 9f ff ff 02 ff <hdg_lo> <hdg_hi>` | `0x02` | locked heading | `sea-trial` |
| route (pending) | `41 9f ff ff 0d ff <hdg_lo> <hdg_hi>` | `0x0d` | course-to-confirm (NAC-3: ~14°) | `nac3-nav` |
| route | `41 9f ff ff 0a ff 00 00` | `0x0a` | 0 (heading-to-steer rides 127237) | `nac3-nav` |
| standby | rotates `ANGLE_STATIC`: `…ff 0d ff ff 7f` / `…0c…` / `…0b…` / `…03…` | `0x0d`/`0c`/`0b`/`03` | NA | `ac42-comm` `htool-guess` |

- **Standby divergence:** the NAC-3 ground truth in standby is field `0x02` NA
  (`41 9f ff ff 02 ff ff ff`, `nac3-wind`); the bridge instead cycles the AC42
  commissioning statics. Harmless (all NA) but not ground-truth-matched.
- Wind field-`0x03` pinned by `nac3-wind`: at engage the value matched the live
  130306 apparent wind angle **to the bit**, then tracked the ChangeCourse nudges.
  `rad16`'s unsigned wrap maps SK's signed AWA (port negative) onto the AP's 0–360°.
- Route field-`0x0a` is the fix for the Nav-view crash: previously route fell to the
  field-`0x02` heading frame, and an auto/heading field under an active route
  crashed the Vulcan's AP view. See README.
- Route field-`0x0d` is the **nav-confirm pending** frame, carried between the first
  Nav press and the confirm (see §6). It holds a course-to-steer to confirm (NAC-3:
  `0d,ff,27,07` / `0d,ff,85,09`); the bridge fills it with the target/current heading.

### 3.2 PGN 65305 — device status (2 Hz)

Two sub-frames, selector at **byte 3**; status word LE16 at bytes 4-5. **Byte 2 is
`0x64` on the NAC-3 but `0x00` on the bridge** (emulated-model discriminator; wind
displayed correctly with `0x00`, so it is treated as harmless).

Selector-`0x0a` status word is a per-mode bitfield — ground truth `nac3-wind` +
`nac3-nav`:

| mode | selector-`0x0a` status word | selector-`0x02` value | source |
|---|---|---|---|
| standby | `0x0008` | `0x0002` | `nac3-wind` |
| auto | `0x0010` | `0x0010` | `nac3-nav` |
| wind | `0x0400` | `0x0010` | `nac3-wind` |
| route (pending) | current mode `\| 0x0080` (from auto → `0x0090`, from wind → `0x0480`) | `0x0010` | `nac3-nav` |
| route | `0x0040` | `0x0110` | `nac3-nav` |

- **Pending status word is mode-dependent**, not a constant: the `0x0080` "confirm
  requested" bit ORed onto whatever mode you engage Nav *from* (auto → `0x0090`,
  wind → `0x0480`). The bridge derives it in `send65305` as
  `(commandedMode === 'wind' ? 0x0400 : 0x0010) | 0x0080`. This is the bit that drives
  the MFD's confirm dialog (see §6).
- **Route selector-`0x02` = `0x0110` lags the latch.** In `nac3-nav` sel-`0x02` stayed
  `0x0010` through pending *and* the first ~15 s of engaged route, only flipping to
  `0x0110` mid-leg — so `0x0100` is leg/XTE data, **not** a route-latch marker. The
  bridge emits `0x0110` immediately and the Vulcan tolerates it, but don't read the
  bit as "route engaged".
- The bridge does not match every ground-truth status word: its auto is `0x0016`
  (vs `0x0010`) and its standby is `0x000a` (vs `0x0008`) — extra spare bits. Neither
  crashes, so both are left as-is; only the route frames were corrected (§3.1/§3.2).
- A mode change also emits the `MODE_CHANGE_65305` announce
  (`41,9f,00,1d,81,00,00,00` / `…80…`) that drives the MFD's displayed mode label.
  `htool-guess`

### 3.3 PGN 65340 / 65302 — pilot state (1 Hz)

> **The NAC-3 emits neither 65340 nor 65302, in any mode** (`nac3-nav`: zero frames
> from any source). **A real AC42 emits both**, from src 13 in `ac42-comm` — 65340 as
> the pilot-state frame tabled below, 65302 as a single 32-bit value report
> (`41 9f 0a 2b 00 00 00 ff`). The bridge emulates an AC42, so it sends both, at 1 Hz.
>
> **Dropped 2026-07-22, restored 2026-08-06.** The dockside test that dropped them
> suppressed both and found the MFD still bound and the mode label still tracking every
> state change (standby → auto → wind → nav). That test stands — but "an already-bound
> plotter does not need them" is a narrower result than "nothing needs them", and it
> was doing double duty as the second. Looking like the device you claim to be is
> reason enough for two frames a second.
>
> **This is not a fix for the first-commissioning reports, and must not be read as
> one.** Issue #1 was filed 2026-07-18, four days *before* the drop, against
> 0.7.0-beta (npm, 2026-07-15) — a build that sent both. That plotter failed with the
> frames on the wire, and failed again on 0.7.3-beta without them. The transmit set is
> now byte-identical to 0.7.0-beta, i.e. exactly what it already failed on. Whatever
> the Vulcan 9 and the Triton² are missing, it is not these.
>
> Restored **unchanged**, not corrected to ground truth. The capture has AC42 standby
> at `41 9f 0a 2b …` where the shipped htool row says `0a 6b`, and the 65302 route row
> is htool's own explicit guess — but these exact bytes ran on the reference rig from
> 0.1.0 through 0.7.0-beta, and correcting values while re-enabling transmission in one
> step would leave nothing to attribute a new symptom to. Fix the bytes separately, if
> a capture ever justifies it. They have **not** run against the 0.8.x Track-pending
> logic — the one thing to watch on the next Track sea trial.

65340 Pilot State:

| mode | frame | source |
|---|---|---|
| standby | `41 9f 00 00 fe f8 00 80` | `ac42-comm` |
| auto | `41 9f 10 01 fe fa 00 80` | `ac42-comm` |
| wind | `41 9f 10 03 fe fa 00 80` | `htool-guess` |
| route | `41 9f 10 06 fe f8 00 80` | `htool-guess` |

65302 (all effectively `htool-guess`): standby
`41 9f 0a 6b 00 00 00 ff`, auto `41 9f 0a 69 00 00 28 ff`, wind
`41 9f 0a 69 00 00 30 ff`, route `41 9f 0a 6b 00 00 28 ff`.

### 3.4 PGN 127237 — Heading/Track Control (5 Hz)

Populated so the MFD shows the set heading (blank "- - -" without it). Steering
Mode = Heading Control, Heading Reference = Magnetic (byte 1 `0x44`),
Heading-To-Steer = locked heading (bytes 5-6). Sent at 5 Hz because other devices
broadcast 127237 with an empty steer value at 10-20 Hz and would otherwise blank
ours. `sea-trial`

### 3.5 Other firehose (1 Hz)

`65420` `41 9f ff ff ff ff f1 ff` · `130860` (23 B, mostly NA) · `128275` (14 B,
NA). **Standard PGNs (127245 rudder / 127250 heading / 127237 as A/B) duplicate the
Raymarine bus and are off by default** — enable only for A/B testing.

---

## 4. Mode state machine (`nac3-nav`)

Modes: **standby / auto / wind / route.** Observed on the NAC-3 driving a real leg
(activate waypoint → nav from wind → auto → nav → arrival → auto → wind):

- **Wind → Nav is a hard reject.** A NAV command issued in wind does **not** engage
  route; the AP hangs in the **65341 field `0x0d`** (nav-pending). It held there for
  ~8 s in the capture, but that was just the time until **Auto** was pressed (which
  forces it out) — **not** the AP's own pending timeout, which the capture doesn't pin.
- **Route is reached via Auto → Nav.** From auto, NAV passes through field `0x0d`
  (pending) and latches to field `0x0a` (route) on a **second** Nav press. That
  two-press = the confirm handshake — see §6 for how the bridge emulates it.
- **Arrival → Auto.** On waypoint arrival the MFD commanded Auto (key `0x09`) and
  the AP dropped route to heading-hold. No arrival alarm (130850 alarm-class /
  130856) appeared in the capture — the transition was MFD-driven.

The NAC-3 capture showed the MFD sequencing **Auto then Nav**; a **B&G Vulcan from
standby sends only Nav (`0x0a`)** and the EV-200 goes standby → pending directly
(`sea-trial`, `nav_test*`). Either way the bridge relays each command as it arrives
and needs no sequencing logic. `commandedMode` is optimistic (set on the button); the
firehose is corrected to the pilot's real SK state in live mode.

---

## 5. OUTPUT side of the *real* pilot (EV-200, Raymarine mfr 1851)

For reference — how the EV-200 reports its own state back. The bridge reads most of
these via SK, but **sniffs 65379 directly off the bus** (see §6):

- **65379 Pilot Mode** (src 204, header `3b,9f`, mode word LE16 at bytes 2-3). Strings:
  `"Auto, compass commanded"` / `"Vane, Wind Mode"` / `"Track Mode"`. Ground-truth mode
  words (`sea-trial`, `nav_test*`): **`0x0000` standby / `0x0040` auto / `0x0180`
  Track-pending (beeping, awaiting confirm) / `0x0181` Track-engaged.** `n2k-signalk`
  4.6.0 maps mode 128/129 + subMode 1 → SK state `'route'`, so SK cannot tell pending
  from engaged — which is why the bridge sniffs the raw word.
- **65345 Pilot Wind Datum** — the locked target wind angle, **unsigned 0..2π** @
  0.0001 rad (port is 180–360° on the wire, *not* negative). SK core already maps
  it to `steering.autopilot.target.windAngleApparent` and sign-converts to −π..π;
  emitted **only in wind mode**.
- **65360 Locked Heading** + **65359 Pilot Heading** + 127250; 126720 raw (header
  `3b,9f`).

---

## 6. Nav engage & confirm handshake

Engaging Nav/route is a **two-press** flow, mirrored from the NAC-3 (§4) so the MFD
raises its own confirm dialog, and wired so the **MFD confirm engages the EV-200
without a separate P70 press** (`sea-trial` 2026-07-05, `nav_test5`).

**Nav press #1 — arm pending + request engage:**
- Bridge sets `navPending`, sends `PUT /state route` → the EV-200 goes to
  **65379 `0x0180` (Track-pending)** and starts beeping for confirmation.
- Firehose emits the pending frames: **65305** selector-`0x0a` = mode `| 0x0080`
  (§3.2) and **65341** selector-`0x0d` (§3.1). The MFD's "engage nav?" dialog is
  driven by that **`0x0080` bit**.

**Nav press #2 — the MFD confirm:** the dialog's OK button sends a **byte-identical
second `0x0a`** (there is no distinct confirm opcode). The bridge then fires the
engage:

> **Engage = V1 PUT `steering.autopilot.actions.advanceWaypoint`, NOT V2
> `courseNextPoint`.** `@signalk/signalk-autopilot` **2.6.0** (what runs on Libelle)
> **stubs the V2 action** (`throw 'Not implemented!'` → HTTP 500), but registers the
> V1 PUT handler → `putAdvanceWaypoint`, which emits **65379 `0x0181`
> (Track-engaged)** — the exact `126208`-group-function the P70's Track confirm sends.
> Guarded server-side by `state === 'route'` (a free safety: no route PUT → no engage).
> The bridge uses `PUT /signalk/v1/api/vessels/self/steering/autopilot/actions/advanceWaypoint`.

**Why the P70 never reacts to the MFD confirm:** `130850` is **Simnet** (Navico); the
EV-200 is **Raymarine** and ignores it entirely. The only MFD→EV-200 path is the
bridge (`130850` → SK → `126208`).

**Latch / abort via the 65379 sniffer.** SK maps both `0x0180` and `0x0181` to
`'route'`, so it can't tell pending from engaged. `reconcileNavPending` (2 Hz) reads
the sniffed word (§5): latch the MFD display on observed **`0x0181`** (covers a
P70-only confirm too), and clear the pending dialog if the pilot leaves the flow
(e.g. Standby → `0x0000`). A 20 s timeout is the anti-stuck fallback.

**Provider requirement.** The bridge's OUTPUT half needs an **Autopilot V2 provider**
with a default pilot (on Libelle: `@signalk/signalk-autopilot`, `raymarineN2K` →
EV-200). Without one the bridge still binds the MFD and decodes buttons (firehose /
dry-run) but **cannot steer**. It detects the absence from an **empty V2 autopilots
list** (`GET /autopilots` → `{}`) — not from `/autopilots/<id>`, which returns **500**
(not 404) with no provider — and surfaces `NO AUTOPILOT PROVIDER` in its status. The
bridge is provider-agnostic: any pilot reachable through the SignalK autopilot API that
supports `state` and the V1 `advanceWaypoint` action works.

---

## 7. Commissioning — 130845 key/value store

130845 carries a key/value parameter store: a 16-bit key, a value, and an operation
byte selecting read, write or value report. The MFD's dockside-config and
commissioning wizard reads and writes every pilot parameter it shows over this PGN.
The AC is not the only server on the bus — in `ac42-comm` the same wizard also reads
an SCX-20 satellite compass.

Figures below are counted from `ac42-comm` (478 × 130845 between five displays, the
AC42 at `0x0d` and the SCX-20 at `0x34`) unless another tag says otherwise.

### 7.1 Frame layout

Fast-packet, 14 bytes. Requests and replies share one layout.

```
b0  41    Mfr+Industry low  (1857 / ind 4)
b1  9F    Mfr+Industry high
b2  <ac>  scope: device address (0x0d captured AC42, 0x23 bridge); FF = bus-wide
b3  FF
b4  FF    FF while b2 addresses one device; 01 on the broadcast form
b5  FF
b6  <klo> key, LE16 low
b7  <khi> key, LE16 high
b8  00    spare (00 in all 478 frames)
b9  <op>  00 read · 01 write · 02 value report
b10..b13  value, LSB first, unused bytes FF
```

- **The target is byte 2; the PGN destination is always 255.** All 478 frames,
  replies included, are broadcast at the N2K level. A device serves the frames whose
  byte 2 holds its own address. In a request byte 2 names the device asked; in a value
  report it names the device the value belongs to, which is the sender (§7.2).
- **Value width is a property of the key**, `ff`-padded to the frame: 1 byte
  (`0x0A18` = `00,ff,ff,ff`), 2 (`0x0109` = `dc,17,ff,ff`), 4 (`0x0914` =
  `c1,0a,00,00`). Frame length is 14 in every case.
- **Priority:** AC42 value reports 2, display reads and writes 3. The bridge replies
  at 3. Whether the priority is significant is unknown.

### 7.2 Operations

A cell is addressed by **scope and key**. The scope is byte 2: a device address selects
that device's own parameter store, `ff` (with b4 = `01`) a bus-wide store several
devices take part in. Each op acts on one cell.

| op | sender | acts on the addressed cell by | frames in `ac42-comm` |
|---|---|---|---|
| `0x00` read | display → device | asking for its value; the frame carries none (`ff` padding) | 386 (66 to the AC, 320 to the SCX-20) |
| `0x01` write | display → device, or broadcast | assigning the value it carries | 38 (4 addressed to the AC, 34 broadcast) |
| `0x02` value report | device → bus | stating its value | 54, all from the AC |

**Only a value report carries an authoritative value, and it is not directed at
whoever asked.** Byte 2 names the device the value belongs to, so the AC's reports
carry its own address — all 50 addressed reports in the capture do — never the
requester's. The op appears in three ways, with nothing in the frame to tell them
apart:

1. **answer to a read**, same key, 0–55 ms after it;
2. **acknowledgement of a write**, same key and value, 0–46 ms after it;
3. **unsolicited**, broadcast, with no request preceding it.

There is no separate acknowledgement op, and no error or refusal op appears anywhere
in the capture: a request a device does not serve is met with silence. Only the served
device reports — displays read and write, and never send `0x02`.

- **Read.** Sent in bursts as the wizard's pages open: 66 reads to the AC covering 40
  distinct keys, 39 of them answered.
- **An unanswered read is a defined state.** The AC never answered key `0x1A23`, read
  20 times (4× by each of the five displays); the SCX-20 answered none of the 320
  reads addressed to it. The wizard renders an unanswered key as NA and proceeds.
  There is no equivalent precedent for a malformed reply.
- **Addressed write.** All four in the capture were acknowledged as above: `0x0914` ←
  `c1,0a,00,00`, then ← `c0,08,00,00`; `0x0109` ← `dd,17`; `0x0209` ← `23,e8`.
- **Broadcast write** (b2 = `ff`, b4 = `01`). 34 frames: 31 from displays, 3 from the
  AC. Display 21 stepped key `0x12FF` through `16,00,2c,37,42,4d,58,63`; four
  displays wrote `0x0208`/`0x0205`/`0x0104`/`0x0204` within 2 s of power-up. A
  broadcast write is addressed to no single device.
- **The two scopes are separate cells, not one value seen twice.** The AC's four
  unsolicited broadcasts, all of key `0x0914` within eight minutes, do not track the
  writes made to `0x0914` on the AC itself: it broadcast `c0,08,00,00` at 01:55:43
  while its own cell, read at 01:52:49 and written at 01:54:56, held `c1,0a,00,00`.

### 7.3 Key encoding

- The key is the LE16 at b6/b7, and that number is what canboat's `Key` field carries
  (`0x0A18` = 2584).
- 130845's key is a canboat `DYNAMIC_FIELD_KEY`: for keys the dictionary names,
  canboatjs renders the name in place of the number — `0x2D04` → `"True wind shift"`,
  `0x0A18` → `2584`. Which keys are named depends on the installed canboat version,
  not on the bus. **A table keyed by number must resolve the key from the raw frame.**
  The same applies to the op byte, which no parsed field carries dependably. `code`
- Field *names* are version-dependent too: camelCase with `useCamel` on (the default
  this plugin's parser gets), Title Case with it off, and 2.x produced Title Case
  only. Accepting one spelling meant no read was answered at all on a 3.x host, with
  the wizard held on *commissioning required* while every other value on the page was
  live. `code`

Keys the captured AC42 answered (39):

```
0109 0114 011c 0209 0218 021c 0614 0618 081c 0914 0918 091c 0a18
0b18 0b20 0b22 0b23 0c18 0c1b 0d19 0d1a 0d23 0e19 0e1a 0f19 0f1a
1019 101a 1119 111a 111c 1921 1a1e 1a1f 1a22 1b1f 1b20 1d14 2d04
```

### 7.4 Boat type — key `0x0A18`

Commissioning values are not consumed by anything that steers here; the backing pilot
carries its own commissioning. Key `0x0A18` (2584) is the exception: it selects the
control set the MFD's autopilot sidebar offers.

| value | boat type | sidebar controls |
|---|---|---|
| `0` | Sail | Tack/Gybe (§2.4) and the wind modes |
| `1` | Outboard | turn patterns: U-Turn, C-Turn, Spiral, Zigzag, Square, S-Turns, Depth |
| `2` | Displacement | as `1` |
| `3` | Planing | as `1` |

- The two control sets occupy the same slot. No value yields both.
- The value is the index into the wizard's own list, in the order above.
- The captured AC42 answers `00` = Sail. `ac42-comm`
- The wizard writes the key like any other. Dockside 2026-08-12, setting the boat type
  against the emulated AC: `41 9f 23 ff ff ff 18 0a 00 01 03`.
- The MFD manual states that the wind and tack functions require a Sail boat type —
  the same constraint stated from the UI side.
- Consequence for an emulator: a fixed row taken from the capture reports Sail
  whatever the user selects, leaving the turn patterns unreachable; a fixed powerboat
  value removes the Tack button.

### 7.5 Autopilot tuning keys

The plotter writes the pilot's steering parameters over the same store, from
`Settings → Autopilot → Automatic steering…` and `Settings → Autopilot → Sailing…`.
The keys below were pinned by setting parameters on a Vulcan 9 and reading the write
off the bus, then cross-checking against the value reported for what the screen had
shown beforehand. Rows with no `set → sent` entry are the ones the rig could only
read back. `vulcan9-set`

**The key splits into two bytes: b6 is the group, b7 the parameter within it.** Both
hold across the set — `0x0D19` and `0x0D1A` are one parameter in two bands, and boat
type `0x0A18` is parameter `0x0A` of the common group.

| group (b6) | section |
|---|---|
| `0x18` | common to both bands |
| `0x19` | Low |
| `0x1A` | High |
| `0x1C` | sailing |

**High and Low name the gain set, not the boat speed.** `Automatic steering…`
describes High as *"For low speed and when running with a sailboat"* and Low as
*"For high speed and when beating or reaching with a sailboat"*. Transition speed
(`0x0C18`) is the crossover point.

Every band value in the AC42 capture matches the Vulcan 9 display before any edit:

| | rudder | counter rudder | auto trim | rate limit |
|---|---|---|---|---|
| **High** — screen | 0.55 | 0.50 | 40 | 7.0 |
| `0x1A` — capture | 55 | 50 | 400 | 3908552 |
| **Low** — screen | 0.62 | 0.50 | 40 | 6.0 |
| `0x19` — capture | 62 | 50 | 400 | 3350187 |

The High set applies at low speed, so its 7.0 °/s rate limit against Low's 6.0 °/s
is consistent with the assignment. `ac42-comm` `vulcan9-set`

| parameter | key | group·param | width | wire encoding | set → sent | shown → reported |
|---|---|---|---|---|---|---|
| Transition speed | `0x0C18` | 18·0C | u16 | 0.01 m/s | 0 kn → 0 | 6 kn → 308 |
| Rudder gain, High | `0x0D1A` | 1A·0D | u16 | value × 100 | 4.00 → 400 | 0.55 → 55 |
| Auto trim, High | `0x0E1A` | 1A·0E | u16 | seconds × 10 | 4 s → 40 | 40 s → 400 |
| Counter rudder, High | `0x0F1A` | 1A·0F | u16 | seconds × 100 | 8.0 → 800 | 0.50 → 50 |
| Rate limit, High | `0x101A` | 1A·10 | u32 | 3.125e-8 rad/s | 15.0 °/s → 8377581 | 7.0 °/s → 3908552 |
| Rudder gain, Low | `0x0D19` | 19·0D | u16 | value × 100 | 4.00 → 400 | 0.62 → 62 |
| Auto trim, Low | `0x0E19` | 19·0E | u16 | seconds × 10 | — | 40 s → 400 |
| Counter rudder, Low | `0x0F19` | 19·0F | u16 | seconds × 100 | — | 0.50 → 50 |
| Rate limit, Low | `0x1019` | 19·10 | u32 | 3.125e-8 rad/s | 12.0 °/s → 6702065 | 6.0 °/s → 3350187 |
| Tack time | `0x081C` | 1C·08 | u16 | seconds × 10 | — | 12 s → 120 |
| Tack angle | `0x0B18` | 18·0B | u16 | 65536 = 360° | 60° → 10923, 150° → 27307 | 100° → 18205 |
| Wind function | `0x091C` | 1C·09 | u16 | enum | Apparent → 1, True → 2 | Auto → 4 |

- **The scales are not uniform, and nothing on the wire declares which applies.**
  Dimensionless values and short times are decimal shifts (rudder gain and counter
  rudder × 100, auto trim and tack time × 10). Speed is SI rather than the displayed
  unit: 6 kn = 3.0867 m/s → 308. Rate limit is an NMEA 2000 rate field at the
  3.125e-8 rad/s resolution 127251 uses — 8377581 × 3.125e-8 = 0.2617994 rad/s =
  15.00000 °/s against 15.0 typed, and the AC's 3908552 = 6.99823 °/s against 7.0
  displayed.
- **Angles are a 16-bit binary angle**, `65536 = 360°`, not 1e-4 rad. Tack angle set
  to 60° sent 10923 and set to 150° sent 27307; a binary angle gives 10922.67 and
  27306.67, 1e-4 rad gives 10472 and 26180. The AC42's stored 18205 is 100.003° as a
  binary angle and 104.3° at 1e-4 rad, against 100° displayed. `vulcan9-set`
- **Width is a property of the parameter.** Rate limit is 32-bit, everything else here
  16-bit. A fixed-width reader gets rate limit wrong by orders of magnitude.
- **Both bands are written, not inferred.** Rudder gain in each, rate limit in Low
  (12.0 °/s → 6702065) as well as High. The remaining Low keys are pinned by readback
  against the display. `vulcan9-set`
- **The sailing dialog spans two groups.** Tack time and wind function are `0x1C`;
  tack angle is `0x0B18`, parameter `0x0B` of the common group, beside boat type.
  Keys were attributed by single-field edits: tack angle 100 → 150 → 60 moved
  `0x0B18` only, wind function Auto → Apparent → True moved `0x091C` only, 4 → 1 → 2.
  Tack time is the remaining key, and its 120 against 12 sec displayed is the same
  seconds × 10 as auto trim; its field is a spinner this rig could not drive, so that
  row is by elimination. `vulcan9-set`
- **Rate limit is converted in 32-bit float — expect ±1 count.** 15.0, 12.0 and
  6.0 °/s sent 8377581, 6702065 and 3351032; exact arithmetic at 3.125e-8 rad/s gives
  8377580.4, 6702064.3 and 3351032.2, so the wire value is neither a round nor a ceil
  of it. All three match `round(float32(deg × π/180) / 3.125e-8)`.
- **A displayed value does not identify a stored one.** 6.0 °/s written is 3351032;
  the AC42 stored 3350187 = 5.99849 °/s. Both display as 6.0. Compare rate limits
  with a tolerance, and do not expect a value read back and rewritten to be
  byte-identical. `vulcan9-set`

When the plotter writes: `vulcan9-set`

- **One key per keypad, on OK**, 1–2 ms after the tap. Each parameter on
  `Automatic steering…` has its own keypad.
- **A whole dialog, on Save.** `Sailing…` carries several fields and sends them
  together.
- **Settings pages read nothing.** Opening `Automatic steering…` or `Sailing…` produced
  no 130845 at all — the plotter displays values it already holds. The op-00 read
  belongs to the commissioning wizard (§7.2), not to the settings pages.
- **The value report is what the page then shows**, measured both ways on this rig.
  Against the canned table the reply carries the old value and the plotter reverts the
  field just written — which is how the "shown → reported" column above was read, every
  row taken before any edit. Against an emulator that applies op-01 before answering,
  the same edits persist across reopening the dialog. §7.6 rule 5.

### 7.6 Requirements for a write path

Derived from §7.1–7.2. An implementation that accepts 130845 writes:

1. **Records only frames whose byte 2 is its own address.** Broadcast writes and
   writes to other devices are ordinary bus traffic (§7.2), not its own.
2. **Takes the operation from the wire and applies op-01 only.** A read carries `ff`
   value bytes; applying one overwrites the value being read.
3. **Ignores a write carrying no value bytes.** Storing the padding yields an all-`ff`
   row — for `0x0A18`, a boat type of 255.
4. **Emits 14-byte frames only.** A stored malformed row is served to every later read
   of that key; an unanswered read is a defined state (§7.2), a short frame is not.
5. **Answers a write with the value just written**, from its own address (§7.2). That
   report is the only acknowledgement the wizard gets.
6. **Persists what it accepts, or reverts visibly.** A real AC holds commissioning in
   non-volatile memory, and the wizard reads values back rather than re-writing them,
   so an in-memory table reports the captured values again after a restart.

Implementation: `lib/ac-emulator.js` — `COMMISSION_RAW` (the 39 keys above plus six
fallbacks the captured AC never answered) and `reply130845`, which serves reads.
Applying writes, and lifting the boat type out of the byte table into a plugin
setting, is issue #12.

---

## 8. CAN transport — why the bridge drives `Canbus` directly

canboatjs offers three ways for a plugin to put a device on the bus. The bridge
uses the oldest one on purpose. `code`

| API | since | what it gives | why not here |
|---|---|---|---|
| `new Canbus()` + `FromPgn` | 2.x | own socketcan channel, own `CanDevice`, raw frames **and** parsed PGNs | **in use** |
| `SimpleCan` | **3.18.0** (PR #424, 2026-05-05) | same, minus the stream plumbing | version floor; buys almost nothing |
| `CanboatUtilities.createEmulator` | **3.18.0** | a device on the server's *existing* CAN connection | parsed PGNs only, no raw frames |

`SimpleCan` is exported from `lib/index.ts` only from 3.18.0; 3.16.4 and earlier
do not expose it at all. The plugin's peer floor is `@canboat/canboatjs >=2.10.0`
and installs do resolve 2.x out of `~/.signalk`, so adopting it means dropping
those hosts or carrying two transports.

What it would remove: the `pipe()`/`plainText` trap (`stream.fromPgn`, see
`lib/canboat-compat.js`) and a few lines of stream wiring. What it would **not**
remove: parsing with `FromPgn` (fast-packet reassembly stays caller-side), the
address-claim shape probe, the `Software Version Code` pin — it builds the same
`CanDevice` — feeding `N2KAnalyzerOut` back for ISO answers, and actisense-string
sending. It also opens its own `CanChannel` exactly like `Canbus`, so there is no
resource win, and it drops `setProviderStatus`/`setProviderError`, which the
plugin's CAN-error status hangs on.

`createEmulator` (reached via the `canboatjsUtils` propertyValue) is the
architecturally right shape — no second channel, no duplicate claim stack — but
it hands out **parsed** PGNs only. The 130850 button decode reads the raw frame
bytes for group/key, because canboat's field naming is not stable across majors
(§2.1). A raw-frame callback on `DeviceEmulator` would make it viable.

---

## 9. Cross-references

- **Kees / canboat n2k_research** (github.com/canboat/n2k_research): raw-PGN RE,
  `navico/ac42/` commissioning analysis + generic `fake-ac.js`, and
  `candump/AUTOPILOT_CONTROL.md` (merrimac-rs control PGNs — different dialect).
- **`lib/ac-emulator.js`** — the byte constants and decode/firehose logic.
