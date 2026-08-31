/* ==== geom.js ==== */
/* geom.js — projection, the start-line frame, and track interpolation.
 *
 * Everything here is a pure function of its arguments. tests.html exercises
 * this file; keep it that way.
 */

const D2R = Math.PI / 180;
const RE  = 6371000;

/* Speed is km/h everywhere: in the logs, in the race files, on the canvases and
 * in the tables. There is deliberately no conversion helper — the M32 tool's
 * worst shipped bug was a unit conversion applied at 21 sites under a comment
 * that named the wrong one, and the cheapest defence is having no conversion to
 * get wrong. If knots are ever wanted, add them at the point of display only,
 * and assert the constant against GPS-derived speed first. */
const SPEED_UNIT = 'km/h';

function hav(a, b, c, d) {
  const dL = (c - a) * D2R, dO = (d - b) * D2R;
  const x = Math.sin(dL / 2) ** 2 +
            Math.cos(a * D2R) * Math.cos(c * D2R) * Math.sin(dO / 2) ** 2;
  return RE * 2 * Math.asin(Math.sqrt(x));
}

function brg(a, b, c, d) {
  const dO = (d - b) * D2R;
  const x = Math.sin(dO) * Math.cos(c * D2R);
  const y = Math.cos(a * D2R) * Math.sin(c * D2R) -
            Math.sin(a * D2R) * Math.cos(c * D2R) * Math.cos(dO);
  return (Math.atan2(x, y) / D2R + 360) % 360;
}

const angDiff = (a, b) => ((a - b + 540) % 360) - 180;

/* Interpolate an angle in degrees the short way round. */
function lerpAngle(a, b, s) {
  if (a == null) return b;
  if (b == null) return a;
  return (a + angDiff(b, a) * s + 360) % 360;
}

const lerp = (a, b, s) => (a == null ? b : b == null ? a : a + (b - a) * s);

/* ── the start-line frame ───────────────────────────────────────────────────
 *
 * Local metric plane centred on the line midpoint, then rotated so the vector
 * leeward -> windward points straight UP the screen. The start line therefore
 * runs vertically with the windward end at the top, which is the M32 tool's
 * projection generalised: for a reaching start the line sits within a few
 * degrees of parallel to the wind, so "windward end up" and "line vertical"
 * are the same instruction.
 *
 * Returned coordinates are (rx, ry) in metres, ry POSITIVE UP. Screen mapping
 * flips ry — see frame.js.
 */
function makeFrame(race) {
  const W = race.marks.windward, L = race.marks.leeward;
  const cLat = (W.lat + L.lat) / 2, cLon = (W.lon + L.lon) / 2;

  const toM = (lat, lon) => ({
    x: (lon - cLon) * D2R * RE * Math.cos(cLat * D2R),
    y: (lat - cLat) * D2R * RE,
  });

  const wM = toM(W.lat, W.lon), lM = toM(L.lat, L.lon);
  const ang = Math.atan2(wM.y - lM.y, wM.x - lM.x);
  const rot = -(ang - Math.PI / 2);
  const cos = Math.cos(rot), sin = Math.sin(rot);

  const r  = (x, y) => ({ rx: x * cos - y * sin, ry: x * sin + y * cos });
  const rp = (lat, lon) => { const m = toM(lat, lon); return r(m.x, m.y); };

  const windR = r(wM.x, wM.y), leeR = r(lM.x, lM.y);
  const m1    = race.marks.M1 ? rp(race.marks.M1.lat, race.marks.M1.lon) : null;

  // Unit vector along the line (leeward -> windward) and its normal. After the
  // rotation the line is vertical, so u is ~(0,1), but derive it rather than
  // assume it — the two marks are not exactly what the rotation was built from
  // once floating point is involved.
  const lx = windR.rx - leeR.rx, ly = windR.ry - leeR.ry;
  const lineLen = Math.hypot(lx, ly) || 1;
  const ux = lx / lineLen, uy = ly / lineLen;
  let nx = -uy, ny = ux;

  // Orient the normal so POSITIVE = pre-start side, i.e. the side away from M1.
  // With no M1 in the file, fall back to +x, and record that we guessed.
  let normalMethod = 'from-M1';
  if (m1) {
    const s = (m1.rx - leeR.rx) * nx + (m1.ry - leeR.ry) * ny;
    if (s > 0) { nx = -nx; ny = -ny; }
  } else {
    normalMethod = 'assumed';
  }

  const limits = {};
  for (const [name, pts] of Object.entries(race.limits || {}))
    limits[name] = pts.map(([la, lo]) => rp(la, lo));

  return {
    // The origin the local metric frame is measured from. Without it the
    // rotation is one-way — every mark and track can be projected INTO the
    // frame and nothing can be projected back out to a latitude and longitude,
    // which is what a basemap underneath needs.
    cLat, cLon,
    toM, r, rp, rot,
    windR, leeR, m1R: m1, lineLen, limits, normalMethod,
    u: { x: ux, y: uy }, n: { x: nx, y: ny },

    /* Signed perpendicular distance to the line. Positive = pre-start side. */
    dtl(p) {
      return (p.rx - this.leeR.rx) * this.n.x + (p.ry - this.leeR.ry) * this.n.y;
    },

    /* Position along the line: 0 % = leeward end, 100 % = windward end.
     * Values outside [0,100] mean the boat is off the end of the line, which
     * is exactly what the port-entry detector looks for. */
    linePct(p) {
      const a = (p.rx - this.leeR.rx) * this.u.x + (p.ry - this.leeR.ry) * this.u.y;
      return a / this.lineLen * 100;
    },

    /* Distance along the leg axis line-midpoint -> M1. Used for reach order. */
    legAxis(p) {
      if (!this.m1R) return null;
      const mx = (this.windR.rx + this.leeR.rx) / 2;
      const my = (this.windR.ry + this.leeR.ry) / 2;
      const ax = this.m1R.rx - mx, ay = this.m1R.ry - my;
      const len = Math.hypot(ax, ay) || 1;
      return ((p.rx - mx) * ax + (p.ry - my) * ay) / len;
    },

    /* True compass bearing of a direction expressed in rotated-frame
     * components. The inverse of the rotation the frame applies, so anything
     * measured on screen can be turned back into a wind angle. */
    bearingFromRot(dx, dy) {
      const c = Math.cos(-this.rot), s2 = Math.sin(-this.rot);
      const e = dx * c - dy * s2;          // east
      const n = dx * s2 + dy * c;          // north
      return (Math.atan2(e, n) / D2R + 360) % 360;
    },

    m1Dist(p) {
      if (!this.m1R) return null;
      return Math.hypot(p.rx - this.m1R.rx, p.ry - this.m1R.ry);
    },
  };
}

/* ── track interpolation ────────────────────────────────────────────────────
 *
 * The logs are 1 Hz. At 75 km/h that is ~21 m between samples, about 1.5 boat
 * lengths, so linear interpolation visibly cuts the corner through a turn.
 * We know the velocity at every sample (COG for direction, |SOG| for
 * magnitude), which is precisely what a cubic Hermite spline wants, so use
 * one. The scalar channels are interpolated linearly; only position gets the
 * spline.
 */
function buildTrack(frame, b) {
  const n = b.t.length;
  const pts = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = frame.rp(b.lat[i], b.lon[i]);
    const sogMs = (b.sog[i] || 0) / 3.6;
    const cog = (b.cog[i] != null ? b.cog[i] : b.hdg[i] || 0) * D2R;
    // velocity in the rotated frame: rotate the (east, north) vector too
    const ve = Math.sin(cog) * sogMs, vn = Math.cos(cog) * sogMs;
    const v = frame.r(ve, vn);
    pts[i] = { rx: p.rx, ry: p.ry, vx: v.rx, vy: v.ry };
  }
  return { t: b.t, pts, raw: b, n };
}

function sampleAt(track, t) {
  const ts = track.t, n = track.n;
  if (!n) return null;
  if (t < ts[0] || t > ts[n - 1]) return null;

  // binary search for the bracketing pair
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid; else hi = mid;
  }
  const t0 = ts[lo], t1 = ts[hi];
  const h = t1 - t0;
  const s = h > 0 ? (t - t0) / h : 0;
  const p0 = track.pts[lo], p1 = track.pts[hi];
  const b = track.raw;

  let rx, ry;
  if (h > 0 && h < 4) {
    // cubic Hermite with the measured velocity as the tangent
    const s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2,    h11 = s3 - s2;
    rx = h00 * p0.rx + h10 * p0.vx * h + h01 * p1.rx + h11 * p1.vx * h;
    ry = h00 * p0.ry + h10 * p0.vy * h + h01 * p1.ry + h11 * p1.vy * h;
  } else {
    // gap in the data — do not pretend a spline through it means anything
    rx = lerp(p0.rx, p1.rx, s);
    ry = lerp(p0.ry, p1.ry, s);
  }

  return {
    t, rx, ry, i: lo, gap: h >= 4,
    sog:  lerp(b.sog[lo],  b.sog[hi],  s),
    hdg:  lerpAngle(b.hdg[lo],  b.hdg[hi],  s),
    cog:  lerpAngle(b.cog[lo],  b.cog[hi],  s),
    twa:  lerp(b.twa[lo],  b.twa[hi],  s),
    twd:  lerpAngle(b.twd[lo],  b.twd[hi],  s),
    tws:  lerp(b.tws[lo],  b.tws[hi],  s),
    dtlLogged: b.dtl[lo],
    linePctLogged: b.linePct[lo],
    targTwa: b.targTwa ? lerp(b.targTwa[lo], b.targTwa[hi], s) : null,
    targSog: b.targSog ? lerp(b.targSog[lo], b.targSog[hi], s) : null,
    // A step, not a ramp: half way between leg 2 and leg 3 you are on leg 2,
    // not on leg 2.5. Take the sample at or before t and leave it alone.
    leg: b.leg ? b.leg[lo] : null,
  };
}

/* Value of a scalar series at a time, without the spline. */
function valueAt(track, t, key) {
  const s = sampleAt(track, t);
  return s ? s[key] : null;
}
