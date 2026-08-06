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
  `"1100"`. The AC does **not** send 126993/126998/126464. `ac42-comm`

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
  **auto**, not to a No Drift mode of its own: Raymarine's No Drift is a COG-referenced
  heading hold, but `SeatalkPilotMode16` `0x0181` ("No Drift, COG referenced") is
  decoded to `route` by `@signalk/n2k-signalk`, and `signalk-autopilot` already uses
  that same `0x0181` as its `advanceWaypoint` — so firing No Drift would mean sending
  track-engage. Auto is the honest approximation: the pilot holds a heading, it just
  does not compensate for drift. Confirmed dockside the same day: pressing No Drift
  engages the pilot, and **both** the MFD and the p70s report Auto — the plotter does
  not latch a No Drift label of its own, so button and display stay consistent.
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

## 7. Cross-references

- **Kees / canboat n2k_research** (github.com/canboat/n2k_research): raw-PGN RE,
  `navico/ac42/` commissioning analysis + generic `fake-ac.js`, and
  `candump/AUTOPILOT_CONTROL.md` (merrimac-rs control PGNs — different dialect).
- **`lib/ac-emulator.js`** — the byte constants and decode/firehose logic.
