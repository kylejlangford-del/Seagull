/* ==== polar.js ==== */
/* polar.js — the F50 polar tables and what they imply.
 *
 * POLARS is injected by build.py from `F50 polars/*.csv`, keyed by the config
 * key with the version and unit suffix stripped, so `m15_HAW_HSB2_HSRW2_v5.kph.csv`
 * is reachable as `m15_HAW_HSB2_HSRW2` — which is exactly what `config_id` in
 * the boat logs contains.
 *
 * Shape per config:
 *   { file, version, tws: [...], twa: [...], v: [[speed|null, ...], ...] }
 *   v[twaIndex][twsIndex], km/h. null where the table is blank.
 *
 * Blanks are not zeros. The F50 has no steady solution through the foiling
 * transition, so whole cells are empty — interpolating across one would invent
 * a boat speed at a wind speed where the boat cannot hold that angle.
 */

const D2R_P = Math.PI / 180;

function polarFor(configKey) {
  if (!configKey) return null;
  return POLARS[configKey] || null;
}

/* Best VMG angle in one TWS column, refined below the 2 deg grid step.
 *
 * The table is coarse: 2 deg in TWA, ~3.7 km/h in TWS. Taking the grid maximum
 * quantises the answer to 2 deg, which is a fifth of the spread we measured
 * between the polar and the boats' own targets — worth removing. A parabola
 * through the best cell and its two neighbours puts the vertex where the real
 * optimum is.
 */
function columnOptimum(p, twsIndex, upwind) {
  const sign = upwind ? 1 : -1;
  let best = -Infinity, bi = -1;
  const vmg = new Array(p.twa.length).fill(null);
  for (let i = 0; i < p.twa.length; i++) {
    const s = p.v[i][twsIndex];
    if (s == null) continue;
    vmg[i] = sign * s * Math.cos(p.twa[i] * D2R_P);
    if (vmg[i] > best) { best = vmg[i]; bi = i; }
  }
  if (bi < 0) return null;

  let twa = p.twa[bi], speed = p.v[bi][twsIndex];
  const a = vmg[bi - 1], b = vmg[bi], c = vmg[bi + 1];
  if (a != null && c != null) {
    const denom = a - 2 * b + c;
    if (denom < 0) {                              // a genuine peak, not a plateau
      const shift = 0.5 * (a - c) / denom;
      if (Math.abs(shift) <= 1) {
        const step = p.twa[bi + 1] - p.twa[bi];
        twa = p.twa[bi] + shift * step;
        // speed at the refined angle, linear between the bracketing cells
        const nb = shift >= 0 ? bi + 1 : bi - 1;
        const f = Math.abs(shift);
        speed = p.v[bi][twsIndex] * (1 - f) + p.v[nb][twsIndex] * f;
      }
    }
  }
  return { twa, speed, vmg: best };
}

/* Target angle and speed at an arbitrary TWS, interpolating between columns.
 * Returns null outside the table rather than extrapolating. */
function polarTarget(p, tws, upwind) {
  if (!p || tws == null) return null;
  const T = p.tws;
  if (tws <= T[0])              return withMeta(columnOptimum(p, 0, upwind), 'clamped-low');
  if (tws >= T[T.length - 1])   return withMeta(columnOptimum(p, T.length - 1, upwind), 'clamped-high');
  for (let i = 0; i < T.length - 1; i++) {
    if (tws >= T[i] && tws <= T[i + 1]) {
      const a = columnOptimum(p, i, upwind), b = columnOptimum(p, i + 1, upwind);
      if (!a || !b) return withMeta(a || b, 'single-column');
      const f = (tws - T[i]) / (T[i + 1] - T[i]);
      return withMeta({
        twa:   a.twa   + (b.twa   - a.twa)   * f,
        speed: a.speed + (b.speed - a.speed) * f,
        vmg:   a.vmg   + (b.vmg   - a.vmg)   * f,
      }, 'interpolated');
    }
  }
  return null;
}

function withMeta(o, method) {
  return o ? Object.assign({}, o, { method }) : null;
}

/* Boat speed at an arbitrary (TWA, TWS), bilinear.
 *
 * Returns null if a cell it actually needs is blank. "Actually needs" matters:
 * a query sitting exactly on a grid line has zero weight on the far side, and
 * an early version returned null for TWA 48 because the blank 46 row was in
 * the bracket even though it contributed nothing. On a table that is 8 % holes
 * that is not an edge case, it is the common case at the low-TWS boundary.
 */
function polarSpeed(p, twa, tws) {
  if (!p || twa == null || tws == null) return null;
  const a = Math.abs(((twa % 360) + 360) % 360);
  const A = a > 180 ? 360 - a : a;                 // mirror: the table is 0-180
  const ia = bracket(p.twa, A), iw = bracket(p.tws, tws);
  if (ia < 0 || iw < 0) return null;

  const fa = (A - p.twa[ia]) / (p.twa[ia + 1] - p.twa[ia]);
  const fw = (tws - p.tws[iw]) / (p.tws[iw + 1] - p.tws[iw]);

  let sum = 0;
  for (const [di, wa] of [[0, 1 - fa], [1, fa]]) {
    if (wa === 0) continue;
    for (const [dw, ww] of [[0, 1 - fw], [1, fw]]) {
      if (ww === 0) continue;
      const c = p.v[ia + di][iw + dw];
      if (c == null) return null;                  // a cell we needed is blank
      sum += c * wa * ww;
    }
  }
  return sum;
}

/* Half-open bracket: a value sitting exactly on a grid line takes the interval
 * that STARTS there, so its weight lands on the cell it names rather than on
 * the one below it. The last point is the exception, having no interval above. */
function bracket(arr, x) {
  const n = arr.length;
  if (x < arr[0] || x > arr[n - 1]) return -1;
  if (x === arr[n - 1]) return n - 2;
  for (let i = 0; i < n - 1; i++) if (x >= arr[i] && x < arr[i + 1]) return i;
  return -1;
}


/* ── velocity made good on course ───────────────────────────────────────────
 *
 * How fast you actually close a mark that bears at a given TWA. Sailing
 * straight at it is not always quickest: at TWS 33 km/h on this polar a course
 * of 160 deg makes 52 km/h sailed directly but 77 km/h sailed at 138 and
 * gybed, and even a 50 deg course gains 5 km/h by cracking off to 66.
 *
 * On a beam reach the two agree to within 1 km/h, which is the case that
 * matters for a reaching start — but the isochrone sweeps every bearing, so
 * the optimisation is not optional.
 *
 * Returns a 0-180 lookup, one entry per degree of course TWA:
 *   { v: [km/h made good], twa: [the TWA that achieves it] }
 *
 * Caveat worth stating where it is displayed: a VMC optimum at a deep course
 * implies gybing. On a 500 m leg that may not be a real option.
 */
function vmcTable(p, tws) {
  if (!p || tws == null) return null;
  const v = new Float64Array(181), best = new Float64Array(181);
  const cache = p.twa.map(a => ({ a, s: polarSpeed(p, a, tws) }))
                     .filter(o => o.s != null);
  if (!cache.length) return null;
  for (let c = 0; c <= 180; c++) {
    let bv = -Infinity, ba = null;
    for (const o of cache) {
      const made = o.s * Math.cos((o.a - c) * D2R_P);
      if (made > bv) { bv = made; ba = o.a; }
    }
    v[c] = bv > 0 ? bv : 0;
    best[c] = ba == null ? c : ba;
  }
  return { v, twa: best, tws };
}

/* Speed made good toward a mark bearing `brgToMark` in a wind of `twd`.
 *
 * Interpolated between the whole-degree entries rather than rounded to the
 * nearest. Rounding quantised the answer in 1 deg steps, which was invisible
 * in a number and obvious as a staircase in the advantage curve drawn from it.
 */
function vmcAt(tbl, twd, brgToMark) {
  if (!tbl) return null;
  let d = Math.abs(((brgToMark - twd + 540) % 360) - 180);
  if (d > 180) d = 360 - d;
  d = Math.max(0, Math.min(180, d));
  const i = Math.floor(d);
  if (i >= 180) return tbl.v[180] || null;
  const f = d - i;
  const a = tbl.v[i], b = tbl.v[i + 1];
  if (!a && !b) return null;
  return a + (b - a) * f;
}
