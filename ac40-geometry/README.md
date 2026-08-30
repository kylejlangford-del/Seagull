# AC40 Geometry v4.3

This version fixes the foil geometry at the MODEL level rather than trying to
re-parent mesh pieces after Three.js loads the file.

## Foil fix

The supplied GLTF contains:
- port ARM
- port outer T-foil half
- port inner T-foil half
- starboard ARM
- starboard outer T-foil half

The source model does **not** contain a starboard inner T-foil half.

v4.3 therefore:
1. Creates a rigid `PORT_FOIL_CANT_ROOT` inside the GLTF containing the arm and
   both port horizontal T-foil pieces.
2. Creates a rigid `STBD_FOIL_CANT_ROOT` containing the starboard arm and outer
   horizontal foil.
3. Mirrors the port inner horizontal foil across the boat centreline to create
   the missing starboard inner horizontal foil.
4. Cants each complete assembly from its actual top pivot.

This removes the runtime grouping problem that caused the port foil to separate
and the starboard cant control to appear not to move.

Current ranges:
- Cant: 50–126°
- Sink: −0.50 to −1.50 m

- Sink controls now move only in **0.05 m increments**.


## v5 — Fixed sink target mode
A new **Fix sink target** mode has been added for wave simulation.

- OFF: the boat keeps its mean-water geometry while waves pass underneath it, so actual sink varies.
- ON: the boat responds to the local instantaneous wave surface to hold the active sink target(s).
- **Sink target accuracy** is adjustable from 0–100% in 5% steps.
  - 0%: no dynamic correction; the boat stays relatively steady.
  - Low values: weak/slow correction; sink target is not fully achieved.
  - 100%: full correction every frame; the active sink target(s) are held as closely as the geometry solver allows.
- In **Heel + sink**, the boat changes heave while heel remains fixed.
- In **Foil sinks**, both heave and heel can move to maintain both sink targets.
- Sink hold is unavailable in **Heel + clearance** mode or when no foil sink is active.
