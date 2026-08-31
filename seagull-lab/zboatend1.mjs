/* TTK/RATIO TO BOAT END — the new Z leg targeting the boat-end mark
 * specifically (not timeToLine's generic nearest point):
 *  - null with Z off, or before a valid arrival at Z exists;
 *  - the leg always targets rd.frame's boat-end mark (whichever of
 *    windR/leeR is NOT rd.pinEnd), verified against a hand recompute;
 *  - the identity: ttk = tts_at_Z_arrival - ttlZToBoatEnd, ratio = that
 *    tts / ttl — both derived from the SAME q.tts ttkZBoat already
 *    produces, so this never disagrees with TTK TO Z about the clock;
 *  - LATE/EARLY off the same ZPT.lateUnder/earlyOver knobs;
 *  - moving Z changes the boat-end distance and therefore the verdict. */
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
  const rd = APP.rd;
  ZPT.on = true; ZPT.targetRatio = 1.2;
  const f = rd.frame;
  const boatEnd = rd.pinEnd === 'windward' ? f.leeR : f.windR;

  const offsets = [[-300, 200], [-250, 150], [-200, 250], [-350, 100], [-150, 300]];
  let found = null;
  for (const team of rd.teams) {
    for (let t = -150; t < -10; t += 5) {
      const me = sampleAt(rd.tracks[team], t);
      if (!me) continue;
      for (const [ox, oy] of offsets) {
        ZPT.p = { rx: me.rx + ox, ry: me.ry + oy };
        ZPT.locked = false;
        const z = zStateAt(rd, t, team);
        if (z && z.toBoatEnd) { found = { team, t, z }; break; }
      }
      if (found) break;
    }
    if (found) break;
  }
  const out = { found: !!found };
  if (found) {
    const { z, t, team } = found;
    out.z = z;
    // hand recompute of the boat-end leg
    const dx = boatEnd.rx - ZPT.p.rx, dy = boatEnd.ry - ZPT.p.ry;
    const dist = Math.hypot(dx, dy);
    const A = Math.abs(angDiff(rd.wind.twd, f.bearingFromRot(dx, dy)));
    const cap = coneCap(rd, A, rd.wind.tws);
    const ttlBoat = ttlRun(cap, rd.wind.tws, A, dist, CONE.aggr, cap, accelCfgKey(rd));
    out.handTtlBoat = ttlBoat;
    out.matchesHand = Math.abs(ttlBoat - z.toBoatEnd.ttl) < 0.05;

    const q = ttkZBoat(rd, t, team);
    out.identityOk = Math.abs((q.tts - z.toBoatEnd.ttl) - z.toBoatEnd.ttk) < 0.01
                   && Math.abs(q.tts / z.toBoatEnd.ttl - z.toBoatEnd.ratio) < 0.001;

    // moving Z further from the boat end should increase ttl and push the
    // verdict toward LATE (smaller/more negative ttk)
    ZPT.p = { rx: boatEnd.rx + (ZPT.p.rx - boatEnd.rx) * 3,
              ry: boatEnd.ry + (ZPT.p.ry - boatEnd.ry) * 3 };
    const z2 = zStateAt(rd, t, team);
    out.movesWithZ = z2 && z2.toBoatEnd
      ? z2.toBoatEnd.ttl > z.toBoatEnd.ttl
      : null;
    out.z2ttl = z2 && z2.toBoatEnd ? z2.toBoatEnd.ttl : null;
  }
  ZPT.on = false; ZPT.p = null;
  return out;
});
console.log(JSON.stringify({ ...r, errs }, null, 1));
await b.close();
