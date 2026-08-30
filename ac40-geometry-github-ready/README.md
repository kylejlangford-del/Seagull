# AC40 Geometry page

This folder is ready to upload into your existing GitHub Pages repo at:

`/ac40-geometry/`

## Files
- `index.html`
- `styles.css`
- `app.js`
- `ac40-model.gltf`

The model file is self-contained: its binary buffers and texture are embedded inside the GLTF.

## GitHub
Open the `ac40-geometry` folder in your Seagull repository and upload the four files above.
The page will then be available at:

`https://kylejlangford-del.github.io/Seagull/ac40-geometry/`

## Included in this first interactive build
- 3D AC40 model
- Port and starboard cant controls based on the supplied 41.5° model
- Heel and trim
- Mean foil sink mode
- Port/starboard sink-target mode that solves heel
- Hull-clearance calculation against the water surface
- Flat water / waves
- Wave height
- Wavelength
- Deep-water automatic wave speed or manual override
- Wave direction
- Boat speed
- Encounter-period calculation
- Playback speed 0.25× to 4×
- Minimum clearance tracking
- 3D / side / front / top camera views

## Coordinate assumptions
The supplied model is treated as:
- +X = forward
- +Y = up
- +Z = starboard
- port foil = negative Z
- starboard foil = positive Z

Hull clearance is evaluated from the supplied hull mesh vertices to the local water surface.
