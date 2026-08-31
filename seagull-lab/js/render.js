/* ==== frame.js ==== */
/* frame.js — ONE canvas frame renderer.
 *
 * The replay is this function on a timer. The port-entry still is this function
 * at the detected entry time. The T=0 still is this function at zero. There is
 * deliberately no second drawing path: the M32 tool carries three near-identical
 * 80-line draw functions and its own notes name that duplication as the reason
 * a fix applied in one place stayed broken in the others.
 */

const TEAM_COLOURS = {
  AUS: '#00843d', BRA: '#009c3b', CAN: '#d52b1e', DEN: '#c8102e',
  ESP: '#f1bf00', FRA: '#0055a4', GBR: '#41b6e6', GER: '#ffcc00',
  ITA: '#e4002b', JPN: '#bc002d', NZL: '#5b6770', SUI: '#da291c',
  USA: '#3a6ea5', KOR: '#003478',
};
const MUTED = '#5a6a7d';

/* Boats on the maps are coloured by where they got to M1, not by team — the
 * question the picture answers is "who won the start", and a fleet of team
 * colours makes you look that up in a table instead of seeing it. Team colours
 * stay in the tables, where identity is what you want.
 *
 * OCS overrides everything: over the line at the gun is a different kind of
 * fact from finishing third, and it gets red plus a ring so it survives being
 * glanced at. */
const PODIUM = { 1: '#ffd700', 2: '#c0c0c0', 3: '#cd7f32' };
const OCS_COL = '#ff3355';

const HULL_MIN_L = 0.42;
const HULL_MAX_L = 0.62;
const HULL_INK = new Map();

function hullInk(hex) {
  if (!hex) return MUTED;
  if (HULL_INK.has(hex)) return HULL_INK.get(hex);
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  // On dark water a navy hull disappears, so dark colours are lifted to a floor
  // of brightness. On light water the failure is the mirror image — a pale
  // yellow vanishes — so the same rule runs the other way and bright colours are
  // held down to a ceiling. Either way the hue that identifies the boat is kept
  // and only its brightness is touched.
  const k = MAP_INK.light
    ? (L > HULL_MAX_L ? HULL_MAX_L / L : 1)
    : (L > 0 && L < HULL_MIN_L ? HULL_MIN_L / L : 1);
  if (k !== 1) {
    r = Math.min(255, Math.round(r * k));
    g = Math.min(255, Math.round(g * k));
    b = Math.min(255, Math.round(b * k));
  }
  const out = `rgb(${r},${g},${b})`;
  HULL_INK.set(hex, out);
  return out;
}

function boatColour(rd, team) {
  if (rd.ocs && rd.ocs.has(team)) return OCS_COL;
  const pos = rd.reachPos && rd.reachPos.get(team);
  if (pos && PODIUM[pos]) return PODIUM[pos];
  return hullInk(TEAM_COLOURS[team]) || MUTED;
}

/* Ratio ink. Same thresholds as the table, dimmed for non-focus boats so the
 * fleet reads as context rather than competing with the boat you are watching. */
function ratioInk(v, focus) {
  const c = v == null   ? '#7f8fa1'
          : v < 0.9     ? '#ff5a70'
          : v <= 1.15   ? '#3ddc84'
          : v <= 1.6    ? '#ffd24a' : '#ff9f43';
  return focus ? c : c + 'b0';
}

const TRAIL_SEC = 10;   // seconds of track behind each boat, all maps, all boats

/* ── the projection ─────────────────────────────────────────────────────────
 *
 * Every boat already carried a 4-second speed vector: where it would be in four
 * seconds if nothing changed. PROJECTION.sec makes that horizon a control, and
 * puts the START RATIO the boat would then have at the tip of the line.
 *
 * That second number is the point of it. The ratio on the boat right now says
 * whether you are early; the ratio at the end of the projection says whether
 * holding this speed and this heading for another N seconds LEAVES you early —
 * which is the decision actually in front of the helm, and the one a live
 * readout of the current ratio cannot answer.
 *
 * It is a straight-line hold: current speed, current course, no turn, no
 * acceleration, no wind change. That is exactly what makes it useful as a
 * "if I do nothing" line, and exactly why it is not a prediction.
 *
 * PROJECTION_STEPS is the menu. 0 means off, and off restores the plain 4 s
 * vector rather than removing it, because the vector is how you read heading at
 * a glance on a crowded map.
 */
const PROJECTION = { sec: 20 };
const PROJECTION_STEPS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
const PROJECTION_DEFAULT_SEC = 4;   // the original vector, used when sec is 0
const PROJECTION_TICK_S = 5;        // a ball on the projection every 5 s

/* ── the second front ───────────────────────────────────────────────────────
 *
 * The wave is every place you could still be and reach the line on the gun at
 * polar speed. It is the ratio = 1.00 contour: time you have over time you
 * need, with nothing spare. That is what makes it close on the line as the
 * clock runs down — the thing that comes back to the boat.
 *
 * Which means the same drawing answers a better question. Ratio is TTS / TTL,
 * so a boat holding ratio R needs TTL = TTS / R, and the ratio-R contour is the
 * ratio-1 fan computed with T / R in place of T. One divide. Set R to the
 * target you actually sail to and the front on the water IS that target: be on
 * it and you are holding the number, inside it and you have burnt too little,
 * outside it and you are already late.
 *
 * This replaced a seconds-ahead version, which drew where the wave would have
 * closed to in N seconds. That was answerable but awkward — it went blank once
 * the horizon crossed the gun, and it asked the reader to hold two clocks at
 * once. A ratio is defined at every pre-gun moment and is the number on the
 * sailors' screen already.
 */
const WAVE_RATIO = { on: true, target: 1.8 };

const F50_LOA = 15.0;   // metres
const F50_BEAM = 8.8;

const teamColour = t => TEAM_COLOURS[t] || '#8899aa';

/* Device-pixel-ratio aware canvas setup. */
function cvs(canvas, cssH) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || canvas.parentNode.clientWidth || 400;
  const H = cssH;
  canvas.style.height = H + 'px';
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W, H };
}

/* ── viewport ───────────────────────────────────────────────────────────────
 *
 * The framing problem: an F50 covers 1.5-2 km in the 90 s before a 200 m start
 * line. "Line fills the frame" and "everyone visible" cannot both hold at
 * T-90, so there are three modes.
 *
 *   LINE   the line fills the frame vertically, always. Boats outside get edge
 *          markers. This is the M32 tool's framing.
 *   FLEET  fit everything — line plus every boat — at this instant.
 *   AUTO   FLEET, but never zoomed in tighter than LINE.
 *
 * AUTO used to interpolate between the FLEET and LINE fits on a time ramp.
 * That was wrong: a blend of two viewports is not itself a viewport that
 * contains anything in particular, and boats fell out of frame between T-70
 * and T-30 — the most interesting part of the approach. Clamping the fleet fit
 * gives the same pull-in for free, because the fleet fit tightens by itself as
 * the boats converge on the line, and it cannot lose a boat by construction.
 */

/* Which way is up.
 *
 * Every coordinate the renderer draws is already in the frame's rotated space:
 * the start line vertical, windward up. That is the course's own orientation
 * and it is the right default, but it is not the only one worth having — north
 * up to place the racetrack in the world, wind up to read shifts against a
 * fixed vertical, boat up to fly the map the way the crew sees it.
 *
 * So one extra rotation is applied on the way to the screen, and it is applied
 * in exactly one place: the point transform. Everything downstream — laylines,
 * routes, hulls, the wind field — goes through that transform and rotates for
 * free. Text does not, because the canvas itself is never rotated: labels,
 * plates and the scale bar stay upright, which is the whole reason for
 * rotating the transform rather than the context.
 *
 * The convention that makes it all work: a compass bearing B appears on screen
 * at angle B − rot (clockwise from up), so an extra rotation φ puts it at
 * B − rot − φ. To make bearing T point up, φ = T − rot.
 */
const MAP_ROT = { mode: 'course' };
const MAP_ROT_DAMP_S = 4;      // boat-up: seconds of heading to average

/* Set once per frame, before the viewport is fitted. Module-level because the
 * dozen draw passes below all need it and threading it through every signature
 * would be a worse trade than one value that changes once a frame. */
let VIEW_ROT = 0;                                  // radians
let VIEW_COS = 1, VIEW_SIN = 0;
const viewRotDeg = () => VIEW_ROT * 180 / Math.PI;

const setViewRot = a => {
  VIEW_ROT = a || 0;
  VIEW_COS = Math.cos(VIEW_ROT);
  VIEW_SIN = Math.sin(VIEW_ROT);
};

/* The last frame's viewport, for screenToFrame below. */
let LAST_VIEW = null;

/* A pixel on the canvas as a point in the rotated frame — the exact inverse of
 * the tX/tY pair in drawFrame, rotation included. Returns null before the first
 * frame has been drawn, because until then there is no view to invert. */
function screenToFrame(px, py) {
  const v = LAST_VIEW;
  if (!v || !(v.scale > 0)) return null;
  const a = (px - v.W / 2) / v.scale;
  const b = -(py - v.H / 2) / v.scale;
  return { rx: v.cx + a * v.cos + b * v.sin, ry: v.cy - a * v.sin + b * v.cos };
}

/* And forward, outside a draw, for hit-testing what the pointer is over. */
function frameToScreen(rx, ry) {
  const v = LAST_VIEW;
  if (!v) return null;
  return { x: v.W / 2 + ((rx - v.cx) * v.cos - (ry - v.cy) * v.sin) * v.scale,
           y: v.H / 2 - ((rx - v.cx) * v.sin + (ry - v.cy) * v.cos) * v.scale };
}

// frame space -> screen-aligned space, and back
const rotFwd = (rx, ry) => ({ rx: rx * VIEW_COS - ry * VIEW_SIN,
                              ry: rx * VIEW_SIN + ry * VIEW_COS });
const rotBack = (rx, ry) => ({ rx: rx * VIEW_COS + ry * VIEW_SIN,
                               ry: -rx * VIEW_SIN + ry * VIEW_COS });
/* A frame-space direction as a screen vector, y already flipped. The one
 * helper app.js needs to keep its own overlays square to the map. */
const dirToScreen = (rx, ry) => {
  const r = rotFwd(rx, ry);
  return { dx: r.rx, dy: -r.ry };
};

/* The heading to fly the map by, averaged.
 *
 * An F50 yaws several degrees a second and gybes through a hundred and forty;
 * hanging the whole map off an instantaneous heading makes it unreadable and
 * slightly sickening. A short circular mean of course-over-ground keeps the
 * rotation honest through a turn without shaking through the straights. */
function boatUpHeading(rd, t, focus) {
  const tr = focus && rd.tracks[focus];
  if (!tr) return null;
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < tr.n; i++) {
    if (!(tr.t[i] > t - MAP_ROT_DAMP_S && tr.t[i] <= t)) continue;
    const c = tr.raw.cog[i] != null ? tr.raw.cog[i] : tr.raw.hdg[i];
    if (c == null) continue;
    sx += Math.sin(c * D2R); sy += Math.cos(c * D2R); n++;
  }
  if (n) return ((Math.atan2(sx, sy) / D2R) % 360 + 360) % 360;
  const s = sampleAt(tr, t);
  return s ? (s.cog != null ? s.cog : s.hdg) : null;
}

function viewRot(rd, t, opts) {
  const f = rd && rd.frame;
  if (!f) return 0;
  const up = f.rot * 180 / Math.PI;      // the bearing that points up already
  let want = null;
  if (MAP_ROT.mode === 'north') want = 0;
  else if (MAP_ROT.mode === 'wind') want = rd.wind ? rd.wind.twd : null;
  else if (MAP_ROT.mode === 'boat') want = boatUpHeading(rd, t, opts.focus);
  // 'course' is the frame's own orientation, which is no extra rotation at all.
  if (want == null) return 0;
  return (((want - up) % 360 + 360) % 360) * D2R;
}

function fitLine(rd, W, H) {
  const f = rd.frame;
  const pad = 46;
  // The line is vertical in the frame, but not on screen once the map is
  // rotated, so the fit asks both axes how much room the line needs. At no
  // rotation the x term is slack and the y term is the old formula exactly.
  const d = rotFwd(f.windR.rx - f.leeR.rx, f.windR.ry - f.leeR.ry);
  const scale = Math.min((W - pad * 2) / Math.max(Math.abs(d.rx) * 1.35, 60),
                         (H - pad * 2) / Math.max(Math.abs(d.ry) * 1.35, 60));
  return {
    cx: (f.windR.rx + f.leeR.rx) / 2,
    cy: (f.windR.ry + f.leeR.ry) / 2,
    scale: Math.max(0.02, scale),
  };
}

/* Seagull Lab: set while racing, so the fit follows the boats and lets the
 * start line leave the frame behind them. */
let FIT_BOATS_ONLY = false;

function fitFleet(rd, t, W, H, opts_focus) {
  const f = rd.frame;
  const xs = [], ys = [];
  if (!FIT_BOATS_ONLY) {
    xs.push(f.windR.rx, f.leeR.rx);
    ys.push(f.windR.ry, f.leeR.ry);
  }
  // Excluded boats do not get a vote on the framing. A boat 1.3 km from the
  // line would otherwise shrink the whole start to a smudge.
  // copy — pushing onto rd.activeTeams would corrupt it for every later call
  const fitting = [...(rd.activeTeams.length ? rd.activeTeams : rd.teams)];
  if (opts_focus && !fitting.includes(opts_focus) && rd.tracks[opts_focus])
    fitting.push(opts_focus);
  for (const team of fitting) {
    const s = sampleAt(rd.tracks[team], t);
    if (s) { xs.push(s.rx); ys.push(s.ry); }
  }
  if (!xs.length) {
    xs.push(f.windR.rx, f.leeR.rx);
    ys.push(f.windR.ry, f.leeR.ry);
  }
  return fitBox(xs, ys, W, H, 60);
}

/* A bounding-box fit, done in the space the SCREEN is aligned to.
 *
 * The box has to be measured after the view rotation or a rotated course
 * overflows its own frame — the extents that matter are the ones along the
 * screen axes, not along the frame's. Points go forward through the rotation,
 * the box is taken there, and the centre comes back out again: because the
 * point transform rotates about that centre, `rotate(p − centre)` is exactly
 * `rotated(p) − boxCentre`, so the fit and the transform agree by construction.
 */
function fitBox(xs, ys, W, H, padPx) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const q = rotFwd(xs[i], ys[i]);
    if (q.rx < minX) minX = q.rx;
    if (q.rx > maxX) maxX = q.rx;
    if (q.ry < minY) minY = q.ry;
    if (q.ry > maxY) maxY = q.ry;
  }
  const spanX = Math.max(maxX - minX, 60), spanY = Math.max(maxY - minY, 60);
  const scale = Math.min((W - padPx * 2) / spanX, (H - padPx * 2) / spanY);
  const c = rotBack((minX + maxX) / 2, (minY + maxY) / 2);
  return { cx: c.rx, cy: c.ry, scale: Math.max(0.02, scale) };
}

function fitCourse(rd, t, W, H, opts_focus) {
  const f = rd.frame;
  const xs = [f.windR.rx, f.leeR.rx], ys = [f.windR.ry, f.leeR.ry];
  for (const el of (rd.course && rd.course.elements) || [])
    for (const p of [el.p1, el.p2])
      if (p) { xs.push(p.rx); ys.push(p.ry); }
  if (f.m1R) { xs.push(f.m1R.rx); ys.push(f.m1R.ry); }
  for (const team of rd.teams) {
    const s = sampleAt(rd.tracks[team], t);
    if (s) { xs.push(s.rx); ys.push(s.ry); }
  }
  return fitBox(xs, ys, W, H, 70);
}

/* Seagull Lab: a camera on one boat.
 *
 * The scale is deliberately NOT the fleet fit. A camera that is centred on you
 * and also zooms with the spread of the fleet moves for two reasons at once,
 * and neither is legible; this one holds a fixed piece of water and lets the
 * boats come and go across it. The piece is sized from the course itself, once
 * per race, so a big course gets a big view and neither is a hard-coded metre
 * count that happens to suit Sassnitz.
 */
const BOAT_VIEW_FALLBACK_M = 900;

function boatViewSpan(rd) {
  if (rd._boatViewSpan != null) return rd._boatViewSpan;
  const xs = [], ys = [];
  for (const el of (rd.course && rd.course.elements) || [])
    for (const p of [el.p1, el.p2]) if (p) { xs.push(p.rx); ys.push(p.ry); }
  let span = BOAT_VIEW_FALLBACK_M;
  if (xs.length > 1) {
    const d = Math.hypot(Math.max(...xs) - Math.min(...xs),
                         Math.max(...ys) - Math.min(...ys));
    span = Math.max(300, Math.min(2500, d * 0.6));
  }
  return (rd._boatViewSpan = span);
}

function fitBoat(rd, t, W, H, focus, offset, zoom) {
  const s = focus && rd.tracks[focus] && sampleAt(rd.tracks[focus], t);
  if (!s) return null;                    // no boat to follow — caller falls back
  const scale = Math.max(0.02, Math.min(W, H) / boatViewSpan(rd));
  if (!offset) return { cx: s.rx, cy: s.ry, scale };

  // OFFSET: the boat a third of the way in from the trailing edge, so two
  // thirds of the screen is the water it is sailing into rather than the water
  // it has already crossed. Which means the camera centre sits a sixth of a
  // screen ahead of the boat, along the bearing to the mark it is sailing to —
  // so the view swings round with the boat at every rounding, by itself.
  const g = typeof crossNextMark === 'function' ? crossNextMark(rd, s) : null;
  const dx = g ? g.rx - s.rx : 0, dy = g ? g.ry - s.ry : 0;
  const d = Math.hypot(dx, dy);
  if (!(d > 1)) return { cx: s.rx, cy: s.ry, scale };
  const ux = dx / d, uy = dy / d;
  // Half the screen, measured in that direction. The inscribed ellipse rather
  // than the rectangle's corner, so the offset eases as the bearing rotates
  // instead of stepping at the diagonals. Measured on the SCREEN axes, so with
  // the map flown boat-up — where the mark is always straight ahead — the
  // offset is a third of the height rather than of some diagonal.
  const sd = rotFwd(ux, uy);
  /* Divided by the zoom, because the offset is a place on the SCREEN — a third
   * in from the trailing edge — and not a distance over the water. Left in
   * metres it is magnified with everything else, and at ×12 it carries the boat
   * clean off the frame you zoomed in to look at it in. */
  const halfM = Math.hypot(sd.rx * W / 2, sd.ry * H / 2) / scale / (zoom || 1);
  return { cx: s.rx + ux * halfM / 3, cy: s.ry + uy * halfM / 3, scale };
}

function viewport(rd, t, W, H, opts) {
  const mode = opts.mode || 'auto';
  let v;
  if (mode === 'line') {
    v = fitLine(rd, W, H);
  } else if (mode === 'course') {
    v = fitCourse(rd, t, W, H, opts.focus);
  } else if (mode === 'boat' || mode === 'boatOffset') {
    v = fitBoat(rd, t, W, H, opts.focus, mode === 'boatOffset', opts.zoom)
        || fitFleet(rd, t, W, H, opts.focus);
  } else if (mode === 'fleet') {
    v = fitFleet(rd, t, W, H, opts.focus);
  } else {
    const fleet = fitFleet(rd, t, W, H, opts.focus), line = fitLine(rd, W, H);
    if (fleet.scale <= line.scale) {
      v = fleet;                      // fleet is wider than the line fit: use it
    } else {
      // the fleet is tighter than the line — hold at the line fit, but keep the
      // fleet's centre so the action stays put rather than snapping to the line
      const maxOff = (H / 2 - 46) / line.scale;
      const dy = Math.max(-maxOff, Math.min(maxOff, fleet.cy - line.cy));
      const maxOffX = (W / 2 - 46) / line.scale;
      const dx = Math.max(-maxOffX, Math.min(maxOffX, fleet.cx - line.cx));
      v = { cx: line.cx + dx * 0.5, cy: line.cy + dy * 0.5, scale: line.scale };
    }
  }
  const z = opts.zoom || 1;
  // A drag is a SCREEN movement, so it comes back through the rotation before
  // it moves the centre — otherwise dragging right slides the map off at
  // whatever angle the frame happens to sit at.
  const s = v.scale * z;
  const px = (opts.panX || 0) / s, py = (opts.panY || 0) / s;
  const u = px * VIEW_COS - py * VIEW_SIN;
  const w = -px * VIEW_SIN - py * VIEW_COS;
  return { cx: v.cx - u, cy: v.cy - w, scale: s };
}

/* ── drawing ────────────────────────────────────────────────────────────────*/

function drawFrame(canvas, rd, t, opts = {}) {
  const H = opts.height || 620;
  const { ctx, W } = cvs(canvas, H);
  // Before anything is fitted or drawn: the viewport, the point transform and
  // every direction on the map all read this.
  setViewRot(viewRot(rd, t, opts));
  const v = viewport(rd, t, W, H, opts);
  const f = rd.frame;
  const mpp = 1 / v.scale;                   // metres per pixel

  // The one place the view rotation is applied. Both take the whole point,
  // because once the map can turn, screen x depends on frame y.
  const tX = (rx, ry) => W / 2
    + ((rx - v.cx) * VIEW_COS - (ry - v.cy) * VIEW_SIN) * v.scale;
  const tY = (rx, ry) => H / 2
    - ((rx - v.cx) * VIEW_SIN + (ry - v.cy) * VIEW_COS) * v.scale;
  const dirOnScreen = deg => {
    const r = f.r(Math.sin(deg * Math.PI / 180), Math.cos(deg * Math.PI / 180));
    return dirToScreen(r.rx, r.ry);
  };
  /* The transform, kept, so a POINTER can be turned back into a place.
   * Everything else on this map goes one way — a position in the frame comes
   * out as a pixel — but anything you can drag has to go the other way too, and
   * the only honest inverse is the one taken from the same numbers tX and tY
   * were built from, on the frame that is actually on screen. */
  LAST_VIEW = { cx: v.cx, cy: v.cy, scale: v.scale, W, H,
                cos: VIEW_COS, sin: VIEW_SIN };

  // background
  ctx.fillStyle = MAP_INK.bg;
  ctx.fillRect(0, 0, W, H);
  // The world, under everything. Off by default: it costs network, and the
  // whole palette was picked against near-black water.
  drawBasemap(ctx, rd, v, W, H);
  /* The grid's switch and its angle both come from app.js: whether it is on is
   * a setting, and what it is turned to depends on the wind sources and the
   * focus boat, neither of which the renderer has any business resolving. */
  if (opts.grid !== false)
    drawGrid(ctx, W, H, mpp, opts.gridAng || 0, tX(0, 0), tY(0, 0));
  if (opts.wave) drawWave(ctx, rd, t, tX, tY, W, H);
  // After the wave, not before: the wave fills opaque black and would bury a
  // field drawn underneath it. Over the top and translucent, both read.
  if (WIND_VIEW.field !== 'off') drawWindField(ctx, rd, t, tX, tY, v, W, H);
  /* Gas over the field and under everything else: it is weather, so it belongs
   * beneath the course and the boats, but above the wash that describes the
   * clean breeze it is dirtying. Lives in app.js — it needs the wind resolver
   * and the tracks. */
  if (typeof drawGas === 'function') drawGas(ctx, rd, t, tX, tY, W, H, opts);

  if (opts.showLimits !== false) drawLimits(ctx, f, tX, tY);
  // Under the line and the marks, so their dots stay on top of it.
  drawEndLegs(ctx, rd, t, tX, tY, W, H, opts);
  drawStartLaylines(ctx, rd, t, tX, tY, W, H, opts);
  drawStartLine(ctx, rd, tX, tY, mpp, opts);
  if (f.m1R) drawM1(ctx, f, tX, tY, mpp, W, H);
  if (opts.course !== false) drawCourse(ctx, rd, tX, tY);
  drawCourseLaylines(ctx, rd, t, tX, tY, W, H, opts.focus);
  drawGateBias(ctx, rd, t, tX, tY, W, H, opts.focus);
  drawNextLeg(ctx, rd, t, tX, tY, W, H, opts.focus);
  drawCrossLines(ctx, rd, t, tX, tY, W, H, opts.focus);
  drawZ(ctx, rd, t, tX, tY, W, H, opts);
  if (opts.laylines !== false) {
    drawAdvantage(ctx, rd, tX, tY, H);
    drawFastPoint(ctx, rd, tX, tY, W, H);
  }

  // Excluded boats are NOT drawn. They were dimmed rather than removed in the
  // first cut, which still left a boat 700 m away cluttering the replay of a
  // start it took no part in.
  //
  // The one exception is the focus boat: if it is itself excluded, drawing
  // nothing would leave the stills blank with no explanation on the canvas.
  // It renders dimmed and tagged instead, and the banner says why.
  // No focus is a real state, not a missing argument: the FOCUS dropdown has a
  // NONE entry for looking at the fleet as a fleet. Defaulting to ITA here
  // would quietly put the highlight back.
  const focus = opts.focus || null;
  const ordered = rd.teams
    .filter(t => !rd.excluded.has(t) || t === focus)
    .sort((a, b) => (a === focus) - (b === focus));
  const offscreen = [];
  for (const team of ordered) {
    const r = drawBoat(ctx, rd, team, t, tX, tY, mpp, W, H, opts, team === focus);
    if (r && r.off) offscreen.push(r);
  }
  drawOffscreen(ctx, offscreen, W, H);
  // The gain goes over the hulls: it is the headline of the crosswind overlay
  // and a number half hidden behind a boat is not a headline.
  drawCrossGain(ctx, rd, t, tX, tY, W, H, opts.focus);

  /* Seagull Lab: the start cone, under the boats and the start geometry so it
   * reads as water rather than as another line on top of them. */
  if (typeof drawStartCone === 'function' && opts.cone)
    drawStartCone(ctx, rd, t, tX, tY, W, H);
  if (opts.entryLeader) drawEntryLeader(ctx, rd, opts.entryLeader, t, tX, tY, opts.focus);
  // Readings on top of the boats — they are labels on the sources, and a label
  // under a hull is not a label.
  if (WIND_VIEW.live !== 'off') drawWindLive(ctx, rd, t, tX, tY, W, H);
  if (WIND_VIEW.live !== 'off' || WIND_VIEW.field !== 'off')
    drawWindLegend(ctx, rd, W, H);
  drawWind(ctx, rd, W, H, dirOnScreen);
  drawScaleBar(ctx, mpp, W, H);
  drawModeChip(ctx, opts, W, H);
  return { W, H, tX, tY, v };
}

/* ── the wind view ──────────────────────────────────────────────────────────
 *
 * Two things can be drawn, and they answer different questions.
 *
 *   the READINGS, where they were taken: an arrow and a TWD/TWS pair at each
 *   instrument. No shading, no model, nothing between you and the sensor.
 *
 *   the FIELD, inverse-distance-weighted from every source at once and shaded
 *   by speed. The shape of the breeze across the box — where the pressure is,
 *   where the shift lives — and a model: smooth where the data is sparse.
 *
 * Sources are every boat's own masthead, sampled at the frame's clock, plus the
 * course-mark boats where their logs have been ingested (rd.markWind). The
 * marks matter more than their count suggests: they are fixed, so they separate
 * a change in the wind from a boat sailing into a different bit of it.
 *
 * Two independent selections, each off / marks / boats / all:
 *
 *   WIND_VIEW.live    which raw readings get drawn — arrow and numbers, where
 *                     the instrument is.
 *   WIND_VIEW.field   whether the shaded field is drawn, and which sources get
 *                     a dot on it showing where its data came from.
 *
 * The field's ARITHMETIC always uses every source, whatever the selection says.
 * Picking "marks" does not build a marks-only interpolation — it shows you the
 * mark positions over the same field. Interpolating from half the readings when
 * the other half exists would be a worse field, not a filtered view of one, and
 * a control that silently changes the model rather than the display is the kind
 * of thing that gets read off and believed.
 */
const WIND_VIEW = { live: 'marks', field: 'off', trailSec: 45 };

/* 'selected' takes both kinds and then filters instrument by instrument, so it
 * passes the kind test and is sieved in windSources itself. */
const windWants = (sel, kind) =>
  sel === 'all' || sel === 'selected' || sel === kind + 's';

// A wind-speed spike above this is the sensor coming out of a manoeuvre, not
// air. Same cut as the wind report: 45 kn.
const WIND_MAX_KMH = 45 * 1.852;

/* Is this a wind reading, or is it the true-wind solution failing?
 *
 * An F50 does 60-90 km/h. Solving true wind from apparent at that speed is a
 * small difference of two large vectors, and when the solution degrades what
 * comes out is not noisy wind, it is apparent wind wearing a TWD label: the
 * direction swings towards the boat's course and the speed climbs towards the
 * boat's own. Race 5 at Sassnitz on 23 Aug is the clear case - 8.9% of its
 * masthead samples sit more than 60 degrees off the race TWD and 6.2% more
 * than 90, with speeds up to 2.2x the race mean, three of the four boats at
 * once. Fed to an overlay unchecked, that is a ladder rung drawn square to a
 * wind that is not there.
 *
 * The race TWD and TWS are whole-race means, so they are the one reference
 * every reading can be checked against without circularity. The gate is set
 * where it separates: across the other five full-length races the 99th
 * percentile of |reading - race TWD| is 12-48 degrees and NOTHING exceeds 60,
 * so a 60 degree gate throws away 0.00% of good data and catches the bad race
 * whole. The speed test is the same idea in the other channel.
 *
 * This is a fault detector, not a smoother. Real shifts, gusts and lulls pass
 * it untouched - that is the whole point of a wind field, and a gate tight
 * enough to flatten one would be worse than no gate at all.
 */
/* The gate is a WEIGHT, not a switch, and that is the whole trick.
 *
 * As a boolean it made the overlays worse in a new way: a sample crossing the
 * threshold entered or left the averaged population instantly, so the answer
 * stepped. Measured on the archive, the rung's wind could move 50 degrees in a
 * single second that way - rare, but exactly the kind of thing you notice,
 * because nothing else on the map moves like that.
 *
 * So credibility falls off smoothly instead. Full weight out to WIND_OFF_FULL
 * degrees from the race TWD, zero by WIND_MAX_OFF_DEG, smoothstep between - and
 * the same in the speed channel. Nothing ever appears or vanishes, every
 * downstream average is a continuous function of the data, and the thresholds
 * still sit where the archive says they should.
 */
const WIND_OFF_FULL = 40, WIND_MAX_OFF_DEG = 60;
const WIND_RATIO_LO = 0.4, WIND_RATIO_FULL_LO = 0.6;
const WIND_RATIO_FULL_HI = 1.6, WIND_RATIO_HI = 2.0;

/* 1 below `full`, 0 above `zero`, smoothstep between - flat at both ends, so
 * the weight has no corner for a derivative to jump at either. */
function windRamp(x, full, zero) {
  if (x <= full) return 1;
  if (x >= zero) return 0;
  const u = (x - full) / (zero - full);
  return 1 - u * u * (3 - 2 * u);
}

function windWeight(rd, twd, tws) {
  if (twd == null || tws == null) return 0;
  if (!(tws > 0 && tws <= WIND_MAX_KMH)) return 0;
  const w = rd.wind || {};
  let k = 1;
  if (w.twd != null) {
    let d = Math.abs(((twd - w.twd) % 360 + 360) % 360);
    if (d > 180) d = 360 - d;
    k *= windRamp(d, WIND_OFF_FULL, WIND_MAX_OFF_DEG);
  }
  if (w.tws > 0) {
    const r = tws / w.tws;
    // The low side is ramped on 1/r so a half-speed reading is judged as
    // harshly as a double-speed one rather than being squeezed into [0,1].
    k *= r >= 1 ? windRamp(r, WIND_RATIO_FULL_HI, WIND_RATIO_HI)
                : windRamp(1 / r, 1 / WIND_RATIO_FULL_LO, 1 / WIND_RATIO_LO);
  }
  return k;
}

/* For the places that genuinely need a yes or no - a field source is drawn or
 * it is not, a HUD row is flagged or it is not. */
const windOK = (rd, twd, tws) => windWeight(rd, twd, tws) > 0;

/* Every reading available at time t, in rotated-frame metres.
 * { rx, ry, twd, tws, label, kind: 'boat' | 'mark' }
 * `sel` filters what comes back for DISPLAY; the field passes 'all'. */
/* Is this source LEFT or RIGHT of where it has been?
 *
 * A single wind reading says almost nothing on its own — what a trimmer wants
 * off a mark boat is not "251 degrees" but "further left than it has been for
 * the last minute". So every source carries the vector mean of its OWN last
 * WIND_SHIFT_SEC seconds, and the arrow is coloured by which side of that the
 * reading currently sits: backed (anticlockwise, a smaller number) is a left
 * shift, veered is a right one.
 *
 * Each source is compared against itself rather than against the fleet, because
 * that is what tells you a shift has reached THIS piece of water. The same
 * fault gate applies, so a minute containing a bad patch does not drag the
 * reference off with it.
 */
const WIND_SHIFT_SEC = 60;
const WIND_SHIFT_DEAD = 1.5;      // degrees of nothing-much, so it cannot flicker
const SHIFT_LEFT_INK  = '#ff4d5e';
const SHIFT_RIGHT_INK = '#3ddc84';

function trailAvg(rd, ts, twds, twss, t, n) {
  const dirs = [], spds = [];
  for (let i = 0; i < n; i++) {
    if (!(ts[i] > t - WIND_SHIFT_SEC && ts[i] <= t)) continue;
    if (windWeight(rd, twds[i], twss[i]) > 0) { dirs.push(twds[i]); spds.push(twss[i]); }
  }
  const w = meanWind(dirs, spds);
  return w ? w.twd : null;
}

/* Which way this reading sits against its own trailing mean: -1 left, +1 right,
 * 0 for no meaningful shift or no reference to compare against. */
function shiftSide(twd, avg) {
  if (avg == null) return 0;
  const d = ((twd - avg) % 360 + 540) % 360 - 180;
  return d > WIND_SHIFT_DEAD ? 1 : d < -WIND_SHIFT_DEAD ? -1 : 0;
}

function windSources(rd, t, sel = 'all', normalise = false) {
  const out = [];
  const picked = (kind, name) =>
    sel !== 'selected' || typeof windPicked !== 'function' || windPicked(kind, name);
  for (const team of windWants(sel, 'boat') ? rd.teams : []) {
    if (rd.excluded.has(team)) continue;
    if (!picked('boat', team)) continue;
    const tr = rd.tracks[team];
    if (!tr) continue;
    const s = sampleAt(tr, t);
    if (!s || !windOK(rd, s.twd, s.tws)) continue;
    out.push({ rx: s.rx, ry: s.ry, twd: s.twd, tws: s.tws, label: team, kind: 'boat',
               avg: trailAvg(rd, tr.t, tr.raw.twd, tr.raw.tws, t, tr.n) });
  }
  // Mark boats, if the day's Course_Marks log has been ingested for this race.
  // Same shape, so nothing downstream has to know which kind it got.
  /* A mark boat's sensor sits about 2 m up; an F50's masthead is about 24 m.
   * Wind climbs with height, so the two read different speeds for the same air —
   * across the Sassnitz days the boats came out a median 3.4 km/h higher, in
   * 92% of paired instants. Direction shows no such bias (0.3° median), so only
   * speed is touched.
   *
   * `normalise` puts the marks on the boats' scale. The FIELD asks for it,
   * because blending the two raw would paint a permanent lull around every mark
   * — an artefact of where the instrument is bolted, not a fact about the wind.
   * LIVE does not, because there the question is what the instrument said. */
  const k = normalise && rd.markScale ? rd.markScale : 1;
  for (const m of (windWants(sel, 'mark') ? (rd.markWind || []) : [])) {
    if (!picked('mark', m.name)) continue;
    const s = markWindAt(m, t);
    if (!s) continue;
    const tws = s.tws * k;                 // normalised before it is judged
    if (!windOK(rd, s.twd, tws)) continue;
    out.push({ rx: m.rx, ry: m.ry, twd: s.twd, tws,
               label: m.name, kind: 'mark',
               avg: trailAvg(rd, m.t, m.twd, m.tws, t, (m.t || []).length) });
  }
  return out;
}

/* A mark's reading at the frame clock. Nearest sample within 5 s rather than
 * interpolated: a mark boat logs slowly and lies still, so the nearest reading
 * IS the reading, and interpolating across a gap would invent a trend. */
function markWindAt(m, t) {
  const ts = m.t;
  if (!ts || !ts.length) return null;
  let lo = 0, hi = ts.length - 1;
  if (t < ts[0] - 5 || t > ts[hi] + 5) return null;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
  const i = Math.abs(ts[lo] - t) <= Math.abs(ts[hi] - t) ? lo : hi;
  if (Math.abs(ts[i] - t) > 5) return null;
  const twd = m.twd[i], tws = m.tws[i];
  if (twd == null || tws == null || !(tws > 0 && tws <= WIND_MAX_KMH)) return null;
  return { twd, tws };
}

/* The colour ramp's domain, fixed per race rather than per frame.
 *
 * Per-frame auto-scaling makes every frame look equally windy: the colours
 * would re-normalise as the fleet spread out and a lull would paint the same
 * red as a squall. So the range is the 5th to 95th percentile of every reading
 * over the whole window, computed once and cached on the race. Then a colour
 * means the same wind speed at T-150 as it does on the gun, which is the only
 * way the shading can show a change rather than survive one.
 */
function windDomain(rd) {
  if (rd._windDomain) return rd._windDomain;
  const all = [];
  for (const team of rd.teams) {
    const tr = rd.tracks[team];
    if (!tr || !tr.raw.tws) continue;
    for (const v of tr.raw.tws) if (v != null && v > 0 && v <= WIND_MAX_KMH) all.push(v);
  }
  // marks enter the domain on the boats' scale, the same one the field paints in
  const k = rd.markScale || 1;
  for (const m of (rd.markWind || []))
    for (const v of m.tws) if (v != null && v > 0 && v <= WIND_MAX_KMH) all.push(v * k);
  if (all.length < 20) return (rd._windDomain = null);
  all.sort((a, b) => a - b);
  const q = p => all[Math.min(all.length - 1, Math.floor(p * all.length))];
  let lo = q(0.05), hi = q(0.95);
  // A dead-flat race would otherwise divide by nothing and paint one colour;
  // give it a minimum spread so the ramp still means something.
  if (hi - lo < 2) { const mid = (lo + hi) / 2; lo = mid - 1; hi = mid + 1; }
  return (rd._windDomain = { lo, hi });
}

/* Blue → green → yellow → red, light to strong. The same reading order as the
 * wind report, so a colour means the same thing in both. */
const WIND_RAMP = [
  [0.00, [ 96, 165, 214]],
  [0.35, [ 92, 178, 128]],
  [0.60, [214, 200,  92]],
  [0.82, [224, 148,  66]],
  [1.00, [200,  62,  48]],
];

function windColour(u) {
  const x = Math.max(0, Math.min(1, u));
  for (let i = 1; i < WIND_RAMP.length; i++) {
    if (x <= WIND_RAMP[i][0]) {
      const [a, ca] = WIND_RAMP[i - 1], [b, cb] = WIND_RAMP[i];
      const s = (x - a) / (b - a);
      return [0, 1, 2].map(k => Math.round(ca[k] + (cb[k] - ca[k]) * s));
    }
  }
  return WIND_RAMP[WIND_RAMP.length - 1][1];
}

/* Inverse distance weighting, p = 2, with a softening length so a source does
 * not become a singular spike you can see the pixel of. SOFTEN_M is roughly a
 * boat length of blur: below it the weight stops climbing, which turns each
 * reading into a smooth mound rather than a pin. */
const IDW_SOFTEN_M = 25;
const FIELD_CELL_PX = 14;      // grid pitch before the smooth upscale
const ARROW_PITCH_PX = 74;     // direction arrows, sparse enough to read through

function idwAt(src, rx, ry) {
  let wsum = 0, sx = 0, sy = 0, ssp = 0, dmin = Infinity;
  for (const s of src) {
    const dx = rx - s.rx, dy = ry - s.ry;
    const dd = dx * dx + dy * dy;
    // An advected reading is a reading plus an assumption, and the assumption
    // gets weaker the further back it came from. `cred` is how much of it is
    // left: it scales the weight, and it stretches the distance the coverage
    // test sees, so an old reading both counts for less and claims less water.
    const c = s.cred == null ? 1 : s.cred;
    const dEff = Math.sqrt(dd) / c;
    if (dEff < dmin) dmin = dEff;
    const d2 = dd + IDW_SOFTEN_M * IDW_SOFTEN_M;
    const w = c / d2;
    wsum += w;
    ssp += w * s.tws;
    // direction averaged as unit vectors, so 359° and 1° average to 0° rather
    // than to 180° — a circular quantity cannot be averaged as a number
    const a = s.twd * D2R;
    sx += w * Math.sin(a);
    sy += w * Math.cos(a);
  }
  if (!wsum) return null;
  return {
    tws: ssp / wsum,
    twd: (Math.atan2(sx, sy) / D2R + 360) % 360,
    dNearest: dmin,
  };
}

/* The field's sources — and the reason the field moves.
 *
 * Taken at one instant, the field is six masthead readings at six boat
 * positions. Advance the clock and the pattern does not travel down the course;
 * it is glued to the fleet, because the only thing that moved was the boats. A
 * gust the leader sailed through a minute ago has simply gone, when in fact it
 * is now somewhere near the bottom gate.
 *
 * So the field is built from the last `trailSec` seconds of readings, and each
 * one is carried from where it was measured to where that air is NOW: downwind,
 * at its own measured speed, for as long as it has been travelling. Frozen
 * Taylor's hypothesis — the standard assumption that over a minute or so a wind
 * pattern is transported by the mean flow faster than it evolves. It is what
 * makes a gust visibly march down the course, and it also fills the water in:
 * a boat's last minute of track seeds a line of readings instead of a point.
 *
 * Age is not free. Each carried reading keeps a credibility that decays with
 * how long it has been drifting, which both thins its weight in the blend and
 * shrinks the water it is allowed to speak for. Set the trail to 0 and this
 * reduces exactly to the instantaneous field.
 */
const TRAIL_STEP_S = 5;
const TRAIL_MAX_SRC = 220;
const TRAIL_HALF_S = 60;        // credibility halves-ish over this long

function windFieldSources(rd, t, sel = 'all') {
  const now = windSources(rd, t, sel, true);
  for (const s of now) s.cred = 1;
  const trail = Math.max(0, WIND_VIEW.trailSec || 0);
  const out = now.slice();
  out.now = now;
  if (!trail) return out;

  for (let age = TRAIL_STEP_S; age <= trail; age += TRAIL_STEP_S) {
    const cred = 1 / (1 + age / TRAIL_HALF_S);
    for (const s of windSources(rd, t - age, sel, true)) {
      // TWD is where the wind came FROM, so the parcel travelled towards
      // twd + 180, at tws km/h, for `age` seconds.
      const a = (s.twd + 180) * D2R;
      const d = rd.frame.r(Math.sin(a), Math.cos(a));
      const m = s.tws / 3.6 * age;
      s.rx += d.rx * m;
      s.ry += d.ry * m;
      s.cred = cred;
      s.age = age;
      out.push(s);
    }
    if (out.length >= TRAIL_MAX_SRC) break;
  }
  return out;
}

/* How much to believe the field at a point, by distance to the nearest reading.
 *
 * IDW will happily answer anywhere, and far from every sensor its answer is
 * just the weighted mean — a confident flat colour over water nobody measured.
 * Painting that at full strength is the single most misleading thing this view
 * could do, so the wash fades out instead and the picture stops where the data
 * does. Full weight within COVER_FULL_M, gone by COVER_GONE_M.
 */
const COVER = { full: 160, gone: 460 };

/* Set the falloff from the spread of the sources: the median distance from
 * each source to its nearest neighbour is how finely the water is actually
 * sampled, and the field should not claim to know more than that. */
function setWindCoverage(src) {
  if (src.length < 2) { COVER.full = 160; COVER.gone = 460; return; }
  const near = [];
  for (let i = 0; i < src.length; i++) {
    let d = Infinity;
    for (let j = 0; j < src.length; j++) {
      if (i === j) continue;
      d = Math.min(d, Math.hypot(src[i].rx - src[j].rx, src[i].ry - src[j].ry));
    }
    if (isFinite(d)) near.push(d);
  }
  if (!near.length) return;
  near.sort((a, b) => a - b);
  const med = near[near.length >> 1];
  COVER.full = Math.max(120, Math.min(700, med * 0.75));
  COVER.gone = Math.max(420, Math.min(2000, med * 2.4));
}

function windCoverage(d) {
  const COVER_FULL_M = COVER.full, COVER_GONE_M = COVER.gone;
  if (d <= COVER_FULL_M) return 1;
  if (d >= COVER_GONE_M) return 0;
  const u = (d - COVER_FULL_M) / (COVER_GONE_M - COVER_FULL_M);
  return (1 - u) * (1 - u);       // squared, so the edge is soft rather than a ring
}

/* The shaded field.
 *
 * Rendered into a small offscreen canvas at the grid pitch and scaled up with
 * smoothing on, which is both far cheaper than filling thousands of rectangles
 * and the reason the result is soft: the browser's bilinear upscale IS the
 * interpolation between cells. Alpha stays low — this is a wash the boats and
 * the wave have to remain legible through, not a heat map in its own right.
 */
function drawWindField(ctx, rd, t, tX, tY, v, W, H) {
  /* 'all' for marks/boats/all — there the selection governs the ringed dots
   * below and never the maths, because interpolating a field from half the
   * instruments and drawing it at full confidence would be a picture of the
   * water that nobody measured.
   *
   * SELECTED SOURCES is the exception, and deliberately: the reason to untick
   * an instrument is that you do not believe it, and a field still built on a
   * masthead you have just rejected would make the whole control cosmetic. So
   * there the pick governs the maths too, and the coverage fade — which is set
   * from how finely the water is actually sampled — widens honestly as sources
   * are dropped. */
  const sel = WIND_VIEW.field === 'selected' ? 'selected' : 'all';
  const src = windFieldSources(rd, t, sel);
  const now = src.now || src;
  // Coverage comes from the LIVE readings only. The trail packs samples along
  // each boat's path, and letting that count as denser sampling would shrink
  // the field to a ribbon behind the fleet — the opposite of what it is for.
  setWindCoverage(now);
  const dom = windDomain(rd);
  rd._windSrcCount = now.length;
  if (src.length < 2 || !dom) return;

  const gw = Math.max(2, Math.ceil(W / FIELD_CELL_PX));
  const gh = Math.max(2, Math.ceil(H / FIELD_CELL_PX));
  const off = drawWindField._c || (drawWindField._c = document.createElement('canvas'));
  off.width = gw; off.height = gh;
  const octx = off.getContext('2d');
  const img = octx.createImageData(gw, gh);

  const mpp = 1 / v.scale;
  for (let j = 0; j < gh; j++) {
    // screen pixel -> rotated-frame metres, the inverse of tX/tY
    const py = (j + 0.5) * H / gh;
    const ry = v.cy - (py - H / 2) * mpp;
    for (let i = 0; i < gw; i++) {
      const px = (i + 0.5) * W / gw;
      const rx = v.cx + (px - W / 2) * mpp;
      const q = idwAt(src, rx, ry);
      const c = windColour((q.tws - dom.lo) / (dom.hi - dom.lo));
      const o = (j * gw + i) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
      img.data[o + 3] = Math.round(255 * windCoverage(q.dNearest));
    }
  }
  octx.putImageData(img, 0, 0);

  ctx.save();
  ctx.globalAlpha = 0.46;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, 0, 0, W, H);
  ctx.restore();

  // Direction arrows on a sparse grid. Uniform length: this says which way, and
  // speed is already the whole point of the shading underneath.
  ctx.save();
  ctx.lineWidth = 1;
  const rot = rd.frame.rot * 180 / Math.PI + viewRotDeg();
  const L = 15;
  for (let py = ARROW_PITCH_PX / 2; py < H; py += ARROW_PITCH_PX) {
    for (let px = ARROW_PITCH_PX / 2; px < W; px += ARROW_PITCH_PX) {
      const rx = v.cx + (px - W / 2) * mpp, ry = v.cy - (py - H / 2) * mpp;
      const q = idwAt(src, rx, ry);
      if (!q) continue;
      // arrows fade on the same coverage curve as the wash, so the two never
      // disagree about how far the data reaches
      const cov = windCoverage(q.dNearest);
      if (cov < 0.06) continue;
      ctx.strokeStyle = `rgba(232,240,250,${(0.42 * cov).toFixed(3)})`;
      ctx.fillStyle = ctx.strokeStyle;
      /* WITH the wind: these fly the way the air is going, so the field reads
       * as flow rather than as a set of bearings. Deliberately the opposite way
       * round from the live mark arrows, which stay pointing into the wind —
       * the mark arrows are instrument readings from one spot, this is a field,
       * and reading a field as flow is what makes a bend visible at a glance. */
      const a = (q.twd + 180 - rot) * D2R;
      const ux = Math.sin(a), uy = -Math.cos(a);
      const x0 = px - ux * L / 2, y0 = py - uy * L / 2;
      const x1 = px + ux * L / 2, y1 = py + uy * L / 2;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - ux * 5 - uy * 3, y1 - uy * 5 + ux * 3);
      ctx.lineTo(x1 - ux * 5 + uy * 3, y1 - uy * 5 - ux * 3);
      ctx.closePath(); ctx.fill();
    }
  }
  ctx.restore();

  // Where the data came from. A ring per selected source — not an arrow and not
  // a number, because those are the Live layer's job and a field is a claim
  // about everywhere between the readings, not at them.
  const shown = WIND_VIEW.field === 'all' ? now
              : now.filter(s => windWants(WIND_VIEW.field, s.kind));
  ctx.save();
  for (const s of shown) {
    const x = tX(s.rx, s.ry), y = tY(s.rx, s.ry);
    if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
    const r = s.kind === 'mark' ? 5 : 3;
    ctx.strokeStyle = s.kind === 'mark' ? 'rgba(255,255,255,0.75)'
                                        : 'rgba(255,255,255,0.4)';
    ctx.lineWidth = s.kind === 'mark' ? 1.8 : 1.1;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

/* The readings themselves. An arrow through each source and its two numbers,
 * and nothing else — no field, no shading, no smoothing.
 *
 * MARKS ONLY, whatever the source setting says. A mark boat sits still in a
 * known piece of water, so an arrow at it is a fact about that place and worth
 * a permanent fixture on the map. An F50's arrow is drawn on top of the F50 —
 * over the hull, the trail, the speed label and, when the fleet compresses,
 * over five other boats' arrows too — and it moves at 40 knots. It buried the
 * part of the map you were reading in exchange for a number that is already in
 * MY BOAT.
 *
 * The mastheads are not being ignored: they still feed the averages, the field
 * and anything set to SELECTED SOURCES. This is only about what gets drawn.
 */
function drawWindLive(ctx, rd, t, tX, tY, W, H) {
  const src = windSources(rd, t, WIND_VIEW.live).filter(s => s.kind === 'mark');
  if (WIND_VIEW.field === 'off') rd._windSrcCount = src.length;
  if (!src.length) return;
  const dom = windDomain(rd);
  const rot = rd.frame.rot * 180 / Math.PI + viewRotDeg();

  ctx.save();
  const placed = [];
  // marks first, so the edge stack builds in a stable order rather than
  // depending on which boat happened to sort first
  for (const s of [...src].sort((a, b) => (b.kind === 'mark') - (a.kind === 'mark'))) {
    let x = tX(s.rx, s.ry), y = tY(s.rx, s.ry);
    let pinned = false;
    if (x < 10 || x > W - 10 || y < 10 || y > H - 10) {
      /* A mark is fixed course furniture — the gates and the windward mark sit
       * hundreds of metres from the line, so at the zoom you actually watch a
       * start at, most of them are off the frame. Dropping them left the marks
       * selection looking empty when it was in fact full. Pinned to the edge
       * instead, on the bearing to where they really are: the same convention
       * the renderer already uses for boats that sail out of shot. A boat's
       * reading is skipped, because drawOffscreen has already marked it. */
      if (s.kind !== 'mark') continue;
      const cx = W / 2, cy = H / 2;
      let dx = x - cx, dy = y - cy;
      const m = Math.max(Math.abs(dx) / (W / 2 - 58), Math.abs(dy) / (H / 2 - 40));
      if (m > 1) { dx /= m; dy /= m; }
      x = cx + dx; y = cy + dy;
      /* Marks that lie in the same direction pin to the same spot — the two
       * finish-line ends land on top of each other and the two readings render
       * as one unreadable smear. Nudge down until clear. Only pinned labels
       * need this: an on-frame mark is where it actually is, and moving it to
       * tidy the text would be a lie about a position. */
      let guard = 0;
      while (guard++ < 12 &&
             placed.some(p => Math.abs(p.x - x) < 96 && Math.abs(p.y - y) < 17))
        y += 17;
      placed.push({ x, y });
      pinned = true;
    }
    ctx.globalAlpha = pinned ? 0.72 : 1;
    const u = dom ? (s.tws - dom.lo) / (dom.hi - dom.lo) : 0.5;
    const c = windColour(u);
    const ink = `rgb(${c[0]},${c[1]},${c[2]})`;
    // Flying WITH the wind — pointing the way the air is going, so the arrow
    // reads as the breeze moving across the course. The number beside it is
    // still the direction the wind comes FROM, which is the convention every
    // other figure on the map uses; the arrow is the picture, the number is
    // the reading.
    const a = (s.twd + 180 - rot) * D2R;
    const ux = Math.sin(a), uy = -Math.cos(a);
    // Red for left of its own last minute, green for right. The speed ramp
    // stays on the numbers, so each thing carries one meaning: the arrow is
    // direction and shift, the figure beside it is speed.
    /* Three states, three colours. The neutral one used to fall through to
     * `ink`, which is the wind-SPEED ramp — blue through green and yellow to
     * red. So an arrow with no meaningful shift in a strong patch came out red
     * and was indistinguishable from a left shift, and in a light patch came
     * out green. Two meanings on one colour is the one thing this overlay
     * cannot afford. Neutral is now the map's own muted ink: plainly neither.
     * The speed ramp stays on the NUMBER beside it, where it is the only thing
     * that colour means. */
    const side = shiftSide(s.twd, s.avg);
    const shaft = side < 0 ? SHIFT_LEFT_INK
                : side > 0 ? SHIFT_RIGHT_INK
                : MAP_INK.faint;
    // A mark is a fixed instrument in a known place and reads the air without
    // dragging its own wake through it, so it gets much the bigger arrow. A
    // boat's masthead is a reading taken while moving, and is drawn as the
    // lighter one — the weights are the confidence, not decoration.
    const L = s.kind === 'mark' ? (pinned ? 32 : 52) : 22;
    const x0 = x - ux * L * 0.5, y0 = y - uy * L * 0.5;
    const x1 = x + ux * L * 0.5, y1 = y + uy * L * 0.5;
    ctx.strokeStyle = shaft; ctx.fillStyle = shaft;
    ctx.lineWidth = s.kind === 'mark' ? 3 : 1.3;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    const hb = s.kind === 'mark' ? (pinned ? 8 : 12) : 5;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - ux * hb - uy * hb * 0.6, y1 - uy * hb + ux * hb * 0.6);
    ctx.lineTo(x1 - ux * hb + uy * hb * 0.6, y1 - uy * hb - ux * hb * 0.6);
    ctx.closePath(); ctx.fill();
    if (s.kind === 'mark') {
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    }

    // A boat's own labels — name, speed, ratio — already stack to its RIGHT, so
    // the wind reading goes to the left. On a packed line that is the difference
    // between two columns of numbers and one illegible pile.
    const txt = `${Math.round(s.twd)}° ${s.tws.toFixed(1)}`;
    ctx.font = s.kind === 'mark' ? '700 10px "Share Tech Mono", monospace'
                                 : '9px "Share Tech Mono", monospace';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = MAP_INK.halo;
    const isMark = s.kind === 'mark';
    // a pinned mark hugs the frame edge, so its label goes on the inboard side
    const inboard = pinned && x > W / 2 ? 'right' : (isMark ? 'left' : 'right');
    ctx.textAlign = inboard;
    const lx = inboard === 'left' ? x + 10 : x - 10, ly = y + (isMark ? -12 : 0);
    ctx.strokeText(txt, lx, ly);
    ctx.fillStyle = ink;
    ctx.fillText(txt, lx, ly);
    if (isMark) {
      ctx.font = '700 9px Orbitron, monospace';
      ctx.strokeStyle = MAP_INK.halo;
      ctx.strokeText(s.label, lx, ly - 11);
      ctx.fillStyle = MAP_INK.cap;
      ctx.fillText(s.label, lx, ly - 11);
    }
  }
  ctx.restore();
}

/* The scale, bottom right, above the scale bar. Numbers on both ends and in the
 * middle: a ramp with no numbers is decoration. */
function drawWindLegend(ctx, rd, W, H) {
  const dom = windDomain(rd);
  const src = rd._windSrcCount || 0;
  ctx.save();
  const bw = 128, bh = 9, x0 = W - bw - 18, y0 = H - 62;
  if (WIND_VIEW.field !== 'off' && dom) {
    for (let i = 0; i < bw; i++) {
      const c = windColour(i / (bw - 1));
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.fillRect(x0 + i, y0, 1, bh);
    }
    ctx.strokeStyle = 'rgba(150,180,210,0.35)'; ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, bw - 1, bh - 1);
    ctx.font = '9px "Share Tech Mono", monospace';
    ctx.fillStyle = 'rgba(190,205,225,0.85)';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';   ctx.fillText(dom.lo.toFixed(0), x0, y0 + bh + 3);
    ctx.textAlign = 'right';  ctx.fillText(dom.hi.toFixed(0) + ' km/h', x0 + bw, y0 + bh + 3);
    ctx.textAlign = 'center'; ctx.fillText(((dom.lo + dom.hi) / 2).toFixed(0), x0 + bw / 2, y0 + bh + 3);
  }
  ctx.font = '700 9px Orbitron, monospace';
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(160,180,205,0.8)';
  // The count is of what the picture RESTS on: the field's own source list
  // when the field is up, otherwise the readings being drawn.
  ctx.fillText(WIND_VIEW.field !== 'off'
    ? `INTERPOLATED WIND · ${src} SOURCES`
    : `LIVE WIND · ${src} SOURCES`, W - 18, y0 - 5);

  /* Asking for marks when this start has none used to draw nothing at all,
   * which reads as a broken control rather than as missing data. Say it. */
  const wantsMarks = WIND_VIEW.live === 'marks' || WIND_VIEW.live === 'all'
                  || WIND_VIEW.live === 'selected'
                  || WIND_VIEW.field === 'marks' || WIND_VIEW.field === 'all'
                  || WIND_VIEW.field === 'selected';
  if (wantsMarks && !(rd.markWind && rd.markWind.length)) {
    ctx.font = '700 9px Orbitron, monospace';
    ctx.fillStyle = 'rgba(255,190,90,0.9)';
    ctx.fillText('NO MARK LOGS FOR THIS START — BOAT SENSORS ONLY', W - 18, y0 - 18);
  }
  ctx.restore();
}

/* Two grid steps, and only two.
 *
 * The old ladder picked whatever round number happened to land near 70 px, so
 * the grid was 20 m at one zoom, 50 at the next, 100 after that — and a grid
 * whose square keeps changing size is a grid you have to re-read the legend for
 * every time you touch the wheel, which defeats the point of having one. Two
 * fixed sizes can be learned: close in you are counting boat lengths on a 50 m
 * square, zoomed out you are reading the course on a 200 m one.
 *
 * GRID_SWITCH_PX is the narrowest a 50 m square is allowed to get before it
 * gives way. Below it the fine grid would be denser than the boats.
 */
const GRID_FINE_M = 50;
const GRID_COARSE_M = 200;
const GRID_SWITCH_PX = 40;
const gridStepFor = mpp => GRID_FINE_M / mpp >= GRID_SWITCH_PX ? GRID_FINE_M : GRID_COARSE_M;

/* A grid that can be turned to something.
 *
 * It used to be screen-aligned: lines drawn at constant frame x and y straight
 * to pixels with no rotation, so however the map was turned the grid stayed
 * square to the window. That makes it a ruler and nothing more. Given an angle
 * it becomes a frame of reference — square to the course, to the boat, or to
 * the wind, where one family of lines IS the ladder and the other is distance
 * along it, and a header shows up as boats crossing the rungs.
 *
 * Drawn in screen space, because that is where the constraint lives (fill the
 * window) and the spacing is a fixed number of pixels once mpp is known. The
 * two families are perpendicular by construction, so only one angle is needed.
 * The offsets are anchored to the frame ORIGIN projected onto each normal, not
 * to the corner of the window, or the whole grid would crawl as you panned.
 */
function drawGrid(ctx, W, H, mpp, angRad, ox, oy) {
  const step = gridStepFor(mpp);
  const px = step / mpp;                     // line spacing, pixels
  if (!(px > 2)) return;                     // denser than this is a grey wash
  const a = angRad || 0;

  ctx.save();
  ctx.strokeStyle = MAP_INK.grid;
  ctx.lineWidth = 1;

  /* (ox, oy) is where the frame's ORIGIN lands on screen, handed in from the
   * same tX/tY everything else on this map is drawn with. That is what pins the
   * grid to the water: pan and the origin moves, so the lines move with it.
   *
   * It has to come from the real transform. Deriving it here from the view
   * centre and the GRID's own angle — which was the first attempt — silently
   * mixes two different rotations: the grid's orientation is not the map's, and
   * the result was a grid that stayed nailed to the window while the water slid
   * underneath it.
   */

  for (const k of [0, 1]) {
    const th = a + k * Math.PI / 2;
    const ux = Math.cos(th), uy = Math.sin(th);      // along the lines
    const nx = -uy, ny = ux;                         // across them
    const anchor = ox * nx + oy * ny;
    // How far the window's corners reach along the normal decides how many
    // lines there are; anything outside that range is off-screen.
    let lo = Infinity, hi = -Infinity;
    for (const [cx2, cy2] of [[0, 0], [W, 0], [0, H], [W, H]]) {
      const d = cx2 * nx + cy2 * ny;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    const first = Math.ceil((lo - anchor) / px) * px + anchor;
    // The line at offset d, drawn long enough to cross the window whatever
    // its angle: the diagonal is the worst case.
    const half = Math.hypot(W, H);
    for (let d = first; d <= hi; d += px) {
      const bx = nx * d, by = ny * d;
      ctx.beginPath();
      ctx.moveTo(bx - ux * half, by - uy * half);
      ctx.lineTo(bx + ux * half, by + uy * half);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/* The boundary is a BAND, not a line.
 *
 * What the course file carries is the inside edge of the boundary zone - the
 * last water you may sail. The zone itself has width, and a boat approaching it
 * needs to see the thing it must not enter, not just the line where trouble
 * starts. So a second polygon is offset outwards and the ring between the two
 * is shaded red.
 *
 * Offsetting a closed polygon is done properly rather than by scaling it about
 * its centre, which is not the same operation and is wrong everywhere the shape
 * is not a circle. Each vertex moves along the bisector of its two edge
 * normals, by d / cos(half the turn), which is exactly the distance that puts
 * both offset edges d away from their originals. The winding decides which side
 * is out, taken from the signed area, so a polygon stored clockwise offsets
 * outwards just the same as one stored anticlockwise.
 */
const BOUNDARY_BAND = { m: 80 };
const BOUNDARY_MITRE_CAP = 0.2;   // a hairpin would otherwise run to infinity

function offsetPoly(pts, d) {
  // Either way: positive pushes the ring outward, negative pulls it in. It used
  // to refuse anything but positive, which silently returned null — and a null
  // ring is a band that simply does not draw — the moment the boundary zone was
  // asked for on the inside of the stored polygon rather than the outside.
  if (!isFinite(d) || d === 0) return null;
  // Dedupe first, and dedupe rather than skip: a repeated point has no edge
  // direction, and skipping it in the offset ring while keeping it in the
  // original would put the two rings out of step with each other for every
  // vertex after it. Both rings are built from the same cleaned list, so they
  // correspond by construction. Course files routinely repeat the first point
  // at the end to close the ring, which is exactly this case.
  const clean = [];
  for (const p of pts) {
    const q = clean[clean.length - 1];
    if (!q || Math.hypot(p.rx - q.rx, p.ry - q.ry) > 1e-6) clean.push(p);
  }
  while (clean.length > 1 &&
         Math.hypot(clean[0].rx - clean[clean.length - 1].rx,
                    clean[0].ry - clean[clean.length - 1].ry) <= 1e-6) clean.pop();
  const n = clean.length;
  if (n < 3) return null;

  let a2 = 0;
  for (let i = 0; i < n; i++) {
    const p = clean[i], q = clean[(i + 1) % n];
    a2 += p.rx * q.ry - q.rx * p.ry;
  }
  const sgn = a2 > 0 ? 1 : -1;
  const unit = (ax, ay) => { const L = Math.hypot(ax, ay);
                             return L > 1e-9 ? { x: ax / L, y: ay / L } : null; };
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = clean[(i - 1 + n) % n], cur = clean[i], next = clean[(i + 1) % n];
    const e1 = unit(cur.rx - prev.rx, cur.ry - prev.ry);
    const e2 = unit(next.rx - cur.rx, next.ry - cur.ry);
    if (!e1 || !e2) return null;           // cannot happen after the dedupe
    // outward normal of an edge, for this winding
    const n1 = { x: sgn * e1.y, y: -sgn * e1.x };
    const n2 = { x: sgn * e2.y, y: -sgn * e2.x };
    let bx = n1.x + n2.x, by = n1.y + n2.y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-9) {                       // doubles back on itself
      out.push({ rx: cur.rx + n1.x * d, ry: cur.ry + n1.y * d });
      continue;
    }
    bx /= bl; by /= bl;
    const k = d / Math.max(BOUNDARY_MITRE_CAP, bx * n1.x + by * n1.y);
    out.push({ rx: cur.rx + bx * k, ry: cur.ry + by * k });
  }
  return { inner: clean, outer: out };
}

function drawLimits(ctx, f, tX, tY) {
  // Keyed on the layer name with any trailing number stripped, because a course
  // file carries "Danger Zone" through "Danger Zone 16" and they are one thing.
  const style = {
    'Boundary':          ['rgba(120,170,230,0.30)', [6, 5]],
    'Training Boundary': ['rgba(90,200,140,0.16)',  [3, 6]],
    'Exclusion Zone':    ['rgba(255,150,60,0.16)',  [2, 7]],
    'EZ':                ['rgba(255,150,60,0.16)',  [2, 7]],
    'Danger Zone':       ['rgba(255,90,90,0.20)',   [2, 4]],
    'No Go Zone':        ['rgba(255,90,90,0.20)',   [2, 4]],
    'Shallow':           ['rgba(210,180,90,0.18)',  [1, 5]],
    'The Island':        ['rgba(210,180,90,0.22)',  [1, 5]],
    'Pit Lane':          ['rgba(150,160,180,0.14)', [5, 5]],
    'VIP':               ['rgba(190,120,200,0.13)', [3, 5]],
    // SY (superyacht) and BYOB come from the original bundle's Sassnitz days
    // rather than the XML, so they predate the KEEP_LAYERS filter.
    'SY':                ['rgba(190,120,200,0.13)', [3, 5]],
    'BYOB':              ['rgba(150,160,180,0.12)', [3, 5]],
  };
  ctx.save();
  const trace = pts => {
    pts.forEach((p, i) => i ? ctx.lineTo(tX(p.rx, p.ry), tY(p.rx, p.ry))
                            : ctx.moveTo(tX(p.rx, p.ry), tY(p.rx, p.ry)));
    ctx.closePath();
  };
  for (const [name, pts] of Object.entries(f.limits || {})) {
    if (!pts.length) continue;
    const base = name.replace(/ \d+$/, '');
    const [col, dash] = style[base] || ['rgba(140,160,190,0.15)', [4, 4]];

    // The racecourse boundary gets its zone drawn. Everything else on the map
    // is already an area with its own meaning; this is the one layer that is
    // stored as the inside edge of something wider.
    if (base === 'Boundary' && BOUNDARY_BAND.m > 0) {
      const ring = offsetPoly(pts, -BOUNDARY_BAND.m);
      if (ring) {
        ctx.save();
        ctx.setLineDash([]);
        // Even-odd across the two rings fills the space between them and
        // nothing else, which is what a band is. Canvas has no path
        // subtraction, but for two nested rings this is exactly equivalent.
        ctx.beginPath();
        trace(ring.inner);
        trace(ring.outer);
        ctx.fillStyle = 'rgba(226,54,54,0.20)';
        ctx.fill('evenodd');
        ctx.strokeStyle = 'rgba(255,96,96,0.42)';
        ctx.lineWidth = 1.2;
        ctx.beginPath(); trace(ring.inner); ctx.stroke();
        ctx.restore();
      }
    }

    ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.setLineDash(dash);
    ctx.beginPath();
    trace(pts);
    ctx.stroke();
  }
  ctx.restore();
}

/* The ADVANTAGE CURVE: how far ahead toward M1 each position along the line
 * starts you, compared with the pin.
 *
 * Drawn FORWARD — bulging onto the course side, toward the mark — because that
 * is the direction the advantage is in. The same number can be phrased as "you
 * could afford to be 26 m further back and still tie", and an earlier version
 * drew it that way, standing off the pre-start side. It is arithmetically
 * identical and reads backwards: the eye wants the good end to lean toward the
 * mark it is good for.
 *
 * Filled, at TRUE SCALE — the depth of the curve at any point is metres you can
 * read straight off the map, not an arbitrary chart axis. A flat curve means a
 * square line for this leg.
 */
/* ── the wave ───────────────────────────────────────────────────────────────
 *
 * Where could a boat be right now and still arrive at the line exactly at the
 * gun? Take every point P along the line, and every course a boat might sail
 * to reach it. Sailing that course at polar speed for the time left covers
 * v(TWA) * T metres, so the boat would have to be standing at P minus that
 * vector. Sweep the course through the whole pre-start side and you get a fan
 * around P; sweep P along the line and the fans merge into one region.
 *
 * Inside it you are early — you can make the line before the gun and will have
 * to burn time. Outside it you are late, and no amount of trimming fixes it.
 * The boundary is the wave, and it sweeps in onto the line as the gun
 * approaches, collapsing onto the line itself at T = 0.
 *
 * The no-go zone falls out of the maths rather than being drawn in: head to
 * wind the polar has no speed, the reach is zero, and the fan pinches to the
 * line at that angle.
 *
 * It is polar speed from a standing sweep, not a simulation — no acceleration,
 * no manoeuvres, no tacking. A boat that has to gybe to get there cannot
 * actually make the edge of the fan.
 */
const WAVE_COURSE_STEP = 3;      // degrees between sampled courses
// A course that only grazes the line still "reaches" it — from a kilometre down
// the line extension, sailing parallel to it. True, and useless: it turns the
// zone into two spikes along the line. Require the approach to close on the
// line at a real angle.
const WAVE_MIN_CLOSE_DEG = 20;

/* The fan itself, as pure geometry: one entry per sampled course, each the
 * vector FROM a point on the line back to where you would have to be. Split
 * out from the drawing so it can be tested. */
function waveFan(rd, T, pad = 0) {
  const p = rd.polar, f = rd.frame;
  const twd = rd.wind.twd, tws = rd.wind.tws;
  if (!p || twd == null || tws == null || !(T > 0)) return [];
  const arm = [];
  for (let brg = 0; brg < 360; brg += WAVE_COURSE_STEP) {
    const d = f.r(Math.sin(brg * D2R), Math.cos(brg * D2R));
    const close = -(d.rx * f.n.x + d.ry * f.n.y);     // >0 = closing on the line
    if (close < Math.sin(WAVE_MIN_CLOSE_DEG * D2R)) continue;
    // Speed made good along this course. Inside the no-go zone — and past the
    // downwind limit — there is no polar cell, but the boat is not stuck: it
    // gets there by tacking or gybing, making good v_opt * cos(off the optimum
    // angle). Without this the fan has a deep notch straight upwind, which is
    // an artefact of the table rather than a fact about the boat.
    let A = ((twd - brg) % 360 + 360) % 360;
    if (A > 180) A = 360 - A;
    let v = polarSpeed(p, twd - brg, tws) || 0;
    const tu = rd.targetUp, td = rd.targetDn;
    if (tu && A < tu.twa) v = Math.max(v, tu.speed * Math.cos((tu.twa - A) * D2R));
    if (td && A > td.twa) v = Math.max(v, td.speed * Math.cos((A - td.twa) * D2R));
    const reach = Math.max(0, v / 3.6) * T + pad;
    arm.push({ brg, twa: A, reach, dx: -d.rx * reach, dy: -d.ry * reach });
  }
  arm.sort((a, b) => Math.atan2(a.dy, a.dx) - Math.atan2(b.dy, b.dx));
  return arm;
}

const WAVE_INK  = '#ff2d3f';                    // the ratio 1.00 front
const WAVE_R_INK = '#ffbe5a';                   // the target-ratio front

/* The wave line itself, drawn as a band of water rather than as a stroke: how
 * far OUTSIDE the ratio-1.00 front the black reaches, in metres. A stroke has a
 * width in pixels and so means a different distance at every zoom; a band in
 * metres means the same piece of water however far out you are looking. */
const WAVE_OUTSIDE = { m: 300 };
const WAVE_OUT_INK = '#000000';

/* One scratch canvas, kept and resized, not a new one every frame. At 1600x950
 * on a 2x display each of these is ~12 MB of backing store, and the wave is
 * drawn on every rendered frame. */
waveBand._c = null;
function waveBand(ctx, rd, Touter, Tinner, tX, tY, W, H, fill, glow, padO = 0, padI = 0) {
  const dpr = window.devicePixelRatio || 1;
  const off = waveBand._c || (waveBand._c = document.createElement('canvas'));
  const w = Math.round(W * dpr), h = Math.round(H * dpr);
  if (off.width !== w || off.height !== h) { off.width = w; off.height = h; }
  const oc = off.getContext('2d');
  oc.setTransform(1, 0, 0, 1, 0, 0);
  oc.clearRect(0, 0, w, h);
  oc.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (!waveRegion(oc, rd, Touter, tX, tY, glow, fill, padO)) return false;
  oc.globalCompositeOperation = 'destination-out';
  waveRegion(oc, rd, Tinner, tX, tY, 'rgba(0,0,0,0)', '#000', padI);
  oc.globalCompositeOperation = 'source-over';

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(off, 0, 0);
  ctx.restore();
  return true;
}

function drawWave(ctx, rd, t, tX, tY, W, H) {
  const T = -t;
  // Red, and opaque black inside: the wave is the hard edge of the start and it
  // should be the first thing the eye lands on. Filled before the line, the
  // marks and the boats, so it hides nothing but the grid.
  const R = WAVE_RATIO.on ? WAVE_RATIO.target : 0;
  /* The band between the two fronts. Which of them is the outer one depends on
   * the target: the fan's reach is linear in T, so a target ABOVE 1.00 puts its
   * front inside the ratio-1.00 wave and a target BELOW 1.00 puts it outside.
   * waveBand punches the second region out of the first, so handing it the two
   * times in the wrong order erased everything it had just drawn — which is
   * what a target of 0.8 used to do: a blank map under two confident legends.
   * Sorting them here makes the band the region between, either way round. */
  /* A black band OUTSIDE the ratio-1.00 front, before anything else is drawn.
   *
   * The front is where the polar just reaches the line on the gun; past it you
   * are late however you sail. That side is the one worth marking, and it is
   * unbounded, which is why the band has a depth rather than being a fill: the
   * fan is re-run with WAVE_OUTSIDE.m added to every arm's reach and the plain
   * front punched out of it, leaving a ring of constant thickness that follows
   * the front exactly.
   *
   * Under the field, the boundary, the marks and the boats, so it darkens the
   * water and hides nothing that is on it. */
  if (WAVE_OUTSIDE.m > 0)
    waveBand(ctx, rd, T, T, tX, tY, W, H, WAVE_OUT_INK, 'rgba(0,0,0,0)',
             WAVE_OUTSIDE.m, 0);

  const live = R > 0
    ? waveBand(ctx, rd, Math.max(T, T / R), Math.min(T, T / R),
               tX, tY, W, H, 'rgba(255,190,90,0.17)', WAVE_INK)
    : waveRegion(ctx, rd, T, tX, tY, WAVE_INK, MAP_INK.waveFill);

  if (!live) return;

  ctx.save();
  ctx.font = '700 9px Orbitron, monospace';
  const lines = [];
  if (live) lines.push([MAP_INK.waveTxt,
    `WAVE · ratio 1.00 — polar reach to the line with ${T.toFixed(0)}s left`]);
  if (R > 0) lines.push([MAP_INK.waveRTxt,
    `WAVE @ ${R.toFixed(2)} · be on this edge to be holding ${R.toFixed(2)}`]);
  // stacked upwards from the layline label so nothing moves when one appears
  lines.forEach(([ink, lbl], i) => {
    const y = H - 88 - (lines.length - 1 - i) * 20;
    const tw = ctx.measureText(lbl).width;
    ctx.fillStyle = MAP_INK.plate;
    ctx.strokeStyle = MAP_INK.plateEdge; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(16, y, tw + 14, 16, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = ink;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(lbl, 23, y + 8);
  });
  ctx.restore();
}

/* One front, for a boat that needs T seconds of polar sailing to reach the
 * line. Returns whether it drew anything, so the caller can label what is on
 * screen rather than what it asked for.
 *
 * Split out of drawWave so the ratio-1 wave and the target-ratio front are the
 * same geometry with a different T — if that ever stops being true, the two
 * would be answering different questions while looking like one picture.
 */
function waveRegion(ctx, rd, T, tX, tY, glow, fill, pad = 0) {
  const f = rd.frame;
  if (!(T > 0.5)) return false;               // at and after the gun there is none
  const arm = waveFan(rd, T, pad);
  if (arm.length < 3) return false;
  arm.sort((a, b) => Math.atan2(a.dy, a.dx) - Math.atan2(b.dy, b.dx));

  // The region is that fan swept along the whole line — every point on the
  // line is a place you might want to arrive. Sweeping a shape along a segment
  // is a Minkowski sum, and its outline is the fan drawn from the leeward end
  // on the side that leans leeward and from the windward end on the side that
  // leans windward, with the two joined across the line's length. That gives
  // ONE closed outline, which can be stroked — sixteen overlapping fans could
  // only be filled.
  // The region is that fan swept along the whole line — every point on the
  // line is somewhere you might want to arrive. Drawn as one fan per sampled
  // point on the line, all in a single path: they overlap heavily and a
  // nonzero fill unions them, which a stroke could not do. The edge is a
  // shadow for the same reason — it follows the silhouette of the union
  // rather than tracing every fan inside it.
  const N = 40;
  ctx.save();
  ctx.beginPath();
  for (let k = 0; k <= N; k++) {
    const along = f.lineLen * k / N;
    const bx = f.leeR.rx + f.u.x * along, by = f.leeR.ry + f.u.y * along;
    ctx.moveTo(tX(bx, by), tY(bx, by));
    for (const a of arm) ctx.lineTo(tX(bx + a.dx, by + a.dy), tY(bx + a.dx, by + a.dy));
    ctx.closePath();
  }
  // The wave's own fill is opaque: a see-through one lets its glow show from
  // underneath and the zone comes out pale grey instead of black. The
  // target-ratio front is deliberately translucent — it is a shading over the
  // wave, not a second hole in it. One fill of one path either way, so the
  // forty overlapping fans union into a single even wash rather than stacking.
  ctx.shadowColor = glow;
  ctx.shadowBlur = 10;
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.restore();
  return true;
}

function drawAdvantage(ctx, rd, tX, tY, H) {
  const A = rd.advantage, f = rd.frame;
  if (!A || !A.pts.length) return;

  const usable = A.pts.filter(p => p.advM != null);
  if (usable.length < 3) return;

  // f.n points to the PRE-START side, so the advantage is drawn along -n to
  // put it forward, toward M1.
  const xy = p => {
    const off = -(p.advM || 0);
    const rx = f.leeR.rx + f.u.x * p.alongM + f.n.x * off;
    const ry = f.leeR.ry + f.u.y * p.alongM + f.n.y * off;
    return [tX(rx, ry), tY(rx, ry)];
  };
  const base = p => {
    const rx = f.leeR.rx + f.u.x * p.alongM, ry = f.leeR.ry + f.u.y * p.alongM;
    return [tX(rx, ry), tY(rx, ry)];
  };

  ctx.save();

  // filled band between the line and the curve
  ctx.beginPath();
  usable.forEach((p, i) => { const [x, y] = xy(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  for (let i = usable.length - 1; i >= 0; i--) { const [x, y] = base(usable[i]); ctx.lineTo(x, y); }
  ctx.closePath();
  ctx.fillStyle = 'rgba(167,139,250,0.16)';
  ctx.fill();

  // the curve itself
  ctx.beginPath();
  usable.forEach((p, i) => { const [x, y] = xy(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = 'rgba(167,139,250,0.85)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // tick at the pin, where the curve is zero by definition
  const pinPt = usable.reduce((a, b) =>
    Math.abs(b.pct - (A.pin === 'windward' ? 100 : 0)) <
    Math.abs(a.pct - (A.pin === 'windward' ? 100 : 0)) ? b : a);
  const [bx, by] = base(pinPt);
  ctx.fillStyle = 'rgba(167,139,250,0.9)';
  ctx.beginPath(); ctx.arc(bx, by, 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.font = '700 8px Orbitron, monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('PIN 0', bx, by + 7);

  // The peak gets a leader and a dot but no label of its own. It is the same
  // place as the fast point by construction, so two chips here were two names
  // for one fact sitting on top of each other.
  const pk = A.peak;
  if (pk && pk.advM != null && Math.abs(pk.advSec) > 0.05) {
    const [px, py] = xy(pk);
    const [qx, qy] = base(pk);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = MAP_INK.fastDim; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(qx, qy); ctx.lineTo(px, py); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = MAP_INK.fastTxt;
    ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();

  /* The caption, bottom left. It used to live in drawLaylines and open with
   * `LAYLINE 47° STBD`, describing two dashed rays off the line ends drawn from
   * the RACE TWD and never updated. Those are gone — the start laylines are now
   * a control of their own with a live, chosen wind — so the caption comes here,
   * to the curve it was actually describing, and drops the prefix that named
   * something no longer on the map. */
  if (H) {
    ctx.save();
    const lbl = `ADVANTAGE TO M1 vs ${A.pin.toUpperCase()} PIN ` +
                `(${A.T0.toFixed(1)}s from the pin)`;
    ctx.font = '700 9px Orbitron, monospace';
    const tw = ctx.measureText(lbl).width;
    ctx.fillStyle = MAP_INK.plate;
    ctx.strokeStyle = 'rgba(74,222,128,0.3)'; ctx.lineWidth = 1;
    // clear of the scale bar, which owns the bottom-left corner
    ctx.beginPath(); ctx.roundRect(16, H - 68, tw + 14, 16, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = MAP_INK.cap;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(lbl, 23, H - 60);
    ctx.restore();
  }
}

/* Where the fast-point chip lands, as a rectangle, without drawing it.
 *
 * Split out so that app.js's LINE TO M1 labels — which are drawn EARLIER in the
 * frame and would otherwise be painted over — can ask where this chip is going
 * to be and step out of its way. Two pieces of code guessing at the same
 * placement would drift apart the first time either was touched; this way there
 * is one placement and the other layer reads it.
 *
 * Needs a ctx only to measure the text.
 */
/* The chip's contents, in one place.
 *
 * Two functions draw this chip's worth of text — the one that MEASURES the box
 * and the one that FILLS it — and they used to build the same list twice from
 * two copies of the same expressions. A line added to one and not the other is
 * a line drawn outside its own box, which is a bug you only see at the zoom
 * where it overflows. One list, both callers.
 *
 * ANGLE is the first board off the line from that spot: what you will actually
 * be sailing once you are across, so the percentage tells you where to be and
 * this tells you what to set up for.
 */
function fastPointLines(rd) {
  const fp = rd.fastPoint;
  const adv = rd.advantage && rd.advantage.peak;
  const out = [
    { t: 'FAST POINT', f: '700 9px Orbitron, monospace', c: '#a78bfa' },
    { t: `${fp.pct.toFixed(0)}% · ${fp.t.toFixed(1)}s to M1`,
      f: '9px "Share Tech Mono", monospace', c: MAP_INK.faint },
  ];
  if (fp.brgToM1 != null) {
    const twa = fp.twaToM1;
    out.push({
      t: `${Math.round((fp.brgToM1 % 360 + 360) % 360).toString().padStart(3, '0')}°`
       + (twa == null ? '' : ` · TWA ${Math.round(Math.abs(twa))}° `
                            + (twa >= 0 ? 'STBD' : 'PORT')),
      f: '9px "Share Tech Mono", monospace', c: MAP_INK.faint });
  }
  if (adv && adv.advM != null && Math.abs(adv.advSec) > 0.05)
    out.push({ t: `${adv.advM.toFixed(0)} m ahead of the pin`,
               f: '700 10px Orbitron, monospace', c: '#a78bfa' });
  return out;
}

function fastPointChipRect(ctx, rd, tX, tY, W, H) {
  const fp = rd.fastPoint, f = rd.frame;
  if (!fp || !f) return null;
  /* When LINE TO M1 is on, app.js has already laid this chip out as the middle
   * row of a three-row column — top end's angle above it, bottom end's below —
   * and stored where it put it. Honour that: the whole point of the column is
   * that the three rows share an edge, which they cannot do if this one goes on
   * placing itself. Cleared every frame by drawEndLegs, so it can never be
   * stale. */
  if (rd._startStack && rd._startStack.chip) return rd._startStack.chip;
  const rx = f.leeR.rx + f.u.x * fp.along;
  const ry = f.leeR.ry + f.u.y * fp.along;
  const x = tX(rx, ry), y = tY(rx, ry);
  const lines = fastPointLines(rd);

  ctx.save();
  let bw = 0;
  for (const l of lines) { ctx.font = l.f; bw = Math.max(bw, ctx.measureText(l.t).width); }
  ctx.restore();
  bw += 14;
  const bh = lines.length * 13 + 8;
  /* Across the line, on the COURSE side.
   *
   * It used to be pinned to `x + 14` under a comment claiming it sat on the
   * pre-start side — which it did, by accident of this venue's orientation, and
   * that is the side the fleet is on. A chip parked over the boats in the last
   * minute before the gun is a chip in the way of the one thing you are
   * watching. So it goes the other way now, and it is placed off the frame's
   * own normal rather than off a hardcoded sign, which keeps it across the line
   * whichever way the venue faces and whichever way the map is turned.
   */
  const nd = dirToScreen(-f.n.x, -f.n.y);        // away from the pre-start side
  const gap = 14;
  let bx = x + nd.dx * (gap + bw / 2) - bw / 2;
  let by = y + nd.dy * (gap + bh / 2) - bh / 2;
  bx = Math.max(6, Math.min(W - bw - 6, bx));
  by = Math.max(6, Math.min((H || 620) - bh - 6, by));
  return { bx, by, bw, bh };
}

/* The fast point: where along the line M1 is reached soonest. */
function drawFastPoint(ctx, rd, tX, tY, W, H) {
  const fp = rd.fastPoint, f = rd.frame;
  if (!fp) return;
  const rx = f.leeR.rx + f.u.x * fp.along;
  const ry = f.leeR.ry + f.u.y * fp.along;
  const x = tX(rx, ry), y = tY(rx, ry);

  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#a78bfa';
  ctx.strokeStyle = MAP_INK.buoyEdge; ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(0, -9); ctx.lineTo(8, 0); ctx.lineTo(0, 9); ctx.lineTo(-8, 0);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();

  const lines = fastPointLines(rd);

  ctx.save();
  const { bx, by, bw, bh } = fastPointChipRect(ctx, rd, tX, tY, W, H);
  ctx.fillStyle = MAP_INK.chip;
  ctx.strokeStyle = 'rgba(167,139,250,0.45)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 4); ctx.fill(); ctx.stroke();
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  lines.forEach((l, i) => {
    ctx.font = l.f; ctx.fillStyle = l.c;
    ctx.fillText(l.t, bx + 7, by + 10 + i * 13);
  });
  ctx.restore();
}

/* Laylines to both ends of the start line, starboard tack.
 *
 * The angle is the polar's best-VMG upwind TWA at the race TWS — not the
 * boat's instantaneous logged target, which is noisy and would make the lines
 * twitch frame to frame. Measured against the boats' own onboard targets over
 * every start in this session, the polar runs +1.0 to +2.0 deg wide upwind with
 * a spread of ~4.5 deg, so treat these as a guide, not a boundary.
 *
 * Wind direction is the race-level fleet TWD for the same reason: stable beats
 * instantaneous when you are drawing a line someone will judge a position
 * against.
 *
 * Starboard green, port red — the usual convention, so the tack is readable
 * without a legend.
 */
/* `trim` widens or narrows the laylines by hand.
 *
 * The target angle is derived from TWS, and TWS is the least reliable channel
 * on the boat — a masthead reading low hands back an angle that is wrong in
 * exactly the place it matters, and no amount of damping fixes a bias. So the
 * angle can be trimmed: positive opens the two laylines away from each other,
 * negative closes them.
 *
 * "Wider" has to mean the same thing at both ends of the course, and that is
 * not the same arithmetic. Upwind the laylines sit at TWA θ either side of the
 * wind, so they separate as θ grows. Downwind they sit at θ from the wind with
 * the run between them, so the gap is 180 − θ and they separate as θ SHRINKS.
 * One number, opposite signs, so the control does what it says whichever gate
 * you are looking at.
 *
 * It moves the route with them. The two were deliberately made to agree — the
 * route's last stretch into a mark lies along that mark's layline — and a trim
 * that shifted only the dashed lines would pull them apart again. It is one
 * correction to the boat's target angles, so everything reading those angles
 * gets it.
 */
const LAYLINE = { on: true, source: 'marks', dampSec: 10, trim: 0, target: 'gate' };
const LAYLINE_TRIM_UP = [20, 85];        // sane bounds, so a slider cannot
const LAYLINE_TRIM_DN = [95, 179];       // produce an angle that is not sailing

const trimTwa = (twa, up) => {
  const k = LAYLINE.trim || 0;
  if (!k || twa == null) return twa;
  const [lo, hi] = up ? LAYLINE_TRIM_UP : LAYLINE_TRIM_DN;
  return Math.max(lo, Math.min(hi, up ? twa + k : twa - k));
};
const TACK_STBD = '#3ddc84';
const TACK_PORT = '#ff4d5e';

/* Vector mean of a direction series — an arithmetic mean of degrees puts a
 * wind oscillating either side of north somewhere near south. */
function meanWind(dirs, spds) {
  let x = 0, y = 0, s = 0, n = 0;
  for (let i = 0; i < dirs.length; i++) {
    if (dirs[i] == null) continue;
    x += Math.sin(dirs[i] * D2R);
    y += Math.cos(dirs[i] * D2R);
    if (spds && spds[i] != null) { s += spds[i]; n++; }
  }
  if (!n && !x && !y) return null;
  return { twd: (Math.atan2(x, y) / D2R + 360) % 360, tws: n ? s / n : null, n };
}


/* A robust, edge-tapered wind average - and a pure function of t, so scrubbing
 * back and forth always gives the same answer.
 *
 * A boxcar mean over a trailing window has a hard edge: one bad sample entering
 * or leaving it steps the output, and on a ladder rung a step reads as the line
 * jumping. Coming out of a tack several arrive at once, and the fault gate
 * upstream makes it worse rather than better, because samples flipping between
 * accepted and rejected change the population being averaged discontinuously.
 * Measured across the archive, the rung's wind moved as much as 34 degrees
 * across a single tack that way.
 *
 * Three things fix it, and all three are needed:
 *
 *   MEDIAN, not mean, for the centre. Half the window can be nonsense without
 *     moving it, and no single wild value can drag it.
 *   MAD for the spread, so the inlier test is set by how noisy THIS window is
 *     rather than by a constant that is too tight in a shifty breeze and too
 *     loose in a steady one.
 *   A COSINE TAPER on what survives, so a sample fades in and out at the edge
 *     of the window instead of appearing and vanishing. This is what removes
 *     the step; the median alone would still tick.
 *
 * Deviations are measured from `ref` - the race TWD - and windOK has already
 * bounded them to +/-60 degrees, so unwrapping around it is unambiguous and the
 * usual circular-median branch-cut problem does not arise at all. With no ref
 * to work from this falls back to the plain vector mean.
 */
const WIND_MIN_TOL_DEG = 12;

/* Robust WITHOUT an order statistic, which is the point.
 *
 * A weighted median is robust but it is not continuous: it is whichever sample
 * the cumulative weight crosses half at, so when the readings fall into two
 * clusters and the mass shifts between them, the answer hops the whole gap in
 * one frame. That is the same disease as a hard threshold, one level up, and
 * on this data it was still worth 12-16 degrees in a single second.
 *
 * So the centre comes from iteratively reweighted least squares with a Tukey
 * biweight instead. Start at the weighted mean; measure the spread; downweight
 * by how far each reading sits from the current centre, on a curve that reaches
 * zero smoothly; repeat. Three passes is plenty. Every step is a smooth
 * function of the inputs, so the output has no jumps at all - and it still
 * ignores a cluster of nonsense, because by the third pass those readings carry
 * essentially no weight.
 *
 * Deviations are taken from `ref` (the race TWD), which windWeight has already
 * kept within +/-60 degrees, so this is ordinary linear arithmetic on a
 * circular quantity with no branch cut anywhere near the data.
 */
const WIND_IRLS_PASSES = 3;
const WIND_BIWEIGHT_K = 2.5;    // x the spread; beyond it a reading has no vote

function robustWind(dirs, spds, ages, sec, ref, wts) {
  const n = dirs.length;
  if (!n) return null;
  if (ref == null || !(sec > 0)) return meanWind(dirs, spds);

  // Each sample's base weight is its credibility times its place in the taper,
  // so it fades out BOTH as it ages past the window and as it drifts towards
  // the edge of what a wind reading can be. Neither ever steps.
  const dev = new Array(n), base = new Array(n);
  for (let i = 0; i < n; i++) {
    dev[i] = ((dirs[i] - ref) % 360 + 540) % 360 - 180;
    const taper = 0.5 * (1 + Math.cos(Math.PI * Math.min(1, Math.max(0, ages[i] / sec))));
    base[i] = taper * (wts ? wts[i] : 1);
  }

  let w = base.slice();
  let c = 0, sw = 0;
  for (let i = 0; i < n; i++) { c += w[i] * dev[i]; sw += w[i]; }
  if (!sw) return null;
  c /= sw;

  for (let pass = 0; pass < WIND_IRLS_PASSES; pass++) {
    let v = 0, tot = 0;
    for (let i = 0; i < n; i++) { v += base[i] * (dev[i] - c) * (dev[i] - c); tot += base[i]; }
    // Floored, so a window that happens to agree with itself does not shrink
    // its own tolerance to nothing and start rejecting its real motion.
    const s = Math.max(WIND_MIN_TOL_DEG / 2, Math.sqrt(tot ? v / tot : 0));
    const k = WIND_BIWEIGHT_K * s;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const u = (dev[i] - c) / k;
      const bw = Math.abs(u) < 1 ? (1 - u * u) * (1 - u * u) : 0;
      w[i] = base[i] * bw;
      num += w[i] * dev[i]; den += w[i];
    }
    if (!den) break;                 // everything rejected: keep the last centre
    c = num / den;
  }

  let ss = 0, wSpd = 0, kept = 0;
  for (let i = 0; i < n; i++) {
    if (!(w[i] > 0)) continue;
    kept++;
    if (spds[i] != null) { ss += w[i] * spds[i]; wSpd += w[i]; }
  }
  // `mass` is the total base weight the window holds: credibility times taper,
  // summed. A full second-by-second window is worth about sec/2 of it, so the
  // caller can tell one lonely sample on the far side of a data gap from a
  // properly populated half-minute — and they are worth very different amounts
  // of confidence, however clean that one sample looks.
  let mass = 0;
  for (let i = 0; i < n; i++) mass += base[i];
  return { twd: (ref + c + 360) % 360, tws: wSpd ? ss / wSpd : null,
           n: kept, mass };
}

/* Ease a live wind estimate towards the race TWD by how much the window is
 * actually worth.
 *
 * A window can be thin for two different reasons and both deserve the same
 * treatment: its readings are barely credible, or there are hardly any of them.
 * The second is not a fault at all — GER's track in race 4 has a genuine
 * 101-second hole in it, and at the far side the window holds exactly one
 * sample. Treated as a 30-second average that one reading moved the line 16.5
 * degrees in a single frame; treated as what it is, one second of evidence, it
 * barely moves it, and the estimate walks out to the live wind over the next
 * half minute as the window refills.
 *
 * A full 1 Hz window carries about sec/2 of tapered weight, so that is the
 * yardstick. Full live at LIVE_FULL of it, the race TWD alone at LIVE_NONE,
 * smoothstep between, always on the shortest arc.
 */
const WIND_LIVE_FULL = 0.75, WIND_LIVE_NONE = 0.25;

function windSettle(w, sec, ref) {
  if (!w || ref == null || w.mass == null) return w;
  const strength = w.mass / Math.max(1e-6, sec / 2);
  const toRace = windRamp(strength, WIND_LIVE_NONE, WIND_LIVE_FULL);
  if (!(toRace > 0)) return w;
  const d = ((w.twd - ref) % 360 + 540) % 360 - 180;
  return { ...w, twd: (ref + d * (1 - toRace) + 360) % 360, held: toRace > 0.5 };
}

/* The wind the laylines are drawn from, damped over LAYLINE.dampSec. */
function laylineWind(rd, t, team) {
  const sec = Math.max(1, LAYLINE.dampSec);
  const ref = rd.wind ? rd.wind.twd : null;
  if (LAYLINE.source === 'mark' && (rd.markWind || []).length) {
    const dirs = [], spds = [], ages = [];
    const wts = [];
    for (const m of rd.markWind) {
      for (let i = 0; i < (m.t || []).length; i++) {
        if (!(m.t[i] > t - sec && m.t[i] <= t)) continue;
        const k = windWeight(rd, m.twd[i], m.tws[i]);
        if (k > 0) { dirs.push(m.twd[i]); spds.push(m.tws[i]);
                     ages.push(t - m.t[i]); wts.push(k); }
      }
    }
    const w = windSettle(robustWind(dirs, spds, ages, sec, ref, wts), sec, ref);
    if (w) return { ...w, from: `${rd.markWind.length} marks` };
  }
  const tr = team && rd.tracks[team];
  if (tr) {
    const dirs = [], spds = [], ages = [], wts = [];
    for (let i = 0; i < tr.n; i++) {
      if (!(tr.t[i] > t - sec && tr.t[i] <= t)) continue;
      const k = windWeight(rd, tr.raw.twd[i], tr.raw.tws[i]);
      if (k > 0) { dirs.push(tr.raw.twd[i]); spds.push(tr.raw.tws[i]);
                   ages.push(t - tr.t[i]); wts.push(k); }
    }
    const w = windSettle(robustWind(dirs, spds, ages, sec, ref, wts), sec, ref);
    if (w) return { ...w, from: team };
  }
  // Guarded the same way the top of this function guards it. Reaching here
  // with no race wind at all threw inside draw(), which swallows it — the map
  // freezes on the last good frame and only the console says why.
  return !rd.wind || rd.wind.twd == null ? null
       : { twd: rd.wind.twd, tws: rd.wind.tws, n: 0, from: 'race average' };
}

/* What to draw laylines to: the windward gate and the leeward gate.
 *
 * There was a menu here — next mark, next two marks, every mark — built off the
 * `Leg` column. In use it turned out that the only two you ever want are the
 * two you are laying, and everything else was lines on the map. So the menu is
 * gone and the rule is the one rule.
 *
 * Which gate is which is decided by projecting each onto the wind axis, not by
 * its position in the course list or its height on screen, so it holds whatever
 * shape the course is and whichever way it is oriented, and swaps by itself
 * when the wind does. A course with no gates at all falls back to every mark,
 * because a layline to nothing is worse than a layline to too much.
 */
/* Every target carries the bearing you APPROACH it on, and that — not where the
 * boat happens to be — is what decides whether its layline is a beat or a run.
 *
 * The two are not the same thing, and the difference shows. A leeward gate is
 * approached downwind, always: it gets downwind target angles and its laylines
 * run UPWIND of it, because upwind is where you come from. But test the mode by
 * the bearing from the boat to the mark and a boat that happens to be below the
 * leeward gate is looking upwind at it, gets beat angles, and the laylines are
 * drawn on the wrong side of the mark entirely.
 *
 * The approach bearing is a property of the course: it is the direction of the
 * leg into that mark, from the element before it in sailing order. That holds
 * wherever the boat is, and it holds while the boat is still three legs away.
 */
function laylineTargets(rd, twd, boat) {
  const els = (rd.course && rd.course.elements) || [];
  const mid = el => el.p2
    ? { rx: (el.p1.rx + el.p2.rx) / 2, ry: (el.p1.ry + el.p2.ry) / 2 } : el.p1;
  // The leg into element i, as a compass bearing.
  const approachTo = i => {
    const prev = els[i - 1], here = els[i];
    if (!prev || !here) return null;
    const a = mid(prev), b = mid(here);
    return rd.frame.bearingFromRot(b.rx - a.rx, b.ry - a.ry);
  };

  /* Which gates are LIVE — the ones this boat is about to round.
   *
   * A SailGP course carries three gates and rounds them in a set order, so
   * "the top gate" and "the bottom gate" are not fixed pieces of water: the
   * bottom gate on lap one is a different mark pair from the bottom gate on
   * lap two, and both exist on the map at the same time. Picking them by
   * projecting every gate onto the wind axis gave one answer for the whole
   * race, and on the leg after M1 it drew the leeward laylines to the OTHER
   * leeward gate — the one used a lap later, half the course away — while the
   * route beside it ran correctly to the gate actually being sailed to.
   *
   * The leg number says which element is next, exactly as the route uses it.
   * So take the next two gates in course order from there: on a windward-
   * leeward course that is one leeward and one windward, and they roll forward
   * by themselves at every rounding. Each carries the bearing of the leg INTO
   * it, which is what decides beat-or-run downstream, and is named by that
   * rather than by where it sits on the screen.
   */
  const leg = boat && boat.leg != null ? Math.round(boat.leg) : 1;
  const at = i => {
    const ap = approachTo(i);
    let up = true;
    if (ap != null && twd != null) {
      let o = Math.abs(((twd - ap) % 360 + 360) % 360);
      if (o > 180) o = 360 - o;
      up = o < 90;
    }
    // `el` rides along because a layline only needs the middle of a gate but
    // anything asking which MARK to round needs both of them.
    return { p: mid(els[i]), el: els[i], i, type: els[i].type,
             name: up ? 'TOP' : 'BOTTOM',
             ap: ap != null ? ap : (up ? twd : (twd + 180) % 360) };
  };
  const live = [];
  for (let i = Math.max(1, leg); i < els.length && live.length < 2; i++)
    if (els[i].type === 'Gate') live.push(at(i));
  // Past the last gate there is nothing left to call a top or a bottom, and
  // falling through to the wind axis there would draw laylines to a gate you
  // rounded a lap ago. The last leg gets the mark it is actually sailing to
  // instead — still the live one, still by the leg.
  if (!live.length)
    for (let i = Math.max(1, leg); i < els.length && !live.length; i++)
      if (els[i].type !== 'StartLine') live.push(at(i));
  if (live.length) return live;

  // No leg to read, or no gates left ahead — fall back to the wind axis, which
  // is all a course with no order to it can offer.
  if (twd != null) {
    const gates = els.filter(e => e.type === 'Gate');
    if (gates.length) {
      // Unit vector pointing INTO the wind, in the rotated frame.
      const u = rd.frame.r(Math.sin(twd * D2R), Math.cos(twd * D2R));
      const proj = g => { const p = mid(g); return p.rx * u.rx + p.ry * u.ry; };
      let top = gates[0], bot = gates[0];
      for (const g of gates) {
        if (proj(g) > proj(top)) top = g;
        if (proj(g) < proj(bot)) bot = g;
      }
      // No element order to lean on here, so the wind gives it: the windward
      // gate is reached sailing towards the wind, the leeward one away from it.
      const out = [{ p: mid(top), el: top, type: 'Gate', name: 'TOP', ap: twd }];
      if (bot !== top)
        out.push({ p: mid(bot), el: bot, type: 'Gate', name: 'BOTTOM',
                   ap: (twd + 180) % 360 });
      return out;
    }
  }

  const out = [];
  for (let i = 0; i < els.length; i++) {
    if (els[i].type === 'StartLine') continue;
    out.push({ p: mid(els[i]), el: els[i], i, type: els[i].type, ap: approachTo(i) });
  }
  if (!out.length && rd.frame.m1R) out.push({ p: rd.frame.m1R, type: 'Mark' });
  return out;
}

/* How long a layline is: long enough to leave the course, always.
 *
 * It used to be scaled off the boat's distance to the mark, which meant that
 * the closer you got the shorter it drew — exactly backwards, since a layline
 * is a line you want to see coming from a long way out, and it would stop short
 * of the boundary just as you were using it to decide when to tack.
 *
 * A mark sits inside the boundary, so no point on that boundary can be further
 * from it than the polygon's own extent. Take the diagonal of the boundary's
 * bounding box and add a margin and the layline provably crosses out of the
 * course whatever the mark and whatever the bearing — no ray casting, no case
 * where it happens to fall short. Computed once per race.
 */
const LAYLINE_MARGIN = 1.2;
const LAYLINE_MIN_M = 900;

function laylineLength(rd) {
  if (rd._layLen != null) return rd._layLen;
  const xs = [], ys = [];
  for (const [name, pts] of Object.entries((rd.frame && rd.frame.limits) || {})) {
    if (name.replace(/ \d+$/, '') !== 'Boundary') continue;
    for (const p of pts) { xs.push(p.rx); ys.push(p.ry); }
  }
  // No boundary in this bundle — fall back to the course itself, which is the
  // next best statement of how big the water is.
  if (xs.length < 2) {
    for (const el of ((rd.course && rd.course.elements) || []))
      for (const p of [el.p1, el.p2]) if (p) { xs.push(p.rx); ys.push(p.ry); }
    if (rd.frame.m1R) { xs.push(rd.frame.m1R.rx); ys.push(rd.frame.m1R.ry); }
  }
  let d = 0;
  if (xs.length > 1)
    d = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return (rd._layLen = Math.max(LAYLINE_MIN_M, d * LAYLINE_MARGIN));
}

const LAYLINE_LABEL_M = 420;

/* Where a layline stops: the boundary.
 *
 * It used to run past it deliberately — a line you want to see coming from a
 * long way out, so it was drawn to the bbox diagonal and allowed to leave the
 * course. With one line per gate that was fine. With one per MARK it is four
 * lines a gate and eight on the map, and eight lines crossing the whole
 * racetrack is a cat's cradle rather than a picture.
 *
 * The boundary is also the honest place to stop. Beyond it is water you may not
 * sail in, so the part of a layline outside the course is not a line you could
 * ever be on — it is decoration. Cast the ray at the boundary and cut it at the
 * first crossing.
 */
const LAYLINE_NO_BND_M = 700;      // no boundary in the bundle: a modest stub

function laylineReach(rd, p, d, cap) {
  let best = null;
  if (typeof boundarySegs === 'function' && typeof rayHitSeg === 'function') {
    for (const [a, b] of boundarySegs(rd)) {
      const h = rayHitSeg(p, d, a, b);
      if (h != null && (best == null || h < best)) best = h;
    }
  }
  return best != null ? Math.min(best, cap) : Math.min(cap, LAYLINE_NO_BND_M);
}

/* The laylines as geometry, so they can be checked without a canvas.
 *
 * One pair per MARK, not per gate. A gate is two marks and you round one of
 * them; the layline to the middle of a gate is a line to a place there is
 * nothing to round, up to half a gate away from either mark — and at 210 m
 * wide that is a hundred metres of error in exactly the decision the line
 * exists to serve. Each mark now gets its own port and starboard layline, and
 * because they are cut at the boundary the extra lines cost far less ink than
 * the two long ones did.
 */
function laylineRays(rd, t, focus, w) {
  const out = [];
  if (!w || w.twd == null) return out;
  const boat = focus && rd.tracks[focus] ? sampleAt(rd.tracks[focus], t) : null;
  const cap = laylineLength(rd);

  for (const g of laylineTargets(rd, w.twd, boat)) {
    // Beat or run? The bearing of the LEG INTO this mark decides it — where the
    // boat currently is has nothing to do with which way the mark is rounded.
    // Only where the course gives no approach (no order to read it from) does
    // the boat's own bearing stand in.
    const brg = g.ap != null ? g.ap
              : rd.frame.bearingFromRot(g.p.rx - (boat ? boat.rx : 0),
                                        g.p.ry - (boat ? boat.ry : 0));
    let off = Math.abs(((w.twd - brg) % 360 + 360) % 360);
    if (off > 180) off = 360 - off;
    const up = off < 90;

    // The angle has to match THIS mark's mode, not the boat's.
    //
    // targTwa is a single number describing whatever the boat is doing at this
    // instant, so taking it as the target for every mark is wrong the moment
    // the two disagree: running down the course it would hand 145 degrees to
    // the windward gate as well, which puts that gate's laylines on the upwind
    // side of it — above the mark, where you never approach from.
    //
    // boatTargets builds both curves out of the same channel across the whole
    // race, keyed to wind speed, so each mark can be given the angle for the
    // leg that actually reaches it. The polar stands in where the harvest
    // carried no targets, and the boat's own reading only where it happens to
    // be in the right mode.
    const ang = typeof nextLegAngles === 'function'
      ? nextLegAngles(rd, w.tws, boat, focus) : null;
    const tgt = polarTarget(rd.polar, w.tws, up);
    const logged = boat && boat.targTwa != null ? Math.abs(boat.targTwa) : null;
    // The angles out of nextLegAngles are already trimmed — it is the one place
    // both the route and these lines read them from. Only the fallbacks, which
    // never went through it, are trimmed here, so the trim is never applied
    // twice to the same number.
    let twa = ang ? (up ? ang.up : ang.dn) : null;
    if (twa == null) {
      const raw = (tgt && tgt.twa)
               ?? (logged != null && (up === (logged < 90)) ? logged : null);
      twa = raw == null ? null : trimTwa(raw, up);
    }
    if (twa == null) continue;

    /* One pair of laylines, or two.
     *
     * MARKS draws them back from each gate mark, which is the honest geometry:
     * the layline you have to make is the layline to the mark you are actually
     * going to round, and the two are a gate-width apart. It is also four lines
     * per gate, and on a lap with two live gates that is eight lines across the
     * course.
     *
     * GATE draws one pair from the middle of the gate, which is the picture you
     * want when the choice of mark is still open — you are laying "the gate"
     * and will decide the end later. Half the ink for the same decision, at the
     * cost of being up to a gate-width wrong once you have committed. */
    const marks = LAYLINE.target === 'gate' ? [g.p]
                : g.el && g.el.p1 && g.el.p2 ? [g.el.p1, g.el.p2] : [g.p];
    for (const tack of [+1, -1]) {
      // Heading on this tack, then the ray BACK from the mark along it.
      const head = w.twd - tack * twa;
      const back = (head + 180) % 360;
      const d = rd.frame.r(Math.sin(back * D2R), Math.cos(back * D2R));
      const pair = marks.map(m => ({ from: m, d, len: laylineReach(rd, m, d, cap),
                                     tack, twa, name: g.name, gate: g }));
      // The two marks' laylines on one tack are parallel, so one caption serves
      // both — put it on whichever has more line under it to carry it.
      let lead = pair[0];
      for (const r of pair) if (r.len > lead.len) lead = r;
      lead.label = true;
      out.push(...pair);
    }
  }
  return out;
}

function drawCourseLaylines(ctx, rd, t, tX, tY, W, H, focus) {
  if (!LAYLINE.on) return;
  const w = laylineWind(rd, t, focus);
  if (!w) return;
  const rays = laylineRays(rd, t, focus, w);
  if (!rays.length) return;

  ctx.save();
  ctx.lineWidth = 1.6;
  ctx.setLineDash([]);   // solid: the map already had too many dotted lines
  ctx.font = '700 10px "Share Tech Mono", monospace';

  for (const r of rays) {
    const ex = r.from.rx + r.d.rx * r.len, ey = r.from.ry + r.d.ry * r.len;
    ctx.strokeStyle = r.tack > 0 ? TACK_STBD : TACK_PORT;
    ctx.globalAlpha = 0.85;
    ctx.setLineDash([]);   // solid: the map already had too many dotted lines
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(tX(r.from.rx, r.from.ry), tY(r.from.rx, r.from.ry));
    ctx.lineTo(tX(ex, ey), tY(ex, ey));
    ctx.stroke();

    if (!r.label) continue;
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    /* Just PAST the end of the line, which is to say outside the boundary.
     *
     * These used to sit half way along the ray, inside the racecourse, where
     * eight of them landed among the boats, the marks, the route and the wave —
     * the busiest water on the map. The ray is already cut at the boundary, so
     * running on a little from its end puts the caption in the empty water
     * outside the course, next to the line it belongs to and on top of nothing.
     *
     * The step is in PIXELS rather than metres so it stays the same visual gap
     * at every zoom, and the text is aligned away from the line so it reads
     * outward instead of doubling back over it. */
    const sx = tX(r.from.rx, r.from.ry), sy = tY(r.from.rx, r.from.ry);
    const exs = tX(ex, ey), eys = tY(ex, ey);
    const dx = exs - sx, dy = eys - sy;
    const L = Math.hypot(dx, dy) || 1;
    const OUT_PX = 15;
    const lx = exs + dx / L * OUT_PX, ly = eys + dy / L * OUT_PX;
    ctx.textAlign = dx >= 0 ? 'left' : 'right';
    ctx.textBaseline = dy >= 0 ? 'top' : 'bottom';
    // The angle shown is the one actually drawn. When it has been trimmed the
    // trim is shown beside it, so the number on the map is never a claim about
    // the boat's targets that the boat's targets do not make.
    const k = LAYLINE.trim || 0;
    const txt = `${r.name ? r.name + ' ' : ''}${r.tack > 0 ? 'S' : 'P'} `
              + `${r.twa.toFixed(0)}°${k ? (k > 0 ? ` +${k}` : ` ${k}`) : ''}`;
    ctx.lineWidth = 3; ctx.strokeStyle = MAP_INK.halo;
    ctx.strokeText(txt, lx, ly);
    ctx.fillStyle = r.tack > 0 ? TACK_STBD : TACK_PORT;
    ctx.fillText(txt, lx, ly);
  }
  ctx.restore();
  rd._laylineWind = w;
}

function drawStartLine(ctx, rd, tX, tY, mpp, opts) {
  const f = rd.frame;
  const wx = tX(f.windR.rx, f.windR.ry), wy = tY(f.windR.rx, f.windR.ry);
  const lx = tX(f.leeR.rx, f.leeR.ry),  ly = tY(f.leeR.rx, f.leeR.ry);

  ctx.save();
  // the extensions, dashed — this is the plane the port entry is measured against
  const ex = (wx - lx), ey = (wy - ly);
  const n = Math.hypot(ex, ey) || 1;
  const ux = ex / n, uy = ey / n;
  ctx.strokeStyle = 'rgba(120,190,255,0.22)';
  ctx.setLineDash([5, 6]); ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(lx - ux * 4000, ly - uy * 4000);
  ctx.lineTo(wx + ux * 4000, wy + uy * 4000);
  ctx.stroke();
  ctx.setLineDash([]);

  // the line itself
  ctx.strokeStyle = '#7fc8ff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(wx, wy); ctx.stroke();

  // Mark dots, plus the TWA from that end to M1. The WINDWARD / LEEWARD text
  // came off on 21 Aug — the windward end is the top of the frame by
  // construction, so it restated the layout. The angle to the mark does not:
  // it is the difference between the two ends that the layout cannot show.
  const e = rd.endToM1;
  for (const [x, y, col, info] of [
    [wx, wy, '#00ccff', e && e.windward],
    [lx, ly, '#ffcc00', e && e.leeward],
  ]) {
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = MAP_INK.buoyEdge; ctx.lineWidth = 1.5; ctx.stroke();
    // The leg label carries this same angle live, off whichever wind source is
    // selected, so showing the race-average one beside it would be two numbers
    // for one quantity that are allowed to disagree.
    if (!info || opts.endLegs) continue;
    const lbl = `M1 ${Math.abs(info.twa).toFixed(0)}°`;
    ctx.font = '700 9px Orbitron, monospace';
    const tw = ctx.measureText(lbl).width;
    ctx.fillStyle = MAP_INK.chip;
    ctx.beginPath(); ctx.roundRect(x + 8, y - 7, tw + 9, 14, 3); ctx.fill();
    ctx.fillStyle = col;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(lbl, x + 12.5, y);
  }

  // line length, on a chip so it stays readable over the grid, a boundary or
  // an off-screen mark pointer
  const lblX = (wx + lx) / 2 - 28, lblY = (wy + ly) / 2;
  const lbl = rd.raw.line.lengthM.toFixed(0) + ' m';
  ctx.font = '9px "Share Tech Mono", monospace';
  const tw = ctx.measureText(lbl).width;
  ctx.fillStyle = MAP_INK.chip;
  ctx.beginPath(); ctx.roundRect(lblX - tw / 2 - 4, lblY - 7, tw + 8, 14, 3); ctx.fill();
  ctx.fillStyle = MAP_INK.faint;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(lbl, lblX, lblY);
  ctx.restore();
}

function drawM1(ctx, f, tX, tY, mpp, W, H) {
  let x = tX(f.m1R.rx, f.m1R.ry), y = tY(f.m1R.rx, f.m1R.ry);

  // M1 is 500 m+ from a 200 m line, so in any frame tight enough to read the
  // start it is off-canvas. Pin it to the edge with its distance rather than
  // letting the leg direction vanish.
  if (x < 12 || x > W - 12 || y < 12 || y > H - 12) {
    const cx = W / 2, cy = H / 2;
    let dx = x - cx, dy = y - cy;
    const m = Math.max(Math.abs(dx) / (W / 2 - 20), Math.abs(dy) / (H / 2 - 20)) || 1;
    const ex = cx + dx / m, ey = cy + dy / m;
    const a = Math.atan2(dy, dx);
    const midR = { rx: (f.windR.rx + f.leeR.rx) / 2, ry: (f.windR.ry + f.leeR.ry) / 2 };
    const distM = Math.hypot(f.m1R.rx - midR.rx, f.m1R.ry - midR.ry);
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.translate(ex, ey); ctx.rotate(a);
    ctx.fillStyle = '#ff8c42';
    ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-6, 5.5); ctx.lineTo(-6, -5.5);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = 0.9;
    const right = dx > 0;
    const lx = ex - Math.sign(dx || 1) * 14;
    const txt = distM.toFixed(0) + ' m';
    ctx.font = '700 9px Orbitron, monospace';
    const w1 = ctx.measureText('M1').width;
    ctx.font = '9px "Share Tech Mono", monospace';
    const w2 = ctx.measureText(txt).width;
    // chip behind the label — it lands on the line-length badge often enough
    const bw2 = Math.max(w1, w2) + 8;
    ctx.fillStyle = MAP_INK.chip;
    ctx.beginPath();
    ctx.roundRect(right ? lx - bw2 : lx - 4, ey - 17, bw2, 26, 3);
    ctx.fill();
    ctx.fillStyle = '#ff8c42';
    ctx.font = '700 9px Orbitron, monospace';
    ctx.textAlign = right ? 'right' : 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('M1', lx, ey - 9);
    ctx.font = '9px "Share Tech Mono", monospace';
    ctx.fillStyle = 'rgba(255,140,66,0.8)';
    ctx.fillText(txt, lx, ey + 3);
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.fillStyle = '#ff8c42';
  ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = MAP_INK.buoyEdge; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = '#ff8c42'; ctx.font = '700 9px Orbitron, monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('M1', x + 9, y);
  ctx.restore();
}

/* An F50 to scale: two hulls and a crossbeam. Below ~7 px it becomes a dot,
 * because a 3-pixel catamaran is just noise. */
/* The map's own palette, and the one thing everything else is derived from.
 *
 * Every ink on this map was picked to sit on near-black water: the labels are
 * pale, the haloes behind them are near-black, the grid is a faint blue lift.
 * Put white water underneath and all three invert in meaning — a pale label on
 * a pale sea with a black halo reads as a smear.
 *
 * So the background is not just a colour, it is the switch. Set it and the
 * luminance decides: `light` flips the halo from near-black to near-white, the
 * grid from a lift to a shade, and the hull rule from raising dark team colours
 * to holding bright ones down. One derived value, one place to set it, and no
 * second palette to keep in step.
 */
const MAP_INK = {
  bg: '#050506',      // the water
  label: 1.25,        // team labels
  fleet: 0.85,        // alpha for boats that are not the focus
  light: false,       // derived from bg — see setMapBg
  halo: 'rgba(4,10,18,0.85)',
  grid: 'rgba(90,130,180,0.09)',
};

MAP_INK.rose = '#7dd3fc';
MAP_INK.faint = 'rgba(190,215,240,0.8)';
MAP_INK.cap = 'rgba(215,228,242,0.9)';
// the rest are filled in by themeInk(), called once below as well as on every
// change of water, so nothing can draw before they exist

/* Relative luminance of a #rrggbb, on the usual perceptual weights. */
function inkLuma(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  if (!isFinite(n)) return 0;
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

/* The pale inks — the compass rose, the scale bar, the small captions — were
 * picked to glow on near-black. On paper they are barely there, so each has a
 * darker twin and this picks between them. Cached on MAP_INK rather than
 * branched at every call, because these are drawn in loops. */
/* A shade of the water, for regions that need to read as a hole in it.
 *
 * The wave's fill was a hard '#000000'. On near-black water that IS a shade of
 * the water, so it looked deliberate; on paper it was a black slab covering the
 * boats, the boundary and every label that fell inside it — the pre-start zone
 * became the one place you could not see the pre-start. Deriving it from the
 * selected water keeps the hue and keeps the region legible: dark water is
 * halved, which leaves near-black near-black and gives steel a deeper slate,
 * while light water is only eased down, because a light map needs a shade
 * rather than a hole. */
function shadeOfWater(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  if (!isFinite(n)) return '#000000';
  const f = inkLuma(hex) > 0.5 ? 0.88 : 0.5;
  const ch = s => Math.round(((n >> s) & 255) * f);
  return '#' + ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
}

function themeInk() {
  MAP_INK.waveFill = shadeOfWater(MAP_INK.bg);
  MAP_INK.rose  = MAP_INK.light ? '#0b6f96' : '#7dd3fc';
  MAP_INK.faint = MAP_INK.light ? 'rgba(30,55,80,0.75)' : 'rgba(190,215,240,0.8)';
  MAP_INK.cap   = MAP_INK.light ? 'rgba(24,40,58,0.9)'  : 'rgba(215,228,242,0.9)';
  // The rest of the pale inks. These were literals scattered through the boat
  // and course passes, so on paper the focus boat's own name and speed were
  // near-white text with a near-white halo behind it — invisible, in the one
  // theme the whole point of which is to be readable.
  MAP_INK.boat      = MAP_INK.light ? '#10243a' : '#e8f0fa';
  MAP_INK.boatDim   = MAP_INK.light ? '#4a627c' : '#9fb0c4';
  MAP_INK.boatSog   = MAP_INK.light ? '#1d3a56' : '#cfe2f5';
  MAP_INK.course    = MAP_INK.light ? '#3c5b78' : '#9fb8d0';
  MAP_INK.finish    = MAP_INK.light ? '#132c46' : '#e8f0f8';
  MAP_INK.scale     = MAP_INK.light ? 'rgba(30,55,85,0.7)' : 'rgba(200,220,240,0.6)';
  MAP_INK.scaleTxt  = MAP_INK.light ? 'rgba(30,55,85,0.85)' : 'rgba(200,220,240,0.75)';
  // The little plates the captions sit on — the compass rose, the mode chip,
  // the wave legends. Dark ink on a dark plate is fine on dark water and a
  // hole in the page on light.
  MAP_INK.plate     = MAP_INK.light ? 'rgba(255,255,255,0.82)' : 'rgba(8,16,28,0.8)';
  // The small chips that hang off marks and the line, and the ring drawn round
  // a buoy to lift it off the water. Both were fixed dark, so on light water
  // the chips were black tabs and the rings were black outlines — the last two
  // places the light theme had not reached.
  MAP_INK.chip      = MAP_INK.light ? 'rgba(255,255,255,0.86)' : 'rgba(7,13,21,0.85)';
  MAP_INK.buoyEdge  = MAP_INK.light ? '#e8eff6' : '#08111c';
  // The captions that sit on a plate at the foot of the map. Their inks were
  // picked to glow on black; on a white plate a 95%-alpha pink is barely ink
  // at all. Each gets a darker twin at the same hue so the legend still reads
  // as the thing it labels.
  MAP_INK.waveTxt   = MAP_INK.light ? '#b02a3c' : 'rgba(255,150,160,0.95)';
  MAP_INK.waveRTxt  = MAP_INK.light ? '#9a6206' : 'rgba(255,205,130,0.9)';
  MAP_INK.fastTxt   = MAP_INK.light ? '#5b3bbf' : 'rgba(167,139,250,0.95)';
  MAP_INK.fastDim   = MAP_INK.light ? 'rgba(91,59,191,0.55)' : 'rgba(167,139,250,0.5)';
  MAP_INK.plateEdge = MAP_INK.light ? 'rgba(60,100,150,0.35)' : 'rgba(64,128,196,0.35)';
}

themeInk();

function setMapBg(hex) {
  MAP_INK.bg = hex;
  MAP_INK.light = inkLuma(hex) > 0.5;
  MAP_INK.halo = MAP_INK.light ? 'rgba(252,253,255,0.88)' : 'rgba(4,10,18,0.85)';
  MAP_INK.grid = MAP_INK.light ? 'rgba(40,70,110,0.13)' : 'rgba(90,130,180,0.09)';
  themeInk();
  HULL_INK.clear();   // the hull rule changes with the water
}

/* Below this many pixels of hull, a locator ring is drawn around the boat. */
const LOCATOR_PX = 13;

/* Read through MAP_INK so they follow the water. Kept as accessors rather than
 * constants because the theme can change at any moment and these are captured
 * inside draw passes. */
const COURSE_INK_ = () => MAP_INK.course || '#9fb8d0';
const FINISH_INK_ = () => MAP_INK.finish || '#e8f0f8';

/* The zone around a mark you are not allowed inside.
 *
 * Every buoy on the course carries one, so it goes in a pass of its own BEFORE
 * anything else is drawn: the marks themselves are drawn with skips and special
 * cases — M1 is owned by drawM1, a gate is two buoys and a line, the finish is
 * neither — and hanging the zone off each of those would inherit every one of
 * those exceptions. A separate pass means every mark gets a zone by the same
 * rule, and the buoys and labels land on top of it rather than under it.
 *
 * The radius is in metres, converted through the same transform as everything
 * else — the screen length of a one-metre step — so it scales with the map
 * instead of being a fixed number of pixels that means a different distance at
 * every zoom. Taken as a length, not as an x-difference: under a rotated view
 * an x-difference is the metre's horizontal component, which shrinks to zero
 * with the map turned ninety degrees.
 */
const MARK_ZONE = { m: 50 };

function drawMarkZones(ctx, rd, tX, tY) {
  if (!(MARK_ZONE.m > 0)) return;
  const f = rd.frame;
  const pts = [];
  const add = p => {
    if (!p) return;
    if (pts.some(q => Math.hypot(q.rx - p.rx, q.ry - p.ry) < 5)) return;
    pts.push(p);
  };
  for (const el of ((rd.course && rd.course.elements) || [])) {
    if (el.type === 'StartLine') continue;      // the line has its own geometry
    add(el.p1);
    add(el.p2);
  }
  add(f.m1R);                                    // in case the course is absent
  if (!pts.length) return;

  const r = MARK_ZONE.m * Math.hypot(tX(1, 0) - tX(0, 0), tY(1, 0) - tY(0, 0));
  if (!(r > 0.5)) return;                        // zoomed out past meaning
  ctx.save();
  ctx.fillStyle = 'rgba(226,54,54,0.13)';
  ctx.strokeStyle = 'rgba(255,96,96,0.30)';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(tX(p.rx, p.ry), tY(p.rx, p.ry), r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawCourse(ctx, rd, tX, tY) {
  drawMarkZones(ctx, rd, tX, tY);
  const c = rd.course;
  if (!c || !c.elements || !c.elements.length) return;
  const f = rd.frame;
  ctx.save();
  ctx.lineCap = 'round';

  const buoy = (p, r, col) => {
    ctx.beginPath();
    ctx.arc(tX(p.rx, p.ry), tY(p.rx, p.ry), r, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1; ctx.stroke();
  };
  const label = (p, txt, col) => {
    ctx.font = `700 ${Math.round(10 * MAP_INK.label)}px "Share Tech Mono", monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const x = tX(p.rx, p.ry), y = tY(p.rx, p.ry) - 13;
    ctx.lineWidth = 3; ctx.strokeStyle = MAP_INK.halo;
    ctx.strokeText(txt, x, y);
    ctx.fillStyle = col; ctx.fillText(txt, x, y);
  };

  let mark = 0, gate = 0;
  for (const el of c.elements) {
    if (el.type === 'StartLine') continue;          // drawStartLine owns that one
    if (!el.p2) {
      mark++;
      // M1 is already on screen with its bearing and range; drawing a second
      // buoy on top of it just thickens the marker and doubles the label.
      if (f.m1R && Math.hypot(el.p1.rx - f.m1R.rx, el.p1.ry - f.m1R.ry) < 15) continue;
      buoy(el.p1, 5, COURSE_INK_());
      label(el.p1, 'M' + mark, COURSE_INK_());
      continue;
    }
    const fin = el.type === 'FinishLine';
    const col = fin ? FINISH_INK_() : COURSE_INK_();
    // The finish keeps its line — it is a line you cross. A gate is two marks
    // you round one of, and the dashes between them drew a barrier that is not
    // there, straight through the water boats sail down.
    if (fin) {
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(tX(el.p1.rx, el.p1.ry), tY(el.p1.rx, el.p1.ry));
      ctx.lineTo(tX(el.p2.rx, el.p2.ry), tY(el.p2.rx, el.p2.ry));
      ctx.stroke();
    }
    buoy(el.p1, 4, col);
    buoy(el.p2, 4, col);
    const mid = { rx: (el.p1.rx + el.p2.rx) / 2, ry: (el.p1.ry + el.p2.ry) / 2 };
    if (fin) label(mid, 'FINISH', col);
    else { gate++; label(mid, 'G' + gate, col); }
  }
  ctx.restore();
}

function drawHull(ctx, x, y, headingScreenDeg, col, mpp, focus) {
  // TRUE SCALE, and not a setting. An F50 is 15.0 m long and 8.8 m wide and
  // that is exactly what is drawn, so two boats a length apart are a length
  // apart on screen and a hull overlapping the line has its bow over the line.
  // There was an exaggeration multiplier here; it is gone, because a map you
  // can read a distance off is worth more than a boat you can see from further
  // out, and one setting quietly making every distance on screen a lie is not
  // a trade worth offering.
  //
  // Zoomed out far enough, 15 m really is a few pixels. Rather than inflating
  // the boat to keep it visible, the hull stays true and a locator ring is
  // drawn around it. The ring is obviously not the boat.
  const L = F50_LOA / mpp;
  const B = F50_BEAM / mpp;
  if (L < LOCATOR_PX) {
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = col;
    ctx.lineWidth = focus ? 1.6 : 1.1;
    ctx.beginPath();
    ctx.arc(x, y, focus ? 9 : 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(headingScreenDeg * Math.PI / 180);

  if (L < 7) {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(0, 0, focus ? 3.4 : 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    return;
  }

  /* The F50 in plan, rather than two lozenges and a bar.
   *
   * Everything below is a fraction of the true LOA and beam, so the shape
   * scales with the boat and never with the zoom: fine bows, two crossbeams
   * rather than one, the wing on the centreline, and the foil and rudder tips
   * splayed outboard — which is what makes an F50 read as an F50 at a glance
   * and, more usefully, what makes its heading readable when the boat is only
   * twenty pixels long.
   *
   * Drawn bow-first up the negative y axis, the context already rotated. */
  const hw = Math.max(1, L * 0.058);        // hull half-width
  const cx = Math.max(0, B / 2 - hw);       // hull centreline, off the middle
  const fine = L > 22;                      // enough pixels to be worth detail

  const hullPath = side => {
    const c = side * cx;
    ctx.beginPath();
    ctx.moveTo(c, -L / 2);                                  // bow
    ctx.quadraticCurveTo(c + hw, -L * 0.22, c + hw, L * 0.18);
    ctx.lineTo(c + hw * 0.82, L * 0.46);                    // quarter
    ctx.lineTo(c - hw * 0.82, L * 0.46);                    // transom
    ctx.lineTo(c - hw, L * 0.18);
    ctx.quadraticCurveTo(c - hw, -L * 0.22, c, -L / 2);
    ctx.closePath();
  };

  // The focus boat carries a halo of its own colour. It is the cheapest way to
  // make one hull stand out of thirteen without changing its colour, growing
  // it off true scale, or ringing it in a colour that means something else.
  if (focus) {
    ctx.save();
    ctx.shadowColor = col;
    ctx.shadowBlur = Math.max(7, L * 0.45);
    ctx.fillStyle = col;
    for (const side of [-1, 1]) { hullPath(side); ctx.fill(); }
    ctx.restore();
  }

  // Appendages under the hulls, so the hulls sit over their roots.
  if (fine) {
    ctx.strokeStyle = col;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, L * (focus ? 0.045 : 0.034));
    ctx.globalAlpha = focus ? 0.95 : 0.75;
    for (const side of [-1, 1]) {
      const c = side * cx;
      ctx.beginPath();                                       // daggerboard
      ctx.moveTo(c, -L * 0.04);
      ctx.lineTo(c + side * B * 0.34, L * 0.10);
      ctx.stroke();
      ctx.beginPath();                                       // rudder
      ctx.moveTo(c, L * 0.40);
      ctx.lineTo(c + side * B * 0.24, L * 0.52);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  ctx.fillStyle = col;
  ctx.strokeStyle = focus ? '#ffffff' : 'rgba(255,255,255,0.25)';
  ctx.lineWidth = focus ? 1.7 : 0.7;
  for (const side of [-1, 1]) { hullPath(side); ctx.fill(); ctx.stroke(); }

  // Two crossbeams. One bar reads as a raft; the pair is the platform, and the
  // gap between them is where the wing steps.
  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(1, L * (focus ? 0.06 : 0.05));
  for (const by of fine ? [-L * 0.10, L * 0.24] : [L * 0.05]) {
    ctx.beginPath(); ctx.moveTo(-cx, by); ctx.lineTo(cx, by); ctx.stroke();
  }

  // The wing, on the centreline and brighter than the platform.
  ctx.strokeStyle = focus ? '#ffffff' : 'rgba(220,235,255,0.45)';
  ctx.lineWidth = Math.max(1, L * (focus ? 0.055 : 0.045));
  ctx.beginPath(); ctx.moveTo(0, L * 0.20); ctx.lineTo(0, -L * 0.30); ctx.stroke();
  ctx.restore();
}

function drawBoat(ctx, rd, team, t, tX, tY, mpp, W, H, opts, focus) {
  const tr = rd.tracks[team];
  const s = sampleAt(tr, t);
  if (!s) return null;

  const isExcluded = rd.excluded.has(team);
  const isOCS = rd.ocs && rd.ocs.has(team);
  const col = boatColour(rd, team);
  const podium = !isOCS && rd.reachPos && PODIUM[rd.reachPos.get(team)];
  // focus and podium boats both earn full weight; the rest of the fleet is
  // context, not subject
  const alpha = isExcluded ? (focus ? 0.55 : 0.2)
              : (focus || isOCS || podium) ? 1 : MAP_INK.fleet;
  // Same tail length for every boat on every map. Non-focus boats used to get
  // 60 % of it, to keep the fleet from cluttering the frame around ITA — but
  // once boats were coloured by finishing position that worked against the
  // picture, since the podium boats are the ones you most want to trace.
  const trailSec = opts.trailSec ?? TRAIL_SEC;
  const TRAIL_MAX_STEPS = 400;      // points per trail, whatever the span
  const rotDeg = rd.frame.rot * 180 / Math.PI + viewRotDeg();

  /* trail
   *
   * Clamped to where samples actually are, and stepped in proportion to the
   * span asked for. At "everything" — 999 s — a fixed half-second step ran two
   * thousand binary searches per boat per frame, almost all of them off the
   * front of the track and returning null, and the fade was meaningless too
   * because every visible point had an age near zero. */
  ctx.save();
  ctx.lineCap = 'round';
  /* The trail keeps the TEAM colour even when the hulls are coloured by ratio.
   * Before the gun a fleet holding 1.00 is a fleet of identical green hulls,
   * and identical green trails behind them are six tracks you cannot tell
   * apart — at the one moment the tracks are the most interesting thing on the
   * map. The hull still answers "am I on target"; the trail answers "whose
   * track is that", and they are different questions. */
  const trailCol = typeof teamInk === 'function' ? teamInk(rd, team) : col;
  const t0 = Math.max(t - trailSec, rd.tMin);
  const span = Math.max(0, t - t0);
  const step = Math.max(0.5, span / TRAIL_MAX_STEPS);
  let prev = null;
  for (let tt = t0; tt <= t + 1e-6; tt += step) {
    const p = sampleAt(tr, tt);
    if (!p) { prev = null; continue; }
    if (prev) {
      const age = span > 0 ? (t - tt) / span : 0;
      ctx.strokeStyle = trailCol;
      ctx.globalAlpha = alpha * (1 - age * 0.7);
      ctx.lineWidth = (focus ? 2.8 : 1.8) * (1 - age * 0.4);
      ctx.beginPath();
      ctx.moveTo(tX(prev.rx, prev.ry), tY(prev.rx, prev.ry));
      ctx.lineTo(tX(p.rx, p.ry), tY(p.rx, p.ry));
      ctx.stroke();
    }
    prev = p;
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  const x = tX(s.rx, s.ry), y = tY(s.rx, s.ry);
  const margin = 30;
  if (x < -margin || x > W + margin || y < -margin || y > H + margin) {
    return { off: true, team, x, y, col: boatColour(rd, team), focus,
             dist: Math.hypot(s.rx - rd.frame.leeR.rx, s.ry - rd.frame.leeR.ry) };
  }

  // Speed vector: PROJECTION.sec of travel ahead, or 4 s when the projection is
  // off. Drawn thin and semi-transparent so it never reads as part of the track
  // — at 75 km/h a 6 s vector is 125 m of line in the same colour as the trail,
  // which is genuinely confusing.
  const sogMs = (s.sog || 0) / 3.6;
  const projSec = PROJECTION.sec > 0 ? PROJECTION.sec : PROJECTION_DEFAULT_SEC;
  const projecting = PROJECTION.sec > 0;
  const vlen = sogMs * projSec / mpp;
  const screenCog = (s.cog != null ? s.cog : s.hdg || 0) - rotDeg;
  const cr = screenCog * Math.PI / 180;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (vlen > 6) {
    const ex = x + Math.sin(cr) * vlen, ey = y - Math.cos(cr) * vlen;
    ctx.save();
    // The projection reads as a statement rather than a whisker, so it gets a
    // longer dash and a little more ink than the 4 s vector it replaces.
    // The focus boat's projection is the one you steer off, so it is drawn
    // heavier and less transparent than the fleet's — at 1.2 px and 0.7 alpha
    // it was the same whisker as everyone else's and disappeared into them.
    ctx.globalAlpha = alpha * (focus ? 0.95 : projecting ? 0.7 : 0.45);
    ctx.setLineDash(projecting ? (focus ? [9, 5] : [7, 5]) : [4, 4]);
    ctx.strokeStyle = col;
    ctx.lineWidth = (focus ? 2.6 : 0.8) * (projecting ? 1.4 : 1);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.restore();
    // Ticks every 5 s along the shaft, so the line carries time as well as
    // reach: the gap between two balls is five seconds of this speed, which is
    // the unit every pre-start decision is actually made in. Only while the
    // projection is a deliberate length — on the plain 4 s vector there is
    // nothing to divide.
    if (projecting) {
      const stepPx = vlen * (PROJECTION_TICK_S / projSec);
      if (stepPx > 7) {
        ctx.save();
        ctx.globalAlpha = alpha * (focus ? 0.95 : 0.6);
        ctx.fillStyle = col;
        ctx.strokeStyle = MAP_INK.halo;
        ctx.lineWidth = 1;
        for (let k = 1; k * PROJECTION_TICK_S < projSec - 1e-6; k++) {
          const px = x + Math.sin(cr) * stepPx * k;
          const py = y - Math.cos(cr) * stepPx * k;
          ctx.beginPath();
          ctx.arc(px, py, focus ? 3.4 : 2.3, 0, Math.PI * 2);
          ctx.fill(); ctx.stroke();
        }
        ctx.restore();
      }
    }

    ctx.globalAlpha = alpha * 0.8;
    ctx.fillStyle = col;
    const ah = focus ? 9 : 6;          // the head follows the shaft's weight
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - Math.sin(cr - 0.4) * ah, ey + Math.cos(cr - 0.4) * ah);
    ctx.lineTo(ex - Math.sin(cr + 0.4) * ah, ey + Math.cos(cr + 0.4) * ah);
    ctx.closePath(); ctx.fill();

    // The ratio at the tip: what holding this speed and heading for projSec
    // seconds would leave you with. Only pre-gun, and only while the projected
    // moment is still pre-gun — "time to the start" past the gun is not a
    // quantity, and a tick that keeps counting is worse than one that stops.
    /* Nothing at the tip once WE are on starboard in the countdown.
     *
     * On starboard you are on the approach and the question has changed: the
     * ratio you will have in twenty seconds is no longer a decision, it is a
     * consequence, and by then the map is at its most crowded — six boats,
     * six projections, six numbers hanging off the ends of them, over the one
     * piece of water you are trying to read. The ratio under each hull is
     * still there for anyone who wants the figure. Same rule as Z, which also
     * retires on starboard, and for the same reason.
     *
     * Also nothing at the tip while THIS boat reads head to wind — TWA inside
     * the no-go zone (CONE_NOGO.dead, the same 20° every accel/cone number in
     * the app already treats as "can't make way here"). A boat head to wind
     * pre-start is mid-manoeuvre, not sailing a course: COG is unwinding fast
     * as the bow swings through the eye of the wind, so the speed-and-heading
     * vector this label is built from describes a heading that is already
     * gone by the time the number is read, not where the boat is going next.
     * Per boat, not global — a fleet mid-start has some boats head to wind and
     * some not, and only the ones actually doing it should go quiet. The
     * vector itself still draws; only the number at its tip disappears. */
    const headToWind = s.twa != null && Math.abs(s.twa) < CONE_NOGO.dead;
    if (projecting && !isExcluded && rd.ratio && !opts.stbdApproach && !headToWind) {
      const dist = sogMs * projSec;                      // metres, rot frame
      const pp = { rx: s.rx + Math.sin(cr) * dist,
                   ry: s.ry + Math.cos(cr) * dist };
      const pr = ratioAtPoint(rd, pp, t + projSec);
      // Three things can be true at the tip, and the blank one is the least
      // useful. "over" is the whole point of looking ahead: holding this speed
      // and this heading puts the boat across the line while the gun is still
      // to come, which is the mistake the projection exists to show.
      const over = pr && pr.ttl < RATIO_MIN_TTL;
      // Past the gun there is no start to project onto, so the tip carries no
      // label at all — a fleet of arrows each tagged "gun" for the rest of the
      // race is noise. Pre-gun the word still means something: your projection
      // reaches past the start.
      const txt = t >= 0 ? null
                : t + projSec >= 0 ? 'gun'
                : over ? 'over'
                : !pr || pr.ratio == null ? null
                : pr.ratio.toFixed(2);
      if (txt) {
        ctx.save();
        ctx.globalAlpha = focus ? 1 : 0.8;
        ctx.font = focus ? '700 11px "Share Tech Mono", monospace'
                         : '10px "Share Tech Mono", monospace';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        // nudged off the arrowhead on the side the arrow is not pointing
        const lx = ex + (Math.sin(cr) >= 0 ? 8 : -8), ly = ey - 9;
        if (Math.sin(cr) < 0) ctx.textAlign = 'right';
        ctx.lineWidth = 3; ctx.strokeStyle = MAP_INK.halo;
        ctx.strokeText(txt, lx, ly);
        ctx.fillStyle = txt === 'gun' ? MAP_INK.boatDim
                      : txt === 'over' ? OCS_COL
                      : ratioInk(pr.ratio, focus);
        ctx.fillText(txt, lx, ly);
        ctx.restore();
      }
    }
  }
  drawHull(ctx, x, y, (s.hdg || 0) - rotDeg, col, mpp, focus);
  if (isOCS) {
    // ring, sized to the boat so it reads at any zoom
    const r = Math.max(11, (F50_LOA / mpp) * 0.75);
    ctx.strokeStyle = OCS_COL; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = alpha * 0.35;
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();

  // label
  ctx.save();
  ctx.globalAlpha = (focus ? 1 : 0.7) * (isExcluded ? 0.6 : 1);
  const off = Math.max(10, (F50_LOA / mpp) * 0.6);
  ctx.font = `${focus ? 700 : 600} `
           + `${Math.round((focus ? 12 : 10) * MAP_INK.label)}px Orbitron, monospace`;
  const pos = rd.reachPos && rd.reachPos.get(team);
  const suffix = isExcluded ? ' ·excl' : (isOCS ? ' OCS' : (pos ? ` ${pos}` : ''));
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 3; ctx.strokeStyle = MAP_INK.halo;
  ctx.strokeText(team + suffix, x + off, y - 6);
  ctx.fillStyle = isOCS ? OCS_COL : (podium || (focus ? MAP_INK.boat : MAP_INK.boatDim));
  ctx.fillText(team + suffix, x + off, y - 6);
  // Speed under the name. The focus boat gets it on every map; on the replay
  // every boat gets it (opts.allSog), smaller and dimmer, because the whole
  // point of the replay is watching who is building speed and who is parked.
  if (s.sog != null && (focus || opts.allSog)) {
    ctx.font = focus ? '10px "Share Tech Mono", monospace'
                     : '9px "Share Tech Mono", monospace';
    // The unit rides with the number on every boat, not just the focus one.
    // A bare "40.7" next to a bare "1.13" is two unlabelled numbers stacked,
    // and the reader has to remember which is which.
    const txt = s.sog.toFixed(1) + ' km/h';
    if (!focus) ctx.globalAlpha *= 0.85;
    ctx.strokeText(txt, x + off, y + 7);
    ctx.fillStyle = focus ? MAP_INK.boatSog : MAP_INK.boatDim;
    ctx.fillText(txt, x + off, y + 7);

    // Start ratio under the speed, live, every boat. Pre-gun only: after the
    // gun "time to the start" is not a quantity. Coloured rather than ranked,
    // because on the map you want to see at a glance who is holding 1.0 and
    // who is a second and a half early, not who is Nth at it.
    if (t < 0 && rd.ratio && !isExcluded) {
      const dr = displayRatio(rd, team, t);
      if (dr) {
        ctx.font = focus ? '10px "Share Tech Mono", monospace'
                         : '9px "Share Tech Mono", monospace';
        // an italic-ish marker would not survive the small size, so the polar
        // fallback is flagged with a dot instead of a different face
        const rtxt = dr.value.toFixed(2) + ' ratio' + (dr.source === 'polar' ? '·' : '');
        ctx.strokeText(rtxt, x + off, y + 19);
        ctx.fillStyle = ratioInk(dr.value, focus);
        ctx.fillText(rtxt, x + off, y + 19);
      }
    }
  }
  ctx.restore();
  return { off: false };
}

/* Boats outside the frame get an edge marker rather than silently vanishing —
 * at T-90 in LINE mode that is most of the fleet. */
function drawOffscreen(ctx, list, W, H) {
  for (const b of list) {
    const cx = W / 2, cy = H / 2;
    let dx = b.x - cx, dy = b.y - cy;
    const m = Math.max(Math.abs(dx) / (W / 2 - 16), Math.abs(dy) / (H / 2 - 16));
    dx /= m; dy /= m;
    const x = cx + dx, y = cy + dy;
    ctx.save();
    ctx.globalAlpha = b.focus ? 0.95 : 0.5;
    ctx.fillStyle = b.col;
    ctx.beginPath();
    const a = Math.atan2(dy, dx);
    ctx.translate(x, y); ctx.rotate(a);
    ctx.moveTo(7, 0); ctx.lineTo(-5, 4.5); ctx.lineTo(-5, -4.5);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = b.focus ? 0.95 : 0.5;
    ctx.font = '700 9px Orbitron, monospace';
    ctx.fillStyle = b.col;
    ctx.textAlign = dx > 0 ? 'right' : 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.team, x - Math.sign(dx) * 12, y - 10);
    ctx.restore();
  }
}

/* At the entry the boat sits ON the line plane by construction, so its
 * perpendicular distance to the line is zero and tells you nothing. The number
 * that describes the entry is how far along the EXTENSION, past the end of the
 * line, the crossing happened. The line renders vertically, so that distance
 * reads as a vertical drop from the boat to the mark. */
function drawEntryLeader(ctx, rd, entry, t, tX, tY, focus) {
  const f = rd.frame;
  if (!entry || entry.pastEndM == null || entry.pastEndM <= 0) return;
  const s = sampleAt(rd.tracks[focus], t);
  if (!s) return;

  const end = entry.end === 'windward' ? f.windR : f.leeR;
  const bx = tX(s.rx, s.ry), by = tY(s.rx, s.ry);
  // foot of the boat on the line axis — the boat is on the plane, so this is
  // the boat's own position projected onto the infinite line
  const along = (s.rx - f.leeR.rx) * f.u.x + (s.ry - f.leeR.ry) * f.u.y;
  const fx = f.leeR.rx + f.u.x * along, fy = f.leeR.ry + f.u.y * along;
  const px = tX(fx, fy), py = tY(fx, fy);
  const ex = tX(end.rx, end.ry), ey = tY(end.rx, end.ry);

  ctx.save();
  // perpendicular hop from the boat onto the line axis (usually ~0 px)
  if (Math.hypot(px - bx, py - by) > 2) {
    ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(250,204,21,0.5)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(px, py); ctx.stroke();
  }
  // the measured run along the extension, boat -> line end
  ctx.setLineDash([7, 5]);
  ctx.strokeStyle = '#facc15'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(ex, ey); ctx.stroke();
  ctx.setLineDash([]);
  // end ticks
  const tick = 7;
  const perp = { x: -f.u.y, y: f.u.x };
  for (const [qx, qy] of [[px, py], [ex, ey]]) {
    ctx.beginPath();
    ctx.moveTo(qx - perp.x * tick, qy + perp.y * tick);
    ctx.lineTo(qx + perp.x * tick, qy - perp.y * tick);
    ctx.stroke();
  }
  // label on a chip at the midpoint
  const mx = (px + ex) / 2, my = (py + ey) / 2;
  const lbl = entry.pastEndM.toFixed(0) + ' m past ' + (entry.end || 'end');
  ctx.font = '700 22px Orbitron, monospace';
  const tw = ctx.measureText(lbl).width;
  const bw = tw + 22, bh = 38;
  // Sit the chip to the LEFT of the measure by default. The clock now lives
  // centre-right on this still, and a right-hand chip lands straight on it.
  const cw = ctx.canvas.width / (window.devicePixelRatio || 1);
  let lx = mx - 14 - bw;
  if (lx < 8) lx = Math.min(mx + 14, cw - bw - 8);
  ctx.fillStyle = MAP_INK.chip;
  ctx.strokeStyle = 'rgba(250,204,21,0.45)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(lx, my - bh / 2, bw, bh, 5);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#facc15';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(lbl, lx + 11, my);
  ctx.restore();
}

function drawWind(ctx, rd, W, H, dirOnScreen) {
  const twd = rd.wind.twd;
  if (twd == null) return;
  const cx = 40, cy = 44, R = 22;
  // Into the wind, at where it is coming from — the same convention as the
  // live arrows and the field arrows, and the same direction the number under
  // the rose names. It used to point downwind, so the one instrument on the
  // map whose whole job is "which way is the wind" disagreed by 180 degrees
  // with every arrow on the water.
  const d = dirOnScreen(twd);
  ctx.save();
  ctx.fillStyle = MAP_INK.plate;
  ctx.strokeStyle = MAP_INK.plateEdge;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, R + 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = MAP_INK.rose; ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(cx - d.dx * R, cy - d.dy * R);
  ctx.lineTo(cx + d.dx * R, cy + d.dy * R);
  ctx.stroke();
  const a = Math.atan2(d.dy, d.dx);
  ctx.fillStyle = MAP_INK.rose;
  ctx.beginPath();
  ctx.moveTo(cx + d.dx * R, cy + d.dy * R);
  ctx.lineTo(cx + d.dx * R - Math.cos(a - 0.5) * 9, cy + d.dy * R - Math.sin(a - 0.5) * 9);
  ctx.lineTo(cx + d.dx * R - Math.cos(a + 0.5) * 9, cy + d.dy * R - Math.sin(a + 0.5) * 9);
  ctx.closePath(); ctx.fill();
  ctx.font = '700 9px Orbitron, monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillStyle = MAP_INK.rose;
  ctx.fillText(Math.round(twd) + '°', cx, cy + R + 10);
  if (rd.wind.tws != null) {
    ctx.fillStyle = MAP_INK.faint;
    ctx.font = '9px "Share Tech Mono", monospace';
    ctx.fillText(rd.wind.tws.toFixed(1) + ' km/h', cx, cy + R + 22);
  }
  ctx.restore();
}

function drawScaleBar(ctx, mpp, W, H) {
  /* The same two steps the grid uses, from the same function. The bar is now a
   * legend for the grid rather than an independent measurement: one square is
   * one bar, at every zoom, and the two can never label the map differently. */
  const nice = gridStepFor(mpp);
  const px = nice / mpp;
  const x = 16, y = H - 22;
  ctx.save();
  ctx.strokeStyle = MAP_INK.scale; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 4);
  ctx.stroke();
  ctx.fillStyle = MAP_INK.scaleTxt;
  ctx.font = '9px "Share Tech Mono", monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText(nice >= 1000 ? (nice / 1000) + ' km' : nice + ' m', x, y - 6);
  ctx.restore();
}

function drawModeChip(ctx, opts, W, H) {
  const label = (opts.mode || 'auto').toUpperCase() +
                ((opts.zoom && Math.abs(opts.zoom - 1) > 0.01)
                  ? '  ×' + opts.zoom.toFixed(1) : '');
  ctx.save();
  ctx.font = '700 8px Orbitron, monospace';
  const w = ctx.measureText(label).width + 14;
  ctx.fillStyle = MAP_INK.plate;
  ctx.strokeStyle = MAP_INK.plateEdge;
  ctx.beginPath(); ctx.roundRect(W - w - 12, H - 26, w, 16, 5);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = MAP_INK.rose;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, W - w / 2 - 12, H - 18);
  ctx.restore();
}

/* ── the ratio strip ────────────────────────────────────────────────────────
 *
 * Start ratio against time, every contesting boat, under the replay and
 * sharing its clock. The point of drawing it rather than tabulating it is that
 * the SHAPE is the coaching: a boat holding 1.4 until T-20 and then dumping it
 * has a different problem from one that drifts under 1.0 at T-40 and never
 * recovers, and both look identical if you only sample the number twice.
 *
 * The y axis is logarithmic. Ratio is a quotient, so 2.0 and 0.5 are equally
 * wrong in opposite directions, and a linear axis puts 0.5 hard against the
 * floor while 2.0 sits mid-panel. On a log axis 1.0 is the centre line and
 * "twice as much time as you need" and "half as much" are the same distance
 * from it, which is what they are.
 */
const RATIO_LO = 0.5, RATIO_HI = 3.0;

function drawRatioStrip(canvasId, rd, t, opts = {}) {
  const canvas = typeof canvasId === 'string'
    ? document.getElementById(canvasId) : canvasId;
  if (!canvas || !rd) return;
  const H = opts.height || 160;
  const { ctx, W } = cvs(canvas, H);
  const focus = opts.focus || '';

  const padL = 46, padR = 12, padT = 16, padB = 20;
  const t0 = Math.max(-90, rd.tMin), t1 = 0;
  // A buffer that starts at or after the gun leaves no axis to draw on, and
  // the transform would hand NaN to every moveTo. Canvas drops those silently,
  // so it read as an empty strip rather than as a bug.
  if (!(t1 - t0 > 0)) return;
  const X = tt => padL + (tt - t0) / (t1 - t0) * (W - padL - padR);
  const lr = Math.log(RATIO_LO), hr = Math.log(RATIO_HI);
  const Y  = r => {
    const v = Math.log(Math.max(RATIO_LO, Math.min(RATIO_HI, r)));
    return padT + (hr - v) / (hr - lr) * (H - padT - padB);
  };

  ctx.fillStyle = '#050506';
  ctx.fillRect(0, 0, W, H);

  if (!rd.vmc) {
    ctx.fillStyle = MUTED;
    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('no polar for this config — the ratio needs one', W / 2, H / 2);
    return;
  }

  // horizontal guides
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'right';
  for (const r of [0.5, 0.75, 1, 1.5, 2, 3]) {
    const y = Y(r);
    ctx.strokeStyle = r === 1 ? '#3d5a72' : '#182533';
    ctx.lineWidth = r === 1 ? 1.4 : 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillStyle = r === 1 ? '#8ea3b8' : '#4a5b6d';
    ctx.fillText(r.toFixed(r === 1 ? 2 : 2), padL - 6, y + 3);
  }

  // time ticks every 15 s
  ctx.textAlign = 'center';
  ctx.fillStyle = '#4a5b6d';
  for (let tt = Math.ceil(t0 / 15) * 15; tt <= 0; tt += 15) {
    const x = X(tt);
    ctx.strokeStyle = '#131e2a';
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
    ctx.fillText(tt === 0 ? 'GUN' : 'T' + tt, x, H - 6);
  }

  /* Two traces per boat.
   *
   * SOLID is the boat's own PC_START_RATIO_unk — the number on the sailors'
   * screen, and the one they will argue with you about. Gaps in it are the
   * PC's sentinel windows and are left as gaps.
   *
   * DASHED is our polar potential: what the ratio would be on the fastest
   * angle to the line. It sits above the solid line by construction, and the
   * space between them is the point of drawing both — that gap is the time
   * available from being on a better angle, which is the only part of this a
   * sailor can steer to.
   */
  const drawTrace = (series, colour, width, alpha, dash) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.globalAlpha = alpha;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    let pen = false, lastT = null;
    for (const p of series) {
      if (p.ratio == null) { pen = false; continue; }
      // a jump of more than 2 s is a gap in the channel, not a steep slope
      if (lastT != null && p.t - lastT > 2.5) pen = false;
      lastT = p.t;
      const x = X(p.t), y = Y(p.ratio);
      if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  };

  const order = rd.activeTeams.filter(x => x !== focus);
  if (focus && rd.ratio.has(focus)) order.push(focus);
  for (const team of order) {
    const isF = team === focus;
    const col = isF ? teamColour(team) : '#3f5164';
    const onboard = (rd.ratioLogged && rd.ratioLogged.get(team)) || [];
    // the fleet gets one line each; only the focus boat is worth two
    if (onboard.length) drawTrace(onboard, col, isF ? 2.4 : 1.1, isF ? 1 : 0.75);
    if (isF || !onboard.length)
      drawTrace(rd.ratio.get(team) || [], col, isF ? 1.4 : 1.1,
                isF ? 0.5 : 0.55, isF ? [5, 4] : [3, 3]);
  }

  // the boat's own port entry, so the pre-entry part of the curve is readable
  // as "not yet in the box" rather than as a bad approach
  const entry = focus && rd.entries ? rd.entries[focus] : null;
  if (entry && entry.t >= t0) {
    const x = X(entry.t);
    ctx.strokeStyle = '#2f6f4f';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
    ctx.setLineDash([]);
  }

  // where the focus boat's last tack or gybe began — the instant the table
  // reports, so the number in the table can be found on the picture
  const man = focus ? lastManoeuvre(rd, focus) : null;
  if (man && man.t >= t0) {
    const x = X(man.t);
    ctx.strokeStyle = teamColour(focus);
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = teamColour(focus);
    ctx.beginPath();
    ctx.moveTo(x, H - padB); ctx.lineTo(x - 4, H - padB + 6); ctx.lineTo(x + 4, H - padB + 6);
    ctx.closePath(); ctx.fill();
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = x > W - 120 ? 'right' : 'left';
    ctx.fillText(' ' + man.type + ' ', x, padT + 8);
  }

  // playhead
  if (t != null && t <= 0 && t >= t0) {
    const x = X(t);
    ctx.strokeStyle = '#e8eef5';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
    const r = focus ? ratioAt(rd, focus, t) : null;
    if (r && r.ratio != null) {
      ctx.fillStyle = teamColour(focus);
      ctx.beginPath(); ctx.arc(x, Y(r.ratio), 3.5, 0, 7); ctx.fill();
    }
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = '#5a6a7d';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText('RATIO', padL + 2, 11);
  if (focus) {
    const has = (rd.ratioLogged && (rd.ratioLogged.get(focus) || []).length) > 0;
    ctx.fillStyle = '#7f8fa1';
    ctx.fillText(has ? 'solid = onboard · dashed = polar potential'
                     : 'polar potential only — no onboard ratio for this boat',
                 padL + 52, 11);
  }
}

/* The numeric readout that sits beside the strip. Returns HTML. */
function ratioReadout(rd, team, t) {
  if (!team) return '<span class="sub">no boat focused</span>';
  if (t >= 0) return '<span class="sub">after the gun</span>';
  const onboard = loggedRatioAt(rd, team, t);
  const ours = ratioAt(rd, team, t);
  if (onboard == null && (!ours || ours.ratio == null))
    return '<span class="sub">no ratio at this moment</span>';

  const shown = onboard != null ? onboard : (ours && ours.ratio);
  const col = shown == null   ? 'var(--muted2)'
            : shown < 0.9     ? 'var(--red)'
            : shown <= 1.15   ? 'var(--green)'
            : shown <= 1.6    ? 'var(--yellow)' : 'var(--orange)';

  let html = `<b style="color:${col};font-size:15px">${shown.toFixed(2)}</b>` +
             `<span class="sub" style="margin-left:6px">` +
             `${onboard != null ? 'onboard' : 'polar potential'}</span>`;

  if (onboard != null && ours && ours.ratio != null) {
    // seconds the boat would save by being on the best angle to the line
    const pcTtl = -t / onboard;
    const gain = pcTtl - ours.ttl;
    html += `<span class="sub" style="margin-left:10px">polar ${ours.ratio.toFixed(2)}` +
            (gain > 0.2 ? ` · ${gain.toFixed(1)}s in the angle` : '') + `</span>`;
  } else if (ours && ours.ratio != null) {
    html += `<span class="sub" style="margin-left:10px">need ${ours.ttl.toFixed(1)}s · ` +
            `have ${ours.tts.toFixed(1)}s</span>`;
  }
  return html;
}
