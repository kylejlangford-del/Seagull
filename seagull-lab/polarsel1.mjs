/* The POLAR row: exists in the BOATS panel, lists every shipped table, and a
 * pick actually changes the physics — cone arm reach and timeToLine both move
 * to the picked table, 'auto' goes back to the race config, and the pick
 * survives a reload via the globals store. */
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 250)));
await p.goto('http://localhost:8817/index.html'); await p.waitForTimeout(3500);
await p.selectOption('#selDay', '2026-08-23'); await p.waitForTimeout(400);
await p.selectOption('#selStart', 'sassnitz-2026-08-23-1441'); await p.waitForTimeout(1800);

const out = await p.evaluate(() => {
  APP.feed.seek(9e9); rebuild(true);
  const rd = APP.rd, focus = APP.focus, t = -60;
  const r = {};
  r.options = Object.keys(ACCEL_CFG).length;
  r.autoKey = accelCfgKey(rd);                      // race config string
  const armSum = () => conePoints(rd, t, focus).arms.reduce((s, a) => s + a.dist, 0);
  const sAuto = armSum();
  POLAR_SEL.pick = 'm8';  const s8 = armSum();  const k8 = accelCfgKey(rd);
  POLAR_SEL.pick = 'm21'; const s21 = armSum();
  POLAR_SEL.pick = 'm15'; const s15 = armSum();    // sassnitz IS m15
  POLAR_SEL.pick = 'auto';
  r.pinnedKey = k8;
  r.movesOnPick = Math.abs(s8 - sAuto) > 1 && Math.abs(s21 - sAuto) > 1;
  r.m15matchesAuto = Math.abs(s15 - sAuto) < 1e-6;  // race config is m15_*
  // the row is really in the BOATS panel
  const row = [...document.querySelectorAll('#panels label, #panels .row, #panels div')]
    .some(el => /POLAR/.test(el.textContent || ''));
  r.rowInDom = row;
  // ttk moves too
  const q = (pick) => { POLAR_SEL.pick = pick; const x = ttkEnd(rd, t, focus, 'wind'); POLAR_SEL.pick = 'auto'; return x && x.ttl; };
  r.ttlAuto = q('auto'); r.ttlM8 = q('m8');
  r.ttkMoves = r.ttlAuto != null && r.ttlM8 != null && Math.abs(r.ttlAuto - r.ttlM8) > 0.05;
  return r;
});

// persistence across reload
await p.evaluate(() => { POLAR_SEL.pick = 'm10'; saveGlobals(); });
await p.reload(); await p.waitForTimeout(3000);
const persisted = await p.evaluate(() => POLAR_SEL.pick);
await p.evaluate(() => { POLAR_SEL.pick = 'auto'; saveGlobals(); });
console.log(JSON.stringify({ ...out, persisted, errs }, null, 1));
await b.close();
