/* The cone, checked against an independently written integrator.
 *
 * Not "does it draw" — whether the reach it claims is the reach the measured
 * table implies, at every arm, over every pre-start frame. The reference here
 * re-implements the integration from the table rather than calling the app's,
 * so the two can actually disagree.
 */
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 250)));
await p.goto('http://localhost:8817/index.html'); await p.waitForTimeout(3500);
await p.selectOption('#selDay', '2026-08-23'); await p.waitForTimeout(400);
await p.selectOption('#selStart', 'sassnitz-2026-08-23-1441'); await p.waitForTimeout(1800);

const out = await p.evaluate(async () => {
  APP.feed.seek(9e9); rebuild(true);
  const rd = APP.rd, tMin = rd.tMin, focus = APP.focus;

  // ── an independent integrator, written from the table's own contract ──
  // (the TABLES are shared data — the independence is in the loop and the
  // band logic. Per-polar first at 15° bins, pooled fallback, measured decel.)
  const bandOf = (x, edges) => { for (let i = 0; i < edges.length; i++) if (x < edges[i]) return i; return edges.length; };
  // angle interpolation between bin centres, nulls holding flat — written
  // fresh here to disagree with accel.js's accelLerp if either is wrong
  const CTR12 = Array.from({ length: 12 }, (_, i) => i * 15 + 7.5);
  const CTR4 = [45, 75, 105, 150];
  const lerpC = (get, ctr, A) => {
    if (A <= ctr[0]) return get(0);
    if (A >= ctr[ctr.length - 1]) return get(ctr.length - 1);
    let i = 0;
    while (i < ctr.length - 2 && A > ctr[i + 1]) i++;
    const lo = get(i), hi = get(i + 1);
    if (lo == null) return hi;
    if (hi == null) return lo;
    return lo + (hi - lo) * (A - ctr[i]) / (ctr[i + 1] - ctr[i]);
  };
  const cfgKey = rd.configs && rd.configs.length === 1 ? rd.configs[0] : null;
  const cfgTab = cfgKey && (ACCEL_CFG[cfgKey] || ACCEL_CFG[String(cfgKey).split('_')[0]]);
  function refRun(v0, tws, twa, T, k, cap) {
    if (!(cap > 0)) return 0;                 // cannot sail at the wind
    let v = Math.max(0, v0), d = 0;
    const n = Math.ceil(T / 0.5);
    for (let i = 0; i < n; i++) {
      const step = Math.min(0.5, T - i * 0.5);
      d += v / 3.6 * step;
      const vb = Math.min(9, Math.max(0, Math.floor(v / 10)));
      if (v > cap) { v = Math.max(cap, v - ACCEL_DECEL[vb] * step); continue; }
      const A = Math.abs(twa);
      let a = null;
      if (cfgTab)
        a = lerpC(j => {
          const lo = cfgTab.p75[vb][j], hi = cfgTab.p90[vb][j];
          return lo == null || hi == null ? null : lo + (hi - lo) * k;
        }, CTR12, A);
      if (a == null) {
        const wb = bandOf(tws, [20, 28, 36]);
        a = lerpC(j => ACCEL_P75[vb][wb][j] + (ACCEL_P90[vb][wb][j] - ACCEL_P75[vb][wb][j]) * k,
                  CTR4, A);
      }
      v = Math.min(cap, v + a * step);
    }
    return d;
  }

  let frames = 0, arms = 0, worst = 0, faults = [], monotone = 0, capped = 0;
  let minDist = Infinity, maxDist = 0, sumWave = 0, sumCone = 0, nCmp = 0;
  for (let t = Math.max(tMin, -150); t < -0.5; t += 0.5) {
    const c = conePoints(rd, t, focus);
    if (!c) continue;
    frames++;
    const me = sampleAt(rd.tracks[focus], t);
    for (const a of c.arms) {
      arms++;
      const want = refRun(me.sog, c.tws, (() => {
        let A = ((c.twd - a.brg) % 360 + 360) % 360; return A > 180 ? 360 - A : A;
      })(), -t, CONE.aggr, a.cap);
      const err = Math.abs(a.dist - want);
      if (err > worst) worst = err;
      if (err > 0.5 && faults.length < 6)
        faults.push({ t: +t.toFixed(1), brg: +a.brg.toFixed(0), got: +a.dist.toFixed(1), want: +want.toFixed(1) });
      if (a.dist < 0 || !isFinite(a.dist)) faults.push({ t, bad: a.dist });
      minDist = Math.min(minDist, a.dist); maxDist = Math.max(maxDist, a.dist);
      // Exceeding the cap is only a fault if we did not START above it: the
      // boat bleeds speed towards the ceiling, it does not snap to it.
      if (a.vEnd > a.cap + 1e-6 && a.cap > 0 && me.sog <= a.cap) capped++;
      // the cone must never claim more than the WAVE's instant-target model
      if (a.cap > 0) { sumCone += a.dist; sumWave += a.cap / 3.6 * (-t); nCmp++; }
    }
    // the reach must shrink monotonically as the gun approaches
    if (t > tMin + 1) {
      const prev = conePoints(rd, t - 0.5, focus);
      if (prev && prev.arms.length === c.arms.length) {
        const dNow = c.arms.reduce((s, a) => s + a.dist, 0);
        const dPrev = prev.arms.reduce((s, a) => s + a.dist, 0);
        if (dNow > dPrev + 1) monotone++;
      }
    }
  }
  // ── the no-go: every arm with zero reach must be an angle with no polar
  // cell, and every angle with a cell must have reach. No exceptions either way.
  let noGoArms = 0, noGoWrong = 0, sailableZero = 0;
  let widthMin = 999, widthMax = 0, sampleWidths = [];
  for (let t = -140; t < -1; t += 2) {
    const c = conePoints(rd, t, focus);
    if (!c) continue;
    let n = 0;
    for (const a of c.arms) {
      const cell = (APP.rd.polar && polarSpeed(APP.rd.polar, c.twd - a.brg, c.tws)) || 0;
      // Zero reach must mean an angle inside the measured dead zone; a cell in
      // the polar must always mean reach. Between the dead zone and the table's
      // floor the cap is the measured ramp, which has no cell by definition.
      let A = ((c.twd - a.brg) % 360 + 360) % 360; if (A > 180) A = 360 - A;
      if (a.dist === 0) { noGoArms++; n++; if (cell > 0) noGoWrong++; }
      else if (A <= CONE_NOGO.dead) sailableZero++;
    }
    const w = n * CONE.step;
    widthMin = Math.min(widthMin, w); widthMax = Math.max(widthMax, w);
    if (sampleWidths.length < 8) sampleWidths.push({ t: +t.toFixed(0), deg: w });
  }

  // ── the two lobes: every arm in a run must be on the run's tack, the tack
  // must agree with an independently computed one, and both lobes must appear.
  let runFrames = 0, bothTacks = 0, tackWrong = 0, runsSeen = [];
  for (let t = -140; t < -1; t += 1) {
    const c = conePoints(rd, t, focus);
    if (!c) continue;
    const runs = coneRuns(c.arms, c.wrap);
    if (!runs.length) continue;
    runFrames++;
    const kinds = new Set(runs.map(r => r.stbd));
    if (kinds.size === 2) bothTacks++;
    runsSeen.push(runs.length);
    for (const r of runs)
      for (const a of r.arms) {
        const ref = (((c.twd - a.brg) % 360 + 360) % 360) < 180;   // wind to stbd
        if (r.stbd !== a.stbd || a.stbd !== ref) tackWrong++;
      }
  }

  return { frames, arms, worstMetres: +worst.toFixed(4), faults, overCap: capped,
           noGoArms, noGoWrong, sailableZero,
           runFrames, bothTacksPct: +(bothTacks / runFrames * 100).toFixed(1),
           tackWrong, runsPerFrame: [Math.min(...runsSeen), Math.max(...runsSeen)],
           noGoWidthDeg: [widthMin, widthMax], sampleWidths,
           minDist: +minDist.toFixed(1), maxDist: +maxDist.toFixed(1),
           coneVsWave: +(sumCone / sumWave).toFixed(3), nCmp,
           growingFrames: monotone };
});

// and a picture
await p.evaluate(() => { APP.feed.seek(-25 + SMOOTH.lag); rebuild(true); draw(); });
await p.waitForTimeout(400);
await p.screenshot({ path: '/home/claude/figs/cone.png' });
console.log(JSON.stringify({ out, errs }, null, 1));
await b.close();
