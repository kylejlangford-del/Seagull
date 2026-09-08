# Seagull Lab Start Geometry v6.1

Updates:
- Default left boundary to left end of start: 485 m
- Default right boundary to right end of start: 678 m
- Default start line: 0.240 NM (444.48 m)
- Default total width: 1607.48 m (0.868 NM)
- Responsive iPhone layout with safe-area support, 44 px touch targets, 16 px numeric inputs, stacked results, and mobile course schematic
- Metres / nautical miles and 90° TWA / 2 Board modes retained

## v6.1 fixes
- Course width and start-line length are now held as exact metre values in JS
  state at all times. Display fields are formatted *from* that state; toggling
  Metres / Nautical miles no longer re-parses the rounded display text, so the
  underlying geometry can never drift from switching units back and forth
  (this was the likely cause of the desktop/mobile discrepancy reports).
- `styles.css` and `app.js` are now loaded with a `?v=` cache-busting query
  string on every page (homepage, AC40 Geometry, Start Geometry), so a
  deployed update is picked up immediately instead of relying on a stale
  cached copy (notably on iPhone Chrome).
- Removed the stale `/deploy` folder, which still had the old v5 defaults
  (513 m / 678 m) and had drifted out of sync with the root-level files that
  GitHub Pages actually serves.

## Open item
- The AC40 90° TWA speed table (7–17 kn TWS → boat speed) was transcribed
  from a screenshot in the original ChatGPT session, which also contained a
  conflicting reading for 13 kn TWS (29.10 kn vs. the 34.0 kn currently used).
  34.0 kn was confirmed as correct, so no change was made to the table — but
  if a cleaner source table turns up later, it's worth a final cross-check.
