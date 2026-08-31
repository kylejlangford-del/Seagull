/* The Z ghost cone, after the pink/mark-wind/ratio rework:
 *  - PINK ink, anchored at the pin while unlocked, gone when locked, boat
 *    cone untouched throughout (pixel-counted through the real draw path);
 *  - Z TARGET RATIO sizes it: doubling the ratio must GROW the fan — more
 *    margin wanted, more room shown to still get it — measured with
 *    CONE.on off so the boat's own (much bigger) cone can't wash the faint
 *    pink fill out where the two overlap;
 *  - it is independent of CONE.on TWICE over: conePoints/drawConeFrom take
 *    an opt.force bypass (checked directly below), AND the outer opts.cone
 *    gate draw() builds before ever calling drawFrame has to let the ghost
 *    through on its own — CONE off must not silence Z's own working while
 *    a pin is being placed. The direct-drawStartCone checks below caught
 *    the first; they missed the second entirely (they never go through
 *    draw()/opts.cone), so that gate is checked separately, through the
 *    real pipeline (APP.lastOpts.cone), below;
 *  - it is built in the start marks' wind when the race carries SL stations
 *    (checked by pinning a fake mark wind and watching the fan turn). */
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
  const me = sampleAt(rd.tracks[APP.focus], t);

  const paint = () => {
    const cv = document.createElement('canvas');
    cv.width = 1400; cv.height = 1000;
    const ctx = cv.getContext('2d');
    const sc = 0.7;
    const tX = (x, y) => (x - me.rx) * sc + 700, tY = (x, y) => (me.ry - y) * sc + 500;
    drawStartCone(ctx, rd, t, tX, tY, cv.width, cv.height);
    const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let green = 0, pink = 0;
    for (let i = 0; i < img.length; i += 4) {
      if (img[i + 3] < 5) continue;
      const R = img[i], G = img[i + 1], B = img[i + 2];
      if (G > R + 15 && G > B + 15) green++;
      else if (R > G + 20 && B > G + 20) pink++;
    }
    return { green, pink };
  };

  ZPT.on = false; ZPT.p = null; ZPT.locked = false; ZPT.targetRatio = 1.0;
  const base = paint();

  ZPT.on = true; ZPT.p = { rx: me.rx - 350, ry: me.ry + 250 }; ZPT.locked = false;
  const unlocked = paint();

  // Isolate the ratio-shrink check from the boat's own cone: at a high
  // target ratio the (small) ghost sits entirely inside the (much bigger)
  // boat cone's footprint, and compositing a faint pink fill on top of the
  // boat cone's own darker fill washes the pink out of the pixel count —
  // not a shrink bug, just contamination from a second polygon in the same
  // frame. CONE.on=false turns the boat's own cone off (conePoints' gate)
  // while the ghost keeps drawing regardless (force:true) — the same
  // independence this feature exists to guarantee — so this measures the
  // ghost alone.
  CONE.on = false;
  const unlockedAlone = paint();
  ZPT.targetRatio = 2.0;
  const doubleRatio = paint();
  CONE.on = true;
  ZPT.targetRatio = 1.0;

  ZPT.locked = true;
  const locked = paint();
  ZPT.locked = false;

  // The bug just reported: the outer gate draw() builds (opts.cone, in the
  // Object.assign block feeding drawFrame) has its own CONE.on check,
  // separate from conePoints'/drawConeFrom's — miss that one and the whole
  // real render pipeline never calls drawStartCone at all while CONE is
  // off, no matter how independent the inside of that function is. Checked
  // through the actual entry point (draw(), not the direct paint() calls
  // above) so this test would have caught it. draw()'s cone gate also
  // requires startGeom (MODE.now === 'pre'), so the feed has to actually be
  // sitting pre-start — seek(9e9) above parked it post-race, which is fine
  // for the direct-paint checks but would make every gate check below false
  // regardless of the fix, for the wrong reason.
  APP.feed.seek(t + (typeof SMOOTH !== 'undefined' ? SMOOTH.lag : 0));
  rebuild(true);
  CONE.on = false;
  ZPT.on = true; ZPT.p = { rx: me.rx - 350, ry: me.ry + 250 }; ZPT.locked = false;
  draw();
  const gateGhostUnlocked = APP.lastOpts.cone === true;
  ZPT.locked = true;
  draw();
  const gateGhostLocked = APP.lastOpts.cone === false;
  ZPT.locked = false;
  CONE.on = true;
  draw();
  const gateConeOnAlways = APP.lastOpts.cone === true;
  CONE.on = false;
  const savedZptOn = ZPT.on;
  ZPT.on = false;
  draw();
  const gateBothOff = APP.lastOpts.cone === false;
  ZPT.on = savedZptOn; CONE.on = true;

  // mark wind really drives it: pin a fake SL station blowing 40° off the
  // race TWD and see the pink fan swing (its arm set changes materially)
  const armsAt = () => {
    const w = startWind(rd, t, APP.focus, { source: 'mark', dampSec: 20 });
    const c = conePoints(rd, t, APP.focus, ZPT.p, { wind: w, T: -t });
    return c ? c.arms.filter(a => a.stbd && a.dist > 0).length : -1;
  };
  const before = armsAt();
  const saveMw = rd.markWind;
  const twd0 = rd.wind.twd;
  const ts = [], twds = [], twss = [];
  for (let q = t - 25; q <= t; q += 1) { ts.push(q); twds.push(twd0 + 40); twss.push(rd.wind.tws); }
  rd.markWind = [{ name: 'SL1', t: ts, twd: twds, tws: twss }];
  const after = armsAt();
  rd.markWind = saveMw;

  ZPT.on = false; ZPT.p = null;
  return {
    basePink: base.pink, unlockedPink: unlocked.pink, lockedPink: locked.pink,
    ghostIsPink: base.pink === 0 && unlocked.pink > 3000,
    goneWhenLocked: locked.pink === 0,
    boatConeUntouched: Math.abs(unlocked.green - base.green) < base.green * 0.03
                    && locked.green === base.green,
    ratioGrows: doubleRatio.pink > unlockedAlone.pink * 1.2,
    pinkAtR1: unlockedAlone.pink, pinkAtR2: doubleRatio.pink,
    coneIndependence: unlockedAlone.pink > 0 && unlockedAlone.green === 0,
    gateGhostUnlocked, gateGhostLocked, gateConeOnAlways, gateBothOff,
    markWindTurnsFan: before > 0 && after > 0 && before !== after,
    armsBefore: before, armsAfter: after,
  };
});
console.log(JSON.stringify({ ...r, errs }, null, 1));
await b.close();
