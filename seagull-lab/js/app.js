/* app.js — the tracker itself.
 *
 * One loop, and it is deliberately dumb:
 *
 *   poll the feed  ->  rebuild the race from the buffer  ->  draw at the clock
 *
 * The rebuild is the whole trick. buildRace() already turns a bundle into
 * everything the renderer reads; run it against a buffer that stops at the
 * present and it does the same job on a race that is still happening. So there
 * is no second, thinner, live-only implementation of the geometry to keep in
 * step with the real one — there is one builder, called ~5x a second on a
 * growing buffer. On a nine-boat fleet that costs a few milliseconds and it
 * means a number on screen live is the same number the review page would show
 * afterwards, computed by the same line of code.
 *
 * The one thing the loop refuses to do is draw ahead of the data. The clock is
 * the clock — it keeps counting through a dropout — but the map is drawn at the
 * last instant a sample exists for, and the gap between the two is on screen as
 * LAG rather than hidden by extrapolating boats forward.
 *
 * LIVE and REPLAY are the same page. Everything below is shared; the tab
 * decides which feed is attached and whether the scrubber and the archive
 * picker are on screen. There is no second code path to keep honest.
 */

const $ = id => document.getElementById(id);

/* Anything interpolated into innerHTML goes through this. The only untrusted
 * string here is the live-feed URL the user typed, which is stored and read
 * back on the next visit — but "only my own input" is exactly the assumption
 * that makes a stored value dangerous, and escaping costs nothing. */
const esc = v => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* How often the race is rebuilt from the buffer. Faster than the 1 Hz data and
 * slow enough that the build never becomes the frame budget. */
const REBUILD_MS = 200;

/* The map is measured, not declared — it is whatever the grid leaves over. */
const MAP_MIN_H = 300;

/* Width of the range thumb, in px, matching --thumb in the stylesheet. The
 * track a thumb can travel is the element minus its own width, so a mark placed
 * at a plain percentage of the element sits progressively further from the
 * value it claims to mark the closer it gets to either end. */
const THUMB_PX = 14;

/* How far behind the clock the map is drawn, in seconds.
 *
 * The renderer interpolates between samples with a cubic Hermite spline using
 * each sample's measured velocity as the tangent — it is built to turn 1 Hz
 * telemetry into smooth motion. It was never getting the chance. The draw time
 * was pinned to the last sample in the buffer, which at 1 Hz only advances once
 * a second, so the spline was always evaluated exactly ON a sample: 98% of
 * frames drew the boat in the identical place and the 60th frame moved it 15 m.
 *
 * A spline needs a sample on BOTH sides of the moment it is drawing. Live, the
 * following sample does not exist yet, and inventing it — dead reckoning the
 * boat forward off its last velocity — means drawing a position nobody
 * measured, in a tool whose whole discipline is not doing that.
 *
 * So the map runs a beat behind the clock instead. One second is the minimum
 * that guarantees a bracketing sample at 1 Hz. The clock still shows true time,
 * and it costs about 19 m of boat at 70 km/h — which is why it is adjustable,
 * and why SMOOTHING can be switched off for a raw, honest, jumpy 1 Hz. */
const SMOOTH = { lag: 1.0 };

/* Which build is actually running, taken from the page rather than hard-coded
 * here — index.html carries it as a <meta> AND as the ?v= on every script tag,
 * so the two can never drift apart. Printed in the footer. */
const BUILD_ID = (() => {
  const m = document.querySelector('meta[name="build"]');
  return (m && m.content) || 'dev';
})();

const APP = {
  manifest: null,
  tab: 'replay',
  feed: null,
  rd: null,               // the built race, as of the last rebuild
  focus: null,
  liveUrl: null,
  rev: -1,                // buffer revision the current rd was built from
  builtAt: 0,
  buildMs: 0,
  theme: 'dark',
  opts: {
    // The view the tool opens on, chosen to be the one you would set up by
    // hand every time: the whole course, aligned with it, on a faded basemap,
    // with the start overlays and the mark wind already live.
    mode: 'course',
    laylines: true,
    showLimits: true,
    wave: true,
    allSog: true,
    height: 620,
    trailSec: 10,
    zoom: 1, panX: 0, panY: 0,
  },
};

/* Projection is a toggle plus a length, so switching it off has to remember
 * what it was. PROJECTION.sec = 0 is the renderer's "off". */
const PROJ = { on: true, sec: 20 };
const applyProj = () => PROJECTION.sec = PROJ.on ? PROJ.sec : 0;


/* ── which anemometers count ────────────────────────────────────────────────
 *
 * Every wind number in this tool is an average of instruments, and instruments
 * fail one at a time. A mark boat swings on its mooring, a masthead ices up, a
 * boat sails into a hole and reads eight knots while the rest of the course
 * reads twenty — and because every overlay averages the whole set, one bad
 * sensor bends the laylines, the route, the gate bias and the course TWD all at
 * once, quietly, in the same direction.
 *
 * So the set is a control. Every mark and every boat is listed with a tick
 * against it, and everything that takes a wind source gains one more option —
 * SELECTED SOURCES — which reads exactly the ticked ones.
 *
 * Held as the DESELECTED set, not the selected one, so that everything is on by
 * default and stays on when the race changes: a new race brings marks and boats
 * this list has never seen, and a set of what is IN would silently exclude
 * every one of them.
 *
 * The id carries the kind, because a mark called AUS and a boat called AUS are
 * different instruments and must not share a tick.
 */
const WIND_PICK = { off: new Set() };

const windId = (kind, name) => (kind === 'mark' ? 'm:' : 'b:') + name;
const windPicked = (kind, name) => !WIND_PICK.off.has(windId(kind, name));

/* Everything in the loaded race that reads wind, in the order the panel lists
 * them: the marks first because they are the ones you most often want to
 * distrust, then the fleet. */
function windRoster(rd) {
  const marks = [], boats = [];
  if (rd) {
    for (const m of (rd.markWind || [])) if (m && m.name) marks.push(m.name);
    for (const team of (rd.teams || [])) if (!rd.excluded.has(team)) boats.push(team);
  }
  return { marks, boats };
}

/* What this instrument is saying right now, in the list, beside its own tick.
 *
 * The reason you open this list is almost always that one number on the map
 * looks wrong and you want to know whose it is, so the list has to show the
 * readings rather than send you back to the map to guess. A dash where the
 * instrument has nothing at this instant is itself the answer often enough.
 */
function windReadout(rd, kind, name, t) {
  if (!rd || t == null) return '';
  if (kind === 'mark') {
    const m = (rd.markWind || []).find(x => x && x.name === name);
    const s = m && typeof markWindAt === 'function' ? markWindAt(m, t) : null;
    return s ? `${Math.round(((s.twd % 360) + 360) % 360)}° ${s.tws.toFixed(1)}` : '—';
  }
  const tr = rd.tracks[name];
  const s = tr ? sampleAt(tr, t) : null;
  return s && s.twd != null && s.tws != null
    ? `${Math.round(((s.twd % 360) + 360) % 360)}° ${s.tws.toFixed(1)}` : '—';
}

/* The list is built by a HEAVY sync, which does not run per frame — rebuilding
 * a dozen rows sixty times a second to move two numbers would be absurd. So the
 * rows are built once and their readings are repainted in place from the draw
 * loop, and only while the WIND tab is actually open. */
let WSRC_BOX = null, WSRC_T = null, WSRC_SIG = null, WSRC_REBUILD = null;

/* The roster this list was built from. Changing race swaps the fleet and often
 * the marks, and nothing on that path runs a heavy panel sync — so the list sat
 * showing the previous race's instruments, with ticks that no longer pointed at
 * anything. Rather than hunting every code path that can load a race and hoping
 * none is ever added, the list checks its own roster each frame and rebuilds
 * itself when it no longer matches: one string compare over a dozen names. */
const windRosterSig = rd => {
  const { marks, boats } = windRoster(rd);
  return marks.map(n => 'm:' + n).concat(boats.map(n => 'b:' + n)).join('|');
};

function paintWindSources(rd, t) {
  WSRC_T = t;
  if (!WSRC_BOX || !WSRC_BOX.isConnected) return;
  if (WSRC_REBUILD && windRosterSig(rd) !== WSRC_SIG) { WSRC_REBUILD(); return; }
  const sheet = $('menusheet');
  if (!sheet || sheet.hidden || MENU_OPEN !== 'wind') return;
  for (const row of WSRC_BOX.querySelectorAll('.wsrcrow')) {
    const el = row.querySelector('.rd');
    if (el) el.textContent = windReadout(rd, row.dataset.k, row.dataset.n, t);
  }
}

/* How many of each kind are on, for the header line and the hints. */
function windPickCount(rd) {
  const { marks, boats } = windRoster(rd);
  return { marks: marks.filter(n => windPicked('mark', n)).length, nMarks: marks.length,
           boats: boats.filter(n => windPicked('boat', n)).length, nBoats: boats.length };
}


/* ── the control rail ───────────────────────────────────────────────────────
 *
 * Declared, not hand-written: a new feature is one entry in this array and it
 * arrives with its label, its widget and its wiring.
 *
 * Three rules keep forty settings navigable:
 *   · a control that depends on another (`dep`) is not drawn at all while that
 *     other one is off, so the rail only ever shows what is live;
 *   · every section carries a one-line summary of its own state in its header,
 *     so you can read the whole rail shut;
 *   · the prose lives behind the HELP switch and in hover tooltips, not in the
 *     column you are trying to scan.
 *
 * kinds:  toggle | num | select | button | custom
 * control: label, get(), set(v), optional dep() and optional hint (string or
 *          function, one short line).
 */
/* ── the basemap's state and its tile sources ────────────────────────────────
 *
 * Declared up here, above PANELS, rather than beside the drawing code where the
 * rest of the basemap lives. A control's `options` array is read when PANELS is
 * DEFINED, not when the rail is built, so a style table declared further down
 * the file is still in its temporal dead zone at that moment — which threw on
 * load and took the whole app down with it. Data that a control enumerates has
 * to be declared before the control.
 */
const BASEMAP = { on: true, alpha: 0.3, style: 'dark' };

/* Which tiles.
 *
 * The standard OSM rendering is a STREET map, and on the water that is exactly
 * the wrong thing: it draws maritime boundaries, nature-reserve outlines and
 * ferry routes as long pale straight lines across open sea, which read as a
 * grid laid over the course and are impossible to tell from one. That is the
 * reason for this list.
 *
 * The default is Esri's label-free dark canvas: coastline, land shape and
 * almost nothing else — no roads, no boundaries, no text. It is what you want
 * under a race course, and it suits the dark theme.
 *
 * CARTO's equivalent was here first and had to go: their CDN now answers
 * without a key by serving a perfectly valid tile with API KEY REQUIRED printed
 * across it, which the loader cannot tell from a map and draws. A source that
 * fails by returning the wrong picture is worse than one that fails outright.
 *
 * Esri's tiles number their rows and columns the other way round — z/y/x, not
 * z/x/y — hence the ESRI() helper rather than one shared template.
 *
 * Every one of these asks for attribution, so `credit` travels with the URL and
 * is drawn in the corner whenever the layer is on.
 */
/* Whatever `style` says, always a real style. A value stored by an older build
 * can name a source that no longer exists — CARTO's did, the moment it started
 * demanding a key — and every read of this table is inside the draw loop, where
 * an undefined lookup takes the whole frame down rather than losing a map. */
const basemapStyle = () => BASEMAP_STYLES[BASEMAP.style] || BASEMAP_STYLES.dark;

const ESRI = svc => (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/${z}/${y}/${x}`;

const BASEMAP_STYLES = {
  /* Esri's Canvas layers: land and water shape, coastline, almost nothing else.
   * The "Base" half of each pair carries no labels at all — Esri ships the text
   * as a separate Reference layer, which is simply not asked for here. */
  dark:  { url: ESRI('Canvas/World_Dark_Gray_Base'),
           credit: '© Esri, HERE, Garmin, © OpenStreetMap contributors', max: 16,
           name: 'dark, no labels' },
  light: { url: ESRI('Canvas/World_Light_Gray_Base'),
           credit: '© Esri, HERE, Garmin, © OpenStreetMap contributors', max: 16,
           name: 'light, no labels' },
  sat:   { url: ESRI('World_Imagery'),
           credit: 'Imagery © Esri, Maxar, Earthstar Geographics', max: 19,
           name: 'satellite' },
  ocean: { url: ESRI('Ocean/World_Ocean_Base'),
           credit: '© Esri, GEBCO, NOAA, National Geographic', max: 13,
           name: 'ocean / bathymetry' },
  osm:   { url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
           credit: '© OpenStreetMap contributors', max: 19,
           name: 'street map' },
};

/* Declared above PANELS, not beside drawGas where it is used — the SHADE
 * control enumerates it, and a control's `options` array is read when PANELS is
 * DEFINED. Left further down the file it is in its temporal dead zone at that
 * moment and the whole app throws on load. Second time: data a control lists
 * goes before the control.
 */
/* Dirty air is not a colour on the water, so every one of these is a neutral —
 * a haze rather than another overlay competing with the greens and reds the
 * rest of the map is drawn in. Which neutral depends entirely on what is
 * underneath: over near-black water only a LIGHT smoke shows at all, over
 * satellite imagery or the paper themes only a DARK one does. Hence a choice
 * rather than a constant. */
const GAS_SHADES = [
  ['196,190,178', 'pale smoke'],
  ['225,228,232', 'white smoke'],
  ['150,138,124', 'warm grey'],
  ['120,132,145', 'cool grey'],
  ['74,80,88',    'dark smoke'],
  ['20,24,30',    'soot'],
];

const PANELS = [

  /* ── the three modes ──────────────────────────────────────────────────────
     This panel used to be PRESETS: a free list of saved settings you clicked
     when the moment changed. The list and the moment are now one thing. There
     are exactly three moments in a race — the countdown, a beat, a run — the
     tool knows which one it is in, and each keeps its own menu, so there is
     nothing to click and nothing to forget to click. What is left is the
     housekeeping: put what is on screen into a mode, or put a mode back to how
     it shipped, and carry the three of them between machines. */
  { title: 'MODES', group: 'presets',
    sum: () => MODE_NAME[MODE.now] + (MODE.hold === 'auto' ? '' : ' · held'),
    controls: [
    { kind: 'custom', build: box => {
      box.className = 'pset';
      box.innerHTML = '';

      for (const m of MODES) {
        const row = document.createElement('div');
        row.className = 'row' + (MODE.now === m ? ' live' : '');

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = MODE_NAME[m];
        name.title = MODE.hold === m
          ? `held in ${MODE_NAME[m]} — click to let the race decide again`
          : `hold ${MODE_NAME[m]}, whatever the boat is doing`;
        name.onclick = () => setHold(MODE.hold === m ? 'auto' : m);
        if (MODE.hold === m) name.style.color = 'var(--amber)';
        row.appendChild(name);

        // SAVE is rarely needed — the live menu IS this mode's settings and is
        // written back on every change — but it is the way to copy what you
        // have set up in one mode into another.
        const put = document.createElement('button');
        put.textContent = 'SAVE';
        put.title = `overwrite ${MODE_NAME[m]} with the settings as they are now`;
        put.onclick = () => { MODE.sets[m] = modeSnapshot(); saveModes(); syncPanels(); };
        row.appendChild(put);

        const rst = document.createElement('button');
        rst.textContent = 'RESET';
        rst.title = `put ${MODE_NAME[m]} back to how it ships`;
        rst.onclick = () => {
          MODE.sets[m] = { ...modeSeed(m) };
          if (MODE.now === m) modeApplySet(MODE.sets[m]);
          saveModes(); syncPanels(); paintBar(); draw();
        };
        row.appendChild(rst);

        box.appendChild(row);
      }

      /* The three sets live in this browser's localStorage, which means they do
       * not survive a cleared cache and cannot be handed to anyone else. These
       * two make them a file. Import replaces per mode rather than wholesale,
       * so a file carrying only DOWNWIND leaves the other two alone. */
      const io = document.createElement('div');
      io.className = 'row';

      const dl = document.createElement('button');
      dl.textContent = 'DOWNLOAD';
      dl.title = 'save all three modes to a .json file';
      dl.onclick = () => {
        const blob = new Blob(
          [JSON.stringify({ app: 'seagull-lab', kind: 'modes', v: 2,
                            saved: new Date().toISOString(),
                            keys: KEY_BIND, modes: MODE.sets }, null, 2)],
          { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `seagull-modes-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      };

      const pick = document.createElement('input');
      pick.type = 'file'; pick.accept = 'application/json,.json'; pick.hidden = true;
      pick.onchange = async () => {
        const f = pick.files && pick.files[0];
        if (!f) return;
        try {
          const d = JSON.parse(await f.text());
          const got = d && (d.modes || (d.kind === 'modes' ? d : null));
          if (!got || typeof got !== 'object') throw new Error('no modes in that file');
          let n = 0;
          for (const m of MODES)
            if (got[m] && typeof got[m] === 'object') {
              MODE.sets[m] = migrateSettings(got[m]); n++;
            }
          if (!n) throw new Error('nothing usable in that file');
          // The keymap travels with them when the file carries one.
          if (d.keys && typeof d.keys === 'object') {
            for (const k of Object.keys(KEY_BIND)) delete KEY_BIND[k];
            Object.assign(KEY_BIND, d.keys);
            saveBinds();
          }
          modeApplySet(MODE.sets[MODE.now]);
          saveModes(); syncPanels(); paintBar(); draw();
          note.textContent = `loaded ${n} mode${n === 1 ? '' : 's'}.`;
        } catch (err) {
          note.textContent = 'could not read that file: ' + err.message;
        }
        pick.value = '';
      };

      const up = document.createElement('button');
      up.textContent = 'LOAD';
      up.title = 'read modes back from a .json file';
      up.onclick = () => pick.click();

      io.append(dl, up, pick);
      box.appendChild(io);

      const note = document.createElement('p');
      note.className = 'note help';
      note.textContent = 'Every setting in this rail except ZOOM and the LOOK '
        + 'panel, plus the wind sources. The mode in force is lit; a held one '
        + 'is amber. The file also carries your key bindings.';
      box.appendChild(note);
    } },
  ]},

  { title: 'CONE', group: 'start',
    sum: () => CONE.on ? `${CONE.spread >= 180 ? 'full sweep' : '±' + CONE.spread + '°'}`
                        + ` · ${CONE.aggr < .34 ? 'repeatable'
                          : CONE.aggr > .66 ? 'best of it' : 'mixed'}` : 'off',
    controls: [
    { kind: 'bool', label: 'CONE', get: () => CONE.on, set: v => CONE.on = v,
      hint: 'where you would be at the gun if you pulled the trigger now, one '
          + 'arm per heading you could steer. Pre-start only — after the gun '
          + 'there is no line to be early to.' },
    { kind: 'num', label: 'SPREAD', min: 20, max: 180, step: 5,
      get: () => CONE.spread, set: v => CONE.spread = v,
      hint: 'degrees either side of the course you are on. At 180 the sweep '
          + 'is full and the starboard-tack lobe comes out whole — the only '
          + 'one drawn — which is the point in the entry, when the lobe that '
          + 'matters is the one you are not on yet. The arms furthest from '
          + 'your course are the ones the turn would cost most, and the turn '
          + 'is not modelled, so a wide cone is the optimistic one.' },
    { kind: 'num', label: 'ARM EVERY', min: 2, max: 15, step: 1,
      get: () => CONE.step, set: v => CONE.step = v,
      hint: 'degrees between arms. Finer is smoother and no more true.' },
    { kind: 'num', label: 'TRIGGER', min: 0, max: 1, step: 0.05,
      get: () => CONE.aggr, set: v => CONE.aggr = v,
      hint: () => `0 = the acceleration you get every time (75th percentile of `
          + `the fleet-wide archive), 1 = the best the fleet manages (90th). At `
          + `${CONE.aggr.toFixed(2)} the cone is ${CONE.aggr < .34 ? 'one you can sail to'
          : CONE.aggr > .66 ? 'the optimistic edge' : 'between the two'}.` },
    { kind: 'bool', label: 'ARMS', get: () => CONE.rays, set: v => CONE.rays = v,
      hint: 'the individual headings, drawn. Off leaves the shape alone.' },
    { kind: 'num', label: 'OPACITY', min: 0.05, max: 0.8, step: 0.05,
      get: () => CONE.fill, set: v => CONE.fill = v,
      hint: 'how heavily the fan sits on the water.' },
  ]},

  { title: 'VIEW', group: 'view',
    sum: () => (VIEWPORT_NAME[APP.opts.mode] || '')
             + (MAP_ROT.mode !== 'course' ? ` · ${MAP_ROT.mode} up` : ''),
    controls: [
    { kind: 'select', label: 'VIEWPORT',
      options: [['fleet', 'follow fleet'], ['course', 'whole course'],
                ['boat', 'target boat'], ['boatOffset', 'target boat offset']],
      get: () => APP.opts.mode,
      set: v => { APP.opts.mode = v; syncRecentre(); },
      hint: () => APP.opts.mode === 'course' ? 'every mark, gate and the finish.'
        : APP.opts.mode === 'boat' ? 'MY BOAT centred, on a fixed piece of water.'
        : APP.opts.mode === 'boatOffset'
        ? 'MY BOAT a third in, two thirds open towards its next mark.'
        : 'the boats, and the start line with them until the gun.' },
    { kind: 'num', label: 'ZOOM', min: 0.1, max: 12, step: 0.25, noPreset: true,
      get: () => APP.opts.zoom, set: v => APP.opts.zoom = v,
      hint: () => (APP.opts.mode === 'boat' || APP.opts.mode === 'boatOffset')
        ? 'wheel to zoom on MY BOAT, drag to pan, double-click to reset.'
        : 'wheel to zoom on the cursor, drag to pan, double-click to reset.' },
    { kind: 'button', label: 'RESET VIEW', text: 'RESET', act: resetView },
    { kind: 'select', label: 'ORIENTATION',
      options: [['course', 'aligned with course'], ['wind', 'aligned with wind'],
                ['boat', 'target boat heading'], ['north', 'north up']],
      get: () => MAP_ROT.mode, set: v => MAP_ROT.mode = v,
      hint: () => MAP_ROT.mode === 'course'
        ? 'the racetrack upright: start line vertical, windward mark at the top.'
        : MAP_ROT.mode === 'wind'
        ? 'the wind straight down the screen, so a shift shows as the course '
          + 'leaning rather than as a number changing.'
        : MAP_ROT.mode === 'boat'
        ? 'MY BOAT pointing up, the way the crew sees it. Averaged over a few '
          + 'seconds so the map does not shake with the yaw.'
        : 'north at the top, which is how the world is drawn everywhere else.' },
    /* `noMode` for the same reason as LOOK, and one more: the lag is what
       decides WHEN the mode changes, so a mode that could change it would be
       moving its own goalposts as it crossed. */
    /* `noMode`: WHETHER you want a grid is a decision about the map, like the
       theme or the basemap, not about the leg — so it is one switch for the
       whole tool. Per-mode it was a trap: turn it off in the countdown and it
       came straight back at the gun, because UPWIND holds its own copy, which
       is indistinguishable from a switch that does not work.

       Its ORIENTATION stays per-mode, because that genuinely is a decision
       about the leg — square to the course on the way up, square to the wind on
       the way down. */
    { kind: 'toggle', label: 'GRID', noMode: true,
      get: () => GRID.on, set: v => GRID.on = v,
      hint: '50 m squares zoomed in, 200 m zoomed out — the same two steps the '
          + 'scale bar shows, so one square is always one bar. One switch for '
          + 'every mode; the orientation below is per-mode.' },
    { kind: 'select', label: 'GRID FROM',
      options: [['course', 'the course axis'], ['boat', 'the boat I am tracking'],
                ['mark', 'the course marks'], ['selected', 'selected sources']],
      get: () => GRID.source, set: v => GRID.source = v,
      dep: () => GRID.on,
      hint: () => GRID.source === 'course'
        ? 'square to the course — a ruler, and the one orientation that never '
          + 'moves. Turn the grid to a wind instead and the difference between '
          + 'the two IS how far off the axis the breeze is sitting.'
        : 'square to the WIND, which makes it a ladder — one family of lines IS '
          + 'the rung, the other is distance up the course, so a header shows up '
          + 'as the fleet crossing the rungs. '
          + WIND_SRC_HINT[GRID.source] },
    { kind: 'num', label: 'GRID DAMPING', min: 1, max: 120, step: 5,
      get: () => GRID.dampSec, set: v => GRID.dampSec = Math.round(v),
      dep: () => GRID.on && GRID.source !== 'course',
      hint: () => `TWD over the last ${Math.round(GRID.dampSec)} s. A grid that `
          + 'twitches with every puff is a grid nobody can look at.' },
    { kind: 'select', label: 'SMOOTHING', noMode: true,
      options: [[0, 'off — raw 1 Hz'], [1, '1 s'], [2, '2 s']],
      get: () => SMOOTH.lag, set: v => SMOOTH.lag = +v,
      hint: () => SMOOTH.lag
        ? `the map runs ${SMOOTH.lag} s behind so each boat can interpolate.`
        : 'raw 1 Hz — the boats step once a second, where they were measured.' },
  ]},

  /* `noMode`: the whole panel is about how the map LOOKS, not about what is
     being asked of it. A theme that flipped at the gun, or a basemap that went
     out, would read as a fault. */
  { title: 'LOOK', group: 'view', noMode: true,
    sum: () => APP.theme + (BASEMAP.on ? ' · map' : ''), controls: [
    { kind: 'select', label: 'THEME',
      options: [['dark', 'dark'], ['mid', 'mid'], ['light', 'light']],
      get: () => APP.theme, set: v => setTheme(v),
      hint: 'the whole player, and it carries the water with it.' },
    { kind: 'select', label: 'WATER',
      options: [['#050506', 'black'], ['#0b1016', 'charcoal'],
                ['#081422', 'deep navy'], ['#101820', 'slate'],
                ['#16202a', 'light slate'], ['#2b3a4a', 'steel'],
                ['#e9eef4', 'paper'], ['#dde7f0', 'mist'],
                ['#cfe0ee', 'pale blue'], ['#bcd6e8', 'shallow'],
                ['#ffffff', 'white']],
      get: () => MAP_INK.bg,
      set: v => { setMapBg(v); $('cTrack').style.background = v; },
      hint: 'the map inverts with this: haloes, grid and hull brightness all '
          + 'follow its luminance.' },
    { kind: 'select', label: 'LABELS',
      options: [[1, 'small'], [1.25, 'medium'], [1.5, 'large'], [1.9, 'huge']],
      get: () => MAP_INK.label, set: v => MAP_INK.label = +v },
    { kind: 'select', label: 'FLEET BRIGHTNESS',
      options: [[0.6, 'dim'], [0.85, 'normal'], [1, 'full']],
      get: () => MAP_INK.fleet, set: v => MAP_INK.fleet = +v,
      hint: 'how far the boats that are not MY BOAT sit behind it.' },
    /* Transparency, not opacity — 0 is solid, 1 is gone but for the halo
     * behind each number, matching how the request for this was phrased
     * rather than how BASEMAP FADE above phrases the same idea the other way
     * round. overlayAlpha() is the ground truth in the CSS variable; this
     * control just shows and sets its complement. */
    { kind: 'num', label: 'OVERLAY TRANSPARENCY', min: 0, max: 1, step: 0.05,
      get: () => Math.round((1 - overlayAlpha()) * 100) / 100,
      set: v => overlayAlpha(Math.round((1 - v) * 100) / 100),
      hint: () => `COURSE, POTENTIAL THREATS and the boat readouts (MY BOAT, `
          + `FLEET RATIO NOW) — 0 is solid, 1 is gone but for the halo behind `
          + `each number. Opens on the theme's own default; move it once and `
          + `it survives a theme switch, the same way WATER does.` },
    { kind: 'toggle', label: 'BASEMAP',
      get: () => BASEMAP.on, set: v => BASEMAP.on = v,
      hint: 'OpenStreetMap under the course. Needs the network.' },
    { kind: 'select', label: 'BASEMAP STYLE',
      options: Object.entries(BASEMAP_STYLES).map(([k, v]) => [k, v.name]),
      get: () => BASEMAP.style,
      set: v => { if (BASEMAP_STYLES[v]) { BASEMAP.style = v; TILES.clear(); } },
      dep: () => BASEMAP.on,
      hint: () => BASEMAP.style === 'osm'
        ? 'the standard OpenStreetMap rendering. It is a STREET map: over water '
          + 'it draws maritime and reserve boundaries as long pale straight lines '
          + 'that look exactly like a grid laid over the course.'
        : BASEMAP.style === 'ocean'
        ? 'bathymetry — depth contours and seabed, made for marine charts. It '
          + 'stops at zoom 13, so close in it goes blank.'
        : BASEMAP.style === 'sat'
        ? 'aerial imagery. No lines at all, and the shoreline is the real one.'
        : 'coastline and land shape, nothing else — no roads, no boundaries, no '
          + 'text. The one to use under a race course.' },
    { kind: 'num', label: 'BASEMAP FADE', min: 0.1, max: 1, step: 0.05,
      get: () => BASEMAP.alpha, set: v => BASEMAP.alpha = Math.max(0.05, Math.min(1, v)),
      dep: () => BASEMAP.on,
      hint: 'how strongly the world shows through.' },
  ]},

  { title: 'BOATS', group: 'boat', sum: () => [POLAR_SEL.pick !== 'auto' ? POLAR_SEL.pick : null,
                                APP.opts.trailSec === 999 ? 'trails' : `${APP.opts.trailSec}s`,
                                RATIO.on ? 'colours' : null,
                                PROJ.on ? `${PROJ.sec}s` : null].filter(Boolean).join(' · '),
    controls: [
    /* Which measured acceleration table the start cone and every TTK/TTL
     * number runs on. Options come from the tables actually shipped in
     * accel.js, so a regeneration that adds a polar adds it here too. */
    { kind: 'select', label: 'POLAR', noMode: true,
      options: [['auto', 'auto (race config)'],
        ...Object.keys(ACCEL_CFG)
          .sort((a, b) => (+a.slice(1)) - (+b.slice(1)))
          .map(k => [k, k + ({ m14: ' · AP wing', m15: ' · heavy air',
                               m21: ' · light air', m23: ' · AP/LA boards' }[k] || '')])],
      get: () => POLAR_SEL.pick,
      set: v => POLAR_SEL.pick = v,
      hint: () => POLAR_SEL.pick === 'auto'
        ? 'the acceleration table follows the race’s own rig config.'
        : `start cone and TTK build speed at the ${POLAR_SEL.pick} table, mined `
          + 'from every 2025-26 event. The speed ceiling per angle still comes '
          + 'from the race’s polar file.' },
    { kind: 'select', label: 'TRAILS',
      options: [[10, '10 s'], [20, '20 s'], [30, '30 s'], [60, '60 s'], [999, 'everything']],
      get: () => APP.opts.trailSec, set: v => APP.opts.trailSec = +v },
    { kind: 'toggle', label: 'SPEED LABELS',
      get: () => APP.opts.allSog, set: v => APP.opts.allSog = v,
      hint: 'km/h beside every boat, not only MY BOAT.' },
    { kind: 'toggle', label: 'TARGET COLOURS',
      get: () => RATIO.on,
      set: v => { RATIO.on = v; if (v && APP.rd) findRatioCrossings(APP.rd); },
      hint: () => `above ${RATIO.target.toFixed(2)} red, at or below it green.` },
    { kind: 'num', label: 'RATIO TARGET', min: 0.2, max: 6, step: 0.1,
      get: () => RATIO.target, dep: () => RATIO.on,
      set: v => { RATIO.target = v; if (RATIO.on && APP.rd) findRatioCrossings(APP.rd); } },
    { kind: 'toggle', label: 'PROJECTION',
      get: () => PROJ.on, set: v => { PROJ.on = v; applyProj(); },
      hint: () => `${PROJ.sec} s ahead at the current speed and heading.` },
    { kind: 'select', label: 'PROJECTION LENGTH',
      options: PROJECTION_STEPS.map(s => [s, s + ' s']), dep: () => PROJ.on,
      get: () => PROJ.sec, set: v => { PROJ.sec = +v; applyProj(); } },
  ]},

  /* ── threats ──────────────────────────────────────────────────────────────
     Its own panel, because it is two different lists that happen to share a
     box. Before the gun it is a RING — everybody within so many metres of us,
     placed by the angle they sit at. Racing it is a RUNG — everybody level with
     us up the course, however far across it they are. Those want different
     numbers, and mixed in among the boat settings under one "THREAT" prefix
     they read as variants of one thing and were hard to find at all. */
  { title: 'THREATS', group: 'boat',
    sum: () => !THREATS.on ? 'off'
             : MODE.now === 'pre' ? `ring ${PRE_THREAT.radiusM} m`
             : `rung ${THREATS.radiusM} m`,
    controls: [
    { kind: 'toggle', label: 'THREATS',
      get: () => THREATS.on, set: v => THREATS.on = v,
      hint: 'the box under COURSE on the left. Before the gun it lists everybody '
          + 'inside the ring by the angle they sit at; racing it lists everybody '
          + 'level with you on the ladder. Click a row to make that boat the one '
          + 'everything else is measured against.' },

    { kind: 'num', label: 'PRE-START RING', min: 50, max: 400, step: 10,
      get: () => PRE_THREAT.radiusM, set: v => PRE_THREAT.radiusM = Math.round(v),
      dep: () => THREATS.on,
      hint: () => `PRE-START. Every boat within ${Math.round(PRE_THREAT.radiusM)} m of `
                + 'us, wherever they are — this is a straight-line ring, not a rung. '
                + 'Each is coloured by the sector it sits in off our own line; the '
                + 'wedge on our transom flashes.' },

    { kind: 'num', label: 'RACE CROSSWIND', min: 10, max: 600, step: 10,
      get: () => THREATS.radiusM, set: v => THREATS.radiusM = Math.round(v),
      dep: () => THREATS.on,
      hint: () => `RACING. Metres up or down your ladder rung — the only distance `
                + `that decides the racing list. Inside ${Math.round(THREATS.radiusM)} m `
                + 'of level with you and on your leg, a boat is on the list.' },

    { kind: 'num', label: 'RACE RANGE', min: 0, max: 800, step: 25,
      get: () => THREATS.rangeM, set: v => THREATS.rangeM = Math.round(v),
      dep: () => THREATS.on,
      hint: () => THREATS.rangeM
        ? `also within ${Math.round(THREATS.rangeM)} straight-line metres. The rung `
          + 'runs along the wind only, so a boat on the far side of the course can '
          + 'read as exactly level with you; this is the cap that keeps it off the '
          + 'list. 0 removes it — crosswind distance alone decides.'
        : 'off — crosswind distance alone decides, however far across the course a '
          + 'boat is. Set a figure to also require it to be near you.' },

    { kind: 'num', label: 'FLASH', min: 0, max: 80, step: 5,
      get: () => THREATS.flashM, set: v => THREATS.flashM = Math.round(v),
      dep: () => THREATS.on,
      hint: () => THREATS.flashM
        ? `RACING. A boat within ${Math.round(THREATS.flashM)} m of your rung pulses, `
          + 'so it is picked up out of the corner of your eye rather than by reading '
          + 'the list. 0 turns the pulse off. (Before the gun it is the critical '
          + 'sector that flashes, not a distance.)'
        : 'off — no row pulses, however close.' },

    { kind: 'num', label: 'AVERAGE', min: 2, max: 20, step: 1,
      get: () => THREATS.avgSec, set: v => THREATS.avgSec = Math.round(v),
      dep: () => THREATS.on,
      hint: () => `seconds. Everything on this list that says something is CHANGING `
                + `is measured over this window rather than frame to frame: the `
                + `gaining and losing arrows, the converging and diverging pair, and `
                + `the TAIL/CHASE tag before the gun. At `
                + `${Math.round(THREATS.avgSec)} s a real trend shows and the wave-by-`
                + `wave wobble does not — shorter and the arrows flicker, longer and `
                + 'they lag the boat.' },
  ]},

  { title: 'COURSE', group: 'view', sum: () => APP.opts.showLimits ? 'on' : 'off', controls: [
    { kind: 'toggle', label: 'COURSE LIMITS',
      get: () => APP.opts.showLimits, set: v => APP.opts.showLimits = v,
      hint: 'the boundary, the marks and their zones.' },
    { kind: 'num', label: 'MARK ZONE', min: 0, max: 200, step: 10,
      get: () => MARK_ZONE.m, set: v => MARK_ZONE.m = Math.max(0, Math.round(v)),
      dep: () => APP.opts.showLimits !== false,
      hint: () => MARK_ZONE.m
        ? `a ${Math.round(MARK_ZONE.m)} m no-go circle around every mark.`
        : 'off — the marks are drawn as buoys alone.' },
    { kind: 'num', label: 'BOUNDARY BAND', min: 0, max: 200, step: 10,
      get: () => BOUNDARY_BAND.m, set: v => BOUNDARY_BAND.m = Math.max(0, Math.round(v)),
      dep: () => APP.opts.showLimits !== false,
      hint: () => BOUNDARY_BAND.m
        ? `the course file stores the <b>inside</b> edge; ${Math.round(BOUNDARY_BAND.m)} m `
          + 'of zone is shaded outside it.'
        : 'off — only the inside edge is drawn.' },
  ]},

  { title: 'START', group: 'start', sum: () => [APP.opts.wave ? 'wave' : null,
                                WAVE_RATIO.on ? WAVE_RATIO.target.toFixed(2) : null,
                                APP.opts.laylines ? 'lines' : null,
                                END_LEGS.on ? 'M1' : null]
                               .filter(Boolean).join(' · ') || 'off',
    controls: [
    { kind: 'toggle', label: 'WAVE',
      get: () => APP.opts.wave, set: v => APP.opts.wave = v,
      hint: 'every place you could still be and make the line on the gun.' },
    { kind: 'toggle', label: 'WAVE @ RATIO',
      get: () => WAVE_RATIO.on, set: v => WAVE_RATIO.on = v,
      hint: () => `the same front at ratio ${WAVE_RATIO.target.toFixed(2)}.` },
    { kind: 'num', label: 'WAVE RATIO', min: 0.2, max: 6, step: 0.1,
      get: () => WAVE_RATIO.target, set: v => WAVE_RATIO.target = v,
      dep: () => WAVE_RATIO.on },
    { kind: 'toggle', label: 'LINE TO M1',
      get: () => END_LEGS.on, set: v => END_LEGS.on = v,
      hint: 'a leg from each end of the line to M1, with its length and the '
          + 'seconds it takes at the polar\u2019s best speed made good on that '
          + 'bearing \u2014 the comparison the start is about.' },
    { kind: 'select', label: 'M1 WIND FROM',
      options: [['race', 'the race TWD'], ['mark', 'the course marks'],
                ['boat', 'the boat I am tracking'], ['both', 'the boat + the marks'],
                ['all', 'all sources']],
      get: () => END_LEGS.source, set: v => END_LEGS.source = v,
      dep: () => END_LEGS.on,
      hint: 'the wind the TWA to M1 is measured against — and the seconds with '
          + 'it, since speed made good depends on where the wind is.' },
    { kind: 'num', label: 'M1 DAMPING', min: 1, max: 120, step: 5,
      get: () => END_LEGS.dampSec, set: v => END_LEGS.dampSec = Math.round(v),
      dep: () => END_LEGS.on && END_LEGS.source !== 'race',
      hint: () => `TWD over the last ${Math.round(END_LEGS.dampSec)} s.` },
    { kind: 'num', label: 'LAST TACK RATIO', min: 1, max: 3, step: 0.05,
      get: () => LAST_TACK.ratio, set: v => LAST_TACK.ratio = v,
      hint: 'the ratio the LAST TACK countdown in MY BOAT runs down to. Above '
          + '1.00 because the turn itself costs seconds and comes out slow \u2014 '
          + 'this is the margin for it, and it is a judgement, not a measurement.' },
    { kind: 'num', label: 'OUT AND BACK TACK', min: 0, max: 30, step: 1,
      get: () => OUT_BACK.tackLossS, set: v => OUT_BACK.tackLossS = Math.round(v),
      hint: 'seconds added to the pin-end loop for the turn at the far end. The '
          + 'polar has nothing to say about a 180\u00b0 turn, so this is an '
          + 'allowance rather than a measurement.' },
    { kind: 'toggle', label: 'START LAYLINES',
      get: () => START_LAY.on, set: v => START_LAY.on = v,
      hint: 'the STARBOARD layline back from each end of the start line, at the '
          + 'upwind target angle. One tack only \u2014 the one you have rights on.' },
    { kind: 'select', label: 'START WIND FROM',
      options: [['boat', 'the boat I am tracking'], ['mark', 'the start marks'],
                ['selected', 'selected sources'], ['manual', 'manual TWD']],
      get: () => START_LAY.source, set: v => START_LAY.source = v,
      dep: () => START_LAY.on,
      hint: () => START_LAY.source === 'manual'
        ? 'a TWD you type, held fixed \u2014 for when you want to see the line '
          + 'against a shift you are expecting rather than the one blowing.'
        : START_LAY.source === 'mark'
        ? 'the mark boats sitting ON the start line (SL\u2026), which are the '
          + 'closest witnesses to its own air. Where a race carries none, every '
          + 'mark on the course stands in.'
        : WIND_SRC_HINT[START_LAY.source] },
    { kind: 'num', label: 'START TWD', min: 0, max: 359, step: 1,
      get: () => START_LAY.twd, set: v => START_LAY.twd = ((Math.round(v) % 360) + 360) % 360,
      dep: () => START_LAY.on && START_LAY.source === 'manual',
      hint: () => `laylines drawn against ${Math.round(START_LAY.twd)}\u00b0, whatever `
                + 'the instruments say.' },
    { kind: 'num', label: 'START DAMPING', min: 1, max: 120, step: 5,
      get: () => START_LAY.dampSec, set: v => START_LAY.dampSec = Math.round(v),
      dep: () => START_LAY.on && START_LAY.source !== 'manual',
      hint: () => `TWD and TWS over the last ${Math.round(START_LAY.dampSec)} s.` },
    /* What the old START LAYLINES switch actually controlled, under a name that
     * says so. It never drew a layline: it draws the advantage band along the
     * line and the fast-point marker with its chip. Keeping the switch matters
     * — those two are the busiest thing on the map in the last minute and you
     * have to be able to turn them off — but keeping the wrong name on it while
     * a real start layline sits directly above would be indefensible. */
    { kind: 'toggle', label: 'FAST POINT + ADVANTAGE',
      get: () => APP.opts.laylines, set: v => APP.opts.laylines = v,
      hint: 'the advantage band along the line and the fast-point marker.' },
    { kind: 'select', label: 'FAST POINT WIND',
      options: [['boat', 'the boat I am tracking'], ['mark', 'the start marks'],
                ['selected', 'selected sources'], ['manual', 'manual TWD'],
                ['race', 'the race TWD (fixed)']],
      get: () => FAST_PT.source, set: v => FAST_PT.source = v,
      dep: () => APP.opts.laylines,
      hint: () => FAST_PT.source === 'race'
        ? 'the race average, solved once — the fast point does not move all '
          + 'pre-start. What this used to do, always.'
        : FAST_PT.source === 'manual'
        ? 'a TWD you type. The fast point jumps to where it would be in that '
          + 'wind, which is the cheapest way to ask what a shift is worth.'
        : FAST_PT.source === 'mark'
        ? 'the mark boats on the start line (SL\u2026), so the fast point tracks '
          + 'the air over the line itself.'
        : WIND_SRC_HINT[FAST_PT.source] },
    { kind: 'num', label: 'FAST POINT TWD', min: 0, max: 359, step: 1,
      get: () => FAST_PT.twd, set: v => FAST_PT.twd = ((Math.round(v) % 360) + 360) % 360,
      dep: () => APP.opts.laylines && FAST_PT.source === 'manual',
      hint: () => `the fast point and the advantage curve solved against `
                + `${Math.round(FAST_PT.twd)}\u00b0.` },
    { kind: 'num', label: 'FAST POINT DAMPING', min: 1, max: 120, step: 5,
      get: () => FAST_PT.dampSec, set: v => FAST_PT.dampSec = Math.round(v),
      dep: () => APP.opts.laylines && !['manual', 'race'].includes(FAST_PT.source),
      hint: () => `TWD over the last ${Math.round(FAST_PT.dampSec)} s. Long, `
                + 'because the fast point crawling about on every gust is worse '
                + 'than one that is a few seconds behind.' },
    { kind: 'toggle', label: 'Z',
      get: () => ZPT.on, set: v => { ZPT.on = v; if (v && !ZPT.p) zDrop(); },
      hint: 'a spot you drop on the water by hand. Drag the pin, then '
          + 'double-click it (or CONFIRM below) to lock it, and MY BOAT carries '
          + 'the port-tack angle, distance and time to it. While you are '
          + 'placing it a faint pink cone hangs off the pin — what a trigger '
          + 'pull from THERE reaches, in the start marks’ own wind, sized '
          + 'by Z RATIO below — and comes off when you lock. Everything Z '
          + 'retires while you are on starboard.' },
    { kind: 'button', label: 'Z PIN',
      text: () => ZPT.locked ? 'RESET' : 'CONFIRM',
      act: () => { if (!ZPT.p) zDrop(); else ZPT.locked = !ZPT.locked; },
      dep: () => ZPT.on,
      hint: () => ZPT.locked
        ? 'locked — the pin cannot be dragged, so panning and following the boat '
          + 'cannot move it. RESET, or double-click the pin, to edit it again.'
        : 'drag the pin on the map, then CONFIRM — or double-click the pin — to '
          + 'freeze it there.' },
    { kind: 'button', label: 'Z DROP', text: () => 'RE-DROP HERE',
      act: () => zDrop(),
      dep: () => ZPT.on,
      hint: 'put the pin back in the middle of the view, unlocked.' },
    { kind: 'num', label: 'Z TARGET RATIO', min: 0.5, max: 3, step: 0.05,
      get: () => ZPT.targetRatio, set: v => ZPT.targetRatio = v,
      dep: () => ZPT.on,
      hint: () => `the margin you want in hand for the tack AT Z — the same `
          + `idea as LAST TACK RATIO, for this tack. RATIO AT Z (below) is `
          + `your ratio sailing from Z back to the line; TTK TO Z = 0 is `
          + `defined as the moment that ratio equals this target, not the `
          + `moment you merely arrive — so a boat reaching Z at ratio 1.00 `
          + `with nothing left for the tack reads as LATE, not on time. `
          + `Also sizes the pink ghost cone on the rare frame leg 1 has no `
          + `answer yet — day to day the cone sizes itself off the real `
          + `time left, not this.` },
    /* The entry verdict, tunable rather than fixed, because "how much slack
     * counts as early" is a judgement a crew makes about their own start, not
     * a measurement. Both read off ttkZBoat — an accelerating run to the pin
     * on the measured table, capped at the polar, scaled by Z TARGET RATIO
     * against the second leg (Z to the line) — for every boat, not only the
     * one you are tracking, so the fleet table and MY BOAT never disagree
     * about who is early or late. */
    { kind: 'num', label: 'Z LATE UNDER', min: -30, max: 15, step: 1,
      get: () => ZPT.lateUnder, set: v => ZPT.lateUnder = Math.round(v),
      dep: () => ZPT.on,
      hint: () => `TTK to Z below ${ZPT.lateUnder}s — or a heading to Z the `
          + `boat cannot sail at all — is a LATE entry. 0 means any boat `
          + `without time in hand for the pin is already late for it.` },
    { kind: 'num', label: 'Z EARLY OVER', min: 0, max: 60, step: 1,
      get: () => ZPT.earlyOver, set: v => ZPT.earlyOver = Math.round(v),
      dep: () => ZPT.on,
      hint: () => `TTK to Z above ${ZPT.earlyOver}s is an EARLY entry — more `
          + `slack for the pin than the entry needs. Between the two `
          + `thresholds reads as ON TIME.` },
    { kind: 'num', label: 'Z WIND DAMPING', min: 5, max: 60, step: 1,
      get: () => ZPT.windDampSec, set: v => ZPT.windDampSec = Math.round(v),
      dep: () => ZPT.on,
      hint: () => `TWD/TWS over the last ${Math.round(ZPT.windDampSec)} s, `
          + `vector-averaged (start marks where the race carries them) — the `
          + `wind every leg of the Z system runs on: TTK TO Z, TTK TO BOAT `
          + `END, and the pink cone's own fan. Raw wind swings hard for a `
          + `few seconds coming out of a tack, which used to show up as the `
          + `cone and TTK TO BOAT END jumping around right along with it. `
          + `Longer here means steadier numbers but slower to catch a real `
          + `shift.` },
  ]},

  /* The mode is not a setting, it is where you are — so it is neither carried
   * by a preset nor owned by a mode, or applying one would move you. */
  { title: 'MODE', group: 'view', noMode: true,
    sum: () => MODE_NAME[MODE.now] + (MODE.hold === 'auto' ? '' : ' · held'),
    controls: [
    { kind: 'select', label: 'MODE', noPreset: true, noMode: true,
      options: [['auto', 'auto — the race decides'], ['pre', 'hold PRE-START'],
                ['up', 'hold UPWIND'], ['down', 'hold DOWNWIND']],
      get: () => MODE.hold, set: v => { MODE.hold = v; },
      hint: 'three sets of settings — the countdown, a beat, a run — and the '
          + 'tool crosses between them on its own: <b>at the gun</b>, then at '
          + 'every rounding that changes the leg from upwind to downwind or '
          + 'back. Hold one to review with the boat somewhere else.' },
    { kind: 'button', label: 'MODE COPY', text: () => 'COPY TO THE OTHER TWO',
      act: () => { for (const m of MODES) if (m !== MODE.now) MODE.sets[m] = modeSnapshot();
                   saveModes(); syncPanels(); },
      hint: () => `put the menu as it is now into the other two modes as well, `
          + `so all three start from what ${MODE_NAME[MODE.now]} looks like.` },
  ]},

  { title: 'ROUTE', group: 'route', sum: () => [ROUTE.on ? 'this leg' : null,
                                ROUTE.next ? 'next' : null].filter(Boolean).join(' · ') || 'off',
    controls: [
    { kind: 'toggle', label: 'ROUTE',
      get: () => ROUTE.on, set: v => ROUTE.on = v,
      hint: 'the leg you are on, forked at the boat: hold this gybe, or switch now.' },
    { kind: 'toggle', label: 'NEXT LEG',
      get: () => ROUTE.next, set: v => ROUTE.next = v,
      hint: 'the leg after, dashed — one branch off each gate mark, on opposite '
          + 'tacks, with the seconds to its first turn.' },
    { kind: 'select', label: 'WIND FROM',
      options: [['boat', 'the boat I am tracking'], ['mark', 'the course marks'],
                ['selected', 'selected sources'], ['race', 'the race TWD']],
      get: () => ROUTE.source, set: v => ROUTE.source = v,
      dep: () => ROUTE.on || ROUTE.next,
      hint: () => WIND_SRC_HINT[ROUTE.source] },
    { kind: 'num', label: 'DAMPING', min: 1, max: 60, step: 1,
      get: () => ROUTE.dampSec, set: v => ROUTE.dampSec = Math.round(v),
      dep: () => (ROUTE.on || ROUTE.next) && ROUTE.source !== 'race',
      hint: () => `TWD over the last ${Math.round(ROUTE.dampSec)} s.` },
  ]},

  { title: 'LAYLINES', group: 'route',
    sum: () => LAYLINE.on
      ? 'on' + (LAYLINE.trim ? ` · ${LAYLINE.trim > 0 ? '+' : ''}${LAYLINE.trim}°` : '')
      : 'off',
    controls: [
    { kind: 'toggle', label: 'LAYLINES',
      get: () => LAYLINE.on, set: v => LAYLINE.on = v,
      hint: 'back from the top and bottom gates at target angle. Starboard '
          + 'green, port red.' },
    { kind: 'select', label: 'WIND FROM',
      options: [['boat', 'the boat I am tracking'], ['mark', 'the course marks'],
                ['selected', 'selected sources']],
      get: () => LAYLINE.source, set: v => LAYLINE.source = v,
      dep: () => LAYLINE.on,
      hint: () => WIND_SRC_HINT[LAYLINE.source] },
    { kind: 'select', label: 'LAY TO',
      options: [['marks', 'each gate mark'], ['gate', 'the middle of the gate']],
      get: () => LAYLINE.target, set: v => LAYLINE.target = v,
      dep: () => LAYLINE.on,
      hint: () => LAYLINE.target === 'gate'
        ? 'one pair of laylines per gate, back from its middle — the picture '
          + 'you want while the choice of end is still open. Half the lines, at '
          + 'the cost of being up to a gate-width out once you have committed.'
        : 'a layline back from EACH mark of the gate, which is the layline you '
          + 'actually have to make. Four lines per gate.' },
    { kind: 'num', label: 'DAMPING', min: 1, max: 60, step: 1,
      get: () => LAYLINE.dampSec, set: v => LAYLINE.dampSec = Math.round(v),
      dep: () => LAYLINE.on,
      hint: () => `TWD and TWS over the last ${Math.round(LAYLINE.dampSec)} s.` },
    { kind: 'num', label: 'WIDEN', min: -20, max: 20, step: 1,
      get: () => LAYLINE.trim, set: v => LAYLINE.trim = Math.round(v),
      dep: () => LAYLINE.on,
      hint: () => LAYLINE.trim
        ? `${LAYLINE.trim > 0 ? '+' : ''}${LAYLINE.trim}° — the laylines are `
          + `${LAYLINE.trim > 0 ? 'wider' : 'tighter'} than the targets say. `
          + 'The route moves with them, and the map shows the trimmed angle.'
        : 'degrees to open the laylines out (+) or pull them in (−), for when '
          + 'a low TWS reading hands back the wrong target angle. The route '
          + 'moves with them.' },
  ]},

  { title: 'GATE BIAS', group: 'route', sum: () => GATE_BIAS.on ? 'on' : 'off', controls: [
    { kind: 'toggle', label: 'GATE BIAS',
      get: () => GATE_BIAS.on, set: v => GATE_BIAS.on = v,
      hint: 'metres the favoured mark of each live gate gives you, written '
          + 'outside the gate: <b>L31m</b> means the left-hand mark by 31 m.' },
    { kind: 'select', label: 'WIND FROM',
      options: [['mark', 'the course marks'], ['boat', 'the boat I am tracking'],
                ['both', 'the boat + the marks'], ['all', 'all sources'],
                ['selected', 'selected sources']],
      get: () => GATE_BIAS.source, set: v => GATE_BIAS.source = v,
      dep: () => GATE_BIAS.on,
      hint: () => GATE_BIAS.source === 'mark'
        ? 'the marks sitting on the gate — the best witnesses to its own air, '
          + 'but thin in this archive.'
        : GATE_BIAS.source === 'boat' ? WIND_SRC_HINT.boat
        : GATE_BIAS.source === 'both'
        ? 'both sets together, which is usually the steadiest answer.'
        : 'every masthead in the fleet and every mark — the whole racecourse.' },
    { kind: 'num', label: 'DAMPING', min: 1, max: 120, step: 5,
      get: () => GATE_BIAS.dampSec, set: v => GATE_BIAS.dampSec = Math.round(v),
      dep: () => GATE_BIAS.on,
      hint: () => `TWD over the last ${Math.round(GATE_BIAS.dampSec)} s. A gate `
                + 'bias is a few metres either way; an undamped TWD moves it '
                + 'faster than you can read it.' },
  ]},

  /* ── gas ──────────────────────────────────────────────────────────────────
     The magnitudes here are the ones to argue with. The SHAPE of the model —
     shed it, drift it, spread it, fade it — is not in doubt; how big and how
     long an F50's dirty air actually is, is, and no table will settle it. So
     every number is a control and the defaults are a starting point to tune
     against the water, not an answer. */
  { title: 'GAS', group: 'wind',
    sum: () => GAS.on ? `${Math.round(GAS.lifeSec)}s` : 'off',
    controls: [
    { kind: 'toggle', label: 'GAS',
      get: () => GAS.on, set: v => GAS.on = v,
      hint: 'dirty air, shed by every boat and left where it was made. Each '
          + 'parcel then drifts downwind on its own, spreading and fading — so '
          + 'this shows the mess a boat left behind after it has tacked away '
          + 'from it, which is the mess you sail into without knowing why.' },
    { kind: 'num', label: 'LENGTH', min: 10, max: 240, step: 10,
      get: () => GAS.lifeSec, set: v => GAS.lifeSec = Math.round(v),
      dep: () => GAS.on,
      hint: () => `seconds a parcel stays worth drawing. At the wind speeds `
          + `these boats race in, ${Math.round(GAS.lifeSec)} s is very roughly `
          + `${Math.round(GAS.lifeSec * 8)} m of trail — this is the control `
          + 'that sets how far back the dirt reaches.' },
    { kind: 'num', label: 'START WIDTH', min: 5, max: 120, step: 5,
      get: () => GAS.r0, set: v => GAS.r0 = Math.round(v),
      dep: () => GAS.on,
      hint: () => `metres across as it leaves the boat. About one rig height is `
          + 'the usual starting point.' },
    { kind: 'num', label: 'SPREAD', min: 0, max: 4, step: 0.05,
      get: () => GAS.grow, set: v => GAS.grow = +(+v).toFixed(2),
      dep: () => GAS.on,
      hint: () => `metres per second of widening as it travels. `
          + `${GAS.grow.toFixed(2)} m/s puts a parcel `
          + `${Math.round(GAS.r0 + GAS.grow * GAS.lifeSec)} m across by the end `
          + 'of its life.' },
    { kind: 'num', label: 'DRIFT', min: 0.3, max: 1.3, step: 0.05,
      get: () => GAS.drift, set: v => GAS.drift = +(+v).toFixed(2),
      dep: () => GAS.on,
      hint: () => `the fraction of the true wind speed a parcel travels at. 1.0 `
          + 'says the dirty air goes exactly as fast as the breeze carrying it; '
          + 'below that it lags, which is the honest way to fudge a wake that '
          + 'is still moving with the boat that made it.' },
    { kind: 'num', label: 'OPACITY', min: 0.05, max: 1, step: 0.05,
      get: () => GAS.alpha, set: v => GAS.alpha = +(+v).toFixed(2),
      dep: () => GAS.on,
      hint: () => `how heavily the whole layer is laid on — `
          + `${Math.round(GAS.alpha * 100)}%. It is a cloud you are meant to see `
          + 'the course through, so the useful range is lower than it looks.' },
    { kind: 'select', label: 'SHADE',
      options: GAS_SHADES,
      get: () => GAS.ink, set: v => GAS.ink = v,
      dep: () => GAS.on,
      hint: 'the tone of the haze. Which one works is decided by what is under '
          + 'it: over near-black water only a light smoke shows at all, over '
          + 'satellite imagery or a paper theme only a dark one does.' },
    { kind: 'num', label: 'EMIT', min: 0.5, max: 5, step: 0.5,
      get: () => GAS.emitSec, set: v => GAS.emitSec = +(+v).toFixed(1),
      dep: () => GAS.on,
      hint: () => `a parcel per boat every ${GAS.emitSec.toFixed(1)} s. Finer is `
          + 'a smoother trail and more work per frame; coarser reads as beads.' },
    { kind: 'select', label: 'WIND FROM',
      options: [['race', 'the race TWD'], ['boat', 'the boat I am tracking'],
                ['mark', 'the course marks'], ['selected', 'selected sources']],
      get: () => GAS.source, set: v => GAS.source = v,
      dep: () => GAS.on,
      hint: () => GAS.source === 'race'
        ? 'one number for the race — the steadiest drift, and the one that will '
          + 'not swing the whole cloud when an instrument twitches.'
        : WIND_SRC_HINT[GAS.source] },
  ]},

  { title: 'CROSSWIND', group: 'wind', sum: () => CROSS.on ? (CROSS.auto ? 'auto' : 'on') : 'off',
    controls: [
    { kind: 'toggle', label: 'CROSSWIND',
      get: () => CROSS.on, set: v => CROSS.on = v,
      hint: 'the ladder rung through MY BOAT — the line square to the wind.' },
    { kind: 'toggle', label: 'AUTO CROSS',
      get: () => CROSS.auto, set: v => CROSS.auto = v, dep: () => CROSS.on,
      hint: 'the nearest boat to your rung on your leg: the gap in metres, '
          + 'green ahead, red behind, plus seconds to a crossing.' },
    { kind: 'num', label: 'CROSS RANGE', min: 0, max: 600, step: 10,
      get: () => CROSS.rangeM, set: v => CROSS.rangeM = Math.round(v),
      dep: () => CROSS.on && CROSS.auto,
      hint: () => CROSS.rangeM
        ? `straight-line metres. The rung runs along the wind only, so without `
          + `this a boat on the far side of the course reads as exactly level `
          + `with you and gets picked as the one that matters. Beyond `
          + `${Math.round(CROSS.rangeM)} m, no comparison rather than a wrong one.`
        : 'no limit — the nearest boat to your rung on your leg is picked '
          + 'however far away it is.' },
    { kind: 'select', label: 'WIND FROM',
      options: [['race', 'the race TWD'], ['boat', 'the boat I am tracking'],
                ['mark', 'the course marks'], ['selected', 'selected sources']],
      get: () => CROSS.source, set: v => CROSS.source = v, dep: () => CROSS.on,
      hint: () => CROSS.source === 'race'
        ? 'one number for the race — what holds the rung still.'
        : WIND_SRC_HINT[CROSS.source] },
    { kind: 'num', label: 'DAMPING', min: 1, max: 120, step: 5,
      get: () => CROSS.dampSec, set: v => CROSS.dampSec = Math.round(v),
      dep: () => CROSS.on && CROSS.source !== 'race',
      hint: () => `TWD over the last ${Math.round(CROSS.dampSec)} s.` },
  ]},

  /* The instruments themselves. A list, not a setting: it is as long as the
   * fleet plus the marks and it changes with the race, so it owns its own area
   * rather than pretending to be a label and a widget. */
  { title: 'WIND SOURCES', group: 'wind',
    sum: () => {
      const c = windPickCount(APP.rd);
      const n = c.marks + c.boats, N = c.nMarks + c.nBoats;
      return !N ? '—' : n === N ? `all ${N}` : `${n}/${N}`;
    },
    controls: [
    { kind: 'custom', build: function wsrcBuild(box) {
      const rd = APP.rd;
      const { marks, boats } = windRoster(rd);
      box.className = 'wsrc';
      box.innerHTML = '';
      WSRC_BOX = box;
      WSRC_SIG = windRosterSig(rd);
      WSRC_REBUILD = () => wsrcBuild(box);
      if (!marks.length && !boats.length) {
        box.innerHTML = '<p class="chint">no wind instruments in this race yet.</p>';
        return;
      }

      const bar = document.createElement('div');
      bar.className = 'wsrcbar';
      const btn = (txt, fn) => {
        const b = document.createElement('button');
        b.className = 'mini'; b.textContent = txt;
        b.onclick = () => { fn(); syncPanels(); rebuild(true); };
        bar.appendChild(b);
      };
      btn('ALL', () => WIND_PICK.off.clear());
      btn('NONE', () => {
        for (const n of marks) WIND_PICK.off.add(windId('mark', n));
        for (const n of boats) WIND_PICK.off.add(windId('boat', n));
      });
      btn('MARKS ONLY', () => {
        WIND_PICK.off.clear();
        for (const n of boats) WIND_PICK.off.add(windId('boat', n));
      });
      btn('BOATS ONLY', () => {
        WIND_PICK.off.clear();
        for (const n of marks) WIND_PICK.off.add(windId('mark', n));
      });
      box.appendChild(bar);

      /* One row per instrument. The tick is the whole control; the name is the
       * label; and where a reading exists at the frame clock its own TWD and
       * TWS sit on the right, because the reason you are in this list is
       * usually that one of them looks wrong and you want to see which. */
      const group = (title, kind, names) => {
        if (!names.length) return;
        const h = document.createElement('div');
        h.className = 'wsrch';
        h.textContent = title;
        box.appendChild(h);
        for (const name of names) {
          const row = document.createElement('button');
          row.className = 'wsrcrow';
          row.dataset.k = kind; row.dataset.n = name;
          const on = windPicked(kind, name);
          // 'pick', not 'on' — button.on is the rail's own solid-accent state
          // and would paint every row a filled slab.
          row.classList.toggle('pick', on);
          row.innerHTML = `<i class="tick">${on ? '✓' : ''}</i>`
                        + `<span class="nm">${name}</span>`
                        + `<span class="rd">${windReadout(rd, kind, name, WSRC_T)}</span>`;
          row.onclick = () => {
            const id = windId(kind, name);
            WIND_PICK.off.has(id) ? WIND_PICK.off.delete(id) : WIND_PICK.off.add(id);
            syncPanels(); rebuild(true);
          };
          box.appendChild(row);
        }
      };
      group('MARKS', 'mark', marks);
      group('BOATS', 'boat', boats);
      paintWindSources(rd, WSRC_T);
    } },
    /* Not drawn, but read and written like any other control, so the tick list
     * travels inside a preset with everything else. A preset that restored the
     * laylines' source as SELECTED SOURCES without restoring which sources
     * those were would be a preset that does something different every time. */
    { kind: 'ghost', label: 'DESELECTED',
      get: () => [...WIND_PICK.off].join(','),
      set: v => { WIND_PICK.off.clear();
                  for (const k of String(v || '').split(',')) if (k) WIND_PICK.off.add(k); } },
  ]},

  { title: 'WIND', group: 'wind', sum: () => [WIND_VIEW.live !== 'off' ? 'live' : null,
                               WIND_VIEW.field !== 'off' ? 'field' : null]
                              .filter(Boolean).join(' · ') || 'off',
    controls: [
    /* Marks only, so the choice is which marks. The F50s' own mastheads are
     * never drawn as arrows — see drawWindLive — and offering "boats" here
     * would be offering a setting that draws nothing. */
    { kind: 'select', label: 'LIVE WIND',
      options: [['off', 'off'], ['marks', 'every mark'],
                ['selected', 'selected marks']],
      get: () => WIND_LIVE_OPT(),
      set: v => WIND_VIEW.live = v,
      hint: () => WIND_VIEW.live === 'off'
        ? 'no arrows on the marks.'
        : `raw readings from ${WIND_VIEW.live === 'selected'
            ? 'the marks ticked in WIND SOURCES' : 'the course marks'}, arrows `
          + 'coloured red for a left shift, green for a right one. The boats\u2019 '
          + 'own mastheads still feed every average, they are just not drawn.' },
    { kind: 'select', label: 'WIND FIELD',
      options: [['off', 'off'], ['marks', 'marks'], ['boats', 'boats'],
                ['all', 'all sources'], ['selected', 'selected sources']],
      get: () => WIND_VIEW.field,
      set: v => { WIND_VIEW.field = v; if (v !== 'off') WIND_FIELD_LAST = v; },
      hint: 'those readings interpolated across the course, fading where '
          + 'nothing is near enough to say.' },
    { kind: 'num', label: 'DRIFT', min: 0, max: 120, step: 5,
      get: () => WIND_VIEW.trailSec, set: v => WIND_VIEW.trailSec = Math.round(v),
      dep: () => WIND_VIEW.field !== 'off',
      hint: () => WIND_VIEW.trailSec
        ? `the last ${Math.round(WIND_VIEW.trailSec)} s carried downwind to where `
          + 'that air is now, so a gust travels down the course.'
        : 'off — this instant only, so the pattern moves with the fleet.' },
    { kind: 'select', label: 'COURSE TWD FROM',
      options: [['all', 'all sources'], ['marks', 'the marks'],
                ['boat', 'your boat'], ['both', 'boat + marks'],
                ['selected', 'selected sources'], ['race', 'race TWD']],
      get: () => COURSE_WIND.source, set: v => COURSE_WIND.source = v,
      hint: 'which readings the COURSE box averages for its AVG TWD.' },
    { kind: 'num', label: 'COURSE TWD DAMPING', min: 0, max: 180, step: 10,
      get: () => COURSE_WIND.dampSec, set: v => COURSE_WIND.dampSec = Math.max(0, Math.round(v)),
      hint: () => COURSE_WIND.dampSec
        ? `averaged over ${Math.round(COURSE_WIND.dampSec)} s — long, because it is `
          + 'the course average, not a boat reading.'
        : 'raw — every gust moves it.' },
  ]},

];

const VIEWPORT_NAME = { fleet: 'fleet', course: 'course', boat: 'boat',
                        boatOffset: 'boat · offset' };
const WIND_SRC_HINT = { boat: 'the masthead of MY BOAT.',
                        mark: 'the course marks’ own readings (start window only).',
                        selected: 'the instruments ticked in WIND SOURCES.',
                        race: 'the race average — one number, so it never moves.' };

/* A stored preset — or an older build — can hold 'boats' or 'all' here. Both
 * now draw exactly what 'marks' draws, so the widget says so rather than
 * showing a blank select. */
const WIND_LIVE_OPT = () =>
  (WIND_VIEW.live === 'boats' || WIND_VIEW.live === 'all') ? 'marks' : WIND_VIEW.live;

const WHICH = { marks: 'the course-mark boats', boats: 'the F50s’ own mastheads',
                all: 'both the mark boats and the F50s',
                selected: 'the instruments ticked in WIND SOURCES', off: 'nothing' };

const SYNC = [];   // one entry per built control: () => refresh its widget
const HEAVY = [];  // custom sections that rebuild their own DOM — skipped on a
                   // light sync, because a wheel tick must not destroy the
                   // preset name you are halfway through typing.

/* Which sections are open. Remembered per browser, because the set you keep
 * open is a working preference, not a per-race one. Everything shut but VIEW by
 * default: every header carries its own state, so a shut rail still reads. */
const OPEN = (() => {
  try {
    const raw = load('panels');
    if (raw) {
      const a = JSON.parse(raw);
      if (Array.isArray(a)) return new Set(a.filter(x => typeof x === 'string'));
    }
  } catch {}
  return new Set(['VIEW']);
})();
const saveOpen = () => save('panels', JSON.stringify([...OPEN]));

/* Long-form help, off by default. The rail's job is to be scanned; the prose
 * is still here for the first time you meet a control, one switch away, and on
 * hover as a tooltip whether or not the switch is on. */
let HELP = false;      // read from storage in boot(), once `load` exists


/* ── presets ────────────────────────────────────────────────────────────────
 *
 * The rail is up to forty settings and still growing, and a race is only four
 * or five moments: the start, the beat, the run, the look at the whole course.
 * A preset is one of those moments — every setting at once, one click.
 *
 * A preset IS the PANELS array. There is no second list of what a preset
 * contains, because a second list is a list that goes stale the first time a
 * control is added and nobody remembers to update it. Every control that can
 * be read and written is in, keyed by `PANEL/LABEL` — which is why CROSSWIND
 * and LAYLINES can both own a control called WIND FROM without colliding.
 * ZOOM opts out: it is transient, and it pairs with a pan the presets do not
 * carry, so restoring one without the other would land you somewhere you never
 * were.
 */

const presetKeys = () => {
  const out = [];
  for (const p of PANELS)
    for (const c of p.controls)
      if (c.get && c.set && c.kind !== 'custom' && c.kind !== 'button' && !c.noPreset)
        out.push([`${p.title}/${c.label}`, c]);
  return out;
};

const snapshot = () => {
  const o = {};
  for (const [k, c] of presetKeys()) o[k] = c.get();
  return o;
};

/* Compared as strings, because a select hands back '1.25' where the default was
 * the number 1.25 and the two mean the same setting.
 *
 * A key the stored preset has never heard of is skipped rather than counted as
 * a mismatch, to match what applyPreset does with it. Otherwise adding one
 * control to this file would darken every chip a user had ever saved, with no
 * way back: applied correctly, reported as not applied. */
function sameSettings(a, b) {
  if (!a || !b) return false;
  for (const [k] of presetKeys()) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
    if (String(a[k]) !== String(b[k])) return false;
  }
  return true;
}

function applyPreset(o) {
  if (!o) return;
  for (const [k, c] of presetKeys()) {
    if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
    // The widget refuses a value that is not one of its options; a preset has
    // to refuse it too, or a stored preset written by an older build could set
    // a select to something the code no longer understands.
    if (c.options && !c.options.some(op => String(op[0]) === String(o[k]))) continue;
    try { c.set(o[k]); } catch {}
  }
  syncPanels();
  paintBar();
  rebuild(true);
}

/* The presets that ship. Written as small overrides rather than as full
 * snapshots, and materialised against the app's own defaults the first time it
 * runs, so a seed never has to be rewritten when a control is added — it simply
 * inherits whatever the default for that control is. */
/* The three sets, as they ship.
 *
 * These ARE the modes — the chips across the top of the map and the settings
 * the tool carries between them are one thing, not a list of presets that
 * happens to include something called PRE-START. A race is a countdown, then an
 * alternation of beats and runs, and each of the three wants a different map.
 *
 * Written as small overrides rather than full snapshots, and materialised
 * against the app's own defaults the first time it runs, so a seed never has to
 * be rewritten when a control is added: it inherits whatever that control's
 * default is.
 *
 * The wind sources are the point of splitting UPWIND from DOWNWIND. They are
 * seeded the same — every source on — because which mark is worth believing
 * depends on the venue and the day, and a shipped guess would be a guess the
 * user then has to undo. What the modes give you is somewhere to PUT that
 * decision once you have made it, per leg type, and have it come back.
 */
const MODE_SEEDS = {
  pre: {
    'VIEW/VIEWPORT': 'fleet',
    'START/FAST POINT + ADVANTAGE': true,
    // On by default in the countdown: the starboard layline off each end is
    // part of the picture you set up before the boat leaves the dock, not
    // something you should have to remember to switch on at T-2:00.
    'START/START LAYLINES': true,
    'CONE/CONE': true,
    /* The WAVE retires as a default when the cone arrives. They are the same
     * physics from opposite ends — the wave sweeps back from the line to find
     * where you could still make it, the cone sweeps forward from the boat to
     * find where you would end up — and on the water they are two red regions
     * overlapping on the same piece of it, which reads as neither. The cone is
     * the one that answers the question out loud, so it keeps the water. WAVE
     * is one switch away in START and everything it did still works. */
    'START/WAVE': false,
    'START/WAVE @ RATIO': false,
    'BOATS/TARGET COLOURS': true,
    'BOATS/PROJECTION': true,
    'CROSSWIND/CROSSWIND': false,
    'LAYLINES/LAYLINES': false,
    'WIND/WIND FIELD': 'off',
    'BOATS/TRAILS': 30,
  },
  up: {
    'CONE/CONE': false,
    /* Dead centre, not offset. The offset view aims a third of a screen along
     * the bearing to the next mark, which means the boat MOVES across the
     * screen every time that bearing changes — a third of a screen, instantly,
     * at every rounding. Following a boat means the boat stays put. */
    'VIEW/VIEWPORT': 'boat',
    'START/WAVE': false,
    'START/WAVE @ RATIO': false,
    'START/START LAYLINES': false,
    'BOATS/PROJECTION': false,
    'CROSSWIND/CROSSWIND': true,
    'CROSSWIND/AUTO CROSS': true,
    'LAYLINES/LAYLINES': true,
    'LAYLINES/LAY TO': 'gate',
    'ROUTE/ROUTE': true,
    'ROUTE/NEXT LEG': true,
    'GATE BIAS/GATE BIAS': true,
    'WIND/WIND FIELD': 'off',
    'BOATS/TRAILS': 30,
  },
  down: {
    'CONE/CONE': false,
    'VIEW/VIEWPORT': 'boat',
    'START/WAVE': false,
    'START/WAVE @ RATIO': false,
    'START/START LAYLINES': false,
    'BOATS/PROJECTION': false,
    'CROSSWIND/CROSSWIND': true,
    'CROSSWIND/AUTO CROSS': true,
    'LAYLINES/LAYLINES': true,
    // Running down, the choice of gate mark stays open much longer, so one
    // pair of laylines off the middle is the honest picture and half the ink.
    'LAYLINES/LAY TO': 'gate',
    'ROUTE/ROUTE': true,
    'ROUTE/NEXT LEG': true,
    'GATE BIAS/GATE BIAS': true,
    'WIND/WIND FIELD': 'off',
    'BOATS/TRAILS': 30,
  },
};


/* ── modes ──────────────────────────────────────────────────────────────────
 *
 * Three of them: PRE-START, UPWIND, DOWNWIND. They are the chips across the top
 * of the map AND the settings behind them — one idea, where there used to be a
 * mode pair and a separate list of presets saying the same thing twice.
 *
 * The gun is not a moment on a clock, it is a change of subject. Before it the
 * whole tool is about one line four hundred metres long and one instant in the
 * future: where should I be at T+0, at what speed, on what tack. After it that
 * line has stopped existing and the question is the fleet — who is on my rung,
 * what does the next mark want, where is the pressure.
 *
 * Those are different tools that happen to share a map, and until now they
 * shared a menu as well: every switch you set for the start was still set on
 * the first reach, and every switch you wanted racing was wrong in the
 * countdown. A preset chip papered over it, at the cost of remembering to
 * click one at the exact moment you are busiest.
 *
 * And a beat is not a run. Which instruments you believe, whether the laylines
 * want the gate or its marks, how far ahead the route is worth drawing — all of
 * it changes at the mark, not at the gun.
 *
 * So there are three modes and they own the menu between them. Each holds its
 * own settings; the tool crosses between them on its own, at the gun and at
 * every rounding that changes the leg's type. Change a switch and you are
 * changing it for the mode you are in; the other two keep what you left them
 * with.
 *
 * The hold is for review, where the boat is not where your attention is:
 * scrubbing back through a start with the feed past T+0 is a real thing to do,
 * and it is the reason the old START OVERLAYS control existed. It is the same
 * control, promoted.
 */
const MODES = ['pre', 'up', 'down'];
const MODE_NAME = { pre: 'PRE-START', up: 'UPWIND', down: 'DOWNWIND' };

const MODE = {
  hold: 'auto',            // 'auto' | one of MODES
  now: 'pre',              // which mode is actually in force, this frame
  sets: { pre: null, up: null, down: null },
  busy: false,             // re-entrancy guard for the switch
};

/* Which mode the racing wants, this instant.
 *
 * Before the gun there is one answer. After it the answer is the LEG: a beat
 * and a run are as different from each other as either is from a countdown —
 * different wind sources are trustworthy, different geometry is worth drawing —
 * and the boat tells you which one it is on by which way the next mark lies
 * relative to the wind. crossSign already answers exactly that question for the
 * crosswind overlay, off the leg number rather than off the boat's heading, so
 * it does not flip every time you luff.
 */
function legModeFor(rd, t, focus) {
  if (!rd || !rd.frame) return null;
  const tr = focus && rd.tracks[focus];
  const boat = tr ? sampleAt(tr, t) : null;
  if (!boat) return null;
  const twd = (rd.wind && rd.wind.twd != null) ? rd.wind.twd : null;
  if (twd == null) return null;
  /* No leg number, no answer. At the gun itself, and again once the boat has
   * finished, the leg channel is empty — and a default of "upwind" there is not
   * a neutral choice, it is a wrong one that flips the whole menu for a frame
   * at the two moments you are most likely to be watching. crossSign has its
   * own fallback for a missing mark, so the emptiness has to be caught here. */
  if (boat.leg == null) return null;
  return crossSign(rd, boat, twd) > 0 ? 'up' : 'down';
}

function modeFor(t, rd, focus) {
  if (MODE.hold !== 'auto') return MODE.hold;
  if (t < 0) return 'pre';
  // "Don't know" means "don't move". Staying put is always right: whatever the
  // last leg was, it is a better description of the water than a coin toss.
  return legModeFor(rd, t, focus) || (MODE.now === 'pre' ? 'down' : MODE.now);
}

/* The mode owns a control unless the control is about the LOOK of the map
 * rather than the question being asked of it. A theme that flipped at the gun
 * would be a fault, not a feature; so would the basemap going out. Marked on
 * the panel or the control as `noMode`, the same shape as `noPreset`. */
const modeKeys = () => {
  const out = [];
  for (const p of PANELS)
    for (const c of p.controls)
      if (c.get && c.set && c.kind !== 'custom' && c.kind !== 'button'
          && !c.noPreset && !c.noMode && !p.noMode)
        out.push([`${p.title}/${c.label}`, c]);
  return out;
};

/* WIND SOURCES is a custom widget — a set of ticks, not a control with a get
 * and a set — so presetKeys() has never seen it and it would have been the one
 * thing a mode could not carry. It is also the thing the modes exist FOR: which
 * instruments you believe on a beat is not which instruments you believe on a
 * run, and the marks that are upwind of you for one leg are downwind of you for
 * the next. So the deselect-set rides along under a key of its own.
 *
 * Stored as a sorted array so two identical selections compare equal as JSON. */
const MODE_PICK_KEY = '_windPick';
const pickSnapshot = () => [...WIND_PICK.off].sort();
function pickApply(a) {
  if (!Array.isArray(a)) return;
  WIND_PICK.off = new Set(a.filter(x => typeof x === 'string'));
}

const modeSnapshot = () => {
  const o = {};
  for (const [k, c] of modeKeys()) o[k] = c.get();
  o[MODE_PICK_KEY] = pickSnapshot();
  return o;
};

/* Deliberately not applyPreset: this runs inside a frame, and applyPreset ends
 * in rebuild() and paintBar(). The values go in here; the repaint is the
 * caller's, once. */
function modeApplySet(o) {
  if (!o) return;
  for (const [k, c] of modeKeys()) {
    if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
    if (c.options && !c.options.some(op => String(op[0]) === String(o[k]))) continue;
    try { c.set(o[k]); } catch {}
  }
  if (Object.prototype.hasOwnProperty.call(o, MODE_PICK_KEY)) pickApply(o[MODE_PICK_KEY]);
}

/* ── shipping a new default into a store that already exists ────────────────
 *
 * A mode's stored settings are a FULL snapshot, which means a default added to
 * MODE_SEEDS after somebody has used the tool once never reaches them: their
 * store already has a value for that key, so there is no gap for the new
 * default to fall into. Start laylines went in as a pre-start default and every
 * existing user carried on without them, which looks exactly like the feature
 * not working.
 *
 * So the store is versioned, and each version names the keys IT introduced,
 * PER MODE. On load, a store older than the current version has those keys —
 * and only those, and only in the modes named — taken from the seed. Everything
 * else the user has tuned is left alone, which is the difference between
 * shipping a default and overwriting somebody's setup. Per-mode matters: the
 * wind field is turned off downwind because it is noise on a run, which is no
 * reason to reach into the beat and switch off a field somebody wants there.
 */
const MODE_STORE_V = 10;
const MODE_SEED_SINCE = {
  3: { pre:  ['START/START LAYLINES'] },
  4: { down: ['WIND/WIND FIELD'] },
  // The racing list stopped capping straight-line range: crosswind distance
  // alone decides it now, in every mode, and the cap is there to be set rather
  // than to be shipped.
  5: { pre: ['THREATS/RACE RANGE'], up: ['THREATS/RACE RANGE'],
       down: ['THREATS/RACE RANGE'] },
  // Laylines to the middle of the gate, on every leg — the choice of end stays
  // open longer than the choice of gate, and it is half the lines.
  6: { pre: ['LAYLINES/LAY TO'], up: ['LAYLINES/LAY TO'], down: ['LAYLINES/LAY TO'] },
  // The gas model, tuned against the water. Every one of its numbers moved, so
  // the whole panel comes forward rather than a key at a time.
  7: (() => {
    const k = ['GAS/GAS', 'GAS/LENGTH', 'GAS/START WIDTH', 'GAS/SPREAD',
               'GAS/DRIFT', 'GAS/OPACITY', 'GAS/SHADE', 'GAS/EMIT',
               'GAS/WIND FROM'];
    return { pre: k, up: k, down: k };
  })(),
  // Following a boat now means the boat stays put: the racing modes open on
  // the centred view rather than the offset one, which slid the boat a third
  // of a screen at every rounding.
  8: { up: ['VIEW/VIEWPORT'], down: ['VIEW/VIEWPORT'] },
  // The start cone arrives on in the countdown and off on the legs.
  9: (() => {
    const k = ['CONE/CONE', 'CONE/SPREAD', 'CONE/ARM EVERY', 'CONE/TRIGGER',
               'CONE/ARMS', 'CONE/OPACITY'];
    return { pre: k.concat(['START/WAVE', 'START/WAVE @ RATIO']), up: k, down: k };
  })(),
  // Both tacks, whole: the cone sweeps the full circle and comes out as two
  // lobes, so it opens wider and each one sits lighter than the single one did.
  10: { pre: ['CONE/SPREAD', 'CONE/OPACITY'] },
};

const saveModes = () =>
  save('modes', JSON.stringify({ v: MODE_STORE_V, ...MODE.sets }));

/* Run something as if a different mode were in force — but only as far as the
 * WIND is concerned.
 *
 * The reason this exists is the next-leg route. It is drawn while you are on
 * this leg, and it is a picture of the OTHER kind of leg: the sources you have
 * decided to believe going upwind are not the ones you want for the run you are
 * about to start, and the whole point of keeping wind sources per mode is that
 * the answer differs. So the next leg is worked out under the arriving mode's
 * wind settings and drawn beside a current leg worked out under this one's.
 *
 * Only the wind settings are swapped, and they are put back in a finally — this
 * runs inside a frame, and leaving the picker inverted because a router threw
 * would silently change every other overlay on the map.
 */
function withModeWind(modeKey, fn) {
  const set = MODE.sets[modeKey];
  if (!set || modeKey === MODE.now) return fn();
  const keep = { src: ROUTE.source, damp: ROUTE.dampSec, off: WIND_PICK.off };
  try {
    const src = set['ROUTE/WIND FROM'];
    const damp = set['ROUTE/DAMPING'];
    if (src != null) ROUTE.source = src;
    if (damp != null) ROUTE.dampSec = damp;
    if (Array.isArray(set[MODE_PICK_KEY])) WIND_PICK.off = new Set(set[MODE_PICK_KEY]);
    return fn();
  } finally {
    ROUTE.source = keep.src; ROUTE.dampSec = keep.damp; WIND_PICK.off = keep.off;
  }
}

/* The live menu IS the current mode's set, so it is mirrored back on every
 * change rather than only when the gun goes. Without this, settings you made
 * during a countdown and never crossed the gun with would be settings you made
 * and lost — which is most of them, in a session spent reviewing one start.
 *
 * The write to storage is debounced because this runs on every switch flip and
 * every drag of a slider; the in-memory stash is not, because a mode switch can
 * arrive on the very next frame. */
/* ── the settings that are NOT a mode's ──────────────────────────────────────
 *
 * `noMode` controls — the whole LOOK panel, SMOOTHING, and the grid's switch —
 * are deliberately shared by all three modes. Collapsing presets into modes
 * left them with nowhere to live: the mode sets are now the only store, and
 * these are precisely the keys the mode sets exclude, so every one of them was
 * being forgotten on reload. Turn the basemap off, come back tomorrow, it is
 * on again.
 *
 * So they get a store of their own, written and read the same way.
 */
const globalKeys = () => {
  const out = [];
  for (const p of PANELS)
    for (const c of p.controls)
      if (c.get && c.set && c.kind !== 'custom' && c.kind !== 'button'
          && !c.noPreset && (c.noMode || p.noMode))
        out.push([`${p.title}/${c.label}`, c]);
  return out;
};

/* What the tool OPENS on, for the settings no mode owns.
 *
 * These two cannot simply be the code's own defaults. WATER is written by the
 * theme, so its "default" is whatever setTheme last set; BASEMAP STYLE has a
 * default in its table but the table is a list of sources, not a statement of
 * which one to open on. Both are stated here instead, applied at boot before
 * anything stored is read, and used as the value a version bump restores.
 */
const LOOK_DEFAULTS = {
  'LOOK/BASEMAP': true,               // on, or the style below shows nothing
  'LOOK/BASEMAP STYLE': 'sat',        // satellite: imagery, and no lines on it
  'LOOK/WATER': '#16202a',            // light slate
};

/* The globals store is versioned for the same reason the modes' is: it holds a
 * full snapshot, so a default changed later has no gap to fall into and never
 * reaches anybody who has used the tool once. Each version names the keys it
 * changed; on load, a store older than the current version has those keys — and
 * only those — put back to what ships. */
const GLOBAL_STORE_V = 2;
const GLOBAL_SINCE = {
  2: ['LOOK/BASEMAP', 'LOOK/BASEMAP STYLE', 'LOOK/WATER'],
};

const saveGlobals = () => {
  const o = { v: GLOBAL_STORE_V };
  for (const [k, c] of globalKeys()) o[k] = c.get();
  save('globals', JSON.stringify(o));
};

/* The shipped value of one global: what LOOK_DEFAULTS says, or the control's
 * own current value at boot, which is the code default. */
function applyLookDefaults() {
  const by = new Map(globalKeys());
  for (const [k, v] of Object.entries(LOOK_DEFAULTS)) {
    const c = by.get(k);
    if (!c) continue;
    if (c.options && !c.options.some(op => String(op[0]) === String(v))) continue;
    try { c.set(v); } catch {}
  }
}

function loadGlobals() {
  // The shipped picture first, so anything the store does not carry — or is no
  // longer allowed to carry — is already right.
  applyLookDefaults();
  let was = 0;
  try {
    const raw = load('globals');
    if (raw) {
      const parsed = JSON.parse(raw);
      was = Number(parsed && parsed.v) || 0;
      const o = migrateSettings(parsed);
      if (o) {
        for (const [k, c] of globalKeys()) {
          if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
          if (c.options && !c.options.some(op => String(op[0]) === String(o[k]))) continue;
          try { c.set(o[k]); } catch {}
        }
      }
    }
  } catch {}
  // Defaults introduced since this store was written, put back over it.
  const by = new Map(globalKeys());
  for (const [ver, keys] of Object.entries(GLOBAL_SINCE)) {
    if (Number(ver) <= was) continue;
    for (const k of keys) {
      const c = by.get(k);
      const v = LOOK_DEFAULTS[k];
      if (!c || v === undefined) continue;
      try { c.set(v); } catch {}
    }
  }
  saveGlobals();
}

let MODE_SAVE = 0, GLOBAL_SAVE = 0;
function modeStash() {
  if (MODE.busy || !MODE.sets[MODE.now]) return;
  MODE.sets[MODE.now] = modeSnapshot();
  clearTimeout(MODE_SAVE);
  MODE_SAVE = setTimeout(() => { saveModes(); saveGlobals(); }, 400);
}

/* Called once a frame with the time being DRAWN, not the time on the clock —
 * the map runs a beat behind the feed and the mode has to change when the
 * picture does, not a second before it.
 *
 * The exchange is symmetric and that is the whole trick: whatever the menu
 * holds right now belongs to the mode being left, so it is put away before the
 * arriving mode is unpacked. Nothing is lost by crossing the gun, in either
 * direction, however many times you scrub over it.
 */
function modeTick(tDraw) {
  const want = modeFor(tDraw, APP.rd, APP.focus);
  if (want === MODE.now || MODE.busy) return false;
  MODE.busy = true;
  try {
    MODE.sets[MODE.now] = modeSnapshot();
    MODE.now = want;
    modeApplySet(MODE.sets[want]);
    saveModes();
  } finally {
    MODE.busy = false;
  }
  return true;
}

/* Setting the hold by hand has to take effect on the frame you set it, not the
 * next one — you are usually holding it BECAUSE the clock disagrees with what
 * you want to see. */
function setHold(v) {
  MODE.hold = v;
  const feed = APP.feed, rd = APP.rd;
  const tDraw = feed && rd
    ? Math.max(rd.tMin, Math.min(feed.t - SMOOTH.lag, rd.tMax)) : 0;
  modeTick(tDraw);
  syncPanels();
  paintBar();
  draw();
}

function loadModes() {
  try {
    const raw = load('modes');
    if (raw) {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && MODES.some(m => o[m])) {
        /* An older store held pre + race. RACE became UPWIND and DOWNWIND, so
         * the one set it had seeds both of them rather than being thrown away:
         * whatever was tuned for the race is a better starting point for each
         * leg type than the shipped defaults are. */
        const race = o.race && typeof o.race === 'object' ? migrateSettings(o.race) : null;
        for (const m of MODES) {
          const got = o[m] && typeof o[m] === 'object' ? migrateSettings(o[m]) : null;
          MODE.sets[m] = got || (m === 'pre' ? null : race) || { ...modeSeed(m) };
        }
        if (!MODE.sets.pre) MODE.sets.pre = { ...modeSeed('pre') };

        /* Defaults added since this store was written. Only the keys each
         * version names, only for versions newer than the store. */
        const was = Number(o.v) || 0;
        for (const [ver, byMode] of Object.entries(MODE_SEED_SINCE)) {
          if (Number(ver) <= was) continue;
          for (const [m, keys] of Object.entries(byMode)) {
            if (!MODE.sets[m]) continue;
            const seed = modeSeed(m);
            for (const k of keys)
              if (Object.prototype.hasOwnProperty.call(seed, k)) MODE.sets[m][k] = seed[k];
          }
        }
        saveModes();
        return;
      }
    }
  } catch {}
  for (const m of MODES) MODE.sets[m] = { ...modeSeed(m) };
  saveModes();
}

/* A shipped mode: the app's own defaults with that mode's overrides on top.
 * Read live rather than materialised once, so adding a control never means
 * revisiting three seed lists — the new control's default is simply part of
 * every mode until somebody overrides it. */
function modeSeed(m) {
  return { ...modeSnapshot(), ...(MODE_SEEDS[m] || null) };
}

/* Sections and controls got shorter names when the rail was reorganised, and a
 * preset is keyed by `PANEL/LABEL` — so every key a user had saved would have
 * stopped matching anything. Renaming a control is cheap; silently emptying
 * somebody's presets is not, so the old key is carried to the new one on load
 * and written back under the new name. */
const PRESET_RENAMES = {
  'MAP/VIEWPORT': 'VIEW/VIEWPORT',
  'MAP/SMOOTHING': 'VIEW/SMOOTHING',
  'MAP/THEME': 'LOOK/THEME',
  'MAP/WATER': 'LOOK/WATER',
  'MAP/LABELS': 'LOOK/LABELS',
  'MAP/FLEET BRIGHTNESS': 'LOOK/FLEET BRIGHTNESS',
  'MAP/BASEMAP': 'LOOK/BASEMAP',
  'MAP/BASEMAP FADE': 'LOOK/BASEMAP FADE',
  'MAP/TRAILS': 'BOATS/TRAILS',
  'MAP/SPEED ON EVERY BOAT': 'BOATS/SPEED LABELS',
  'RATIO TARGET/TARGET COLOURS': 'BOATS/TARGET COLOURS',
  'RATIO TARGET/TARGET': 'BOATS/RATIO TARGET',
  'PROJECTED LINE/PROJECTION': 'BOATS/PROJECTION',
  'PROJECTED LINE/LENGTH': 'BOATS/PROJECTION LENGTH',
  'WAVE/WAVE 1.00': 'START/WAVE',
  'WAVE/WAVE @ RATIO': 'START/WAVE @ RATIO',
  'WAVE/WAVE RATIO': 'START/WAVE RATIO',
  'LINES/LAYLINES': 'START/FAST POINT + ADVANTAGE',
  // START LAYLINES was the advantage band and the fast point, never a layline.
  // The name now belongs to the real start laylines, so the old key is carried
  // to the switch that kept its behaviour rather than landing on the new one.
  'START/START LAYLINES': 'START/FAST POINT + ADVANTAGE',
  'LINES/COURSE LIMITS': 'COURSE/COURSE LIMITS',
  'LINES/MARK ZONE': 'COURSE/MARK ZONE',
  'LINES/BOUNDARY BAND': 'COURSE/BOUNDARY BAND',
  'CROSSWIND/CROSSWIND LINE': 'CROSSWIND/CROSSWIND',
  'ROUTE/NEXT LEG ROUTE': 'ROUTE/NEXT LEG',
  'LAYLINES/TO THE MARKS': 'LAYLINES/LAYLINES',
  'GAS/STRENGTH': 'GAS/OPACITY',
  // The threat controls moved out of BOATS into a panel of their own, and the
  // two lists' numbers were given names that say which list they belong to.
  'BOATS/POTENTIAL THREATS': 'THREATS/THREATS',
  'BOATS/THREAT RING': 'THREATS/PRE-START RING',
  'BOATS/THREAT RADIUS': 'THREATS/RACE CROSSWIND',
  'BOATS/THREAT RANGE': 'THREATS/RACE RANGE',
  'BOATS/THREAT FLASH': 'THREATS/FLASH',
  'BOATS/THREAT AVERAGE': 'THREATS/AVERAGE',
};

function migrateSettings(s) {
  if (!s || typeof s !== 'object') return null;
  const out = { ...s };
  /* A rename only applies to a key that no longer names a control.
   *
   * `START/START LAYLINES` is the case that forced this. The old control by
   * that name became FAST POINT + ADVANTAGE, and then a genuinely new control
   * took the vacated name — so the rename was firing on the LIVE key and, since
   * its destination was also present in every snapshot, quietly deleting the
   * start laylines setting out of every preset each time one was loaded. A
   * rename whose source is a live control is not a rename; it is a collision. */
  const live = new Set(presetKeys().map(([k]) => k));
  for (const [from, to] of Object.entries(PRESET_RENAMES))
    if (!live.has(from) && Object.prototype.hasOwnProperty.call(out, from)) {
      if (!Object.prototype.hasOwnProperty.call(out, to)) out[to] = out[from];
      delete out[from];
    }
  return out;
}


/* ── the bar ────────────────────────────────────────────────────────────────
 *
 * Chips light by comparison, not by memory: a preset is lit while the settings
 * match it and goes out the moment you change one. Nothing to keep in sync, and
 * it cannot tell you that you are in PRE-START when you are not.
 */

// Switches worth reaching for mid-race without opening the rail.
/* Which sources the field was last showing, so the bar's switch puts back what
 * you chose rather than jumping to 'all sources' every time it is turned on. */
let WIND_FIELD_LAST = 'all';

/* ── gas: bad air, shed and drifting ─────────────────────────────────────────
 *
 * Not a cone stuck to the boat. A boat does not carry its dirty air around with
 * it — it LEAVES it, and the air then goes where the air goes. So each boat
 * sheds a parcel of disturbed breeze every emitSec, and every parcel from then
 * on is on its own: it drifts downwind at the wind's own speed, spreads as it
 * goes, and fades. What you see is the union of everything still alive.
 *
 * That is what makes it worth drawing. A cone answers "who is gassing me now",
 * which you can usually see out of the boat. A drifting trail answers "where is
 * the dirty water going to BE", including the dirt from a boat that tacked away
 * a minute ago and is no longer anywhere near the mess it made — which is the
 * one you sail into without knowing why.
 *
 * The numbers are the AC75 model's shape rather than the F50's. An F50 is the
 * more efficient boat and disturbs less air, so the honest thing is to ship the
 * shape and make every magnitude a control: LENGTH, SPREAD and STRENGTH are
 * meant to be tuned against what you actually see on the water, which is the
 * only way any of this gets calibrated.
 */
const GAS = {
  /* These are Kyle's numbers, taken off the water rather than out of a table —
   * the shipped model was a starting point and this is where it was tuned to.
   * DRIFT above 1.0 says the dirty air runs slightly faster than the mean
   * breeze, which is what a wake still carrying the momentum of the boat that
   * made it actually does. */
  on: true,
  source: 'race',    // which wind carries the parcels
  dampSec: 30,
  emitSec: 1.0,      // one parcel per boat per second of race
  lifeSec: 60,       // how long a parcel still counts for anything
  r0: 18,            // metres — a parcel starts about this far across
  grow: 1.05,        // metres per second of spreading as it travels
  drift: 1.05,       // fraction of TWS the parcel travels at
  alpha: 0.75,       // how strongly the whole layer is laid on
  ink: '225,228,232',// white smoke — see GAS_SHADES
};
/* Every parcel still alive at time t.
 *
 * Walked backwards from now in emitSec steps: for each step, where each boat
 * WAS then, plus how far the wind has carried that spot since. The wind is
 * taken at the moment of shedding rather than now, so a parcel dropped in an
 * old direction keeps travelling in it — which is the whole point of modelling
 * this as trails rather than as geometry hung off the current breeze.
 */
function gasPuffs(rd, t, focus) {
  if (!rd || !rd.frame) return [];
  const out = [];
  const step = Math.max(0.5, GAS.emitSec);
  for (let age = 0; age <= GAS.lifeSec; age += step) {
    const te = t - age;
    if (te < rd.tMin) break;
    const w = pickWind(rd, te, focus, GAS.source, GAS.dampSec);
    if (!w || w.twd == null) continue;
    // Downwind, in the rotated frame, at the wind's own speed.
    const to = (w.twd + 180) % 360;
    const d = rd.frame.r(Math.sin(to * D2R), Math.cos(to * D2R));
    const tws = w.tws != null ? w.tws : (rd.wind && rd.wind.tws) || 0;
    const run = (tws / 3.6) * age * GAS.drift;        // km/h -> m/s -> metres
    const fade = 1 - age / GAS.lifeSec;
    for (const team of rd.teams) {
      if (rd.excluded.has(team)) continue;
      const b = sampleAt(rd.tracks[team], te);
      if (!b) continue;
      out.push({ team,
                 rx: b.rx + d.rx * run, ry: b.ry + d.ry * run,
                 r: GAS.r0 + GAS.grow * age,
                 a: fade * fade });      // squared: it thins out fast at first
    }
  }
  return out;
}

/* Drawn into an offscreen at half scale and laid on in one go.
 *
 * Each parcel on its own is a faint smudge; two hundred of them composited
 * straight onto the map would each cost a full-size radial gradient and the
 * overlaps would run away to solid. Half resolution is free softness — this is
 * a cloud, not a boundary — and compositing the layer once means GAS STRENGTH
 * is one honest multiplier on the whole picture rather than a per-parcel alpha
 * that stacks.
 */
function drawGas(ctx, rd, t, tX, tY, W, H, opts) {
  if (!GAS.on || !rd || !rd.frame) return;
  const puffs = gasPuffs(rd, t, opts && opts.focus);
  if (!puffs.length) return;

  const sc = 0.5;
  const gw = Math.max(2, Math.round(W * sc)), gh = Math.max(2, Math.round(H * sc));
  const off = drawGas._c || (drawGas._c = document.createElement('canvas'));
  if (off.width !== gw || off.height !== gh) { off.width = gw; off.height = gh; }
  const o = off.getContext('2d');
  o.clearRect(0, 0, gw, gh);

  // one metre, in offscreen pixels
  const p0 = { rx: 0, ry: 0 }, p1 = { rx: 100, ry: 0 };
  const mpx = Math.hypot(tX(p1.rx, p1.ry) - tX(p0.rx, p0.ry),
                         tY(p1.rx, p1.ry) - tY(p0.rx, p0.ry)) / 100 * sc;
  for (const q of puffs) {
    const x = tX(q.rx, q.ry) * sc, y = tY(q.rx, q.ry) * sc;
    const r = q.r * mpx;
    if (r < 0.5 || x < -r || y < -r || x > gw + r || y > gh + r) continue;
    const g = o.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.22 * q.a;
    g.addColorStop(0, `rgba(${GAS.ink},${a.toFixed(3)})`);
    g.addColorStop(1, `rgba(${GAS.ink},0)`);
    o.fillStyle = g;
    o.beginPath(); o.arc(x, y, r, 0, Math.PI * 2); o.fill();
  }

  ctx.save();
  ctx.globalAlpha = GAS.alpha;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, 0, 0, W, H);
  ctx.restore();
}


/* ── the grid ────────────────────────────────────────────────────────────────
 *
 * Squares on the water, turned to something you care about. Square to the
 * COURSE it is a ruler. Square to the WIND it is a ladder: one family of lines
 * is the rung, the other is distance up the course, and a header shows up as
 * the fleet crossing the rungs rather than as a number you have to read. Square
 * to the BOAT it is your own track and everything square to it.
 *
 * Damped like every other wind reading here, because a grid that twitches with
 * each puff is a grid nobody can look at.
 */
const GRID = { on: true, source: 'course', dampSec: 30 };

/* The compass bearing the grid is turned to, or null to leave it square to the
 * frame. One family of lines runs along this bearing, the other across it.
 *
 * Three of the four sources are WIND, and they are the same three every other
 * WIND FROM in this tool offers — the boat's own instrument, the marks, or
 * whichever sources you have ticked. "The boat" means the wind the boat is
 * reading, not the way it happens to be pointing: a grid turned to a heading
 * would swing through ninety degrees at every tack and be useless as a frame of
 * reference. The fourth, the course axis, is the fixed one to measure against.
 */
function gridBearing(rd, t, focus) {
  if (!rd || !rd.frame) return null;
  if (GRID.source === 'course') {
    // Bearing 0 in the rotated frame is, by construction, up the course. Asking
    // the frame rather than re-deriving it from the marks keeps this the same
    // axis everything else on the map is built on.
    return rd.frame.bearingFromRot(0, 1);
  }
  const w = pickWind(rd, t, focus, GRID.source, GRID.dampSec);
  return w && w.twd != null ? w.twd : null;
}

/* ── Z ───────────────────────────────────────────────────────────────────────
 *
 * A spot on the water you have decided you want to be at, dropped by hand.
 *
 * The tool is full of geometry that comes out of the course and the wind — the
 * fast point, the laylines, the wave. Z is the other kind: a place a sailor
 * picked for a reason no model has, and everything about it is then answered
 * with the same machinery as everything else. How long to get there on port at
 * target speed and target angle, at what TWA, by what route round the boundary.
 *
 * Two states, and the second one matters. While it is UNLOCKED the pin is
 * draggable and the readouts move under your hand, which is what you want while
 * you are choosing. CONFIRM locks it: after that the numbers change only
 * because the boat moved or the wind shifted, never because you brushed the
 * canvas. RESET makes it draggable again, in place.
 *
 * `p` is in the rotated frame, not in pixels — so the pin stays on its piece of
 * water through a zoom, a pan and a change of map orientation.
 */
const ZPT = { on: false, p: null, locked: false,
              /* The margin a crew wants in hand for the tack itself when they
               * reach Z — the same idea LAST_TACK.ratio already is for the
               * final board, defaulted to match it, and used two ways: it is
               * the RATIO that TTK TO Z = 0 means (ttkZBoat), and it sizes
               * the OLD fallback for the pink ghost cone's reach on the rare
               * frame where leg 1 has no answer yet (drawStartCone) — day to
               * day the cone is sized by leg 1's own remaining time instead.
               * Once a boat is past Z the question is the ordinary approach,
               * governed by RATIO.target like everywhere else. */
              targetRatio: 1.2,
              lateUnder: 0,       // TTK to Z below this = LATE entry
              earlyOver: 10,      // TTK to Z above this = EARLY entry
              /* TWD/TWS for every leg of the Z system — leg 1 (boat to Z),
               * the boat-end leg, and the ghost cone's own fan — vector-
               * averaged over this many seconds (zWind, below). Raw TWD
               * swings hard for a few seconds coming out of a tack — the
               * wind vane itself is disturbed by the manoeuvre — and every
               * one of those legs used to read it undamped, so the cone's
               * size and TTK TO BOAT END would jump right along with it.
               * Same idea as every other DAMPING control in this file, just
               * on the Z system's own knob so it can be tuned separately. */
              windDampSec: 20 };
const Z_INK = '#ff8ad8';
const Z_HIT_PX = 16;              // how near the pointer has to be to grab it
/* Crosshair labels keep outside this radius of the pin — the grab collar plus
 * a plate's half-height plus a little air, so a number never sits on the thing
 * your finger is on. */
const Z_LAB_CLEAR = Z_HIT_PX + 20;
const Z_LAB_OFF = 15;             // how far a plate rides off its own leg

/* Z is a PORT-tack idea. Sailing in on starboard you are on the other gybe with
 * rights and a different problem, and a route drawn to a spot you are not
 * approaching is a line arguing with the boat. So everything Z retires on
 * starboard and comes back when you tack — the pin stays, faded, because it is
 * still where you decided it was.
 */
const zOnPort = boat => boat && boat.twa != null && boat.twa < 0;

/* The route, the angle and the clock, all off one wind and one set of targets.
 *
 * The route is bounceLeg forced onto port: the same router that draws every leg
 * on the course, so it bounces off the same boundary at the same target angles
 * and cannot disagree with the rest of the map about what is sailable. The
 * clock is its length over the boat's own target speed for the mode — "target
 * speed and target angle", which is the speed you would actually make good if
 * you sailed it properly rather than the speed you happen to be doing.
 */
function zStateAt(rd, t, focus) {
  if (!ZPT.on || !ZPT.p || !rd || !rd.frame) return null;
  const tr = focus && rd.tracks[focus];
  const boat = tr ? sampleAt(tr, t) : null;
  if (!boat) return null;
  const w = settledWind(rd, t, focus, ROUTE.source, ROUTE.dampSec);
  const twd = w && w.twd != null ? w.twd : (rd.wind && rd.wind.twd);
  if (twd == null) return null;

  const dx = ZPT.p.rx - boat.rx, dy = ZPT.p.ry - boat.ry;
  const distM = Math.hypot(dx, dy);
  const brg = rd.frame.bearingFromRot(dx, dy);
  // Signed TWA of the spot, in the boat's own convention: positive starboard.
  const twa = -(((brg - twd) % 360 + 540) % 360 - 180);

  const out = { p: ZPT.p, distM, brg, twa, onPort: zOnPort(boat),
                route: null, secs: null, tws: w && w.tws,
                geom: zGeom(rd, twd) };
  if (!out.onPort) return out;              // everything else retires

  const tws = w && w.tws != null ? w.tws : (rd.wind && rd.wind.tws);
  const ang = nextLegAngles(rd, tws, boat, focus);
  if (!ang) return out;
  const up = Math.abs(twa) < 90;
  const v = up ? ang.upV : ang.dnV;

  const r = bounceLeg(rd, { rx: boat.rx, ry: boat.ry }, ZPT.p, twd, ang, -1,
                      { approach: brg, forceTack: true });
  if (r && r.pts.length) {
    const pts = [{ rx: boat.rx, ry: boat.ry }, ...r.pts];
    let d = 0;
    for (let i = 1; i < pts.length; i++)
      d += Math.hypot(pts[i].rx - pts[i - 1].rx, pts[i].ry - pts[i - 1].ry);
    out.route = pts;
    out.routeM = d;
    out.turns = Math.max(0, pts.length - 2);
    if (v > 0) out.secs = d / (v / 3.6);
  } else if (v > 0) {
    // No route the router will stand behind — still answer the direct question
    // rather than nothing, and say that is what it is.
    out.secs = distM / (v / 3.6);
    out.direct = true;
  }

  /* TTK on port TO Z — the same subtraction as TTK to the line, with Z as the
   * place and the ACCELERATION model as the clock: build speed from the speed
   * you are doing on the measured per-polar table, capped at the polar, over
   * the direct distance. It used to be the route time at target speed; the
   * accel run answers the question the entry actually asks — can THIS boat,
   * from THIS speed, still make that spot — which is the same physics every
   * other TTK in the tool runs on (ttkZBoat below, shared with the fleet).
   * Scaled by Z TARGET RATIO so TTK TO Z = 0 means "arrive with exactly the
   * margin wanted for the tack", not merely "arrive".
   *
   * Positive is slack in hand; negative means you are already late for it.
   * Not to be confused with TTK AT Z below, which is a different question with
   * the same units: that one is what your START is worth once you get there.
   * TO Z is about getting there, AT Z is about the line from there.
   */
  const q = t < 0 ? ttkZBoat(rd, t, focus) : null;
  if (q) out.ttkToZ = q.ttk;                 // null while Z is unreachable
  if (q && q.unreachable) out.zLate = true;

  /* And what the start looks like once you get there.
   *
   * The whole reason to pick a spot is what it does for your start, so the spot
   * has to answer in the start's own currency: seconds to kill and ratio, at Z,
   * at the moment you would arrive — the SAME arrival ttkZBoat already worked
   * out above (the accel run, not the tacking route below), and the SAME
   * timeToLine leg it ran to get there, so this can never disagree with the
   * headline TTK TO Z number about when the boat gets to the spot. Unscaled —
   * ratio 1.00 / ttk 0 is the ordinary line cut here, same as everywhere else
   * that isn't TO Z — which is what makes the identity in Z TARGET RATIO's
   * hint true: TTK TO Z = 0 puts RATIO AT Z at exactly the target.
   */
  if (q && !q.unreachable) {
    out.ttlToZ = q.ttlToZ;                   // accel leg-1 seconds, for zArrival's caption
    if (q.arrival >= 0) out.zWhy = 'the gun goes first';
    else out.atZ = { at: q.arrival, ttl: q.ttlZLine, ttk: q.plainTtk, ratio: q.ratio };
  } else if (q && q.unreachable) {
    out.zWhy = 'no line solution there';
  }

  /* Early or late TO THE BOAT END — a separate question from the block
   * above, on purpose: it needs leg 1 (boat to Z) but NOT leg 2 of TTK TO Z
   * (the generic Z-to-line math), so it is computed independently rather
   * than gated behind whether that unrelated leg happened to resolve. See
   * ttkToBoatEnd's own comment — this is a distance-and-wind answer, not a
   * ratio one, and does not use ZPT.targetRatio. */
  const bq = ttkToBoatEnd(rd, t, focus);
  if (bq) {
    if (bq.unreachable) out.toBoatEndWhy = 'no heading there';
    else if (bq.arrival >= 0) out.toBoatEndWhy = 'the gun goes first';
    else out.toBoatEnd = { ttl: bq.ttlBoat, tts: bq.tts, ratio: bq.ratio, ttk: bq.ttk };
  }
  return out;
}

/* Where Z sits, in the start line's own terms.
 *
 * Three numbers, and between them they place the spot without anyone having to
 * eyeball it against the map:
 *
 *   belowPin  along the LINE, from the pin end to the point on the line square
 *             to Z. Positive past the pin — outside the line — negative up it
 *             towards the boat end. Same sign convention as BELOW PIN in MY
 *             BOAT, so the two can be compared directly.
 *   dtl       square off the line, or off its EXTENSION where Z is past an end,
 *             which is the same infinite line the port-entry rule is measured
 *             against. Positive on the pre-start side.
 *   bnd       from Z to the boundary on a beam reach — 90° TWA — taking the one
 *             of the two that runs AWAY from the course, because that is the
 *             escape, and the escape is what the distance is for.
 *
 * `foot` is the point on the line square to Z: the corner of the crosshair, and
 * where the two line-relative numbers are measured between.
 */
function zGeom(rd, twd) {
  const f = rd && rd.frame;
  if (!f || !ZPT.p || !f.leeR || !f.windR) return null;
  const p = ZPT.p;
  const pct = f.linePct(p);
  const pinPct = rd.pinEnd === 'windward' ? 100 : 0;
  const pinSign = rd.pinEnd === 'windward' ? 1 : -1;
  const belowPin = (pct - pinPct) / 100 * f.lineLen * pinSign;
  const dtl = f.dtl(p);
  const along = pct / 100 * f.lineLen;
  const foot = { rx: f.leeR.rx + f.u.x * along, ry: f.leeR.ry + f.u.y * along };
  const pin = rd.pinEnd === 'windward' ? f.windR : f.leeR;

  let bnd = null, bdir = null;
  if (twd != null) {
    let best = -Infinity;
    for (const tk of [1, -1]) {
      const h = headVec(rd, twd - tk * 90);
      const s = h.rx * f.n.x + h.ry * f.n.y;      // f.n points to the pre-start side
      if (s > best) { best = s; bdir = h; }
    }
    if (bdir) for (const [a, b] of boundarySegs(rd)) {
      const hh = rayHitSeg(p, bdir, a, b);
      if (hh != null && hh > 0 && (bnd == null || hh < bnd)) bnd = hh;
    }
  }
  return { p, foot, pin, belowPin, dtl, bnd, bdir };
}

/* Drop it. Middle of what you are looking at, because that is the piece of
 * water you were looking at when you asked for it — and it lands unlocked, so
 * the next thing you do is drag it somewhere better. Before the first frame is
 * drawn there is no view to take a centre from, so it falls back to the middle
 * of the start line, pushed onto the pre-start side. */
function zDrop() {
  const rd = APP.rd;
  const c = typeof screenToFrame === 'function'
    ? screenToFrame(($('cTrack').clientWidth || 800) / 2,
                    ($('cTrack').clientHeight || 600) / 2) : null;
  if (c) { ZPT.p = c; }
  else if (rd && rd.frame) {
    const f = rd.frame;
    ZPT.p = { rx: (f.windR.rx + f.leeR.rx) / 2 + f.n.x * 200,
              ry: (f.windR.ry + f.leeR.ry) / 2 + f.n.y * 200 };
  } else return;
  ZPT.locked = false;
}

/* The pin, and the route to it. Drawn above the course furniture and below the
 * boats, so it never hides a hull. */
function drawZ(ctx, rd, t, tX, tY, W, H, opts) {
  if (!opts || !opts.zOn || !ZPT.p || !rd || !rd.frame) return;
  const z = zStateAt(rd, t, opts && opts.focus);
  const x = tX(ZPT.p.rx, ZPT.p.ry), y = tY(ZPT.p.rx, ZPT.p.ry);

  /* Off the frame — pinned to the edge, pointing at itself.
   *
   * A spot you placed by hand is a spot you have to be able to find again, and
   * a zoom or a pan can put it behind the bezel with nothing to say it is
   * there. The marker sits on the edge nearest it, aimed at it, with the metres
   * to go, so the pin is never simply lost; clicking near it is still not the
   * pin, so this cannot be dragged by accident from the edge. */
  /* The edge it is pinned to is the edge of the CLEAR water, not of the canvas.
   * The corners of this map are overlays — boat data top right, the course box
   * top left, the menu tabs bottom right — and a marker put on the true edge
   * spent most of its time underneath one of them, which is a marker that does
   * not exist. The inset is measured off those elements rather than guessed, so
   * it follows them if they are resized or switched off. */
  const box = $('cTrack').getBoundingClientRect();
  let iL = 22, iR = W - 22, iT = 22, iB = H - 22;
  for (const id of ['readouts', 'coursebox', 'menutabs', 'menusheet']) {
    const el = $(id);
    if (!el || el.hidden || !el.getBoundingClientRect) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    const l = r.left - box.left, rt = r.right - box.left;
    const tp = r.top - box.top, bt = r.bottom - box.top;
    if (rt > W * 0.55) iR = Math.min(iR, l - 10); else iL = Math.max(iL, rt + 10);
    if (bt > H * 0.6) iB = Math.min(iB, tp - 10);
    if (tp < H * 0.2 && rt <= W * 0.55) iT = Math.max(iT, 22);
  }
  iL = Math.max(22, Math.min(iL, W / 2 - 30));
  iR = Math.min(W - 22, Math.max(iR, W / 2 + 30));
  iT = Math.max(22, Math.min(iT, H / 2 - 30));
  iB = Math.min(H - 22, Math.max(iB, H / 2 + 30));

  if (x < iL || x > iR || y < iT || y > iB) {
    const cx = (iL + iR) / 2, cy = (iT + iB) / 2;
    const dx = x - cx, dy = y - cy, L = Math.hypot(dx, dy) || 1;
    // walk out from the centre until the inset edge is met
    const k = Math.min(dx > 1e-6 ? (iR - cx) / dx : dx < -1e-6 ? (iL - cx) / dx : 1e9,
                       dy > 1e-6 ? (iB - cy) / dy : dy < -1e-6 ? (iT - cy) / dy : 1e9);
    const ex = cx + dx * k, ey = cy + dy * k;
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.fillStyle = Z_INK;
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.moveTo(9, 0); ctx.lineTo(-6, 6); ctx.lineTo(-6, -6);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.font = '700 10px "Share Tech Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = ey < iT + 20 ? 'top' : 'bottom';
    const lx = Math.max(iL + 4, Math.min(iR - 4, ex - dx / L * 30));
    const ly = Math.max(iT + 2, Math.min(iB - 2, ey - dy / L * 30 + (ey < iT + 20 ? 12 : -6)));
    const txt = `Z ${z ? `${z.distM.toFixed(0)} m` : ''}`.trim();
    ctx.lineWidth = 3; ctx.strokeStyle = MAP_INK.halo;
    ctx.strokeText(txt, lx, ly);
    ctx.fillStyle = Z_INK;
    ctx.fillText(txt, lx, ly);
    ctx.restore();
  }

  ctx.save();
  if (z && z.route && z.route.length > 1) {
    ctx.strokeStyle = Z_INK;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    ctx.beginPath();
    z.route.forEach((p, i) => {
      const px = tX(p.rx, p.ry), py = tY(p.rx, p.ry);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.stroke();
    // a dot at each turn, so a two-board route reads as two boards
    ctx.fillStyle = Z_INK;
    for (let i = 1; i < z.route.length - 1; i++) {
      const px = tX(z.route[i].rx, z.route[i].ry), py = tY(z.route[i].rx, z.route[i].ry);
      ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  /* The crosshair, while it is being placed.
   *
   * Three legs, each one BEING the number it is labelled with rather than an
   * arrow near it: Z square onto the line, along the line from the pin to that
   * foot, and the beam reach out to the boundary. Drawn only while unlocked —
   * once confirmed the spot is decided and the working can come off the map.
   */
  const g = !ZPT.locked ? (z && z.geom) || zGeom(rd, rd.wind && rd.wind.twd) : null;
  if (g) {
    /* Where the three numbers go.
     *
     * The midpoint of each leg is the obvious place and the wrong one. Two of
     * the three legs START at the pin, so a short leg — which is exactly the
     * case while you are dropping Z near the line or near the boundary — put
     * its own label on top of the pin, its collar and the Z, and you could not
     * read the number you were placing the pin by.
     *
     * So each plate is pushed along its own leg until it is clear of the pin,
     * ridden beside the leg rather than on it, and then moved off any plate
     * already down. The label still belongs to its leg — it sits on it, and
     * nothing else is on it — it simply never sits on the thing you are
     * dragging. */
    const placed = [];
    const overlap = (a2, b2) =>
      a2.x < b2.x + b2.w && a2.x + a2.w > b2.x &&
      a2.y < b2.y + b2.h && a2.y + a2.h > b2.y;
    /* Distance from a point to a RECTANGLE, not to the rectangle's centre.
     * A plate is ninety pixels wide: its centre can be well clear of the pin
     * while its left-hand end sits straight over it, which is how the first
     * version of this still covered the thing it was written to uncover. */
    const rectGap = (r, px3, py3) => Math.hypot(
      Math.max(r.x, Math.min(px3, r.x + r.w)) - px3,
      Math.max(r.y, Math.min(py3, r.y + r.h)) - py3);

    const lab = (txt, ax, ay, bx2, by2) => {
      ctx.font = '700 10px "Share Tech Mono", monospace';
      const w = ctx.measureText(txt).width + 10, h = 16;
      let ux = bx2 - ax, uy = by2 - ay;
      let len = Math.hypot(ux, uy);
      /* A leg can be exactly zero long — drop Z on the pin and "0 m past pin"
       * is a true statement about a segment with no direction. Left as it was,
       * every candidate position collapsed onto the one point and the plate
       * landed on the pin. So a degenerate leg borrows a direction: away from
       * the pin, or straight up if it is the pin. */
      if (len < 1) {
        ux = ax - x; uy = ay - y;
        len = Math.hypot(ux, uy);
        if (len < 1) { ux = 0; uy = -1; len = 1; }
      }
      ux /= len; uy /= len;
      const nx = -uy, ny = ux;                       // square to the leg

      /* The anchor stays ON the leg — it is where the leader line starts, and
       * it is what keeps the number attached to the thing it measures. The
       * plate itself is then free to move, because the leader says which leg it
       * belongs to however far it has been pushed. */
      const s = Math.min(Math.max(len / 2, Z_LAB_CLEAR), Math.max(len, 1));
      const bx3 = ax + ux * s, by3 = ay + uy * s;

      /* Candidates, nearest first: out to one side of the leg, then the other,
       * at increasing distance; then, when a short leg leaves no room either
       * way, further along the leg's own direction. The first that clears both
       * the pin and every plate already down wins. */
      const away = ((bx3 - x) * nx + (by3 - y) * ny) >= 0 ? 1 : -1;
      let best = null;
      outer:
      for (const along of [0, 26, 52, 78, 112, 152]) {
        for (const k of [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7]) {
          const off = Z_LAB_OFF * k * away;
          const cx2 = bx3 + nx * off + ux * along;
          const cy2 = by3 + ny * off + uy * along;
          const r = { x: cx2 - w / 2, y: cy2 - h / 2, w, h };
          if (rectGap(r, x, y) < Z_LAB_CLEAR) continue;
          if (placed.some(q => overlap(q, r))) continue;
          best = { cx: cx2, cy: cy2, r };
          break outer;
        }
      }
      /* Nowhere clear at all — take the furthest candidate rather than dropping
       * the number. A crowded label is still readable; a missing one is not. */
      if (!best) {
        const off = Z_LAB_OFF * 7 * away;
        const cx2 = bx3 + nx * off + ux * 152, cy2 = by3 + ny * off + uy * 152;
        best = { cx: cx2, cy: cy2, r: { x: cx2 - w / 2, y: cy2 - h / 2, w, h } };
      }
      placed.push(best.r);

      // A hairline from the plate back to its leg, so a pushed label still
      // reads as belonging to the line it measures.
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = Z_INK; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(bx3, by3); ctx.lineTo(best.cx, best.cy); ctx.stroke();
      ctx.restore();

      ctx.fillStyle = MAP_INK.plate;
      ctx.strokeStyle = MAP_INK.plateEdge; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(best.r.x, best.r.y, w, h, 3);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = Z_INK;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(txt, best.cx, best.cy);
    };
    const seg = (a2, b2) => {
      ctx.beginPath();
      ctx.moveTo(tX(a2.rx, a2.ry), tY(a2.rx, a2.ry));
      ctx.lineTo(tX(b2.rx, b2.ry), tY(b2.rx, b2.ry));
      ctx.stroke();
    };
    ctx.save();
    ctx.strokeStyle = Z_INK;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 4]);
    seg(g.p, g.foot);                                   // square off the line
    seg(g.pin, g.foot);                                 // along the line, from the pin
    if (g.bnd != null && g.bdir)
      seg(g.p, { rx: g.p.rx + g.bdir.rx * g.bnd, ry: g.p.ry + g.bdir.ry * g.bnd });
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    const fx = tX(g.foot.rx, g.foot.ry), fy = tY(g.foot.rx, g.foot.ry);
    const px2 = tX(g.pin.rx, g.pin.ry), py2 = tY(g.pin.rx, g.pin.ry);
    lab(`${Math.abs(g.dtl).toFixed(0)} m off line`, x, y, fx, fy);
    lab(`${Math.abs(g.belowPin).toFixed(0)} m ${g.belowPin > 0 ? 'past' : 'up from'} pin`,
        px2, py2, fx, fy);
    if (g.bnd != null && g.bdir) {
      const bxp = tX(g.p.rx + g.bdir.rx * g.bnd, g.p.ry + g.bdir.ry * g.bnd);
      const byp = tY(g.p.rx + g.bdir.rx * g.bnd, g.p.ry + g.bdir.ry * g.bnd);
      lab(`${g.bnd.toFixed(0)} m to bnd @ 90°`, x, y, bxp, byp);
    }
    // Where they landed, kept so the "never under the pin, never under each
    // other" rule can be checked against real frames rather than eyeballed.
    rd._zLabels = { pin: { x, y }, rects: placed };
    ctx.restore();
  }

  // The pin. Faded on starboard, because on that gybe it is a note of where you
  // decided to go rather than a live instruction.
  const live = !z || z.onPort;
  ctx.globalAlpha = live ? 1 : 0.4;
  ctx.strokeStyle = MAP_INK.halo;
  ctx.lineWidth = 3;
  ctx.fillStyle = Z_INK;
  ctx.beginPath();
  ctx.moveTo(x, y - 11); ctx.lineTo(x + 9, y); ctx.lineTo(x, y + 11); ctx.lineTo(x - 9, y);
  ctx.closePath(); ctx.stroke(); ctx.fill();
  ctx.font = '700 10px Orbitron, monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = MAP_INK.halo;
  ctx.fillText('Z', x, y + 0.5);

  // Unlocked: a dashed collar saying this one can be picked up.
  if (!ZPT.locked) {
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = Z_INK;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(x, y, Z_HIT_PX, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}


/* ── time to kill, to a chosen END of the line ──────────────────────────────
 *
 * The onboard computer's TTK — the number the sailors steer by — was decoded
 * off this archive (docs/ttk-decoded.html): it is an accelerating run to the
 * NEAREST point of the line, at a constant per-config acceleration, capped
 * near the polar speed for the angle of that run. Reverse-engineered to about
 * a second over 12,000 pre-start samples across all fifty races.
 *
 * That number answers "can I make the line". It cannot answer "can I make the
 * BOAT END", which is a different run at a different angle with a different
 * polar cap — and on a reaching start the two diverge hard as you come down
 * the line. This computes the same quantity, aimed at an end:
 *
 *   ttk = time you have − time to reach THAT end
 *
 * with the run integrated on the measured per-config acceleration table (the
 * real curve, with its soft patch — not the constant the onboard model uses),
 * capped at the polar for the rhumb-line angle through coneCap, so the no-go
 * treatment matches the cone's. TRIGGER in the CONE panel sets how good a pull
 * to assume for both.
 *
 * Positive: you can be at that end with seconds in hand — time you must burn.
 * Negative: that end is out of reach by that many seconds even at potential.
 */
function ttkEnd(rd, t, focus, end) {
  if (t >= -0.5 || !rd || !rd.frame) return null;
  const tr = focus && rd.tracks[focus];
  const s = tr && sampleAt(tr, t);
  if (!s || rd.frame.dtl(s) <= 0) return null;
  const w = crossWindAt(rd, t, focus) ||
            (rd.wind && rd.wind.twd != null ? rd.wind : null);
  if (!w || w.twd == null || w.tws == null) return null;
  const f = rd.frame;
  const e = end === 'lee' ? f.leeR : f.windR;
  const dx = e.rx - s.rx, dy = e.ry - s.ry;
  const dist = Math.hypot(dx, dy);
  if (dist < 5) return { ttk: -t, ttl: 0, dist };
  const A = Math.abs(angDiff(w.twd, f.bearingFromRot(dx, dy)));
  const cfg = accelCfgKey(rd);
  const ttl = ttlRun(s.sog, w.tws, A, dist, CONE.aggr, coneCap(rd, A, w.tws), cfg);
  if (ttl == null) return { ttk: null, ttl: null, dist, unreachable: true };
  return { ttk: -t - ttl, ttl, dist };
}

/* TTK to the Z SPOT, for any boat — the entry question, on the same physics,
 * over BOTH legs of the journey: boat -> Z, then Z -> the line.
 *
 * Leg 1 (boat to Z) is an accelerating run on the measured per-polar table,
 * capped at the polar, at CONE's trigger setting — arriving at `arrival`.
 * Leg 2 (Z to the line) is timeToLine(rd, ZPT.p): the same accel model, at
 * the polar cap since a pin has no speed of its own (the tool's standing
 * convention for a place rather than a boat). Z_RATIO — "your ratio from Z
 * back to the line" — is leg 2's tts / ttl at the moment you arrive: exactly
 * what displayRatio reads for a live boat, just anchored on the pin.
 *
 * The number this drives LATE / EARLY is NOT the plain tts − ttl of leg 2 —
 * that would put the line at ratio 1.00, and a boat that reaches Z with
 * nothing but ratio 1.00 in hand has nothing left for the tack itself. So
 * TTK TO Z is scaled by ZPT.targetRatio, the margin a crew sets for that
 * tack (the same idea LAST_TACK.ratio already is for the final board):
 *
 *   ttk = tts − targetRatio × ttl
 *
 * which makes TTK TO Z = 0 mean, by construction, "ratio at Z equals your
 * target" — not "ratio at Z equals 1.00". A heading to Z the boat cannot
 * sail, or a Z the polar cannot reach at all, is unreachable and therefore
 * late — no ratio math rescues a heading that is not sailable. */
/* Damped TWD/TWS for the whole Z system — leg 1 (below), the boat-end leg,
 * and the ghost cone's own fan all read this SAME number, so a jump in one
 * can never disagree with a jump in another. Raw TWD swings hard for a few
 * seconds coming out of a tack — the vane itself is disturbed by the
 * manoeuvre, not the wind — and every one of these legs used to read
 * instantaneous wind (crossWindAt with its default 'race' source, which
 * settledWind hands back completely undamped; rd.wind directly, no damping
 * at all) straight into a distance/time run, so the cone's size and TTK TO
 * BOAT END would jump right along with the vane. 'mark' source: the marks
 * ON the line are the air that matters at the line, same as the cone's fan
 * already used — this just gives leg 1 and the boat-end leg the same
 * damped number instead of an undamped one of their own. */
function zWind(rd, t, focus) {
  return startWind(rd, t, focus, { source: 'mark', dampSec: ZPT.windDampSec });
}

/* Leg 1 alone — boat to Z, on the accelerating table. Split out because it
 * is shared by two DIFFERENT second legs (Z to the generic line, below; Z to
 * the boat-end mark, further down) that fail independently of each other: a
 * Z the generic line math cannot resolve should not also blank out a boat-
 * end answer that is a perfectly good distance-and-wind calculation on its
 * own, and vice versa. Returns null where the question does not apply at
 * all (no Z, no boat, gun gone, no wind) — distinct from `unreachable:true`,
 * which means it applies and the answer is that the boat cannot sail it.
 * Wind comes off zWind, above — damped over ZPT.windDampSec — rather than
 * an instantaneous read, so this leg's arrival time doesn't jump with every
 * vane twitch coming out of a tack. */
function ttkZLeg1(rd, t, team) {
  if (!ZPT.on || !ZPT.p || t >= -0.5 || !rd || !rd.frame) return null;
  const tr = team && rd.tracks[team];
  const s = tr && sampleAt(tr, t);
  if (!s) return null;
  const dx = ZPT.p.rx - s.rx, dy = ZPT.p.ry - s.ry;
  const dist = Math.hypot(dx, dy);
  if (dist < 10) return { arrival: t, ttlToZ: 0, tts: -t };
  const w = zWind(rd, t, team);
  if (!w || w.twd == null || w.tws == null) return null;
  const A = Math.abs(angDiff(w.twd, rd.frame.bearingFromRot(dx, dy)));
  const ttlToZ = ttlRun(s.sog, w.tws, A, dist, CONE.aggr,
                        coneCap(rd, A, w.tws), accelCfgKey(rd));
  if (ttlToZ == null) return { unreachable: true };
  const arrival = t + ttlToZ;
  return { arrival, ttlToZ, tts: -arrival };
}

function ttkZBoat(rd, t, team) {
  const leg1 = ttkZLeg1(rd, t, team);
  if (!leg1) return leg1;                          // null: does not apply here
  if (leg1.unreachable) return { ttk: null, ratio: null, unreachable: true };
  const ttlZLine = timeToLine(rd, ZPT.p);
  if (!(ttlZLine > 0)) return { ttk: null, ratio: null, unreachable: true };
  const { arrival, ttlToZ, tts } = leg1;
  return {
    arrival, ttlToZ, ttlZLine, tts,
    ratio: tts / ttlZLine,                          // Z RATIO: leg 2 alone
    ttk: tts - ZPT.targetRatio * ttlZLine,           // drives LATE / EARLY
    plainTtk: tts - ttlZLine,                        // classic ttk (ratio 1.00 cut) — TTK AT Z
  };
}

/* Whichever end is NOT the pin — the committee boat, and the thing "racing
 * at the boat end" is actually asking about. rd.pinEnd already says which
 * of the two line ends the pin is at; the other one is this. */
function boatEndPoint(rd) {
  const f = rd && rd.frame;
  if (!f || !f.leeR || !f.windR) return null;
  return rd.pinEnd === 'windward' ? f.leeR : f.windR;
}

/* Z is a target for a reason: the question placing it is answering is not
 * "can I make the line somewhere", it is "will I fetch the BOAT END" — the
 * end that actually decides a boat-end start, not whichever point on the
 * infinite line happens to be nearest. timeToLine() answers a different
 * question (it targets the nearer END only incidentally, when a point
 * happens to sit past it — otherwise it goes dead square across, which is
 * not a heading anyone sails at the boat specifically). This runs the same
 * accel model leg 1 (boat -> Z) runs, straight from Z to the boat-end mark,
 * so "reachable" here always means the mark itself, wherever Z is dropped.
 * The pin has no speed of its own, so — the same convention as every other
 * waypoint leg in this file (timeToLine, leg 1 above) — the run starts
 * already at the polar cap for the heading, not from a stop. Wind comes off
 * zWind — the same damped number leg 1 and the ghost cone use — rather than
 * the instantaneous rd.wind this used to read straight off the vane: a
 * distance-and-wind answer is only as steady as the wind half of it. */
function ttlZToBoatEnd(rd, t, focus) {
  const f = rd && rd.frame;
  if (!f || !ZPT.p || !rd.polar) return null;
  const w = zWind(rd, t, focus);
  if (!w || w.twd == null || w.tws == null) return null;
  const end = boatEndPoint(rd);
  if (!end) return null;
  const dx = end.rx - ZPT.p.rx, dy = end.ry - ZPT.p.ry;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return 0;
  const A = Math.abs(angDiff(w.twd, f.bearingFromRot(dx, dy)));
  const cap = coneCap(rd, A, w.tws);
  if (!(cap > 0)) return null;                    // the run is in the no-go
  return ttlRun(cap, w.tws, A, dist, CONE.aggr, cap, accelCfgKey(rd));
}

/* Early or late TO THE BOAT END — a distance equation, not a ratio one. We
 * know the wind; we know how far Z is from the boat-end mark; that is
 * enough to say how long the leg from Z takes (ttlZToBoatEnd). Add how long
 * it takes to REACH Z (leg 1, shared with TTK TO Z) and the arrival comes
 * with its own tts — time left to the gun. Compare the two times directly:
 * ttk = tts − ttlZToBoatEnd, ratio = tts / ttlZToBoatEnd. No ZPT.targetRatio
 * in this one — that scaling is TTK TO Z's own answer to a different
 * question (margin in hand AT Z for the tack); this leg only asks whether
 * there is enough time left, after Z, to reach the mark itself. And
 * deliberately NOT gated on timeToLine()/the generic Z-to-line leg TTK TO Z
 * needs — a Z the generic line math cannot resolve can still have a perfectly
 * good, independently computable answer for "how long to the boat from
 * here", and blanking this leg because that unrelated one failed was the
 * bug: the distance-and-wind answer was right all along, it just never got
 * to show up. */
function ttkToBoatEnd(rd, t, team) {
  const leg1 = ttkZLeg1(rd, t, team);
  if (!leg1) return null;                          // does not apply here
  if (leg1.unreachable) return { ttk: null, ratio: null, unreachable: true };
  const ttlBoat = ttlZToBoatEnd(rd, t, team);
  if (ttlBoat == null) return { ttk: null, ratio: null, unreachable: true, ttlToZ: leg1.ttlToZ };
  const { tts, arrival, ttlToZ } = leg1;
  if (ttlBoat === 0) return { arrival, ttlToZ, ttlBoat, tts, ratio: null, ttk: tts };
  return { arrival, ttlToZ, ttlBoat, tts, ratio: tts / ttlBoat, ttk: tts - ttlBoat };
}

/* The verdict on one boat's entry: 'late', 'early', or 'ok' — null where
 * there is nothing to judge (no Z, no sample, no wind). Unreachable is late
 * by definition: if you cannot get to the spot, you are not early for it. */
function zEntryClass(q) {
  if (!q) return null;
  if (q.unreachable || q.ttk == null || q.ttk < ZPT.lateUnder) return 'late';
  return q.ttk > ZPT.earlyOver ? 'early' : 'ok';
}

/* ── the start cone ─────────────────────────────────────────────────────────
 *
 * The WAVE answers "am I in the zone", sweeping back FROM the line to find
 * every place that could still make it on time. This answers the question the
 * afterguard actually asks, which is the same physics the other way round:
 * pull the trigger NOW, hold this angle — where do I end up when the gun goes?
 *
 * Apex on the boat, one arm per sampled heading, and the arm's length is the
 * water covered in the time that is left. Where the fan crosses the line is
 * the stretch of line you can make; the part of it BEYOND the line is where
 * you would arrive early and have to burn time to stay behind it.
 *
 * The whole reason this is not the WAVE with its origin moved is acceleration.
 * The WAVE assumes polar speed from a standing sweep, which for a boat sitting
 * at 20 km/h with twenty seconds left overstates the reach by half a boat
 * length per second. This one integrates the measured table in js/accel.js —
 * a(v, tws, twa) off 109k straight-line samples of this fleet — from the speed
 * the boat is doing right now up to the polar target for the angle.
 *
 * What it does not model, and both make it optimistic rather than pessimistic:
 * the seconds spent turning from the current heading onto the sampled one, and
 * dirty air. A cone that promises less than the boat can do gets ignored on
 * the second race day, so the honest place to be wrong is the generous side —
 * as long as it says so, which is what SPREAD is really for: the arms far off
 * the current heading are the ones the turn would cost most.
 */
/* Which polar's measured acceleration the cone — and every time-to-line and
 * TTK built on the same physics — reads. 'auto' follows the race bundle's
 * config (its mNN prefix picks the table); a hand pick pins one of the mined
 * per-polar tables from the 2025-26 fleet pull, for the days you know what is
 * on the boat before the bundle does. Lives in the BOATS panel as a noMode
 * control, so it survives reloads via the globals store but is not a "mode".
 * The speed ceiling per angle still comes from the race's own polar file —
 * this picks the ACCELERATION table only. */
const POLAR_SEL = { pick: 'auto' };

function accelCfgKey(rd) {
  if (POLAR_SEL.pick !== 'auto') return POLAR_SEL.pick;
  return rd && rd.configs && rd.configs.length === 1 ? rd.configs[0] : null;
}

const CONE = {
  on: true,
  spread: 180,      // degrees either side of the current course — a full sweep,
                    // so BOTH lobes are whole. The no-go and dead downwind cut
                    // them apart by themselves; nothing needs a narrower window
                    // except taste, and that is what the control is for.
  step: 5,          // degrees between arms
  aggr: 0.35,       // 0 = the repeatable table, 1 = the best of it
  rays: true,
  fill: 0.22,       // two lobes now, so each sits lighter than one did
};

/* The fan as pure geometry, so it can be checked without drawing it. */
function conePoints(rd, t, focus, at, opt) {
  /* The boat's own cone is gated on CONE.on; the Z ghost is not — it is its
   * own switch (ZPT.on, unlocked) and has to keep showing while a sailor is
   * placing the pin whether or not they happen to have the main cone toggled
   * on at all. opt.force is how the ghost's call opts out of the CONE.on
   * gate without opting out of anything else conePoints checks. */
  if ((!opt || !opt.force) && !CONE.on) return null;
  if (!rd || !rd.frame || !(t < 0)) return null;
  const tr = focus && rd.tracks[focus];
  const me = tr && sampleAt(tr, t);
  if (!me) return null;
  /* The boat's own cone stays off until the boat has actually sailed INTO the
   * course boundary — the pre-start box, the same polygon the run-out above
   * tests the pin against. Before that the boat is still coming in from
   * outside it (warm-up, the pre-race sail-by) and a reach-to-the-line cone
   * from out there is answering a question the pre-start has not started
   * asking yet — it would just be one more shape on the water on top of
   * whatever the boat is actually doing before it gets there. insideBoundary
   * returning null (no boundary in the file at all) does not block it: a race
   * with no pre-start box on file is not a reason to hide the cone forever,
   * only a confirmed OUTSIDE is. The Z ghost is exempt (opt.force) — placing
   * Z is exactly the work done before sailing in, same as it is exempt from
   * CONE.on itself, just above. */
  if ((!opt || !opt.force) && insideBoundary(rd, me) === false) return null;
  /* opt.wind swaps the wind the fan is built in (the Z ghost reads the start
   * marks' own air rather than the boat's); opt.T swaps the run time (the
   * ghost runs the gun time TIMES the Z target ratio, so a ratio above 1
   * draws the longer reach that margin buys, not dead-on-the-gun). */
  const w = (opt && opt.wind) || crossWindAt(rd, t, focus);
  if (!w || w.twd == null || w.tws == null) return null;

  // The heading we are on, not the way the bows point — the same choice the
  // threat sectors make, and for the same reason.
  const myCog = me.cog != null ? me.cog : me.hdg;
  if (myCog == null) return null;
  const T = opt && opt.T != null ? opt.T : -t;    // seconds to the gun
  const f = rd.frame, p = rd.polar;

  /* A full sweep is a circle, and a circle's two ends are the same heading —
   * so stop one step short of repeating it, and tell the run-builder the array
   * wraps. Without both, the lobe that straddles dead astern comes out as two
   * pieces with a seam and a duplicated arm down the middle of it. */
  const full = CONE.spread >= 180;
  const last = full ? 180 - CONE.step : CONE.spread;

  /* `at` moves the apex without changing the physics: the same sweep, the
   * same speed in hand, measured from a different piece of water. The Z pin
   * uses it to ask "and from HERE?" while the spot is being chosen. */
  const apex = at || me;
  const arms = [];
  for (let off = -CONE.spread; off <= last + 1e-9; off += CONE.step) {
    const brg = myCog + off;
    let A = ((w.twd - brg) % 360 + 360) % 360;
    if (A > 180) A = 360 - A;

    const cap = coneCap(rd, A, w.tws);
    const cfg = accelCfgKey(rd);
    const run = accelRun(me.sog, w.tws, A, T, CONE.aggr, cap, cfg);
    const d = f.r(Math.sin(brg * D2R), Math.cos(brg * D2R));
    /* Which tack this heading would be sailed on — from the wind and the
     * heading, not from the boat's own logged TWA, because the whole point of
     * the arm is that it is a heading we are NOT on yet. Wind off the starboard
     * side is starboard tack, the same test the threat sectors use. */
    const stbd = angDiff(w.twd, brg) >= 0;
    arms.push({ brg, off, dist: run.d, vEnd: run.v, cap, twa: A, stbd,
                rx: apex.rx + d.rx * run.d, ry: apex.ry + d.ry * run.d });
  }
  return { me, apex, T, twd: w.twd, tws: w.tws, cog: myCog, arms, wrap: full };
}

/* Port red, starboard green — the way the boats are marked on this map and on
 * the water, so there is nothing to translate at the moment you are reading it.
 *
 * The cone's geometry comes in two pieces because the boat has two tacks
 * available; only the starboard lobe is DRAWN (see drawStartCone) — on port
 * in the entry it is where you would end up if you put the bow down and
 * went, which is the interesting one, and it is the tack with rights. The
 * lobes are separated by the no-go at one end and by dead downwind at the
 * other, which is why nothing has to decide where one stops — the arms with
 * no reach do it. The port ink stays for the day the red fan is asked back. */
const CONE_INK = { port: '255,77,94', stbd: '74,222,128' };
const Z_CONE_INK = '255,138,216';   // Z_INK (#ff8ad8) as an rgb triple

/* Consecutive arms sharing a tack and actually going somewhere. A run is a
 * lobe: the no-go pinches to the apex between them, so a gap in the arms IS
 * the boundary and nothing has to be told where to cut. */
function coneRuns(arms, wrap) {
  const runs = [];
  let cur = null;
  arms.forEach((a, i) => {
    if (!(a.dist > 0)) { cur = null; return; }
    if (!cur || cur.stbd !== a.stbd) {
      cur = { stbd: a.stbd, arms: [], from: i, to: i };
      runs.push(cur);
    }
    cur.arms.push(a);
    cur.to = i;
  });
  /* On a full sweep the array is a circle cut open, so a lobe lying across the
   * cut arrives as the last run and the first run. Same tack, one touching each
   * end: that is one lobe, and joining them is what stops a seam being drawn
   * down the middle of it. */
  if (wrap && runs.length > 1) {
    const a0 = runs[0], aN = runs[runs.length - 1];
    if (a0.stbd === aN.stbd && a0.from === 0 && aN.to === arms.length - 1) {
      aN.arms = aN.arms.concat(a0.arms);
      runs.shift();
    }
  }
  return runs.filter(r => r.arms.length > 1);
}

/* The boat's own cone, and — while a Z pin is being placed — a ghost of the
 * same physics from the pin: "and from HERE?". The ghost is pink like
 * everything Z, deliberately faint (no dark over-early clip, no rays, a
 * whisper of fill) so the Z numbers, the marks and the laylines stay
 * readable through it, and it comes off the map the moment the pin is
 * locked, the same way the Z crosshair working does. It differs from the
 * boat's cone in three deliberate ways: it is built in the START MARKS' own
 * wind (zWind, ZPT.windDampSec damped — the same number leg 1 and the boat-
 * end leg read, so the fan's size can't disagree with the numbers beside
 * it), because Z lives at the line and the line's air is the air that
 * matters there; its run time is the REAL time you would have once you got
 * there — leg 1's own tts (ttkZLeg1, the same clock TTK TO Z and TTK TO
 * BOAT END run on), not a guess made from the current instant — so the fan
 * literally IS "how far can I get from Z with what's left", the same
 * distance-and-wind question those numbers answer, just drawn; it falls
 * back to gun-time-times-target-ratio only when leg 1 has no answer yet (no
 * track, no wind). And it is INDEPENDENT of the CONE switch — it is Z's own
 * working, on whenever Z is being placed, off whenever it is not, whatever
 * CONE says (drawStartCone is let through the outer opts.cone gate for
 * exactly this reason, in the o = Object.assign block that builds render
 * options). */
function drawStartCone(ctx, rd, t, tX, tY, W, H) {
  drawConeFrom(ctx, rd, t, tX, tY, null, false);
  if (ZPT.on && ZPT.p && !ZPT.locked && t < 0) {
    const w = zWind(rd, t, APP.focus);
    const leg1 = ttkZLeg1(rd, t, APP.focus);
    const T = leg1 && !leg1.unreachable && leg1.tts > 0 ? leg1.tts
            : -t * Math.max(0.2, ZPT.targetRatio);
    drawConeFrom(ctx, rd, t, tX, tY, ZPT.p, { wind: w, T: Math.max(0.2, T), force: true });
  }
}

function drawConeFrom(ctx, rd, t, tX, tY, at, ghost) {
  const c = conePoints(rd, t, APP.focus, at, ghost || undefined);
  if (!c) return;
  /* Starboard lobe only, on either tack. The port fan came along for free
   * with the full sweep and went again by request: the lobe that decides an
   * entry is the starboard one — it is the tack with rights, and the one you
   * are measuring your escape onto — and the red fan mostly sat on top of
   * the fleet you were trying to read. The GEOMETRY still carries both
   * (coneRuns is unfiltered for the checks); only the drawing narrows. */
  const runs = coneRuns(c.arms, c.wrap).filter(r => r.stbd);
  if (!runs.length) return;

  const ax = tX(c.apex.rx, c.apex.ry), ay = tY(c.apex.rx, c.apex.ry);
  const lobe = (r) => {
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    for (const a of r.arms) ctx.lineTo(tX(a.rx, a.ry), tY(a.rx, a.ry));
    ctx.closePath();
  };

  ctx.save();

  const fillA = ghost ? Math.min(0.09, CONE.fill * 0.4) : CONE.fill;
  for (const r of runs) {
    // Pink for the ghost — it belongs to Z, and everything Z is pink.
    const ink = ghost ? Z_CONE_INK : r.stbd ? CONE_INK.stbd : CONE_INK.port;
    lobe(r);
    ctx.fillStyle = `rgba(${ink},${fillA})`;
    ctx.fill();
  }

  /* The early half of each lobe, darker: the same shape clipped to the far side
   * of the line. Clipped rather than rebuilt as a second polygon, because the
   * boundary is a straight line across the fan and a clip is exactly that — no
   * arm has to be split and no outline can come out tangled. */
  const beyond = ghost ? null : linePlane(rd.frame, -1, 6000);
  if (beyond) {
    ctx.save();
    ctx.beginPath();
    beyond.forEach((q, i) => {
      const x = tX(q.rx, q.ry), y = tY(q.rx, q.ry);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.clip();
    for (const r of runs) {
      lobe(r);
      ctx.fillStyle = r.stbd ? `rgba(12,90,40,${Math.min(0.85, CONE.fill + 0.28)})`
                             : `rgba(120,0,10,${Math.min(0.85, CONE.fill + 0.28)})`;
      ctx.fill();
    }
    ctx.restore();
  }

  // The arms themselves. They are what makes the picture read as a set of
  // choices rather than as a blob: each one is a heading you could steer.
  if (CONE.rays && !ghost) {
    for (const r of runs) {
      ctx.strokeStyle = `rgba(${r.stbd ? CONE_INK.stbd : CONE_INK.port},0.34)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const a of r.arms) {
        ctx.moveTo(ax, ay);
        ctx.lineTo(tX(a.rx, a.ry), tY(a.rx, a.ry));
      }
      ctx.stroke();
    }
  }

  // The outer edge, solid: this is the front, and it is the thing being read.
  // The ghost's is faint and dashed — an offer, not the picture in force.
  for (const r of runs) {
    ctx.strokeStyle = `rgba(${ghost ? Z_CONE_INK : r.stbd ? CONE_INK.stbd : CONE_INK.port},${ghost ? 0.4 : 0.9})`;
    ctx.lineWidth = ghost ? 1.1 : 1.6;
    if (ghost) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    r.arms.forEach((a, i) => {
      const x = tX(a.rx, a.ry), y = tY(a.rx, a.ry);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    if (ghost) ctx.setLineDash([]);
  }
  ctx.restore();

  // Kept for the harness and for anyone asking why the fan is that shape.
  if (!ghost) { rd._cone = c; rd._coneRuns = runs; }
}

/* One side of the start line as a polygon big enough to cover the map: the
 * line's own direction swept `reach` metres to the `sign` side of it. */
function linePlane(f, sign, reach) {
  if (!f || !f.leeR || !f.windR) return null;
  const ux = f.u.x, uy = f.u.y, nx = f.n.x * sign, ny = f.n.y * sign;
  const mx = (f.windR.rx + f.leeR.rx) / 2, my = (f.windR.ry + f.leeR.ry) / 2;
  const L = reach;
  return [
    { rx: mx - ux * L, ry: my - uy * L },
    { rx: mx + ux * L, ry: my + uy * L },
    { rx: mx + ux * L + nx * L, ry: my + uy * L + ny * L },
    { rx: mx - ux * L + nx * L, ry: my - uy * L + ny * L },
  ];
}


const QUICK = [
  { label: 'CROSSWIND', get: () => CROSS.on,
    set: v => CROSS.on = v,
    title: 'the ladder rung through MY BOAT, and the gap to the boat you are level with' },
  { label: 'ROUTE', get: () => ROUTE.on,
    set: v => ROUTE.on = v,
    title: 'the boundary-to-boundary route to the mark you are sailing to, forked at the gate' },
  { label: 'NEXT LEG', get: () => ROUTE.next,
    set: v => ROUTE.next = v,
    title: 'and the leg after that, from the mark you round to the one beyond it' },
  { label: 'LAYLINES', get: () => LAYLINE.on,
    set: v => LAYLINE.on = v,
    title: 'the top and bottom gate laylines at target angle' },
  { label: 'WIND FIELD', get: () => WIND_VIEW.field !== 'off',
    set: v => WIND_VIEW.field = v ? WIND_FIELD_LAST : 'off',
    title: 'the interpolated wind field across the course, drifting downwind' },
  { label: 'CONE', get: () => CONE.on,
    set: v => CONE.on = v,
    title: 'the start cone — pull the trigger now and hold an angle, and this '
         + 'is where you are when the gun goes. The starboard-tack lobe, '
         + 'shown on either tack, dark where you would be over the line '
         + 'early' },
  { label: 'GAS', get: () => GAS.on,
    set: v => GAS.on = v,
    title: 'dirty air, shed by every boat and drifting down the course with the '
         + 'wind — including the dirt from a boat that has already tacked away' },
  { label: 'Z', get: () => ZPT.on,
    set: v => { ZPT.on = v; if (v && !ZPT.p) zDrop(); },
    title: 'drop a spot on the water and get the port-tack route, angle and time '
         + 'to it — drag the pin, then double-click it to lock it (or Z PIN in '
         + 'the START menu)' },
];

/* ── keyboard ────────────────────────────────────────────────────────────────
 *
 * One table, three consumers: the key handler, the help sheet drawn from it,
 * and anyone reading this file to find out what a key does. A second list would
 * be a list that goes stale the first time a key is added and nobody remembers
 * to update it — the same reason a preset IS the panel list.
 *
 * Letters are chosen from the thing they switch rather than from what is left
 * over: C crosswind, R route, L laylines, W wave, Z the Z spot. Where two
 * things want the same letter the one you reach for mid-race gets it.
 *
 * `act` does the work and `state` reports it, so the sheet can show what is on
 * without anything having to tell it.
 */
const KEY_DEFS = [
  { g: 'Overlays', def: 'c', id: 'crosswind', name: 'Crosswind',
    state: () => CROSS.on,        act: () => CROSS.on = !CROSS.on },
  { g: 'Overlays', def: 'r', id: 'route', name: 'Route',
    state: () => ROUTE.on,        act: () => ROUTE.on = !ROUTE.on },
  { g: 'Overlays', def: 'n', id: 'nextleg', name: 'Next leg',
    state: () => ROUTE.next,      act: () => ROUTE.next = !ROUTE.next },
  { g: 'Overlays', def: 'l', id: 'laylines', name: 'Laylines',
    state: () => LAYLINE.on,      act: () => LAYLINE.on = !LAYLINE.on },
  { g: 'Overlays', def: 'b', id: 'gatebias', name: 'Gate bias',
    state: () => GATE_BIAS.on,    act: () => GATE_BIAS.on = !GATE_BIAS.on },
  { g: 'Overlays', def: 'g', id: 'gas', name: 'Gas',
    state: () => GAS.on,          act: () => GAS.on = !GAS.on },

  { g: 'Start', def: 'w', id: 'wave', name: 'Wave',
    state: () => APP.opts.wave,   act: () => APP.opts.wave = !APP.opts.wave },
  { g: 'Start', def: 'm', id: 'linetom1', name: 'Line to M1',
    state: () => END_LEGS.on,     act: () => END_LEGS.on = !END_LEGS.on },
  { g: 'Start', def: 's', id: 'startlay', name: 'Start laylines',
    state: () => START_LAY.on,    act: () => START_LAY.on = !START_LAY.on },
  { g: 'Start', def: 'p', id: 'fastpoint', name: 'Fast point + advantage',
    state: () => APP.opts.laylines, act: () => APP.opts.laylines = !APP.opts.laylines },
  { g: 'Start', def: 'z', id: 'z', name: 'Z',
    state: () => ZPT.on,
    act: () => { ZPT.on = !ZPT.on; if (ZPT.on && !ZPT.p) zDrop(); } },
  { g: 'Start', def: 'Z', id: 'zlock', name: 'Lock / unlock the Z pin', shift: true,
    state: () => ZPT.on && ZPT.locked,
    act: () => { if (ZPT.p) ZPT.locked = !ZPT.locked; } },

  { g: 'Wind', def: 'f', id: 'windfield', name: 'Wind field',
    state: () => WIND_VIEW.field !== 'off',
    act: () => WIND_VIEW.field = WIND_VIEW.field === 'off' ? WIND_FIELD_LAST : 'off' },
  { g: 'Wind', def: 'v', id: 'livewind', name: 'Live wind arrows',
    state: () => WIND_VIEW.live !== 'off',
    act: () => WIND_VIEW.live = WIND_VIEW.live === 'off' ? 'marks' : 'off' },

  { g: 'Boats', def: 'e', id: 'threats', name: 'Potential threats',
    state: () => THREATS.on,      act: () => THREATS.on = !THREATS.on },
  { g: 'Boats', def: 'j', id: 'projection', name: 'Projected line',
    state: () => PROJ.on,         act: () => { PROJ.on = !PROJ.on; applyProj(); } },
  { g: 'Boats', def: 'k', id: 'speedlabels', name: 'Speed labels',
    state: () => APP.opts.allSog, act: () => APP.opts.allSog = !APP.opts.allSog },
  { g: 'Boats', def: 't', id: 'trails', name: 'Trails · 10 / 20 / 30 / 60 / all',
    show: () => APP.opts.trailSec >= 999 ? 'all' : `${APP.opts.trailSec} s`,
    act: () => { const o = [10, 20, 30, 60, 999];
                 APP.opts.trailSec = o[(o.indexOf(APP.opts.trailSec) + 1) % o.length]; } },

  { g: 'View', def: 'q', id: 'mode', name: 'Mode · cycle auto / PRE-START / UPWIND / DOWNWIND',
    show: () => MODE.hold === 'auto' ? `auto · ${MODE_NAME[MODE.now]}`
                                     : `held ${MODE_NAME[MODE.hold]}`,
    act: () => { const o = ['auto', 'pre', 'up', 'down'];
                 setHold(o[(o.indexOf(MODE.hold) + 1) % o.length]); } },
  { g: 'View', def: 'x', id: 'viewport', name: 'Viewport',
    show: () => VIEWPORT_NAME[APP.opts.mode] || APP.opts.mode,
    act: () => { const o = ['fleet', 'course', 'boat', 'boatOffset'];
                 APP.opts.mode = o[(o.indexOf(APP.opts.mode) + 1) % o.length];
                 syncRecentre(); } },
  { g: 'View', def: 'o', id: 'orientation', name: 'Orientation',
    show: () => MAP_ROT.mode,
    act: () => { const o = ['course', 'wind', 'boat', 'north'];
                 MAP_ROT.mode = o[(o.indexOf(MAP_ROT.mode) + 1) % o.length]; } },
  { g: 'View', def: 'd', id: 'theme', name: 'Theme',
    show: () => APP.theme,
    act: () => setTheme(THEMES[(THEMES.indexOf(APP.theme) + 1) % THEMES.length]) },
  { g: 'View', def: 'a', id: 'basemap', name: 'Basemap',
    state: () => BASEMAP.on,      act: () => BASEMAP.on = !BASEMAP.on },
  { g: 'View', def: '0', id: 'resetview', name: 'Reset zoom and pan', act: () => resetView() },

  { g: 'Modes', def: '1', id: 'modepre', name: 'Hold PRE-START',
    state: () => MODE.hold === 'pre',
    act: () => setHold(MODE.hold === 'pre' ? 'auto' : 'pre') },
  { g: 'Modes', def: '2', id: 'modeup', name: 'Hold UPWIND',
    state: () => MODE.hold === 'up',
    act: () => setHold(MODE.hold === 'up' ? 'auto' : 'up') },
  { g: 'Modes', def: '3', id: 'modedown', name: 'Hold DOWNWIND',
    state: () => MODE.hold === 'down',
    act: () => setHold(MODE.hold === 'down' ? 'auto' : 'down') },
  { g: 'Modes', def: '4', id: 'modeauto', name: 'Back to auto',
    state: () => MODE.hold === 'auto', act: () => setHold('auto') },

  { g: 'Transport', def: 'Space', id: 'play', name: 'Play / pause', noAct: true },
  { g: 'Transport', def: '← →', id: 'step', name: 'Step 1 s · shift for 5 s', noAct: true },
  { g: 'Transport', def: '?', id: 'help', name: 'This list', noAct: true },
];

/* ── bindings ────────────────────────────────────────────────────────────────
 *
 * KEY_DEFS carries the DEFAULT key for each action; what a key actually does is
 * KEY_DEFS plus whatever the user has rebound, kept separately and stored. Two
 * layers rather than one mutable list, so RESET is a delete rather than a
 * reconstruction, and so a default can be changed in this file later without
 * silently overwriting a binding somebody chose.
 *
 * Keyed by `id`, never by name or by key: renaming an action or moving its
 * default must not lose the binding somebody set for it.
 */
let KEY_BIND = {};                       // id -> { k, shift }

const keyOf = x => {
  const b = KEY_BIND[x.id];
  return b ? { k: b.k, shift: !!b.shift } : { k: x.def, shift: !!x.shift };
};

/* How a binding is written on screen. Shift is part of the identity — `z` and
 * `Z` are two different switches — so it is shown rather than implied. */
const keyLabel = x => {
  const b = keyOf(x);
  if (!b.k) return '—';
  return (b.shift ? '⇧' : '') + (b.k === ' ' ? 'Space' : b.k);
};

const loadBinds = () => {
  try {
    const raw = JSON.parse(load('keys') || '{}');
    KEY_BIND = {};
    for (const [id, b] of Object.entries(raw))
      if (b && typeof b.k === 'string') KEY_BIND[id] = { k: b.k, shift: !!b.shift };
  } catch { KEY_BIND = {}; }
};
const saveBinds = () => save('keys', JSON.stringify(KEY_BIND));

/* Bind, and take the key off whoever had it.
 *
 * A key that does two things does neither reliably, so a clash is resolved
 * rather than reported: the previous owner is left UNBOUND and named, so you
 * can see what you took and give it something else. Returns what was displaced.
 */
function bindKey(x, k, shift) {
  let stolen = null;
  for (const y of KEY_DEFS) {
    if (y === x || y.noAct) continue;
    const b = keyOf(y);
    if (b.k && b.k === k && !!b.shift === !!shift) {
      KEY_BIND[y.id] = { k: '', shift: false };
      stolen = y;
    }
  }
  KEY_BIND[x.id] = { k, shift: !!shift };
  saveBinds();
  return stolen;
}
const unbindKey = x => { KEY_BIND[x.id] = { k: '', shift: false }; saveBinds(); };
const resetBinds = () => { KEY_BIND = {}; saveBinds(); };

/* The map from a keystroke to an entry, through the binding layer. */
function keyEntry(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  for (const x of KEY_DEFS) {
    if (x.noAct) continue;
    const b = keyOf(x);
    if (!b.k) continue;                             // deliberately unbound
    if (!!b.shift !== e.shiftKey) continue;
    if (e.key === b.k) return x;
    // A shifted letter arrives as its capital, so letters compare
    // case-insensitively once the shift flag has already matched.
    if (b.k.length === 1 && e.key.length === 1 &&
        e.key.toLowerCase() === b.k.toLowerCase()) return x;
  }
  return null;
}

/* What may be bound. A modifier alone is not a shortcut, and the keys the
 * transport owns are left alone rather than being quietly stealable — losing
 * play/pause to a mis-key in a rebind would be a poor trade. */
const KEY_RESERVED = [' ', 'ArrowLeft', 'ArrowRight', 'Escape', '?', 'Tab', 'Enter'];
function keyBindable(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return false;
  if (KEY_RESERVED.includes(e.key)) return false;
  return e.key.length === 1 || /^F\d+$/.test(e.key);
}

/* ── the help sheet ─────────────────────────────────────────────────────────
 * Built from KEY_DEFS, so a shortcut cannot exist without being documented. It
 * shows the live state beside each key, which turns it from a list of bindings
 * into a readout of the whole tool on one screen. */
let KEYHELP = null, KEY_CAPTURE = null, KEY_NOTE = '';

function keyHelp(show) {
  if (!KEYHELP) {
    KEYHELP = document.createElement('div');
    KEYHELP.className = 'keyhelp card';
    KEYHELP.hidden = true;
    ($('map') || document.body).appendChild(KEYHELP);
  }
  const on = show == null ? KEYHELP.hidden : show;
  if (!on) { KEYHELP.hidden = true; KEY_CAPTURE = null; KEY_NOTE = ''; return; }

  const groups = [];
  for (const x of KEY_DEFS) {
    let g = groups.find(q => q.g === x.g);
    if (!g) groups.push(g = { g: x.g, rows: [] });
    let val = '';
    try {
      if (x.show) val = x.show() || '';
      else if (x.state) val = x.state() ? 'on' : 'off';
    } catch { val = ''; }
    const cap = KEY_CAPTURE === x.id;
    const fixed = x.noAct;
    /* A row is a button when it can be rebound and a plain div when it cannot.
     * The transport keys are shown because you want them on the list, and are
     * not offered because taking play/pause away by accident is not a trade
     * anybody wants. */
    const kbd = `<kbd class="${cap ? 'cap' : ''}">${cap ? '…' : keyLabel(x)}</kbd>`;
    const body = `${kbd}<span class="n">${x.name}</span>` +
                 `<span class="s${x.state && val === 'on' ? ' on' : ''}">${val}</span>`;
    g.rows.push(fixed
      ? `<div class="kh fixed">${body}</div>`
      : `<button class="kh${cap ? ' capturing' : ''}" data-id="${x.id}">${body}</button>`);
  }

  const note = KEY_CAPTURE
    ? 'press a key · backspace to unbind · esc to cancel'
    : (KEY_NOTE || 'click a shortcut to change it');
  KEYHELP.innerHTML =
    `<h2>KEYBOARD <span class="at">${note}</span>` +
    `<button class="mini kbreset">RESET</button>` +
    `<button class="mini kbclose">CLOSE</button></h2>` +
    '<div class="khcols">' +
    groups.map(g => `<div class="khg"><h3>${g.g}</h3>${g.rows.join('')}</div>`).join('') +
    '</div>';

  KEYHELP.querySelector('.kbclose').onclick = () => keyHelp(false);
  KEYHELP.querySelector('.kbreset').onclick = () => {
    resetBinds(); KEY_CAPTURE = null; KEY_NOTE = 'back to the defaults'; keyHelp(true);
  };
  for (const btn of KEYHELP.querySelectorAll('button.kh'))
    btn.onclick = () => {
      KEY_CAPTURE = KEY_CAPTURE === btn.dataset.id ? null : btn.dataset.id;
      KEY_NOTE = '';
      keyHelp(true);
    };
  KEYHELP.hidden = false;
}

/* The keystroke that lands while a row is armed. Returns true when it was
 * consumed, so the normal handler never sees the key you were binding. */
function keyCaptureHandled(e) {
  if (!KEY_CAPTURE) return false;
  const x = KEY_DEFS.find(q => q.id === KEY_CAPTURE);
  if (!x) { KEY_CAPTURE = null; return false; }
  e.preventDefault();

  if (e.key === 'Escape') { KEY_CAPTURE = null; KEY_NOTE = ''; keyHelp(true); return true; }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    unbindKey(x); KEY_CAPTURE = null; KEY_NOTE = `${x.name} unbound`; keyHelp(true); return true;
  }
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return true;
  if (!keyBindable(e)) {
    KEY_NOTE = `${e.key === ' ' ? 'Space' : e.key} is reserved`;
    keyHelp(true);
    return true;
  }
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const stolen = bindKey(x, k, e.shiftKey);
  KEY_CAPTURE = null;
  KEY_NOTE = stolen ? `${x.name} bound · ${stolen.name} is now unbound`
                    : `${x.name} bound to ${keyLabel(x)}`;
  keyHelp(true);
  return true;
}

function paintBar() {
  const bar = $('presetbar');
  if (!bar) return;

  bar.innerHTML = '';

  /* One row of three, where there used to be a mode pair AND a preset list.
   * They were always the same idea twice: the chip you clicked when the moment
   * changed, and the settings the moment carried. The lit chip is the mode in
   * force and is not a button you need to press — the race presses it. Pressing
   * one anyway HOLDS it, which is what you want reviewing; pressing a held one
   * hands it back. */
  const ml = document.createElement('span');
  ml.className = 'lbl';
  ml.textContent = 'MODE';
  bar.appendChild(ml);

  const modes = document.createElement('span');
  modes.className = 'chips modes';
  for (const m of MODES) {
    const b = document.createElement('button');
    b.textContent = MODE_NAME[m];
    b.classList.toggle('on', MODE.now === m);
    b.classList.toggle('held', MODE.hold === m);
    b.title = MODE.hold === m
      ? `held in ${MODE_NAME[m]} — click again to let the race decide`
      : `hold ${MODE_NAME[m]}, whatever the boat is doing`;
    b.onclick = () => setHold(MODE.hold === m ? 'auto' : m);
    modes.appendChild(b);
  }
  bar.appendChild(modes);

  const sp = document.createElement('span');
  sp.className = 'spacer';
  bar.appendChild(sp);

  const quick = document.createElement('span');
  quick.className = 'quick';
  for (const q of QUICK) {
    const b = document.createElement('button');
    b.textContent = q.label;
    b.title = q.title || '';
    if (q.soon) {
      b.disabled = true;
    } else {
      b.classList.toggle('on', !!q.get());
      b.onclick = () => { q.set(!q.get()); syncPanels(); paintBar(); rebuild(true); };
    }
    quick.appendChild(b);
  }
  bar.appendChild(quick);
}

/* Rows the rail is made of, so the filter can hide and show them without
 * caring what kind of widget each one holds. */
const ROWS = [];

const plain = h => String(h).replace(/<[^>]*>/g, '');

function buildPanels() {
  const root = $('panels');
  root.innerHTML = '';
  SYNC.length = 0;
  HEAVY.length = 0;
  ROWS.length = 0;

  for (const p of PANELS) {
    const card = document.createElement('div');
    card.className = 'card fold';
    card.dataset.group = p.group || 'view';
    const head = document.createElement('h2');
    head.innerHTML = `<span>${p.title}</span><em class="sum"></em><i class="caret"></i>`;
    head.tabIndex = 0;
    card.appendChild(head);

    // A section's state, on its own header. The rail is ten sections and forty
    // controls; being able to read what is on without opening anything is the
    // difference between a menu and a filing cabinet.
    const sum = head.querySelector('.sum');
    if (p.sum) SYNC.push(() => { try { sum.textContent = p.sum() || ''; } catch { sum.textContent = ''; } });

    const body = document.createElement('div');
    body.className = 'foldbody';
    card.appendChild(body);

    const paint = () => {
      const open = OPEN.has(p.title);
      card.classList.toggle('open', open);
      head.setAttribute('aria-expanded', String(open));
    };
    const toggle = () => {
      OPEN.has(p.title) ? OPEN.delete(p.title) : OPEN.add(p.title);
      saveOpen(); paint();
    };
    head.onclick = toggle;
    head.onkeydown = e => {
      // stopPropagation as well as preventDefault: the document's own key
      // handler treats Space as play/pause for anything that is not a text
      // field, and without this the rail's keyboard controls both fold the
      // section and pause the replay.
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); e.stopPropagation(); toggle();
      }
    };
    paint();
    card._rows = [];
    ROWS.push({ card, title: p.title, rows: card._rows });

    for (const c of p.controls) {
      // A custom control owns its whole area rather than the label/widget row —
      // the presets list is a different shape from a setting and pretending
      // otherwise would cost more than it saved.
      // A setting with no widget: carried by presets, absent from the rail.
      if (c.kind === 'ghost') continue;
      if (c.kind === 'custom') {
        const box = document.createElement('div');
        body.appendChild(box);
        const draw = () => c.build(box);
        HEAVY.push(draw);
        draw();
        card._rows.push({ el: box, hint: null, text: p.title.toLowerCase() });
        continue;
      }
      const row = document.createElement('div');
      row.className = 'c';
      row.innerHTML = `<label>${c.label}</label>`;
      const w = document.createElement('span');
      w.className = 'w';
      row.appendChild(w);
      body.appendChild(row);

      const hint = document.createElement('p');
      hint.className = 'chint';
      hint.hidden = true;
      if (c.hint) body.appendChild(hint);
      card._rows.push({ el: row, hint: c.hint ? hint : null,
                        text: (c.label + ' ' + p.title).toLowerCase() });

      const refresh = () => {
        // A control that depends on another is not dimmed, it is absent. Half
        // the rail is conditional, and a menu that only shows what is live is
        // a third the height of one that shows everything.
        const live = c.dep ? !!c.dep() : true;
        row.hidden = !live;
        if (!c.hint) return;
        let txt = '';
        try { txt = typeof c.hint === 'function' ? c.hint() : c.hint; } catch {}
        row.title = plain(txt);
        hint.hidden = !(live && HELP);
        if (live && HELP) hint.innerHTML = txt;
      };

      if (c.kind === 'toggle') {
        const b = document.createElement('button');
        b.className = 'sw';
        b.onclick = () => { c.set(!c.get()); syncPanels(); };
        w.appendChild(b);
        SYNC.push(() => {
          b.textContent = c.get() ? 'ON' : 'OFF';
          b.classList.toggle('active', !!c.get());
          refresh();
        });

      } else if (c.kind === 'num') {
        const minus = document.createElement('button');
        minus.className = 'step'; minus.textContent = '−';
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = c.min; inp.max = c.max; inp.step = c.step;
        const plus = document.createElement('button');
        plus.className = 'step'; plus.textContent = '+';
        const clamp = v => Math.max(c.min, Math.min(c.max, v));
        const commit = v => { c.set(+clamp(v).toFixed(2)); syncPanels(); };
        minus.onclick = () => commit(c.get() - c.step);
        plus.onclick  = () => commit(c.get() + c.step);
        inp.oninput   = () => { const v = parseFloat(inp.value);
                                if (isFinite(v)) { c.set(clamp(v)); syncPanels(true); } };
        w.append(minus, inp, plus);
        // Skip the input while it has focus, or typing "1." rewrites itself.
        SYNC.push(keep => {
          if (!(keep && document.activeElement === inp))
            inp.value = String(+c.get().toFixed(2));
          refresh();
        });

      } else if (c.kind === 'button') {
        const b = document.createElement('button');
        // The caption may be a function: a button that toggles a state has to
        // say which way it is about to go, and CONFIRM/RESET is one button.
        const cap = () => typeof c.text === 'function' ? c.text() : c.text;
        b.textContent = cap();
        b.onclick = () => { c.act(); syncPanels(); rebuild(true); };
        w.appendChild(b);
        SYNC.push(() => { b.textContent = cap(); refresh(); });

      } else if (c.kind === 'select') {
        const s = document.createElement('select');
        s.innerHTML = c.options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
        // A value that is not one of the options leaves a select empty, and
        // a numeric setting would then quietly take `+'' === 0`. Refuse it and
        // put the widget back to what the state actually is.
        s.onchange = () => {
          if (!c.options.some(o => String(o[0]) === s.value)) { s.value = String(c.get()); return; }
          c.set(s.value); syncPanels();
        };
        w.appendChild(s);
        SYNC.push(() => {
          const want = String(c.get());
          s.value = c.options.some(o => String(o[0]) === want) ? want : String(c.options[0][0]);
          refresh();
        });
      }
    }
    root.appendChild(card);
  }
  buildRailTools();
  buildMenuTabs();
  syncPanels();
}

/* ── the menu tabs ───────────────────────────────────────────────────────────
 *
 * Eleven sections in one column was a rail you scrolled to find anything in,
 * permanently occupying 318 px of a map that is the entire point of the tool.
 * They are grouped instead, and the group is chosen from a tab bar in the
 * bottom-right corner: one category open at a time, over the map, gone the
 * moment you click the tab again.
 *
 * The grouping follows what you are doing rather than what the code calls
 * things — WIND owns CROSSWIND because a ladder rung is a wind construct, and
 * START owns ROUTE, LAYLINES and GATE BIAS because they are all read in the
 * same two minutes.
 */
const MENU_TABS = [
  ['view',    'VIEW'],
  ['boat',    'BOAT'],
  ['start',   'START'],
  ['route',   'ROUTE'],
  ['wind',    'WIND'],
  ['presets', 'MODES'],
];
let MENU_OPEN = null;

function buildMenuTabs() {
  const host = $('menutabs');
  if (!host) return;
  host.innerHTML = '';
  for (const [key, label] of MENU_TABS) {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.group = key;
    b.onclick = () => openMenu(MENU_OPEN === key ? null : key);
    host.appendChild(b);
  }
  openMenu(load('menu') || null);
}

function openMenu(key) {
  MENU_OPEN = MENU_TABS.some(t => t[0] === key) ? key : null;
  save('menu', MENU_OPEN || '');
  const sheet = $('menusheet');
  if (sheet) sheet.hidden = !MENU_OPEN;
  for (const b of $('menutabs').children)
    b.classList.toggle('on', b.dataset.group === MENU_OPEN);
  // The cards are built once and kept; switching a tab only changes which of
  // them are shown, so SYNC, the filter and every open/shut state survive.
  for (const g of ROWS) {
    const owner = g.card.dataset.group;
    g.card.hidden = !MENU_OPEN || owner !== MENU_OPEN;
  }
  if (MENU_OPEN) syncPanels();
}

/* The filter and the HELP switch. Eleven sections is short enough to scan and
 * long enough that "where was DAMPING again" is a real question; typing three
 * letters answers it without knowing which section owns the control. */
function buildRailTools() {
  const host = $('railtools');
  if (!host) return;
  host.innerHTML = '';

  const q = document.createElement('input');
  q.type = 'search'; q.id = 'railq'; q.placeholder = 'filter settings…';
  q.autocomplete = 'off';
  q.oninput = () => applyFilter(q.value);
  // Escape clears rather than closing anything, and no key in here reaches the
  // transport controls.
  q.onkeydown = e => {
    e.stopPropagation();
    if (e.key === 'Escape') { q.value = ''; applyFilter(''); }
  };
  host.appendChild(q);

  const help = document.createElement('button');
  help.textContent = 'HELP';
  help.title = 'show the one-line explanation under each control';
  help.classList.toggle('on', HELP);
  help.onclick = () => {
    HELP = !HELP;
    save('help', HELP ? '1' : '0');
    help.classList.toggle('on', HELP);
    document.body.classList.toggle('help', HELP);
    syncPanels();
  };
  document.body.classList.toggle('help', HELP);
  host.appendChild(help);

  const shut = document.createElement('button');
  shut.textContent = '⇱';
  shut.title = 'collapse every section';
  shut.onclick = () => {
    OPEN.clear(); saveOpen();
    for (const g of ROWS) g.card.classList.remove('open');
  };
  host.appendChild(shut);
}

/* Filtering is presentational only — nothing is disabled, the rows are just
 * hidden — so a filtered rail cannot change what the map is drawing. */
function applyFilter(raw) {
  const q = (raw || '').trim().toLowerCase();
  for (const g of ROWS) {
    let hits = 0;
    for (const r of g.rows) {
      const on = !q || r.text.includes(q);
      r.el.classList.toggle('filtered', !on);
      if (r.hint) r.hint.classList.toggle('filtered', !on);
      // A row its own dependency has switched off is not a hit. Counting it
      // opened an empty section: filter for DAMPING with CROSSWIND reading the
      // race TWD and the CROSSWIND card appeared with nothing inside it.
      if (on && !r.el.hidden) hits++;
    }
    g.card.classList.toggle('nomatch', !!q && !hits);
    // While a filter is running every section with a hit is forced open, and
    // the remembered open-set is left untouched so clearing the box puts the
    // rail back exactly as it was.
    g.card.classList.toggle('forceopen', !!q && hits > 0);
  }
}

function syncPanels(keepFocus, light) {
  /* Every change to the rail is a change to the mode you are in — or, for the
   * handful of settings that belong to no mode, to the globals. Written back
   * here, the one place every control passes through. */
  modeStash();
  if (!MODE.busy && MODE.sets[MODE.now]) {
    clearTimeout(GLOBAL_SAVE);
    GLOBAL_SAVE = setTimeout(saveGlobals, 400);
  }
  for (const fn of SYNC) fn(keepFocus);
  if (!light) for (const fn of HEAVY) fn(keepFocus);
  // The bar's chips are a readout of the settings, so they refresh with
  // the rail rather than only when a preset is clicked.
  if (!light) paintBar();
  const q = $('railq');
  if (q && q.value) applyFilter(q.value);
}


/* ── boot ───────────────────────────────────────────────────────────────── */

async function boot() {
  try {
    APP.manifest = await (await fetch('data/manifest.json')).json();
  } catch (e) {
    overlay('bad', 'NO DATA',
      'Could not load <code>data/manifest.json</code>. The site has to be served ' +
      'over http, not opened from the filesystem — see the README.');
    return;
  }

  // Seeded from the app's own defaults, so this has to run before anything
  // changes them — and before buildPanels, which draws the presets list.
  setTheme(load('theme') || 'mid');
  HELP = load('help') === '1';
  loadBinds();
  /* Before buildPanels, so the MODES panel draws the mode it is actually in.
   * The app opens in PRE-START and applies that mode's settings straight away:
   * the first thing you see is the tool set up for a countdown, not the
   * defaults waiting for the clock to move. */
  loadModes();
  MODE.now = 'pre';
  modeApplySet(MODE.sets.pre);
  // After the mode's settings, because these are the ones a mode must not
  // touch — applying them last is what makes that true in practice as well as
  // in principle.
  loadGlobals();
  buildPanels();
  applyProj();
  fillSelect($('selEvent'),
             APP.manifest.events.map(e => [e.eventId, `${e.venue.toUpperCase()} ${e.season}`]));
  wireBottomBar();
  wireMapGestures();
  wireTabs();
  wireRecBtn();
  sizeMap();
  new ResizeObserver(sizeMap).observe($('map'));

  const q = new URLSearchParams(location.search);
  APP.liveUrl = q.get('live') || load('liveUrl');

  // ?race=<id> opens one start directly; otherwise the newest in the index.
  const want = q.get('race');
  const race = want && APP.manifest.races.find(r => r.raceId === want);
  const target = race || APP.manifest.races[APP.manifest.races.length - 1];
  $('selEvent').value = target.bundle;
  syncDays(); $('selDay').value = target.day;
  syncStarts(); $('selStart').value = target.raceId;
  APP.defaultRace = target.raceId;

  await setTab(q.get('live') || q.get('tab') === 'live' ? 'live' : 'replay');
  requestAnimationFrame(loop);
}

const load = k => { try { return localStorage.getItem('seagull.' + k); } catch { return null; } };
const save = (k, v) => { try { localStorage.setItem('seagull.' + k, v); } catch {} };

/* Light or dark, for the whole player.
 *
 * The chrome is entirely CSS variables, so it is one attribute on the root; the
 * map is a canvas and has to be told. Switching also carries the water across —
 * pale labels on a pale sea is not a theme, it is a bug — unless the water
 * already suits, so a deliberate choice of white water in dark mode survives. */
const THEMES = ['dark', 'mid', 'light'];
const THEME_WATER = { dark: '#050506', mid: '#2b3a4a', light: '#e9eef4' };

function setTheme(name) {
  APP.theme = THEMES.includes(name) ? name : 'dark';
  document.documentElement.dataset.theme = APP.theme;
  save('theme', APP.theme);
  // Carry the water across unless it was chosen by hand.
  //
  // This used to compare MAP_INK.light against the theme, which worked while
  // there were two themes and they sat on opposite sides of the luma test.
  // Dark and mid are both dark-inked, so that test cannot tell them apart and
  // would leave mid on near-black water — the one thing it exists to avoid.
  // Comparing against the set of theme waters instead still leaves a hand-set
  // water alone, which was the point of the guard.
  const known = Object.values(THEME_WATER).map(h => h.toLowerCase());
  const cur = String(MAP_INK.bg || '').toLowerCase();
  if (!cur || known.includes(cur)) {
    setMapBg(THEME_WATER[APP.theme]);
    const c = document.getElementById('cTrack');
    if (c) c.style.background = MAP_INK.bg;
  }
}

/* DATA OVERLAY TRANSPARENCY (LOOK panel, below) — how see-through COURSE,
 * POTENTIAL THREATS and the boat readouts are. One CSS variable,
 * --overlayAlpha, is what css/app.css's --glassThin actually reads; each
 * theme block opens it on its own already-tuned default, and setting it here
 * writes an INLINE override on the root, which beats any :root[data-theme]
 * rule regardless of which theme is active — the same trick WATER uses to
 * survive a theme switch instead of resetting with it. Called with no
 * argument to read the live value (the inline override if there is one, else
 * whichever theme default is in effect), with one to set it. */
function overlayAlpha(v) {
  const root = document.documentElement;
  if (v != null) { root.style.setProperty('--overlayAlpha', v); return v; }
  const inline = root.style.getPropertyValue('--overlayAlpha');
  if (inline) return parseFloat(inline);
  const computed = parseFloat(getComputedStyle(root).getPropertyValue('--overlayAlpha'));
  return isFinite(computed) ? computed : 0.32;
}


/* ── tabs ───────────────────────────────────────────────────────────────── */

function wireTabs() {
  $('reopen').onclick = () => liveSetup();
  $('tabs').onclick = e => {
    const b = e.target.closest('button[data-tab]');
    if (b && b.dataset.tab !== APP.tab) setTab(b.dataset.tab);
  };
}

async function setTab(tab) {
  APP.tab = tab;
  document.body.classList.toggle('mode-live', tab === 'live');
  $('reopen').hidden = true;
  for (const b of $('tabs').children) b.classList.toggle('active', b.dataset.tab === tab);
  hideOverlay();

  if (APP.feed) { APP.feed.stop(); APP.feed = null; APP.rd = null; }
  recTeardown();

  if (tab === 'replay') {
    await openStart($('selStart').value || APP.defaultRace);
  } else if (APP.liveUrl) {
    await startLive(APP.liveUrl);
  } else {
    liveSetup();
  }
}

/* No socket configured yet, which is the honest state of this build. Rather
 * than an empty tab, offer the two ways forward: a real URL, or the mock feed
 * that exercises the same code path with a fake transport. */
function liveSetup(msg) {
  paintStatus();
  $('subtitle').textContent = 'no live feed connected';
  overlay('', 'LIVE FEED', (msg ? `<b style="color:var(--amber)">${esc(msg)}</b><br><br>` : '') +
    'Point this at a socket that speaks the protocol in the README, or run the ' +
    'mock feed — the whole live code path over a fake transport, fed from an ' +
    'archived race.',
    `<div class="row">
       <input type="text" id="liveUrl" placeholder="wss://host/race" value="${esc(load('liveUrl') || '')}">
       <button id="liveGo">CONNECT</button>
       <button id="liveMock" class="active">RUN MOCK</button>
     </div>`,
    // Closable: opening the LIVE tab to look at it is not the same as wanting
    // to connect something, and a sheet you cannot dismiss is a modal pretending
    // to be a page. Closing it leaves the CONNECT button on the map.
    true);
  $('liveGo').onclick = () => {
    const u = $('liveUrl').value.trim();
    if (!u) return;
    APP.liveUrl = u; save('liveUrl', u); hideOverlay(); startLive(u);
  };
  $('liveMock').onclick = () => { hideOverlay(); startLive('mock'); };
}

function overlay(cls, title, body, extra = '', closable = false) {
  const el = $('overlay');
  el.hidden = false;
  el.innerHTML =
    `<div class="sheet ${cls}">
       ${closable ? '<button class="x" id="sheetClose" title="close" aria-label="close">×</button>' : ''}
       <h3>${title}</h3><p>${body}</p>${extra}
     </div>`;
  $('reopen').hidden = true;
  if (closable) $('sheetClose').onclick = () => { hideOverlay(); $('reopen').hidden = false; };
}

function hideOverlay() { $('overlay').hidden = true; }


/* ── the archive picker ─────────────────────────────────────────────────── */

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const dayLabel = d => {
  const [y, m, dd] = d.split('-');
  return `${dd} ${MONTHS[+m - 1]} ${y}`;
};

function fillSelect(sel, pairs, value) {
  sel.innerHTML = pairs.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  if (value != null) sel.value = value;
}

const eventOf = id => APP.manifest.events.find(e => e.eventId === id);
const raceMeta = id => APP.manifest.races.find(r => r.raceId === id);

function syncDays() {
  const e = eventOf($('selEvent').value);
  fillSelect($('selDay'), e.days.map(d => [d.day, dayLabel(d.day)]));
}

function syncStarts() {
  const e = eventOf($('selEvent').value);
  const d = e.days.find(x => x.day === $('selDay').value) || e.days[0];
  fillSelect($('selStart'), d.races.map(id => {
    const r = raceMeta(id);
    return [id, `${r.clock} · ${r.label}${r.sessionType === 'practice' ? ' (practice)' : ''}`];
  }));
}


/* ── loading a race ─────────────────────────────────────────────────────── */

const BUNDLES = new Map();

/* The bundles are gzipped on disk because GitHub Pages will not serve a .gz
 * with Content-Encoding set — the browser gets raw bytes and unpacks them. */
async function fetchBundle(eventId) {
  if (BUNDLES.has(eventId)) return BUNDLES.get(eventId);
  const p = (async () => {
    const res = await fetch(`data/events/${eventId}.json.gz`);
    if (!res.ok) throw new Error(`${res.status} on ${eventId}`);
    if (typeof DecompressionStream === 'undefined')
      throw new Error('this browser cannot unpack gzip in the page');
    return await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).json();
  })();
  // Caching the promise is what stops two selects racing for the same bundle.
  // Caching a REJECTED promise is a different thing: one network blip would
  // make that event permanently unloadable for the life of the page, however
  // many times you picked it. Successes stay, failures are forgotten.
  p.catch(() => { if (BUNDLES.get(eventId) === p) BUNDLES.delete(eventId); });
  BUNDLES.set(eventId, p);
  return p;
}

/* Which race the user last asked for. Two overlapping loads finish in whatever
 * order the network gives them, and without this the slower one wins the map
 * while all three pickers name the faster. */
let OPEN_SEQ = 0;

async function openStart(raceId) {
  const meta = raceMeta(raceId);
  if (!meta) return;
  const seq = ++OPEN_SEQ;
  let bundle;
  try { bundle = await fetchBundle(meta.bundle); }
  catch (e) {
    if (seq === OPEN_SEQ) overlay('bad', 'BUNDLE MISSING',
      `Could not load <code>${esc(meta.bundle)}</code>: ${esc(e.message)}`);
    return;
  }
  if (seq !== OPEN_SEQ) return;                // a newer pick is already loading
  const race = bundle[raceId];
  if (!race) { overlay('bad', 'NOT IN BUNDLE', `${esc(raceId)} is not in ${esc(meta.bundle)}.`); return; }
  if (APP.tab !== 'replay') return;            // the tab changed while we loaded

  hideOverlay();
  if (APP.feed) APP.feed.stop();
  recTeardown();
  const feed = new ReplayFeed(race, { from: race.tRange ? race.tRange[0] : -150 });
  attach(feed);

  const teams = Object.keys(race.boats || {}).sort();
  setFocusList(teams);

  $('rSlider').min = feed.tMin;
  $('rSlider').max = feed.tMax;
  $('rSlider').value = feed.t;
  placeGunMark(feed.tMin, feed.tMax);
  $('subtitle').textContent =
    `${race.venue} ${race.season} · ${dayLabel(race.date)} · ${race.clock} · ${race.label}` +
    (race.sessionType === 'practice' ? ' · practice' : '');
  rebuild(true);
  feed.play();
  syncPlay();
  syncSpeed();
}

async function startLive(url) {
  if (APP.feed) APP.feed.stop();
  recTeardown();
  $('reopen').hidden = true;

  let opts = {};
  if (url === 'mock') {
    const id = $('selStart').value || APP.defaultRace;
    const race = (await fetchBundle(raceMeta(id).bundle))[id];
    opts.socket = () => new MockLiveSocket(race);
  }

  const feed = new LiveFeed(url, opts);
  attach(feed);
  $('subtitle').textContent = url === 'mock'
    ? 'mock live feed — the live code path, a fake transport'
    : url;

  // Teams are not known until boats report, so the list is filled from the
  // buffer and refilled while boats are still joining.
  let known = '';
  const watch = setInterval(() => {
    if (APP.feed !== feed) return clearInterval(watch);
    const key = feed.buffer.teams.join(',');
    if (key && key !== known) { known = key; setFocusList(feed.buffer.teams); }
  }, 1000);

  feed.start();
}

function setFocusList(teams) {
  fillSelect($('selFocus'), [['', 'NONE'], ...teams.map(t => [t, t])],
             teams.includes(APP.focus) ? APP.focus
             : (teams.includes('ITA') ? 'ITA' : teams[0]));
  APP.focus = $('selFocus').value || null;
}

function attach(feed) {
  APP.feed = feed;
  APP.rd = null;
  APP.rev = -1;
  feed.on('status', paintStatus);
  paintStatus();
}


/* ── the loop ───────────────────────────────────────────────────────────── */

function loop(wallMs) {
  const feed = APP.feed;
  if (feed) {
    const fresh = feed.poll(wallMs);
    if (fresh && wallMs - APP.builtAt > REBUILD_MS) rebuild();
    draw();
    // record.js's own clock, not the display's: it has to keep starting and
    // stopping on the race's actual timing even while feed.t is pinned back
    // by the scrubber, which is why this reads the feed and rd directly
    // rather than tDraw.
    recTick(feed, APP.rd);
  }
  requestAnimationFrame(loop);
}

/* Rebuild the race from everything received so far.
 *
 * `force` used to mean "build it again whether or not anything arrived", and
 * almost every caller passed it: a preset click, a quick-bar switch, a wheel
 * tick, every scrub of the slider. But buildRace() is a pure function of the
 * buffer, so the same samples give the same race — and behind it sat
 * findRatioCrossings(), which walks the entire pre-start at 0.25 s for every
 * boat. Settings do not change the race; they change what is DRAWN from it,
 * and drawing is draw()'s job. So the buffer revision is the only thing that
 * can make this work worth doing, and `force` now only covers the first build.
 */
function rebuild(force) {
  const feed = APP.feed;
  if (!feed || !feed.buffer.ready()) return;
  if (APP.rd && feed.buffer.rev === APP.rev) return;
  const t0 = performance.now();
  try {
    APP.rd = buildRace(feed.buffer.race(), { live: true });
    APP.rev = feed.buffer.rev;
    APP.builtAt = t0;
    APP.buildMs = performance.now() - t0;
    if (RATIO.on) findRatioCrossings(APP.rd);
  } catch (e) {
    // A bad frame must not take the tracker down mid-race. Keep the last good
    // race on screen, say so, and try again on the next batch of samples.
    console.error('rebuild failed', e);
    if (APP.feed) APP.feed.setStatus('error', `rebuild failed: ${e.message}`);
  }
}

/* The map is whatever the grid leaves over, so its height is read from the DOM
 * rather than declared, and handed to the renderer as opts.height. */
function sizeMap() {
  const h = Math.max(MAP_MIN_H, $('map').clientHeight);
  if (h !== APP.opts.height) { APP.opts.height = h; draw(); }
}

function draw() {
  const feed = APP.feed, rd = APP.rd;
  if (!rd) return;
  // Never ahead of the data, and a beat behind it — see SMOOTH.
  const tDraw = Math.max(rd.tMin, Math.min(feed.t - SMOOTH.lag, rd.tMax));

  // Where the two modes actually change hands. It happens here, on the time
  // being DRAWN, so the settings turn over on the same frame the picture does.
  // A switch repaints the menu and the bar — but only on the frame it switches,
  // which is once a race in each direction unless you are scrubbing.
  if (modeTick(tDraw)) { syncPanels(); paintBar(); syncRecentre(); }

  // The mode IS the start geometry. Before the gun the tool is about one line:
  // the wave, the laylines, the advantage curve and the fast point are all ways
  // of asking "where should I be at T+0". After it none of them mean anything,
  // and holding the start line in frame while the fleet sails away from it is
  // exactly the wrong picture — so they retire together and the viewport starts
  // following the boats.
  const racing = tDraw > 0;
  const startGeom = MODE.now === 'pre';
  FIT_BOATS_ONLY = !startGeom;
  const o = Object.assign({}, APP.opts, {
    focus: APP.focus,
    wave: APP.opts.wave && startGeom,
    laylines: APP.opts.laylines && startGeom,
    endLegs: END_LEGS.on && startGeom,
    // Start laylines retire with the rest of the start geometry: they are lines
    // to a line that stops existing at the gun.
    startLay: START_LAY.on && startGeom,
    // Z is a pre-start idea too. The pin is a place you wanted to be BEFORE the
    // gun; carrying it up the first beat would be carrying a stale decision.
    zOn: ZPT.on && startGeom,
    // The cone is a question about the line, so it retires with the line.
    // The Z ghost has to get through this gate too, independently of
    // CONE.on — it is Z's own working, not the boat's cone, and CONE off
    // must not also silence it while a pin is being placed (drawStartCone
    // itself decides which of the two actually draws).
    cone: (CONE.on || (ZPT.on && ZPT.p && !ZPT.locked)) && startGeom,
    /* On starboard, in the countdown: the projections stop carrying a ratio at
     * their tips. Worked out here rather than in the renderer because it is a
     * fact about the boat we are following, and the renderer is drawing all six
     * of them — it has no business deciding which one is ours. */
    /* The grid, and what it is turned to. Resolved here because the angle can
     * come off the wind sources or the focus boat, which are this file's to
     * know. The renderer is handed a screen-ready decision, not a policy. */
    grid: GRID.on,
    gridAng: (() => {
      if (!GRID.on) return 0;
      const brg = gridBearing(rd, tDraw, APP.focus);
      if (brg == null) return 0;
      // compass bearing -> screen angle, the same conversion the wind arrows use
      const rot = rd.frame.rot * 180 / Math.PI + viewRotDeg();
      return (brg - rot - 90) * D2R;
    })(),
    stbdApproach: startGeom && (() => {
      const tr = APP.focus && rd.tracks[APP.focus];
      const me = tr ? sampleAt(tr, tDraw) : null;
      return !!(me && !zOnPort(me));
    })(),
    // FOLLOW FLEET is the fleet fit, clamped to never zoom in tighter than
    // the start line while the start is still the subject. Past the gun the
    // clamp is exactly the wrong picture — holding a line the fleet is sailing
    // away from — so it drops and the fit is the boats alone.
    mode: APP.opts.mode === 'fleet' && startGeom ? 'auto' : APP.opts.mode,
  });

  try {
    // Before the frame, not inside it: the fast point and the advantage curve
    // are both read by the renderer and both come off this wind.
    // What the renderer was actually handed this frame. Kept because every
    // question of the form "why is that drawn / not drawn" is answered by it,
    // and reading it back beats re-deriving it and hoping the two agree.
    APP.lastOpts = o;
    if (o.laylines) refreshFastPoint(rd, tDraw, APP.focus);
    drawFrame($('cTrack'), rd, tDraw, o);
  } catch (e) {
    console.error('draw failed', e);
  }
  paintHud(rd, tDraw);
  renderCourseBox(rd, tDraw, APP.focus);
  renderThreats(rd, tDraw, APP.focus);
  paintWindSources(rd, tDraw);
  renderRatioNow(rd, tDraw, $('ratioNow'), $('ratioNowT'));
  // The fleet ratio is a pre-start reading and renderRatioNow already refuses
  // to print one after the gun — but the card stayed, holding a single line
  // saying there was nothing to show. Now that the readouts sit ON the map,
  // that line costs a piece of water, so the whole card goes with it.
  const ratioCard = $('ratioNow').closest('.card');
  if (ratioCard) ratioCard.hidden = tDraw >= 0;
  paintClock(feed, rd, tDraw);
}


/* ── readouts ───────────────────────────────────────────────────────────── */

const tLabel = t => `T${t < 0 ? '−' : '+'}${Math.abs(t).toFixed(1)}`;

function paintClock(feed, rd, tDraw) {
  $('clock').textContent = tLabel(feed.t);
  $('clock').classList.toggle('after', feed.t >= 0);
  /* The mode, not the clock. They agree unless you are holding one, and when
   * they disagree this is the only place on screen that says so — a held mode
   * with a running clock is exactly the state you can otherwise stare at for a
   * minute wondering why the wave is still drawn. */
  const ph = $('phase');
  ph.textContent = MODE_NAME[MODE.now] + (MODE.hold === 'auto' ? '' : ' · HELD');
  ph.classList.toggle('held', MODE.hold !== 'auto');
  ph.classList.toggle('pre', MODE.now === 'pre');
  ph.title = MODE.hold === 'auto'
    ? 'switches at the gun'
    : `held in ${MODE_NAME[MODE.now]} — the clock is not driving the mode`;
  // How far behind the clock the DATA is — not how far behind the map is
  // drawn, which is SMOOTH.lag and entirely our own doing.
  const lag = feed.t - rd.tMax;
  const el = $('lag');
  el.textContent = lag > 2.5 ? `LAG ${lag.toFixed(1)}s` : '';
  el.classList.toggle('bad', lag > 5);

  // LIVE's own transport. The window keeps growing as samples land, so its
  // min/max are read fresh every frame rather than set once like a replay's
  // fixed range — and the LIVE button says whether the clock is still riding
  // the wall clock or has been pulled back by a drag on the scrubber.
  if (feed.kind === 'live') {
    $('rSlider').min = feed.tMin;
    $('rSlider').max = feed.tMax;
    placeGunMark(feed.tMin, feed.tMax);
    const btn = $('rGoLive');
    btn.classList.toggle('tracking', feed.live);
    btn.textContent = feed.live ? 'LIVE' : 'GO LIVE';
  }
  if ((feed.seekable || feed.kind === 'live') && document.activeElement !== $('rSlider'))
    $('rSlider').value = feed.t;
  /* The build stamp beside the timings.
   *
   * "I refreshed and I cannot see the change" is the most expensive question in
   * a static site with no build step: the files on disk are right, the browser
   * is running something else, and nothing on screen says which. Now something
   * does — this is the same string as the ?v= on every script tag, read back
   * out of the page that actually loaded. If it is not the stamp you were sent,
   * the code is not the code you were sent. */
  $('buildMs').textContent = `${BUILD_ID} · ${APP.buildMs.toFixed(1)} ms · `
                           + `${feed.buffer.count} samples`;
}

/* The focus boat's own numbers, big enough to read from the back of a RIB. */
function paintHud(rd, t) {
  const team = APP.focus;
  const el = $('hud');
  if (!team || !rd.tracks[team]) {
    el.innerHTML = '<div class="nofocus">no boat selected</div>';
    return;
  }
  const s = sampleAt(rd.tracks[team], t);
  if (!s) {
    el.innerHTML = `<div class="nofocus">${team} — no position yet</div>`;
    return;
  }
  const cell = (k, val, sub) =>
    `<div class="cell"><span class="k">${k}</span><b>${val}</b><span class="u">${sub}</span></div>`;

  // Past the gun the ratio is answering a question nobody is asking any more.
  // The numbers that matter become the ones that matter for the rest of the
  // race: how fast, how fast you could be, and how far to the next mark.
  if (t >= 0) { el.innerHTML = raceHud(rd, team, s, t); return; }

  const d = displayRatio(rd, team, t);
  const r = ratioAt(rd, team, t);           // polar-derived, for TTL / TTK
  const dtl = rd.frame.dtl(s);
  const pct = rd.frame.linePct(s);
  // Past the line, time-to-line is zero and time-to-kill is the whole
  // countdown. Both are arithmetically true and neither is a number anyone
  // should steer by, so they read as dashes rather than as advice.
  const over = dtl <= 0;
  // Distance below the pin, along the line — which in this frame is straight
  // down the screen, because the frame rotates the line vertical with the
  // windward end up. Positive is past the pin and outside the line; negative
  // is up the line toward the boat end. Which end is the pin comes from the
  // race, so this reads the same whichever end it was.
  const pinPct = rd.pinEnd === 'windward' ? 100 : 0;
  const pinSign = rd.pinEnd === 'windward' ? 1 : -1;
  const belowPin = pct == null ? null
                 : (pct - pinPct) / 100 * rd.frame.lineLen * pinSign;
  const v = d ? d.value : null;
  const col = v == null ? 'var(--muted)'
            : !RATIO.on ? 'var(--ink)'
            : v > RATIO.target ? 'var(--red)' : 'var(--green)';
  const burn = v == null ? null : v - RATIO.target;

  el.innerHTML = `
    <div class="rel"><div class="who mine">${team}</div></div>
    <div class="big" style="color:${col}">
      <span class="k">RATIO ${d ? `<em>${d.source}</em>` : ''}</span>
      <b>${v == null ? '—' : v.toFixed(2)}</b>
      <span class="u">${burn == null ? '' :
        (burn > 0 ? `+${burn.toFixed(2)} over target` : `${burn.toFixed(2)} under target`)}</span>
    </div>
    <div class="cells">
      ${cell('TO KILL', over || !r || r.ttk == null ? '—' : r.ttk.toFixed(1),
             over ? 'over the line' : 's')}
      ${(() => {
        /* TTK to the boat (windward) end — a different run from TO KILL, which
         * aims at the nearest point. Amber when that end is slipping away. */
        const q = over ? null : ttkEnd(rd, t, team, 'wind');
        if (over || !q) return cell('TTK BOAT', '—', '');
        if (q.unreachable) return cell('TTK BOAT', '—', 'out of reach');
        const ink = q.ttk != null && q.ttk < 0 ? ' style="color:var(--amber)"' : '';
        return `<div class="cell"><span class="k">TTK BOAT</span>
          <b${ink}>${q.ttk.toFixed(1)}</b><span class="u">s · to top end</span></div>`;
      })()}
      ${cell('TO LINE', over || !r || r.ttl == null ? '—' : r.ttl.toFixed(1),
             over ? '' : 's needed')}
      ${cell('DTL', dtl == null ? '—' : dtl.toFixed(0), 'm to line')}
      ${cell('SOG', s.sog == null ? '—' : s.sog.toFixed(1), 'km/h')}
      ${cell('TWA', s.twa == null ? '—' : s.twa.toFixed(0) + '°', s.twa < 0 ? 'port' : 'starboard')}
      ${cell('BELOW PIN', belowPin == null ? '—' : Math.abs(belowPin).toFixed(0),
             belowPin == null ? '' : belowPin > 0 ? 'm past the pin' : 'm up the line')}
    </div>
    ${boundaryBlock(rd, team, t)}
    ${zBlock(rd, team, t)}`;
}

/* Z, in MY BOAT.
 *
 * Rendered whenever Z is on, dashes and all — the block appears and disappears
 * with the Z switch, which is a deliberate act, and never with the tack, which
 * is not. A readout that moved every time the boat turned would shuffle the
 * card under your eye in the last minute of a start.
 *
 * On starboard it says so in words rather than going blank. "—" reads as
 * broken; ON STARBOARD reads as the rule doing what it was told.
 */
function zBlock(rd, team, t) {
  if (!ZPT.on) return '';
  const z = zStateAt(rd, t, team);
  const state = !ZPT.p ? 'no pin' : ZPT.locked ? 'locked' : 'drag to place';
  if (!z) return `
    <div class="bnd z">
      <span class="k">Z <em>${state}</em></span>
      <div class="pair"><b>—</b><b>—</b></div>
      <div class="pair sub"><span>twa</span><span>s to Z</span></div>
    </div>`;

  if (!z.onPort) return `
    <div class="bnd z">
      <span class="k">Z <em>${state}</em></span>
      <div class="pair">
        <b style="color:var(--muted)">${z.twa == null ? '—' : `${z.twa > 0 ? '+' : ''}${z.twa.toFixed(0)}°`}</b>
        <b style="color:var(--muted)">—</b>
      </div>
      <div class="pair sub"><span>twa to Z</span><span>on starboard</span></div>
      ${(() => { const g = ZPT.locked ? null : z.geom; return !g ? '' : `
      <div class="pair trio">
        <b>${g.belowPin == null ? '—' : Math.abs(g.belowPin).toFixed(0)}</b>
        <b>${g.dtl == null ? '—' : Math.abs(g.dtl).toFixed(0)}</b>
        <b>${g.bnd == null ? '—' : g.bnd.toFixed(0)}</b>
      </div>
      <div class="pair trio sub">
        <span>m ${g.belowPin > 0 ? 'past' : 'up from'} pin</span>
        <span>m off line</span>
        <span>m to bnd 90°</span>
      </div>`; })()}
    </div>`;

  /* The placement row, while you are still placing it.
   *
   * These three are the working: how far past the pin, how far off the line,
   * how far to the boundary square. They are what you drag the pin AGAINST.
   * Once it is locked the spot is decided, the question becomes how to get
   * there, and three numbers about where it sits are three numbers in the way
   * of the ones that now matter. So they retire with the crosshairs on the map,
   * at the same moment and for the same reason — RESET brings both back. */
  const g = ZPT.locked ? null : z.geom;
  const trio = !g ? '' : `
      <div class="pair trio">
        <b>${g.belowPin == null ? '—' : Math.abs(g.belowPin).toFixed(0)}</b>
        <b>${g.dtl == null ? '—' : Math.abs(g.dtl).toFixed(0)}</b>
        <b>${g.bnd == null ? '—' : g.bnd.toFixed(0)}</b>
      </div>
      <div class="pair trio sub">
        <span>m ${g.belowPin > 0 ? 'past' : 'up from'} pin</span>
        <span>m off line</span>
        <span>m to bnd 90°</span>
      </div>`;
  const secs = z.secs == null ? '—' : z.secs.toFixed(1);
  const note = z.direct ? 'direct — no route'
             : z.turns ? `${z.routeM.toFixed(0)} m · ${z.turns} turn${z.turns > 1 ? 's' : ''}`
             : `${z.routeM.toFixed(0)} m`;
  /* Entry class off the SAME number the fleet column reads (zEntryClass on
   * ttkToZ / zLate — the accelerating run to the pin, not the route clock
   * above), so a boat never disagrees with itself between MY BOAT and the
   * fleet table. */
  const cls = zEntryClass({ ttk: z.ttkToZ, unreachable: z.zLate });
  const clsInk = cls === 'late' ? 'var(--red)' : cls === 'early' ? 'var(--amber)' : 'var(--green)';
  return `
    <div class="bnd z">
      <span class="k">Z <em>${state} · ${note}</em></span>
      <div class="pair trio big">
        <b style="color:var(--zink)">${z.twa == null ? '—'
          : `${z.twa > 0 ? '+' : ''}${z.twa.toFixed(0)}°`}</b>
        <b style="color:var(--zink)">${secs}</b>
        <b style="color:${z.ttkToZ == null ? 'var(--muted)' : clsInk}">${z.ttkToZ == null ? '—'
          : (z.ttkToZ > 0 ? '+' : '') + z.ttkToZ.toFixed(1)}</b>
      </div>
      <div class="pair trio sub">
        <span>twa · port</span><span>s to Z</span>
        <span>s to kill to Z${cls ? ` · <b style="color:${clsInk}">${cls.toUpperCase()}</b>` : ''}</span>
      </div>
      ${zArrival(z)}
      ${boatEndArrival(z)}
      ${trio}
    </div>`;
}

/* TTK and ratio AT Z, on arrival.
 *
 * Coloured the same way the boundary pair is, and for the same reason: at a
 * spot you are sailing to the question is binary — can you still make the line
 * on the gun from there. A negative TTK answers no, and colouring it against
 * the ratio TARGET instead would call it green while it says the opposite.
 */
function zArrival(z) {
  const a = z && z.atZ;
  const col = !a || a.ttk == null ? 'var(--muted)'
            : a.ttk < 0 ? 'var(--red)' : 'var(--green)';
  const note = a && z.ttlToZ != null ? `in ${z.ttlToZ.toFixed(1)}s` : (z && z.zWhy) || '';
  return `
      <div class="pair k k2" style="margin-top:9px">
        <span>TTK AT Z <em>${note}</em></span><span>RATIO AT Z</span>
      </div>
      <div class="pair">
        <b style="color:${col}">${!a || a.ttk == null ? '—'
          : (a.ttk > 0 ? '+' : '') + a.ttk.toFixed(1)}</b>
        <b style="color:${col}">${!a || a.ratio == null ? '—' : a.ratio.toFixed(2)}</b>
      </div>
      <div class="pair sub"><span>s to kill on arrival</span><span>ratio on arrival</span></div>`;
}

/* Early or late TO THE BOAT END, holding Z TARGET RATIO from Z onward — the
 * question a boat-end approach is actually FOR. Same LATE/EARLY vocabulary
 * as TTK TO Z (zEntryClass, the same ZPT.lateUnder/earlyOver knobs), so
 * moving Z and reading this pair is the whole workflow: drag the pin, watch
 * whether the boat end reads LATE or EARLY, drop it once it reads on time. */
function boatEndArrival(z) {
  const a = z && z.toBoatEnd;
  if (!a && !(z && z.toBoatEndWhy)) return '';
  const cls = zEntryClass({ ttk: a ? a.ttk : null, unreachable: !a });
  const ink = cls === 'late' ? 'var(--red)' : cls === 'early' ? 'var(--amber)' : 'var(--green)';
  return `
      <div class="pair k k2" style="margin-top:9px">
        <span>TTK TO BOAT END</span><span>RATIO TO BOAT END</span>
      </div>
      <div class="pair">
        <b style="color:${a ? ink : 'var(--muted)'}">${!a ? '—'
          : (a.ttk > 0 ? '+' : '') + a.ttk.toFixed(1)}</b>
        <b style="color:${a ? ink : 'var(--muted)'}">${!a || a.ratio == null ? '—' : a.ratio.toFixed(2)}</b>
      </div>
      <div class="pair sub">
        <span>${a ? `<b style="color:${ink}">${cls.toUpperCase()}</b> for the boat end`
                   : (z.toBoatEndWhy || '')}</span>
        <span>time left over ${a ? 'wind + distance' : 'the leg'}</span>
      </div>`;
}

/* The boundary outlook, under the boat's own numbers.
 *
 * Always rendered pre-gun, dashes and all. A block that appeared and vanished
 * with the tack would shuffle everything above it twice a lap, and a readout
 * that moves under your eye in the last minute of a start is worse than one
 * that sometimes says nothing — the dashes carry the reason instead.
 */
function boundaryBlock(rd, team, t) {
  const o = boundaryOutlook(rd, team, t) || {};
  const has = o.ratio != null || o.ttk != null;
  /* Coloured by whether you will be LATE, not against the ratio target.
   *
   * The target comparison is the right rule for the live ratio, where the
   * question is how much time you still have to burn. It is the wrong rule
   * here: at the boundary the question is binary — from that point, at that
   * time, can you still make the line on the gun. A ttk of −8.5 s answers no,
   * and colouring it green because 0.27 sits under a target of 1.80 would say
   * the opposite of what the number means.
   */
  const col = o.ttk == null ? 'var(--muted)'
            : o.ttk < 0 ? 'var(--red)' : 'var(--green)';
  // The time only when there is something for it to be the time OF. A "in
  // 277s" beside two dashes is a number explaining nothing.
  const when = has && o.secs != null
    ? `in ${o.secs.toFixed(1)}s · ${o.distM.toFixed(0)} m`
    : (o.why || '');
  return `
    <div class="bnd">
      <span class="k">TTK / RATIO AT BOUNDARY <em>${when}</em></span>
      <div class="pair">
        <b style="color:${col}">${o.ttk == null ? '—'
            : (o.ttk > 0 ? '+' : '') + o.ttk.toFixed(1)}</b>
        <b style="color:${col}">${o.ratio == null ? '—' : o.ratio.toFixed(2)}</b>
      </div>
      <div class="pair sub"><span>s to kill</span><span>ratio</span></div>
    </div>
    ${lastTackBlock(rd, team, t)}`;
}

/* How long this course can still be held. One number, because it is one
 * decision. */
function lastTackBlock(rd, team, t) {
  const o = lastTackAt(rd, team, t) || {};
  let big, col, sub;
  if (o.past) {
    big = 'NOW'; col = 'var(--red)';
    sub = `already through ${LAST_TACK.ratio.toFixed(2)}`;
  } else if (o.secs != null) {
    big = o.secs.toFixed(1);
    col = o.secs < 5 ? 'var(--amber)' : 'var(--green)';
    sub = 's before you cannot make the line';
  } else {
    big = '—'; col = 'var(--muted)'; sub = o.why || '';
  }
  // Beside it, the pin-end loop: a fact about the course rather than about the
  // boat, but it belongs here because it is the other half of the same
  // question — how much time the thing you are about to do will cost.
  const ob = outAndBack(rd) || {};
  const obBig = ob.secs != null ? ob.secs.toFixed(1) : '—';
  const obSub = ob.secs != null
    ? `s from the pin · +${OUT_BACK.tackLossS}s tack`
    : (ob.why || '');

  return `
    <div class="bnd">
      <!-- No "now" ratio beside LAST TACK. The headline above prefers the
           boat's OWN onboard channel where it exists, and this countdown can
           only be run off the computed one; printing both would put two
           different numbers for the same quantity in one card. -->
      <!-- A caption per column: these are two unrelated numbers sharing a row,
           unlike the block above where one caption covers a pair. -->
      <div class="pair k k2">
        <span>LAST TACK <em>${LAST_TACK.ratio.toFixed(2)} ratio</em></span>
        <span>OUT AND BACK <em>${
          ob.distM != null ? `${ob.distM.toFixed(0)} m` : ''}</em></span>
      </div>
      <div class="pair">
        <b style="color:${col}">${big}</b>
        <b style="color:var(--ink)">${obBig}</b>
      </div>
      <div class="pair sub"><span>${sub}</span><span>${obSub}</span></div>
    </div>`;
}

/* The race half of MY BOAT. Speed against the polar is the honest headline once
 * the start is over: it is the one number that says whether the boat is being
 * sailed well, independent of where it happens to be on the course.
 *
 * It goes as far as the data goes. The archived bundles stop at T+90, so the
 * distance to Mark 1 is the last course number they can answer — a fuller
 * course needs marks the ingest does not currently carry. See the README. */


/* ── the basemap ────────────────────────────────────────────────────────────
 *
 * OpenStreetMap tiles under the course, so the racetrack sits somewhere in the
 * world rather than in a black void.
 *
 * The awkward part is that this tool does not work in latitude and longitude.
 * Everything is in a local metric frame rotated so the start line stands
 * vertical, and tiles are Web Mercator, north up. Rather than convert the
 * course into Mercator, the tiles are drawn under a canvas transform that maps
 * Mercator pixels onto the map: one linear map, built by pushing the two
 * Mercator basis vectors through the same chain every mark goes through —
 * pixels to metres, metres east/north into the rotated frame, rotated frame to
 * screen. Whatever that chain does, the tiles do too, including the rotation,
 * so they cannot drift out of register with the course by construction.
 *
 * Tiles are cached, capped and drawn only when they have arrived; a tile that
 * is still loading simply is not drawn, and its arrival schedules one repaint.
 * OSM's tile policy asks for modest use and attribution, so both are here: the
 * caps below, and the credit drawn in the corner whenever the layer is on.
 */
const TILE_PX = 256;
const TILE_MAX_PER_FRAME = 64;     // a viewport of tiles, not a continent
const TILE_MAX_INFLIGHT = 6;
const TILE_CACHE_MAX = 400;

const TILES = new Map();           // "z/x/y" -> Image (with .ok once loaded)
let tilesInFlight = 0;
let tileRepaint = null;

function tileAt(z, x, y) {
  const key = `${z}/${x}/${y}`;
  const hit = TILES.get(key);
  if (hit) return hit;
  if (tilesInFlight >= TILE_MAX_INFLIGHT) return null;
  // Oldest out first. A Map keeps insertion order, so the first key is the
  // least recently added — good enough for a viewport-sized working set.
  if (TILES.size > TILE_CACHE_MAX) TILES.delete(TILES.keys().next().value);
  const img = new Image();
  img.ok = false;
  tilesInFlight++;
  img.onload = () => {
    img.ok = true;
    tilesInFlight--;
    // One repaint for a burst of arrivals rather than one each — and a repaint
    // is draw(), not rebuild(). rebuild() re-runs the whole race builder over
    // the buffer and does not draw anything; a picture arriving under the
    // course cannot have changed a single sample.
    if (!tileRepaint) tileRepaint = setTimeout(() => {
      tileRepaint = null;
      if (APP.rd) draw();
    }, 90);
  };
  /* A tile that failed stays in the cache as a permanent miss. Deleting it
   * meant the very next frame asked for it again, and at sixty frames a second
   * with six slots that is a few hundred requests a second at whatever is
   * refusing them — offline, or a tile the server does not have. It is marked
   * dead instead, and nothing retries it until the cache rolls over. */
  img.onerror = () => { tilesInFlight--; img.ok = false; img.dead = true; };
  img.src = basemapStyle().url(z, x, y);
  TILES.set(key, img);
  return img;
}

/* Rotated frame back out to latitude and longitude — the inverse of the frame's
 * own rp(), which is why the frame now carries its origin. */
function rotToLL(f, rx, ry) {
  const cos = Math.cos(f.rot), sin = Math.sin(f.rot);
  const x = rx * cos + ry * sin;          // undo the rotation
  const y = -rx * sin + ry * cos;
  const lat = f.cLat + y / (D2R * RE);
  const lon = f.cLon + x / (D2R * RE * Math.cos(f.cLat * D2R));
  return { lat, lon };
}

const mercX = (lon, z) => (lon + 180) / 360 * Math.pow(2, z) * TILE_PX;
const mercY = (lat, z) => {
  const s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * D2R);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, z) * TILE_PX;
};

function drawBasemap(ctx, rd, v, W, H) {
  if (!BASEMAP.on || !rd || !rd.frame || rd.frame.cLat == null) return;
  const f = rd.frame;
  const style = basemapStyle();
  const c = rotToLL(f, v.cx, v.cy);

  // Pick the zoom whose tile pixels are closest to the map's own pixels, so a
  // tile is drawn at roughly 1:1 rather than smeared or downsampled.
  const mppMap = 1 / v.scale;                                  // metres/pixel
  const world = 156543.03392 * Math.cos(c.lat * D2R);          // m/px at zoom 0
  let z = Math.round(Math.log2(world / mppMap));
  z = Math.max(1, Math.min(style.max, z));
  const mppTile = world / Math.pow(2, z);

  // The linear map from Mercator pixels to screen pixels, built by pushing the
  // two basis vectors through the same chain the course goes through. Mercator
  // y grows southward, hence the negated north component.
  const basis = (dx, dy) => {
    const p = f.r(dx * mppTile, -dy * mppTile);
    // …and then through the view rotation, the same one the point transform
    // applies, or the world under the course stays put while the course turns.
    const q = dirToScreen(p.rx, p.ry);
    return { x: q.dx * v.scale, y: q.dy * v.scale };
  };
  const bx = basis(1, 0), by = basis(0, 1);
  const a = bx.x, b = bx.y, cc = by.x, d = by.y;

  const det = a * d - b * cc;
  if (!isFinite(det) || Math.abs(det) < 1e-12) return;
  const inv = (sx, sy) => ({ x: (d * sx - cc * sy) / det, y: (-b * sx + a * sy) / det });

  // Which tiles does the screen actually cover? Corners, back through the
  // inverse, into Mercator pixels.
  const mx = mercX(c.lon, z), my = mercY(c.lat, z);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [sx, sy] of [[-W / 2, -H / 2], [W / 2, -H / 2], [-W / 2, H / 2], [W / 2, H / 2]]) {
    const q = inv(sx, sy);
    x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x);
    y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
  }
  const n = Math.pow(2, z);
  const tx0 = Math.floor((mx + x0) / TILE_PX), tx1 = Math.floor((mx + x1) / TILE_PX);
  const ty0 = Math.max(0, Math.floor((my + y0) / TILE_PX));
  const ty1 = Math.min(n - 1, Math.floor((my + y1) / TILE_PX));
  if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > TILE_MAX_PER_FRAME) return;

  ctx.save();
  ctx.globalAlpha = BASEMAP.alpha;
  ctx.translate(W / 2, H / 2);
  ctx.transform(a, b, cc, d, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const wrapped = ((tx % n) + n) % n;                 // the world is round
      const img = tileAt(z, wrapped, ty);
      if (!img || !img.ok) continue;
      // A hair of overdraw, or the seams between tiles show as hairlines once
      // the transform puts them on fractional pixels.
      ctx.drawImage(img, tx * TILE_PX - mx - 0.5, ty * TILE_PX - my - 0.5,
                    TILE_PX + 1, TILE_PX + 1);
    }
  }
  ctx.restore();

  // Attribution is a condition of using the tiles, not a nicety.
  ctx.save();
  ctx.font = '10px "Share Tech Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(230,238,248,0.55)';
  ctx.fillText(style.credit, W - 8, H - 6);
  ctx.restore();
}

/* ── the next leg ───────────────────────────────────────────────────────────
 *
 * On a stadium course the beat is not a free choice of when to tack — it is a
 * corridor. You sail your target angle until the boundary stops you, tack, sail
 * across, tack again, and the only real decision is when you leave the corridor
 * for the layline. So the useful picture of the next leg is exactly that: the
 * track you would sail if you bounced boundary to boundary at your target angle
 * and took the layline when it came.
 *
 * It is a route, not a prediction of the future. Nothing here knows about the
 * wind shifting, the other boats, or what you will actually decide. What it
 * does say, honestly, is the shape of the leg: how many tacks it takes, where
 * they fall, which side runs out first, and how far off the corner the layline
 * actually is. That is the thing you cannot see from a layline pair alone.
 *
 * Built from the same pieces as everything else: the boat's leg for which mark,
 * the settled wind, the polar's target angles (or the boat's own logged target
 * where the polar has nothing for the configuration), and the boundary polygon
 * — which is the INSIDE edge of the zone, the last water you may sail, so it is
 * the right thing to bounce off.
 */
/* The route's own wind. It is drawn from the boat's masthead damped over ten
 * seconds by default, not the race average: a route is about the water in front
 * of you now, and a shift the boat is already in should bend it. Ten seconds is
 * short enough to follow a real shift and long enough that the corridor does not
 * shimmer — and the same fault gate and settling apply, so a bad window walks it
 * back to the race TWD instead of throwing the whole corridor sideways. */
const ROUTE = { on: false, next: false, source: 'boat', dampSec: 10 };
/* Every turning mark on these courses is rounded to port — a left turn — which
 * puts you on starboard coming out of it. Gates are the exception and set their
 * own tack per mark, because there the side you round IS the decision. */
/* Which tack you leave a mark on, from the direction you turn round it.
 *
 * There is no fixed answer — it depends on the leg you are joining, which is
 * what a hardcoded rule kept getting wrong. Round the LEFT-hand mark of the top
 * gate and you bear away to the left onto starboard; round the left-hand mark
 * of the BOTTOM gate and the same left turn heads you up onto port. Same turn,
 * opposite tack, because one rounding bears away and the other heads up.
 *
 * So it is derived instead. The new leg has two possible headings — twd ∓ θ,
 * one per tack — and the one you actually reach is the FIRST of them you meet
 * turning the way the rounding takes you. Measure how far you would have to
 * turn that way to reach each, and take the shorter.
 */
function exitTack(approachBrg, twd, theta, turnLeft) {
  let best = null, bestTurn = Infinity;
  for (const tk of [1, -1]) {
    const exit = twd - tk * theta;                    // heading = twd − tack·θ
    const turn = turnLeft ? ((approachBrg - exit) % 360 + 360) % 360
                          : ((exit - approachBrg) % 360 + 360) % 360;
    if (turn < bestTurn) { bestTurn = turn; best = tk; }
  }
  return best;
}

const MARK_ROUND_TACK = 1;          // +1 starboard, -1 port
const ROUTE_MAX_TACKS = 40;
const ROUTE_EPS = 1e-6;

/* Ray from p along d against the segment a-b. Returns the distance along the
 * ray, or null. Solving p + t*d = a + s*e and requiring the hit to be ahead of
 * the ray and inside the segment. */
function rayHitSeg(p, d, a, b) {
  const ex = b.rx - a.rx, ey = b.ry - a.ry;
  const den = d.rx * ey - d.ry * ex;
  if (Math.abs(den) < ROUTE_EPS) return null;      // parallel
  const wx = a.rx - p.rx, wy = a.ry - p.ry;
  const t = (wx * ey - ex * wy) / den;
  const s = (wx * d.ry - d.rx * wy) / den;
  return t > ROUTE_EPS && s >= 0 && s <= 1 ? t : null;
}

/* Same, but against the infinite line through a with direction e — which is
 * what a layline is: it runs both ways from the mark. */
function rayHitLine(p, d, a, e) {
  const den = d.rx * e.ry - d.ry * e.rx;
  if (Math.abs(den) < ROUTE_EPS) return null;
  const wx = a.rx - p.rx, wy = a.ry - p.ry;
  const t = (wx * e.ry - e.rx * wy) / den;
  return t > ROUTE_EPS ? t : null;
}

/* The course boundary as a list of segments, deduped, in the rotated frame. */
function boundarySegs(rd) {
  /* The FAR edge of the boundary band, which is the one a boat turns at.
   *
   * The course file stores the INSIDE edge — that is what BOUNDARY BAND's own
   * hint says — and the band is shaded outwards from it. Everything that ends
   * at the boundary took the stored polygon, so the laylines, the next-leg
   * bounce and out-and-back all stopped a full band short, finishing on the
   * inner edge with the shading still to run. At the default 80 m that is 80 m
   * of missing course on every one of them.
   *
   * Cached per band width as well as per race, so moving the BOUNDARY BAND
   * slider re-derives it instead of serving the previous width's ring. */
  const band = BOUNDARY_BAND.m > 0 ? BOUNDARY_BAND.m : 0;
  if (rd._bndSegs && rd._bndBand === band) return rd._bndSegs;
  const segs = [];
  for (const [name, pts] of Object.entries((rd.frame && rd.frame.limits) || {})) {
    if (name.replace(/ \d+$/, '') !== 'Boundary') continue;
    // offsetPoly already dedupes and unwraps a repeated closing point, and
    // hands back the mitred outer ring — the same one drawLimits strokes, so
    // the geometry and the picture cannot drift apart.
    // The band is now shaded INSIDE the stored polygon, so the stored polygon
    // is itself the outer limit — the line a boat turns at — and no offset is
    // wanted here. Kept as a cleaned copy of the file's own points.
    let use = null;
    if (!use) {
      use = [];
      for (const p of pts) {
        const q = use[use.length - 1];
        if (!q || Math.hypot(p.rx - q.rx, p.ry - q.ry) > 1e-6) use.push(p);
      }
      while (use.length > 1 &&
             Math.hypot(use[0].rx - use[use.length - 1].rx,
                        use[0].ry - use[use.length - 1].ry) <= 1e-6) use.pop();
    }
    for (let i = 0; i < use.length; i++)
      segs.push([use[i], use[(i + 1) % use.length]]);
  }
  rd._bndBand = band;
  return (rd._bndSegs = segs);
}

/* Even-odd crossing count against the course boundary — is p actually inside
 * it, not just somewhere on the course. Used wherever "inside the box" has to
 * be an actual yes/no rather than an assumption: the pre-start run-out below
 * (a pin the boundary already contains, or a boat still sailing in from
 * outside it, get two different honest answers, not one geometry pretending
 * to be the other), and the boat's own cone, which has nothing useful to say
 * about a reach to the line from water that is not the pre-start box at all. */
function insideBoundary(rd, p) {
  const segs = boundarySegs(rd);
  if (!segs.length || !p) return null;
  let inside = false;
  for (const [a, b] of segs) {
    if ((a.ry > p.ry) !== (b.ry > p.ry)) {
      const x = a.rx + (p.ry - a.ry) / (b.ry - a.ry) * (b.rx - a.rx);
      if (x > p.rx) inside = !inside;
    }
  }
  return inside;
}

/* Unit vector for a compass heading, in the rotated frame. */
const headVec = (rd, deg) => rd.frame.r(Math.sin(deg * D2R), Math.cos(deg * D2R));

/* The boat's own target angles, as a curve against wind speed.
 *
 * The harvest carries TARG_TWA_deg beside TWS at every sample, which means each
 * race already contains this boat's target angle paired with the wind it was
 * measured in — hundreds of readings of it, in both modes, from the boat's own
 * onboard tables. That is a better answer than the polar: it is what this boat
 * was actually being asked to sail, in this configuration, on this day.
 *
 * A single sample is not enough, because targTwa only ever describes whatever
 * the boat is doing at that instant. Taken across the race the two modes
 * separate cleanly — under 90 degrees is the beat, over it is the run — so both
 * curves fall out of the same channel. Read back by taking the MEDIAN of every
 * reading within a few km/h of the wind you have now, which is robust to the
 * handful of samples logged mid-manoeuvre, and widened until it has enough to
 * be worth a median at all.
 *
 * Built once per boat per race and cached. The polar stands in only where the
 * harvest carried no targets — the 2024-25 events, and any race predating the
 * channel being added.
 */
const TARGET_TWS_WINDOW = 3;      // km/h either side, to start with
const TARGET_MIN_SAMPLES = 12;

function boatTargets(rd, team) {
  rd._targ = rd._targ || {};
  if (rd._targ[team]) return rd._targ[team];
  const tr = rd.tracks[team];
  const up = [], dn = [], upV = [], dnV = [];
  if (tr && tr.raw.targTwa) {
    for (let i = 0; i < tr.n; i++) {
      const a = tr.raw.targTwa[i], s = tr.raw.tws[i];
      if (a == null || s == null || !(s > 0)) continue;
      const m = Math.abs(a);
      if (!(m > 5 && m < 175)) continue;
      (m < 90 ? up : dn).push([s, m]);
      // TARG_BOAT_SPEED rides along beside the angle, so the same channel that
      // says what to steer says how fast it goes — which is what turns a
      // distance on the map into a time on the clock.
      const v = tr.raw.targSog ? tr.raw.targSog[i] : null;
      if (v != null && v > 0) (m < 90 ? upV : dnV).push([s, v]);
    }
  }
  const byTws = (a, b) => a[0] - b[0];
  up.sort(byTws); dn.sort(byTws); upV.sort(byTws); dnV.sort(byTws);
  return (rd._targ[team] = { up, dn, upV, dnV });
}

function targetAt(rows, tws) {
  if (!rows.length) return null;
  if (tws == null) tws = rows[rows.length >> 1][0];
  for (let w = TARGET_TWS_WINDOW; w <= 40; w *= 2) {
    const hit = [];
    for (const [s, a] of rows) if (Math.abs(s - tws) <= w) hit.push(a);
    if (hit.length >= TARGET_MIN_SAMPLES) {
      hit.sort((a, b) => a - b);
      return hit[hit.length >> 1];
    }
  }
  const all = rows.map(r => r[1]).sort((a, b) => a - b);
  return all[all.length >> 1];
}

/* The two target angles, in degrees off the wind, for the wind speed the boat
 * is reading now. The boat's own logged targets first; the polar only where the
 * harvest carried none. */
function nextLegAngles(rd, tws, boat, team) {
  const tab = team ? boatTargets(rd, team) : { up: [], dn: [], upV: [], dnV: [] };
  let a = targetAt(tab.up, tws);
  let b = targetAt(tab.dn, tws);
  const upV = targetAt(tab.upV || [], tws), dnV = targetAt(tab.dnV || [], tws);
  let from = a != null && b != null ? 'boat' : 'polar';
  if (a == null) { const p = polarTarget(rd.polar, tws, true);  a = p && p.twa; }
  if (b == null) { const p = polarTarget(rd.polar, tws, false); b = p && p.twa; }
  const logged = boat && boat.targTwa != null ? Math.abs(boat.targTwa) : null;
  if (a == null && logged != null && logged < 90) a = logged;
  if (b == null && logged != null && logged >= 90) b = logged;
  /* The layline trim, applied HERE — the one place the route, the next-leg
   * route and the laylines all read their angles from. Applying it further
   * downstream would move the dashed lines and leave the route where it was,
   * and the whole point of the two sharing a bearing and a threshold was that
   * the route's last stretch into a mark lies along that mark's layline. The
   * speeds are untouched: the trim corrects a bad angle, not a bad speed. */
  if (typeof trimTwa === 'function') { a = trimTwa(a, true); b = trimTwa(b, false); }

  /* Target SPEEDS have the same fallback the angles do, and for the same
   * reason. TARG_BOAT_SPEED is only logged beside an upwind target angle once
   * the boat is sailing upwind, so before the gun — where everyone is reaching
   * at ninety-odd degrees — the upwind bucket is empty and there is no speed to
   * turn the first board of the next leg into seconds. That is exactly when M1
   * EXIT is the number on the screen, so it fell to a dash the whole pre-start.
   * The polar knows the answer at the angle already chosen; use it. */
  let uv = upV, dv = dnV;
  if (typeof polarSpeed === 'function') {
    if (!(uv > 0) && a != null) { const v = polarSpeed(rd.polar, a, tws); if (v > 0) uv = v; }
    if (!(dv > 0) && b != null) { const v = polarSpeed(rd.polar, b, tws); if (v > 0) dv = v; }
  }
  return { up: a, dn: b, upV: uv, dnV: dv, from };
}

/* One leg of the route: from p to mark, bouncing off the boundary.
 *
 * `opts.approach` is the bearing of the LEG into this mark, and passing it is
 * what makes the route and the laylines agree. Both now decide beat-or-run from
 * the same bearing and pick the angle by the same test, so the route's last
 * stretch into a mark lies exactly along that mark's layline instead of a few
 * degrees off it — or, where the two rules disagreed about the mode, a hundred
 * degrees off it. Without an approach it falls back to the bearing from here,
 * which is all a course with no element order can offer.
 *
 * `opts.forceTack` keeps the tack it was handed instead of choosing the one
 * that gains, so the caller can ask "and what if I went the other way".
 *
 * It also reports `firstEnd`: what stops the FIRST board — 'BOUNDARY' when the
 * water runs out, 'LAYLINE' when you can turn and lay from there, 'MARK' when
 * the board simply arrives. That one word is the whole of M1 EXIT and the whole
 * of OPEN COURSE, and taking it from here rather than re-deriving it elsewhere
 * is what makes those two numbers agree with the route drawn on the map.
 */
function bounceLeg(rd, p, mark, twd, ang, tack0, opts = {}) {
  const out = [];
  let firstEnd = null;
  const note = w => { if (firstEnd == null) firstEnd = w; };
  const segs = boundarySegs(rd);
  const brg = opts.approach != null ? opts.approach
            : rd.frame.bearingFromRot(mark.rx - p.rx, mark.ry - p.ry);
  let off = Math.abs(((twd - brg) % 360 + 360) % 360);
  if (off > 180) off = 360 - off;

  const up = ang.up, dn = ang.dn;
  if (up == null || dn == null) { out.push(mark); return { pts: out, tack: tack0, firstEnd: 'MARK' }; }

  /* Can the mark be laid from here in one go?
   *
   * Two things both have to hold, and the second is the one that makes this a
   * stadium course rather than open water. The mark has to bear at an angle you
   * would sail — inside the target angles, so neither pinching nor sailing
   * dead downwind — AND the straight line to it has to stay in the water. A
   * boundary across that line is exactly why you tack: not because the angle is
   * wrong, but because the course runs out first.
   *
   * Leave the second test out and almost everything is a fetch, because the
   * band between the upwind and downwind targets is nearly ninety degrees wide
   * and a mark rarely sits outside it. That is the difference between a route
   * and a rhumb line. */
  const canFetch = (from, tk) => {
    const brgM = rd.frame.bearingFromRot(mark.rx - from.rx, mark.ry - from.ry);
    // Signed TWA of the mark: negative is starboard side of the wind, positive
    // port, matching heading = twd − tack*theta.
    const sig = ((brgM - twd) % 360 + 540) % 360 - 180;
    const o = Math.abs(sig);
    if (o < up || o > dn) return false;
    /* And it has to be on the tack you are actually on. A mark bearing at a
     * perfectly sailable ANGLE but on the other side of the wind is a gybe
     * away, not a fetch — you cannot reach it without turning. Leaving this
     * out is what let a leg leave a gate on a forced starboard exit and then
     * draw a single straight line to a mark that was only layable on port:
     * one segment, no turn, and so no time-to-first-gybe to put on the map. */
    if (tk != null && sig * -tk < 0) return false;
    const dx = mark.rx - from.rx, dy = mark.ry - from.ry;
    const L = Math.hypot(dx, dy);
    if (!(L > 1)) return true;
    const dir = { rx: dx / L, ry: dy / L };
    for (const [a, b] of segs) {
      const h = rayHitSeg(from, dir, a, b);
      if (h != null && h < L - 1) return false;      // the water runs out first
    }
    return true;
  };
  // Held to the handed tack only when the caller insists on it; otherwise the
  // tack is still up for grabs below, so either side of the wind counts.
  if (canFetch(p, opts.forceTack ? tack0 : null)) {
    out.push(mark); return { pts: out, tack: tack0, firstEnd: 'MARK' };
  }

  // The same test the laylines use, on the same bearing, so the same number
  // comes out of both.
  const theta = off < 90 ? up : dn;
  let tack = tack0;
  // Start on the tack that actually gains on the mark — unless the caller is
  // deliberately asking for the other one.
  const gains = tk => {
    const d = headVec(rd, twd - tk * theta);
    return d.rx * (mark.rx - p.rx) + d.ry * (mark.ry - p.ry);
  };
  if (!opts.forceTack && gains(tack) < gains(-tack)) tack = -tack;

  let cur = { rx: p.rx, ry: p.ry };
  for (let i = 0; i < ROUTE_MAX_TACKS; i++) {
    // Fetchable from here? Then sail it, and no more turns are needed. This is
    // also what stops the corridor spinning: the mode comes from the leg, so
    // from a position the leg's mode does not suit — already past the mark, or
    // well off to one side — sailing the leg's angle need never converge.
    if (canFetch(cur, tack)) { out.push(mark); note('MARK'); return { pts: out, tack, firstEnd }; }

    const d = headVec(rd, twd - tack * theta);
    const dOther = headVec(rd, twd + tack * theta);

    // Where this tack crosses the layline for the OTHER tack — the point you
    // can tack and lay the mark from.
    let tLay = rayHitLine(cur, d, mark, dOther);
    if (tLay != null) {
      const q = { rx: cur.rx + d.rx * tLay, ry: cur.ry + d.ry * tLay };
      // and only if the mark is then AHEAD on that tack, not behind you
      if ((mark.rx - q.rx) * dOther.rx + (mark.ry - q.ry) * dOther.ry <= 0) tLay = null;
    }

    let tBnd = null;
    for (const [a, b] of segs) {
      const h = rayHitSeg(cur, d, a, b);
      if (h != null && (tBnd == null || h < tBnd)) tBnd = h;
    }

    if (tLay != null && (tBnd == null || tLay <= tBnd)) {
      out.push({ rx: cur.rx + d.rx * tLay, ry: cur.ry + d.ry * tLay });
      out.push(mark);
      note('LAYLINE');
      return { pts: out, tack: -tack, firstEnd };
    }
    if (tBnd == null) { out.push(mark); note('MARK'); return { pts: out, tack, firstEnd }; }

    // Stop a whisker short, so the next ray starts inside the water rather than
    // exactly on the edge where it would re-hit the same segment at t=0.
    const t = Math.max(0, tBnd - 0.5);
    cur = { rx: cur.rx + d.rx * t, ry: cur.ry + d.ry * t };
    out.push(cur);
    note('BOUNDARY');
    tack = -tack;
  }
  // Ran out of turns without laying it. Draw nothing rather than a straight
  // line at some angle nobody would sail — the caller drops the branch, and an
  // absent route is honest where an invented one is not.
  return { pts: [], tack, firstEnd };
}

/* The route, or ROUTES — because at a gate there are two.
 *
 * A gate is a decision, and it is the decision the leg turns on: the two marks
 * are a couple of hundred metres apart across the course, so which one you round
 * changes where the next leg starts, which side of the corridor you begin on,
 * and often how many tacks the leg costs. Drawing the midpoint answers a
 * question nobody asks. So when the next mark is a gate the route forks, and
 * both branches are drawn: LEFT and RIGHT as seen from the boat on its way in.
 *
 * Which is which comes from the cross product of the approach direction with
 * the offset of each mark from the gate centre — the boat's own left and right,
 * not the screen's and not the wind's, because "go left at the gate" means the
 * one on your left as you come at it.
 *
 * Only the FIRST gate forks. Beyond it each branch takes gate midpoints, since
 * forking every gate would double the picture at every mark and the second
 * decision is not one you are making yet.
 */
const gateMid = el => el.p2
  ? { rx: (el.p1.rx + el.p2.rx) / 2, ry: (el.p1.ry + el.p2.ry) / 2 } : el.p1;

/* Draws it. Three rows before the gun, three after — AVG TWD is always there,
 * and the second metric changes with the phase because the question does: on
 * the way to M1 it is how long this reach lasts, and once racing it is how long
 * until the leg stops boxing you in. */
function renderCourseBox(rd, t, focus) {
  const box = $('coursebox'), body = $('courseBody');
  if (!box || !body) return;
  if (!rd || !rd.frame) { box.hidden = true; return; }
  box.hidden = false;

  const row = (k, v, cls) =>
    `<div class="cb${cls ? ' ' + cls : ''}"><span class="k">${k}</span>` +
    `<span class="v">${v}</span></div>`;
  const secs = x => x == null ? '—' : `${Math.round(x)}<small>s</small>`;

  const w = pickWind(rd, t, focus, COURSE_WIND.source, COURSE_WIND.dampSec);
  const twd = w && w.twd != null ? w.twd : (rd.wind && rd.wind.twd);
  const tws = w && w.tws != null ? w.tws : (rd.wind && rd.wind.tws);
  const out = [
    row('AVG TWD', twd == null ? '—'
      : `${Math.round(((twd % 360) + 360) % 360)}°` +
        (tws == null ? '' : `<small>${tws.toFixed(1)} km/h</small>`)),
  ];

  /* Which of the two second rows, and the switch is NOT the gun.
   *
   * M1 EXIT answers "how long does this board off M1 last". That question is
   * live from the moment you can see the reach until the moment the board ends
   * — which is the first turn after M1, not the start signal. Switching at the
   * gun took the number away halfway through the very leg it was measuring, and
   * replaced it with one about a corridor you had not entered yet.
   *
   * OPEN COURSE takes over at that first turn, because that is the first moment
   * its question ("tack now and does the next board end on the layline") has
   * anything to answer. */
  const turn = firstTurnAfterM1(rd, focus);
  if (turn == null || t < turn) {
    const x = m1ExitAt(rd, t, focus);
    out.push(row('M1 EXIT', x
      ? `<span class="what">${x.what}</span>${secs(x.secs)}` : '—'));
  } else {
    const oc = openCourseAt(rd, t, focus);
    out.push(row('OPEN COURSE',
      !oc ? '—' : oc.open ? 'OPEN' : secs(oc.secs),
      oc && oc.open ? 'open' : ''));
  }

  /* ── the gate you are sailing at, and what the leg after it costs ─────────
   *
   * Two things you decide on the way IN to a rounding, not after it. Which mark
   * of the gate is favoured is the last call of this leg; how many turns the
   * next leg takes off each of them is the first call of the next one, and the
   * two are the same decision — a gate can be biased one way and still be the
   * wrong end to round if the leg off it costs you an extra turn.
   *
   * Both come from work already being done for the map: the bias from the same
   * routine that writes it beside the gate, the turn counts from the same
   * router that draws the dashed next-leg branches. Nothing here computes a
   * second opinion. */
  let gb = null;
  try { gb = gateBiasAt(rd, t, focus)[0] || null; } catch {}
  if (gb) out.push(row('NEXT GATE',
    `${gb.side === 'L' ? 'LEFT' : 'RIGHT'}` +
    `<span class="what">${gb.m < 1 ? 'EVEN' : Math.round(gb.m) + ' m'}</span>`));

  const bt = bounceState(rd, t, focus);
  if (bt && bt.nexts && bt.nexts.length) {
    /* Tacks upwind, gybes downwind — named for the leg being COUNTED, which is
     * the next one, not the one under the boat. Coming up a beat the number
     * that matters is how many gybes the run off each mark takes. */
    const word = bt.runningNext ? 'gybes' : 'tacks';
    const pick = lbl => bt.nexts.find(n => n.label === lbl);
    const L = pick('LEFT'), R = pick('RIGHT');
    if (L || R) {
      // Fewer turns is better, so the cheaper side is called out rather than
      // left to be worked out from two numbers.
      const best = (L && R && L.tacks !== R.tacks)
        ? (L.tacks < R.tacks ? 'L' : 'R') : null;
      const cell = (side, n) => n == null ? '—'
        : `<b class="${best === side ? 'good' : ''}">${n.tacks}</b>`;
      out.push(row('NEXT LEG',
        `${cell('L', L)}<small>L</small> · ${cell('R', R)}<small>R</small>` +
        `<span class="what">${word}</span>`));
    } else if (bt.nexts.length === 1 && bt.nexts[0].label == null) {
      // A single turning mark is not a choice, so it is not written as one.
      out.push(row('NEXT LEG',
        `<b>${bt.nexts[0].tacks}</b><span class="what">${word}</span>`));
    }
  }

  // The finish, once it is the next thing but one — see finishInfoAt.
  const fi = finishInfoAt(rd, t, focus);
  if (fi) {
    out.push(row('TO FINISH', fi.twa == null
      ? `${Math.round(((fi.brg % 360) + 360) % 360)}°`
      : `${Math.abs(Math.round(fi.twa))}°<small>TWA ${fi.tack} · ` +
        `${Math.round(((fi.brg % 360) + 360) % 360)}°</small>`));
    out.push(row('FINISH END',
      `${fi.side}<span class="what">${fi.gainM < 1 ? 'EVEN' : Math.round(fi.gainM) + ' m'}</span>`));
  }
  body.innerHTML = out.join('');
}

/* The last leg, read one leg early.
 *
 * The finish is the one mark on the course you approach without having rounded
 * anything on the way in, so the decision about it — which end, and at what
 * angle — has to be made while you are still on the leg BEFORE it. Not at the
 * start of that leg, though: the first half of it is about getting round the
 * last mark, and a finish-line readout sitting there for a whole leg is two
 * rows of the box saying nothing yet. Halfway is when it starts to matter, so
 * halfway is when it appears, and it stays up through the final leg.
 *
 * Both numbers are about the COURSE, measured from the last mark rather than
 * from wherever the boat happens to be:
 *
 *   TO FINISH   the angle the final leg is sailed at — TWA, with the tack and
 *               the true bearing beside it. That is what says whether it is a
 *               fetch, a reach or a run, and which gybe it wants.
 *   FINISH END  which end of the line is nearer the last mark, and by how many
 *               metres. LEFT and RIGHT as the boat coming down the leg sees
 *               them, by the same cross product the gate labels use, so the two
 *               never disagree about which side is which.
 */
function finishInfoAt(rd, t, focus) {
  const els = (rd.course && rd.course.elements) || [];
  const n = els.length;
  if (n < 3 || !rd.frame) return null;
  const fin = els[n - 1];
  if (!fin || !fin.p1 || !fin.p2) return null;
  const last = els[n - 2];
  if (!last || !last.p1) return null;
  const boat = focus && rd.tracks[focus] ? sampleAt(rd.tracks[focus], t) : null;
  if (!boat) return null;
  const leg = boat.leg == null ? null : Math.round(boat.leg);
  if (leg == null || leg < n - 2) return null;

  // On the second-last leg it waits for halfway; on the final leg it is already
  // the leg being sailed, so there is nothing to wait for.
  if (leg === n - 2) {
    const a = gateMid(els[n - 3]), b = gateMid(last);
    const ax = b.rx - a.rx, ay = b.ry - a.ry;
    const L2 = ax * ax + ay * ay;
    if (!(L2 > 0)) return null;
    const f = ((boat.rx - a.rx) * ax + (boat.ry - a.ry) * ay) / L2;
    if (!(f >= 0.5)) return null;
  }

  const from = gateMid(last);
  const c = { rx: (fin.p1.rx + fin.p2.rx) / 2, ry: (fin.p1.ry + fin.p2.ry) / 2 };
  const ux = c.rx - from.rx, uy = c.ry - from.ry;
  const L = Math.hypot(ux, uy);
  if (!(L > 1)) return null;
  const brg = rd.frame.bearingFromRot(ux, uy);

  const w = pickWind(rd, t, focus, COURSE_WIND.source, COURSE_WIND.dampSec);
  const twd = w && w.twd != null ? w.twd : (rd.wind && rd.wind.twd);
  const twa = twd == null ? null : ((brg - twd) % 360 + 540) % 360 - 180;

  const d1 = Math.hypot(fin.p1.rx - from.rx, fin.p1.ry - from.ry);
  const d2 = Math.hypot(fin.p2.rx - from.rx, fin.p2.ry - from.ry);
  const near = d1 <= d2 ? fin.p1 : fin.p2;
  const cross = (ux / L) * (near.ry - c.ry) - (uy / L) * (near.rx - c.rx);

  return { brg, twa, side: cross > 0 ? 'LEFT' : 'RIGHT',
           gainM: Math.abs(d1 - d2),
           tack: twa == null ? null : (twa < 0 ? 'PORT' : 'STBD') };
}

/* ── the COURSE box ──────────────────────────────────────────────────────────
 *
 * Three numbers about the racecourse rather than about a boat, so they sit in
 * their own corner: the wind the course is being read with, and how far you are
 * from the moment the leg stops being a corridor.
 */
const COURSE_WIND = { source: 'all', dampSec: 60 };

/* OPEN COURSE.
 *
 * Kyle's definition, in his words: "if you are sailing on port/starboard tack,
 * and if you tack now your next tack will be on layline rather than boundary".
 *
 * So it is a question about the board AFTER the turn, not about the one you are
 * on. Sailing up a stadium leg you are boxed in: tack now and the port board
 * runs into the boundary, so you are still in the corridor and the next turn is
 * forced on you rather than chosen. At some point that stops being true — tack
 * from there and the port board ends on the STARBOARD LAYLINE, where you turn
 * because you want to, not because the water ran out. That is the moment the
 * course opens.
 *
 * The layline is to the MIDDLE of the gate, not to either mark: aiming at a
 * mark commits you to rounding it, and the decision this number serves is the
 * one before that.
 *
 * The test is not re-derived here. It is one call to bounceLeg with the tack
 * forced the other way — exactly the TACK NOW branch drawn on the map — and a
 * read of its `firstEnd`. Two numbers that answer the same question have to
 * come out of the same routine or they will drift apart, which is what happened
 * the first time round.
 *
 * The countdown is how long you stay on this board before that becomes true,
 * found by walking the boat forward along its present heading and asking again.
 * If the boundary on THIS board arrives first, the course does not open on this
 * leg of the zigzag at all and there is no honest number to show.
 */
function openCourseAt(rd, t, focus) {
  if (!focus || !rd.tracks[focus]) return null;
  const boat = sampleAt(rd.tracks[focus], t);
  if (!boat || boat.sog == null) return null;
  const w = settledWind(rd, t, focus, ROUTE.source, ROUTE.dampSec);
  if (!w || w.twd == null) return null;
  const els = (rd.course && rd.course.elements) || [];
  const leg = boat.leg != null ? Math.round(boat.leg) : 1;
  const el = els[leg];
  if (!el || el.type === 'StartLine') return null;

  const target = gateMid(el);
  const ang = nextLegAngles(rd, w.tws != null ? w.tws : rd.wind.tws, boat, focus);
  const prev = els[leg - 1];
  const ap = prev ? rd.frame.bearingFromRot(target.rx - gateMid(prev).rx,
                                            target.ry - gateMid(prev).ry) : null;
  const tack0 = boat.twa != null && boat.twa < 0 ? -1 : 1;

  /* Tack from P and see what ends the board. LAYLINE — or the mark itself, which
   * is the same news only better — is open; BOUNDARY is not. */
  const opens = P => {
    const r = bounceLeg(rd, P, target, w.twd, ang, -tack0,
                        { approach: ap, forceTack: true });
    if (!r.pts.length) return false;
    return r.firstEnd === 'LAYLINE' || r.firstEnd === 'MARK';
  };

  const here = { rx: boat.rx, ry: boat.ry };
  if (opens(here)) return { secs: 0, open: true, distM: 0 };

  const hdg = boat.hdg != null ? boat.hdg : boat.cog;
  const spd = boat.sog / 3.6;
  if (hdg == null || !(spd > 0)) return { secs: null, open: false };
  const d = headVec(rd, hdg);

  // How far this board can run before the water stops it. There is no point
  // asking about a position you will never sail through.
  let lim = spd * OPEN_COURSE_HORIZON_S;
  for (const [p1, p2] of boundarySegs(rd)) {
    const h = rayHitSeg(here, d, p1, p2);
    if (h != null && h < lim) lim = h;
  }
  if (!(lim > 0)) return { secs: null, open: false };

  const at = m => ({ rx: here.rx + d.rx * m, ry: here.ry + d.ry * m });
  if (!opens(at(lim))) return { secs: null, open: false };

  // Bisect for the first metre of this board from which it opens.
  let lo = 0, hi = lim;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (opens(at(mid))) hi = mid; else lo = mid;
  }
  return { secs: hi / spd, open: false, distM: hi };
}

/* How far ahead OPEN COURSE will look along the present board, in seconds. Past
 * a couple of minutes the answer is about a wind and a course that will have
 * moved on, so it is not worth the arithmetic. */
const OPEN_COURSE_HORIZON_S = 150;

/* M1 EXIT — the pre-start twin of OPEN COURSE.
 *
 * "The time from M1 to either boundary or layline." That is not a measurement
 * of where the boat is now: it is the first board of the leg AFTER M1, the one
 * the next-leg route already draws and already puts a clock on. So this reads
 * that clock rather than building a second one — which is why the two now match.
 * They did not before, because this measured from the boat's present position
 * along its present heading, which is a different quantity that happened to
 * carry the same label.
 */
function m1ExitAt(rd, t, focus) {
  const r = bounceState(rd, t, focus);
  if (!r) return null;
  /* Two ways to ask the same question, depending on where the boat is.
   *
   * Before the rounding the board has not started, so it is measured from the
   * MARK — the next-leg branch off M1, which is the clock already drawn on the
   * map. Once round, the board is under way and the honest number is from HERE:
   * the current leg's own first run, which is the same stretch of water with
   * the part you have already sailed taken off. Reading `nexts` after the
   * rounding would have measured the leg after the one you are on.
   */
  const boat = rd.tracks[focus] ? sampleAt(rd.tracks[focus], t) : null;
  const leg = boat && boat.leg != null ? Math.round(boat.leg) : 1;

  const n = (r.nexts || [])[0];
  const hold = (r.routes || []).find(x => x.label === 'HOLD');
  /* Still on the reach — leg 1, before the gun or after it — and the board in
   * question has not started: it is measured from the MARK, as the next-leg
   * branch off M1 already does. The switch is the ROUNDING, not the gun. Made
   * at the gun instead, the whole reach reported the time to M1 itself, which
   * is the current leg's first board when the current leg is the reach. You can
   * see M1 coming; nobody needs a clock on it. */
  const from = leg < 2
    ? (n && n.firstSec != null ? n : null)
    : (hold && hold.now && hold.now.firstSec != null ? hold.now : null);
  if (!from) return null;
  /* Only the two things that END a board by making you turn. A board that
   * simply lays its mark has neither, and naming the mark there would answer a
   * question nobody asked — so it reads as a dash instead. */
  if (from.firstEnd !== 'BOUNDARY' && from.firstEnd !== 'LAYLINE') return null;
  return { what: from.firstEnd, secs: from.firstSec, distM: from.firstM };
}

/* The first turn after M1 — the moment M1 EXIT stops being the question.
 *
 * Found from the boat's own TWA, not from the course: the leg number changes at
 * the rounding, and what is wanted is the TURN that ends the first board of the
 * next leg, which the course cannot know. A sign change in TWA is a tack or a
 * gybe either way, which is right — off M1 it is a gybe on these courses, but
 * the metric does not care which way the boat went round.
 *
 * Readings within 15° of head-to-wind or dead downwind are skipped: the sign
 * there is noise, and a boat wandering across the run would otherwise "gybe"
 * every second. The new sign has to hold for three seconds before it counts.
 *
 * Cached per boat, and recomputed while the answer is still null and the feed
 * has played further — in replay `rd` only spans what has been played, so an
 * early null must not be allowed to set.
 */
const M1_TURN_DEAD = 15;      // degrees either side of 0 and 180 that carry no sign
const M1_TURN_HOLD = 3;       // seconds the new tack must hold to count as a turn
function firstTurnAfterM1(rd, focus) {
  if (!focus || !rd.tracks[focus]) return null;
  rd._m1turn = rd._m1turn || {};
  const memo = rd._m1turn[focus];
  if (memo && (memo.v != null || memo.tMax >= rd.tMax)) return memo.v;

  const tr = rd.tracks[focus];
  let sign0 = null, since = null, ans = null;
  for (let t = 0; t <= rd.tMax; t += 1) {
    const s = sampleAt(tr, t);
    if (!s) continue;
    const leg = s.leg == null ? null : Math.round(s.leg);
    if (leg == null || leg < 2) { sign0 = null; since = null; continue; }
    const a = s.twa;
    if (a == null) continue;
    const m = Math.abs(a);
    if (m < M1_TURN_DEAD || m > 180 - M1_TURN_DEAD) continue;
    const sg = a < 0 ? -1 : 1;
    if (sign0 == null) { sign0 = sg; continue; }
    if (sg === sign0) { since = null; continue; }
    if (since == null) since = t;
    if (t - since >= M1_TURN_HOLD) { ans = since; break; }
  }
  rd._m1turn[focus] = { v: ans, tMax: rd.tMax };
  return ans;
}

/* One route solve per frame, shared.
 *
 * bounceTrack runs the router several times over — two branches for this leg,
 * one from each gate mark for the next — and three separate overlays now want
 * its answer: the route lines, the leg readout, and the COURSE box. Solving it
 * three times a frame is both wasteful and a way for two of them to disagree
 * about the same picture if a setting changes between calls. Memoised on
 * everything the answer actually depends on.
 */
let BOUNCE_MEMO = null;
function bounceState(rd, t, focus) {
  const key = `${t}|${focus}|${MODE.now}|${ROUTE.source}|${ROUTE.dampSec}|`
            + `${LAYLINE.trim}|${WIND_PICK.off.size}`;
  if (BOUNCE_MEMO && BOUNCE_MEMO.key === key && BOUNCE_MEMO.rd === rd)
    return BOUNCE_MEMO.v;
  let v = null;
  try { v = bounceTrack(rd, t, focus); } catch { v = null; }
  BOUNCE_MEMO = { key, rd, v };
  return v;
}

function bounceTrack(rd, t, focus) {
  if (!focus || !rd.tracks[focus]) return null;
  const boat = sampleAt(rd.tracks[focus], t);
  if (!boat) return null;
  const w = settledWind(rd, t, focus, ROUTE.source, ROUTE.dampSec);
  if (!w || w.twd == null) return null;
  const els = (rd.course && rd.course.elements) || [];
  // Before the gun there is no leg number yet, but there is no doubt about the
  // course either: everyone is sailing leg 1, to M1, and the leg after it is
  // the one that actually needs thinking about while you still have time to
  // think. So the pre-start default is leg 1, and it holds until the boat's own
  // leg count takes over at the rounding.
  const leg = boat.leg != null ? Math.round(boat.leg) : 1;
  if (!els.length) return null;
  const first = els[leg];
  if (!first || first.type === 'StartLine') return null;

  const tws = w.tws != null ? w.tws : rd.wind.tws;
  const ang = nextLegAngles(rd, tws, boat, focus);
  const start = { rx: boat.rx, ry: boat.ry };
  const tack0 = boat.twa != null && boat.twa < 0 ? -1 : 1;

  // The bearing of each leg, from the element before it — the same thing the
  // laylines use to decide a mark's mode, so the two never disagree.
  const approachTo = i => {
    const a = els[i - 1], b = els[i];
    if (!a || !b) return null;
    const pa = gateMid(a), pb = gateMid(b);
    return rd.frame.bearingFromRot(pb.rx - pa.rx, pb.ry - pa.ry);
  };
  const ap1 = approachTo(leg), ap2 = approachTo(leg + 1);
  // Beat or run — asked separately for each leg, because they are usually
  // opposites. A run into a beat is two gybes then some number of TACKS, and
  // naming the second lot after the first is just wrong.
  const isRun = ap => {
    if (ap == null) return false;
    let o = Math.abs(((w.twd - ap) % 360 + 360) % 360);
    if (o > 180) o = 360 - o;
    return o >= 90;
  };
  const running = isRun(ap1), runningNext = isRun(ap2);

  const measure = (pts, endMark, extra) => {
    let dist = 0, tacks = extra || 0;
    for (let i = 1; i < pts.length; i++) {
      dist += Math.hypot(pts[i].rx - pts[i - 1].rx, pts[i].ry - pts[i - 1].ry);
      if (i < pts.length - 1 &&
          Math.hypot(endMark.rx - pts[i].rx, endMark.ry - pts[i].ry) >= 1) tacks++;
    }
    return { pts, mark: endMark, dist, tacks };
  };

  /* How long the FIRST run lasts — from the mark to wherever the corridor first
   * makes you turn, boundary or layline. That is the number you are counting
   * down as you round: not how long the leg takes, but how long you are on this
   * board before the next decision. Distance over the boat's own target speed
   * for the mode, from TARG_BOAT_SPEED in the same channel as the angles, so it
   * is this boat's speed in this wind rather than a guess. */
  // `angles` defaults to this leg's — the next-leg branches pass their own,
  // resolved under the mode they belong to, so the seconds on that board come
  // off the target speed for the wind THAT leg is being drawn in.
  const firstRun = (leg2, runningLeg, angles) => {
    if (!leg2 || leg2.pts.length < 2) return;
    const a = leg2.pts[0], b = leg2.pts[1];
    leg2.firstM = Math.hypot(b.rx - a.rx, b.ry - a.ry);
    // The end of the first run is a turn only if it is not the mark itself.
    leg2.firstIsTurn = Math.hypot(leg2.mark.rx - b.rx, leg2.mark.ry - b.ry) >= 1;
    /* Nearly always the first run ends at a boundary or a layline and the clock
     * is a countdown to that turn. A handful of legs genuinely lay in one go —
     * the next mark sits inside the target angles AND on the tack you leave the
     * gate on — and there the same clock is time to the mark, which is the same
     * question ("how long on this board before anything changes") with a
     * different answer. The branch label says 0 GYBES in that case, so the two
     * cannot be confused. It is hung at the midpoint rather than at the end,
     * because the end is another gate mark with its own thicket of labels. */
    leg2.firstAt = leg2.firstIsTurn
      ? b : { rx: (a.rx + b.rx) / 2, ry: (a.ry + b.ry) / 2 };
    const A = angles || ang;
    const v = runningLeg ? A.dnV : A.upV;
    leg2.firstSec = v > 0 ? leg2.firstM / (v / 3.6) : null;
  };

  // Which gate mark each branch ends at is not the branch's question — it is
  // whichever of the two that branch actually lays for less. The fork here is
  // the one you are making RIGHT NOW: hold this gybe, or swap onto the other.
  const marks = first.p2 ? [first.p1, first.p2] : [first.p1];
  const c = first.p2 ? gateMid(first) : first.p1;
  // Where THIS leg is steered: the middle of the gate, or the mark itself when
  // there is only one. It used to run to whichever of the two marks laid for
  // less, which is a choice this route is not making — and because the tie was
  // broken the same way every time, it drew the same gate leg after leg, up and
  // down. You sail at the gate and pick a mark at the rounding; the LEFT/RIGHT
  // fork below is where that choice is actually put.
  const target = c;
  const ux = c.rx - boat.rx, uy = c.ry - boat.ry;
  const L = Math.hypot(ux, uy) || 1;
  const sideOf = m => ((ux / L) * (m.ry - c.ry) - (uy / L) * (m.rx - c.rx)) > 0
    ? 'L' : 'R';

  // THIS leg: the decision you are making now — hold this gybe out to the
  // boundary, or swap onto the other one immediately. Each branch ends at
  // whichever gate mark it lays for less, because which mark to round is not
  // the question being asked here.
  const build = head => {
    const r = bounceLeg(rd, start, target, w.twd, ang, head.tack,
                        { approach: ap1, forceTack: true });
    if (!r.pts.length) return null;
    const best = measure([start, ...r.pts], target, head.cost);
    best.endTack = r.tack;
    best.firstEnd = r.firstEnd;
    firstRun(best, running);
    // No gate side to name any more: the route ends between the marks, which is
    // the honest answer to "where does this board take me".
    return { label: head.label, gate: null, now: best };
  };

  const routes = [
    { label: 'HOLD',                            tack: tack0,  cost: 0 },
    { label: running ? 'GYBE NOW' : 'TACK NOW', tack: -tack0, cost: 1 },
  ].map(build).filter(Boolean);

  // THE NEXT leg: one from EACH mark of the gate, not one from whichever mark
  // this leg happened to favour. Which gate you round is a real choice and the
  // whole value of looking a leg ahead is seeing what each one gives you — so
  // both are drawn, from the left mark and from the right, each bouncing off
  // the boundary in its own right. Their arrival tack comes from sailing this
  // leg to that mark, so each next leg starts on the gybe you would actually
  // round on.
  const nexts = [];
  const el2 = els[leg + 1];
  /* The next leg gets the NEXT leg's wind.
   *
   * A beat and a run do not want the same instruments — a mark that is dead
   * upwind of the fleet is reading clean air on one leg and everybody's dirt on
   * the other — which is why the sources are kept per mode. It follows that the
   * leg you are drawing AHEAD should be resolved under the mode it belongs to,
   * not under the one you happen to be sailing. So: this leg on this mode's
   * wind, the next leg on the arriving mode's, side by side on the same map. */
  const wNext = el2 && el2.type !== 'StartLine'
    ? withModeWind(runningNext ? 'down' : 'up',
                   () => settledWind(rd, t, focus, ROUTE.source, ROUTE.dampSec))
    : null;
  const w2 = wNext && wNext.twd != null ? wNext : w;
  const tws2 = w2.tws != null ? w2.tws : tws;
  const ang2 = withModeWind(runningNext ? 'down' : 'up',
                            () => nextLegAngles(rd, tws2, boat, focus)) || ang;
  if (el2 && el2.type !== 'StartLine') {
    // You do not sail to the middle of a gate — you sail to one of its marks,
    // and the layline and the corridor are different for each. Aiming at the
    // midpoint put the end of the route at a place there is nothing to round,
    // up to half a gate away from either mark, and bent the whole approach to
    // suit it. Each branch now runs to whichever mark of the destination it
    // lays for less, exactly as the current leg does.
    // Same again for where each branch is heading: the middle of the next gate,
    // or its single mark. Which mark of THAT gate to round is the fork you will
    // be shown when you get there, not one to prejudge from a leg away.
    const dest = [el2.p2 ? gateMid(el2) : el2.p1];
    for (const m of marks) {
      /* The tack you leave on is set by WHICH MARK you round, not by how you
       * arrived.
       *
       * `sideOf` is left and right as the APPROACHING boat sees them. You sail
       * between the marks and turn outward around the one you picked, so the
       * mark on your left is rounded with a LEFT turn and the one on your right
       * with a right turn. A single turning mark is not a choice: these courses
       * round M1 to port, so it is a left turn every time.
       *
       * The turn is the input; exitTack() works out what tack that turn leaves
       * you on, against the leg you are joining. Fixing the tack per side
       * instead was right for one gate and wrong for the other.
       */
      const side = marks.length > 1 ? sideOf(m) : null;
      const tack = ap1 == null ? MARK_ROUND_TACK
                 : exitTack(ap1, w2.twd, runningNext ? ang2.dn : ang2.up,
                            side !== 'R');
      const m2 = dest[0];
      const r2 = bounceLeg(rd, m, m2, w2.twd, ang2, tack,
                           { approach: ap2, forceTack: true });
      if (!r2.pts.length) continue;
      const meas = measure([m, ...r2.pts], m2);
      meas.firstEnd = r2.firstEnd;
      firstRun(meas, runningNext, ang2);
      meas.label = side === 'R' ? 'RIGHT' : side === 'L' ? 'LEFT' : null;
      // A leg that is simply fetched — one straight run to the mark, no turns —
      // is not being sailed on a tack at all, so it does not claim one. Saying
      // STBD over a rhumb line would be a label with nothing behind it.
      const fetched = meas.tacks === 0 && meas.pts.length === 2;
      meas.tackOut = fetched ? null : (tack > 0 ? 'STBD' : 'PORT');
      meas.from = m;
      nexts.push(meas);
    }
    nexts.sort((a, b) => (a.label === 'LEFT' ? -1 : 1));
  }

  return (routes.length || nexts.length)
    ? { routes, nexts, twd: w.twd, ang, tws, running, runningNext,
        twdNext: w2.twd, angNext: ang2 } : null;
}

/* LEFT is green and RIGHT is amber, held apart from the boat's own colour so
 * two routes in one hull colour never have to be told apart by shade alone. */
/* This leg is the green/amber pair; the next leg gets its own blue/violet, so
 * four lines on one map never have to be told apart by dash alone. */
const ROUTE_INK = { HOLD: '#4fd6a0', 'GYBE NOW': '#e0a83f', 'TACK NOW': '#e0a83f',
                    null: '#8fb4d8' };
const NEXT_INK = { LEFT: '#5aa9e6', RIGHT: '#b98cff', null: '#8fb4d8' };


/* ── out and back ────────────────────────────────────────────────────────────
 *
 * How long the pin-end escape takes: from the lower start mark, out to the
 * boundary at 90° TWA, and back again. It is the length of the loop you commit
 * to when you go down there, and knowing it in seconds is what tells you
 * whether there is room for it before the gun.
 *
 * 90° is the whole trick. A reciprocal course out and back is 90° TWA in BOTH
 * directions — turn a beam reach through 180° and it is a beam reach on the
 * other tack — so one speed off the polar covers both legs and the distance is
 * the same each way. Any other angle out would come back at a different one.
 *
 * Which of the two beam reaches: the one running AWAY from the other end of the
 * line. The line sits square-ish to the wind, so a 90° heading runs along it,
 * and the useful direction is out past the pin rather than back up towards the
 * boat end.
 *
 * The tack in the middle is not free, and the polar has nothing to say about
 * it — a turn through 180° costs seconds no table models. OUT AND BACK TACK is
 * that cost, 8 s by default, added flat. It is an allowance, not a measurement,
 * which is why it is a control.
 *
 * The wind is the race average, deliberately: this sits beside the ratio and the
 * time-to-line, which are built on the same one, and a loop timed off a
 * different wind from the numbers next to it would not be comparable with them.
 */
const OUT_BACK = { tackLossS: 8 };
const OUT_BACK_TWA = 90;

function outAndBack(rd) {
  const f = rd && rd.frame;
  if (!f || !f.leeR || !f.windR) return { why: 'no line' };
  const twd = rd.wind && rd.wind.twd, tws = rd.wind && rd.wind.tws;
  if (twd == null || tws == null) return { why: 'no wind' };
  const v = polarSpeed(rd.polar, OUT_BACK_TWA, tws);
  if (!(v > 0)) return { why: 'no polar at 90°' };

  // Out onto the PRE-START side — not "along the line".
  //
  // This started as a dot with the line axis, on the assumption that a 90-TWA
  // heading runs roughly along the start line. That holds for a line square to
  // the wind and is flatly wrong here: a SailGP start line lies nearly ALONG
  // the wind axis (M1 sits at ~90 TWA off the line, which is the whole reason
  // this metric is measured at 90), so a 90-TWA heading is almost square to
  // the line. Measured across the archive that dot came out between 0.008 and
  // 0.6 — near zero — so its sign, and with it the direction sailed, flipped
  // on the line bias from one race to the next: 850 m out in one race and
  // 235 m in the next on the same course.
  //
  // The frame's normal is the conditioned test. It is oriented positive on the
  // pre-start side (away from M1), which is the side you actually run out on,
  // and |dot| lands between 0.80 and 1.00 in every race in the archive.
  const pin = rd.pinEnd === 'windward' ? f.windR : f.leeR;
  let d = null, best = 0;
  for (const tk of [1, -1]) {
    const h = headVec(rd, twd - tk * OUT_BACK_TWA);
    const s = h.rx * f.n.x + h.ry * f.n.y;
    if (s > best) { best = s; d = h; }
  }
  if (!d) return { why: 'no pre-start side' };

  const segs = boundarySegs(rd);
  if (!segs.length) return { why: 'no boundary in the file' };

  // The archive carries only the RACING boundary — Njord has no pre-start box —
  // and on some days the start line is laid outside it. Then the run out never
  // crosses it and the honest answer is that the box is missing, not that the
  // geometry failed.
  if (!insideBoundary(rd, pin)) return { why: 'pin outside the boundary' };

  let D = null;
  for (const [a, b] of segs) {
    const hit = rayHitSeg(pin, d, a, b);
    if (hit != null && (D == null || hit < D)) D = hit;
  }
  if (D == null) return { why: 'no boundary that way' };

  const sail = 2 * D / (v / 3.6);
  return { distM: D, kmh: v, sail, secs: sail + OUT_BACK.tackLossS };
}

/* ── the last tack ───────────────────────────────────────────────────────────
 *
 * Running out from the entry, the ratio falls the whole way: the time you have
 * is draining while the time you need is growing. There is a moment on that
 * course after which you can no longer get back to the line for the gun, and
 * the number worth having is how many seconds away it is. Hold the course past
 * it and you are late, and no amount of sailing well afterwards fixes it.
 *
 * The threshold is a ratio, not 1.00, because 1.00 is the point at which a
 * boat already pointing at the line and already up to speed would just make it
 * — and at the moment of the tack you are none of those things. The turn costs
 * seconds and metres and comes out slow. LAST TACK RATIO is that margin, 1.20
 * by default, and it is the one number in this calculation that is a judgement
 * rather than a measurement, which is why it is a control and not a constant.
 *
 * Found by scanning forward along the projected course and bisecting the first
 * crossing rather than solving it. The ratio is not guaranteed monotonic — a
 * course angled back towards the line has the time you need falling as well as
 * the time you have — so anything that assumed a single downward slope would
 * find the wrong root on exactly the boats doing something interesting.
 */
const LAST_TACK = { ratio: 1.2 };
const LAST_TACK_STEP = 0.5;        // s, coarse scan
const LAST_TACK_EPS = 0.02;        // s, bisection floor

function lastTackAt(rd, team, t) {
  if (!(t < 0)) return { why: 'the gun has gone' };
  const tr = rd.tracks[team];
  const s = tr && sampleAt(tr, t);
  if (!s) return { why: 'no position' };
  const sog = s.sog;
  if (!(sog > 0.5)) return { why: 'stopped' };
  const cog = s.cog != null ? s.cog : s.hdg;
  if (cog == null) return { why: 'no heading' };

  const d = headVec(rd, cog);
  const v = sog / 3.6;                                   // m/s
  const target = LAST_TACK.ratio;
  const at = tau => {
    const p = { rx: s.rx + d.rx * v * tau, ry: s.ry + d.ry * v * tau };
    const r = ratioAtPoint(rd, p, t + tau);
    return r ? r.ratio : null;
  };

  const now = at(0);
  /* No ratio to count down from. Almost always one thing: the boat is on the
   * COURSE side of the line, where time-to-line is zero by definition and the
   * ratio is undefined — which in this archive is most of the first hundred
   * seconds, because the fleet runs out beyond the pin and comes back. Say
   * which it is rather than "no ratio", so the blank is a fact about where the
   * boat is and not an apparent fault in the readout. */
  if (now == null)
    return { why: rd.frame.dtl(s) <= 0 ? 'over the line' : 'too close to the line' };
  // Already through it: the tack was due, and saying so beats a countdown that
  // has quietly gone negative.
  if (now <= target) return { now, past: true };

  const horizon = -t;                                    // the gun is the limit
  let lo = 0, hi = null;
  for (let tau = LAST_TACK_STEP; tau <= horizon; tau += LAST_TACK_STEP) {
    const r = at(tau);
    if (r == null) break;                                // too close to the line
    if (r <= target) { hi = tau; break; }
    lo = tau;
  }
  if (hi == null) return { now, why: 'holds to the gun' };

  while (hi - lo > LAST_TACK_EPS) {
    const mid = (lo + hi) / 2;
    const r = at(mid);
    if (r == null || r <= target) hi = mid; else lo = mid;
  }
  return { now, secs: hi, past: false };
}

/* ── what the boundary will hand you ─────────────────────────────────────────
 *
 * The pre-start is run out on port and back, and the turn is not a free choice:
 * the boundary makes it for you. So the question that matters on the way out is
 * not "what is my ratio now" — it is "what will my ratio be when I am made to
 * turn", because that is the state you actually have to start solving from.
 *
 * Hold the current speed and course to the first boundary the ray meets, and
 * evaluate the same ratio arithmetic there, at the time you would arrive. The
 * answer moves continuously as you steer, which is the point: bear away and the
 * ray finds a further piece of boundary, so the arrival is later and the ratio
 * falls; luff and it finds a nearer one.
 *
 * It is quoted on port only, as asked. On starboard the boat is coming back to
 * the line and the boundary is behind the problem rather than in front of it.
 */
const BOUND_MAX_S = 300;         // beyond this the ray is not a plan, it is a line

function boundaryOutlook(rd, team, t) {
  if (!(t < 0)) return { why: 'the gun has gone' };
  const tr = rd.tracks[team];
  const s = tr && sampleAt(tr, t);
  if (!s) return { why: 'no position' };
  if (s.twa == null) return { why: 'no wind angle' };
  if (s.twa >= 0) return { why: 'on starboard' };
  const sog = s.sog;
  if (!(sog > 0.5)) return { why: 'stopped' };

  const cog = s.cog != null ? s.cog : s.hdg;
  if (cog == null) return { why: 'no heading' };
  const d = headVec(rd, cog);

  let D = null;
  for (const [a, b] of boundarySegs(rd)) {
    const h = rayHitSeg(s, d, a, b);
    if (h != null && (D == null || h < D)) D = h;
  }
  if (D == null) return { why: 'no boundary ahead' };

  const secs = D / (sog / 3.6);
  if (!(secs >= 0)) return { why: 'not closing on it' };
  const at = t + secs;
  /* Arriving after the gun is not a pre-start state, and the ratio arithmetic
   * says nothing about it — but it is the most useful thing this can tell you
   * when it happens, so it is checked FIRST and named plainly. Holding this
   * course does not end at the boundary; it ends at the start. */
  if (at >= 0) return { why: 'the gun goes first' };
  if (secs > BOUND_MAX_S) return { why: 'boundary too far' };

  const p = { rx: s.rx + d.rx * D, ry: s.ry + d.ry * D };
  const r = ratioAtPoint(rd, p, at);
  if (!r) return { why: 'no ratio there' };
  return { p, secs, distM: D, at, ratio: r.ratio, ttk: r.ttk, ttl: r.ttl };
}

/* ── the legs from each end of the line to M1 ────────────────────────────────
 *
 * The one comparison the start is actually about. The line is two ends and they
 * are not equal: one is closer to M1, the other usually gets a better angle, and
 * which of those wins is the whole argument. The bearing from each end was
 * already on the map; the distance and the TIME were not, and time is the number
 * that settles it — a pin end 40 m closer is worth nothing if the angle out of
 * it costs you six seconds.
 *
 * Distance is the straight line. Seconds come from timeToM1(), which divides
 * that distance by the polar's best speed MADE GOOD on that bearing — so a leg
 * you cannot lay in one go is costed at what tacking or gybing it really makes,
 * not at the boat's speed through the water. It is the same function the fast
 * point on the line is found with, so the three numbers on this map cannot
 * disagree with each other.
 */
const END_LEGS = { on: true, source: 'race', dampSec: 20 };
const END_LEG_INK = { windward: '#00ccff', leeward: '#ffcc00' };
const END_LEG_AT = 0.35;         // how far along the VISIBLE part the label sits

/* The visible portion of a segment, as a parameter range. Liang–Barsky.
 *
 * M1 sits 500 m off a 200 m line, so at any zoom tight enough to read the start
 * the mark — and most of the leg to it — is off canvas. Putting the label at a
 * fixed fraction of the whole line would post it into the void about half the
 * time; putting it at a fraction of the part you can SEE always lands it on a
 * piece of line that is actually drawn.
 */
function segInRect(x0, y0, x1, y1, W, H, pad) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - pad, W - pad - x0, y0 - pad, H - pad - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return t1 > t0 ? [t0, t1] : null;
}

/* ── the start laylines ──────────────────────────────────────────────────────
 *
 * The starboard layline back from each end of the start line, at the upwind
 * target angle. Starboard only, and deliberately: it is the tack you have
 * rights on, so it is the only one of the two you can plan an approach around
 * with any confidence. Drawing the port one as well would double the lines on
 * the busiest part of the map to show a layline you may be waved off.
 *
 * The wind is its own choice, separate from the course laylines', because the
 * two are asking about different water — the start line has mark boats sitting
 * on it, and mid-race it does not. MANUAL is a TWD you type: the one source
 * that is not a measurement, for looking at the line against a shift you expect
 * rather than the one blowing.
 */
const START_LAY = { on: false, source: 'mark', dampSec: 20, twd: 270 };
/* The same green the course laylines use for starboard, not a green of its own:
 * these ARE starboard laylines and there is no reason for the eye to have to
 * learn a second colour for the same fact. */
const START_LAY_INK = TACK_STBD;
const START_LAY_MAX_M = 2400;           // if the boundary never stops it

/* The wind behind anything measured against the START LINE — the laylines and
 * the fast point both — so the two can never be drawn off different winds while
 * sitting on the same piece of water.
 *
 * Everything except MANUAL goes through the same resolvers as the rest of the
 * tool; MANUAL short-circuits with the typed TWD and the race's own TWS, since
 * a hand-set direction says nothing about speed and the target angle still
 * needs one.
 */
function startWind(rd, t, focus, cfg) {
  if (cfg.source === 'race')
    return rd.wind && rd.wind.twd != null
      ? { twd: rd.wind.twd, tws: rd.wind.tws, from: 'race' } : null;
  if (cfg.source === 'manual')
    return { twd: cfg.twd, tws: rd.wind ? rd.wind.tws : null, from: 'manual' };
  if (cfg.source === 'mark') {
    /* The marks ON the line, where the archive names them — SL1, SL2. They are
     * a few metres from the geometry these lines are drawn through, which no
     * other station on the course can say. Where a race carries none, every
     * mark stands in rather than the layline going blank. */
    const sl = (rd.markWind || []).filter(m => /^SL/i.test(m.name || ''));
    if (sl.length) {
      const sec = Math.max(1, cfg.dampSec);
      const dirs = [], spds = [], ages = [], wts = [];
      for (const m of sl)
        for (let i = 0; i < (m.t || []).length; i++) {
          if (!(m.t[i] > t - sec && m.t[i] <= t)) continue;
          const k = windWeight(rd, m.twd[i], m.tws[i]);
          if (k > 0) { dirs.push(m.twd[i]); spds.push(m.tws[i]);
                       ages.push(t - m.t[i]); wts.push(k); }
        }
      const ref = rd.wind ? rd.wind.twd : null;
      const w = windSettle(robustWind(dirs, spds, ages, sec, ref, wts), sec, ref);
      if (w) return { ...w, from: w.held ? 'race' : 'start marks' };
    }
  }
  return settledWind(rd, t, focus, cfg.source, cfg.dampSec);
}

const startLayWind = (rd, t, focus) => startWind(rd, t, focus, START_LAY);


/* ── the fast point, live ────────────────────────────────────────────────────
 *
 * Where along the line M1 is reached soonest is a fact about the WIND, and the
 * wind moves. It was solved once when the race loaded, off the race average,
 * and then sat still for the whole pre-start — so the one marker on the map
 * that says "start here" was answering a question about the average of the next
 * ten minutes rather than about now.
 *
 * The maths is not repeated here. rd.wind and rd.vmc are swapped for the live
 * ones, the SAME fastPointOnLine and advantageProfile are called, and the
 * originals are put back — so the live fast point and the load-time one can
 * never diverge through two copies of the geometry drifting apart.
 *
 * Cached on the rounded wind: the source is damped over tens of seconds, so
 * consecutive frames almost always agree to a tenth of a degree, and this turns
 * ~5,600 time-to-M1 solves per frame into none.
 */
const FAST_PT = { source: 'mark', dampSec: 30, twd: 270 };

function vmcFor(rd, tws) {
  if (tws == null || !rd.polar) return rd.vmc;
  const k = Math.round(tws * 2) / 2;
  rd._vmcCache = rd._vmcCache || {};
  return rd._vmcCache[k] || (rd._vmcCache[k] = vmcTable(rd.polar, k));
}

function refreshFastPoint(rd, t, focus) {
  if (!rd || !rd.frame || !rd.frame.m1R || !rd.polar) return;
  if (rd._fpBase === undefined) rd._fpBase = { fp: rd.fastPoint, adv: rd.advantage };
  const w = startWind(rd, t, focus, FAST_PT);
  if (!w || w.twd == null) {
    rd.fastPoint = rd._fpBase.fp; rd.advantage = rd._fpBase.adv; return;
  }
  const tws = w.tws != null ? w.tws : (rd.wind ? rd.wind.tws : null);
  const key = `${w.twd.toFixed(1)}|${tws == null ? '-' : tws.toFixed(1)}|${rd.pinEnd}`;
  if (rd._fpKey === key) return;

  const twd0 = rd.wind.twd, tws0 = rd.wind.tws, vmc0 = rd.vmc;
  rd.wind.twd = w.twd; rd.wind.tws = tws; rd.vmc = vmcFor(rd, tws);
  let fp = null, adv = null;
  try {
    fp = fastPointOnLine(rd);
    adv = advantageProfile(rd, rd.pinEnd);
  } catch {}
  rd.wind.twd = twd0; rd.wind.tws = tws0; rd.vmc = vmc0;

  rd._fpKey = key;
  rd.fastPoint = fp || rd._fpBase.fp;
  rd.advantage = adv || rd._fpBase.adv;
}

function drawStartLaylines(ctx, rd, t, tX, tY, W, H, opts) {
  if (!opts || !opts.startLay) return;
  const f = rd && rd.frame;
  if (!f || !f.windR || !f.leeR) return;
  const w = startLayWind(rd, t, opts && opts.focus);
  if (!w || w.twd == null) return;

  const boat = opts && opts.focus && rd.tracks[opts.focus]
    ? sampleAt(rd.tracks[opts.focus], t) : null;
  const ang = nextLegAngles(rd, w.tws != null ? w.tws : (rd.wind && rd.wind.tws),
                            boat, opts && opts.focus);
  const theta = ang && ang.up;
  if (theta == null) return;

  // Starboard: heading = twd − θ. The layline runs BACK from the mark, so it is
  // the reciprocal of the heading a boat laying that mark would be steering.
  const head = headVec(rd, w.twd - theta);
  const back = { rx: -head.rx, ry: -head.ry };
  const segs = typeof boundarySegs === 'function' ? boundarySegs(rd) : [];

  ctx.save();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = START_LAY_INK;
  ctx.setLineDash([]);
  ctx.font = '700 10px "Share Tech Mono", monospace';
  ctx.textBaseline = 'middle';

  for (const [name, end] of [['BOAT', f.windR], ['PIN', f.leeR]]) {
    // Stop at the course boundary, like every other layline in the tool, so the
    // start box does not sprout two lines running off into open water.
    let L = START_LAY_MAX_M;
    for (const [a, b] of segs) {
      const h = rayHitSeg(end, back, a, b);
      if (h != null && h > 1 && h < L) L = h;
    }
    const ex = end.rx + back.rx * L, ey = end.ry + back.ry * L;
    const x0 = tX(end.rx, end.ry), y0 = tY(end.rx, end.ry);
    const x1 = tX(ex, ey), y1 = tY(ex, ey);

    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
    ctx.stroke();

    // The caption past the end of the ray, outside the boundary — the same
    // placement the course laylines use, for the same reason.
    /* Past the end of the ray, and stepped sideways.
     *
     * The course laylines are the same tack at the same angle, so their rays
     * are PARALLEL to these and end on the same boundary — which put both
     * captions on the same few pixels and printed BOAT S 59° straight through
     * BOTTOM S 137°. The perpendicular step is what separates two labels that
     * geometry insists on bringing together. */
    const dx = x1 - x0, dy = y1 - y0;
    const D = Math.hypot(dx, dy) || 1;
    const px = -dy / D, py = dx / D;
    const lx = x1 + dx / D * 16 + px * 15, ly = y1 + dy / D * 16 + py * 15;
    if (lx > -60 && lx < W + 60 && ly > -30 && ly < H + 30) {
      const txt = `${name} S ${Math.round(theta)}°`;
      ctx.textAlign = dx >= 0 ? 'left' : 'right';
      ctx.globalAlpha = 1;
      ctx.lineWidth = 3; ctx.strokeStyle = MAP_INK.halo;
      ctx.strokeText(txt, lx, ly);
      ctx.fillStyle = START_LAY_INK;
      ctx.fillText(txt, lx, ly);
      ctx.lineWidth = 1.6; ctx.strokeStyle = START_LAY_INK;
    }
  }
  ctx.restore();
}

function drawEndLegs(ctx, rd, t, tX, tY, W, H, opts) {
  /* The labels no longer form a column, so nothing here places the fast point
   * chip any more — it places itself, and these two step around it. The hook in
   * fastPointChipRect stays (it is the only way this file could ever move that
   * chip again) but it is now always cleared, unconditionally and before any
   * early return, so a stale rectangle can never survive a frame. */
  rd._startStack = null;
  if (!opts || !opts.endLegs) return;
  const f = rd && rd.frame;
  if (!f || !f.m1R || !f.windR || !f.leeR) return;

  /* The wind these angles are measured against. Pre-start the mark boats are
   * sitting on the line and the fleet is milling about beside it, so which
   * witness you believe is a real choice — and the TWA to M1 is exactly the
   * number that choice moves. The seconds move with it too: the speed made good
   * on a bearing depends on where the wind is, so quoting a time off one wind
   * and an angle off another would be two halves of different answers. */
  const w = pickWind(rd, t, opts.focus, END_LEGS.source, END_LEGS.dampSec);
  const twd = w ? w.twd : null;
  const secsFrom = p => {
    if (!rd.vmc || twd == null) return null;
    const dx = f.m1R.rx - p.rx, dy = f.m1R.ry - p.ry;
    const d = Math.hypot(dx, dy);
    if (d < 1) return 0;
    const v = vmcAt(rd.vmc, twd, f.bearingFromRot(dx, dy));
    return v > 0 ? d / (v / 3.6) : null;
  };

  const mx = tX(f.m1R.rx, f.m1R.ry), my = tY(f.m1R.rx, f.m1R.ry);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  /* ── each label on its own ray ────────────────────────────────────────────
   *
   * These numbers were briefly stacked into one aligned column beside the fast
   * point chip, which read well as a block and cost the one thing that mattered
   * most: you could no longer see AT A GLANCE which end each row belonged to.
   * Colour carried it, and colour is a lookup — you have to remember that cyan
   * is windward before the row means anything.
   *
   * So each one is written along the ray it describes, rotated to it, sitting
   * on the dashed line itself. Nothing to remember: the number is on the line,
   * and the line goes to the end it came from. They are placed nearer their own
   * end than M1, where the two rays are furthest apart, and stepped along the
   * ray if they would land on the fast point chip or on each other.
   */
  const ends = [['windward', f.windR], ['leeward', f.leeR]].map(([key, end]) => {
    const twa = twd == null ? null
      : ((twd - f.bearingFromRot(f.m1R.rx - end.rx, f.m1R.ry - end.ry)) % 360 + 540) % 360 - 180;
    const distM = Math.hypot(f.m1R.rx - end.rx, f.m1R.ry - end.ry);
    const bits = [];
    if (twa != null) bits.push(`${Math.abs(twa).toFixed(0)}°`);
    bits.push(`${distM.toFixed(0)} m`);
    const sec = secsFrom(end);
    if (sec != null) bits.push(`${sec.toFixed(1)}s`);
    return { key, end, txt: bits.join(' · '),
             x0: tX(end.rx, end.ry), y0: tY(end.rx, end.ry) };
  });

  // the dashed rays first, under everything
  for (const e of ends) {
    ctx.strokeStyle = END_LEG_INK[e.key];
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.4;
    // A fine dash of its own — the start box already carries the line's own
    // extensions, the start laylines and the advantage curve, and a fourth kind
    // of dashed line has to be tellable from the other three.
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(e.x0, e.y0);
    ctx.lineTo(mx, my);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.globalAlpha = 1;
  ctx.font = '700 11px "Share Tech Mono", monospace';
  for (const e of ends) e.tw = ctx.measureText(e.txt).width;

  const chip = typeof fastPointChipRect === 'function' && opts.laylines !== false
    ? fastPointChipRect(ctx, rd, tX, tY, W, H) : null;
  const placed = [];
  if (chip) placed.push({ x: chip.bx, y: chip.by, w: chip.bw, h: chip.bh });

  const overlap = (p, q) =>
    p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y;

  /* A rotated label's footprint, as the upright box that contains it. Cheap,
   * and slightly pessimistic, which is the right way to be wrong about whether
   * two pieces of text are on top of each other. */
  const aabb = (cx, cy, w2, h2, ang) => {
    const c = Math.abs(Math.cos(ang)), sn = Math.abs(Math.sin(ang));
    const bw2 = w2 * c + h2 * sn, bh2 = w2 * sn + h2 * c;
    return { x: cx - bw2 / 2, y: cy - bh2 / 2, w: bw2, h: bh2 };
  };

  /* The part of a ray you can actually see.
   *
   * At any real zoom the start line's ends spend most of the time off the edge
   * of the map, and a label placed a third of the way along a ray that begins
   * off-screen is a label that is also off-screen. Measured across the archive
   * that was very nearly half of them. So each ray is clipped to the canvas
   * first and the label is placed along what is LEFT — the visible piece of the
   * line is the only piece it can sit on.
   *
   * Liang-Barsky, because it answers exactly this: the two parameters along the
   * segment where it enters and leaves the box. */
  const clipSeg = (x0, y0, x1, y1, minx, miny, maxx, maxy) => {
    let t0 = 0, t1 = 1;
    const dx = x1 - x0, dy = y1 - y0;
    const test = (p, q) => {
      if (p === 0) return q >= 0;
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else       { if (r < t0) return false; if (r < t1) t1 = r; }
      return true;
    };
    if (!test(-dx, x0 - minx) || !test(dx, maxx - x0)) return null;
    if (!test(-dy, y0 - miny) || !test(dy, maxy - y0)) return null;
    return t1 > t0 ? { t0, t1 } : null;
  };

  const HH = H || 620, PAD = 6;
  const inView = q => q.x >= PAD && q.y >= PAD
                   && q.x + q.w <= W - PAD && q.y + q.h <= HH - PAD;

  // The longer ray places first: it has the most room to be moved along, so it
  // is the one that can most afford to go second-best if it comes to that.
  const order = ends.slice().sort((p, q) =>
    Math.hypot(mx - q.x0, my - q.y0) - Math.hypot(mx - p.x0, my - p.y0));

  for (const e of order) {
    const dx = mx - e.x0, dy = my - e.y0;
    /* Rotated to the ray, and never upside down. A bearing written back to
     * front is a bearing you read twice. */
    let ang = Math.atan2(dy, dx);
    if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
    const h2 = 15, w2 = e.tw + 10;

    const vis = clipSeg(e.x0, e.y0, mx, my, PAD, PAD, W - PAD, HH - PAD);
    if (!vis) continue;               // none of this ray is on screen

    /* Candidates run along the VISIBLE piece, starting near its own end and
     * stepping towards M1 — the near end is where the two rays are furthest
     * apart, so it is where the labels are least likely to want the same
     * piece of screen. */
    const at = k => vis.t0 + (vis.t1 - vis.t0) * k;
    let best = null, firstFit = null;
    for (const k of [0.22, 0.14, 0.32, 0.08, 0.44, 0.04, 0.56, 0.68, 0.80, 0.92,
                     0.27, 0.37, 0.50, 0.62, 0.74, 0.86, 0.96, 0.18, 0.11]) {
      const fr = at(k);
      const cx = e.x0 + dx * fr, cy = e.y0 + dy * fr;
      const box = aabb(cx, cy, w2, h2, ang);
      if (!inView(box)) continue;
      if (!firstFit) firstFit = { cx, cy, box };
      if (placed.some(q => overlap(q, box))) continue;
      best = { cx, cy, box };
      break;
    }
    /* Nothing clear: take the first position that at least fits on the map.
     * A number written over something is still readable; one written off the
     * edge is not there at all. */
    if (!best) best = firstFit;
    /* And if NOTHING along the ray fits — a short visible stub near a corner,
     * which is what a hard zoom leaves you with — put it at the middle of that
     * stub and slide it back onto the map. It is then a hair off the line
     * rather than on it, which is the smallest possible concession: the
     * alternative is dropping the number entirely, and a third of frames at
     * high zoom were doing exactly that. */
    if (!best) {
      const fr = at(0.5);
      let cx = e.x0 + dx * fr, cy = e.y0 + dy * fr;
      const box0 = aabb(cx, cy, w2, h2, ang);
      cx += Math.max(0, PAD - box0.x) - Math.max(0, box0.x + box0.w - (W - PAD));
      cy += Math.max(0, PAD - box0.y) - Math.max(0, box0.y + box0.h - (HH - PAD));
      best = { cx, cy, box: aabb(cx, cy, w2, h2, ang) };
    }
    placed.push(best.box);

    ctx.save();
    ctx.translate(best.cx, best.cy);
    ctx.rotate(ang);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 11px "Share Tech Mono", monospace';
    /* A halo rather than a plate. A plate here would hide the very line the
     * label is meant to be sitting on, and the point of the move is that the
     * text and its ray are one object. The halo is heavy enough to punch the
     * dashes out from under the glyphs and nothing more. */
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = MAP_INK.halo;
    ctx.strokeText(e.txt, 0, 0);
    ctx.fillStyle = END_LEG_INK[e.key];
    ctx.fillText(e.txt, 0, 0);
    ctx.restore();
  }

  // Where they landed, so "never on the chip, never on each other" can be
  // checked against real frames rather than eyeballed.
  rd._endLabels = { chip: chip ? { x: chip.bx, y: chip.by, w: chip.bw, h: chip.bh } : null,
                    boxes: placed.slice(chip ? 1 : 0) };

  ctx.restore();
}

/* ── gate bias ──────────────────────────────────────────────────────────────
 *
 * A gate is two marks and they are almost never square to the wind. Rounding
 * the favoured one puts you further along the next leg before you have sailed a
 * metre of it, and that head start is worth knowing at the top of the leg
 * rather than working out on the approach.
 *
 * The measure is the one sailors use: project both marks onto the axis of the
 * leg you are about to sail and take the difference. For a leeward gate the
 * next leg is a beat, so the mark further UPWIND wins; for a windward gate the
 * next leg is a run, so the mark further DOWNWIND wins. Nothing here is about
 * where the boat currently is — the bias belongs to the gate and the wind.
 *
 * Which gates count is the same question the laylines answer, so it is asked in
 * the same place: laylineTargets() gives the live pair by the leg, and each
 * target now carries its element so both marks can be reached.
 *
 * LEFT and RIGHT are named from the boat approaching, not from the screen —
 * which is what a crew means by "the left gate". Coming down to a leeward gate
 * you are facing down the course, so the mark on the LEFT of the screen is your
 * RIGHT-hand mark; at the windward gate, approached the other way, screen-left
 * is your left. One cross product against the leg's own approach bearing gives
 * both cases, and it is the same rule the next-leg route uses to label its
 * branches, so the two overlays cannot disagree about which mark is which.
 */
const GATE_BIAS = { on: true, source: 'both', dampSec: 20 };
const GATE_BIAS_PX = 64;          // how far off the gate the number sits
const GATE_BIAS_EVEN_M = 1;       // below this it is not a bias, it is noise

/* The wind behind the bias, from any combination of sources.
 *
 * This one wants a wider choice than the other overlays. A gate's bias is a
 * fact about the water AT the gate, so the mark boats sitting on it are the
 * best witnesses there are — but mark wind is thin in this archive, and the
 * boat you are watching is somewhere else on the course. So the sets are
 * offered separately and together, and every one of them goes through the same
 * fault gate, the same robust circular mean and the same settling as everything
 * else, so switching source changes the evidence and not the method.
 */
const WIND_SETS = {
  race: null,                      // the race average, straight through
  mark: { marks: true },
  boat: { boat: true },
  both: { marks: true, boat: true },
  all:  { marks: true, boats: true },
  // Everything, minus whatever is unticked in WIND SOURCES. Same evidence pool
  // as `all`, then one filter — so switching between them changes the set of
  // instruments and nothing else about how they are read.
  selected: { marks: true, boats: true, pick: true },
};

/* One wind resolver for the overlays that want a choice of evidence. Every set
 * goes through the same fault gate, the same robust circular mean and the same
 * settling, so choosing a source changes what is being listened to and not how
 * it is listened to. */
function pickWind(rd, t, focus, source, dampSec) {
  const race = !rd.wind || rd.wind.twd == null ? null
             : { twd: rd.wind.twd, tws: rd.wind.tws, from: 'race' };
  if (source === 'race') return race;
  const sets = WIND_SETS[source] || WIND_SETS.both;
  const sec = Math.max(1, dampSec);
  const ref = rd.wind ? rd.wind.twd : null;

  const dirs = [], spds = [], ages = [], wts = [];
  const take = (ts, twds, twss, n) => {
    for (let i = 0; i < n; i++) {
      if (!(ts[i] > t - sec && ts[i] <= t)) continue;
      const k = windWeight(rd, twds[i], twss[i]);
      if (k > 0) { dirs.push(twds[i]); spds.push(twss[i]);
                   ages.push(t - ts[i]); wts.push(k); }
    }
  };
  const ok = (kind, name) => !sets.pick || windPicked(kind, name);
  if (sets.marks)
    for (const m of (rd.markWind || []))
      if (ok('mark', m.name)) take(m.t || [], m.twd, m.tws, (m.t || []).length);
  if (sets.boat && rd.tracks[focus] && ok('boat', focus)) {
    const tr = rd.tracks[focus];
    take(tr.t, tr.raw.twd, tr.raw.tws, tr.n);
  }
  if (sets.boats)
    for (const team of rd.teams) {
      const tr = rd.tracks[team];
      if (tr && ok('boat', team)) take(tr.t, tr.raw.twd, tr.raw.tws, tr.n);
    }

  const w = windSettle(robustWind(dirs, spds, ages, sec, ref, wts), sec, ref);
  if (w) return { ...w, from: w.held ? 'race' : source };
  // Nothing usable in the window — the race average, flagged as held, rather
  // than no number at all. A gate bias that blinks out every time a masthead
  // faults is worse than one that leans on the average for a few seconds.
  return race && { ...race, held: true };
}

/* One entry per live gate: which mark is favoured, by how much, and where to
 * write it. */
function gateBiasAt(rd, t, focus) {
  if (!rd.frame || typeof laylineTargets !== 'function') return [];
  const w = pickWind(rd, t, focus, GATE_BIAS.source, GATE_BIAS.dampSec);
  if (!w || w.twd == null) return [];
  const boat = focus && rd.tracks[focus] ? sampleAt(rd.tracks[focus], t) : null;

  const out = [];
  for (const g of laylineTargets(rd, w.twd, boat)) {
    const el = g.el;
    if (!el || !el.p1 || !el.p2) continue;         // a gate, or nothing to bias
    const c = { rx: (el.p1.rx + el.p2.rx) / 2, ry: (el.p1.ry + el.p2.ry) / 2 };

    // The axis of the leg you are about to sail: away from the wind out of a
    // gate you came up to, into it out of one you came down to.
    const up = g.name === 'TOP';                   // approached upwind
    const dir = headVec(rd, up ? (w.twd + 180) % 360 : w.twd);

    // Metres of the next leg already made good by rounding p1 rather than p2.
    const gain = (el.p1.rx - el.p2.rx) * dir.rx + (el.p1.ry - el.p2.ry) * dir.ry;
    const fav = gain > 0 ? el.p1 : el.p2;

    // Left or right as the boat coming into this gate sees them.
    const a = headVec(rd, g.ap);
    const side = (a.rx * (fav.ry - c.ry) - a.ry * (fav.rx - c.rx)) > 0 ? 'L' : 'R';

    out.push({ gate: g, c, dir, side, m: Math.abs(gain), wind: w,
               name: g.name, up });
  }
  return out;
}

function drawGateBias(ctx, rd, t, tX, tY, W, H, focus) {
  if (!GATE_BIAS.on) return;
  let list = [];
  try { list = gateBiasAt(rd, t, focus); } catch { return; }
  if (!list.length) return;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const b of list) {
    const x = tX(b.c.rx, b.c.ry), y = tY(b.c.rx, b.c.ry);
    // OUTSIDE the gate: below a leeward gate, above a windward one — the side
    // you are not sailing to, so the number never lands on the laylines, the
    // zone rings or the route running out of the same marks. Offset in pixels
    // rather than metres so it keeps its distance at every zoom.
    const sx = tX(b.c.rx + b.dir.rx, b.c.ry + b.dir.ry) - x, sy = tY(b.c.rx + b.dir.rx, b.c.ry + b.dir.ry) - y;
    const L = Math.hypot(sx, sy) || 1;
    // Kept inside the frame. A gate near the edge of the view would otherwise
    // push its own number off the top or the bottom, which is the moment you
    // most want it — it is the gate you are closing on.
    const px = Math.max(34, Math.min(W - 34, x - (sx / L) * GATE_BIAS_PX));
    const py = Math.max(16, Math.min(H - 16, y - (sy / L) * GATE_BIAS_PX));

    const even = b.m < GATE_BIAS_EVEN_M;
    const txt = even ? 'EVEN' : `${b.side}${Math.round(b.m)}m`;
    const col = even ? NEXT_INK.null : (b.side === 'L' ? NEXT_INK.LEFT : NEXT_INK.RIGHT);

    ctx.font = '700 19px "Share Tech Mono", monospace';
    ctx.lineWidth = 4;
    ctx.strokeStyle = MAP_INK.halo;
    ctx.globalAlpha = 1;
    ctx.strokeText(txt, px, py);
    ctx.fillStyle = col;
    ctx.fillText(txt, px, py);

    // A held wind is the race average standing in, and a bias computed off it
    // is a different claim from one computed off the gate. Say so, quietly.
    if (b.wind.held) {
      ctx.font = '9px "Share Tech Mono", monospace';
      ctx.fillStyle = MAP_INK.faint;
      ctx.fillText('held', px, py + 15);
    }
  }
  ctx.restore();
}

function drawNextLeg(ctx, rd, t, tX, tY, W, H, focus) {
  if (!ROUTE.on && !ROUTE.next) return;
  const r = bounceState(rd, t, focus);
  if (!r) return;
  // This leg's manoeuvre names the switch button; the NEXT leg's names its own
  // count. They are usually different words.
  const wordNext = r.runningNext ? 'GYBE' : 'TACK';

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.font = '700 10px "Share Tech Mono", monospace';
  ctx.textBaseline = 'middle';

  // Cheapest of a pair, so one of them can be drawn bold. Turns first,
  // distance to break the tie: a manoeuvre costs far more than the metres it
  // saves.
  const pick = list => list.reduce((a, x) => !a || x.tacks < a.tacks ||
    (x.tacks === a.tacks && x.dist < a.dist) ? x : a, null);

  const stroke = (leg, col, bold, dash) => {
    ctx.setLineDash(dash);
    ctx.strokeStyle = col;
    ctx.globalAlpha = bold ? 0.85 : 0.4;
    ctx.lineWidth = bold ? 2 : 1.4;
    ctx.beginPath();
    leg.pts.forEach((p, i) => i ? ctx.lineTo(tX(p.rx, p.ry), tY(p.rx, p.ry))
                                : ctx.moveTo(tX(p.rx, p.ry), tY(p.rx, p.ry)));
    ctx.stroke();
    // A dot at each turn. Not at the mark, which is drawn already and is not a
    // decision.
    ctx.setLineDash([]);
    ctx.globalAlpha = bold ? 1 : 0.55;
    ctx.fillStyle = col;
    for (let i = 1; i < leg.pts.length - 1; i++) {
      const p = leg.pts[i];
      if (Math.hypot(leg.mark.rx - p.rx, leg.mark.ry - p.ry) < 1) continue;
      ctx.beginPath();
      ctx.arc(tX(p.rx, p.ry), tY(p.rx, p.ry), bold ? 2.8 : 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  const label = (txt, col, at, align, dx, dy, bold) => {
    ctx.setLineDash([]);
    ctx.textAlign = align;
    const x = tX(at.rx, at.ry) + dx, y = tY(at.rx, at.ry) + dy;
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    ctx.strokeStyle = MAP_INK.halo;
    ctx.strokeText(txt, x, y);
    ctx.fillStyle = col;
    ctx.globalAlpha = bold ? 1 : 0.7;
    ctx.fillText(txt, x, y);
  };

  // THIS leg, solid. No turn count: on the leg you are already sailing the
  // question is which way to go, not how much it costs to get there, and the
  // number was just something else to read past.
  if (ROUTE.on && r.routes.length) {
    const best = pick(r.routes.map(x => x.now));
    for (const rt of r.routes) {
      const col = ROUTE_INK[rt.label] || ROUTE_INK.null;
      const bold = r.routes.length > 1 && rt.now === best;
      stroke(rt.now, col, bold, []);
      const bits = [rt.label];
      if (rt.gate) bits.push(rt.gate);
      bits.push(`${Math.round(rt.now.dist)} m`);
      label(bits.join(' · '), col, rt.now.mark, 'center', 0,
            rt.label === 'HOLD' ? -28 : 42, bold);
    }
  }

  // THE NEXT leg, dashed, one from each gate mark — and here the count is the
  // point: what each gate costs you on the leg after it.
  if (ROUTE.next && r.nexts.length) {
    const best = pick(r.nexts);
    /* Which side of the gate each label sits on is a SCREEN question.
     *
     * It used to be taken from the branch's name — LEFT pushed its text left,
     * RIGHT pushed it right — but LEFT and RIGHT are the approaching boat's
     * hands, not the viewport's. Rotate the map, or come at the gate from the
     * other end of the course, and the LEFT branch's mark is on the right of
     * the screen with its label shoved back across the gate on top of the other
     * one. Reading the direction off the marks' own screen positions keeps each
     * label outboard of the mark it belongs to, whichever way round they land.
     *
     * The gap grows as the gate shrinks: zoomed in there is room to sit close,
     * zoomed out the two marks are a few pixels apart and a 34 px offset puts
     * both labels in the same thicket. */
    const fx = n => tX(n.from.rx, n.from.ry);
    const midX = r.nexts.reduce((a, n) => a + fx(n), 0) / r.nexts.length;
    const gatePx = r.nexts.length > 1
      ? Math.abs(fx(r.nexts[0]) - fx(r.nexts[1])) : 999;
    const gap = Math.max(34, Math.min(120, 150 - gatePx));
    for (const nx of r.nexts) {
      const col = NEXT_INK[nx.label] || NEXT_INK.null;
      const bold = r.nexts.length > 1 && nx === best;
      stroke(nx, col, bold, [7, 5]);
      const bits = [];
      if (nx.label) bits.push(nx.label);
      if (nx.tackOut) bits.push(nx.tackOut);
      bits.push(`${nx.tacks} ${wordNext}${nx.tacks === 1 ? '' : 'S'}`);
      bits.push(`${Math.round(nx.dist)} m`);
      // Anchored at the gate mark it leaves from — both branches END at the
      // same point, and the marks are what tell them apart. Outward from its
      // own mark and well clear of it: at the zoom you actually watch a
      // rounding at, the gate is a cluster of buoys, zones and rounding marks,
      // and a label tucked against it is a label inside a thicket.
      ctx.font = '700 13px "Share Tech Mono", monospace';
      const outward = r.nexts.length > 1 ? (fx(nx) <= midX ? -1 : 1)
                                         : (nx.label === 'LEFT' ? -1 : 1);
      // The two are still staggered vertically so they cannot collide even
      // when the gate is edge-on and both labels want the same side.
      const dy = outward < 0 ? 30 : 54;
      label(bits.join(' · '), col, nx.from, outward < 0 ? 'right' : 'left',
            outward * gap, dy, bold);
      ctx.font = '700 10px "Share Tech Mono", monospace';

      // The clock on the first board: how long from the mark until the
      // corridor makes you turn — or, on the rare leg that lays outright,
      // until the mark. Big, because it is the number you are counting down as
      // you round, and placed on the run it belongs to.
      // No lower cut-off: a first run of two seconds means turn almost at once,
      // which is exactly when you want to be told, and a suppressed clock is
      // indistinguishable from a broken one.
      if (nx.firstSec != null) {
        ctx.font = '700 24px "Share Tech Mono", monospace';
        ctx.textAlign = 'center';
        const fx = tX(nx.firstAt.rx, nx.firstAt.ry), fy = tY(nx.firstAt.rx, nx.firstAt.ry) - 16;
        const secs = `${Math.round(nx.firstSec)}s`;
        ctx.globalAlpha = 1;
        ctx.lineWidth = 4;
        ctx.strokeStyle = MAP_INK.halo;
        ctx.strokeText(secs, fx, fy);
        ctx.fillStyle = col;
        ctx.globalAlpha = bold ? 1 : 0.75;
        ctx.fillText(secs, fx, fy);
        ctx.font = '700 10px "Share Tech Mono", monospace';
      }
    }
  }
  ctx.restore();
}

/* ── crosswind ──────────────────────────────────────────────────────────────
 *
 * The crosswind line is the ladder rung: the line square to the wind through a
 * boat. Two boats on the same rung are level no matter how far apart they are
 * across the course, and the gap between two rungs is the only honest answer to
 * "am I ahead?" on a beat or a run. Bow-to-bow and distance-to-mark both
 * flatter whoever happens to be nearer the middle, and both change when the
 * boats converge without either having gained a metre.
 *
 * AUTO CROSS picks who to measure against: the boat closest to YOUR RUNG — the
 * smallest gap along the wind, not the smallest gap across the course. That is
 * the boat you are level with, and therefore the boat you are about to meet.
 * Picking the laterally nearest boat instead answers a different question and
 * usually lands on someone half a leg ahead of you.
 *
 * Ahead is signed by the leg, not by the wind: upwind is ahead on a beat and
 * behind on a run, and the leg number says which one this is.
 *
 * On OPPOSITE TACKS the two boats are converging, so the plate also carries the
 * seconds until their paths cross — the intersection of the two current
 * courses, at their current speeds. Same tack, no crossing, no number.
 *
 * WIND is its own setting here, and it defaults to the race TWD — the number on
 * the compass rose. A rung is a line you are asked to read a metre off, and a
 * masthead TWD at 1 Hz swings it several degrees a second: the line ends up
 * moving more than the boats do. The live sources are still offered, with their
 * own damping, but they are a choice rather than the default.
 */
const CROSS = { on: false, auto: true, source: 'race', dampSec: 30, rangeM: 80 };

/* How far clear of my own hull the gain plate sits, before its own size is
 * added. Enough to miss the boat, its speed label and its focus halo. */
const CROSS_GAIN_CLEAR = 40;
const CROSS_AHEAD = '#3ddc84';
const CROSS_BEHIND = '#ff4d5e';
/* The clock is deliberately neutral rather than green or red — but neutral has
 * to mean something on both grounds. A near-white number is invisible on light
 * water, which is the one place this plate is hardest to read anyway. */
const crossTimeInk = () => MAP_INK.light ? '#243546' : '#dfe9f5';

/* The wind the rungs are squared to.
 *
 * 'race' is `rd.wind`, the race TWD the compass rose shows — one number for the
 * whole race, which is what makes the rung hold still. The other two are the
 * live sources, vector-averaged over dampSec, which is the same treatment the
 * laylines give them. */

/* The settled wind, for any overlay that needs one.
 *
 * Both the crosswind rung and the route ask the same question — what is the
 * wind, right now, damped — and they had better not get different answers, so
 * they ask it through the same function with their own source and damping.
 *
 * Every sample is weighted by how much of a wind reading it still looks like
 * (windWeight), the window is reduced by a smooth robust estimator rather than
 * a mean (robustWind), and the result is eased towards the race TWD by how much
 * the window is actually worth (windSettle) — thin because the readings are
 * barely credible, or thin because there are hardly any of them, which after a
 * gap in the track is not a fault at all. Nothing anywhere in that chain steps.
 */
function settledWind(rd, t, focus, source, dampSec) {
  const race = rd.wind.twd == null ? null : { twd: rd.wind.twd, tws: rd.wind.tws,
                                              from: 'race' };
  if (source === 'race') return race;
  const sec = Math.max(1, dampSec);
  const ref = rd.wind ? rd.wind.twd : null;

  /* The ticked instruments, marks and boats together. It leans on pickWind
   * rather than repeating the gather here, because the two must not drift: the
   * whole promise of the source picker is that every overlay set to SELECTED
   * SOURCES is listening to the same instruments. Asked before the no-track
   * guard below, because a selection can be all marks and no boats, and that is
   * a perfectly good answer with nothing on the boat channel. */
  if (source === 'selected') {
    const w = pickWind(rd, t, focus, 'selected', sec);
    return w && { ...w, from: w.held ? 'race' : 'selected' };
  }
  if (!rd.tracks[focus]) return race;

  const reduce = (dirs, spds, ages, wts) =>
    windSettle(robustWind(dirs, spds, ages, sec, ref, wts), sec, ref);

  if (source === 'mark' && (rd.markWind || []).length) {
    const dirs = [], spds = [], ages = [], wts = [];
    for (const m of rd.markWind)
      for (let i = 0; i < (m.t || []).length; i++) {
        if (!(m.t[i] > t - sec && m.t[i] <= t)) continue;
        const k = windWeight(rd, m.twd[i], m.tws[i]);
        if (k > 0) { dirs.push(m.twd[i]); spds.push(m.tws[i]);
                     ages.push(t - m.t[i]); wts.push(k); }
      }
    const w = reduce(dirs, spds, ages, wts);
    if (w) return { ...w, from: w.held ? 'race' : 'marks' };
    return race && { ...race, held: true };
  }
  if (source === 'boat') {
    const tr = rd.tracks[focus];
    const dirs = [], spds = [], ages = [], wts = [];
    for (let i = 0; i < tr.n; i++) {
      if (!(tr.t[i] > t - sec && tr.t[i] <= t)) continue;
      const k = windWeight(rd, tr.raw.twd[i], tr.raw.tws[i]);
      if (k > 0) { dirs.push(tr.raw.twd[i]); spds.push(tr.raw.tws[i]);
                   ages.push(t - tr.t[i]); wts.push(k); }
    }
    const w = reduce(dirs, spds, ages, wts);
    if (w) return { ...w, from: w.held ? 'race' : focus };
    return race && { ...race, held: true };
  }
  return race;
}

const crossWindAt = (rd, t, focus) =>
  settledWind(rd, t, focus, CROSS.source, CROSS.dampSec);

/* Seconds until two boats' paths cross, holding course and speed.
 *
 * Both boats are straight lines from here on. Solve for where the lines meet
 * and return how long MY boat takes to get there — that is the clock you are
 * actually running: how long until I am on their track. A crossing behind
 * either boat is not a crossing, parallel courses never meet, and anything
 * further off than CROSS_MAX_S is a coincidence of geometry rather than a
 * situation, so all three return nothing rather than a number.
 */
const CROSS_MAX_S = 300;
function crossSeconds(rd, me, other) {
  const vel = s => {
    if (s.sog == null || s.cog == null) return null;
    const d = rd.frame.r(Math.sin(s.cog * D2R), Math.cos(s.cog * D2R));
    const v = s.sog / 3.6;                       // km/h -> m/s
    return { x: d.rx * v, y: d.ry * v };
  };
  const a = vel(me), b = vel(other);
  if (!a || !b) return null;
  const den = a.x * b.y - a.y * b.x;
  if (Math.abs(den) < 1e-6) return null;         // parallel courses
  const px = other.rx - me.rx, py = other.ry - me.ry;
  const ta = (px * b.y - py * b.x) / den;
  const tb = (px * a.y - py * a.x) / den;
  if (!(ta > 0) || !(tb > 0)) return null;       // the meeting point is astern
  if (ta > CROSS_MAX_S || tb > CROSS_MAX_S) return null;
  return ta;
}

/* Unit vectors in the rotated frame: into the wind, and square to it. */
function crossAxes(rd, twd) {
  const up = rd.frame.r(Math.sin(twd * D2R), Math.cos(twd * D2R));
  return { up, across: { rx: up.ry, ry: -up.rx } };
}

/* The mark this boat is sailing to, from its leg number. Independent of the
 * LAYLINES rail setting — this asks a different question and must not change
 * answer because someone chose to draw every mark. */
function crossNextMark(rd, boat) {
  const els = (rd.course && rd.course.elements) || [];
  const leg = boat && boat.leg != null ? Math.round(boat.leg) : null;
  const el = leg != null ? els[leg] : null;
  if (el && el.type !== 'StartLine')
    return el.p2 ? { rx: (el.p1.rx + el.p2.rx) / 2, ry: (el.p1.ry + el.p2.ry) / 2 }
                 : el.p1;
  return rd.frame.m1R || null;
}

/* +1 when upwind is ahead (a beat), −1 when it is behind (a run). */
function crossSign(rd, boat, twd) {
  const g = crossNextMark(rd, boat);
  if (!g || twd == null) return 1;
  const brg = rd.frame.bearingFromRot(g.rx - boat.rx, g.ry - boat.ry);
  let off = Math.abs(((twd - brg) % 360 + 360) % 360);
  if (off > 180) off = 360 - off;
  return off < 90 ? 1 : -1;
}

/* Pick a boat, or put it back.
 *
 * Selecting turns AUTO CROSS off and makes this boat the crosswind reference
 * AND the boat MY BOAT compares against. Deselecting restores what the overlay
 * was doing before — including leaving it OFF if it was off, because turning
 * something on that you had deliberately turned off is not "restoring".
 */
function pickThreat(team) {
  if (PICK.team === team) {
    PICK.team = null;
    if (PICK.wasOn != null) CROSS.on = PICK.wasOn;
    if (PICK.wasAuto != null) CROSS.auto = PICK.wasAuto;
    PICK.wasOn = PICK.wasAuto = null;
  } else {
    if (!PICK.team) { PICK.wasOn = CROSS.on; PICK.wasAuto = CROSS.auto; }
    PICK.team = team;
    CROSS.on = true;
    CROSS.auto = false;
  }
  syncPanels();
  paintBar();
  rebuild(true);
}

/* ── ensigns ─────────────────────────────────────────────────────────────────
 *
 * Drawn, not typed. The obvious way to put a flag beside a team code is the
 * regional-indicator emoji — two characters, no assets — and it is wrong here:
 * Windows ships no flag glyphs at all, so on half the machines this repo runs
 * on 🇬🇧 renders as the bare letters "GB" sitting next to the letters "GBR".
 * So each one is a handful of shapes on a 60×40 field, which costs about a
 * line of markup per flag and looks the same everywhere.
 *
 * They are drawn to be read at eighteen pixels, not to be correct at a
 * hundred: the Union Jack's saltire is not counterchanged, Brazil has a band
 * but no stars in it, and the crosses are laid on as strokes. At this size the
 * thing that identifies a flag is its colours and its one big shape.
 */
const UJ =
  '<rect width="60" height="40" fill="#012169"/>'
+ '<path d="M0,0L60,40M60,0L0,40" stroke="#fff" stroke-width="8"/>'
+ '<path d="M0,0L60,40M60,0L0,40" stroke="#C8102E" stroke-width="4.6"/>'
+ '<path d="M30,0V40M0,20H60" stroke="#fff" stroke-width="13.3"/>'
+ '<path d="M30,0V40M0,20H60" stroke="#C8102E" stroke-width="8"/>';

/* The canton is the same drawing at half size, which is what a canton is. */
const UJ_CANTON = `<g transform="scale(.5)">${UJ}</g>`;
const star = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff"/>`;

/* An eleven-point leaf, symmetric about x=30. Recognisable at 8 px tall, which
 * is all that is asked of it. */
const MAPLE =
  'M30,5 L32.2,11.5 L37,10.5 L36.3,15.5 L42,13.5 L40.5,18 L46,20.5 L41,23.5 '
+ 'L42.5,26.5 L35.5,25.5 L35,28 L31.6,24.5 L32.6,34 L27.4,34 L28.4,24.5 '
+ 'L25,28 L24.5,25.5 L17.5,26.5 L19,23.5 L14,20.5 L19.5,18 L18,13.5 '
+ 'L23.7,15.5 L23,10.5 L27.8,11.5 Z';

const TEAM_FLAG = {
  AUS: '<rect width="60" height="40" fill="#00247D"/>' + UJ_CANTON
     + star(15, 31, 2.6) + star(44, 9, 1.7) + star(50, 17, 1.9)
     + star(43, 22, 1.7) + star(47, 30, 2.1) + star(39, 15, 1.2),
  BRA: '<rect width="60" height="40" fill="#009B3A"/>'
     + '<path d="M30,4L56,20L30,36L4,20Z" fill="#FEDF00"/>'
     + '<circle cx="30" cy="20" r="9" fill="#002776"/>'
     + '<path d="M21.7,22.6Q30,28.6 38.3,22.6" fill="none" stroke="#fff" stroke-width="2"/>',
  CAN: '<rect width="60" height="40" fill="#fff"/>'
     + '<rect width="15" height="40" fill="#D80621"/>'
     + '<rect x="45" width="15" height="40" fill="#D80621"/>'
     + `<path d="${MAPLE}" fill="#D80621"/>`,
  DEN: '<rect width="60" height="40" fill="#C8102E"/>'
     + '<path d="M20,0V40M0,20H60" stroke="#fff" stroke-width="6.6"/>',
  ESP: '<rect width="60" height="40" fill="#AA151B"/>'
     + '<rect y="10" width="60" height="20" fill="#F1BF00"/>',
  FRA: '<rect width="60" height="40" fill="#fff"/>'
     + '<rect width="20" height="40" fill="#002395"/>'
     + '<rect x="40" width="20" height="40" fill="#ED2939"/>',
  GBR: UJ,
  GER: '<rect width="60" height="40" fill="#DD0000"/>'
     + '<rect width="60" height="13.34" fill="#000"/>'
     + '<rect y="26.66" width="60" height="13.34" fill="#FFCE00"/>',
  /* Not in this archive, but the fleet changes and a missing flag is a hole in
     the row. Cheap to carry. */
  JPN: '<rect width="60" height="40" fill="#fff"/>'
     + '<circle cx="30" cy="20" r="12" fill="#BC002D"/>',
  ITA: '<rect width="60" height="40" fill="#fff"/>'
     + '<rect width="20" height="40" fill="#009246"/>'
     + '<rect x="40" width="20" height="40" fill="#CE2B37"/>',
  NZL: '<rect width="60" height="40" fill="#00247D"/>' + UJ_CANTON
     + '<circle cx="49" cy="10" r="2.4" fill="#fff"/><circle cx="49" cy="10" r="1.5" fill="#CC142B"/>'
     + '<circle cx="43" cy="20" r="2.4" fill="#fff"/><circle cx="43" cy="20" r="1.5" fill="#CC142B"/>'
     + '<circle cx="53" cy="22" r="2.4" fill="#fff"/><circle cx="53" cy="22" r="1.5" fill="#CC142B"/>'
     + '<circle cx="48" cy="32" r="2.4" fill="#fff"/><circle cx="48" cy="32" r="1.5" fill="#CC142B"/>',
  SUI: '<rect width="60" height="40" fill="#D52B1E"/>'
     + '<rect x="26.5" y="9" width="7" height="22" fill="#fff"/>'
     + '<rect x="19" y="16.5" width="22" height="7" fill="#fff"/>',
  SWE: '<rect width="60" height="40" fill="#006AA7"/>'
     + '<path d="M20,0V40M0,20H60" stroke="#FECC00" stroke-width="6.6"/>',
  USA: '<rect width="60" height="40" fill="#fff"/>'
     + [0, 2, 4, 6, 8, 10, 12].map(i =>
         `<rect y="${(i * 40 / 13).toFixed(2)}" width="60" height="3.08" fill="#B31942"/>`).join('')
     + '<rect width="24" height="21.5" fill="#0A3161"/>'
     + [[5, 5], [12, 5], [19, 5], [8.5, 10.7], [15.5, 10.7], [5, 16.4], [12, 16.4], [19, 16.4]]
         .map(([x, y]) => star(x, y, 1.5)).join(''),
};

/* The hairline matters: Canada and Italy are white at their edges and would
 * otherwise bleed into the panel behind them. */
function flagSVG(team) {
  /* An unknown code gets an empty field rather than nothing at all: a blank
     gap where the other rows have a flag reads as a bug, an empty flag reads
     as a flag we do not have. */
  const body = TEAM_FLAG[team]
    || '<rect width="60" height="40" fill="rgba(128,140,155,.22)"/>';
  return '<svg viewBox="0 0 60 40" preserveAspectRatio="none" aria-hidden="true">'
       + body
       + '<rect x=".5" y=".5" width="59" height="39" fill="none" '
       + 'stroke="rgba(0,0,0,.45)" stroke-width="1.6"/></svg>';
}

/* The box, under COURSE on the left.
 *
 * The rows are UPDATED, not rebuilt. Writing innerHTML every frame destroys and
 * recreates each button sixty times a second, and a button that does not
 * survive from mousedown to mouseup cannot be clicked — the first version of
 * this list looked right and could not be used. So each team keeps its element
 * for as long as it is on the list, only the numbers inside it change, and the
 * rows are re-ordered by moving the existing nodes rather than replacing them.
 */
/* ── the pre-start threat ring ───────────────────────────────────────────────
 *
 * Racing, a threat is a boat on your rung: the question is who can take a
 * length off you up the next leg, and the answer lives on the wind axis. In the
 * pre-start it is not that question at all. Inside the box you are turning
 * inside two hundred metres of water with five other boats doing the same, and
 * what matters is where somebody is RELATIVE TO YOUR BOW — a boat on your
 * transom can hook you, a boat on your leeward bow can luff you into the line,
 * and a boat out on your beam can do neither for the next twenty seconds.
 *
 * So this list is a ring, not a ladder. Everything within 200 m, placed by the
 * angle off our own heading, and coloured by what that angle can do to us.
 *
 * The angle is signed to WINDWARD, not to starboard: +90° is ninety degrees up
 * from our line whichever tack we happen to be on. That is what makes one set
 * of sectors work for both entries instead of two mirrored sets.
 */
const PRE_THREAT = {
  radiusM: 200,     // the ring
  /* No avgSec of its own: the closing test and the TAIL/CHASE tag are measured
   * over THREATS.avgSec, the same window the racing list's arrows use and the
   * same one the AVERAGE control sets. Two independent five-second constants
   * with one slider between them is a slider that half works. */
  sternWind: 20,    // windward edge of the critical wedge, off dead astern
  sternLee: 45,     // its leeward edge
  bow: 45,          // the bow sectors, either side of our line
  beam: 135,        // where the beam sectors give way to the stern ones
  follow: 60,       // headings within this are "going the same way"
};

/* Four levels, worst first. The name is what the row says; the key is what the
 * stylesheet colours it with. */
const PRE_LEVELS = {
  4: { key: 'crit', name: 'CRITICAL' },
  3: { key: 'dang', name: 'DANGER' },
  2: { key: 'med',  name: 'MEDIUM' },
  1: { key: 'thr',  name: 'THREAT' },
};

/* Which of the eight wedges an angle falls in.
 *
 * phi is degrees off our own track, signed to WINDWARD — so the wedges do not
 * care which tack we are on, which is what lets one set of geometry serve both.
 * Bow is A/H, quarter is C/F, transom is D/E.
 *
 *        A  0…+45   windward bow          H  0…−45    leeward bow
 *        B +45…+90  windward, fwd of beam G −45…−90   leeward, fwd of beam
 *        C +90…+135 windward quarter      F −90…−135  leeward quarter
 *        D +135…180 windward, astern      E −135…−180 on our transom
 */
function preSector(phi) {
  if (phi >= 0) return phi <= 45 ? 'A' : phi <= 90 ? 'B' : phi <= 135 ? 'C' : 'D';
  return phi >= -45 ? 'H' : phi >= -90 ? 'G' : phi >= -135 ? 'F' : 'E';
}

/* What each wedge is WORTH — and that depends on our own tack, because it is
 * decided by the rights rather than by the geometry.
 *
 * ON PORT we have none. The boat that hurts is the one on our transom and on
 * our line (the hook) and the one on our leeward bow that can luff us, so the
 * danger sits aft and to leeward.
 *
 * ON STARBOARD we hold rights over anyone on port, and the whole picture turns
 * through ninety degrees: the transom stops being the hook, and what matters
 * instead is the boat ABOVE AND BEHIND — the windward quarter and the windward
 * stern — because that is the one place rights cannot help. It can bear down on
 * us and we have nowhere to go. So C and D are the critical pair on starboard
 * where E was on port.
 *
 * 4 CRITICAL (flashes) · 3 DANGER · 2 MEDIUM · 1 THREAT
 */
const PRE_LEVELS_BY_TACK = {
  port: { A: 2, B: 1, C: 1, D: 2, E: 4, F: 1, G: 1, H: 3 },
  stbd: { A: 1, B: 1, C: 4, D: 4, E: 2, F: 1, G: 1, H: 1 },
};

function preLevel(phi, onStbd) {
  const s = preSector(phi);
  /* The one wedge that is not a whole sector. On PORT the critical zone runs
   * from +20° windward round the transom to −45° leeward, so it takes all of E
   * and only the inner sliver of D — the rest of D is a lesser thing. On
   * starboard D is critical end to end and no exception is needed. */
  if (!onStbd && s === 'D' && phi >= 180 - PRE_THREAT.sternWind) return 4;
  return (onStbd ? PRE_LEVELS_BY_TACK.stbd : PRE_LEVELS_BY_TACK.port)[s];
}

function preThreatsAt(rd, t, focus) {
  if (!rd || !rd.frame || !focus || !rd.tracks[focus]) return null;
  const me = sampleAt(rd.tracks[focus], t);
  if (!me) return null;
  const w = crossWindAt(rd, t, focus);
  const twd = w && w.twd != null ? w.twd : null;

  /* The line we are travelling, not the way the bows point. In a pre-start
   * turn they differ by a good ten degrees, and a boat is dangerous relative to
   * where we are GOING. cog when the feed has it, heading when it does not. */
  const myCog = me.cog != null ? me.cog : me.hdg;
  if (myCog == null || twd == null) return null;

  /* Which side of our track is windward. Positive = the wind is off our
   * starboard side, so starboard bearings are the windward ones. This is the
   * same quantity as the logged TWA, and it is taken from the wind rather than
   * from the TWA channel so that a boat with no TWA still places correctly. */
  const windSide = angDiff(twd, myCog) >= 0 ? 1 : -1;

  const brgTo = (a, b) => rd.frame.bearingFromRot(b.rx - a.rx, b.ry - a.ry);
  const back = Math.max(1, THREATS.avgSec);
  const mePrev = sampleAt(rd.tracks[focus], t - back);

  const out = [];
  for (const team of rd.teams) {
    if (team === focus || rd.excluded.has(team)) continue;
    const s = sampleAt(rd.tracks[team], t);
    if (!s) continue;
    const range = Math.hypot(s.rx - me.rx, s.ry - me.ry);
    if (!(range <= PRE_THREAT.radiusM)) continue;

    const phiRaw = angDiff(brgTo(me, s), myCog);   // + to starboard
    const phi = windSide * phiRaw;                 // + to windward
    /* Our own tack, taken from the same windSide the angle is signed by rather
     * than from the TWA channel: it is the identical quantity, it is already
     * computed, and it is never null. Wind off our starboard side = starboard. */
    const level = preLevel(phi, windSide > 0);

    /* Closing, over the same 5 s the racing list uses. Null where the track
     * does not reach back that far rather than computed off a short window. */
    let closing = null, sepPrev = null;
    if (mePrev) {
      const sPrev = sampleAt(rd.tracks[team], t - back);
      if (sPrev) {
        sepPrev = Math.hypot(mePrev.rx - sPrev.rx, mePrev.ry - sPrev.ry);
        closing = range < sepPrev - 0.5 ? true : range > sepPrev + 0.5 ? false : null;
      }
    }

    /* Who is following whom.
     *
     * Astern of the other boat ON THAT BOAT'S OWN HEADING, both of us going the
     * same general way, and the gap shrinking. All three, or it says nothing:
     * two boats converging bow to bow are not a chase in either direction, and
     * a boat astern that is dropping away is not following anybody. The test is
     * run from each boat's own heading rather than from the line between us,
     * because that is what "behind" means to the boat doing the chasing. */
    const theirCog = s.cog != null ? s.cog : s.hdg;
    const sameWay = theirCog != null
      && Math.abs(angDiff(theirCog, myCog)) <= PRE_THREAT.follow;
    let follow = null;
    if (sameWay && closing === true) {
      if (Math.abs(phiRaw) > 90) follow = 'TAIL';                    // they are behind us
      else if (Math.abs(angDiff(brgTo(s, me), theirCog)) > 90) follow = 'CHASE';
    }

    // Positive logged TWA is starboard — verified against the archive.
    const tack = s.twa == null ? null : (s.twa >= 0 ? 'S' : 'P');

    out.push({ team, range, phi, phiRaw, level, closing, follow, tack });
  }

  /* Worst first, and inside a level the nearest first. A list that reorders by
   * distance alone would put a boat drifting across our beam above the one
   * sitting on our transom. */
  out.sort((a, b) => b.level - a.level || a.range - b.range);
  return out;
}

const THR_ROWS = new Map();
let THR_ORDER = '';
let THR_SHAPE = '';       // which list built the rows we are holding

/* The pre-start row. Where they are, how far, and whether the gap is theirs to
 * close — the racing row's questions do not apply, so neither does its shape. */
function renderPreThreats(rd, t, focus, body) {
  const list = preThreatsAt(rd, t, focus);
  let none = body.querySelector('.thnone');
  if (!list || !list.length) {
    for (const [, el] of THR_ROWS) el.remove();
    THR_ROWS.clear(); THR_ORDER = '';
    if (!none) { none = document.createElement('div'); none.className = 'thnone';
                 body.appendChild(none); }
    none.textContent = `nobody within ${PRE_THREAT.radiusM} m`;
    return;
  }
  if (none) none.remove();

  const live = new Set();
  for (const r of list) {
    live.add(r.team);
    let el = THR_ROWS.get(r.team);
    if (!el) {
      el = document.createElement('button');
      el.className = 'thr pre';
      el.dataset.team = r.team;
      el.innerHTML = `<i class="tf">${flagSVG(r.team)}</i>`
                   + '<span class="tm"></span><i class="tk"></i>'
                   + '<svg class="tb" viewBox="-12 -12 24 24" aria-hidden="true">'
                   + '<path d="M0,-9 L5.5,7 L0,3.4 L-5.5,7 Z" fill="currentColor"/></svg>'
                   + '<span class="td"></span><span class="tfl"></span>';
      el.onclick = () => pickThreat(r.team);
      THR_ROWS.set(r.team, el);
      body.appendChild(el);
    }
    const tm = el.querySelector('.tm');
    tm.textContent = r.team;
    tm.style.color = boatColour(rd, r.team);

    /* Starboard green, port red — the way the boats themselves are marked, so
     * there is nothing to translate at the moment you are reading this. */
    const tk = el.querySelector('.tk');
    tk.textContent = r.tack || '';
    tk.className = 'tk' + (r.tack ? ' ' + r.tack : '');

    /* The arrow IS the bearing: it points at them, in our own frame, bow up.
     * A row of words saying "windward quarter" is a row of words you have to
     * turn into a picture; this is the picture. It is rotated by the raw
     * bearing, not the windward-signed one, so it points where they actually
     * are rather than at a mirror image on the other tack. */
    el.querySelector('.tb').style.transform = `rotate(${r.phiRaw.toFixed(1)}deg)`;

    const td = el.querySelector('.td');
    td.innerHTML = `${Math.round(r.range)}<small>m</small>`;
    td.className = 'td' + (r.closing === true ? ' in' : r.closing === false ? ' out' : '');

    el.querySelector('.tfl').textContent = r.follow || '';

    const lv = PRE_LEVELS[r.level];
    el.className = `thr pre lv-${lv.key}` + (PICK.team === r.team ? ' on' : '');
    el.title = `${r.team} — ${lv.name}, ${Math.round(r.range)} m, `
             + `${Math.abs(r.phi).toFixed(0)}° ${r.phi >= 0 ? 'windward' : 'leeward'} `
             + `of our line` + (r.follow === 'TAIL' ? ', following us'
                              : r.follow === 'CHASE' ? ', we are following them' : '');
  }

  for (const [team, el] of [...THR_ROWS])
    if (!live.has(team)) { el.remove(); THR_ROWS.delete(team); }

  const order = list.map(r => r.team).join('|');
  if (order !== THR_ORDER) {
    for (const r of list) body.appendChild(THR_ROWS.get(r.team));
    THR_ORDER = order;
  }
}

function renderThreats(rd, t, focus) {
  const box = $('threatbox'), body = $('threatBody');
  if (!box || !body) return;
  if (!THREATS.on || !rd || !rd.frame) { box.hidden = true; return; }
  box.hidden = false;

  /* Two lists, one box. The rows are built for the shape they are in and are
   * updated in place thereafter, so crossing the gun has to throw them away
   * rather than try to reuse a racing row as a pre-start one. */
  const shape = MODE.now === 'pre' ? 'pre' : 'race';
  if (shape !== THR_SHAPE) {
    for (const [, el] of THR_ROWS) el.remove();
    THR_ROWS.clear(); THR_ORDER = '';
    const n = body.querySelector('.thnone'); if (n) n.remove();
    THR_SHAPE = shape;
  }
  const h2 = box.querySelector('h2');
  if (h2) h2.textContent = shape === 'pre' ? 'THREATS · 200 m' : 'POTENTIAL THREATS';
  if (shape === 'pre') return renderPreThreats(rd, t, focus, body);

  const list = threatsAt(rd, t, focus);

  let none = body.querySelector('.thnone');
  if (!list || !list.length) {
    for (const [, el] of THR_ROWS) el.remove();
    THR_ROWS.clear(); THR_ORDER = '';
    if (!none) {
      none = document.createElement('div');
      none.className = 'thnone';
      body.appendChild(none);
    }
    none.textContent = `nobody within ${THREATS.radiusM} m of your rung`;
    return;
  }
  if (none) none.remove();

  /* Two arrows facing each other for closing, back to back for opening. The
   * pair is the picture; the metres beside it are the measurement. */
  /* Plain arrows, not the arrow-to-bar glyphs: ⇥⇤ and ⇤⇥ are correct and
   * unreadable at 11 px, where they turn into a pair of dashes. */
  const conv = c => c === true ? ['cv in', '▶◀']
              : c === false ? ['cv out', '◀▶']
              : ['cv', '··'];
  const trend = x => x == null ? ['tr', '']
              : x > 0 ? ['tr up', '▲']
              : x < 0 ? ['tr dn', '▼'] : ['tr flat', '▬'];

  const live = new Set();
  for (const r of list) {
    live.add(r.team);
    let el = THR_ROWS.get(r.team);
    if (!el) {
      el = document.createElement('button');
      el.className = 'thr';
      el.dataset.team = r.team;
      /* The ensign is set once, with the row. A boat's nationality is the one
       * thing on this line that cannot change while the race is running, so it
       * has no business being rewritten sixty times a second with the rest. */
      el.innerHTML = `<i class="tf">${flagSVG(r.team)}</i>`
                   + '<span class="tm"></span><i class="cv"></i><span class="ti"></span>'
                   + '<i class="tr"></i><span class="td"></span>';
      el.onclick = () => pickThreat(r.team);
      THR_ROWS.set(r.team, el);
      body.appendChild(el);
    }
    const ahead = r.dist >= 0;
    const [cc, ct] = conv(r.converging), [tc, tt] = trend(r.trend);
    const tm = el.querySelector('.tm');
    tm.textContent = r.team;
    tm.style.color = boatColour(rd, r.team);
    const cv = el.querySelector('.cv'); cv.className = cc; cv.textContent = ct;
    el.querySelector('.ti').innerHTML =
      r.secs == null ? '' : `${Math.round(r.secs)}<small>s</small>`;
    const tr = el.querySelector('.tr'); tr.className = tc; tr.textContent = tt;
    const td = el.querySelector('.td');
    td.className = 'td ' + (ahead ? 'up' : 'dn');
    td.innerHTML = `${Math.abs(r.dist).toFixed(0)}<small>m</small>`;
    el.classList.toggle('on', PICK.team === r.team);
    /* Inside the flash radius the row pulses. A boat this close to your rung is
     * the one thing on this panel you must not miss while you are looking at
     * the map, and a colour alone does not fetch the eye off a moving picture —
     * movement does. It is a slow pulse rather than a blink, and it stops
     * entirely for anyone who has asked the system for reduced motion, where
     * the row holds the lit state instead. */
    el.classList.toggle('close', Math.abs(r.dist) <= THREATS.flashM);
    el.title = `${r.team} — ${Math.abs(r.dist).toFixed(0)} m `
             + `${ahead ? 'behind you' : 'ahead of you'} on the rung`;
  }

  for (const [team, el] of [...THR_ROWS])
    if (!live.has(team)) { el.remove(); THR_ROWS.delete(team); }

  /* Re-order only when the order has actually changed. appendChild MOVES an
   * existing node rather than replacing it, so a row keeps its identity — but
   * doing it on every frame would still shuffle the list under the pointer for
   * no reason. */
  const order = list.map(r => r.team).join('|');
  if (order !== THR_ORDER) {
    for (const r of list) body.appendChild(THR_ROWS.get(r.team));
    THR_ORDER = order;
  }
}

/* ── potential threats ───────────────────────────────────────────────────────
 *
 * Every boat inside 80 m of your ladder rung, nearest first — the ones that can
 * actually take something off you in the next half minute.
 *
 * The crosswind overlay answers this for ONE boat, the one it picks. In a fleet
 * of seven that leaves five you are not being told about, and the boat about to
 * cost you is not always the one nearest your rung. So the same rung arithmetic
 * is run against everybody and the answers are listed.
 *
 * Per boat:
 *   dist       metres up or down the rung — ahead positive, behind negative
 *   trend      is that number improving or not, over a 5 s window rather than
 *              frame to frame, because a rung gain wobbles with every wave
 *   converging is the SEPARATION closing, over the same window
 *   secs       when the two tracks actually cross, and only when they do —
 *              opposite tacks, ahead of both boats, inside CROSS_MAX_S
 *
 * Converging and the crossing time are deliberately separate questions. Two
 * boats on the same tack can be closing without ever crossing, and two on
 * opposite tacks can have crossed already; a picture that fused them would say
 * "converging" about a boat you have just sailed past.
 */
const THREATS = { on: true, radiusM: 80, rangeM: 0, flashM: 20, avgSec: 5 };

/* The boat you picked off the list, and what the crosswind overlay was doing
 * before you picked it — so deselecting can put it back exactly. A pick turns
 * AUTO CROSS off; if the overlay itself was off before, it goes back off. */
const PICK = { team: null, wasOn: null, wasAuto: null };

function threatsAt(rd, t, focus) {
  if (!rd || !rd.frame || !focus || !rd.tracks[focus]) return null;
  const me = sampleAt(rd.tracks[focus], t);
  if (!me) return null;
  const w = crossWindAt(rd, t, focus);
  if (!w || w.twd == null) return null;
  const ax = crossAxes(rd, w.twd);
  const sign = crossSign(rd, me, w.twd);
  const rung = (a, b) => sign * ((a.rx - b.rx) * ax.up.rx + (a.ry - b.ry) * ax.up.ry);

  const back = Math.max(1, THREATS.avgSec);
  const mePrev = sampleAt(rd.tracks[focus], t - back);
  const myLeg = me.leg == null ? null : Math.round(me.leg);

  const out = [];
  for (const team of rd.teams) {
    if (team === focus || rd.excluded.has(team)) continue;
    const s = sampleAt(rd.tracks[team], t);
    if (!s) continue;
    if ((s.leg == null ? null : Math.round(s.leg)) !== myLeg) continue;
    const dist = rung(me, s);
    if (!(Math.abs(dist) <= THREATS.radiusM)) continue;

    /* Level with you is not the same as near you.
     *
     * The rung measures along the WIND axis only, so a boat on the far side of
     * the course reads a rung gain of nothing while being half a kilometre
     * away — it is exactly level and no kind of threat. Measured over the
     * archive, a third of the rows this list produced were boats more than
     * 200 m off and a sixth more than 400 m, out to 1.1 km. So there is a
     * straight-line limit as well as a rung one: a threat has to be both level
     * with you AND near you. */
    const sep = Math.hypot(me.rx - s.rx, me.ry - s.ry);
    // 0 means no cap: the rung is the whole test.
    if (THREATS.rangeM > 0 && !(sep <= THREATS.rangeM)) continue;

    /* The 5 s window. Where the track does not reach back that far — the first
     * seconds of a race — the trend is left null rather than computed off a
     * shorter window that would read as more confident than it is. */
    let trend = null, converging = null;
    const sPrev = sampleAt(rd.tracks[team], t - back);
    if (mePrev && sPrev) {
      const dPrev = rung(mePrev, sPrev);
      if (Math.abs(dist - dPrev) > 0.35) trend = dist > dPrev ? 1 : -1;
      else trend = 0;
      const sepNow = Math.hypot(me.rx - s.rx, me.ry - s.ry);
      const sepPrev = Math.hypot(mePrev.rx - sPrev.rx, mePrev.ry - sPrev.ry);
      converging = sepNow < sepPrev - 0.5 ? true : sepNow > sepPrev + 0.5 ? false : null;
    }

    const opposite = me.twa != null && s.twa != null && (me.twa < 0) !== (s.twa < 0);
    const secs = opposite ? crossSeconds(rd, me, s) : null;
    out.push({ team, dist, trend, converging, opposite, secs, sep });
  }
  out.sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist));
  return out;
}

/* Everything both crosswind layers need, worked out once.
 *
 * Memoised on the frame, because the rungs draw under the boats and the gain
 * draws over them: two calls per frame that must never disagree about which
 * boat is being compared. A cache keyed on the frame keeps them the same
 * answer by construction rather than by both happening to compute it. */
let CROSS_MEMO = null;
function crossState(rd, t, focus) {
  const key = `${t}|${focus}|${CROSS.on}|${CROSS.auto}|${CROSS.source}|${CROSS.dampSec}`;
  if (CROSS_MEMO && CROSS_MEMO.key === key && CROSS_MEMO.rd === rd)
    return CROSS_MEMO.v;
  const v = crossCompute(rd, t, focus);
  CROSS_MEMO = { key, rd, v };
  return v;
}

function crossCompute(rd, t, focus) {
  if (!CROSS.on || !focus || !rd.tracks[focus]) return null;
  const me = sampleAt(rd.tracks[focus], t);
  if (!me) return null;
  const w = crossWindAt(rd, t, focus);
  if (!w || w.twd == null) return null;
  const ax = crossAxes(rd, w.twd);
  const sign = crossSign(rd, me, w.twd);
  const out = { me, twd: w.twd, ax, sign, held: !!w.held,
                other: null, otherTeam: null,
                gain: null, secs: null, opposite: false };

  /* A boat picked off the threat list beats the automatic choice, and beats
   * AUTO CROSS being off: picking a boat IS asking for it to be measured. */
  const rungOf = s2 => sign * ((me.rx - s2.rx) * ax.up.rx + (me.ry - s2.ry) * ax.up.ry);
  if (PICK.team && PICK.team !== focus && rd.tracks[PICK.team]) {
    const s2 = sampleAt(rd.tracks[PICK.team], t);
    if (s2) {
      out.otherTeam = PICK.team;
      out.other = s2;
      out.gain = rungOf(s2);
      out.opposite = me.twa != null && s2.twa != null && (me.twa < 0) !== (s2.twa < 0);
      if (out.opposite) out.secs = crossSeconds(rd, me, s2);
      return out;
    }
  }
  if (!CROSS.auto) return out;

  // The boat closest to MY RUNG, ON THE SAME LEG — and only on the same leg. A
  // boat a leg behind is sailing a different piece of course towards a
  // different mark, so its rung answers a different question and the metres
  // between the two rungs are not a gain over anybody. No same-leg boat means
  // no comparison rather than a wrong one: the rung stays, the number does not
  // appear.
  //
  // Where no leg is known at all — before the gun, after the finish, or in a
  // race harvested before `Leg` was carried — every boat reads null, they all
  // match, and the whole fleet is in scope. That is the honest best available,
  // not a leg filter quietly failing open on some boats and not others.
  /* And within reach.
   *
   * The rung is measured along the WIND only, so a boat on the far side of the
   * course reads a gain of nothing while being half a kilometre away — exactly
   * level with you, and no kind of threat. AUTO CROSS had no limit at all and
   * would happily hand back that boat as "the one that matters": a real frame
   * from Portsmouth had the plate reading 23 m AHEAD OF DEN with DEN 403 m
   * away, while the threat list beside it — which does cap range — had already
   * discarded DEN and was showing NZL at 134 m. Two overlays, one frame,
   * disagreeing about who counts.
   *
   * CROSS RANGE is that cap, in straight-line metres. Nobody in range means no
   * comparison rather than a wrong one, which is the same rule the leg filter
   * above already follows. */
  const myLeg = me.leg == null ? null : Math.round(me.leg);
  const rung = s => sign * ((me.rx - s.rx) * ax.up.rx + (me.ry - s.ry) * ax.up.ry);
  const reach = CROSS.rangeM > 0 ? CROSS.rangeM : Infinity;
  let best = null, bd = Infinity;
  for (const team of rd.teams) {
    if (team === focus || rd.excluded.has(team)) continue;
    const s = sampleAt(rd.tracks[team], t);
    if (!s) continue;
    if ((s.leg == null ? null : Math.round(s.leg)) !== myLeg) continue;
    if (Math.hypot(me.rx - s.rx, me.ry - s.ry) > reach) continue;
    const d = Math.abs(rung(s));
    if (d < bd) { bd = d; best = { team, s }; }
  }
  if (!best) return out;
  out.otherTeam = best.team;
  out.other = best.s;
  out.gain = rung(best.s);
  // Opposite tacks only: same tack the boats are not converging and a line
  // intersection somewhere out on the course is not a cross anyone will sail.
  out.opposite = me.twa != null && best.s.twa != null
              && (me.twa < 0) !== (best.s.twa < 0);
  if (out.opposite) out.secs = crossSeconds(rd, me, best.s);
  return out;
}

/* The rungs themselves, under the boats. */
function drawCrossLines(ctx, rd, t, tX, tY, W, H, focus) {
  const c = crossState(rd, t, focus);
  if (!c) return;
  // The rung's direction on screen. Through the same helper the renderer uses,
  // so the rung turns with the map instead of staying square to a frame the
  // map is no longer aligned with.
  const sd = dirToScreen(c.ax.across.rx, c.ax.across.ry);
  const ux = sd.dx, uy = sd.dy;
  const L = W + H;
  ctx.save();
  // A long dash, deliberately unlike the laylines' short one. Both overlays can
  // be on at once and both draw dashed lines in team-ish colours; if they also
  // shared a dash the map would be four kinds of green line with no way to tell
  // a rung from a layline.
  ctx.setLineDash([26, 12]);
  ctx.font = '700 10px "Share Tech Mono", monospace';
  ctx.textBaseline = 'middle';
  const rung = (s, team, mine) => {
    const x = tX(s.rx, s.ry), y = tY(s.rx, s.ry);
    const col = boatColour(rd, team);
    ctx.strokeStyle = col;
    ctx.lineWidth = mine ? 2 : 1.4;
    ctx.globalAlpha = mine ? 0.85 : 0.55;
    ctx.beginPath();
    ctx.moveTo(x - ux * L, y - uy * L);
    ctx.lineTo(x + ux * L, y + uy * L);
    ctx.stroke();
    // Tag the rung where it leaves the frame, so a line running off the edge is
    // still attributable to a boat that may itself be off screen.
    // My tag sits above the line, theirs below. AUTO CROSS picks the boat
    // closest to my rung, so the two lines are usually nearly on top of each
    // other — which is the point, and would put the two tags on top of each
    // other too if they shared a side.
    const k = ux !== 0 ? (ux > 0 ? -x + 34 : W - x - 34) / ux : 0;
    const lx = x + ux * k, ly = (y + uy * k) + (mine ? -8 : 10);
    if (ly > 12 && ly < H - 12) {
      ctx.save();
      ctx.setLineDash([]);
      ctx.textAlign = ux > 0 ? 'left' : 'right';
      ctx.lineWidth = 3; ctx.strokeStyle = MAP_INK.halo;
      // When the live wind was asked for and rejected, MY tag says so. A rung
      // silently drawn off a different wind than the one selected is the one
      // failure mode of this overlay you would never catch by looking at it.
      const txt = mine && c.held ? team + ' · RACE TWD' : team;
      ctx.strokeText(txt, lx, ly);
      ctx.globalAlpha = mine ? 0.95 : 0.7;
      ctx.fillStyle = col;
      ctx.fillText(txt, lx, ly);
      ctx.restore();
    }
  };
  rung(c.me, focus, true);
  if (c.other) rung(c.other, c.otherTeam, false);
  ctx.restore();
}

/* The gain, over the boats: how far ahead or behind, in metres, halfway
 * between the two. Green ahead, red behind, my boat the reference. */
function drawCrossGain(ctx, rd, t, tX, tY, W, H, focus) {
  const c = crossState(rd, t, focus);
  if (!c || !c.other || c.gain == null) return;
  const mx = tX(c.me.rx, c.me.ry), my = tY(c.me.rx, c.me.ry);

  // Anchored to MY boat, always to WINDWARD of it.
  //
  // It used to sit halfway between the two boats, stepping sideways when they
  // closed up. Halfway is the honest place for a number about a pair — and it
  // is the worst place to put a plate this size, because the whole point of the
  // crosswind overlay is the moment the two boats converge, and that is exactly
  // when halfway lands on top of both of them. Worse, the plate moved as they
  // closed: you had to find it again at the moment you least wanted to look
  // away.
  //
  // Windward of my own boat is somewhere nothing else wants to be. Both boats
  // are sailing away from it, their tracks trail away from it, and the boat
  // being compared is by construction near MY RUNG — which runs square to the
  // wind, so it comes at my boat from the side, not from up there. The plate
  // holds one bearing off one hull for the whole approach.
  const ahead = c.gain >= 0;
  const col = ahead ? CROSS_AHEAD : CROSS_BEHIND;
  // Whole metres, always. The tenth was there for small gaps and was never
  // worth its width: the number is read off a moving map at a glance, the
  // underlying position is not good to a decimetre anyway, and a digit that
  // appears and disappears as the gap crosses 10 m makes the plate change
  // size while you are looking at it.
  const big = `${Math.round(Math.abs(c.gain))} m`;
  const cap = `${ahead ? 'AHEAD OF' : 'BEHIND'} ${c.otherTeam}`;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Seconds to the cross, on opposite tacks. Bare number, no label: it sits
  // under a figure that already carries its unit, and anything that reads as a
  // sentence at 20 px is something you stop and read instead of glance at.
  const secs = c.secs == null ? null : String(Math.round(c.secs));

  // Measured before it is placed, because where windward puts it depends on how
  // big it is: a plate is pushed clear by its own half-width when the wind is
  // across the screen and by its own half-height when the wind is up it.
  ctx.font = '700 30px "Share Tech Mono", monospace';
  const wBig = ctx.measureText(big).width;
  ctx.font = '700 11px "Share Tech Mono", monospace';
  const wCap = ctx.measureText(cap).width;
  ctx.font = '700 20px "Share Tech Mono", monospace';
  const wSec = secs ? ctx.measureText(secs).width : 0;
  const pw = Math.max(wBig, wCap, wSec) + 22, ph = secs ? 86 : 52;

  // `ax.up` points at the wind — the direction you sail to go upwind — and
  // dirToScreen turns it with the map, so this stays windward under COURSE UP
  // as well as NORTH UP.
  const sd = dirToScreen(c.ax.up.rx, c.ax.up.ry);
  const half = (Math.abs(sd.dx) * pw + Math.abs(sd.dy) * ph) / 2;
  let D = CROSS_GAIN_CLEAR + half;

  /* One boat can still be up there: the one being compared. AUTO CROSS picks
   * the boat nearest my rung, and a rung runs square to the wind, so it is
   * normally abeam — but when the gain is large the nearest available boat is a
   * long way up the course, and on a wide zoom that puts it right under the
   * plate. Roughly one frame in twenty, measured.
   *
   * It is pushed FURTHER OUT, never to one side. The bearing off my hull is the
   * one thing that must not move — a plate that keeps its distance but changes
   * which side it is on is the fault this whole change was made to fix — so the
   * only free variable is how far along it sits. */
  const acr = { dx: -sd.dy, dy: sd.dx };
  const along = (ox, oy) => (ox - mx) * sd.dx + (oy - my) * sd.dy;
  const across = (ox, oy) => Math.abs((ox - mx) * acr.dx + (oy - my) * acr.dy);
  const halfAcr = (Math.abs(acr.dx) * pw + Math.abs(acr.dy) * ph) / 2;
  {
    const oxp = tX(c.other.rx, c.other.ry), oyp = tY(c.other.rx, c.other.ry);
    const sA = along(oxp, oyp);
    if (across(oxp, oyp) < halfAcr + 10 && sA + half + 22 > D && sA > 0)
      D = sA + half + 22;
  }

  let x = mx + sd.dx * D;
  // The text baseline sits 18 px below the plate's top edge, so the plate's own
  // centre is what gets placed and y is worked back from it.
  let y = (my + sd.dy * D) + 18 - ph / 2;

  // A plate pushed off the edge is a plate nobody reads. Slide it back on
  // rather than dropping it: the number still belongs to the boat it is nearest
  // to, and losing it at the one moment the boats are hard against the frame
  // would be the overlay failing when it is needed.
  const pad = 6;
  x = Math.max(pw / 2 + pad, Math.min(W - pw / 2 - pad, x));
  y = Math.max(pad, Math.min(H - ph - pad, y - 18)) + 18;
  // Only if MY boat is on screen at all — this is a label on a hull, and a
  // label clamped to the edge for a boat two screens away is just clutter.
  if (mx < -40 || mx > W + 40 || my < -40 || my > H + 40) { ctx.restore(); return; }

  // A plate under it. This lands over hulls, tracks and the wind wash, and a
  // stroked outline alone is not enough contrast against all three.
  ctx.fillStyle = MAP_INK.light ? 'rgba(250,252,255,0.72)' : 'rgba(4,10,18,0.62)';
  ctx.strokeStyle = col;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1.2;
  const rx = x - pw / 2, ry = y - 18, r = 6;
  ctx.beginPath();
  ctx.moveTo(rx + r, ry);
  ctx.arcTo(rx + pw, ry, rx + pw, ry + ph, r);
  ctx.arcTo(rx + pw, ry + ph, rx, ry + ph, r);
  ctx.arcTo(rx, ry + ph, rx, ry, r);
  ctx.arcTo(rx, ry, rx + pw, ry, r);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 0.55;
  ctx.stroke();

  // A leader back to the hull it belongs to. Once the plate stopped floating
  // between the two boats it stopped being obvious whose number it is, and at
  // this distance off the hull a thin line is the cheapest way to say so.
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(mx + sd.dx * 13, my + sd.dy * 13);
  ctx.lineTo(x - sd.dx * half, (y - 18 + ph / 2) - sd.dy * half);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.globalAlpha = 1;
  ctx.fillStyle = col;
  ctx.font = '700 30px "Share Tech Mono", monospace';
  ctx.fillText(big, x, y);
  ctx.font = '700 11px "Share Tech Mono", monospace';
  ctx.globalAlpha = 0.9;
  ctx.fillText(cap, x, y + 22);
  if (secs) {
    // Neutral, not green or red: it is a clock, not a gain, and colouring it
    // like one would say the cross is good news or bad before it happens.
    ctx.font = '700 20px "Share Tech Mono", monospace';
    ctx.fillStyle = crossTimeInk();
    ctx.globalAlpha = 0.95;
    ctx.fillText(secs, x, y + 47);
  }
  ctx.restore();
}

/* Nearest boat on the same tack, which is the only fair thing to compare
 * against: same wind, same waves, same side of the shift. A boat on the other
 * tack is sailing a different piece of water and the numbers do not mean the
 * same thing. */
/* The boat to put beside yours: nearest, on your tack, AND on your leg.
 *
 * Same tack alone is not a fair comparison, and the card was making an unfair
 * one. Tack is only a sign — a boat beating at TWA 65° and a boat running at
 * 116° are both on starboard, and setting 29 km/h against 44 km/h then colouring
 * the difference green says the running boat is going better when it is simply
 * going downwind. The VMG row was worse: +12.6 upwind against −19.4 downwind,
 * compared as though one beat the other.
 *
 * The leg says which of those two things you are doing, so it is the filter
 * that makes the row mean something. It is the same rule AUTO CROSS uses, for
 * the same reason. Where no leg is known at all — before the gun, after the
 * finish, or a race harvested before `Leg` was carried — every boat reads null,
 * they all match, and the comparison falls back to tack alone: the honest best
 * available rather than a filter quietly failing open on some boats and not
 * others.
 */
function nearestSameTack(rd, team, t) {
  const me = sampleAt(rd.tracks[team], t);
  if (!me || me.twa == null) return null;

  /* Picked off the threat list, the boat you chose is the boat you compare
   * against — on your tack or not. The automatic pick is a guess at which boat
   * matters; a pick is you telling it. */
  if (PICK.team && PICK.team !== team && rd.tracks[PICK.team]) {
    const s = sampleAt(rd.tracks[PICK.team], t);
    if (s) return { team: PICK.team, s,
                    dist: Math.hypot(s.rx - me.rx, s.ry - me.ry) };
  }

  /* Capped by CROSS RANGE, the same limit AUTO CROSS uses. This picks the
   * NEAREST boat rather than the one closest to the rung, so it was never as
   * badly wrong — but a card comparing you against a boat four hundred metres
   * away is still a card comparing you against nobody, and the two overlays
   * must not name different boats. */
  const myTack = Math.sign(me.twa);
  const myLeg = me.leg == null ? null : Math.round(me.leg);
  const reach = CROSS.rangeM > 0 ? CROSS.rangeM : Infinity;
  let best = null, bd = Infinity;
  for (const other of rd.teams) {
    if (other === team) continue;
    const s = sampleAt(rd.tracks[other], t);
    if (!s || s.twa == null || Math.sign(s.twa) !== myTack) continue;
    if ((s.leg == null ? null : Math.round(s.leg)) !== myLeg) continue;
    const d = Math.hypot(s.rx - me.rx, s.ry - me.ry);
    if (d > reach) continue;
    if (d < bd) { bd = d; best = { team: other, s, dist: d }; }
  }
  return best;
}

const vmgOf = s => (s.sog == null || s.twa == null)
  ? null : s.sog * Math.cos(s.twa * Math.PI / 180);

/* The race half of MY BOAT: my numbers on the left, the nearest boat on my
 * tack beside them on the right, row for row so the eye compares across rather
 * than hunting. Speed against the polar is the honest headline once the start
 * is over — it says whether the boat is being sailed well, independent of where
 * it happens to be on the course. */
function raceHud(rd, team, s, t) {
  const pol = polarSpeed(rd.polar, s.twa, s.tws);
  const pc = pol && s.sog != null ? s.sog / pol * 100 : null;
  const col = pc == null ? 'var(--ink)'
            : pc >= 98 ? 'var(--green)' : pc >= 92 ? 'var(--ink)' : 'var(--red)';
  const rel = nearestSameTack(rd, team, t);
  const mine = vmgOf(s), theirs = rel ? vmgOf(rel.s) : null;

  // Better or worse, in the sense that matters on this leg: upwind more VMG
  // toward the wind is better, downwind more away from it is.
  const ink = (a, b) => (a == null || b == null) ? ''
    : Math.abs(a) > Math.abs(b) + 0.05 ? 'color:var(--green)'
    : Math.abs(a) < Math.abs(b) - 0.05 ? 'color:var(--red)' : '';
  const n = (v, dp = 1) => v == null ? '—' : v.toFixed(dp);

  const row = (k, a, b, unit, aInk = '', bInk = '') => `
    <div class="rk">${k}</div>
    <div class="ra" style="${aInk}">${a}</div>
    <div class="rb" style="${bInk}">${rel ? b : '—'}</div>
    <div class="ru">${unit}</div>`;

  return `
    <div class="rel">
      <div class="who mine">${team}</div>
      <div class="who them">${rel ? `${rel.team}<em>${rel.dist.toFixed(0)} m</em>`
                                  : '<span class="none">no boat on my tack and leg</span>'}</div>
    </div>
    <div class="big" style="color:${col}">
      <span class="k">SPEED ${pc == null ? '' : '<em>vs polar</em>'}</span>
      <b>${n(s.sog)}</b>
      <span class="u">${pc == null ? 'km/h — no polar for this configuration'
                                   : `${pc.toFixed(0)}% of ${pol.toFixed(1)} km/h target`}</span>
    </div>
    <div class="cmp">
      ${row('SPEED', n(s.sog), rel ? n(rel.s.sog) : '—', 'km/h',
            ink(s.sog, rel && rel.s.sog), ink(rel && rel.s.sog, s.sog))}
      ${row('TWA', s.twa == null ? '—' : s.twa.toFixed(0) + '°',
            rel && rel.s.twa != null ? rel.s.twa.toFixed(0) + '°' : '—',
            s.twa == null ? '' : s.twa < 0 ? 'port' : 'stbd')}
      ${row('TWS', n(s.tws), rel ? n(rel.s.tws) : '—',
            windOK(rd, s.twd, s.tws) ? 'km/h' : 'km/h · suspect',
            windOK(rd, s.twd, s.tws) ? '' : 'opacity:.5',
            rel && windOK(rd, rel.s.twd, rel.s.tws) ? '' : 'opacity:.5')}
      ${row('VMG', n(mine), rel ? n(theirs) : '—', mine == null ? ''
              : mine > 0 ? 'upwind' : 'downwind',
            ink(mine, theirs), ink(theirs, mine))}
    </div>`;
}

function paintStatus() {
  const f = APP.feed;
  const el = $('status');
  if (!f) { el.className = 'status'; el.textContent = 'NO FEED'; return; }
  el.className = `status ${f.status}`;
  el.innerHTML = `<i></i>${f.label} · ${f.status.toUpperCase()}` +
                 (f.note ? ` <em>${f.note}</em>` : '');
}


/* ── the bottom bar ─────────────────────────────────────────────────────── */

function wireBottomBar() {
  $('selEvent').onchange = () => { syncDays(); syncStarts(); openStart($('selStart').value); };
  $('selDay').onchange   = () => { syncStarts(); openStart($('selStart').value); };
  $('selStart').onchange = () => openStart($('selStart').value);
  $('selFocus').onchange = () => { APP.focus = $('selFocus').value || null; };

  $('rPlay').onclick = () => { APP.feed.toggle(); syncPlay(); };
  $('rBack').onclick = () => { APP.feed.seek(APP.feed.tMin); rebuild(true); };
  $('rGoLive').onclick = () => { if (APP.feed && APP.feed.goLive) APP.feed.goLive(); };
  $('rSlider').oninput = e => { APP.feed.seek(+e.target.value); rebuild(true); };
  // A range input keeps focus after the mouse comes up, and the playhead is
  // only written back to the thumb while the thumb is NOT focused — so one
  // click on the scrubber used to freeze it there for good while the race ran
  // on underneath. Hand the focus back when the drag ends.
  $('rSlider').onchange = e => e.target.blur();
  for (const x of [0.5, 1, 2, 4]) {
    $('rSpeed' + String(x).replace('.', '')).onclick = () => {
      APP.feed.setSpeed(x);
      syncSpeed();
    };
  }

  document.addEventListener('keydown', e => {
    // Typing in the filter box or a preset name is typing, not shortcuts.
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;

    // A row waiting for a key eats the next keystroke, whatever it is.
    if (keyCaptureHandled(e)) return;

    if (e.key === 'Escape' && KEYHELP && !KEYHELP.hidden) { keyHelp(false); return; }
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) { e.preventDefault(); keyHelp(); return; }

    /* The toggles come first and do not need a seekable feed: they are about
     * what is drawn, which is as true of a live race as of a replay. */
    const hit = keyEntry(e);
    if (hit) {
      e.preventDefault();
      hit.act();
      syncPanels();
      paintBar();
      rebuild(true);
      if (KEYHELP && !KEYHELP.hidden) keyHelp(true);   // the sheet is a readout
      return;
    }

    const f = APP.feed;
    if (!f || !f.seekable) return;
    // BUTTON is excluded only here: Space on a focused button is that button's
    // own click, and hijacking it would break the menu for keyboard users.
    if (e.key === ' ') {
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault(); f.toggle(); syncPlay();
    }
    else if (e.key === 'ArrowLeft')  { f.pause(); f.seek(f.t - (e.shiftKey ? 5 : 1)); rebuild(true); syncPlay(); }
    else if (e.key === 'ArrowRight') { f.pause(); f.seek(f.t + (e.shiftKey ? 5 : 1)); rebuild(true); syncPlay(); }
  });

  addEventListener('resize', sizeMap);
}

/* ── zoom and pan ───────────────────────────────────────────────────────────
 *
 * The renderer has always taken zoom, panX and panY; nothing had ever offered
 * them to anyone. On a map whose whole job is showing you where boats are, that
 * is the difference between reading the fleet and squinting at it.
 *
 * Zoom is anchored on the cursor rather than the centre. Screen x works out as
 *   sx = W/2 + (rx − cx₀)·s₀·z + panX
 * so holding the point under the cursor still while z changes to z′ needs
 *   panX′ = panX + (sx − W/2 − panX)·(1 − z′/z)
 * and the same on y with its sign flipped. Centre-anchored zoom would send
 * whatever you were looking at off the edge, which is exactly when you were
 * looking at it.
 */
const isFollowView = () =>
  APP.opts.mode === 'boat' || APP.opts.mode === 'boatOffset';

function resetView() {
  APP.opts.zoom = 1;
  APP.opts.panX = 0;
  APP.opts.panY = 0;
  syncRecentre();
}

/* Coming back to the boat is not the same act as throwing the view away.
 *
 * The zoom is a decision — how much water you want to see — and it survives a
 * rounding, a leg and a scrub. The pan is not: it is where you went to look at
 * something, and it is the only thing between you and the boat. So the button
 * in a follow view drops the pan and leaves the zoom exactly where you set it.
 * RESET VIEW, which says what it does, still resets both. */
function recentreView() {
  APP.opts.panX = 0;
  APP.opts.panY = 0;
  syncRecentre();
}

/* Bottom-left of the map: the way back.
 *
 * A drag is a deliberate act — you went to look at something — so nothing
 * should snatch the view back from you on a timer. But the moment you have
 * dragged, the camera is no longer following anything, and the only thing that
 * knows where the boat went is the camera you just left. So the button appears
 * exactly when there is something to go back FROM: a pan, or a zoom off 1. It
 * is not drawn on the canvas, because it has to be clickable and because it is
 * a control, not information. */
function syncRecentre() {
  const el = $('recentre');
  if (!el) return;
  /* What counts as "off" differs by view, because what the button undoes does.
   * Following a boat, a zoom is not off anything — the boat is still centred —
   * so only a pan raises it. Anywhere else the zoom is part of the view the
   * button restores, so it counts. */
  const panned = !!(APP.opts.panX || APP.opts.panY);
  const off = isFollowView() ? panned : (panned || APP.opts.zoom !== 1);
  el.hidden = !off;
  el.textContent = isFollowView() ? 'RECENTRE ON BOAT' : 'RESET VIEW';
}

function wireMapGestures() {
  const c = $('cTrack');

  const rc = $('recentre');
  if (rc) rc.onclick = () => {
    isFollowView() ? recentreView() : resetView();
    syncPanels(false, true);
    draw();
  };
  syncRecentre();

  c.addEventListener('wheel', e => {
    e.preventDefault();
    const z = APP.opts.zoom;
    const z2 = Math.max(0.1, Math.min(12, z * Math.exp(-e.deltaY * 0.0016)));
    if (z2 === z) return;
    /* Zooming on the cursor is right when you are looking AT something — you
     * hold the thing under the pointer still and the rest opens out around it.
     * It is wrong when you are FOLLOWING something: the anchor is already
     * chosen, it is the boat, and cursor-anchored zoom pushes it off centre by
     * writing a pan the camera then has to carry for the rest of the race.
     * So in the follow views the zoom is anchored on the boat and no pan is
     * written at all, and the boat holds its place through every tick. */
    if (!isFollowView()) {
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const k = 1 - z2 / z;
      APP.opts.panX += (sx - r.width / 2 - APP.opts.panX) * k;
      APP.opts.panY -= (r.height / 2 + APP.opts.panY - sy) * k;
    }
    APP.opts.zoom = z2;
    // A light sync: the widgets, not the sections that rebuild their own DOM.
    // A wheel gesture fires dozens of these a second, and a full sync tore
    // down and rebuilt the preset list every tick — which, if you were part
    // way through typing a preset name, took the field with it. ZOOM is
    // noPreset anyway, so none of that work could change anything.
    syncPanels(false, true);
    syncRecentre();
    draw();
  }, { passive: false });

  let drag = null;
  c.style.cursor = 'grab';

  /* Is the pointer on the Z pin, and is the pin willing to be moved? Locked is
   * locked: a confirmed spot must not move because you brushed the canvas while
   * panning, which is the whole reason CONFIRM exists. */
  const overZ = e => {
    if (!ZPT.on || !ZPT.p || ZPT.locked || typeof frameToScreen !== 'function') return false;
    const s = frameToScreen(ZPT.p.rx, ZPT.p.ry);
    if (!s) return false;
    const r = c.getBoundingClientRect();
    return Math.hypot(e.clientX - r.left - s.x, e.clientY - r.top - s.y) <= Z_HIT_PX + 4;
  };

  c.addEventListener('pointerdown', e => {
    if (overZ(e)) {
      drag = { z: true };
      c.setPointerCapture(e.pointerId);
      c.style.cursor = 'grabbing';
      return;
    }
    drag = { x: e.clientX, y: e.clientY, px: APP.opts.panX, py: APP.opts.panY };
    c.setPointerCapture(e.pointerId);
    c.style.cursor = 'grabbing';
  });
  c.addEventListener('pointermove', e => {
    if (!drag) {
      // A cursor that changes over the pin is the only affordance a canvas has.
      c.style.cursor = overZ(e) ? 'move' : 'grab';
      return;
    }
    if (drag.z) {
      const r = c.getBoundingClientRect();
      const p = screenToFrame(e.clientX - r.left, e.clientY - r.top);
      if (p) { ZPT.p = p; draw(); }
      return;
    }
    APP.opts.panX = drag.px + (e.clientX - drag.x);
    APP.opts.panY = drag.py + (e.clientY - drag.y);
    syncRecentre();
    draw();
  });
  const end = () => {
    // Dropping the pin is worth a panel sync — the MY BOAT block and the
    // CONFIRM button both read state that just changed.
    if (drag && drag.z) syncPanels(false, true);
    drag = null; c.style.cursor = 'grab';
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  /* Double-click the pin to CONFIRM it, and again to RESET.
   *
   * The menu button is the discoverable way; this is the one you can reach
   * without leaving the map, which matters because the whole gesture — drag,
   * look, lock — happens out here. Double-click anywhere ELSE still resets the
   * view, so the existing gesture is untouched: the pin is a small target and
   * the test is the same one that decides whether a drag grabs it.
   */
  c.addEventListener('dblclick', e => {
    if (ZPT.on && ZPT.p && typeof frameToScreen === 'function') {
      const sp = frameToScreen(ZPT.p.rx, ZPT.p.ry);
      const r = c.getBoundingClientRect();
      if (sp && Math.hypot(e.clientX - r.left - sp.x, e.clientY - r.top - sp.y) <= Z_HIT_PX + 6) {
        ZPT.locked = !ZPT.locked;
        syncPanels(); draw();
        return;
      }
    }
    resetView(); syncPanels(false, true); draw();
  });
}

/* Put the gun on the scrubber. The windows are not symmetrical about T+0 — this
 * archive runs T−150 to T+90 — so the mark is placed from the race's own range
 * rather than assumed to be centred, and it hides itself entirely if the gun is
 * outside the window rather than clamping to an end and lying about it. */
function placeGunMark(tMin, tMax) {
  const el = $('gunMark');
  const span = tMax - tMin;
  if (!(span > 0) || tMin > 0 || tMax < 0) { el.hidden = true; return; }
  const f = (0 - tMin) / span;
  el.hidden = false;
  el.style.left = `calc(${(f * 100).toFixed(3)}% + ${((0.5 - f) * THUMB_PX).toFixed(2)}px)`;
}

/* The speed buttons are a readout of the feed, not a memory of what was last
 * clicked. Opening a different race builds a fresh ReplayFeed at 1x, and
 * without this the 4x button stayed lit over a replay running at 1x. */
function syncSpeed() {
  const now = APP.feed ? APP.feed.speed : 1;
  for (const x of [0.5, 1, 2, 4]) {
    const b = $('rSpeed' + String(x).replace('.', ''));
    if (b) b.classList.toggle('active', x === now);
  }
}

function syncPlay() {
  if (!APP.feed || !APP.feed.seekable) return;
  $('rPlay').textContent = APP.feed.playing ? 'PAUSE' : 'PLAY';
  $('rPlay').classList.toggle('on', APP.feed.playing);
}

boot();
