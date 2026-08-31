/* ==== metrics.js ==== */
/* metrics.js — everything derived from a loaded race.
 *
 * Convention followed throughout, taken from the M32 post-mortem: when a
 * computation has fallbacks, RECORD WHICH ONE FIRED and surface it in the UI.
 * A heading that asserts a method which is no longer running is how a broken
 * feature stays invisible.
 */

const DTL_CLEAR_M = 15;      // metres behind the line still counted as "safe"

/* Boats further than this from the line at the gun are dropped from the
 * analysis. A boat 200 m back did not contest this start: its line %, its
 * crossing time and its distance-to-line are projections of a position that
 * has nothing to do with the start, and leaving it in drags every fleet
 * average and every ranking with it. This follows the rule already written
 * down in ANALYSIS-PATTERNS.md §5 — entities whose data is meaningless get
 * removed entirely rather than carried with an asterisk.
 *
 * Excluded boats are still DRAWN on the maps, dimmed. They just do not feed
 * any number, any ranking, or the viewport fit. */
const EXCLUDE_DTL_M = 200;

/* Second cut-off, along the line rather than across it. A boat can sit 50 m
 * off the line plane — comfortably inside EXCLUDE_DTL_M — while being three
 * line-lengths past the leeward end, which is not contesting the start either.
 * Observed: SUI in start 12 was 51.6 m from the line at −313 % along it, and
 * reached M1 52 s after the leader, yet appeared in every ranking.
 *
 * Expressed as a fraction of the line length beyond whichever end is nearer,
 * so it scales with the line rather than being a fixed metre count. 0.5 = half
 * a line length, i.e. line % outside [−50, 150]. */
const EXCLUDE_PAST_END_FRAC = 0.5;

/* Build the fat per-race object every renderer reads from.
 *
 * opts.live — Seagull Lab addition. Live, the start is not over, so the passes
 * that need data from AFTER the moment being drawn are skipped and their fields
 * left empty rather than half-computed:
 *
 *   exclusions    decided from each boat's position AT THE GUN, which has not
 *                 happened yet. Applied pre-gun that rule excludes the whole
 *                 fleet, so live mode keeps every boat and excludes none.
 *   detectEntries scans a fixed T−130..T−20 window in one pass.
 *   startStats    one row per boat summarising the finished start.
 *   m1Order       the order at Mark 1, reached ~35 s after the gun.
 *
 * Everything the tracker draws — the frame, the tracks, the polar, the
 * advantage curve, the ratio series, the wave — is computed only from data up
 * to the last sample in the buffer, so it is honest at any moment of a live
 * start. render.js already guards every skipped field, which is why live mode
 * is a flag here rather than a second builder. */
function buildRace(raw, opts = {}) {
  const LIVE = !!opts.live;
  const frame = makeFrame(raw);
  const tracks = {};
  for (const [team, b] of Object.entries(raw.boats)) tracks[team] = buildTrack(frame, b);

  const rd = {
    raw, frame, tracks,
    teams: Object.keys(tracks).sort(),
    tMin: raw.tRange[0], tMax: raw.tRange[1],
    wind: raw.wind,
    warnings: [],
  };

  // Decide exclusions BEFORE anything is derived, so no excluded boat can
  // reach a fleet aggregate, a ranking or the viewport fit.
  rd.excluded = new Map();
  for (const team of (LIVE ? [] : rd.teams)) {
    const g = sampleAt(rd.tracks[team], 0);
    if (!g) { rd.excluded.set(team, 'no position at the gun'); continue; }

    const d = frame.dtl(g);
    if (Math.abs(d) > EXCLUDE_DTL_M) {
      rd.excluded.set(team, `${Math.abs(d).toFixed(0)} m from the line at the gun`);
      continue;
    }

    // distance past whichever end is nearer, along the line, in metres
    const pct = frame.linePct(g);
    const pastEnd = pct < 0   ? -pct / 100 * frame.lineLen
                  : pct > 100 ? (pct - 100) / 100 * frame.lineLen
                  : 0;
    if (pastEnd > EXCLUDE_PAST_END_FRAC * frame.lineLen)
      rd.excluded.set(team,
        `${pastEnd.toFixed(0)} m past the ${pct < 0 ? 'leeward' : 'windward'} end ` +
        `at the gun (over half the ${frame.lineLen.toFixed(0)} m line)`);
  }
  rd.activeTeams = rd.teams.filter(t => !rd.excluded.has(t));

  /* Course-mark wind, where the day's Course_Marks log has been sliced for this
   * start. Positions are fixed, so each mark carries one point and a series of
   * readings rather than a track. Absent for a race with no mark log, and every
   * reader treats an empty list as "no marks", never as "no wind". */
  /* How much higher the F50s read than the mark boats in this race, measured at
   * build time from the two sets of readings. Only the interpolated field uses
   * it — see windSources. Null where there was nothing to compare. */
  rd.markScale = raw.markScale || null;
  rd.course = null;
  if (raw.course && Array.isArray(raw.course.elements)) {
    rd.course = {
      legs: raw.course.legs || null,
      elements: raw.course.elements.map(el => ({
        type: el.type,
        p1: frame.rp(el.coord1.lat, el.coord1.lon),
        p2: el.coord2 ? frame.rp(el.coord2.lat, el.coord2.lon) : null,
      })),
    };
  }

  rd.markWind = (raw.markWind || []).map(m => {
    const p = frame.rp(m.lat, m.lon);
    return { name: m.name, rx: p.rx, ry: p.ry, t: m.t, twd: m.twd, tws: m.tws };
  });

  // Polar for this race. All boats have carried the same config in every
  // session seen so far; if that stops being true, say so rather than picking
  // one and drawing a layline that is wrong for half the fleet.
  rd.configs = raw.configs || [];
  rd.polar   = rd.configs.length === 1 ? polarFor(rd.configs[0]) : null;
  rd.targetUp = polarTarget(rd.polar, rd.wind.tws, true);
  rd.targetDn = polarTarget(rd.polar, rd.wind.tws, false);

  rd.endToM1 = endsToM1(rd);
  rd.vmc = vmcTable(rd.polar, rd.wind.tws);
  rd.fastPoint = fastPointOnLine(rd);
  rd.pinEnd    = raw.pinEnd || 'leeward';
  rd.advantage = advantageProfile(rd, rd.pinEnd);

  // Continuous start ratio, one series per contesting boat. Needs rd.vmc and
  // rd.frame, so it sits after the polar block and before anything reads it.
  rd.ratio = new Map();
  rd.ratioLogged = new Map();
  for (const team of rd.activeTeams) {
    rd.ratio.set(team, ratioSeries(rd, team));
    rd.ratioLogged.set(team, loggedRatioSeries(rd, team));
  }
  // How much of the pre-start the boats' own channel actually covers, so the
  // report can say so rather than leaving a reader to wonder about the gaps.
  const cov = rd.activeTeams.map(t => (rd.ratioLogged.get(t) || []).length);
  rd.ratioCoverage = cov.length ? Math.round(cov.reduce((a, b) => a + b, 0) / cov.length) : 0;

  if (LIVE) {
    // Nothing here can be known yet. Empty, not absent: the renderer reads
    // every one of these and an empty value means "not yet", which is true.
    rd.live       = true;
    rd.entries    = {};
    rd.startStats = [];
    rd.m1         = { rows: [], order: [], method: null, note: 'live — Mark 1 not reached' };
    rd.reachPos   = new Map();
    rd.ocs        = new Set();
    return rd;
  }

  rd.entries    = detectEntries(rd);
  rd.startStats = startStats(rd);
  rd.m1         = m1Order(rd);        // reads startStats to demote OCS boats
  // lookups the renderer needs: where each boat finished the reach, and who
  // was over at the gun
  rd.reachPos = new Map();
  rd.m1.order.forEach((team, i) => rd.reachPos.set(team, i + 1));
  rd.ocs = new Set(rd.startStats.filter(s => s.ocs).map(s => s.team));

  validate(rd);
  return rd;
}

/* ── port entry ─────────────────────────────────────────────────────────────
 *
 * The boat enters the pre-start by crossing the EXTENSION of the start line on
 * port. Confirmed against the 19 Aug sample: crossing at T-64.5 at 215 % along
 * the line, TWA -76 deg. So the test is three simple conditions and needs no
 * tuning:
 *
 *   signed DTL goes negative -> positive   (moving onto the pre-start side)
 *   AND |line %| outside [0,100]           (an extension, not the line itself)
 *   AND TWA < 0                            (port tack)
 */
function detectEntries(rd) {
  const WIN = [-130, -20];
  const STEP = 0.2;
  const out = {};

  for (const team of rd.teams) {
    const tr = rd.tracks[team];
    let found = null, prev = null;

    for (let t = Math.max(WIN[0], rd.tMin); t <= WIN[1]; t += STEP) {
      const s = sampleAt(tr, t);
      if (!s) { prev = null; continue; }
      const d = rd.frame.dtl(s);
      if (prev && prev.d < 0 && d >= 0) {
        const pct = rd.frame.linePct(s);
        const onPort = s.twa != null && s.twa < 0;
        const onExtension = pct < 0 || pct > 100;
        if (onExtension && onPort) {
          // refine to the exact crossing between the two samples
          const f = prev.d / (prev.d - d);
          const tc = prev.t + (t - prev.t) * f;
          const sc = sampleAt(tr, tc) || s;
          const pctC = rd.frame.linePct(sc);
          found = {
            t: +tc.toFixed(1),
            sog: sc.sog, hdg: sc.hdg, twa: sc.twa,
            linePct: +pctC.toFixed(0),
            end: pctC > 100 ? 'windward' : 'leeward',
            // how far beyond the line END the crossing happened, in metres.
            // At the crossing instant the perpendicular distance is zero by
            // construction, so this along-the-extension distance is the
            // number that actually describes the entry.
            pastEndM: +(Math.abs(pctC > 100 ? pctC - 100 : pctC)
                        / 100 * rd.frame.lineLen).toFixed(1),
            method: 'line-extension-port',
          };
          break;
        }
      }
      prev = { t, d };
    }

    if (!found) {
      // Fallback: the last crossing of the line plane before T-20, whatever the
      // tack or the end. Weaker, so say so rather than showing it as the same
      // thing.
      let last = null; prev = null;
      for (let t = Math.max(WIN[0], rd.tMin); t <= WIN[1]; t += STEP) {
        const s = sampleAt(tr, t); if (!s) { prev = null; continue; }
        const d = rd.frame.dtl(s);
        if (prev && prev.d < 0 && d >= 0) {
          const f = prev.d / (prev.d - d);
          const tc = prev.t + (t - prev.t) * f;
          const sc = sampleAt(tr, tc) || s;
          const pctL = rd.frame.linePct(sc);
          last = { t: +tc.toFixed(1), sog: sc.sog, hdg: sc.hdg, twa: sc.twa,
                   linePct: +pctL.toFixed(0),
                   end: pctL > 100 ? 'windward' : pctL < 0 ? 'leeward' : null,
                   pastEndM: (pctL < 0 || pctL > 100)
                     ? +(Math.abs(pctL > 100 ? pctL - 100 : pctL)
                         / 100 * rd.frame.lineLen).toFixed(1) : 0,
                   method: 'any-crossing' };
        }
        prev = { t, d };
      }
      found = last;
    }
    out[team] = found;   // may be null — the UI must show that honestly
  }
  return out;
}

/* ── start report ───────────────────────────────────────────────────────────*/
/* ── over the line at the gun ───────────────────────────────────────────────
 *
 * Three sources, in descending order of authority, and the tool says which
 * one it used rather than presenting them as one number.
 *
 * 1. ALARM_PENALTY_OCS_unk — the umpires' own call, raised on the boat about
 *    the boat 1.5-1.9 s after the gun. This IS the answer. Nothing we compute
 *    outranks it.
 * 2. The boat's latched PC_DTL_m — the distance the performance computer
 *    froze at its own gun. On the 11 Sassnitz races the sign of this value
 *    reproduces the umpires exactly: three calls, three matches, no false
 *    positives and no misses.
 * 3. Our own distance at t = 0, interpolated between 1 Hz samples. This is
 *    what the tool used to rely on alone, and on the same 11 races it got 2
 *    of the 3 calls, invented 2 that never happened, and missed 1 that did.
 *    A boat covers 15-20 m in the second either side of the gun, and our
 *    samples straddle it — that is the whole error.
 *
 * A boat off the end of the line cannot be over it, whatever its
 * perpendicular distance says, so the line-% bound applies to 2 and 3. It is
 * not applied to 1: the umpires do not need our geometry to be right.
 */
function latchedAtGun(rd, team) {
  const tr = rd.tracks[team], b = tr && tr.raw;
  if (!b || !b.dtl) return null;
  // The PC latches DTL at the gun and holds it. Walk back from the end of the
  // window over the repeated tail; the first sample of that tail is the latch.
  let i = b.t.length - 1;
  const v = b.dtl[i];
  if (v == null) return null;
  while (i > 0 && b.dtl[i - 1] === v) i--;
  if (b.t[i] < -3 || b.t[i] > 6) return null;      // not a gun latch
  return { dtl: v, linePct: b.linePct ? b.linePct[i] : null, t: b.t[i] };
}

function ocsCall(rd, team, ourDtl, ourPct) {
  const b = rd.tracks[team] && rd.tracks[team].raw;
  const pen = b && b.penalties && b.penalties.ocs;
  if (pen) return { over: true, source: 'umpire', at: pen.t };

  // an explicit empty penalties object means we HAVE the umpire data for this
  // race and this boat was not called — that is a negative, not a silence
  const haveUmpire = !!(b && b.penalties);
  if (haveUmpire) return { over: false, source: 'umpire' };

  const L = latchedAtGun(rd, team);
  if (L) {
    const pct = L.linePct != null ? L.linePct : ourPct;
    const onLine = pct == null || (pct > -2 && pct < 102);
    return { over: L.dtl < 0 && onLine, source: 'latched', margin: L.dtl };
  }
  const onLine = ourPct == null || (ourPct > -2 && ourPct < 102);
  return { over: ourDtl != null && ourDtl < 0 && onLine, source: 'computed',
           margin: ourDtl };
}

function startStats(rd) {
  const stats = [];

  // One fleet-wide reference speed for the T->95 % metric. The M32 tool learned
  // the hard way that a per-boat denominator which barely varies between boats
  // is a noisy divisor that makes the metric worse, not fairer.
  let fleetMax = 0;
  for (const team of rd.activeTeams) {
    const tr = rd.tracks[team];
    for (let i = 0; i < tr.n; i++)
      if (tr.t[i] >= 0 && tr.t[i] <= 60 && tr.raw.sog[i] > fleetMax) fleetMax = tr.raw.sog[i];
  }

  for (const team of rd.activeTeams) {
    const tr = rd.tracks[team];
    const at = t => sampleAt(tr, t);

    const g   = at(0);
    const g15 = at(-15);

    // min speed in the final 30 s — stall detection. Uses the already-abs'd
    // sog from prep.py; raw SOG is signed and would break this silently.
    let minSpd = null;
    for (let i = 0; i < tr.n; i++) {
      const t = tr.t[i];
      if (t >= -30 && t <= 0 && tr.raw.sog[i] != null)
        minSpd = minSpd == null ? tr.raw.sog[i] : Math.min(minSpd, tr.raw.sog[i]);
    }

    // line crossing: first sign change of DTL from + to - after T-5
    let cross = null, prev = null;
    for (let t = -5; t <= Math.min(40, rd.tMax); t += 0.2) {
      const s = at(t); if (!s) { prev = null; continue; }
      const d = rd.frame.dtl(s);
      if (prev && prev.d > 0 && d <= 0) {
        cross = +(prev.t + (t - prev.t) * (prev.d / (prev.d - d))).toFixed(1);
        break;
      }
      prev = { t, d };
    }

    // seconds after the gun to reach 95 % of the fleet's best speed
    let accel = null;
    if (fleetMax > 0) {
      const target = fleetMax * 0.95;
      for (let i = 0; i < tr.n; i++)
        if (tr.t[i] >= 0 && tr.raw.sog[i] >= target) { accel = +tr.t[i].toFixed(1); break; }
    }

    const entry = rd.entries[team];
    const dtlGun = g ? rd.frame.dtl(g) : null;
    const ratio = ratioStats(rd, team);
    const latched = latchedAtGun(rd, team);
    const call = ocsCall(rd, team, dtlGun, g ? rd.frame.linePct(g) : null);

    stats.push({
      team,
      dtlGun,
      dtlGunLogged: g ? g.dtlLogged : null,       // the 1 Hz sample before the gun, NOT the latch
      dtlT15: g15 ? rd.frame.dtl(g15) : null,
      sogGun: g ? g.sog : null,                    // km/h, like every speed here
      minSpd30: minSpd,
      crossTime: cross,
      linePct: g ? rd.frame.linePct(g) : null,
      linePctLogged: g ? g.linePctLogged : null,
      accel,
      twaGun: g ? g.twa : null,
      entryT: entry ? entry.t : null,
      entrySog: entry ? entry.sog : null,
      entryMethod: entry ? entry.method : null,
      entryPastEndM: entry ? entry.pastEndM : null,
      entryEnd: entry ? entry.end : null,
      ratio,                                       // { -30, -15, -5 } -> ratio
      dtlLatched: latched ? latched.dtl : null,
      linePctLatched: latched ? latched.linePct : null,
      ocs: call.over,
      ocsSource: call.source,
      ocsAt: call.at != null ? call.at : null,
    });
  }
  return stats;
}

/* ── the start ratio ────────────────────────────────────────────────────────
 *
 *   ratio(t) = time you have  /  time you need
 *            = TTS / TTL
 *
 * TTS is simply -t. TTL is the time to reach the start line sailing at the
 * boat's full polar potential on the FASTEST ANGLE TO THE LINE — not on the
 * boat's current heading, and with no allowance for the manoeuvre or the
 * acceleration it would take to get onto that angle. It is a potential, not a
 * prediction: what the boat could do from here if everything went right.
 *
 * The onboard performance computer carries the same quantity as
 * PC_START_RATIO_unk, and its PC_TTK_s ("time to kill") is the surplus
 * TTS - TTL, so ratio = TTS / (TTS - TTK) is the same statement rearranged.
 * We recompute it from the course file and the polar rather than reading the
 * channel, because a number you cannot check is one you will eventually trust
 * while it is wrong — and because the logged channel goes to a sentinel for
 * roughly half the pre-start.
 *
 * Reading it:
 *   1.0   arrive at the line exactly on the gun with nothing spare
 *   >1.0  surplus — that many times more time than you need, i.e. time to kill
 *   <1.0  late — you cannot make the line at the gun even at polar speed
 *
 * Defined for t < 0 only. After the gun "time to the start" is not a thing.
 */

const RATIO_MIN_TTL = 0.5;    // s — below this the ratio is division by noise
const RATIO_CAP     = 4;      // display clamp; above this the shape is all that matters

/* Seconds from a point to the start line — an ACCELERATING run, not a cruise.
 *
 * The target is the perpendicular foot on the line — the shortest crossing —
 * unless the boat is off an end, in which case it is that end, because a
 * perpendicular from out there never meets the line at all. In the ordinary
 * case the two are identical, so this only bites in the entry, which is
 * exactly where the boat is off the end by construction. This matches the
 * onboard computer's own convention, decoded from the logged channels
 * (docs/ttk-decoded.html).
 *
 * The run itself is ttlRun (js/accel.js): build from the speed the boat is
 * DOING at the measured per-config acceleration, capped at the polar for the
 * rhumb-line angle, no-go treated as the cone treats it. This used to be
 * dist / best-VMC — teleporting the boat to its fastest possible speed — and
 * against 1,151 real late line-crossings that model ran 5.3 s optimistic
 * where this one lands within 1.8 s. A point with no boat attached (a Z pin,
 * a projection without a speed) is taken already at the cap: potential, the
 * old semantic, which is the only honest reading for a place.
 *
 * The trigger-quality knob is CONE.aggr when the app has loaded it (one knob
 * moves the cone, TTK BOAT and every ratio together), 0.35 standalone.
 */
function timeToLine(rd, p) {
  const f = rd.frame;
  if (!rd.polar || rd.wind.twd == null) return null;
  const d = f.dtl(p);                       // + = pre-start side
  if (d <= 0) return 0;                     // already on or over the line
  const pct = f.linePct(p);
  let tx, ty;
  if (pct < 0)        { tx = f.leeR.rx;  ty = f.leeR.ry;  }
  else if (pct > 100) { tx = f.windR.rx; ty = f.windR.ry; }
  else                { tx = p.rx - f.n.x * d; ty = p.ry - f.n.y * d; }
  const dx = tx - p.rx, dy = ty - p.ry;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return 0;
  const A = Math.abs(angDiff(rd.wind.twd, f.bearingFromRot(dx, dy)));
  const cap = coneCap(rd, A, rd.wind.tws);
  if (!(cap > 0)) return null;              // the run is in the no-go
  const cfg = typeof accelCfgKey === 'function' ? accelCfgKey(rd)
            : (rd.configs && rd.configs.length === 1 ? rd.configs[0] : null);
  const k = typeof CONE !== 'undefined' ? CONE.aggr : 0.35;
  const v0 = p.sog != null ? p.sog : cap;
  return ttlRun(v0, rd.wind.tws, A, dist, k, cap, cfg);
}

/* The ratio for ANY point at ANY pre-gun time — the arithmetic on its own,
 * with no boat attached.
 *
 * ratioAt() below is this evaluated where the boat actually is. The projection
 * on the map evaluates it where the boat WOULD be after holding its speed and
 * heading, which is a position no track passes through, so the two callers need
 * the same formula and only one of them can start from a track sample. Keeping
 * it in one function is what stops the projected number and the live number
 * from drifting apart under a later edit.
 */
function ratioAtPoint(rd, p, t) {
  if (t >= 0) return null;
  const ttl = timeToLine(rd, p);
  if (ttl == null) return null;
  const tts = -t;
  return {
    t, tts, ttl,
    ttk:   tts - ttl,                                   // time to kill
    ratio: ttl >= RATIO_MIN_TTL ? tts / ttl : null,
  };
}

/* The ratio and its parts at one instant. Null where it would be meaningless
 * rather than a large number that looks like a measurement. */
function ratioAt(rd, team, t) {
  if (t >= 0) return null;
  const tr = rd.tracks[team];
  if (!tr) return null;
  const s = sampleAt(tr, t);
  if (!s) return null;
  const r = ratioAtPoint(rd, s, t);
  if (!r) return null;
  return { ...r, dtl: rd.frame.dtl(s), sog: s.sog };
}

function ratioSeries(rd, team, step = 0.5) {
  const from = Math.max(-90, rd.tMin), to = -RATIO_MIN_TTL;
  const out = [];
  for (let t = from; t <= to; t += step) {
    const r = ratioAt(rd, team, +t.toFixed(2));
    if (r) out.push(r);
  }
  return out;
}

/* The boat's OWN ratio, as its performance computer reported it — the number
 * on the sailors' screen. Present only once the ingest carries PC_START_RATIO_unk
 * (per-boat `pcRatio`, sentinel-gated at ingest, null where the channel was
 * floored or overflowed).
 *
 * Nearest sample within a second rather than interpolated: this is a reading,
 * not a trajectory, and averaging across a sentinel edge would invent a value
 * halfway between a real ratio and nothing.
 */
function loggedRatioAt(rd, team, t) {
  const tr = rd.tracks[team];
  if (!tr || !tr.raw.pcRatio) return null;
  const ts = tr.t, arr = tr.raw.pcRatio;
  let lo = 0, hi = tr.n - 1;
  if (t < ts[0] - 1 || t > ts[hi] + 1) return null;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
  const i = Math.abs(ts[lo] - t) <= Math.abs(ts[hi] - t) ? lo : hi;
  if (Math.abs(ts[i] - t) > 1) return null;
  const v = arr[i];
  return v == null || !isFinite(v) ? null : v;
}

/* One accessor for everything that displays a ratio, so the strip, the table
 * and the boat labels can never disagree about which number they are showing.
 * The boat's own reading wins; ours fills in where the channel is blind. */
function displayRatio(rd, team, t) {
  const lg = loggedRatioAt(rd, team, t);
  if (lg != null) return { value: lg, source: 'onboard' };
  const r = ratioAt(rd, team, t);
  if (!r || r.ratio == null) return null;
  return { value: r.ratio, source: 'polar' };
}

/* ── the last tack or gybe ──────────────────────────────────────────────────
 *
 * From TACK_DETECT_unk, which is a ramp rather than a flag: zero outside a
 * manoeuvre, then counting up at 0.1/s from the moment one begins, clipped at
 * 1.0. Every run in the Sassnitz data is exactly 10.0 s wide, so the ramp is
 * elapsed/10 and its end is start + 10 s BY CONSTRUCTION — the channel
 * measures when a manoeuvre starts and nothing else. We therefore report the
 * ratio at the START: the instant the boat committed to its final approach,
 * which is the moment the number was still a decision rather than a result.
 *
 * Tack or gybe is our own reading, from the TWA either side of the turn: a
 * sign change through a small mean |TWA| is a tack, through a large one a
 * gybe. Anything that does not change tack is called a turn.
 */
function lastManoeuvre(rd, team) {
  const tr = rd.tracks[team];
  const runs = tr && tr.raw.manoeuvres;
  if (!runs || !runs.length) return null;
  const before = runs.filter(r => r[0] < -1 && r[0] > -120);
  if (!before.length) return null;
  const [start, end, peak] = before[before.length - 1];

  const a = sampleAt(tr, Math.max(rd.tMin, start - 3));
  const b = sampleAt(tr, Math.min(rd.tMax, start + 12));
  let type = 'turn';
  if (a && b && a.twa != null && b.twa != null && (a.twa < 0) !== (b.twa < 0))
    type = (Math.abs(a.twa) + Math.abs(b.twa)) / 2 < 90 ? 'tack' : 'gybe';

  return { t: start, end, peak, type, count: before.length };
}

/* Ratio at the sampling times the table reports. Kept as one list so the
 * column and its header cannot drift apart. */
const RATIO_MARKS = [-30, -15, -5];

function ratioStats(rd, team) {
  const onboard = {}, polar = {};
  for (const m of RATIO_MARKS) {
    onboard[m] = loggedRatioAt(rd, team, m);
    const r = ratioAt(rd, team, m);
    polar[m] = r ? r.ratio : null;
  }
  // and at the last tack or gybe, which is what the report leads with
  const man = lastManoeuvre(rd, team);
  let atMan = null;
  if (man) {
    const r = ratioAt(rd, team, man.t);
    atMan = {
      t: man.t, type: man.type, count: man.count,
      onboard: loggedRatioAt(rd, team, man.t),
      polar: r ? r.ratio : null,
    };
  }
  return { onboard, polar, manoeuvre: atMan };
}

/* The boat's own ratio as a series, straight off the gated channel. Gaps are
 * left as gaps — the PC's sentinel windows are real and drawing through them
 * would claim a reading the boat never made. */
function loggedRatioSeries(rd, team) {
  const tr = rd.tracks[team];
  if (!tr || !tr.raw.pcRatio) return [];
  const out = [];
  for (let i = 0; i < tr.n; i++) {
    const v = tr.raw.pcRatio[i];
    if (v == null || tr.t[i] > 0) continue;
    out.push({
      t: tr.t[i], ratio: v,
      ttk: tr.raw.pcTtk ? tr.raw.pcTtk[i] : null,
      tts: tr.raw.pcTts ? tr.raw.pcTts[i] : null,
    });
  }
  return out;
}

/* ── reach order at M1 ──────────────────────────────────────────────────────
 *
 * Method hierarchy, best first, and the one that fired is stored on the result:
 *   1 perpendicular  — projection onto the line-mid -> M1 axis crosses M1's own
 *                      projection. One shared plane for all boats, so rounding
 *                      radius does not bias the order.
 *   2 closest        — minimum distance to M1. Times the minimum during the
 *                      turn, so it runs systematically late.
 *   3 axis-proxy     — distance along the leg axis at a fixed time. Used when
 *                      the window does not reach M1 at all.
 *
 * Confidence comes from closest-approach distance, and is gated PER RACE, not
 * per boat: mixing time-ranked and proxy-ranked boats in one ranking is
 * incoherent.
 */
function m1Order(rd) {
  if (!rd.frame.m1R)
    return { order: [], rows: [], method: 'none', confidence: 'NONE',
             note: 'no M1 in the course file' };

  const axisM1 = rd.frame.legAxis(rd.frame.m1R);
  const rows = [];

  for (const team of rd.activeTeams) {
    const tr = rd.tracks[team];
    let tCross = null, prev = null, closest = Infinity, tClosest = null;

    for (let t = 0; t <= rd.tMax; t += 0.2) {
      const s = sampleAt(tr, t); if (!s) { prev = null; continue; }
      const a = rd.frame.legAxis(s);
      const d = rd.frame.m1Dist(s);
      if (d < closest) { closest = d; tClosest = t; }
      if (prev && prev.a < axisM1 && a >= axisM1 && tCross == null)
        tCross = +(prev.t + (t - prev.t) * ((axisM1 - prev.a) / (a - prev.a))).toFixed(1);
      prev = { t, a };
    }

    const conf = closest < 20 ? 'HIGH' : closest < 60 ? 'MEDIUM' : 'LOW';
    // distance along the axis at the end of the window, for the proxy ranking
    const last = sampleAt(tr, rd.tMax);
    rows.push({
      team, tCross, tClosest,
      closest: isFinite(closest) ? closest : null,
      confidence: conf,
      axisEnd: last ? rd.frame.legAxis(last) : null,
    });
  }

  const ok = rows.filter(r => r.confidence !== 'LOW' && r.tCross != null).length;
  const share = rows.length ? ok / rows.length : 0;

  let method, note;
  if (share >= 0.8) {
    method = 'perpendicular';
    note = 'ranked by time crossing the M1 plane';
    rows.sort((a, b) => (a.tCross ?? 1e9) - (b.tCross ?? 1e9));
  } else if (rows.some(r => r.tClosest != null && r.closest < 120)) {
    method = 'closest-approach';
    note = 'ranked by closest approach to M1 — runs late, treat as approximate';
    rows.sort((a, b) => (a.tClosest ?? 1e9) - (b.tClosest ?? 1e9));
  } else {
    method = 'axis-proxy';
    note = `ranked by distance along the leg axis at T+${rd.tMax.toFixed(0)}s — ` +
           'the window does not reach M1';
    rows.sort((a, b) => (b.axisEnd ?? -1e9) - (a.axisEnd ?? -1e9));
  }

  // Boats over the line at the gun go to the back, whatever their rounding
  // time. Getting to M1 first off an OCS start is not winning the start, and
  // leaving them on the podium made the maps read as if it were. The sort is
  // stable, so the order within each group is the one the method produced.
  const ocs = new Set(rd.startStats.filter(s => s.ocs).map(s => s.team));
  const nOCS = rows.filter(r => ocs.has(r.team)).length;
  rows.sort((a, b) => (ocs.has(a.team) ? 1 : 0) - (ocs.has(b.team) ? 1 : 0));

  return { rows, order: rows.map(r => r.team), method, note,
           confidence: share >= 0.8 ? 'HIGH' : share > 0 ? 'MEDIUM' : 'LOW',
           qualifiedShare: share, ocsDemoted: nOCS };
}

/* Bearing, distance and TWA from each end of the line to M1.
 *
 * TWA follows the logs' own convention — TWA = TWD − heading, normalised to
 * ±180, positive = starboard. Deriving it the other way round would flip the
 * sign against every TWA already in the race file, which is the kind of quiet
 * inconsistency that only shows up when someone trusts it.
 *
 * The two ends differ because they sit at different points along the wind axis:
 * from the windward end you are further upwind of M1 and sail a broader angle
 * down to it. On Sassnitz start 12 that is 100 deg from the windward end
 * against 78 deg from the leeward — the same leg, 22 deg apart.
 */
function endsToM1(rd) {
  const M = rd.raw.marks;
  if (!M.M1 || rd.wind.twd == null) return null;
  const one = end => {
    const b = brg(end.lat, end.lon, M.M1.lat, M.M1.lon);
    const twa = ((rd.wind.twd - b + 540) % 360) - 180;
    return {
      bearing: +b.toFixed(1),
      distM: +hav(end.lat, end.lon, M.M1.lat, M.M1.lon).toFixed(0),
      twa: +twa.toFixed(1),
      tack: twa >= 0 ? 'stbd' : 'port',
    };
  };
  return { windward: one(M.windward), leeward: one(M.leeward) };
}

/* ── time to M1, and what it implies about where to start ───────────────────
 *
 * Time from a point to M1 at the polar's best speed made good on that bearing.
 * Everything below is built on this one function.
 */
function timeToM1(rd, rx, ry) {
  const f = rd.frame;
  if (!f.m1R || !rd.vmc || rd.wind.twd == null) return null;
  const dx = f.m1R.rx - rx, dy = f.m1R.ry - ry;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return 0;
  const brgToMark = f.bearingFromRot(dx, dy);
  const v = vmcAt(rd.vmc, rd.wind.twd, brgToMark);          // km/h
  if (!v || v <= 0) return null;
  return dist / (v / 3.6);                                   // seconds
}

const pointOnLine = (f, alongM) => ({
  rx: f.leeR.rx + f.u.x * alongM,
  ry: f.leeR.ry + f.u.y * alongM,
});

/* The FAST POINT: where along the line M1 is reached soonest.
 *
 * Not necessarily an end. Time to M1 is distance divided by a speed that
 * itself varies with the bearing, so the two terms trade against each other
 * and the minimum can sit anywhere along the line — or past an end, which is
 * worth knowing too.
 */
function fastPointOnLine(rd) {
  const f = rd.frame;
  if (!f.m1R || !rd.vmc) return null;
  const L = f.lineLen;
  let best = null;
  for (let pct = -50; pct <= 150; pct += 0.25) {
    const p = pointOnLine(f, pct / 100 * L);
    const t = timeToM1(rd, p.rx, p.ry);
    if (t == null) continue;
    if (!best || t < best.t) best = { t, pct, along: pct / 100 * L };
  }
  if (!best) return null;

  const tLee  = timeToM1(rd, f.leeR.rx,  f.leeR.ry);
  const tWind = timeToM1(rd, f.windR.rx, f.windR.ry);

  /* The angle the fast point BUYS you: the bearing of the first board off the
   * line from that spot, and its TWA. The percentage says where to be and the
   * seconds say what it is worth; this says what you will be sailing when you
   * get there, which is the number you set the boat up on. Positive TWA is
   * starboard, the same convention as everywhere else. */
  const bp = pointOnLine(f, best.along);
  const brgToM1 = f.bearingFromRot(f.m1R.rx - bp.rx, f.m1R.ry - bp.ry);
  const twaToM1 = rd.wind.twd == null ? null
                : ((rd.wind.twd - brgToM1 + 540) % 360) - 180;

  return Object.assign(best, {
    brgToM1, twaToM1,
    tLeeward: tLee, tWindward: tWind,
    gainVsLeeward:  tLee  == null ? null : tLee  - best.t,
    gainVsWindward: tWind == null ? null : tWind - best.t,
    endSpread: (tLee != null && tWind != null) ? tWind - tLee : null,
    onLine: best.pct >= 0 && best.pct <= 100,
  });
}

/* The ADVANTAGE PROFILE along the line, relative to the pin.
 *
 * For each position along the start line, how much better off you are there
 * than at the pin, measured two ways:
 *
 *   advSec  seconds sooner you reach M1
 *   advM    metres of head start that is worth — the perpendicular distance
 *           you could give away at that position and still arrive level
 *
 * advM is the useful one to draw, because it is in the same units as the map:
 * a 25 m advantage is 25 m on screen, directly comparable to where the boats
 * actually are. Seconds are the honest quantity but nobody can eyeball a
 * second against a start line.
 *
 * advM is solved by bisection rather than derived from advSec, because the
 * conversion factor is the speed made good on a bearing that itself changes as
 * you move off the line. Dividing seconds by a nominal boat speed would be
 * close, but wrong in exactly the region where the curve is most interesting.
 */
function advantageProfile(rd, pinEnd) {
  const f = rd.frame;
  if (!f.m1R || !rd.vmc) return null;
  const pin = pinEnd === 'windward' ? f.windR : f.leeR;
  const T0 = timeToM1(rd, pin.rx, pin.ry);
  if (T0 == null) return null;

  const L = f.lineLen;
  const at = (alongM, off) => {
    const p = pointOnLine(f, alongM);
    return timeToM1(rd, p.rx + f.n.x * off, p.ry + f.n.y * off);
  };

  const pts = [];
  for (let pct = -10; pct <= 110; pct += 1) {
    const alongM = pct / 100 * L;
    const t = at(alongM, 0);
    if (t == null) continue;

    // metres of head start: solve time(point + n*off) == T0
    let advM = null;
    let lo = -900, hi = 900;
    const tLo = at(alongM, lo), tHi = at(alongM, hi);
    if (tLo != null && tHi != null && (tLo - T0) * (tHi - T0) <= 0) {
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        const tm = at(alongM, mid);
        if (tm == null) break;
        if ((tLo - T0) * (tm - T0) <= 0) hi = mid; else lo = mid;
      }
      advM = (lo + hi) / 2;
    }
    pts.push({ pct, alongM, t, advSec: T0 - t, advM });
  }
  if (pts.length < 3) return null;

  const onLine = pts.filter(p => p.pct >= 0 && p.pct <= 100);
  const peak = (onLine.length ? onLine : pts)
    .reduce((a, b) => (b.advSec > a.advSec ? b : a));
  const nearest = p => pts.reduce((a, b) =>
    Math.abs(b.pct - p) < Math.abs(a.pct - p) ? b : a);

  return {
    pin: pinEnd, T0, pts, peak,
    otherEnd: nearest(pinEnd === 'windward' ? 0 : 100),
  };
}

/* ── validation ─────────────────────────────────────────────────────────────
 * Config and data problems shipped silently in the M32 tool for months.
 * Everything checked here surfaces as a visible banner, never a console log.
 */
function validate(rd) {
  const w = rd.warnings;
  const R = rd.raw;

  if (R.line.lengthM < 50 || R.line.lengthM > 800)
    w.push(`start line is ${R.line.lengthM} m — implausible, check the course file`);

  if (R.courseBinding !== 'raceStartTime')
    w.push(`course file ${R.courseFile} was not matched to this start by time ` +
           `(${R.courseBinding}) — marks may be from a different race`);

  if (rd.wind.confidence === 'LOW' || rd.wind.twd == null)
    w.push(`wind direction confidence is ${rd.wind.confidence} — the windward/leeward ` +
           'end labels and the frame orientation depend on it');

  if (rd.frame.normalMethod === 'assumed')
    w.push('no M1 in the course file, so which side of the line is "pre-start" ' +
           'was assumed, not derived');

  for (const [team, why] of rd.excluded)
    w.push(`${team} excluded from the analysis — ${why}`);

  if (!rd.activeTeams.length)
    w.push(`no boat was within ${EXCLUDE_DTL_M} m of the line and inside half a ` +
           'line length of its ends at the gun — nothing to report for this start');

  for (const st of rd.startStats) {
    if (st.sogGun != null && st.sogGun < 18)
      w.push(`${st.team} was doing ${st.sogGun.toFixed(1)} km/h at the gun — ` +
             'this looks like a countdown that was not sailed, not a start');
  }

  if (!rd.configs.length)
    w.push('no config_id in this day\'s export, so there is no polar: laylines, ' +
           'the fast point, the advantage curve and the wave are all off. ' +
           'Fix with tools/set-config.py, or re-run prep.py --config on the raw logs');
  else if (rd.configs.length > 1)
    w.push(`boats ran different configs (${rd.configs.join(', ')}) — one layline ` +
           'cannot describe the fleet, so laylines are off');
  else if (!rd.polar)
    w.push(`no polar file for config ${rd.configs[0]} — laylines are off`);
  else if (!rd.targetUp)
    w.push(`TWS ${rd.wind.tws} km/h is outside the polar's range — laylines are off`);
  else if (rd.targetUp.method !== 'interpolated')
    w.push(`TWS ${rd.wind.tws} km/h is at the edge of the polar ` +
           `(${rd.targetUp.method}) — the layline angle is clamped, not interpolated`);

  if (rd.fastPoint && !rd.fastPoint.onLine)
    w.push(`the quickest point to M1 is ${rd.fastPoint.pct.toFixed(0)} % along the ` +
           'line, i.e. past an end — no position on the line itself is optimal');
  if (rd.vmc && rd.fastPoint && rd.fastPoint.endSpread != null &&
      Math.abs(rd.fastPoint.endSpread) < 0.5)
    w.push('the two line ends are within half a second of each other on time ' +
           'to M1 — the line is square for this leg, so the advantage curve is flat');

  // say which authority the OCS calls came from, every time
  const srcs = new Set(rd.startStats.filter(s => s.ocs).map(s => s.ocsSource));
  if (srcs.size && !srcs.has('umpire'))
    w.push('OCS is derived, not the umpires\' call — this race carries no ' +
           'ALARM_PENALTY_OCS_unk, so the flags come from ' +
           [...srcs].join(' and ') + ' distance and may not match the jury');
  if (rd.m1.ocsDemoted)
    w.push(`${rd.m1.ocsDemoted} boat${rd.m1.ocsDemoted > 1 ? 's' : ''} over the line ` +
           'at the gun, moved to the back of the reach order regardless of ' +
           'rounding time');

  if (rd.m1.method === 'closest-approach')
    w.push('reach order fell back to closest approach — it times the minimum ' +
           'during the turn, so it runs late; treat the order as approximate');
  else if (rd.m1.method === 'axis-proxy')
    w.push('reach order is a distance-along-axis proxy — no boat got close ' +
           'enough to M1 in the window for a rounding time');
  if (rd.m1.rows.length && rd.m1.rows.every(r => r.confidence === 'LOW'))
    w.push('every boat\'s closest approach to M1 is over 60 m — these are leg ' +
           'completions, not roundings');

  for (const team of rd.activeTeams) {
    const b = rd.raw.boats[team];
    if (b.speedCheck != null && Math.abs(b.speedCheck - 1) > 0.05)
      w.push(`${team}: logged speed disagrees with GPS-derived speed by ` +
             `${((b.speedCheck - 1) * 100).toFixed(0)}%`);
    const span = b.t[b.t.length - 1] - b.t[0];
    if (b.t.length < span * 0.8)
      w.push(`${team}: ${(span - b.t.length).toFixed(0)} samples missing across ` +
             `the ${span.toFixed(0)}s window`);
    if (!rd.entries[team])
      w.push(`${team}: no port entry detected in T-130..T-20`);
    else if (rd.entries[team].method === 'any-crossing')
      w.push(`${team}: port-entry fallback used — the crossing found was not ` +
             'on port past a line end');
  }
}
