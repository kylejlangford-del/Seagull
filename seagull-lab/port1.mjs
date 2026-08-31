/* Port lobe gone from the DRAWING, geometry intact: paint the cone on a
 * transparent canvas twice (all runs vs stbd-only via the real draw path) and
 * count red vs green pixels; then screenshot a port-tack entry moment. */
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
  // find a moment where MY BOAT is on PORT tack (twa < 0) with a live cone
  const rd = APP.rd, tr = rd.tracks[APP.focus];
  let tPort = null, tAny = null;
  for (let t = -120; t < -5; t += 1) {
    const s = sampleAt(tr, t);
    if (!s) continue;
    const c = conePoints(rd, t, APP.focus);
    if (!c || !coneRuns(c.arms, c.wrap).length) continue;
    tAny = tAny == null ? t : tAny;
    if (s.twa != null && s.twa < 0) { tPort = t; break; }
  }
  const t = tPort != null ? tPort : tAny;
  // geometry still carries both tacks
  const c = conePoints(rd, t, APP.focus);
  const runs = coneRuns(c.arms, c.wrap);
  const kinds = new Set(runs.map(x => x.stbd));
  // paint through the REAL draw path onto a scratch canvas and count inks
  const cv = document.createElement('canvas');
  cv.width = 1200; cv.height = 900;
  const ctx = cv.getContext('2d');
  const f = rd.frame;
  const xs = c.arms.filter(a => a.dist > 0).map(a => a.rx).concat([c.me.rx]);
  const ys = c.arms.filter(a => a.dist > 0).map(a => a.ry).concat([c.me.ry]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sc = Math.min(1100 / (x1 - x0 + 1), 800 / (y1 - y0 + 1));
  const tX = (x, y) => (x - x0) * sc + 50, tY = (x, y) => (y1 - y) * sc + 50;
  drawStartCone(ctx, rd, t, tX, tY, cv.width, cv.height);
  const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let red = 0, green = 0;
  for (let i = 0; i < img.length; i += 4) {
    if (img[i + 3] < 10) continue;
    if (img[i] > img[i + 2] + 30 && img[i] > img[i + 1] + 30) red++;
    if (img[i + 1] > img[i] + 20 && img[i + 1] > img[i + 2] + 20) green++;
  }
  return { t, onPort: tPort != null, geomTacks: kinds.size,
           geomRuns: runs.length, redPx: red, greenPx: green };
});
console.log(JSON.stringify({ ...r, errs }, null, 1));
await b.close();
