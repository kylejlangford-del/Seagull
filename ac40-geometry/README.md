# AC40 Geometry v4

Upload the contents of this folder into your existing GitHub repo folder:

`/ac40-geometry/`

Replace the existing files with:
- `index.html`
- `styles.css`
- `app.js`
- `ac40-model.gltf`

## Foil sink logic
- Port sink is active only while port cant is **90° or less**.
- Starboard sink is active only while starboard cant is **90° or less**.
- Above 90°, that foil's sink control is disabled and shown as `OFF (>90°)`.
- If one foil is above 90°, the vertical solution uses **heel + the active foil sink**, or the user can select **heel + hull clearance**.
- If both foils are above 90°, the app automatically switches to **heel + hull clearance**.
- The two-foil sink solver is only available when both foils are 90° or less.

Other current features:
- Cant range 50–126°.
- Sink range −0.50 to −1.50 m.
- Full foil assemblies move rigidly with cant.
- Left scenario table.
- Scenario screenshot export.
- Independently scrollable right-side controls.


## Logo fix
This build includes its own copy of the Seagull Lab logo at:
`ac40-geometry/assets/seagull-lab-logo.png`

The geometry page therefore no longer depends on the homepage `/assets/` folder.


## v4.2 foil assembly fix
The supplied GLTF contains duplicate object names. Three.js renames these at runtime
to `ARM`, `ARM_1`, `WINGIB`, `WINGIB_1`, and `WINGIB_2`.

The earlier build only matched the first `ARM` and first `WINGIB`, which caused:
- the inner half of the port T-foil to stay behind;
- the starboard foil assembly not to cant.

v4.2 matches all duplicate foil objects, groups them by port/starboard side, and
uses the actual cant pivot coordinates from the supplied GLTF reference geometry.
