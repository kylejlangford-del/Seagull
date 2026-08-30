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


## v4.5 — Simple sink target tracking

The previous Fix Sink Target / Accuracy update has been removed.

The sink controls remain exactly where they were on the right side.

A single **Sink target tracking** slider is now on the LEFT side:
- 0% = current behaviour: the boat stays relatively steady and waves pass over the foils, so actual sink varies.
- 100% = the boat moves with the local wave surface so the active sink target is always reached.
- Intermediate values blend between those two behaviours.

This control does not replace or change the actual sink target sliders.


## v4.6 — revised AC40 model

This build uses the user's newly revised GLTF.

The cant fixes were reapplied directly to that new model:
- Port ARM + the complete port horizontal T-foil are attached to `PORT_FOIL_CANT_ROOT`.
- Starboard ARM + the complete starboard horizontal T-foil are attached to `STBD_FOIL_CANT_ROOT`.
- Both sides rotate as rigid assemblies around their top cant pivots.
- No extra/mirrored foil geometry has been added.
- All other geometry from the revised model is left as supplied.
