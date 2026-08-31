/* ── the acceleration table ──────────────────────────────────────────────────
 *
 * What an F50 does when the trigger is pulled, measured rather than assumed:
 * ~4.1M straight-line samples — every boat at every event of the 2025 and
 * 2026 seasons, pulled from Njord — acceleration read as a centred difference
 * and everything with a rate of turn over 3 deg/s thrown away, because a boat
 * in a turn is not accelerating in any sense a start cone can use.
 *
 * Indexed [boat speed][wind band][angle band]. Speed in 10 km/h steps from 0;
 * wind and angle bands below. Values are km/h PER SECOND — the unit you can
 * check against a speed trace by eye.
 *
 * Two percentiles, because the honest answer depends on what you are asking.
 * p75 is a good trigger pull, the kind you get every time, and is what a cone
 * you intend to sail to should be built on. p90 is the best of them. The tool
 * interpolates between the two on one slider and offers nothing above p90: a
 * cone drawn off the single best acceleration in fifty races is a cone that
 * lies to you at the one moment you cannot check it.
 *
 * Nearly every cell is measured directly at this data size; the few thin
 * ones fall back to the speed x wind marginal, then speed x angle, then the
 * speed row alone. Nothing here is invented; the thin cells are simply
 * coarser.
 *
 * Regenerate with build/accel-table.py (source: the fleet-wide pull in
 * /home/claude/ingest — see its docstring).
 */
const ACCEL_TWS = [20, 28, 36];        // upper edge of each wind band, km/h
const ACCEL_TWA = [60, 90, 120];       // upper edge of each angle band, degrees
const ACCEL_V_STEP = 10;               // km/h per speed row

/* A good pull, repeatable. */
const ACCEL_P75 = [
/*GEN:P75*/
  /*  0-10  */ [[0.18,0.14,0.13,0.10], [0.29,0.19,0.12,0.10], [0.27,0.14,0.10,0.11], [0.20,0.12,0.18,0.12]],
  /* 10-20  */ [[0.32,0.28,0.19,0.13], [0.50,0.52,0.35,0.13], [0.47,0.45,0.31,0.15], [0.42,0.21,0.21,0.15]],
  /* 20-30  */ [[0.35,0.40,0.30,0.12], [0.75,0.73,0.64,0.10], [1.09,1.18,0.88,0.21], [1.03,1.62,0.74,0.17]],
  /* 30-40  */ [[0.35,0.66,0.71,0.45], [0.76,1.03,1.03,0.36], [1.19,1.59,1.72,0.05], [1.45,1.84,2.16,0.05]],
  /* 40-50  */ [[0.31,0.56,0.74,0.41], [0.59,1.17,1.44,1.00], [1.15,2.01,2.60,0.96], [1.67,2.51,2.89,0.63]],
  /* 50-60  */ [[0.24,0.45,0.54,0.29], [0.40,0.79,1.18,0.87], [0.65,1.57,2.41,1.76], [0.99,2.23,2.82,1.45]],
  /* 60-70  */ [[0.34,0.45,0.44,0.23], [0.31,0.77,0.87,0.44], [0.46,1.26,1.83,1.40], [0.63,1.60,2.93,2.12]],
  /* 70-80  */ [[0.27,0.57,0.24,0.16], [0.45,0.62,0.57,0.30], [0.62,1.12,1.09,0.54], [1.01,1.35,1.58,1.00]],
  /* 80-90  */ [[0.29,0.29,0.29,0.29], [0.32,0.52,0.43,0.22], [0.43,0.89,0.68,0.34], [0.55,1.03,0.72,0.45]],
  /* 90-100 */ [[0.40,1.16,0.63,0.25], [0.40,1.16,0.63,0.25], [0.28,0.28,0.56,0.17], [0.46,1.20,0.66,0.30]],
/*GEN:END*/
];

/* The top of what the fleet manages. */
const ACCEL_P90 = [
/*GEN:P90*/
  /*  0-10  */ [[0.41,0.31,0.27,0.25], [0.70,0.40,0.26,0.24], [0.70,0.31,0.26,0.26], [0.52,0.22,0.45,0.26]],
  /* 10-20  */ [[0.66,0.54,0.40,0.33], [1.10,1.05,0.75,0.32], [1.13,0.98,0.69,0.35], [1.13,0.57,0.57,0.36]],
  /* 20-30  */ [[0.68,0.72,0.61,0.41], [1.30,1.21,1.20,0.51], [1.86,1.99,1.63,0.60], [1.92,2.51,1.65,0.50]],
  /* 30-40  */ [[0.72,1.05,1.11,0.92], [1.23,1.49,1.55,1.01], [1.74,2.15,2.53,0.99], [2.06,2.56,2.89,1.10]],
  /* 40-50  */ [[0.61,0.95,1.20,0.86], [1.03,1.70,2.00,1.58], [1.71,2.63,3.36,1.87], [2.26,3.25,3.94,1.73]],
  /* 50-60  */ [[0.54,0.83,0.94,0.64], [0.76,1.31,1.82,1.58], [1.14,2.33,3.25,2.43], [1.58,3.14,4.06,2.43]],
  /* 60-70  */ [[0.70,0.86,0.83,0.56], [0.69,1.29,1.44,0.98], [0.89,2.02,2.68,2.28], [1.12,2.62,3.66,2.92]],
  /* 70-80  */ [[0.64,0.92,0.58,0.47], [0.84,1.08,1.04,0.72], [1.12,1.78,1.78,1.20], [1.63,2.24,2.55,2.03]],
  /* 80-90  */ [[0.74,0.74,0.74,0.74], [0.77,1.10,0.89,0.67], [0.91,1.44,1.20,0.80], [1.15,1.64,1.32,1.00]],
  /* 90-100 */ [[0.96,1.68,1.12,0.75], [0.96,1.68,1.12,0.75], [0.78,0.78,1.05,0.58], [1.02,1.72,1.20,0.82]],
/*GEN:END*/
];

/* Slowing down, which the cone needs as much as speeding up: turn towards a
 * deeper angle whose target is below the speed you are carrying and you do not
 * hold that speed, you bleed it. Read the same way as the table above, from the
 * 10th percentile of every DECELERATING sample at each speed — the rate of a
 * boat actually killing speed rather than one easing off. Magnitudes, km/h per
 * second. (Inside the no-go the archive gives −4.55 at the same percentile,
 * which is the same order; nothing here needs a special case for it.) */
const ACCEL_DECEL = [/*GEN:DECEL*/0.46, 0.91, 1.88, 2.90, 3.35, 2.89, 2.95, 2.58, 1.84, 2.08/*GEN:END*/];

const accelBand = (x, edges) => {
  for (let i = 0; i < edges.length; i++) if (x < edges[i]) return i;
  return edges.length;
};

/* Linear along the ANGLE axis, between bin CENTRES, so the cone is a curve
 * rather than a staircase: a bin's value is truest in its middle, and halfway
 * between two middles the honest answer is halfway between the two values.
 * A null neighbour contributes nothing — the defined side holds flat instead
 * of inventing a slope into a cell nobody measured; both sides null is null,
 * and the caller falls back exactly as it did for a single null bin. Beyond
 * the first or last centre the end value holds (extrapolating a trend past
 * the data would claim more than the table knows). */
function accelLerp(get, centres, A) {
  if (A <= centres[0]) return get(0);
  const n = centres.length;
  if (A >= centres[n - 1]) return get(n - 1);
  let i = 0;
  while (i < n - 2 && A > centres[i + 1]) i++;
  const lo = get(i), hi = get(i + 1);
  if (lo == null) return hi;
  if (hi == null) return lo;
  return lo + (hi - lo) * (A - centres[i]) / (centres[i + 1] - centres[i]);
}
const ACCEL_TWA_CTR = [45, 75, 105, 150];       // centres of the mined bands

/* Acceleration in km/h per second, at this speed, wind and angle.
 * k = 0 reads the repeatable table, k = 1 the best-of-it one. */
function accelAt(v, tws, twaAbs, k) {
  const vb = Math.max(0, Math.min(ACCEL_P75.length - 1,
                                  Math.floor((v || 0) / ACCEL_V_STEP)));
  const wb = accelBand(tws || 0, ACCEL_TWS);
  const kk = Math.max(0, Math.min(1, k || 0));
  return accelLerp(
    j => ACCEL_P75[vb][wb][j] + (ACCEL_P90[vb][wb][j] - ACCEL_P75[vb][wb][j]) * kk,
    ACCEL_TWA_CTR, Math.abs(twaAbs || 0));
}

/* How far you get in T seconds if you pull the trigger now and hold this
 * angle: integrated forward in short steps rather than solved, because the
 * acceleration is a table with a soft patch in the middle of it and no closed
 * form. Capped at the polar target for the angle — the table has no ceiling in
 * it, since a 90th percentile never goes negative.
 *
 * Returns metres run and the speed you arrive at. */
const ACCEL_DT = 0.5;

function accelRun(v0, tws, twaAbs, T, k, vCap, cfg) {
  let v = Math.max(0, v0 || 0), d = 0;
  if (!(T > 0)) return { d: 0, v };
  /* No cap means no polar cell at this angle, and that is not a boat with an
   * unlimited ceiling — it is a heading the boat cannot sail. The caller
   * decides what to do about it; the honest answer from here is nowhere. */
  if (!(vCap > 0)) return { d: 0, v: 0 };
  for (let s = 0; s < T; s += ACCEL_DT) {
    const step = Math.min(ACCEL_DT, T - s);
    d += (v / 3.6) * step;
    if (v > vCap) {
      const vb = Math.max(0, Math.min(ACCEL_DECEL.length - 1, Math.floor(v / ACCEL_V_STEP)));
      v = Math.max(vCap, v - ACCEL_DECEL[vb] * step);
    } else {
      v = Math.min(vCap, v + accelAtCfg(cfg, v, tws, twaAbs, k) * step);
    }
  }
  return { d, v };
}


/* ── per-polar tables ────────────────────────────────────────────────────────
 *
 * The fleet does not sail one boat. Fifteen polar selections appear across
 * the 2025-26 seasons — different wings and appendages, different polars —
 * and they accelerate differently enough that one table splits the
 * difference badly: at 40-50 km/h on a beam angle the m15 heavy-air rig
 * manages roughly three times what the m14 does at p75. The race bundle
 * carries which config the fleet is in (rd.configs, e.g. 'm15_HAW_HSB2_
 * HSRW2'); its mNN prefix is the POLAR_SELECTION id these tables are keyed
 * by, so the lookup tries the full string first and then the prefix.
 *
 * Shape: [speed decade][TWA 15° bin ×12 (0-15 … 165-180)], p75 and p90,
 * km/h per second. null = fewer than 60 straight-line samples in that cell —
 * the lookup falls back to the pooled three-axis table above, which always
 * answers. The table has no wind axis because the polar IS the wind regime:
 * you are not in the heavy-air rig in 15 km/h of breeze.
 *
 * Mined by build/accel-table.py from the full fleet-wide Njord pull (every
 * boat, every event of 2025 and 2026 — ~5.8M straight-line samples).
 */
const ACCEL_CFG_TWA = [15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165];
const ACCEL_CFG = {
/*GEN:CFG*/
  'm2': {  // 376,361 samples
   p75: [
    [0.10,0.19,0.20,0.22,0.17,0.13,0.14,0.19,0.17,0.14,0.14,0.13],
    [0.07,0.22,0.35,0.46,0.60,0.63,0.49,0.38,0.26,0.19,0.17,0.16],
    [0.05,0.22,0.60,0.61,0.61,0.63,0.69,0.67,0.34,0.07,0.05,0.05],
    [null,0.05,0.56,0.91,0.99,1.00,1.05,1.08,0.94,0.63,0.05,0.05],
    [0.05,0.16,0.40,0.61,0.98,1.44,1.52,1.15,0.99,0.79,0.41,0.05],
    [null,0.09,0.31,0.46,0.75,1.34,1.19,0.81,0.72,0.47,0.31,0.48],
    [null,null,0.35,0.73,1.06,1.07,0.77,0.62,0.54,0.31,0.41,0.27],
    [null,null,null,null,1.28,1.11,0.68,0.35,0.40,0.56,0.54,0.17],
    [null,null,null,null,null,null,null,null,null,0.67,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
   ],
   p90: [
    [0.25,0.41,0.44,0.44,0.35,0.29,0.33,0.39,0.36,0.30,0.29,0.29],
    [0.24,0.57,0.93,0.92,1.07,1.09,0.82,0.70,0.53,0.42,0.38,0.39],
    [0.05,0.67,1.12,1.10,1.05,1.09,1.16,1.11,0.82,0.47,0.37,0.18],
    [null,0.09,1.16,1.49,1.49,1.48,1.56,1.52,1.41,1.08,0.29,0.05],
    [0.19,0.49,0.86,1.12,1.54,2.09,2.11,1.71,1.56,1.34,1.14,0.29],
    [null,0.39,0.70,0.89,1.37,2.08,1.86,1.43,1.33,1.03,0.92,1.37],
    [null,null,0.74,1.31,1.97,1.72,1.29,1.13,1.07,0.81,1.16,0.75],
    [null,null,null,null,1.77,1.71,1.15,0.84,1.06,1.21,1.13,0.48],
    [null,null,null,null,null,null,null,null,null,1.06,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
   ] },
  'm8': {  // 982,219 samples
   p75: [
    [0.09,0.22,0.28,0.19,0.17,0.10,0.12,0.11,0.09,0.10,0.09,0.08],
    [0.05,0.26,0.45,0.42,0.37,0.34,0.35,0.27,0.22,0.17,0.13,0.11],
    [0.05,0.05,0.76,0.74,0.61,0.54,0.62,0.60,0.33,0.18,0.05,0.05],
    [0.05,0.05,0.28,1.02,1.09,0.95,0.88,0.98,0.89,0.05,0.05,0.05],
    [0.46,0.16,0.36,1.00,1.38,1.65,1.53,1.31,1.27,1.05,0.05,0.05],
    [0.16,0.24,0.33,0.63,0.96,1.38,1.43,1.20,1.32,1.42,0.90,0.05],
    [null,null,0.29,0.55,0.96,1.25,1.23,1.01,1.00,0.73,0.27,0.31],
    [null,null,null,0.86,0.91,1.02,0.97,0.71,0.63,0.46,0.22,null],
    [null,null,null,null,0.56,0.85,0.80,0.57,0.34,0.29,0.25,null],
    [null,null,null,null,null,null,null,0.50,null,null,null,null],
   ],
   p90: [
    [0.27,0.49,0.69,0.40,0.38,0.23,0.27,0.30,0.21,0.26,0.25,0.21],
    [0.26,0.74,1.08,0.88,0.73,0.68,0.70,0.57,0.46,0.38,0.31,0.30],
    [0.53,0.55,1.45,1.35,1.10,1.06,1.32,1.22,0.80,0.55,0.32,0.17],
    [1.32,0.27,0.95,1.54,1.58,1.50,1.47,1.66,1.67,0.36,0.05,0.05],
    [1.16,0.46,0.86,1.55,1.99,2.40,2.27,2.01,1.99,1.69,0.87,0.05],
    [0.39,0.56,0.72,1.07,1.59,2.28,2.31,2.00,2.10,2.12,1.63,0.05],
    [null,null,0.69,1.00,1.59,1.99,1.93,1.75,1.74,1.53,0.91,0.84],
    [null,null,null,1.26,1.42,1.64,1.57,1.29,1.22,0.98,0.65,null],
    [null,null,null,null,1.01,1.32,1.26,1.08,0.86,0.69,0.67,null],
    [null,null,null,null,null,null,null,0.78,null,null,null,null],
   ] },
  'm9': {  // 148,825 samples
   p75: [
    [0.06,0.22,0.32,0.33,null,null,null,null,0.16,0.11,0.09,0.09],
    [0.05,0.28,0.51,0.65,0.72,0.56,0.45,0.23,0.17,0.13,0.12,0.07],
    [0.05,0.07,0.86,1.09,1.22,0.75,1.11,0.58,0.20,0.10,0.05,0.05],
    [null,0.05,0.64,1.36,1.52,1.50,1.45,1.76,0.05,0.05,0.05,0.05],
    [null,0.05,0.60,1.57,2.05,2.69,1.90,2.22,0.60,0.05,0.05,null],
    [null,0.05,0.43,0.93,1.70,2.63,2.25,2.13,1.95,0.05,null,null],
    [null,null,0.40,0.63,1.25,1.92,2.09,2.34,2.33,1.13,null,null],
    [null,null,null,1.07,1.29,1.59,1.70,1.17,0.71,0.05,null,null],
    [null,null,null,null,1.03,1.15,1.55,0.80,0.49,0.15,null,null],
    [null,null,null,null,null,null,0.89,0.46,0.21,null,null,null],
   ],
   p90: [
    [0.23,0.51,0.77,0.73,null,null,null,null,0.29,0.26,0.20,0.20],
    [0.10,0.74,1.20,1.36,1.25,1.15,0.86,0.58,0.36,0.29,0.27,0.21],
    [0.05,0.35,1.77,1.81,1.86,1.41,1.95,1.31,0.57,0.33,0.05,0.05],
    [null,0.05,1.36,2.00,2.05,2.22,2.29,2.41,0.05,0.05,0.05,0.05],
    [null,0.05,1.26,2.20,2.85,3.33,3.21,3.27,1.60,0.05,0.05,null],
    [null,0.55,0.92,1.52,2.61,3.52,3.47,2.90,2.72,1.04,null,null],
    [null,null,0.80,1.15,2.10,2.87,3.40,3.04,3.09,1.99,null,null],
    [null,null,null,1.65,2.03,2.40,2.65,2.01,1.72,0.51,null,null],
    [null,null,null,null,1.56,1.87,2.40,1.38,1.03,0.56,null,null],
    [null,null,null,null,null,null,1.40,0.98,0.85,null,null,null],
   ] },
  'm10': {  // 898,739 samples
   p75: [
    [0.08,0.15,0.18,0.12,0.10,0.08,0.09,0.12,0.12,0.11,0.09,0.09],
    [0.10,0.19,0.36,0.37,0.31,0.28,0.21,0.17,0.17,0.15,0.11,0.12],
    [0.05,0.05,0.40,0.39,0.46,0.41,0.38,0.30,0.23,0.11,0.05,0.05],
    [0.05,0.05,0.31,0.78,0.80,0.69,0.62,0.68,0.41,0.18,0.05,0.05],
    [null,0.23,0.30,0.72,1.00,1.28,1.12,0.93,0.73,0.73,0.05,0.06],
    [0.21,0.25,0.27,0.51,0.79,0.98,0.96,0.74,0.69,0.84,0.28,0.24],
    [null,0.13,0.29,0.54,0.77,0.90,0.91,0.80,0.63,0.39,0.09,0.14],
    [null,null,null,0.79,0.81,0.71,0.61,0.39,0.37,0.34,0.08,null],
    [null,null,null,null,0.69,0.74,0.57,0.47,0.33,0.42,0.34,null],
    [null,null,null,null,null,null,0.80,0.31,0.28,0.42,null,null],
   ],
   p90: [
    [0.21,0.36,0.46,0.30,0.23,0.21,0.23,0.25,0.27,0.23,0.22,0.23],
    [0.30,0.55,0.82,0.83,0.64,0.59,0.46,0.36,0.38,0.34,0.26,0.29],
    [0.17,0.62,0.94,0.81,0.83,0.75,0.76,0.69,0.54,0.43,0.26,0.28],
    [0.05,0.05,0.98,1.31,1.26,1.12,1.05,1.14,0.89,0.90,0.05,0.69],
    [null,0.86,0.74,1.25,1.60,1.95,1.72,1.44,1.33,1.41,0.51,0.62],
    [0.44,0.55,0.64,0.95,1.36,1.81,1.76,1.33,1.48,1.66,1.02,0.60],
    [null,0.40,0.68,0.95,1.44,1.66,1.58,1.42,1.28,0.99,0.45,0.40],
    [null,null,null,1.30,1.31,1.31,1.23,0.90,0.82,0.85,0.53,null],
    [null,null,null,null,1.12,1.21,1.05,0.83,0.70,0.99,0.88,null],
    [null,null,null,null,null,null,1.11,0.65,0.57,0.85,null,null],
   ] },
  'm12': {  // 19,592 samples
   p75: [
    [0.05,0.21,0.14,0.14,0.17,0.22,0.18,0.18,0.12,0.15,0.13,0.12],
    [null,0.27,0.24,0.23,0.22,0.29,0.28,0.14,0.07,0.30,0.18,0.07],
    [null,0.36,0.51,0.30,0.30,0.17,0.33,0.60,0.77,0.47,null,null],
    [null,null,0.54,1.07,0.91,null,0.77,0.71,0.53,null,0.24,null],
    [null,0.43,1.08,1.66,0.68,null,null,null,0.76,null,null,null],
    [null,0.36,null,null,0.26,null,null,null,1.60,0.82,null,null],
    [null,null,null,null,null,null,null,null,0.49,0.40,0.10,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
   ],
   p90: [
    [0.17,0.38,0.42,0.30,0.32,0.38,0.43,0.28,0.24,0.32,0.28,0.24],
    [null,0.86,0.62,0.43,0.42,0.54,0.47,0.28,0.27,0.67,0.43,0.19],
    [null,0.66,0.95,0.80,0.46,0.33,1.14,1.05,1.10,0.81,null,null],
    [null,null,0.87,1.46,1.41,null,0.96,1.03,0.90,null,0.46,null],
    [null,0.68,1.74,2.27,1.21,null,null,null,1.51,null,null,null],
    [null,0.70,null,null,0.59,null,null,null,2.28,1.28,null,null],
    [null,null,null,null,null,null,null,null,0.96,0.83,0.23,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
   ] },
  'm13': {  // 11,587 samples
   p75: [
    [0.05,0.14,0.25,0.05,0.13,null,null,0.08,0.07,0.05,0.05,null],
    [0.14,0.16,0.17,0.20,0.18,0.11,0.05,null,0.05,0.07,null,null],
    [null,null,0.67,0.45,0.37,null,null,null,null,null,null,null],
    [null,null,0.43,1.01,0.53,0.65,null,null,null,null,null,null],
    [null,null,0.29,0.54,0.93,null,null,1.05,1.22,null,null,null],
    [null,null,null,0.36,0.66,null,null,1.25,0.88,0.30,null,null],
    [null,null,null,null,null,null,null,null,0.45,0.19,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
   ],
   p90: [
    [0.21,0.34,0.37,0.21,0.21,null,null,0.13,0.14,0.10,0.08,null],
    [0.31,0.43,0.70,0.37,0.35,0.18,0.11,null,0.10,0.12,null,null],
    [null,null,1.10,0.96,0.72,null,null,null,null,null,null,null],
    [null,null,0.80,1.44,1.25,0.94,null,null,null,null,null,null],
    [null,null,0.54,0.93,1.39,null,null,1.62,1.66,null,null,null],
    [null,null,null,0.60,1.09,null,null,2.26,1.48,0.95,null,null],
    [null,null,null,null,null,null,null,null,0.70,0.49,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
   ] },
  'm14': {  // 460,447 samples
   p75: [
    [0.09,0.19,0.28,0.18,0.18,0.22,0.19,0.16,0.13,0.12,0.10,0.08],
    [0.05,0.29,0.46,0.54,0.52,0.41,0.39,0.24,0.19,0.13,0.09,0.11],
    [0.05,0.05,0.54,0.63,0.64,0.54,0.44,0.27,0.14,0.05,0.05,0.05],
    [0.05,0.05,0.05,0.82,0.97,0.93,0.85,0.81,0.52,0.05,0.05,0.05],
    [0.26,0.14,0.31,0.74,1.14,1.40,1.51,1.21,1.01,0.76,0.05,0.05],
    [0.41,0.20,0.27,0.54,0.76,1.09,1.17,1.05,0.99,0.69,0.35,0.05],
    [null,null,0.25,0.48,0.95,0.93,0.99,0.96,0.74,0.49,0.08,0.05],
    [null,null,null,null,1.16,0.82,0.71,0.56,0.40,0.42,0.08,null],
    [null,null,null,null,null,0.83,0.60,0.33,0.20,0.31,0.18,null],
    [null,null,null,null,null,null,null,null,null,0.36,null,null],
   ],
   p90: [
    [0.24,0.46,0.70,0.43,0.38,0.41,0.42,0.33,0.29,0.27,0.22,0.20],
    [0.22,0.76,0.98,1.01,0.91,0.72,0.74,0.51,0.42,0.33,0.28,0.28],
    [0.06,0.38,1.21,1.17,1.15,0.97,0.90,0.75,0.61,0.33,0.19,0.18],
    [0.05,0.05,0.59,1.33,1.45,1.43,1.37,1.33,1.14,0.42,0.34,0.05],
    [0.62,0.46,0.77,1.27,1.69,2.00,2.12,1.76,1.58,1.39,0.62,0.05],
    [0.81,0.46,0.67,0.98,1.36,1.77,1.87,1.72,1.62,1.44,1.08,0.05],
    [null,null,0.75,0.94,1.56,1.56,1.64,1.63,1.33,1.16,0.60,0.31],
    [null,null,null,null,1.62,1.39,1.19,1.03,0.90,0.96,0.45,null],
    [null,null,null,null,null,1.49,0.97,0.59,0.62,0.89,0.79,null],
    [null,null,null,null,null,null,null,null,null,0.97,null,null],
   ] },
  'm15': {  // 1,070,818 samples
   p75: [
    [0.09,0.22,0.24,0.17,0.14,0.13,0.10,0.10,0.09,0.09,0.09,0.08],
    [0.05,0.29,0.41,0.33,0.30,0.27,0.22,0.16,0.15,0.15,0.13,0.12],
    [0.05,0.05,1.08,0.99,0.61,0.47,0.54,0.50,0.33,0.20,0.12,0.05],
    [0.05,0.05,0.87,1.41,1.25,1.14,1.13,1.02,0.44,0.05,0.05,0.05],
    [null,0.05,0.74,1.38,1.46,1.69,1.44,1.34,1.22,0.46,0.05,0.05],
    [null,0.05,0.47,0.85,1.17,1.78,1.30,1.14,1.57,1.18,0.05,0.05],
    [null,null,0.38,0.57,0.98,1.79,1.41,1.03,1.43,1.72,0.57,0.05],
    [null,null,0.60,0.75,1.20,1.29,1.29,1.12,1.02,0.50,0.05,null],
    [null,null,null,null,1.28,1.03,0.78,0.69,0.57,0.35,0.09,null],
    [null,null,null,null,null,1.25,0.87,0.45,0.21,0.31,0.06,null],
   ],
   p90: [
    [0.28,0.52,0.61,0.36,0.29,0.26,0.20,0.20,0.18,0.19,0.20,0.19],
    [0.17,0.79,0.97,0.73,0.61,0.55,0.46,0.35,0.34,0.35,0.33,0.29],
    [0.05,0.80,1.85,1.76,1.13,0.97,1.18,1.08,0.75,0.54,0.41,0.05],
    [0.05,0.05,1.62,1.99,1.87,1.81,1.88,1.88,1.44,0.57,0.05,0.05],
    [null,0.05,1.32,1.98,2.24,2.56,2.26,1.89,1.86,1.15,0.05,0.05],
    [null,0.37,0.96,1.40,1.94,2.78,2.20,1.85,2.25,1.92,0.43,0.05],
    [null,null,0.78,1.03,1.75,2.69,2.53,1.90,2.46,2.48,1.50,0.43],
    [null,null,1.18,1.40,1.98,2.09,2.06,1.88,1.89,1.27,0.44,null],
    [null,null,null,null,2.02,1.62,1.34,1.43,1.14,0.81,0.46,null],
    [null,null,null,null,null,1.74,1.41,1.03,0.60,0.81,0.63,null],
   ] },
  'm16': {  // 653,063 samples
   p75: [
    [0.09,0.15,0.19,0.18,0.17,0.16,0.14,0.11,0.10,0.10,0.09,0.10],
    [0.07,0.16,0.32,0.33,0.27,0.25,0.19,0.16,0.13,0.12,0.09,0.10],
    [0.05,0.05,0.27,0.38,0.48,0.39,0.36,0.28,0.06,0.05,0.05,0.05],
    [0.11,0.05,0.09,0.55,0.89,1.02,0.99,0.81,0.69,0.23,0.05,0.16],
    [0.22,0.24,0.21,0.41,0.63,0.88,0.99,0.80,0.55,0.23,0.21,0.31],
    [0.21,0.30,0.26,0.39,0.51,0.61,0.65,0.54,0.34,0.16,0.10,0.38],
    [null,null,null,null,0.60,0.59,0.54,0.62,0.37,0.20,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
   ],
   p90: [
    [0.25,0.35,0.45,0.43,0.36,0.30,0.27,0.24,0.23,0.25,0.26,0.26],
    [0.31,0.50,0.69,0.65,0.54,0.49,0.44,0.38,0.33,0.35,0.26,0.24],
    [0.05,0.05,0.69,0.72,0.82,0.73,0.69,0.62,0.38,0.07,0.11,0.58],
    [0.51,0.23,0.47,0.92,1.28,1.43,1.43,1.24,1.13,0.69,0.30,1.19],
    [0.44,0.57,0.52,0.75,1.06,1.37,1.47,1.28,1.00,0.65,0.59,0.68],
    [0.41,0.63,0.52,0.80,0.93,1.02,1.02,0.96,0.72,0.47,0.28,0.82],
    [null,null,null,null,0.85,0.93,0.81,1.08,0.74,0.61,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
   ] },
  'm18': {  // 143,784 samples
   p75: [
    [0.08,0.12,0.16,0.19,0.20,0.17,0.17,0.15,0.14,0.10,0.10,0.11],
    [0.05,0.05,0.15,0.17,0.19,0.21,0.18,0.13,0.11,0.11,0.12,0.10],
    [null,null,null,0.36,0.16,0.22,0.15,0.12,0.13,0.13,0.12,0.10],
    [null,null,null,0.91,1.11,1.06,null,null,0.21,null,null,null],
    [null,null,0.13,0.32,0.59,1.03,null,1.30,0.92,null,null,null],
    [null,null,null,null,null,null,null,0.67,0.31,0.14,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
   ],
   p90: [
    [0.20,0.26,0.34,0.37,0.38,0.32,0.30,0.27,0.27,0.23,0.22,0.24],
    [0.10,0.14,0.37,0.33,0.34,0.36,0.31,0.26,0.23,0.23,0.24,0.24],
    [null,null,null,0.62,0.33,0.38,0.30,0.27,0.20,0.21,0.22,0.19],
    [null,null,null,1.21,1.40,1.45,null,null,0.74,null,null,null],
    [null,null,0.40,0.54,0.98,1.36,null,1.58,1.31,null,null,null],
    [null,null,null,null,null,null,null,0.85,0.57,0.34,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
   ] },
  'm21': {  // 703,427 samples
   p75: [
    [0.08,0.17,0.22,0.21,0.19,0.17,0.18,0.17,0.15,0.12,0.09,0.07],
    [0.07,0.30,0.39,0.33,0.37,0.34,0.30,0.22,0.16,0.15,0.14,0.07],
    [0.05,0.07,0.33,0.37,0.40,0.39,0.32,0.26,0.17,0.18,0.09,0.05],
    [0.05,0.05,0.36,0.56,0.66,0.77,0.81,0.73,0.54,0.29,0.09,0.05],
    [0.20,0.21,0.37,0.51,0.58,0.67,0.81,0.59,0.39,0.32,0.28,0.14],
    [null,0.19,0.33,0.57,0.80,0.90,0.72,0.59,0.51,0.64,0.26,0.16],
    [null,null,null,0.55,0.76,0.78,0.83,0.69,0.64,0.42,0.05,null],
    [null,null,null,null,null,null,0.84,0.48,0.47,0.16,0.05,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
   ],
   p90: [
    [0.22,0.38,0.48,0.45,0.43,0.35,0.35,0.33,0.32,0.28,0.23,0.20],
    [0.28,0.73,0.79,0.63,0.64,0.60,0.54,0.45,0.38,0.39,0.40,0.24],
    [0.05,0.38,0.69,0.69,0.69,0.66,0.60,0.55,0.47,0.46,0.39,0.05],
    [0.62,0.40,0.79,1.04,1.11,1.20,1.19,1.12,0.95,0.82,0.44,0.09],
    [0.45,0.47,0.73,0.92,1.06,1.19,1.31,1.00,0.78,0.84,0.74,0.30],
    [null,0.37,0.65,1.02,1.33,1.43,1.28,1.02,1.03,1.35,0.86,0.42],
    [null,null,null,0.83,1.10,1.30,1.34,1.27,1.19,0.90,0.53,null],
    [null,null,null,null,null,null,1.26,0.92,0.88,0.66,0.51,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
   ] },
  'm22': {  // 75,152 samples
   p75: [
    [0.23,0.31,0.49,0.47,0.36,0.33,0.20,0.31,0.34,0.17,0.19,0.22],
    [0.23,0.39,0.48,0.55,0.63,0.54,0.50,0.53,0.34,0.24,0.20,0.21],
    [0.23,0.47,0.63,0.75,0.70,0.82,0.77,0.70,0.43,0.29,0.17,0.05],
    [null,0.09,0.66,0.86,0.69,0.74,1.14,1.42,1.31,0.54,0.05,0.05],
    [null,0.05,0.50,0.76,0.80,0.98,1.16,1.83,1.53,1.35,1.24,0.90],
    [null,null,0.42,0.66,0.87,0.99,0.91,1.24,1.37,0.77,1.02,null],
    [null,null,null,null,null,1.10,1.01,0.91,0.77,0.66,0.65,null],
    [null,null,null,null,null,null,null,null,0.87,0.47,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
   ],
   p90: [
    [0.49,0.65,0.91,0.85,0.72,0.51,0.45,0.61,0.61,0.38,0.35,0.44],
    [0.60,1.01,1.06,1.05,1.22,1.11,0.92,0.97,0.70,0.56,0.45,0.50],
    [0.52,1.00,1.28,1.25,1.38,1.42,1.35,1.41,0.90,0.72,0.51,0.05],
    [null,0.49,1.25,1.41,1.31,1.44,1.85,2.08,2.07,1.33,0.17,0.05],
    [null,0.44,0.98,1.27,1.44,1.69,2.23,2.71,2.09,2.14,2.00,1.69],
    [null,null,0.82,1.32,1.58,1.80,1.75,2.22,1.99,1.45,1.80,null],
    [null,null,null,null,null,1.77,1.74,1.41,1.42,1.22,1.19,null],
    [null,null,null,null,null,null,null,null,1.22,0.99,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
   ] },
  'm23': {  // 254,900 samples
   p75: [
    [0.06,0.14,0.19,0.16,0.14,0.13,0.14,0.12,0.12,0.09,0.06,0.05],
    [0.05,0.21,0.36,0.35,0.25,0.23,0.20,0.17,0.12,0.10,0.09,0.07],
    [0.05,0.05,0.61,0.76,0.68,0.53,0.36,0.38,0.26,0.11,0.05,0.05],
    [null,0.05,0.34,0.91,1.08,1.11,1.04,0.93,0.77,0.19,0.05,0.05],
    [null,0.05,0.35,0.67,1.03,1.33,1.22,1.02,0.99,0.64,0.16,0.05],
    [null,0.09,0.31,0.50,0.79,1.04,0.96,0.85,0.59,0.38,0.15,null],
    [null,null,0.25,0.46,0.70,1.00,0.94,0.74,0.61,0.37,0.12,null],
    [null,null,null,null,0.90,1.05,0.83,0.51,0.47,0.35,0.18,null],
    [null,null,null,null,null,null,0.63,null,0.28,0.21,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
   ],
   p90: [
    [0.17,0.35,0.41,0.34,0.30,0.26,0.26,0.25,0.23,0.18,0.15,0.14],
    [0.17,0.63,0.80,0.72,0.53,0.49,0.41,0.34,0.29,0.24,0.24,0.18],
    [0.05,0.05,1.28,1.25,1.07,1.01,0.80,0.74,0.64,0.43,0.21,0.05],
    [null,0.05,0.80,1.39,1.56,1.55,1.55,1.40,1.31,0.62,0.05,0.05],
    [null,0.33,0.77,1.13,1.62,1.94,1.86,1.51,1.45,1.19,0.89,0.05],
    [null,0.40,0.64,0.88,1.32,1.69,1.57,1.39,1.16,0.98,0.65,null],
    [null,null,0.57,0.86,1.13,1.61,1.62,1.16,1.12,0.89,0.49,null],
    [null,null,null,null,1.47,1.52,1.22,0.94,0.89,0.77,0.54,null],
    [null,null,null,null,null,null,0.89,null,0.70,0.60,null,null],
    [null,null,null,null,null,null,null,null,null,null,null,null],
   ] },
/*GEN:END*/
};

/* Acceleration for THIS fleet configuration, falling back to the pooled table
 * where the config is unknown or its cells are thin. Interpolated along the
 * angle axis between the 15° bin centres, same contract as accelAt. */
const ACCEL_CFG_CTR = ACCEL_CFG_TWA.map(e => e - 7.5).concat([172.5]);
function accelAtCfg(cfg, v, tws, twaAbs, k) {
  const tab = cfg && (ACCEL_CFG[cfg] || ACCEL_CFG[String(cfg).split('_')[0]]);
  if (tab) {
    const vb = Math.max(0, Math.min(9, Math.floor((v || 0) / ACCEL_V_STEP)));
    const kk = Math.max(0, Math.min(1, k || 0));
    const a = accelLerp(j => {
      const lo = tab.p75[vb][j], hi = tab.p90[vb][j];
      return lo == null || hi == null ? null : lo + (hi - lo) * kk;
    }, ACCEL_CFG_CTR, Math.abs(twaAbs || 0));
    if (a != null) return a;
  }
  return accelAt(v, tws, twaAbs, k);
}

/* Seconds to cover `dist` metres holding one angle — the inverse of accelRun,
 * and the quantity a time-to-kill is made of. Same physics: build from the
 * speed you are doing at the measured rate for this config, capped at the
 * polar; bleed at the measured deceleration if you are above the cap. Returns
 * null where the heading cannot cover the distance in any sane time. */
const TTL_MAX_S = 600;

function ttlRun(v0, tws, twaAbs, dist, k, vCap, cfg) {
  if (!(dist > 0)) return 0;
  if (!(vCap > 0)) return null;
  let v = Math.max(0, v0 || 0), d = 0, t = 0;
  while (d < dist) {
    if (t > TTL_MAX_S) return null;
    d += (v / 3.6) * ACCEL_DT;
    if (v > vCap) {
      const vb = Math.max(0, Math.min(ACCEL_DECEL.length - 1, Math.floor(v / ACCEL_V_STEP)));
      v = Math.max(vCap, v - ACCEL_DECEL[vb] * ACCEL_DT);
    } else {
      v = Math.min(vCap, v + accelAtCfg(cfg, v, tws, twaAbs, k) * ACCEL_DT);
    }
    t += ACCEL_DT;
  }
  // the last step overshoots by up to ACCEL_DT·v — refund the overshoot
  return t - (d - dist) / Math.max(v / 3.6, 0.1);
}

/* The speed ceiling for a heading HELD — which is not the same question the
 * WAVE asks, and the difference is the whole reason this overlay exists.
 *
 * The WAVE projects the target angle onto headings inside the no-go, because a
 * boat asked to REACH a piece of water may tack to get there. An arm of this
 * fan is not a destination, it is a heading you steer and hold, and nobody
 * sails at the wind.
 *
 * But the polar alone is not the answer either. This fleet's table has no cells
 * below about 48 degrees — not because the boat cannot go there but because
 * that is below the upwind target, and a table of targets has no reason to
 * carry it. Reading "no cell" as "no speed" cuts a 96-degree wedge out of the
 * fan, straight through the angles a boat sails on every start.
 *
 * So the edge is measured instead, off 122,356 straight-line samples:
 *
 *     |TWA|      median sog     p90 sog
 *     15-20         6.6           11.3      stopped
 *     20-25         8.2           14.4      stopped
 *     25-30        10.6           35.9      coming out of it
 *     30-35        22.6           59.8      a boat pinching is near full speed
 *     35-40        53.8           62.9      sailing
 *     40-45        56.4           63.8      sailing
 *
 * The median is misleading between 25 and 35 because most samples in that band
 * are mid-tack — a boat passing through, not one holding the angle. The p90 is
 * the boat that IS holding it, and read against 62.9 it runs 0.23, 0.57, 0.95,
 * 1.00 across those four bands. A straight ramp from nothing at 20 degrees to
 * everything at 35 gives 0.17, 0.50, 0.83, 1.00 — a shade conservative all the
 * way along, which is the right direction for it to be wrong.
 */
const CONE_NOGO = { dead: 20, full: 35 };

/* The lowest angle the polar will actually answer for, at this wind. Probed
 * rather than read off the grid, because a grid line with a blank cell is not
 * an angle the table can answer for. Cached per race and wind — it moves only
 * with the wind speed, and only across whole degrees. */
function polarFloor(rd, tws) {
  const key = Math.round(tws);
  if (!rd._polFloor) rd._polFloor = {};
  if (rd._polFloor[key] != null) return rd._polFloor[key];
  let a0 = null;
  if (rd.polar) {
    for (let a = 1; a <= 90; a++)
      if (polarSpeed(rd.polar, a, tws) > 0) { a0 = a; break; }
  }
  return (rd._polFloor[key] = a0);
}

function coneCap(rd, twaAbs, tws) {
  if (!rd.polar) return 0;
  const direct = polarSpeed(rd.polar, twaAbs, tws);
  if (direct > 0) return direct;
  const a0 = polarFloor(rd, tws);
  // Below the table's floor, and above the deep limit if the table has one:
  // only the upwind side is ramped, because that is the side with a no-go.
  if (a0 == null || twaAbs >= a0) return 0;
  const k = Math.max(0, Math.min(1,
    (twaAbs - CONE_NOGO.dead) / (CONE_NOGO.full - CONE_NOGO.dead)));
  return k > 0 ? polarSpeed(rd.polar, a0, tws) * k : 0;
}
