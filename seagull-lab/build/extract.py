#!/usr/bin/env python3
"""extract.py — pull the tracker's engine out of the start-review page.

Seagull Lab does not fork the start-review renderer, it *extracts* it. Five of
the eight files in js/ are lifted from that page's bundled index.html by this
script, with a small, named set of patches applied on the way through. Nothing
in those five files is hand-edited here, which means:

  * a fix made in start-review reaches this tracker by re-running the script,
    not by hand-merging two diverged copies of an 1800-line renderer;
  * every deviation from the source is written down below, as a patch with a
    reason, rather than being invisible in a diff nobody runs.

The three hand-written files — feed.js, app.js, mock-live.js — are the live
tool itself and are not touched.

    python3 build/extract.py ../start-review/index.html

Re-run it, then re-run the browser check, whenever start-review changes.

HAND EDITS IN js/render.js NOT YET FOLDED IN HERE — re-running this script will
lose them, so fold them in first. Each was made directly in js/render.js during
the tidy-up pass, and each needs to become a patch below (one edit in
js/metrics.js is listed at the end):

  * waveBand() keeps one offscreen canvas instead of allocating a full-size,
    DPR-scaled one per frame;
  * drawWave() sorts the two wave fronts before banding them, so a WAVE RATIO
    below 1.00 no longer punches the outer region out of itself and erases the
    whole overlay; the unreachable "nothing left to draw" label went with it;
  * themeInk() now also carries the boat, course, finish and scale-bar inks and
    the caption plates, all of which were hardcoded for dark water and so
    vanished on light, and it is called once at load as well as on every change
    of water;
  * the compass rose points INTO the wind, like every other arrow on the map;
  * the trail loop is clamped to rd.tMin and stepped in proportion to the span,
    so TRAILS = everything is 400 points rather than 2000 mostly-null lookups;
  * a wind arrow with no meaningful shift is drawn in MAP_INK.faint rather than
    falling through to the wind-SPEED ramp, which made a neutral arrow in a
    strong patch red and so indistinguishable from a left shift;
  * the layline captions are drawn just past the END of each ray — outside the
    boundary — instead of half way along it, where eight of them landed in the
    busiest water on the map. The step is in pixels so the gap holds at every
    zoom, and the text aligns away from the line rather than back over it;
  * drawCourseLaylines() strokes solid rather than [9,6] — with the route, the
    next leg, the projection and the boundary all dashed, one more dashed
    family made the map unreadable;
  * the mark wind arrows fly WITH the wind (twd + 180) rather than into it; the
    number beside each one still names the direction it comes FROM;
  * offsetPoly() accepts a negative distance and insets, where it used to
    `return null` for anything but a positive one — and BOUNDARY_BAND is now
    shaded INSIDE the stored polygon, so the file's own ring is the outer limit
    that the laylines, the bounce and out-and-back all end on;
  * a gate's two marks no longer have a dashed rung drawn between them — it
    read as a barrier across water boats sail through. The finish keeps its
    line, because that one is a line you cross;
  * the projection carries a ball every PROJECTION_TICK_S (5 s), so the line
    reads as time as well as reach;
  * the shipped defaults are the view the tool opens on: WAVE_RATIO.on,
    LAYLINE {on, source:'marks'}, WIND_VIEW.live 'marks', TRAIL_SEC 10 and
    PROJECTION.sec 20;
  * renderRatioNow() in js/ratio.js carries a TTK column: seconds to kill to the
    line per boat, from ratioAt(), on the far side of the bar, with a header row
    naming RATIO and TTK. A boat past the line reads OVER rather than a figure;
    MY BOAT's own TO KILL uses the same routine, so the two cannot disagree;
  * the map grid and the scale bar share ONE step, gridStepFor(mpp), and it has
    only two values: 50 m while a square is at least GRID_SWITCH_PX (40 px)
    across, 200 m beyond that. The old 1/2/5/10 decade ladder gave a different
    square at every zoom, so the bar is now a legend for the grid rather than an
    independent measurement;
  * drawGrid(ctx, W, H, mpp, angRad, ox, oy) can be TURNED. It was screen-
    aligned — lines at constant frame x and y straight to pixels, no rotation —
    which made it a ruler and nothing else. Given an angle it becomes a frame of
    reference: square to the wind, one family of lines IS the ladder rung. It is
    drawn in screen space, and (ox, oy) is the frame origin as tX(0,0)/tY(0,0)
    give it, which is what pins the grid to the water under a pan. Deriving that
    anchor inside drawGrid from the view centre and the GRID's own angle mixes
    two different rotations and leaves the grid nailed to the window. app.js
    passes opts.grid and opts.gridAng — the switch and the bearing, resolved
    there because the angle can come off the wind sources or the focus boat;
  * drawWindField()'s arrows fly WITH the wind (twd + 180). The live mark arrows
    still point into it: those are instrument readings from one spot, this is a
    field, and a field reads as flow;
  * fastPointOnLine() in js/metrics.js returns brgToM1 and twaToM1 — the bearing
    and TWA of the first board off the line from the fast point. The chip's text
    is built once by fastPointLines(rd) and used by BOTH fastPointChipRect (which
    measures the box) and drawFastPoint (which fills it); they used to build the
    same list from two copies of the same expressions, so a line added to one
    was a line drawn outside its own box;
  * LAYLINE carries `target`, defaulting to 'gate': 'marks' draws a layline back
    from each gate mark, 'gate' one pair back from the gate's middle.
    laylineRays() reads it;
  * drawBoat() draws no ratio at the tip of the projection when opts.stbdApproach
    — we are on starboard in the countdown, where that number is a consequence
    rather than a decision and the map is at its most crowded;
  * js/ratio.js exports teamInk(rd, team) — the ORIGINAL boatColour, kept before
    the ratio colouring rebinds it — and drawBoat() paints the TRAIL with that
    rather than with the ratio colour. Before the gun a fleet holding 1.00 is a
    fleet of identical green hulls, and identical green trails behind them are
    six tracks you cannot tell apart at the one moment they are worth reading;
  * renderRatioNow() also NULL-GUARDS the sample it hands to frame.dtl(). At the
    first instant of a race a boat whose track has not started yet has no
    sample, dtl() dereferences what it is given, and the exception escaped
    draw() — so one boat with no data blanked the entire frame, map included;
  * waveFan()/waveRegion()/waveBand() take a metre PAD added to every arm's
    reach, and drawWave() uses it to lay a black band WAVE_OUTSIDE.m (300 m)
    deep on the far side of the ratio-1.00 front — the fan re-run 300 m bigger
    with the plain front punched out of it. A depth in metres rather than a
    stroke in pixels, so the wave line is the same piece of water at every zoom;
  * drawFastPoint()'s placement is split out as fastPointChipRect(ctx, rd, tX,
    tY, W, H), which returns the chip's rectangle without drawing it. app.js's
    drawEndLegs runs EARLIER in the frame and would be painted over, so it asks
    for that rectangle and steps its LINE TO M1 plates out of the way rather
    than guessing at a second copy of the same placement. It now goes further:
    those plates and this chip are laid out as ONE left-aligned column, top end
    of the line / fast point / bottom end in screen order, so fastPointChipRect
    returns rd._startStack.chip when app.js has set it (cleared every frame by
    drawEndLegs, so it can never be stale);
  * drawFrame keeps its viewport in LAST_VIEW and exposes screenToFrame() /
    frameToScreen(), the exact inverse and forward of its own tX/tY including
    the map rotation. Nothing on this map needed to go backwards until Z, whose
    pin is dragged: a pointer has to become a place;
  * drawFrame calls drawZ() (in app.js) after drawCrossLines — the hand-dropped
    Z spot and its port-tack route;
  * drawFrame calls drawStartLaylines() (in app.js) beside drawEndLegs();
  * drawLaylines() is DELETED — two dashed starboard rays off the start-line
    ends, drawn from the race TWD and never updated. START LAYLINES in app.js
    replaces them with the same geometry off a live, chosen wind. Its caption
    plate moved into drawAdvantage(ctx, rd, tX, tY, H), which is the curve it
    was describing, and lost the `LAYLINE 47° STBD` prefix that named the rays;
  * drawWindLive() draws MARK sources only, whatever WIND_VIEW.live says: an
    F50's arrow lands on top of the F50 — hull, trail, speed label and, in a
    compressed fleet, five other boats' arrows — and moves at 40 knots. The
    mastheads still feed the averages and the field; they are simply not drawn;
  * windWants()/windSources() understand a 'selected' source: it passes both
    kinds and then sieves instrument by instrument against windPicked() in
    app.js, so an unticked mark or masthead is dropped from the live arrows and
    from the field. windFieldSources() takes the selection as an argument and
    drawWindField() passes 'selected' through to the MATHS as well as the dots
    — the only source setting that does, because the point of unticking a
    sensor is not believing it;
  * drawHull() draws the F50 in plan — fine bows, two crossbeams, the wing on
    the centreline and the foil and rudder tips splayed outboard — instead of
    two lozenges and a single bar, and the focus boat gets a halo of its own
    colour, a heavier hull outline and a 2.6 px projection with a bigger head;
  * the ratio-1.00 wave fills with MAP_INK.waveFill — shadeOfWater(MAP_INK.bg),
    a new helper beside inkLuma — instead of a hard '#000000'. On near-black
    water black IS a shade of the water, so nobody noticed; on any lighter one
    the pre-start zone was an opaque black slab over the boats, the boundary
    and every label inside it;
  * the wave and fast-point captions, and the layline advantage caption, read
    MAP_INK.waveTxt / .waveRTxt / .fastTxt / .cap so they survive light water;
  * the last dark-only chips and buoy outlines read MAP_INK.chip / .buoyEdge,
    so they invert with the water like everything else;
  * drawFastPoint() takes H and places its chip across the line on the course
    side, off the frame's own normal, instead of at a hardcoded `x + 14` that
    parked it over the fleet;
  * drawFrame calls drawEndLegs() (in app.js) just before drawStartLine, and
    drawStartLine suppresses its own `M1 87°` chip while opts.endLegs is on, so
    the TWA to M1 is quoted once rather than twice off two different winds;
  * the map can be rotated (MAP_ROT / viewRot / setViewRot): tX and tY take the
    whole point and apply the view rotation, dirOnScreen and dirToScreen carry
    it, every `frame.rot` bearing conversion adds viewRotDeg(), the viewport
    fits measure their bounding box in screen-aligned space (fitBox), and
    viewport() maps the pan back through the rotation;
  * laylines are drawn per gate MARK rather than to the gate midpoint, cut at
    the first boundary crossing (laylineReach / laylineRays), and carry a manual
    LAYLINE.trim that widens or narrows them — applied in nextLegAngles so the
    route moves with them;
  * laylineTargets() carries each target's course element (`el`, `i`) so the
    gate-bias overlay in app.js can reach both marks of a gate;
  * laylineTargets() picks the live gates by the boat's leg — the next two gates
    in course order — instead of by projecting every gate onto the wind axis,
    which on a three-gate course named a gate from another lap;
  * laylineWind() guards rd.wind on its fallback path;
  * drawRatioStrip() returns rather than dividing by zero when the buffer starts
    at or after the gun;
  * timeToLine() in js/metrics.js is an ACCELERATING run, not dist / best-VMC:
    ttlRun (js/accel.js) from the boat's current speed on the measured
    per-config acceleration table, capped at the polar for the rhumb-line angle
    via coneCap, trigger quality from CONE.aggr when the app is loaded. The
    onboard computer's own TTK was decoded from the logged channels
    (docs/ttk-decoded.html) and works exactly this way; against 1,151 real late
    line-crossings the VMC model ran 5.3 s optimistic where this lands within
    1.8 s. A point with no sog (the Z pin) is taken already at the cap. Every
    ratio, TTK and TTS in the tool flows through this one function;
  * timeToLine() picks its accel table via accelCfgKey(rd) when the app is
    loaded (typeof-guarded, same pattern as CONE.aggr): app.js's POLAR row in
    the BOATS panel can pin one of the mined per-polar tables, 'auto' follows
    rd.configs as before;
  * drawClock() and fmtT() are DELETED, and drawFrame no longer calls them. The
    plate was drawn top-right of the canvas, which stopped being free space when
    the quick bar became an overlay ON the map: it sat under the GAS and Z
    buttons with only its amber showing through the gap between them. It was a
    second copy of the countdown anyway — the header clock is the one that is
    read — and two clocks is one clock too many whether or not you can see both;
  * fitBoat() takes the zoom and divides its offset by it. The offset is a place
    on the SCREEN — the boat a third in from the trailing edge — not a distance
    over the water, and left in metres it was magnified with everything else:
    at ×12 the boat was carried clean out of the frame you had zoomed in to
    look at it in;
  * drawFrame calls drawStartCone() (in app.js) just before drawEntryLeader —
    the start cone, drawn under the boats and the start geometry because it is
    water rather than another line on top of them;
  * renderRatioNow() in js/ratio.js hands the RK column over to the Z verdict
    (zFleetVerdict, boatEntering, Z_ENTRY_INK — new in ratio.js) for any boat
    still outside the line's ends: red LATE (unreachable, or under ZPT.lateUnder
    seconds in hand for the pin), amber EARLY (over ZPT.earlyOver), green
    otherwise, on ttkZBoat/zEntryClass (app.js, typeof-guarded the way CONE is
    guarded elsewhere in this file — ratio.js loads before app.js). The row's
    name/ratio colour switches the same way. The moment linePct puts a boat
    between the ends it reverts to the ordinary line RATIO/TTK reading — the
    Z verdict answers "can I still get there", which stops being the question
    once the boat has arrived;
  * ttkZBoat() (app.js) now runs TWO legs, not one: boat-to-Z on the
    accelerating table (as before), then Z-to-line via timeToLine — the same
    leg RATIO AT BOUNDARY runs everywhere else — and scales its TTK by
    ZPT.targetRatio (renamed from coneRatio, default 1.2) rather than 1.0:
    ttk = tts - targetRatio*ttlZLine, so TTK TO Z = 0 is the moment the ratio
    sailing from Z back to the line equals the margin wanted for the tack at
    Z, not merely the moment of arrival. Returns arrival/ttlToZ/ttlZLine/tts/
    ratio/ttk/plainTtk; zEntryClass, zFleetVerdict and the fleet table are
    unchanged in shape, just reading the rescaled ttk;
  * zStateAt()'s atZ block (app.js) — "TTK AT Z"/"RATIO AT Z" in the MY BOAT
    Z panel — now reads straight off the SAME ttkZBoat() call that produces
    ttkToZ, instead of a second, separate ratioAtPoint() call timed off the
    tacking ROUTE (out.secs/bounceLeg). The two clocks disagreed; unified
    onto ttkZBoat's accel arrival, ttl and ratio are UNSCALED here (ratio
    1.00 is the ordinary line cut, same as everywhere but TO Z), which is
    what makes TTK TO Z = 0 imply RATIO AT Z = ZPT.targetRatio. zArrival()'s
    caption switched from the route seconds (z.secs) to the accel leg-1 time
    (z.ttlToZ, new field on zStateAt's return) for the same reason. The
    tacking ROUTE (out.route/secs/turns, "s to Z" in the big row) is left
    alone — a deliberately different, route-planning number, not a second
    measure of the same thing;
  * conePoints()'s gate changed from `if (!CONE.on) return null` to
    `if ((!opt || !opt.force) && !CONE.on) return null`, and drawStartCone()
    passes force:true for the Z ghost — the pink ghost cone is Z's own
    working (on whenever a pin is being placed, off once locked) and no
    longer tracks the CONE on/off switch that governs the boat's own cone;
  * ratio.js gains fleetEntryTag(rd, team, t): every fleet-table row, not
    only boats still outside the line's ends, is labelled LATE or EARLY in
    the RK column (word first, the number that earned it moved to a title
    tooltip). While entering it collapses zFleetVerdict's three classes to
    two words (late stays LATE; ok and early both read EARLY, ink keeps the
    amber/green distinction); once in the box, or with no Z pin, it falls
    back to ratio-vs-RATIO.target (over target LATE/red, at-or-under
    EARLY/green) — the same rule ratioColourFor already paints the row
    with. OVER (already over the line) keeps its own word, outside this;
  * drawBoat() also drops the ratio-at-the-tip label, per boat, while that
    boat's own TWA reads inside CONE_NOGO.dead (head to wind) — same idea as
    the existing opts.stbdApproach suppression just above, a second reason
    the number at the tip is not a decision worth showing. Pre-start, head to
    wind is a manoeuvre (killing time, opening a gap), not a course being
    steered, and COG is unwinding fast as the bow swings through the eye of
    the wind — the speed-and-heading vector the label is built from describes
    a heading already gone. The vector itself still draws; only its tip text
    goes quiet, and only for the boat actually doing it.
"""

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1] if len(sys.argv) > 1
           else HERE.parent / 'start-review' / 'index.html')

# The bundle marks its module boundaries in comments; find them rather than
# hard-coding line numbers, so the script survives the page growing.
SECTIONS = [
    ('js/vendor.js',  'js/vendor.js', 'geom.js'),
    ('js/geom.js',    'geom.js',      'polar.js'),
    ('js/polar.js',   'polar.js',     'metrics.js'),
    ('js/metrics.js', 'metrics.js',   'frame.js'),
    ('js/render.js',  'frame.js',     'replay.js'),
]

# The ratio-target colouring and the two renderer rebindings live in the
# start-review page's views.js / app.js, mixed in with the cross-event tabs this
# tracker does not have. Taken by anchor rather than by section marker.
RATIO_FROM = '/* ── ratio-target colouring'
RATIO_TO = "\n</script>"
REBIND_FROM = '/* Colour the boats by ratio instead of by finishing position.'
REBIND_TO = '\nasync function boot()'


# ── patches ────────────────────────────────────────────────────────────────
#
# Every difference between the extracted files and the source, with the reason
# it exists. A patch that stops matching is an error, not a warning: silently
# shipping the unpatched original is how a live tool starts drawing numbers it
# cannot know yet.

PATCHES = {
'js/metrics.js': [
  # 1. buildRace gains a live mode. Live, the passes that need data from after
  #    the moment being drawn are skipped rather than half-computed.
  ("""/* Build the fat per-race object every renderer reads from. */
function buildRace(raw) {
  const frame = makeFrame(raw);""",
   """/* Build the fat per-race object every renderer reads from.
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
  const frame = makeFrame(raw);"""),

  # 2. No exclusions live. The rule reads each boat's position at the gun.
  ("""  rd.excluded = new Map();
  for (const team of rd.teams) {""",
   """  rd.excluded = new Map();
  for (const team of (LIVE ? [] : rd.teams)) {"""),

  # 13. The rest of the course, projected into the start-line frame. The review
  #     page only ever needed the two line ends and M1, because that is the
  #     whole of a start. A race tool needs the gates, the marks past the first
  #     and the finish, or the boats after T+0 are sailing at nothing.
  #
  #     `raw.course` comes straight from Njord's RaceCourse.elements and is
  #     absent from every bundle harvested for starts only, so this builds what
  #     is there and nothing when there is nothing.
  ("""  rd.markWind = (raw.markWind || []).map(m => {""",
   """  rd.course = null;
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

  rd.markWind = (raw.markWind || []).map(m => {"""),

  # 3. Stop before the three post-start passes, leaving their fields empty.
  ("""  rd.entries    = detectEntries(rd);""",
   """  if (LIVE) {
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

  rd.entries    = detectEntries(rd);"""),
],

'js/render.js': [
  # 4. Let the fleet fit drop the start line. The review page always keeps the
  #    line in frame, which is right when every question is about the start.
  #    Racing, it wastes half the map on water nobody is sailing on, and the
  #    fleet shrinks to a smudge in one corner as it leaves.
  ("""function fitFleet(rd, t, W, H, opts_focus) {
  const f = rd.frame;
  const xs = [f.windR.rx, f.leeR.rx], ys = [f.windR.ry, f.leeR.ry];""",
   """/* Seagull Lab: set while racing, so the fit follows the boats and lets the
 * start line leave the frame behind them. */
let FIT_BOATS_ONLY = false;

function fitFleet(rd, t, W, H, opts_focus) {
  const f = rd.frame;
  const xs = [], ys = [];
  if (!FIT_BOATS_ONLY) {
    xs.push(f.windR.rx, f.leeR.rx);
    ys.push(f.windR.ry, f.leeR.ry);
  }"""),

  # 5. Colour the boats by team when there is no finishing position to colour
  #    by. The review page knows who reached Mark 1 first and paints the podium
  #    gold/silver/bronze and everyone else grey — which is the right answer
  #    afterwards and useless live, where it makes the whole fleet identical
  #    grey hulls. Several team colours are dark navies and greens that vanish
  #    on black water, so each is lifted to a floor of perceived brightness:
  #    the hue that identifies the boat is kept, and whether it can be seen is
  #    not left to chance.
  ("""function boatColour(rd, team) {
  if (rd.ocs && rd.ocs.has(team)) return OCS_COL;
  const pos = rd.reachPos && rd.reachPos.get(team);
  return (pos && PODIUM[pos]) || MUTED;
}""",
   """const HULL_MIN_L = 0.42;
const HULL_INK = new Map();

function hullInk(hex) {
  if (!hex) return MUTED;
  if (HULL_INK.has(hex)) return HULL_INK.get(hex);
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (L > 0 && L < HULL_MIN_L) {
    const k = HULL_MIN_L / L;
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
}"""),

  # 6. How the map reads. The review page is studied on a desk with the mouse
  #    on the scrubber; this one is glanced at, and "which boat is that and
  #    where is it pointing" has to be answerable in the time you actually
  #    have. Three knobs, all on the MAP panel — and the hull itself stays at
  #    true F50 scale unless you deliberately exaggerate it.
  ("""function drawHull(ctx, x, y, headingScreenDeg, col, mpp, focus) {
  const L = F50_LOA / mpp, B = F50_BEAM / mpp;""",
   """const MAP_INK = {
  bg: '#050506',      // the water
  label: 1.25,        // team labels
  fleet: 0.85,        // alpha for boats that are not the focus
};

/* Below this many pixels of hull, a locator ring is drawn around the boat. */
const LOCATOR_PX = 13;

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
  }"""),

  # 7. Lift the fleet out of the background. 0.6 alpha says "context, not
  #    subject", which is right for a report about one boat's start and wrong
  #    for a tool you are using to watch nine boats converge on one line.
  ("""              : (focus || isOCS || podium) ? 1 : 0.6;""",
   """              : (focus || isOCS || podium) ? 1 : MAP_INK.fleet;"""),

  # 8. Trails: thicker, and fading to a third rather than to nothing. Where a
  #    boat has been over the last half minute is the second most useful thing
  #    on the map and it was drawn the faintest.
  ("""      ctx.globalAlpha = alpha * (1 - age) * 0.8;
      ctx.lineWidth = focus ? 2.4 * (1 - age * 0.5) : 1.3;""",
   """      ctx.globalAlpha = alpha * (1 - age * 0.7);
      ctx.lineWidth = (focus ? 2.8 : 1.8) * (1 - age * 0.4);"""),

  # 9. Team labels scale with MAP_INK.label.
  ("""  ctx.font = focus ? '700 12px Orbitron, monospace' : '600 10px Orbitron, monospace';""",
   """  ctx.font = `${focus ? 700 : 600} `
           + `${Math.round((focus ? 12 : 10) * MAP_INK.label)}px Orbitron, monospace`;"""),

  # 10. …and never let the fleet fit end up with nothing in it. With no boat
  #    reporting yet, an empty list makes Math.min(...[]) Infinity and the
  #    whole viewport NaN — a blank canvas with no error anywhere.
  ("""  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const padPx = 60;""",
   """  if (!xs.length) {
    xs.push(f.windR.rx, f.leeR.rx);
    ys.push(f.windR.ry, f.leeR.ry);
  }
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const padPx = 60;"""),

  # 14. Draw it. Marks and gates in course order, the finish solid where the
  #     gates are dashed, and M1 skipped because drawM1 already draws that one
  #     with its bearing and distance.
  ("""function drawHull(ctx, x, y, headingScreenDeg, col, mpp, focus) {""",
   """const COURSE_INK = '#9fb8d0';
const FINISH_INK = '#e8f0f8';

function drawCourse(ctx, rd, tX, tY) {
  const c = rd.course;
  if (!c || !c.elements || !c.elements.length) return;
  const f = rd.frame;
  ctx.save();
  ctx.lineCap = 'round';

  const buoy = (p, r, col) => {
    ctx.beginPath();
    ctx.arc(tX(p.rx), tY(p.ry), r, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1; ctx.stroke();
  };
  const label = (p, txt, col) => {
    ctx.font = `700 ${Math.round(10 * MAP_INK.label)}px "Share Tech Mono", monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const x = tX(p.rx), y = tY(p.ry) - 13;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(4,10,18,0.85)';
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
      buoy(el.p1, 5, COURSE_INK);
      label(el.p1, 'M' + mark, COURSE_INK);
      continue;
    }
    const fin = el.type === 'FinishLine';
    const col = fin ? FINISH_INK : COURSE_INK;
    ctx.strokeStyle = col;
    ctx.lineWidth = fin ? 2 : 1.4;
    ctx.setLineDash(fin ? [] : [6, 5]);
    ctx.beginPath();
    ctx.moveTo(tX(el.p1.rx), tY(el.p1.ry));
    ctx.lineTo(tX(el.p2.rx), tY(el.p2.ry));
    ctx.stroke();
    ctx.setLineDash([]);
    buoy(el.p1, 4, col);
    buoy(el.p2, 4, col);
    const mid = { rx: (el.p1.rx + el.p2.rx) / 2, ry: (el.p1.ry + el.p2.ry) / 2 };
    if (fin) label(mid, 'FINISH', col);
    else { gate++; label(mid, 'G' + gate, col); }
  }
  ctx.restore();
}

function drawHull(ctx, x, y, headingScreenDeg, col, mpp, focus) {"""),

  # 16. Three more viewports, because `line` frames the start and `fleet`
  #     frames the boats and neither can show you a race.
  #
  #     WHOLE COURSE fits every course element plus wherever the boats are, so
  #     the picture is the racetrack with the fleet somewhere on it — on a
  #     course a kilometre deep the gates are otherwise simply off the edge.
  #
  #     TARGET BOAT is a camera on one boat, centred. TARGET BOAT OFFSET puts
  #     it a third of the way in from the trailing edge, so two thirds of the
  #     screen is the water it is sailing into rather than the water it has
  #     already crossed; the offset direction is the bearing to the mark its
  #     leg says it is sailing to, so the view swings round at each rounding by
  #     itself.
  #
  #     Their scale is fixed per race rather than taken from the fleet fit: a
  #     camera centred on you that ALSO zooms with the spread of the fleet is
  #     moving for two reasons at once and neither is legible. The piece of
  #     water is sized from the course, so a big course gets a big view without
  #     a hard-coded metre count that happens to suit one venue.
  ("""function viewport(rd, t, W, H, opts) {
  const mode = opts.mode || 'auto';
  let v;
  if (mode === 'line') {
    v = fitLine(rd, W, H);
  } else if (mode === 'fleet') {""",
   """function fitCourse(rd, t, W, H, opts_focus) {
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
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const padPx = 70;
  const spanX = Math.max(maxX - minX, 60), spanY = Math.max(maxY - minY, 60);
  const scale = Math.min((W - padPx * 2) / spanX, (H - padPx * 2) / spanY);
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, scale: Math.max(0.02, scale) };
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

function fitBoat(rd, t, W, H, focus, offset) {
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
  // instead of stepping at the diagonals.
  const halfM = Math.hypot(ux * W / 2, uy * H / 2) / scale;
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
    v = fitBoat(rd, t, W, H, opts.focus, mode === 'boatOffset')
        || fitFleet(rd, t, W, H, opts.focus);
  } else if (mode === 'fleet') {
    v = fitFleet(rd, t, W, H, opts.focus);
  } else {"""),

  # 18. Shade the band BETWEEN the two ratio fronts, and leave the water in
  #     front of the target front — the side toward the line — open.
  #
  #     The review page fills the whole 1.00 region opaque black, which reads
  #     as a hole and blacks out exactly the water you are trying to steer
  #     through. What matters to a crew is the gap between "on the gun with
  #     nothing spare" and "holding my target": be inside the band and you are
  #     between the two numbers.
  #
  #     Canvas has no path subtraction, and the region is forty overlapping
  #     fans that only union under a single nonzero fill — so an even-odd trick
  #     on one path would cancel the overlaps instead of cutting a hole. Done
  #     on an offscreen layer instead: fill the outer region, then erase the
  #     inner one with destination-out, then blit. The layer carries the same
  #     device-pixel transform as the map, and is blitted under the identity so
  #     it lands 1:1.
  ("""function drawWave(ctx, rd, t, tX, tY, W, H) {""",
   """function waveBand(ctx, rd, Touter, Tinner, tX, tY, W, H, fill, glow) {
  const dpr = window.devicePixelRatio || 1;
  const off = document.createElement('canvas');
  off.width = Math.round(W * dpr);
  off.height = Math.round(H * dpr);
  const oc = off.getContext('2d');
  oc.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (!waveRegion(oc, rd, Touter, tX, tY, glow, fill)) return false;
  oc.globalCompositeOperation = 'destination-out';
  waveRegion(oc, rd, Tinner, tX, tY, 'rgba(0,0,0,0)', '#000');
  oc.globalCompositeOperation = 'source-over';

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(off, 0, 0);
  ctx.restore();
  return true;
}

function drawWave(ctx, rd, t, tX, tY, W, H) {"""),

  # 19. Laylines to the course marks, on the boat's target angle, in tack
  #     colours — starboard green, port red, the way a crew already reads a
  #     compass rose.
  #
  #     The wind they are drawn from is a choice, because the two answers
  #     differ and the difference is the point: the masthead of the boat you
  #     are watching tells you what IT is sailing in, and the mark tells you
  #     what is waiting up there. Both are damped over a window, because an
  #     undamped 1 Hz TWD swings the layline several degrees a second and a
  #     layline that dances is worse than none.
  ("""function drawLaylines(ctx, rd, tX, tY, W, H) {""",
   """const LAYLINE = { on: false, source: 'boat', dampSec: 10 };
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

/* The wind the laylines are drawn from, damped over LAYLINE.dampSec. */
function laylineWind(rd, t, team) {
  const sec = Math.max(1, LAYLINE.dampSec);
  if (LAYLINE.source === 'mark' && (rd.markWind || []).length) {
    const dirs = [], spds = [];
    for (const m of rd.markWind) {
      for (let i = 0; i < (m.t || []).length; i++)
        if (m.t[i] > t - sec && m.t[i] <= t) { dirs.push(m.twd[i]); spds.push(m.tws[i]); }
    }
    const w = meanWind(dirs, spds);
    if (w) return { ...w, from: `${rd.markWind.length} marks` };
  }
  const tr = team && rd.tracks[team];
  if (tr) {
    const dirs = [], spds = [];
    for (let i = 0; i < tr.n; i++)
      if (tr.t[i] > t - sec && tr.t[i] <= t) { dirs.push(tr.raw.twd[i]); spds.push(tr.raw.tws[i]); }
    const w = meanWind(dirs, spds);
    if (w) return { ...w, from: team };
  }
  return rd.wind.twd == null ? null
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
      const out = [{ p: mid(top), type: 'Gate', name: 'TOP', ap: twd }];
      if (bot !== top)
        out.push({ p: mid(bot), type: 'Gate', name: 'BOTTOM', ap: (twd + 180) % 360 });
      return out;
    }
  }

  const out = [];
  for (let i = 0; i < els.length; i++) {
    if (els[i].type === 'StartLine') continue;
    out.push({ p: mid(els[i]), type: els[i].type, ap: approachTo(i) });
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

function drawCourseLaylines(ctx, rd, t, tX, tY, W, H, focus) {
  if (!LAYLINE.on) return;
  const w = laylineWind(rd, t, focus);
  if (!w) return;
  const boat = focus && sampleAt(rd.tracks[focus], t);
  const targets = laylineTargets(rd, w.twd, boat);
  if (!targets.length) return;
  const list = targets;

  ctx.save();
  ctx.lineWidth = 1.6;
  ctx.setLineDash([9, 6]);
  ctx.font = '700 10px "Share Tech Mono", monospace';

  for (const g of list) {
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
    const twa = (ang && (up ? ang.up : ang.dn))
             ?? (tgt && tgt.twa)
             ?? (logged != null && (up === (logged < 90)) ? logged : null);
    if (twa == null) continue;

    const len = laylineLength(rd);
    for (const tack of [+1, -1]) {
      // Heading on this tack, then the ray BACK from the mark along it.
      const head = w.twd - tack * twa;
      const back = (head + 180) % 360;
      const d = rd.frame.r(Math.sin(back * D2R), Math.cos(back * D2R));
      const ex = g.p.rx + d.rx * len, ey = g.p.ry + d.ry * len;
      ctx.strokeStyle = tack > 0 ? TACK_STBD : TACK_PORT;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(tX(g.p.rx), tY(g.p.ry));
      ctx.lineTo(tX(ex), tY(ey));
      ctx.stroke();

      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      // The label stays near the mark rather than three quarters of the way
      // along a line that now runs off the course — out there it is a caption
      // with nothing under it.
      const lab = Math.min(len * 0.5, LAYLINE_LABEL_M);
      const lx = tX(g.p.rx + d.rx * lab), ly = tY(g.p.ry + d.ry * lab);
      const txt = `${g.name ? g.name + ' ' : ''}${tack > 0 ? 'S' : 'P'} ${twa.toFixed(0)}°`;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(4,10,18,0.85)';
      ctx.strokeText(txt, lx, ly);
      ctx.fillStyle = tack > 0 ? TACK_STBD : TACK_PORT;
      ctx.fillText(txt, lx, ly);
      ctx.lineWidth = 1.6;
      ctx.setLineDash([9, 6]);
    }
  }
  ctx.restore();
  rd._laylineWind = w;
}

function drawLaylines(ctx, rd, tX, tY, W, H) {"""),

  # 21. Use it. With a target ratio set the wave becomes a band; without one it
  #     stays the review page's filled region.
  ("""  const live = waveRegion(ctx, rd, T, tX, tY, WAVE_INK, '#000000');""",
   """  const R0 = WAVE_RATIO.on ? WAVE_RATIO.target : 0;
  const live = R0 > 0
    ? waveBand(ctx, rd, T, T / R0, tX, tY, W, H, 'rgba(255,190,90,0.17)', WAVE_INK)
    : waveRegion(ctx, rd, T, tX, tY, WAVE_INK, '#000000');"""),

  ("""  const rfront = R > 0 && waveRegion(ctx, rd, ratioT, tX, tY,
                                     WAVE_R_INK, 'rgba(255,190,90,0.10)');""",
   """  const rfront = R > 0 && live;"""),

  # 15. …and call it, after M1 so the labels sit over the course rather than
  #     under the boats.
  ("""  if (f.m1R) drawM1(ctx, f, tX, tY, mpp, W, H);""",
   """  if (f.m1R) drawM1(ctx, f, tX, tY, mpp, W, H);
  if (opts.course !== false) drawCourse(ctx, rd, tX, tY);
  drawCourseLaylines(ctx, rd, t, tX, tY, W, H, opts.focus);
  drawGateBias(ctx, rd, t, tX, tY, W, H, opts.focus);
  drawNextLeg(ctx, rd, t, tX, tY, W, H, opts.focus);
  drawCrossLines(ctx, rd, t, tX, tY, W, H, opts.focus);"""),

  # 27. Two call sites for the crosswind overlay. The overlay itself lives in
  #     app.js, not here: it is a Seagull Lab feature with no counterpart in
  #     start-review, and a patch that pastes 150 lines of new code into an
  #     extracted file is a fork wearing a patch's clothes. The rungs go under
  #     the boats with the other course lines; the gain goes over them, because
  #     it is the headline of the overlay and a number half behind a hull is
  #     not a headline.
  ("""  drawOffscreen(ctx, offscreen, W, H);""",
   """  drawOffscreen(ctx, offscreen, W, H);
  // The gain goes over the hulls: it is the headline of the crosswind overlay
  // and a number half hidden behind a boat is not a headline.
  drawCrossGain(ctx, rd, t, tX, tY, W, H, opts.focus);"""),

  # 24. Beam is measured to the OUTSIDE of the hulls, not between their
  #     centrelines. An F50 is 15.0 m long with a beam of 8.8 m — both figures
  #     overall — and the renderer was putting the two centrelines 8.8 m apart
  #     and then drawing 1.1 m of hull either side of each, for 11.05 m across.
  #     Measured on a scratch canvas: 15.00 m long (right) by 11.25 m wide
  #     (26% over). Pull the centrelines in by the hull half-width so the outer
  #     edges land on the beam.
  ("""    const cx = side * B / 2;""",
   """    const cx = side * Math.max(0, B / 2 - hw);"""),

  # 23. The water is a setting, not a constant. Every ink on this map was
  #     chosen against near-black, so the choices stay dark — a genuinely light
  #     chart needs the whole palette re-picked, not just this one value.
  ("""  // background
  ctx.fillStyle = '#050506';""",
   """  // background
  ctx.fillStyle = MAP_INK.bg;"""),

  # 22. Let the interpolated wind field cover the course.
  #
  #     The coverage falloff was tuned for the start: nine mark boats sat in a
  #     tight grid around the line, so 160 m of full confidence and nothing
  #     past 460 m painted a continuous field. Racing, the only sources left
  #     are the F50s' own mastheads — this archive's mark wind stops at T+90 —
  #     and six boats strung a kilometre down the course fall outside each
  #     other's radius entirely. The field breaks into blobs around each boat
  #     and the course between them goes blank.
  #
  #     So the falloff scales with how far apart the sources actually are. The
  #     field is exactly as confident as its own sampling density, which is the
  #     honest rule and happens to be the one that draws a course-wide field
  #     from a spread-out fleet and a tight one from a cluster at the line.
  ("""const COVER_FULL_M = 160;
const COVER_GONE_M = 460;

function windCoverage(d) {
  if (d <= COVER_FULL_M) return 1;
  if (d >= COVER_GONE_M) return 0;
  const u = (d - COVER_FULL_M) / (COVER_GONE_M - COVER_FULL_M);""",
   """const COVER = { full: 160, gone: 460 };

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
  const u = (d - COVER_FULL_M) / (COVER_GONE_M - COVER_FULL_M);"""),

  # 29. A fault gate on every masthead reading, because an F50 at 80 km/h can
  #     fail to solve true wind at all and what comes out still looks like
  #     wind. Measured across the six full-length races: five have nothing
  #     worse than 48 degrees off the race TWD at the 99th percentile; race 5
  #     on 23 Aug has 8.9% beyond 60 degrees and 6.2% beyond 90. So the gate
  #     throws away 0.00% of the good races and catches the bad one whole.
  #     Applied where the readings enter - the field, the live arrows and the
  #     laylines - so nothing downstream has to know the data can lie.
  ("""const WIND_MAX_KMH = 45 * 1.852;
""",
   """const WIND_MAX_KMH = 45 * 1.852;

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
const WIND_MAX_OFF_DEG = 60;
const WIND_RATIO_LO = 0.4, WIND_RATIO_HI = 2.0;

function windOK(rd, twd, tws) {
  if (twd == null || tws == null) return false;
  if (!(tws > 0 && tws <= WIND_MAX_KMH)) return false;
  const w = rd.wind || {};
  if (w.twd != null) {
    let d = Math.abs(((twd - w.twd) % 360 + 360) % 360);
    if (d > 180) d = 360 - d;
    if (d > WIND_MAX_OFF_DEG) return false;
  }
  if (w.tws > 0) {
    const r = tws / w.tws;
    if (r < WIND_RATIO_LO || r > WIND_RATIO_HI) return false;
  }
  return true;
}
"""),

  ("""    const s = sampleAt(tr, t);
    if (!s || s.twd == null || s.tws == null) continue;
    if (!(s.tws > 0 && s.tws <= WIND_MAX_KMH)) continue;
    out.push({ rx: s.rx, ry: s.ry, twd: s.twd, tws: s.tws, label: team, kind: 'boat' });""",
   """    const s = sampleAt(tr, t);
    if (!s || !windOK(rd, s.twd, s.tws)) continue;
    out.push({ rx: s.rx, ry: s.ry, twd: s.twd, tws: s.tws, label: team, kind: 'boat',
               avg: trailAvg(rd, tr.t, tr.raw.twd, tr.raw.tws, t, tr.n) });"""),

  ("""    const s = markWindAt(m, t);
    if (!s) continue;
    out.push({ rx: m.rx, ry: m.ry, twd: s.twd, tws: s.tws * k,
               label: m.name, kind: 'mark' });""",
   """    const s = markWindAt(m, t);
    if (!s) continue;
    const tws = s.tws * k;                 // normalised before it is judged
    if (!windOK(rd, s.twd, tws)) continue;
    out.push({ rx: m.rx, ry: m.ry, twd: s.twd, tws,
               label: m.name, kind: 'mark',
               avg: trailAvg(rd, m.t, m.twd, m.tws, t, (m.t || []).length) });"""),

  ("""  if (LAYLINE.source === 'mark' && (rd.markWind || []).length) {
    const dirs = [], spds = [];
    for (const m of rd.markWind) {
      for (let i = 0; i < (m.t || []).length; i++)
        if (m.t[i] > t - sec && m.t[i] <= t) { dirs.push(m.twd[i]); spds.push(m.tws[i]); }
    }
    const w = meanWind(dirs, spds);
    if (w) return { ...w, from: `${rd.markWind.length} marks` };
  }
  const tr = team && rd.tracks[team];
  if (tr) {
    const dirs = [], spds = [];
    for (let i = 0; i < tr.n; i++)
      if (tr.t[i] > t - sec && tr.t[i] <= t) { dirs.push(tr.raw.twd[i]); spds.push(tr.raw.tws[i]); }
    const w = meanWind(dirs, spds);
    if (w) return { ...w, from: team };
  }""",
   """  if (LAYLINE.source === 'mark' && (rd.markWind || []).length) {
    const dirs = [], spds = [];
    for (const m of rd.markWind) {
      for (let i = 0; i < (m.t || []).length; i++)
        if (m.t[i] > t - sec && m.t[i] <= t && windOK(rd, m.twd[i], m.tws[i]))
          { dirs.push(m.twd[i]); spds.push(m.tws[i]); }
    }
    const w = meanWind(dirs, spds);
    if (w) return { ...w, from: `${rd.markWind.length} marks` };
  }
  const tr = team && rd.tracks[team];
  if (tr) {
    const dirs = [], spds = [];
    for (let i = 0; i < tr.n; i++)
      if (tr.t[i] > t - sec && tr.t[i] <= t && windOK(rd, tr.raw.twd[i], tr.raw.tws[i]))
        { dirs.push(tr.raw.twd[i]); spds.push(tr.raw.tws[i]); }
    const w = meanWind(dirs, spds);
    if (w) return { ...w, from: team };
  }"""),

  # 30. Replace the boxcar mean behind the damped overlays with a robust,
  #     edge-tapered one. A hard-edged trailing window steps every time a
  #     sample enters or leaves it, several do at once coming out of a tack,
  #     and patch 29's gate makes it worse by flipping samples in and out of
  #     the averaged population. Measured on the archive, the rung's wind moved
  #     up to 34 degrees across one tack. Median for the centre, MAD for the
  #     spread, cosine taper for the edge - and still a pure function of t, so
  #     scrubbing backwards gives the same answer as scrubbing forwards.
  ("""/* The wind the laylines are drawn from, damped over LAYLINE.dampSec. */
""",
   """
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

function robustWind(dirs, spds, ages, sec, ref) {
  const n = dirs.length;
  if (!n) return null;
  if (ref == null || !(sec > 0)) return meanWind(dirs, spds);

  const dev = new Array(n);
  for (let i = 0; i < n; i++) dev[i] = ((dirs[i] - ref) % 360 + 540) % 360 - 180;
  const byDev = [...dev].sort((a, b) => a - b);
  const med = byDev[byDev.length >> 1];
  const ad = dev.map(d => Math.abs(d - med)).sort((a, b) => a - b);
  // 1.4826 makes the MAD comparable to a standard deviation for normal noise;
  // three of those is the usual outlier line. The floor stops a very steady
  // window from setting a tolerance so tight it rejects its own real motion.
  const tol = Math.max(WIND_MIN_TOL_DEG, 3 * 1.4826 * ad[ad.length >> 1]);

  let sx = 0, sy = 0, ss = 0, wSpd = 0, wSum = 0, kept = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(dev[i] - med) > tol) continue;
    const w = 0.5 * (1 + Math.cos(Math.PI * Math.min(1, Math.max(0, ages[i] / sec))));
    if (!(w > 0)) continue;
    kept++;
    const a = (ref + dev[i]) * D2R;
    sx += w * Math.sin(a);
    sy += w * Math.cos(a);
    if (spds[i] != null) { ss += w * spds[i]; wSpd += w; }
    wSum += w;
  }
  if (!wSum) return null;
  return { twd: (Math.atan2(sx, sy) / D2R + 360) % 360,
           tws: wSpd ? ss / wSpd : null, n: kept };
}

/* The wind the laylines are drawn from, damped over LAYLINE.dampSec. */
"""),

  ("""function laylineWind(rd, t, team) {
  const sec = Math.max(1, LAYLINE.dampSec);
  if (LAYLINE.source === 'mark' && (rd.markWind || []).length) {
    const dirs = [], spds = [];
    for (const m of rd.markWind) {
      for (let i = 0; i < (m.t || []).length; i++)
        if (m.t[i] > t - sec && m.t[i] <= t && windOK(rd, m.twd[i], m.tws[i]))
          { dirs.push(m.twd[i]); spds.push(m.tws[i]); }
    }
    const w = meanWind(dirs, spds);
    if (w) return { ...w, from: `${rd.markWind.length} marks` };
  }
  const tr = team && rd.tracks[team];
  if (tr) {
    const dirs = [], spds = [];
    for (let i = 0; i < tr.n; i++)
      if (tr.t[i] > t - sec && tr.t[i] <= t && windOK(rd, tr.raw.twd[i], tr.raw.tws[i]))
        { dirs.push(tr.raw.twd[i]); spds.push(tr.raw.tws[i]); }
    const w = meanWind(dirs, spds);
    if (w) return { ...w, from: team };
  }""",
   """function laylineWind(rd, t, team) {
  const sec = Math.max(1, LAYLINE.dampSec);
  const ref = rd.wind ? rd.wind.twd : null;
  if (LAYLINE.source === 'mark' && (rd.markWind || []).length) {
    const dirs = [], spds = [], ages = [];
    for (const m of rd.markWind) {
      for (let i = 0; i < (m.t || []).length; i++)
        if (m.t[i] > t - sec && m.t[i] <= t && windOK(rd, m.twd[i], m.tws[i]))
          { dirs.push(m.twd[i]); spds.push(m.tws[i]); ages.push(t - m.t[i]); }
    }
    const w = robustWind(dirs, spds, ages, sec, ref);
    if (w) return { ...w, from: `${rd.markWind.length} marks` };
  }
  const tr = team && rd.tracks[team];
  if (tr) {
    const dirs = [], spds = [], ages = [];
    for (let i = 0; i < tr.n; i++)
      if (tr.t[i] > t - sec && tr.t[i] <= t && windOK(rd, tr.raw.twd[i], tr.raw.tws[i]))
        { dirs.push(tr.raw.twd[i]); spds.push(tr.raw.tws[i]); ages.push(t - tr.t[i]); }
    const w = robustWind(dirs, spds, ages, sec, ref);
    if (w) return { ...w, from: team };
  }"""),

  # 31. Make the gate a weight rather than a switch, and the outlier test a
  #     ramp rather than a cut. As booleans they introduced a failure of their
  #     own: a sample crossing a threshold joined or left the averaged
  #     population instantly, so the answer stepped - up to 50 degrees in one
  #     second on the rung. Nothing else on the map moves like that, which is
  #     precisely why it was the thing you noticed. Everything downstream is
  #     now a continuous function of the data.
  ("""const WIND_MAX_OFF_DEG = 60;
const WIND_RATIO_LO = 0.4, WIND_RATIO_HI = 2.0;

function windOK(rd, twd, tws) {
  if (twd == null || tws == null) return false;
  if (!(tws > 0 && tws <= WIND_MAX_KMH)) return false;
  const w = rd.wind || {};
  if (w.twd != null) {
    let d = Math.abs(((twd - w.twd) % 360 + 360) % 360);
    if (d > 180) d = 360 - d;
    if (d > WIND_MAX_OFF_DEG) return false;
  }
  if (w.tws > 0) {
    const r = tws / w.tws;
    if (r < WIND_RATIO_LO || r > WIND_RATIO_HI) return false;
  }
  return true;
}""",
   """/* The gate is a WEIGHT, not a switch, and that is the whole trick.
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

/* Is this source LEFT or RIGHT of where it has been?
 *
 * A single wind reading says almost nothing on its own - what a trimmer wants
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
"""),

  ("""function robustWind(dirs, spds, ages, sec, ref) {
  const n = dirs.length;
  if (!n) return null;
  if (ref == null || !(sec > 0)) return meanWind(dirs, spds);

  const dev = new Array(n);
  for (let i = 0; i < n; i++) dev[i] = ((dirs[i] - ref) % 360 + 540) % 360 - 180;
  const byDev = [...dev].sort((a, b) => a - b);
  const med = byDev[byDev.length >> 1];
  const ad = dev.map(d => Math.abs(d - med)).sort((a, b) => a - b);
  // 1.4826 makes the MAD comparable to a standard deviation for normal noise;
  // three of those is the usual outlier line. The floor stops a very steady
  // window from setting a tolerance so tight it rejects its own real motion.
  const tol = Math.max(WIND_MIN_TOL_DEG, 3 * 1.4826 * ad[ad.length >> 1]);

  let sx = 0, sy = 0, ss = 0, wSpd = 0, wSum = 0, kept = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(dev[i] - med) > tol) continue;
    const w = 0.5 * (1 + Math.cos(Math.PI * Math.min(1, Math.max(0, ages[i] / sec))));
    if (!(w > 0)) continue;
    kept++;
    const a = (ref + dev[i]) * D2R;
    sx += w * Math.sin(a);
    sy += w * Math.cos(a);
    if (spds[i] != null) { ss += w * spds[i]; wSpd += w; }
    wSum += w;
  }
  if (!wSum) return null;
  return { twd: (Math.atan2(sx, sy) / D2R + 360) % 360,
           tws: wSpd ? ss / wSpd : null, n: kept };
}""",
   """/* Weighted order statistic: the value where cumulative weight reaches half. */
function wQuantile(pairs, f) {
  const s = [...pairs].sort((a, b) => a[0] - b[0]);
  let tot = 0;
  for (const [, w] of s) tot += w;
  let run = 0;
  for (const [v, w] of s) { run += w; if (run >= f * tot) return v; }
  return s.length ? s[s.length - 1][0] : 0;
}

function robustWind(dirs, spds, ages, sec, ref, wts) {
  const n = dirs.length;
  if (!n) return null;
  if (ref == null || !(sec > 0)) return meanWind(dirs, spds);

  // Each sample's weight is its credibility times its place in the taper, so a
  // sample fades out BOTH as it ages past the window and as it drifts towards
  // the edge of what a wind reading can be. Neither ever steps.
  const dev = new Array(n), w = new Array(n);
  for (let i = 0; i < n; i++) {
    dev[i] = ((dirs[i] - ref) % 360 + 540) % 360 - 180;
    const taper = 0.5 * (1 + Math.cos(Math.PI * Math.min(1, Math.max(0, ages[i] / sec))));
    w[i] = taper * (wts ? wts[i] : 1);
  }
  const med = wQuantile(dev.map((d, i) => [d, w[i]]), 0.5);
  const mad = wQuantile(dev.map((d, i) => [Math.abs(d - med), w[i]]), 0.5);
  // 1.4826 makes the MAD comparable to a standard deviation for normal noise;
  // three of those is the usual outlier line. The floor stops a very steady
  // window from setting a tolerance so tight it rejects its own real motion.
  const tol = Math.max(WIND_MIN_TOL_DEG, 3 * 1.4826 * mad);

  let sx = 0, sy = 0, ss = 0, wSpd = 0, wSum = 0, kept = 0;
  for (let i = 0; i < n; i++) {
    // The inlier test is a ramp too, over the outer third of the tolerance,
    // so an outlier loses its vote gradually rather than all at once.
    const k = w[i] * windRamp(Math.abs(dev[i] - med), tol * 0.67, tol);
    if (!(k > 0)) continue;
    kept++;
    const a = (ref + dev[i]) * D2R;
    sx += k * Math.sin(a);
    sy += k * Math.cos(a);
    if (spds[i] != null) { ss += k * spds[i]; wSpd += k; }
    wSum += k;
  }
  if (!wSum) return null;
  return { twd: (Math.atan2(sx, sy) / D2R + 360) % 360,
           tws: wSpd ? ss / wSpd : null, n: kept };
}"""),

  ("""    for (const m of rd.markWind) {
      for (let i = 0; i < (m.t || []).length; i++)
        if (m.t[i] > t - sec && m.t[i] <= t && windOK(rd, m.twd[i], m.tws[i]))
          { dirs.push(m.twd[i]); spds.push(m.tws[i]); ages.push(t - m.t[i]); }
    }
    const w = robustWind(dirs, spds, ages, sec, ref);
    if (w) return { ...w, from: `${rd.markWind.length} marks` };
  }
  const tr = team && rd.tracks[team];
  if (tr) {
    const dirs = [], spds = [], ages = [];
    for (let i = 0; i < tr.n; i++)
      if (tr.t[i] > t - sec && tr.t[i] <= t && windOK(rd, tr.raw.twd[i], tr.raw.tws[i]))
        { dirs.push(tr.raw.twd[i]); spds.push(tr.raw.tws[i]); ages.push(t - tr.t[i]); }
    const w = robustWind(dirs, spds, ages, sec, ref);
    if (w) return { ...w, from: team };
  }""",
   """    const wts = [];
    for (const m of rd.markWind) {
      for (let i = 0; i < (m.t || []).length; i++) {
        if (!(m.t[i] > t - sec && m.t[i] <= t)) continue;
        const k = windWeight(rd, m.twd[i], m.tws[i]);
        if (k > 0) { dirs.push(m.twd[i]); spds.push(m.tws[i]);
                     ages.push(t - m.t[i]); wts.push(k); }
      }
    }
    const w = robustWind(dirs, spds, ages, sec, ref, wts);
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
    const w = robustWind(dirs, spds, ages, sec, ref, wts);
    if (w) return { ...w, from: team };
  }"""),

  # 32. And drop the weighted median for an IRLS/biweight centre. A median is
  #     robust but it is an order statistic, so with the readings in two
  #     clusters it hops the whole gap the moment the weight mass crosses over
  #     - the same disease as a hard threshold, one level up, and still worth
  #     12-16 degrees in a single second on this data. IRLS is robust AND
  #     smooth: no sorting, no jumps, and a cluster of nonsense still carries
  #     essentially no weight by the third pass.
  ("""/* Weighted order statistic: the value where cumulative weight reaches half. */
function wQuantile(pairs, f) {
  const s = [...pairs].sort((a, b) => a[0] - b[0]);
  let tot = 0;
  for (const [, w] of s) tot += w;
  let run = 0;
  for (const [v, w] of s) { run += w; if (run >= f * tot) return v; }
  return s.length ? s[s.length - 1][0] : 0;
}

function robustWind(dirs, spds, ages, sec, ref, wts) {
  const n = dirs.length;
  if (!n) return null;
  if (ref == null || !(sec > 0)) return meanWind(dirs, spds);

  // Each sample's weight is its credibility times its place in the taper, so a
  // sample fades out BOTH as it ages past the window and as it drifts towards
  // the edge of what a wind reading can be. Neither ever steps.
  const dev = new Array(n), w = new Array(n);
  for (let i = 0; i < n; i++) {
    dev[i] = ((dirs[i] - ref) % 360 + 540) % 360 - 180;
    const taper = 0.5 * (1 + Math.cos(Math.PI * Math.min(1, Math.max(0, ages[i] / sec))));
    w[i] = taper * (wts ? wts[i] : 1);
  }
  const med = wQuantile(dev.map((d, i) => [d, w[i]]), 0.5);
  const mad = wQuantile(dev.map((d, i) => [Math.abs(d - med), w[i]]), 0.5);
  // 1.4826 makes the MAD comparable to a standard deviation for normal noise;
  // three of those is the usual outlier line. The floor stops a very steady
  // window from setting a tolerance so tight it rejects its own real motion.
  const tol = Math.max(WIND_MIN_TOL_DEG, 3 * 1.4826 * mad);

  let sx = 0, sy = 0, ss = 0, wSpd = 0, wSum = 0, kept = 0;
  for (let i = 0; i < n; i++) {
    // The inlier test is a ramp too, over the outer third of the tolerance,
    // so an outlier loses its vote gradually rather than all at once.
    const k = w[i] * windRamp(Math.abs(dev[i] - med), tol * 0.67, tol);
    if (!(k > 0)) continue;
    kept++;
    const a = (ref + dev[i]) * D2R;
    sx += k * Math.sin(a);
    sy += k * Math.cos(a);
    if (spds[i] != null) { ss += k * spds[i]; wSpd += k; }
    wSum += k;
  }
  if (!wSum) return null;
  return { twd: (Math.atan2(sx, sy) / D2R + 360) % 360,
           tws: wSpd ? ss / wSpd : null, n: kept };
}""",
   """/* Robust WITHOUT an order statistic, which is the point.
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
  return { twd: (ref + c + 360) % 360, tws: wSpd ? ss / wSpd : null, n: kept };
}"""),

  # 33. Draw the racecourse boundary as the BAND it is. The course file stores
  #     the inside edge - the last water you may sail - and a boat approaching
  #     needs to see the zone it must not enter, not just the line where
  #     trouble starts. A proper polygon offset (bisector, d/cos(half-turn),
  #     winding from the signed area), not a scale about the centre, which is a
  #     different operation and wrong anywhere the shape is not a circle.
  ("""function drawLimits(ctx, f, tX, tY) {""",
   """/* The boundary is a BAND, not a line.
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
  if (!(d > 0)) return null;
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

function drawLimits(ctx, f, tX, tY) {"""),

  ("""  ctx.save();
  for (const [name, pts] of Object.entries(f.limits || {})) {
    if (!pts.length) continue;
    const [col, dash] = style[name.replace(/ \d+$/, '')]
                     || ['rgba(140,160,190,0.15)', [4, 4]];
    ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.setLineDash(dash);
    ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(tX(p.rx), tY(p.ry)) : ctx.moveTo(tX(p.rx), tY(p.ry)));
    ctx.closePath(); ctx.stroke();
  }
  ctx.restore();
}""",
   """  ctx.save();
  const trace = pts => {
    pts.forEach((p, i) => i ? ctx.lineTo(tX(p.rx), tY(p.ry))
                            : ctx.moveTo(tX(p.rx), tY(p.ry)));
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
      const ring = offsetPoly(pts, BOUNDARY_BAND.m);
      if (ring) {
        ctx.save();
        ctx.setLineDash([]);
        // Even-odd across the two rings fills the space between them and
        // nothing else, which is what a band is. Canvas has no path
        // subtraction, but for two nested rings this is exactly equivalent.
        ctx.beginPath();
        trace(ring.outer);
        trace(ring.inner);
        ctx.fillStyle = 'rgba(226,54,54,0.20)';
        ctx.fill('evenodd');
        ctx.strokeStyle = 'rgba(255,96,96,0.42)';
        ctx.lineWidth = 1.2;
        ctx.beginPath(); trace(ring.outer); ctx.stroke();
        ctx.restore();
      }
    }

    ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.setLineDash(dash);
    ctx.beginPath();
    trace(pts);
    ctx.stroke();
  }
  ctx.restore();
}"""),

  # 34. A no-go zone around every mark, in its own pass before the course is
  #     drawn. The marks are drawn with skips and special cases - M1 belongs to
  #     drawM1, a gate is two buoys and a line, the finish is neither - so
  #     hanging the zone off each of them would inherit every one of those
  #     exceptions. One pass, one rule, and the buoys land on top of it.
  ("""function drawCourse(ctx, rd, tX, tY) {
  const c = rd.course;
  if (!c || !c.elements || !c.elements.length) return;
  const f = rd.frame;
  ctx.save();
  ctx.lineCap = 'round';
""",
   """/* The zone around a mark you are not allowed inside.
 *
 * Every buoy on the course carries one, so it goes in a pass of its own BEFORE
 * anything else is drawn: the marks themselves are drawn with skips and special
 * cases — M1 is owned by drawM1, a gate is two buoys and a line, the finish is
 * neither — and hanging the zone off each of those would inherit every one of
 * those exceptions. A separate pass means every mark gets a zone by the same
 * rule, and the buoys and labels land on top of it rather than under it.
 *
 * The radius is in metres, converted through the same transform as everything
 * else — tX(x + R) - tX(x) — so it scales with the map instead of being a fixed
 * number of pixels that means a different distance at every zoom.
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

  const r = Math.abs(tX(MARK_ZONE.m) - tX(0));
  if (!(r > 0.5)) return;                        // zoomed out past meaning
  ctx.save();
  ctx.fillStyle = 'rgba(226,54,54,0.13)';
  ctx.strokeStyle = 'rgba(255,96,96,0.30)';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(tX(p.rx), tY(p.ry), r, 0, Math.PI * 2);
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
"""),

  # 36. A basemap call site, under the grid and everything else. The layer
  #     itself lives in app.js — it is a Seagull Lab feature with no counterpart
  #     in start-review, and it is all network and cache handling rather than
  #     drawing.
  ("""  // background
  ctx.fillStyle = MAP_INK.bg;
  ctx.fillRect(0, 0, W, H);
  drawGrid(ctx, W, H, v, mpp);""",
   """  // background
  ctx.fillStyle = MAP_INK.bg;
  ctx.fillRect(0, 0, W, H);
  // The world, under everything. Off by default: it costs network, and the
  // whole palette was picked against near-black water.
  drawBasemap(ctx, rd, v, W, H);
  drawGrid(ctx, W, H, v, mpp);"""),

  # 37. Wind arrows point INTO the wind, and carry the shift.
  #
  #     Into the wind because that is the direction a masthead fly reads and
  #     the direction the number beside the arrow names; flying downwind means
  #     the same thing and reads as the opposite one. Both the live arrows and
  #     the field's grid arrows, because two conventions on one map are worse
  #     than either.
  #
  #     And a single reading says almost nothing on its own. Each source now
  #     carries the vector mean of its OWN last 60 s, and the arrow is red when
  #     the reading is left of it and green when right — so a shift arriving
  #     shows as the arrows changing colour one after another across the course.
  #     The speed ramp stays on the numbers, so each element carries one meaning.
  ("""    const a = (s.twd + 180 - rot) * D2R;
    const ux = Math.sin(a), uy = -Math.cos(a);""",
   """    // Pointing INTO the wind — at where it is coming from, which is the
    // direction a sailor reads off a masthead fly and the direction the number
    // beside it names. An arrow flying downwind means the same thing and reads
    // as the opposite one.
    const a = (s.twd - rot) * D2R;
    const ux = Math.sin(a), uy = -Math.cos(a);
    // Red for left of its own last minute, green for right. The speed ramp
    // stays on the numbers, so each thing carries one meaning: the arrow is
    // direction and shift, the figure beside it is speed.
    const side = shiftSide(s.twd, s.avg);
    const shaft = side < 0 ? SHIFT_LEFT_INK : side > 0 ? SHIFT_RIGHT_INK : ink;"""),

  ("""    ctx.strokeStyle = ink; ctx.fillStyle = ink;
    ctx.lineWidth = s.kind === 'mark' ? 3 : 1.3;""",
   """    ctx.strokeStyle = shaft; ctx.fillStyle = shaft;
    ctx.lineWidth = s.kind === 'mark' ? 3 : 1.3;"""),

  ("""      // TWD is where the wind comes FROM; the arrow flies with it
      const a = (q.twd + 180 - rot) * D2R;""",
   """      // Into the wind, the same way round as the live arrows. Two arrow
      // conventions on one map is worse than either of them.
      const a = (q.twd - rot) * D2R;"""),

  ("""  const src = windSources(rd, t, 'all', true);
  const dom = windDomain(rd);""",
   """  const src = windFieldSources(rd, t);
  const now = src.now || src;
  // Coverage comes from the LIVE readings only. The trail packs samples along
  // each boat's path, and letting that count as denser sampling would shrink
  // the field to a ribbon behind the fleet — the opposite of what it is for.
  setWindCoverage(now);
  const dom = windDomain(rd);"""),

  # 25. Make the wind field move with the WIND rather than with the fleet.
  #
  #     The review page's field is six masthead readings at six boat positions,
  #     taken at one instant. Advance the clock and the pattern does not travel
  #     down the course; it is glued to the boats, because the only thing that
  #     moved was the boats. A gust the leader sailed through a minute ago has
  #     simply gone, when in fact it is now somewhere near the bottom gate —
  #     which is exactly the thing a live tool is being asked.
  #
  #     So the field is built from a trailing window of readings, each carried
  #     from where it was measured to where that air is NOW: downwind, at its
  #     own measured speed, for as long as it has been travelling. That is
  #     frozen Taylor's hypothesis, the standard assumption that over a minute
  #     or so a wind pattern is transported by the mean flow faster than it
  #     evolves. It also fills the water in — a boat's last minute of track
  #     seeds a line of readings instead of a point.
  #
  #     Age is not free, so each carried reading keeps a credibility that decays
  #     with how long it has been drifting: it counts for less in the blend AND
  #     claims less water, via the same coverage test that already fades the
  #     field out where nothing is near enough to say. WIND_VIEW.trailSec = 0
  #     reduces this exactly to the original instantaneous field.
  ("""const WIND_VIEW = { live: 'off', field: 'off' };""",
   """const WIND_VIEW = { live: 'off', field: 'off', trailSec: 45 };"""),

  ("""function idwAt(src, rx, ry) {
  let wsum = 0, sx = 0, sy = 0, ssp = 0, d2min = Infinity;
  for (const s of src) {
    const dx = rx - s.rx, dy = ry - s.ry;
    const dd = dx * dx + dy * dy;
    if (dd < d2min) d2min = dd;
    const d2 = dd + IDW_SOFTEN_M * IDW_SOFTEN_M;
    const w = 1 / d2;
    wsum += w;
    ssp += w * s.tws;""",
   """function idwAt(src, rx, ry) {
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
    ssp += w * s.tws;"""),

  ("""  if (!wsum) return null;
  return {
    tws: ssp / wsum,
    twd: (Math.atan2(sx, sy) / D2R + 360) % 360,
    dNearest: Math.sqrt(d2min),
  };
}""",
   """  if (!wsum) return null;
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

function windFieldSources(rd, t) {
  const now = windSources(rd, t, 'all', true);
  for (const s of now) s.cred = 1;
  const trail = Math.max(0, WIND_VIEW.trailSec || 0);
  const out = now.slice();
  out.now = now;
  if (!trail) return out;

  for (let age = TRAIL_STEP_S; age <= trail; age += TRAIL_STEP_S) {
    const cred = 1 / (1 + age / TRAIL_HALF_S);
    for (const s of windSources(rd, t - age, 'all', true)) {
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
}"""),

  # The source rings mark where the data came from, so they follow the live
  # readings — an advected copy is not a place anyone measured anything.
  ("""  const shown = WIND_VIEW.field === 'all' ? src
              : src.filter(s => windWants(WIND_VIEW.field, s.kind));""",
   """  const shown = WIND_VIEW.field === 'all' ? now
              : now.filter(s => windWants(WIND_VIEW.field, s.kind));"""),

  # 26. Past the gun the projected line's tip carries no label. The review page
  #     tags it "gun" whenever the projection reaches T+0, which pre-start says
  #     something useful — you are projecting past the start — and for the whole
  #     rest of the race says it forever, on every boat.
  ("""      const txt = t + projSec >= 0 ? 'gun'
                : over ? 'over'""",
   """      // Past the gun there is no start to project onto, so the tip carries no
      // label at all — a fleet of arrows each tagged "gun" for the rest of the
      // race is noise. Pre-gun the word still means something: your projection
      // reaches past the start.
      const txt = t >= 0 ? null
                : t + projSec >= 0 ? 'gun'
                : over ? 'over'"""),
],

'js/geom.js': [
  # 35. Keep the frame's origin on the frame. The rotation into the local metric
  #     frame is one-way without it: everything can be projected in and nothing
  #     back out to a latitude and longitude, which is exactly what a basemap
  #     underneath the course needs.
  ("""  return {
    toM, r, rp, rot,""",
   """  return {
    // The origin the local metric frame is measured from. Without it the
    // rotation is one-way — every mark and track can be projected INTO the
    // frame and nothing can be projected back out to a latitude and longitude,
    // which is what a basemap underneath needs.
    cLat, cLon,
    toM, r, rp, rot,"""),

  # 17. Carry the boat's own target angle through the sampler, so laylines can
  #     use the number the boat is actually steering to rather than a table
  #     lookup. Null until a harvest includes TARG_TWA_deg; the layline code
  #     falls back to the polar meanwhile.
  ("""    dtlLogged: b.dtl[lo],
    linePctLogged: b.linePct[lo],""",
   """    dtlLogged: b.dtl[lo],
    linePctLogged: b.linePct[lo],
    targTwa: b.targTwa ? lerp(b.targTwa[lo], b.targTwa[hi], s) : null,
    targSog: b.targSog ? lerp(b.targSog[lo], b.targSog[hi], s) : null,
    // A step, not a ramp: half way between leg 2 and leg 3 you are on leg 2,
    // not on leg 2.5. Take the sample at or before t and leave it alone.
    leg: b.leg ? b.leg[lo] : null,"""),
],

'js/ratio.js': [
  # 11. The onboard ratio channel keeps logging for a few seconds past the gun
  #    and the number means nothing there. Blank it rather than show it.
  ("""function renderRatioNow(rd, t, el, label) {
  if (label) label.textContent = `T${t < 0 ? '−' : '+'}${Math.abs(t).toFixed(1)}`;
  const CAP = 4;""",
   """function renderRatioNow(rd, t, el, label) {
  if (label) label.textContent = `T${t < 0 ? '−' : '+'}${Math.abs(t).toFixed(1)}`;
  // After the gun there is no line left to be early or late for. The onboard
  // channel keeps logging a number for a few seconds past it and it means
  // nothing; showing it would be the tracker's most-read panel quietly lying.
  if (t >= 0) {
    el.innerHTML = '<div class="gunned">gun — the start is sailed</div>';
    return;
  }
  const CAP = 4;"""),

  # 12. Ratio colouring is a pre-start idea. Past the gun the channel stops
  #    reporting and every boat turns grey — which reads as "no data" on a
  #    fleet that is sailing perfectly well. Hand the boats back to the
  #    renderer's own colours at T+0.
  ("""boatColour = function (rd, team) {
  if (RATIO.on) {""",
   """boatColour = function (rd, team) {
  if (RATIO.on && _frameT != null && _frameT < 0) {"""),
],
}


def cut(text, start_marker, end_marker):
    a = text.index(start_marker)
    b = text.index(end_marker, a + len(start_marker))
    return text[a:b].rstrip() + '\n'


def main():
    if not SRC.exists():
        sys.exit(f'source not found: {SRC}\nusage: python3 build/extract.py <start-review/index.html>')
    page = SRC.read_text()

    out = {}
    for name, a, b in SECTIONS:
        out[name] = cut(page, f'/* ==== {a} ==== */', f'/* ==== {b} ==== */')

    out['js/ratio.js'] = (cut(page, RATIO_FROM, RATIO_TO).rstrip() + '\n\n'
                          + cut(page, REBIND_FROM, REBIND_TO).rstrip() + '\n')

    for name, patches in PATCHES.items():
        for old, new in patches:
            if out[name].count(old) != 1:
                sys.exit(f'PATCH FAILED in {name}: anchor matched '
                         f'{out[name].count(old)} times, expected 1.\n'
                         f'  anchor: {old.splitlines()[0][:90]}\n'
                         f'The source has moved under this script. Re-read the '
                         f'patch above and fix the anchor before shipping.')
            out[name] = out[name].replace(old, new)

    for name, body in out.items():
        p = HERE / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
        print(f'{name:18} {len(body.splitlines()):5} lines   {len(body)//1024:4} KB')

    print(f'\nfrom {SRC}')
    print('hand-written and untouched: js/feed.js, js/app.js, js/mock-live.js')


if __name__ == '__main__':
    main()
