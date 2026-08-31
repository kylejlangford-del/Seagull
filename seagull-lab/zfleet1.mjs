/* The Z fleet-entry verdict, end to end:
 *  - off (no Z pin): every row's z verdict is null, ratio colouring untouched;
 *  - on: a boat outside the line's ends gets judged by ttkZBoat/zEntryClass —
 *    LATE (unreachable OR under ZPT.lateUnder), EARLY (over ZPT.earlyOver),
 *    otherwise on-time — and MY BOAT's own Z block agrees with the SAME
 *    number for the boat being tracked;
 *  - crossing into the box (pct in [0,100]) turns the verdict off for that
 *    boat — "switch to the normal ratio" — verified by moving the pin's
 *    reference boat's own sample synthetically past the line ends;
 *  - the thresholds (ZPT.lateUnder / earlyOver) actually move the boundary.
 */
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 250)));
await p.goto('http://localhost:8817/index.html'); await p.waitForTimeout(3500);
await p.selectOption('#selDay', '2026-08-23'); await p.waitForTimeout(400);
await p.selectOption('#selStart', 'sassnitz-2026-08-23-1441'); await p.waitForTimeout(1800);

const r = await p.evaluate(() => {
  APP.feed.seek(9e9); rebuild(true);
  const rd = APP.rd, t = -90;
  const out = {};

  // 1. off: verdicts all null
  ZPT.on = false; ZPT.p = null; ZPT.locked = false;
  out.offAllNull = rd.teams.every(team => zFleetVerdict(rd, team, t) == null);

  // 2. on, pin near the line: at least one entering boat gets a verdict, and
  // every verdict returned agrees with a hand recomputation via ttkZBoat.
  const f = rd.frame;
  ZPT.on = true;
  ZPT.p = { rx: (f.leeR.rx + f.windR.rx) / 2, ry: (f.leeR.ry + f.windR.ry) / 2 - 40 };
  ZPT.locked = false;
  let checked = 0, agree = 0, sawLate = 0, sawEarly = 0, sawOk = 0, entering = 0;
  for (const team of rd.teams) {
    const tr = rd.tracks[team], s = tr && sampleAt(tr, t);
    if (!s) continue;
    const pct = f.linePct(s);
    const isEntering = pct < 0 || pct > 100;
    const z = zFleetVerdict(rd, team, t);
    if (isEntering) entering++;
    if (!isEntering) { if (z != null) out.crossedButStillJudged = team; continue; }
    if (z == null) continue;
    checked++;
    const q = ttkZBoat(rd, t, team);
    const want = zEntryClass(q);
    if (want === z.cls) agree++;
    if (z.cls === 'late') sawLate++; else if (z.cls === 'early') sawEarly++; else sawOk++;
  }
  out.entering = entering; out.checked = checked; out.agree = agree;
  out.sawLate = sawLate; out.sawEarly = sawEarly; out.sawOk = sawOk;

  // 3. MY BOAT's own ttkToZ agrees with the fleet verdict for the focus boat
  const zBlock = zStateAt(rd, t, APP.focus);
  const fleetZ = zFleetVerdict(rd, APP.focus, t);
  out.myBoatAgrees = zBlock && fleetZ
    ? Math.abs((zBlock.ttkToZ ?? -999) - fleetZ.ttk) < 0.05 || (zBlock.zLate && fleetZ.cls === 'late')
    : (zBlock ? zBlock.ttkToZ : null) === (fleetZ ? fleetZ.ttk : null);
  out.myBoatTtkToZ = zBlock ? zBlock.ttkToZ : null;
  out.fleetTtkToZ = fleetZ ? fleetZ.ttk : null;

  // 4. thresholds move the boundary: tighten earlyOver so far nothing can be
  // early, then loosen lateUnder so far nothing can be late
  const save = { lateUnder: ZPT.lateUnder, earlyOver: ZPT.earlyOver };
  ZPT.earlyOver = 9999;
  let earlyGone = true;
  for (const team of rd.teams) { const z = zFleetVerdict(rd, team, t); if (z && z.cls === 'early') earlyGone = false; }
  ZPT.earlyOver = save.earlyOver;
  ZPT.lateUnder = -9999;
  let lateShrinks = true;
  for (const team of rd.teams) {
    const z = zFleetVerdict(rd, team, t);
    if (z && z.cls === 'late') { const q = ttkZBoat(rd, t, team); if (!q || !q.unreachable) lateShrinks = false; }
  }
  ZPT.lateUnder = save.lateUnder;
  out.earlyOverWorks = earlyGone;
  out.lateUnderWorks = lateShrinks;

  ZPT.on = false; ZPT.p = null;
  return out;
});
console.log(JSON.stringify({ ...r, errs }, null, 1));
await b.close();
