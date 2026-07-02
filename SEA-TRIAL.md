# Sea trial test protocol

Sea-trial checklist for `signalk-navico-autopilot-bridge` driving a real pilot
(reference rig: B&G Vulcan 7 → SignalK V2 → Raymarine EV-200). It closes out the
items the dock test could not: holding **quality** with way on, Wind/Track modes,
Tack, and the MFD mode overlay. See the README
[Known limitations](README.md#known-limitations).

> Read the README [Disclaimer](README.md#disclaimer--no-warranty) first. The
> autopilot moves the rudder. Run this only with a competent helmsman ready to
> take manual control, in open water with sea room, in light wind and calm sea on
> the first attempt.

## Crew and abort

- **Helmsman** stays at the wheel/tiller, hand on the clutch, throughout. Does not
  rely on the pilot — is steering manually the instant anything is wrong.
- **Operator** works the Vulcan buttons and calls each test.
- **Observer** (optional) watches the P70 and Vulcan overlay and records results.
- **Abort at any time:** press **Standby on the P70** (the pilot's own head). This
  must always return the helm regardless of what the bridge or MFD is doing. If
  the P70 standby does not free the helm, **disengage the clutch by hand** and
  kill the pilot's power.
- Abort and log a **FAIL** if: the boat turns the wrong way, an alteration is far
  larger than commanded, the pilot does not respond, or the mode shown disagrees
  with what the boat is doing.

## Preconditions

- [x] Open water, sea room downwind/down-current, no traffic close by.
- [x] Light wind, calm sea (first trial). Note conditions in the log.
- [x] Bridge mode = **`live`**, plugin running, plugin log visible (decoded keys).
- [x] `sourcePriorities` set so the real pilot owns `steering.autopilot.state` and
      `target.headingMagnetic` (README
      [§5](README.md#5-source-priorities-required)) — otherwise course change is
      refused in auto.
- [x] No real Simrad/B&G AC on the bus (only the emulator).
- [x] Pilot commissioned and known good on its **own** head (P70) first — confirm
      it holds a course in Auto from the P70 before involving the bridge.
- [x] Boat type on the MFD = **Sail** (wind mode + tack buttons present).
- [x] Engine on or adequate boat speed for steerage in every test below.

## Log header

| field | value |
|---|---|
| Date / time | 2026-06-16 20:00 |
| Plugin version | 0.3.0-alpha |
| Pilot / drive | EV-200 |
| MFD | Vulcan 7 |
| Wind (true) | 10 knots |
| Sea state | calm |
| Boat speed | 4 knots |
| Crew | 1 |

Tick **PASS** or **FAIL** for each test. "Observe on" lists where to confirm:
**boat** (actual heading/rudder), **P70** (pilot head), **Vulcan** (MFD overlay).

---

## Phase 1 — Engagement and failsafe

Prove the abort path **before** relying on the pilot for anything dynamic.

### 1.1 Engage Auto from the Vulcan
- Steady on a heading with way on. Press **Auto** on the Vulcan.
- **Pass if:** clutch engages, pilot holds the current heading; P70 shows Auto;
  Vulcan overlay shows Auto.
- Observe on: boat, P70, Vulcan.
- [x] PASS
- [ ] FAIL
- Note: ____

### 1.2 Abort via P70 standby (critical)
- With the pilot in Auto (from 1.1), press **Standby on the P70**.
- **Pass if:** helm is freed immediately, clutch releases, boat steers by hand.
- [x] PASS
- [ ] FAIL
- Note: ____

### 1.3 Standby from the Vulcan
- Re-engage Auto, then press **Standby on the Vulcan**.
- **Pass if:** pilot drops to standby; P70 and Vulcan both show Standby.
- Observe on: boat, P70, Vulcan.
- [x] PASS
- [ ] FAIL
- Note: ____

### 1.4 Lost-autopilot alarm (optional, safest at low speed / on return)
- With the MFD bound, stop the plugin (or the firehose) for a few seconds.
- **Pass if:** Vulcan raises the lost-autopilot alarm; re-binds when restarted.
- [x] PASS
- [ ] FAIL
- Note: ____

---

## Phase 2 — Auto mode (course hold + ±course)

### 2.1 Course hold
- In Auto, let the pilot settle. Watch heading for ~1–2 min.
- **Pass if:** holds the set heading within normal pilot tolerance (no wandering,
  no slow lee-ward creep). This is the dock test's missing "with way on" check.
- Observe on: boat, P70.
- [x] PASS
- [ ] FAIL
- Note: ____ Set heading is not shown on Vulcan, just - - -

### 2.2 ±1° nudge
- Press the **+1°** (starboard) course button once; then **−1°** (port) once.
- **Pass if:** heading changes by ~1° in the pressed direction each time; P70
  target updates. Direction matches the button (starboard = right).
- Observe on: boat, P70.
- [x] PASS
- [ ] FAIL
- Note: ____

### 2.3 ±10° nudge
- Press **+10°** once, confirm ~10° starboard; press **−10°** once, confirm ~10°
  port.
- **Pass if:** ~10° alteration each, correct direction; no overshoot beyond pilot
  norm.
- Observe on: boat, P70.
- [x] PASS
- [ ] FAIL
- Note: ____

### 2.4 Cumulative large alteration (and no accidental tack)
- From Auto, press **+10°** repeatedly (e.g. 6×) to come round ~60°.
- **Pass if:** total alteration ≈ sum of presses, all to starboard; the boat does
  **not** perform a tack/gybe (tack must be ignored outside wind mode).
- Observe on: boat, P70, plugin log.
- [x] PASS
- [ ] FAIL
- Note: ____

---

## Phase 3 — Wind mode (hold + tack)

Tack is a **test candidate** — the turn-direction convention is unverified. Do
this with the most sea room and be ready to abort. Direction is derived from
`environment.wind.angleApparent`, not the MFD; confirm SK has a sane apparent
wind angle before tacking.

### 3.1 Engage Wind and hold
- Sailing (or motor-sailing) at a steady apparent wind angle, press **Wind**.
- **Pass if:** pilot holds the apparent wind angle; P70 shows Wind; Vulcan overlay
  shows Wind (see Phase 5).
- Observe on: boat, P70, Vulcan.
- [x] PASS
- [ ] FAIL
- Note: ____TWA and commanded wind angle missing

### 3.2 ±wind-angle adjust
- Press **+1° / −1°** and **+10° / −10°** in Wind.
- **Pass if:** the held wind angle shifts by the pressed amount, correct side.
- Observe on: boat, P70.
- [ ] PASS
- [x] FAIL
- Note: ____ ____TWA and commanded wind angle missing

### 3.3 Tack to windward
- On a beat, press the **Tack** button for a tack **to starboard** (wind on port
  bow → boat should tack onto starboard tack). Then, on the new tack, tack back to
  port.
- **Pass if:** boat tacks the **expected** way (toward the side the bridge derived
  from the apparent wind angle), settles on the new wind angle. Note the actual
  vs expected direction — this is the convention under test.
- Observe on: boat, P70, plugin log (`POST tack/*`).
- [ ] PASS
- [x] FAIL
- Note: ____Tack button disabled on Vulcan

---

## Phase 4 — Nav / Track mode

### 4.1 Follow a route leg
- Activate a route / go-to on the Vulcan, press **Nav/Track**.
- **Pass if:** pilot steers toward the active waypoint, corrects cross-track; P70
  shows the nav/track mode; Vulcan overlay shows Track.
- Observe on: boat, P70, Vulcan.
- [x] PASS
- [ ] FAIL
- Note: ____

### 4.2 Waypoint advance
- Let the boat approach the waypoint (or force an advance on the MFD).
- **Pass if:** pilot picks up the next leg without losing the plot.
- Observe on: boat, P70.
- [ ] PASS
- [ ] FAIL
- Note: ____ Not tested

---

## Phase 5 — MFD mode-display overlay

The per-mode firehose frames are **guesses** (htool, unverified). The pilot's mode
is authoritative on the **P70**; this phase only checks whether the **Vulcan
overlay label** follows. A wrong label with a correct P70 mode is a display-only
miss, not a steering fault — record it, don't abort for it.

For each mode, record what each display shows, then tick if the Vulcan overlay
matches the P70:

- [x] **Standby** — P70: ____  Vulcan: ____
- [x] **Auto** — P70: ____  Vulcan: ____
- [x] **Wind** — P70: ____  Vulcan: ____
- [x] **Nav / Track** — P70: ____  Vulcan: ____

---

## Phase 6 — No Drift (informational)

- Press **No Drift** on the Vulcan.
- **Expected:** no steering action; plugin log shows the key decoded but not fired
  (no V2 equivalent). Confirm the boat does **not** change behaviour.
- [x] As expected (no steering action; key decoded but not fired)
- [ ] Unexpected
- Note: ____

---

## Post-trial

- [x] Drop to Standby (P70) and steer home manually.
- [x] Record overall verdict and any FAILs with conditions.
- [x] File issues / update README [Known limitations](README.md#known-limitations)
      for anything that failed or behaved unexpectedly (especially tack direction
      and the Wind/Track overlay).
