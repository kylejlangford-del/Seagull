/* ── ratio-target colouring ─────────────────────────────────────────────────
 *
 * The start ratio is time you have / time you need. Above 1 you have surplus to
 * burn; below 1 you cannot make the line at the gun even at full potential. A
 * crew sails to a target — "get it down to 1.8 by the entry" — so the useful
 * question while watching is not what the number is, it is which side of the
 * target each boat is on, at a glance, without reading thirteen numbers.
 *
 * Hence: red above target, green at or below it, and a double flash at the
 * moment a boat's ratio passes through 1.00 — the number it is ultimately
 * steering for.
 */

const RATIO_RED = '#ff4d5e';
const RATIO_GREEN = '#3ddc84';
const RATIO_FLASH = '#b9ffcf';
const RATIO_NONE = '#5b6b7f';
/* Late / on-time / early, off the Z verdict — amber sits between red and
 * green because EARLY is not the goal the way ON TIME is, it is slack you
 * could be spending; the pink itself is left for Z's own ink so this column
 * never gets confused for the pin. */
const Z_ENTRY_INK = { late: RATIO_RED, ok: RATIO_GREEN, early: '#ffbe5a' };

/* Two flashes, 0.4 s of replay time each. Driven by the replay clock rather than
 * wall time on purpose: scrub back over the moment and it flashes again, the same
 * way, instead of firing once and never repeating. */
const FLASH_STEP = 0.4;
const FLASH_N = 4;               // on, off, on, off

const RATIO = {
  on: true,
  target: 1.8,
  crossings: new Map(),          // team -> [t, …] where the ratio passed through 1
};

/* Where each boat's ratio crosses 1.00, found once per race rather than per frame.
 * The onboard channel is gappy, so a crossing is either a sign change across two
 * live samples or a sample sitting inside a small band around 1. */
function findRatioCrossings(rd, step = 0.25, band = 0.02) {
  RATIO.crossings = new Map();
  for (const team of rd.teams) {
    const hits = [];
    let prev = null, prevT = null, lastHit = -1e9;
    for (let t = rd.tMin; t <= 0; t += step) {
      const d = displayRatio(rd, team, +t.toFixed(2));
      const v = d && d.value != null ? d.value : null;
      if (v != null) {
        const near = Math.abs(v - 1) <= band;
        // A crossing has to be a TRANSIT, not a jump. The onboard channel drops
        // out and recovers, so consecutive live samples of 3.9 then 0.33 pass a
        // naive sign test while the boat never went near 1.00. Require the two
        // samples to be adjacent in time and within a ratio of each other.
        const adjacent = prevT != null && t - prevT <= step * 2.5;
        const smooth = prev != null && Math.abs(v - prev) <= 1.0;
        const crossed = adjacent && smooth && (prev - 1) * (v - 1) < 0;
        if ((near || crossed) && t - lastHit > FLASH_STEP * FLASH_N) {
          hits.push(+t.toFixed(2));
          lastHit = t;
        }
        prev = v; prevT = t;
      } else if (prevT != null && t - prevT > 2) {
        prev = null;             // a gap that long is not a trajectory
      }
    }
    RATIO.crossings.set(team, hits);
  }
}

function ratioColourFor(rd, team, t) {
  if (t == null) return null;
  for (const tc of RATIO.crossings.get(team) || []) {
    const phase = (t - tc) / FLASH_STEP;
    if (phase >= 0 && phase < FLASH_N) {
      return Math.floor(phase) % 2 === 0 ? RATIO_FLASH : RATIO_GREEN;
    }
  }
  const d = displayRatio(rd, team, t);
  if (!d || d.value == null) return RATIO_NONE;
  return d.value > RATIO.target ? RATIO_RED : RATIO_GREEN;
}

/* Still APPROACHING the box between the line's two ends, not yet inside it —
 * linePct's own definition of "off the end", read for every boat rather than
 * only the one Z retires for. This is the moment the Z spot is the honest
 * question ("can this boat still get there"); once a boat is between the
 * ends the ratio-to-target burn is what a start is actually judged on, and
 * showing the Z verdict past that point would be answering a question the
 * boat has already answered by arriving. */
function boatEntering(rd, team, t) {
  const tr = rd.tracks[team], s = tr && sampleAt(tr, t);
  if (!s || !rd.frame) return false;
  const pct = rd.frame.linePct(s);
  return pct < 0 || pct > 100;
}

/* The fleet table's Z column: which boats can still make the Z spot, while
 * they are still outside the line's ends. ttkZBoat / zEntryClass live in
 * app.js (script order puts ratio.js first); guarded the same way CONE is
 * guarded in metrics.js, since this file has to parse before app.js runs. */
function zFleetVerdict(rd, team, t) {
  if (typeof ZPT === 'undefined' || !ZPT.on || !ZPT.p) return null;
  if (!boatEntering(rd, team, t)) return null;
  if (typeof ttkZBoat !== 'function' || typeof zEntryClass !== 'function') return null;
  const q = ttkZBoat(rd, t, team);
  const cls = zEntryClass(q);
  return cls ? { cls, ttk: q.ttk } : null;
}

/* Every boat, always labelled LATE or EARLY — not just the ones still
 * outside the line's ends. While a boat is approaching Z (boatEntering, Z
 * set) the label is the Z verdict collapsed to two words: LATE stays LATE,
 * both OK and EARLY read as EARLY — the ink keeps the three-way distinction
 * (amber for genuinely early, green for merely on time) even though the
 * word does not. Once a boat has entered the box, or when there is no Z
 * pin, the label falls back to the ordinary ratio-to-target read: over
 * target is time you don't have (LATE, red), at or under it is time in
 * hand (EARLY, green) — the same rule ratioColourFor already paints the
 * row with, just spelled out. Null only when there is no ratio data at all
 * to judge by. */
function fleetEntryTag(rd, team, t) {
  const z = zFleetVerdict(rd, team, t);
  if (z) {
    const late = z.cls === 'late';
    return { text: late ? 'LATE' : 'EARLY', ink: Z_ENTRY_INK[z.cls],
             title: z.ttk == null ? 'cannot make the Z spot on this heading'
                  : `TTK to Z: ${(z.ttk > 0 ? '+' : '') + z.ttk.toFixed(1)}s · ${z.cls.toUpperCase()} entry` };
  }
  const d = displayRatio(rd, team, t);
  if (!d || d.value == null) return null;
  const late = d.value > RATIO.target;
  return { text: late ? 'LATE' : 'EARLY', ink: late ? RATIO_RED : RATIO_GREEN,
           title: `ratio ${d.value.toFixed(2)} vs target ${RATIO.target.toFixed(2)}` };
}

/* The live per-boat readout beside the player — the same judgement as the colours,
 * in numbers, for when you need to say which boat rather than point at it. */
function renderRatioNow(rd, t, el, label) {
  if (label) label.textContent = `T${t < 0 ? '−' : '+'}${Math.abs(t).toFixed(1)}`;
  // After the gun there is no line left to be early or late for. The onboard
  // channel keeps logging a number for a few seconds past it and it means
  // nothing; showing it would be the tracker's most-read panel quietly lying.
  if (t >= 0) {
    el.innerHTML = '<div class="gunned">gun — the start is sailed</div>';
    return;
  }
  const CAP = 4;
  // One header line for the column pair. Two numbers per row with no captions
  // is a table you have to be told how to read.
  const head = '<div class="rnow rhead"><span class="rt"></span>'
             + '<span class="rv">RATIO</span><span class="rbar"></span>'
             + '<span class="rk">TTK</span></div>';
  const rows = rd.activeTeams.map(team => {
    const d = displayRatio(rd, team, t);
    /* Seconds to kill to the LINE, per boat, from the same polar routine MY
     * BOAT's TO KILL runs on — so the fleet column and your own headline can
     * never disagree about your own number.
     *
     * A boat already over the line is given a dash rather than a figure. Past
     * the line time-to-kill is arithmetically the whole countdown and means
     * nothing, and a big green number against a boat that is over is the one
     * thing this column must not say. */
    const rr = typeof ratioAt === 'function' ? ratioAt(rd, team, t) : null;
    /* The sample can be missing, and dtl() dereferences what it is handed.
     * At the very first instant of a race a boat whose track has not started
     * yet returns null here, dtl threw on it, and the exception came out of
     * draw() — so ONE boat with no sample blanked the whole frame: map,
     * readouts and all. Guarded, that boat simply has no ratio row content
     * until its track begins. */
    const ms = sampleAt(rd.tracks[team], t);
    const dtl = ms && rd.frame && rd.frame.dtl ? rd.frame.dtl(ms) : null;
    /* dtl is signed distance to the INFINITE line, not the finite segment
     * between the ends — a boat on port still out past the line's own
     * EXTENSION can already read dtl <= 0 without having crossed anything
     * real. That is exactly the population boatEntering()/the Z verdict
     * exist to describe, so it must not also masquerade as OVER: a boat
     * approaching the boat end from outside on port is entering, not
     * disqualified. True OVER — past the real line, inside its ends, or on
     * starboard past the extension — is untouched. */
    const enteringOnPort = ms && ms.twa != null && ms.twa < 0 && boatEntering(rd, team, t);
    const ttk = (dtl != null && dtl <= 0 && !enteringOnPort) || !rr || rr.ttk == null
      ? null : rr.ttk;
    /* Z takes over the row's judgement while a boat is still outside the
     * line's ends and Z is set; the moment it crosses in, the row is back to
     * the ordinary ratio-to-target reading — that switch is `z` being null. */
    const z = zFleetVerdict(rd, team, t);
    const over = dtl != null && dtl <= 0 && !enteringOnPort;
    return { team, v: d && d.value != null ? d.value : null,
             src: d ? d.source : null,
             col: z ? Z_ENTRY_INK[z.cls] : ratioColourFor(rd, team, t),
             ttk, over, z, tag: over ? null : fleetEntryTag(rd, team, t) };
  }).sort((a, b) => (a.v == null) - (b.v == null) || (a.v - b.v));

  el.innerHTML = head + rows.map(r => {
    const w = r.v == null ? 0 : Math.min(1, r.v / CAP) * 100;
    const tgt = Math.min(1, RATIO.target / CAP) * 100;
    // The RK column: every boat labelled LATE or EARLY (fleetEntryTag), the
    // word itself doing the at-a-glance job the numbers used to, with the
    // number that earned it moved into the tooltip. OVER stays its own word
    // — over the line is disqualified, not "late" — and a boat with no
    // ratio data at all still falls back to the bare TTK-to-line figure.
    const zTag = r.over
      ? '<span class="rk over">OVER</span>'
      : r.tag
      ? `<span class="rk zent" style="color:${r.tag.ink}" title="${r.tag.title}">${r.tag.text}</span>`
      : `<span class="rk">${r.ttk == null ? '—' : r.ttk.toFixed(1)}</span>`;
    return `<div class="rnow" title="${r.src ? r.src + ' channel' : 'no ratio logged'}">
      <span class="rt" style="color:${r.col}">${r.team}</span>
      <span class="rv" style="color:${r.col}">${r.v == null ? '—' : r.v.toFixed(2)}</span>
      <span class="rbar"><i style="width:${w}%;background:${r.col};opacity:.75"></i>
        <span class="tgt" style="left:${tgt}%"></span></span>
      ${zTag}
    </div>`;
  }).join('');
}

/* Colour the boats by ratio instead of by finishing position.
 *
 * Done by rebinding two of the renderer's own functions rather than editing
 * vendor.js, so the vendored file stays byte-identical to upstream and a future
 * fix can be dropped straight in. `boatColour` has no time argument — it never
 * needed one — so `drawBoat` is wrapped to record the frame's clock first, and
 * the replacement colour function reads it. Both are plain top-level function
 * declarations in a classic script, so the bindings are writable and every
 * internal call site picks up the new ones. */
const _origBoatColour = boatColour;

/* The team's OWN colour, whatever the ratio colouring is doing.
 *
 * boatColour is rebound below to answer with the ratio colour before the gun,
 * which is what you want for the hull — it is the whole point of TARGET
 * COLOURS. It is not what you want for the TRAIL: with the fleet on target,
 * every boat trails green and the six tracks behind them stop being tellable
 * apart, which is exactly when a pre-start picture is worth reading. So the
 * trail asks for this instead. A function declaration, not a const, so
 * render.js can `typeof` it without meeting a temporal dead zone. */
function teamInk(rd, team) { return _origBoatColour(rd, team); }
const _origDrawBoat = drawBoat;
let _frameT = null;

drawBoat = function (ctx, rd, team, t, ...rest) {
  _frameT = t;
  return _origDrawBoat(ctx, rd, team, t, ...rest);
};

boatColour = function (rd, team) {
  if (RATIO.on && _frameT != null && _frameT < 0) {
    const c = ratioColourFor(rd, team, _frameT);
    if (c) return c;
  }
  return _origBoatColour(rd, team);
};
