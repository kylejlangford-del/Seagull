(() => {
  const MANIFEST_PATH = './manifest.json';
  const CONFIG_KEY = 'seagull-sailshots-config-v1';
  const GAP_WARN_SECONDS = 30 * 60; // 30 minutes

  // ---------- publishing straight to GitHub ----------
  // This page still has no server of its own, but a delete/category/comment
  // edit can publish itself instead of making Kyle download manifest.json
  // and upload it by hand — as long as a GitHub token is on file. The token
  // is a personal access token HE creates and pastes in once (see
  // connectGithub() below); it's kept only in this browser's localStorage
  // and used only for direct browser->api.github.com calls, never sent
  // anywhere else. Without a token, everything falls back to the original
  // download/discard flow further down.
  const GITHUB_OWNER = 'kylejlangford-del';
  const GITHUB_REPO = 'Seagull';
  const GITHUB_BRANCH = 'main';
  const GITHUB_MANIFEST_PATH = 'sail-shots/manifest.json';
  const GITHUB_TOKEN_KEY = 'seagull-sailshots-github-token-v1';
  const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_MANIFEST_PATH}`;

  function getGithubToken() {
    try { return localStorage.getItem(GITHUB_TOKEN_KEY) || ''; } catch { return ''; }
  }
  function setGithubToken(token) {
    try {
      if (token) localStorage.setItem(GITHUB_TOKEN_KEY, token);
      else localStorage.removeItem(GITHUB_TOKEN_KEY);
    } catch { /* localStorage unavailable — token just won't persist across reloads */ }
  }
  // btoa() only handles Latin1 — this widens any UTF-8 (e.g. a comment with
  // a curly quote or emoji) into the byte sequence btoa expects first.
  function utf8ToBase64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }
  // New shots' photo files are hosted on Cloudflare R2 (not committed to this
  // repo — 700MB+ of photos doesn't belong in git or GitHub's web upload).
  // Older shots still have a plain "photos/whatever.jpg" repo-relative path
  // in their manifest entry, and photoSrc() below keeps those working too —
  // nothing needs migrating.
  const R2_PHOTO_BASE_URL = 'https://pub-1c550d12c25441ef85b207d40ac08cfe.r2.dev';
  function photoSrc(file) {
    return /^https?:\/\//i.test(file || '') ? file : `./${file}`;
  }
  // Pulls the plain filename back out of either a repo-relative path
  // ("photos/DSC01118.JPG") or an R2 URL (".../DSC01118.JPG") — decoding it
  // so it displays/matches the same way a raw filename does.
  function filenameOf(file) {
    const last = (file || '').split('/').pop() || '';
    try { return decodeURIComponent(last); } catch { return last; }
  }

  // ---------- categorization tuning ----------
  const CLASSIFY_WINDOW_SECONDS = 15; // how far either side of the photo to look
  const TURN_RATE_THRESHOLD = 3; // avg deg/sec heading swing across the window counts as "turning"
  const DOWNWIND_TWA_THRESHOLD = 90; // |TWA| >= this => downwind, below => upwind
  const GYBE_TWA_THRESHOLD = 150; // |TWA| passing this close to dead-run during a turn => gybe, not a tack

  // Photos taken during the same manoeuvre land within a few seconds of each
  // other (burst shooting); consecutive manoeuvres out on the water are
  // reliably a minute-plus apart. 60s sits comfortably between the two.
  const MANOEUVRE_GROUP_GAP_SECONDS = 60;

  // ---------- framing tuning (crop/zoom/straighten, all categories) ----------
  const FRAME_ROTATE_MIN = -45, FRAME_ROTATE_MAX = 45;
  const FRAME_ZOOM_MIN = 100, FRAME_ZOOM_MAX = 300; // percent

  // ---------- twist profile tuning (Straight Line Upwind only) ----------
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const TWIST_ANALYSIS_MAX_DIM = 1400; // downscale the photo before pixel-scanning it, for speed
  // The pixel-level edge trace always walks this many internal steps, for
  // good curve accuracy regardless of how many points the user actually
  // sees/edits — that count is separate (see twistPointCount below) and is
  // just a resample of this dense trace down to fewer, easier-to-drag points.
  const TWIST_DENSE_STEPS = 40;
  const TWIST_SEARCH_RADIUS_FRAC = 0.045; // how far either side of the predicted x the edge search looks, as a fraction of image width
  const TWIST_EDGE_MIN_SCORE = 8; // below this, the local gradient is too weak to trust — fall back toward the straight-line guess
  const TWIST_GRAPH_W = 220, TWIST_GRAPH_H = 170;
  const TWIST_GRAPH_PAD = { left: 34, right: 10, top: 10, bottom: 22 };
  const TWIST_POINT_COUNT_MIN = 3, TWIST_POINT_COUNT_MAX = 21;
  let twistPointCount = 5; // how many points are shown/edited/saved by default — adjustable via the +/- stepper

  const CATEGORIES = [
    { value: 'manoeuvre', label: 'Manoeuvre Sequence' },
    { value: 'gybe-exit', label: 'Gybe Exit' },
    { value: 'upwind', label: 'Straight Line Upwind' },
    { value: 'downwind', label: 'Straight Line Downwind' },
    { value: 'other', label: 'Other / Uncategorized' },
  ];
  const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.value, c.label]));

  const el = {
    addBtn: document.getElementById('addBtn'),
    githubConnectBtn: document.getElementById('githubConnectBtn'),
    importView: document.getElementById('importView'),
    galleryView: document.getElementById('galleryView'),
    emptyState: document.getElementById('emptyState'),
    dateTabs: document.getElementById('dateTabs'),
    categoryChips: document.getElementById('categoryChips'),
    shotGrid: document.getElementById('shotGrid'),
    galleryChangesBar: document.getElementById('galleryChangesBar'),
    galleryDiscardChanges: document.getElementById('galleryDiscardChanges'),
    galleryDownloadChanges: document.getElementById('galleryDownloadChanges'),
    githubStatus: document.getElementById('githubStatus'),

    lightbox: document.getElementById('lightbox'),
    lightboxClose: document.getElementById('lightboxClose'),
    lightboxDelete: document.getElementById('lightboxDelete'),
    lightboxPrev: document.getElementById('lightboxPrev'),
    lightboxNext: document.getElementById('lightboxNext'),
    lightboxImageWrap: document.getElementById('lightboxImageWrap'),
    lightboxImg: document.getElementById('lightboxImg'),
    lightboxVars: document.getElementById('lightboxVars'),
    lightboxCategory: document.getElementById('lightboxCategory'),
    lightboxDate: document.getElementById('lightboxDate'),
    lightboxComment: document.getElementById('lightboxComment'),

    frameSection: document.getElementById('frameSection'),
    frameCenterBtn: document.getElementById('frameCenterBtn'),
    frameCenterCancelBtn: document.getElementById('frameCenterCancelBtn'),
    frameCenterHint: document.getElementById('frameCenterHint'),
    frameEditBtn: document.getElementById('frameEditBtn'),
    frameResetBtn: document.getElementById('frameResetBtn'),
    frameSaveBtn: document.getElementById('frameSaveBtn'),
    frameCancelBtn: document.getElementById('frameCancelBtn'),
    frameControls: document.getElementById('frameControls'),
    frameCropModeBtn: document.getElementById('frameCropModeBtn'),
    frameStraightenModeBtn: document.getElementById('frameStraightenModeBtn'),
    frameRotateRow: document.getElementById('frameRotateRow'),
    frameRotateRange: document.getElementById('frameRotateRange'),
    frameRotateValue: document.getElementById('frameRotateValue'),
    frameCropHint: document.getElementById('frameCropHint'),
    frameStraightenHint: document.getElementById('frameStraightenHint'),
    frameGrid: document.getElementById('frameGrid'),
    frameCropBox: document.getElementById('frameCropBox'),

    twistSection: document.getElementById('twistSection'),
    twistTraceBtn: document.getElementById('twistTraceBtn'),
    twistClearBtn: document.getElementById('twistClearBtn'),
    twistSaveBtn: document.getElementById('twistSaveBtn'),
    twistCancelBtn: document.getElementById('twistCancelBtn'),
    twistHint: document.getElementById('twistHint'),
    twistGraph: document.getElementById('twistGraph'),
    twistOverlay: document.getElementById('twistOverlay'),
    twistPointsMinus: document.getElementById('twistPointsMinus'),
    twistPointsPlus: document.getElementById('twistPointsPlus'),
    twistPointCountLabel: document.getElementById('twistPointCountLabel'),

    csvInput: document.getElementById('csvInput'),
    csvDropLabel: document.getElementById('csvDropLabel'),
    csvSummary: document.getElementById('csvSummary'),
    csvConfig: document.getElementById('csvConfig'),
    timestampSelect: document.getElementById('timestampSelect'),
    headingSelect: document.getElementById('headingSelect'),
    twaSelect: document.getElementById('twaSelect'),
    variablePicker: document.getElementById('variablePicker'),
    varsAll: document.getElementById('varsAll'),
    varsNone: document.getElementById('varsNone'),

    photoInput: document.getElementById('photoInput'),
    photoDropLabel: document.getElementById('photoDropLabel'),
    dayNotesInput: document.getElementById('dayNotesInput'),

    previewStep: document.getElementById('previewStep'),
    previewList: document.getElementById('previewList'),

    publishStep: document.getElementById('publishStep'),
    downloadManifest: document.getElementById('downloadManifest'),
  };

  let existingManifest = { timestampColumn: '', variables: [], shots: [], dayNotes: {}, overlayLayout: {} };
  let csvHeaders = [];
  let csvRows = [];
  let sortedRows = []; // [{ ts: epochMillis, row: {...} }] ascending by timestamp, rebuilt whenever timestampColumn changes
  let timestampColumn = '';
  let headingColumn = '';
  let twaColumn = '';
  let selectedVars = new Set();
  // photos: { file, name, capturedAt: Date|null, source, matchedRow, matchedIndex, gapSeconds, category, categoryManual }
  let photos = [];

  let selectedDateKey = null;
  let selectedCategory = 'all';
  let currentGalleryOrder = []; // the shots currently shown in the grid, in their displayed order — lets the lightbox step next/prev
  // When opening a collapsed manoeuvre-group card, prev/next should stay
  // scoped to just that group's own shots rather than the whole category —
  // this overrides currentGalleryOrder for navigation purposes only, so a
  // renderGallery() triggered from inside the lightbox (e.g. saving a
  // framing edit) can't silently widen the scope back out.
  let lightboxScopedOrder = null;
  function activeGalleryOrder() { return lightboxScopedOrder || currentGalleryOrder; }

  // set once a shot is deleted or re-categorized from the gallery (not the
  // import flow) — these edits happen straight against existingManifest so
  // the page reflects them immediately, but like everything else here they
  // aren't "real" until published, so a banner offers a manifest download
  // rather than firing one on every click
  let manifestDirty = false;

  // ---------- persistence (working config only — the published gallery
  // always reads manifest.json, never localStorage, so it looks the same
  // on every device once published) ----------
  function loadConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (!raw) return {};
      return JSON.parse(raw);
    } catch (e) { return {}; }
  }
  function saveConfig() {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify({
        timestampColumn, headingColumn, twaColumn, variables: [...selectedVars],
      }));
    } catch (e) { /* ignore quota errors */ }
  }

  // ---------- CSV parsing (RFC4180-ish: quoted fields, escaped quotes) ----------
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip, \n handles the break */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.length > 1 || r[0] !== '');
  }

  function parseTimestampValue(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const trimmed = String(raw).trim();
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      if (trimmed.length >= 13) return new Date(num);
      if (trimmed.length >= 10) return new Date(num * 1000);
    }
    const iso = trimmed.includes(' ') && !trimmed.includes('T') ? trimmed.replace(' ', 'T') : trimmed;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d;
    return null;
  }

  function guessTimestampHeader(headers) {
    const preferred = headers.find(h => /time|date|utc|stamp/i.test(h));
    return preferred || headers[0];
  }
  function guessHeadingHeader(headers) {
    return headers.find(h => /heading|hdg/i.test(h)) || '';
  }
  function guessTwaHeader(headers) {
    // \b doesn't fire between "TWA" and a following "_" (both are \w), so
    // match on non-letter boundaries explicitly rather than \b.
    return headers.find(h => /(^|[^a-z])twa([^a-z]|$)/i.test(h) || /true.*wind.*angle/i.test(h)) || '';
  }

  // ---------- EXIF date extraction ----------
  // Both plain JPEG (APP1 segment) and HEIC/HEIF (an 'Exif' item box) wrap the
  // same TIFF-structured EXIF blob behind an "Exif\0\0" signature, so scanning
  // the raw bytes for that signature — rather than parsing either container
  // format — reads capture time out of both.
  function findExifTiffStart(bytes) {
    for (let i = 0; i < bytes.length - 10; i++) {
      if (bytes[i] === 0x45 && bytes[i + 1] === 0x78 && bytes[i + 2] === 0x69 && bytes[i + 3] === 0x66 &&
          bytes[i + 4] === 0 && bytes[i + 5] === 0) {
        const b0 = bytes[i + 6], b1 = bytes[i + 7];
        if ((b0 === 0x49 && b1 === 0x49) || (b0 === 0x4d && b1 === 0x4d)) return i + 6;
      }
    }
    return -1;
  }

  function parseExifDate(buf) {
    const bytes = new Uint8Array(buf);
    const tiffStart = findExifTiffStart(bytes);
    if (tiffStart < 0) return null;
    const dv = new DataView(buf, tiffStart);
    const little = dv.getUint8(0) === 0x49;
    const u16 = (off) => dv.getUint16(off, little);
    const u32 = (off) => dv.getUint32(off, little);
    if (u16(2) !== 42) return null;

    // A 12-byte IFD entry is tag(2) + type(2) + count(4) + valueOrOffset(4).
    // "count" is the number of TYPE-sized components (e.g. string length for
    // ASCII, 1 for a single LONG pointer) — it is NOT the value itself, so
    // ASCII strings and LONG pointers each need their own reader below.
    function readIFD(offset) {
      const entryCount = u16(offset);
      const entries = [];
      for (let e = 0; e < entryCount; e++) {
        const entryOff = offset + 2 + e * 12;
        entries.push({ tag: u16(entryOff), type: u16(entryOff + 2), count: u32(entryOff + 4), entryOff });
      }
      return entries;
    }
    function readAscii(entry) {
      const size = entry.count; // ASCII components are 1 byte each
      const dataOffset = size <= 4 ? entry.entryOff + 8 : u32(entry.entryOff + 8);
      let str = '';
      for (let k = 0; k < size - 1; k++) str += String.fromCharCode(dv.getUint8(dataOffset + k));
      return str;
    }
    function readLong(entry) {
      const size = entry.count * 4; // LONG components are 4 bytes each
      return size <= 4 ? u32(entry.entryOff + 8) : u32(u32(entry.entryOff + 8));
    }

    let dateTime = null, exifIfdOffset = null;
    try {
      const ifd0 = readIFD(u32(4));
      for (const entry of ifd0) {
        if (entry.tag === 0x8769) exifIfdOffset = readLong(entry);
        if (entry.tag === 0x0132 && entry.type === 2) dateTime = readAscii(entry);
      }
      if (exifIfdOffset != null) {
        const exifIfd = readIFD(exifIfdOffset);
        for (const entry of exifIfd) {
          if (entry.tag === 0x9003 && entry.type === 2) { dateTime = readAscii(entry); break; }
        }
      }
    } catch (e) { return null; }

    if (!dateTime) return null;
    const m = dateTime.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m;
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  }

  async function readCaptureDate(file) {
    try {
      const slice = file.slice(0, 524288); // 512 KB is plenty for EXIF near the head of the file
      const buf = await slice.arrayBuffer();
      const exifDate = parseExifDate(buf);
      if (exifDate) return { date: exifDate, source: 'exif' };
    } catch (e) { /* fall through to file-modified */ }
    if (file.lastModified) return { date: new Date(file.lastModified), source: 'file-modified' };
    return { date: null, source: null };
  }

  // ---------- matching (binary search over a sorted-by-time array) ----------
  function buildSortedRows() {
    sortedRows = csvRows
      .map(row => {
        const d = timestampColumn ? parseTimestampValue(row[timestampColumn]) : null;
        return d ? { ts: d.getTime(), row } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.ts - b.ts);
  }

  function findNearestIndex(targetTs) {
    if (sortedRows.length === 0) return -1;
    let lo = 0, hi = sortedRows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedRows[mid].ts < targetTs) lo = mid + 1; else hi = mid;
    }
    if (lo > 0) {
      const prevDiff = Math.abs(sortedRows[lo - 1].ts - targetTs);
      const curDiff = Math.abs(sortedRows[lo].ts - targetTs);
      if (prevDiff <= curDiff) return lo - 1;
    }
    return lo;
  }

  function matchNearestRow(capturedAt) {
    if (!capturedAt || sortedRows.length === 0) return null;
    const idx = findNearestIndex(capturedAt.getTime());
    if (idx < 0) return null;
    const match = sortedRows[idx];
    return { row: match.row, gapSeconds: Math.abs(match.ts - capturedAt.getTime()) / 1000, index: idx };
  }

  // ---------- auto-categorization ----------
  // Smallest signed angular difference b-a, wrapped to [-180, 180].
  function angDiff(a, b) {
    let d = (b - a) % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  // Expands outward from centerIndex to the widest span of rows within
  // windowSeconds either side, in time (not row count) — cheap because the
  // window is short in wall-clock time even if the CSV has gaps.
  function getWindowIndices(centerIndex, windowSeconds) {
    const centerTs = sortedRows[centerIndex].ts;
    let startIdx = centerIndex, endIdx = centerIndex;
    while (startIdx > 0 && (centerTs - sortedRows[startIdx - 1].ts) <= windowSeconds * 1000) startIdx--;
    while (endIdx < sortedRows.length - 1 && (sortedRows[endIdx + 1].ts - centerTs) <= windowSeconds * 1000) endIdx++;
    return [startIdx, endIdx];
  }

  // Auto-suggests a category from the heading/TWA trend around the matched
  // row. Returns null when there isn't enough data to guess — the shot then
  // starts as "Other" and the user picks manually.
  function classifyShot(index) {
    if (index < 0 || index >= sortedRows.length || !headingColumn) return null;

    const [startIdx, endIdx] = getWindowIndices(index, CLASSIFY_WINDOW_SECONDS);
    const pts = [];
    for (let i = startIdx; i <= endIdx; i++) {
      const heading = parseFloat(sortedRows[i].row[headingColumn]);
      const twa = twaColumn ? parseFloat(sortedRows[i].row[twaColumn]) : NaN;
      if (!isNaN(heading)) pts.push({ ts: sortedRows[i].ts, heading, twa });
    }
    if (pts.length < 2) return null;

    let swing = 0, crossedDeadRun = false;
    for (let i = 1; i < pts.length; i++) {
      swing += Math.abs(angDiff(pts[i - 1].heading, pts[i].heading));
      if (!isNaN(pts[i].twa) && Math.abs(pts[i].twa) >= GYBE_TWA_THRESHOLD) crossedDeadRun = true;
    }
    const durationSec = Math.max(1, (pts[pts.length - 1].ts - pts[0].ts) / 1000);
    const turnRate = swing / durationSec;

    const centerTwa = twaColumn ? parseFloat(sortedRows[index].row[twaColumn]) : NaN;

    if (turnRate >= TURN_RATE_THRESHOLD) {
      if (crossedDeadRun && !isNaN(centerTwa) && Math.abs(centerTwa) >= DOWNWIND_TWA_THRESHOLD) return 'gybe-exit';
      return 'manoeuvre';
    }
    if (!isNaN(centerTwa)) return Math.abs(centerTwa) < DOWNWIND_TWA_THRESHOLD ? 'upwind' : 'downwind';
    return null;
  }

  function rematchAllPhotos() {
    photos.forEach(p => {
      const m = matchNearestRow(p.capturedAt);
      p.matchedRow = m ? m.row : null;
      p.matchedIndex = m ? m.index : -1;
      p.gapSeconds = m ? m.gapSeconds : null;
      if (!p.categoryManual) {
        p.category = m ? (classifyShot(m.index) || 'other') : (p.category || 'other');
      }
    });
    renderPreview();
  }

  // ---------- gallery ----------
  async function loadManifest() {
    try {
      const res = await fetch(MANIFEST_PATH, { cache: 'no-store' });
      if (res.ok) existingManifest = await res.json();
    } catch (e) { /* first run — manifest.json may not exist yet */ }
    if (!Array.isArray(existingManifest.shots)) existingManifest.shots = [];
    if (!Array.isArray(existingManifest.variables)) existingManifest.variables = [];
    if (!existingManifest.dayNotes || typeof existingManifest.dayNotes !== 'object') existingManifest.dayNotes = {};
    if (!existingManifest.overlayLayout || typeof existingManifest.overlayLayout !== 'object') existingManifest.overlayLayout = {};
    renderGallery();
  }


  // Boat-data values arrive at whatever precision the CSV happened to log
  // (often 2 decimals even for a load in the thousands, e.g. "2774.81"),
  // which reads as noisy clutter once a dozen-plus of them are stacked on a
  // photo. Round each to a precision that matches its unit instead — loads
  // (kgf) to whole numbers, angles/speeds (deg/kts) to one decimal, small
  // foil measurements (m) to two — so the overlay reads like a clean
  // instrument panel rather than a raw data dump. Falls back to the raw
  // value untouched if it isn't a plain number.
  function formatOverlayValue(varName, raw) {
    if (raw === undefined || raw === '' || raw === '—') return raw;
    const num = Number(raw);
    if (Number.isNaN(num)) return raw;
    if (/_kgf$/.test(varName)) return String(Math.round(num));
    if (/_m$/.test(varName)) return num.toFixed(2);
    return num.toFixed(1);
  }

  // ---------- lightbox variable display: fixed curated list ----------
  // Kyle wants one fixed order/grouping/color-coding for the lightbox data
  // panel, replacing whatever order the manifest's `variables` array (built
  // from CSV column order) happens to be in. Groups get a visible gap
  // between them, and each row's value is colored by group. A row is simply
  // skipped if that CSV column isn't present on this shot (e.g. an older
  // batch predating a newer column) — nothing renders as blank/zero.
  // "Mast AOA" isn't a CSV column at all — it's computed on the fly as
  // AWA_deg - MastRotation_deg.
  const MAST_AOA_KEY = '__mastAoa';
  const LIGHTBOX_VAR_GROUPS = [
    { color: 'blue', vars: ['TWS_kts', 'BSP_kts', 'TWA_deg', 'Heel_deg', 'Leeway_deg', 'AWA_deg'] },
    { color: 'white', vars: ['TrimTarget_deg'] },
    { color: 'red', vars: ['FoilCantPort_deg', 'FoilFlapPort_deg', 'FoilSinkPort_target'] },
    { color: 'green', vars: ['FoilCantStbd_deg', 'FoilFlapStbd_deg', 'FoilSinkStbd_target'] },
    { color: 'white', vars: ['JibSheetLoad_kgf', 'JibCunninghamLoad_kgf', 'JibTrackLoad_kgf'] },
    { color: 'orange', vars: ['MainSheetLoad_kgf', 'MainCunninghamLoad_kgf', 'FootCamber_deg', 'Clew_position', MAST_AOA_KEY, 'MastRotation_deg', 'MainTravellerAngle_deg'] },
  ];

  // The boat logs MastRotation_deg as an unsigned magnitude (always
  // positive, whichever side the mast is actually rotated to) — but AWA_deg
  // is signed by which side the wind's on (negative = wind from port). To
  // combine them (for Mast AOA, and to show a rotation value that actually
  // means something on its own) the magnitude needs the sign of AWA_deg —
  // confirmed with Kyle: same sign as AWA_deg, e.g. AWA -14° + raw rotation
  // 21.4° -> signed rotation -21.4°.
  function normalizedMastRotation(row) {
    if (row['MastRotation_deg'] === undefined || row['MastRotation_deg'] === '') return undefined;
    const mag = Math.abs(Number(row['MastRotation_deg']));
    if (Number.isNaN(mag)) return undefined;
    const awaNum = Number(row['AWA_deg']);
    const sign = (row['AWA_deg'] === undefined || row['AWA_deg'] === '' || Number.isNaN(awaNum) || awaNum === 0) ? 1 : Math.sign(awaNum);
    return sign * mag;
  }

  function computeMastAoa(row) {
    if (row['AWA_deg'] === undefined || row['AWA_deg'] === '') return undefined;
    const awa = Number(row['AWA_deg']);
    const rot = normalizedMastRotation(row);
    if (Number.isNaN(awa) || rot === undefined || Number.isNaN(rot)) return undefined;
    return awa - rot;
  }

  // Resolves one curated-list entry against a shot's matched CSV row —
  // returns { label, value } to render, or undefined to skip the row
  // entirely (missing column / not computable).
  function lightboxVarEntry(key, row) {
    if (key === MAST_AOA_KEY) {
      const val = computeMastAoa(row);
      if (val === undefined) return undefined;
      return { label: 'Mast AOA', value: formatOverlayValue('MastAOA_deg', val) };
    }
    if (key === 'MastRotation_deg') {
      const val = normalizedMastRotation(row);
      if (val === undefined) return undefined;
      return { label: key, value: formatOverlayValue(key, val) };
    }
    if (row[key] === undefined || row[key] === '') return undefined;
    return { label: key, value: formatOverlayValue(key, row[key]) };
  }

  function formatShotDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'Unknown time';
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }

  function dateKeyOf(shot) {
    const d = new Date(shot.capturedAt);
    if (isNaN(d.getTime())) return 'unknown';
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function formatDateKey(key) {
    if (key === 'unknown') return 'Unknown date';
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function makeChip(cls, value, label, isActive, onClick) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = cls + (isActive ? ' is-active' : '');
    chip.textContent = label;
    chip.addEventListener('click', onClick);
    return chip;
  }

  // ---------- manoeuvre grouping (Manoeuvre Sequence category only) ----------
  // Clusters the shots in one manoeuvre burst together and names each
  // cluster in chronological order — "Tack 1", "Gybe 1", "Gybe 2", etc.,
  // counted separately per type. A cluster is a run of shots with no gap
  // bigger than MANOEUVRE_GROUP_GAP_SECONDS between consecutive capture
  // times; whether it's a tack or a gybe is read off the average TWA across
  // the cluster, using the same upwind/downwind split the auto-categorizer
  // uses elsewhere (below DOWNWIND_TWA_THRESHOLD => upwind => tack).
  // Returns an array of { label, shots }, one entry per cluster — each
  // cluster's own shots sorted chronologically (earliest first, so opening
  // the group starts at the first shot of that manoeuvre and steps forward
  // through the rest). The array of groups itself is newest-group-first, to
  // match the rest of the gallery's "sorted newest first" convention.
  function manoeuvreGroups(shots) {
    const ascending = [...shots].sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
    const groups = [];
    let tackCount = 0, gybeCount = 0, clusterStart = 0;
    const flushCluster = (endExclusive) => {
      const cluster = ascending.slice(clusterStart, endExclusive);
      if (cluster.length === 0) return;
      const twas = cluster
        .map(s => Number((s.row || {})['TWA_deg']))
        .filter(v => !Number.isNaN(v));
      const avgAbsTwa = twas.length ? twas.reduce((sum, v) => sum + Math.abs(v), 0) / twas.length : 0;
      const label = avgAbsTwa >= DOWNWIND_TWA_THRESHOLD ? `Gybe ${++gybeCount}` : `Tack ${++tackCount}`;
      groups.push({ label, shots: cluster });
    };
    for (let i = 1; i < ascending.length; i++) {
      const gapSec = (new Date(ascending[i].capturedAt) - new Date(ascending[i - 1].capturedAt)) / 1000;
      if (gapSec > MANOEUVRE_GROUP_GAP_SECONDS) { flushCluster(i); clusterStart = i; }
    }
    flushCluster(ascending.length);
    return groups.reverse();
  }

  function renderGallery() {
    const shots = existingManifest.shots || [];
    const hasShots = shots.length > 0;
    el.emptyState.classList.toggle('is-hidden', hasShots);
    el.dateTabs.classList.toggle('is-hidden', !hasShots);
    el.categoryChips.classList.toggle('is-hidden', !hasShots);
    if (!hasShots) { el.shotGrid.innerHTML = ''; return; }

    const byDate = new Map();
    shots.forEach(s => {
      const key = dateKeyOf(s);
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(s);
    });
    const dateKeys = [...byDate.keys()].sort((a, b) => b.localeCompare(a)); // newest first
    if (!selectedDateKey || !byDate.has(selectedDateKey)) selectedDateKey = dateKeys[0];

    el.dateTabs.innerHTML = '';
    dateKeys.forEach(key => {
      const note = (existingManifest.dayNotes || {})[key];
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'date-tab' + (key === selectedDateKey ? ' is-active' : '');
      const title = document.createElement('strong');
      title.textContent = formatDateKey(key);
      tab.appendChild(title);
      if (note) {
        const sub = document.createElement('span');
        sub.textContent = note;
        tab.appendChild(sub);
      }
      tab.addEventListener('click', () => { selectedDateKey = key; selectedCategory = 'all'; renderGallery(); });
      el.dateTabs.appendChild(tab);
    });

    const dayShots = byDate.get(selectedDateKey) || [];
    const counts = { all: dayShots.length };
    CATEGORIES.forEach(c => { counts[c.value] = 0; });
    dayShots.forEach(s => { const cat = s.category || 'other'; counts[cat] = (counts[cat] || 0) + 1; });

    el.categoryChips.innerHTML = '';
    el.categoryChips.appendChild(makeChip('category-chip', 'all', `All (${counts.all})`, selectedCategory === 'all', () => {
      selectedCategory = 'all'; renderGallery();
    }));
    CATEGORIES.forEach(c => {
      if (counts[c.value] === 0) return;
      el.categoryChips.appendChild(makeChip('category-chip', c.value, `${c.label} (${counts[c.value]})`, selectedCategory === c.value, () => {
        selectedCategory = c.value; renderGallery();
      }));
    });

    const filtered = selectedCategory === 'all' ? dayShots : dayShots.filter(s => (s.category || 'other') === selectedCategory);
    const sorted = [...filtered].sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
    currentGalleryOrder = sorted; // lets the lightbox step to the next/previous photo in this same order

    el.shotGrid.innerHTML = '';

    // Manoeuvre Sequence view only: collapse each tack/gybe burst down to a
    // single card (the earliest shot in it) with a header and a "N photos"
    // badge instead of one card per photo — opening it starts at that first
    // shot and steps forward through the rest in chronological order.
    if (selectedCategory === 'manoeuvre') {
      manoeuvreGroups(filtered).forEach(group => {
        const header = document.createElement('div');
        const isGybe = /^Gybe/.test(group.label);
        header.className = `shot-grid__group-label shot-grid__group-label--${isGybe ? 'gybe' : 'tack'}`;
        header.textContent = group.label;
        el.shotGrid.appendChild(header);
        el.shotGrid.appendChild(renderManoeuvreGroupCard(group));
      });
      return;
    }

    sorted.forEach(shot => el.shotGrid.appendChild(renderShotCard(shot)));
  }

  // A normal, single-photo gallery card: thumbnail (clickable to open the
  // lightbox), category picker, delete button, and a quick-comment box.
  function renderShotCard(shot) {
    const card = document.createElement('article');
    card.className = 'shot-card';

    const imgWrap = document.createElement('div');
    imgWrap.className = 'shot-card__image-wrap';
    const img = document.createElement('img');
    img.src = photoSrc(shot.file);
    img.dataset.shotId = shot.id;
    img.alt = '';
    img.loading = 'lazy';
    imgWrap.appendChild(img);
    const dateTag = document.createElement('span');
    dateTag.className = 'shot-card__date';
    dateTag.textContent = formatShotDate(shot.capturedAt);
    imgWrap.appendChild(dateTag);

    const catSelect = document.createElement('select');
    catSelect.className = `shot-card__category shot-card__category--${shot.category || 'other'}`;
    catSelect.setAttribute('aria-label', 'Category');
    CATEGORIES.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.value; opt.textContent = c.label;
      if ((shot.category || 'other') === c.value) opt.selected = true;
      catSelect.appendChild(opt);
    });
    catSelect.addEventListener('click', (e) => e.stopPropagation()); // don't open the lightbox
    catSelect.addEventListener('change', () => {
      setShotCategory(shot.id, catSelect.value);
    });
    imgWrap.appendChild(catSelect);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'shot-card__delete';
    deleteBtn.setAttribute('aria-label', 'Delete photo');
    deleteBtn.textContent = '×';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't open the lightbox
      deleteShot(shot.id);
    });
    imgWrap.appendChild(deleteBtn);

    imgWrap.classList.add('is-clickable');
    imgWrap.addEventListener('click', () => openLightbox(shot, null));

    card.appendChild(imgWrap);
    applyFrameToImg(img, shot, 'grid');

    // The full boat-data readout now only lives in the lightbox (left
    // panel), so it doesn't clash with the photo here — the card stays a
    // clean thumbnail with just the category/date badges. A comment box
    // sits right under it, so a quick note can be added without opening
    // the lightbox at all.
    const commentWrap = document.createElement('div');
    commentWrap.className = 'shot-card__comment-wrap';
    const commentInput = document.createElement('textarea');
    commentInput.className = 'shot-card__comment';
    commentInput.dataset.shotId = shot.id;
    commentInput.rows = 2;
    commentInput.placeholder = 'Add a comment…';
    commentInput.value = shot.comment || '';
    commentInput.addEventListener('input', () => setShotComment(shot.id, commentInput.value));
    commentInput.addEventListener('blur', () => flushPendingPublish());
    commentWrap.appendChild(commentInput);
    card.appendChild(commentWrap);

    return card;
  }

  // A collapsed manoeuvre-group card: shows only the group's earliest shot
  // as the thumbnail (that's the one that opens), with a "N photos" badge
  // when there's more than one hidden behind it. No per-shot controls here
  // (category/delete/comment) since those would be ambiguous applied to a
  // whole burst — they stay available per-photo inside the lightbox once
  // you've opened the group and stepped to the shot you want.
  function renderManoeuvreGroupCard(group) {
    const repShot = group.shots[0]; // earliest in the group — the one that opens
    const card = document.createElement('article');
    card.className = 'shot-card';

    const imgWrap = document.createElement('div');
    imgWrap.className = 'shot-card__image-wrap is-clickable';
    const img = document.createElement('img');
    img.src = photoSrc(repShot.file);
    img.dataset.shotId = repShot.id;
    img.alt = '';
    img.loading = 'lazy';
    imgWrap.appendChild(img);

    const dateTag = document.createElement('span');
    dateTag.className = 'shot-card__date';
    dateTag.textContent = formatShotDate(repShot.capturedAt);
    imgWrap.appendChild(dateTag);

    if (group.shots.length > 1) {
      const stackBadge = document.createElement('span');
      stackBadge.className = 'shot-card__stack-count';
      stackBadge.textContent = `${group.shots.length} photos`;
      imgWrap.appendChild(stackBadge);
    }

    imgWrap.addEventListener('click', () => {
      // Scope prev/next to just this manoeuvre's own shots, in
      // chronological order, rather than the whole Manoeuvre Sequence list.
      openLightbox(repShot, group.shots);
    });
    applyFrameToImg(img, repShot, 'grid');

    card.appendChild(imgWrap);
    return card;
  }

  // ---------- lightbox (full-size photo view) ----------
  // The card thumbnails are cropped to a 4:3 tile; the lightbox shows the
  // whole, uncropped photo instead — that's the point of "full screen". The
  // boat data used to float directly on top of the photo, which got
  // unreadable fast once a dozen-plus variables were selected — it now
  // lives in a plain list in a panel to the left of the photo instead, with
  // a comment box in a matching panel on the right, so nothing sits on the
  // photo itself anymore.
  let currentLightboxShotId = null;
  // Framing edit in progress, or null when idle. See the "framing" block
  // below for the full state machine.
  let frameState = null;
  // Twist-profile trace in progress, or null when idle. See the "twist
  // profile" block below for the full state machine.
  let twistState = null;

  function openLightbox(shot, scopedOrder) {
    const row = shot.row || {};
    currentLightboxShotId = shot.id;
    // scopedOrder is only passed explicitly by a direct open (a plain shot
    // card passes null to clear it, a manoeuvre-group card passes its own
    // shots) — stepLightbox's internal re-open omits it entirely so an
    // active scoped session survives stepping through it.
    if (scopedOrder !== undefined) lightboxScopedOrder = scopedOrder;
    endTwistTrace(); // switching shots (open, or prev/next) abandons any in-progress trace
    endFrameEdit(); // ditto for an in-progress framing edit
    endCenterPick(); // ditto for an in-progress boat-centering click

    el.lightboxImg.src = photoSrc(shot.file);
    // updateLightboxFrameDisplay must run before the syncTwistOverlayViewBox
    // below can fire synchronously (a cached image completes immediately) —
    // it reads the .is-framed class that call sets, to know whether the
    // overlay should track the crop or the full photo.
    updateLightboxFrameDisplay(shot);
    // The twist overlay's viewBox is set to the photo's own natural pixel
    // size (once known) so its circles/lines aren't stretched by a mismatch
    // between that size's aspect ratio and a generic square viewBox.
    el.lightboxImg.onload = syncTwistOverlayViewBox;
    if (el.lightboxImg.complete) syncTwistOverlayViewBox();

    el.lightboxCategory.className = `shot-card__category shot-card__category--${shot.category || 'other'}`;
    el.lightboxCategory.innerHTML = '';
    CATEGORIES.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.value; opt.textContent = c.label;
      if ((shot.category || 'other') === c.value) opt.selected = true;
      el.lightboxCategory.appendChild(opt);
    });
    el.lightboxDate.textContent = formatShotDate(shot.capturedAt);

    el.lightboxVars.innerHTML = '';
    LIGHTBOX_VAR_GROUPS.forEach(group => {
      const rows = group.vars
        .map(key => lightboxVarEntry(key, row))
        .filter(Boolean);
      if (rows.length === 0) return;
      // A blank-line gap between groups — only once there's already a
      // group rendered above it, so the panel never starts with one.
      if (el.lightboxVars.children.length > 0) {
        const gap = document.createElement('div');
        gap.className = 'lightbox__var-gap';
        el.lightboxVars.appendChild(gap);
      }
      rows.forEach(({ label, value }) => {
        const item = document.createElement('div');
        item.className = `lightbox__var-row lightbox__var-row--${group.color}`;
        item.innerHTML = `<span></span><b></b>`;
        item.querySelector('span').textContent = label;
        item.querySelector('b').textContent = value;
        el.lightboxVars.appendChild(item);
      });
    });

    el.lightboxComment.value = shot.comment || '';

    // Prev/next only make sense when there's something to step to — hide
    // them rather than leaving a dead-end arrow when the gallery has just
    // this one shot (or the filtered view has been narrowed to one).
    const canNavigate = activeGalleryOrder().length > 1;
    el.lightboxPrev.classList.toggle('is-hidden', !canNavigate);
    el.lightboxNext.classList.toggle('is-hidden', !canNavigate);

    renderTwistSection(shot);
    renderFrameSection(shot);

    el.lightbox.classList.remove('is-hidden');
  }
  function closeLightbox() {
    flushPendingPublish(); // don't leave a just-typed comment waiting on the debounce timer
    endTwistTrace();
    endFrameEdit();
    endCenterPick();
    lightboxScopedOrder = null;
    el.lightbox.classList.add('is-hidden');
    el.lightboxImg.src = '';
    currentLightboxShotId = null;
  }
  // Steps to the next/previous shot in the currently displayed gallery
  // order (same date + category filter the grid is showing, or — when
  // opened from a collapsed manoeuvre-group card — just that group's own
  // shots). Wraps around at either end so the arrows always do something
  // while more than one photo is in view.
  function stepLightbox(delta) {
    const order = activeGalleryOrder();
    if (!currentLightboxShotId || order.length < 2) return;
    const idx = order.findIndex(s => s.id === currentLightboxShotId);
    if (idx === -1) return;
    const next = order[(idx + delta + order.length) % order.length];
    openLightbox(next);
  }
  el.lightboxClose.addEventListener('click', closeLightbox);
  el.lightbox.addEventListener('click', (e) => {
    if (e.target === el.lightbox) closeLightbox(); // click on the backdrop, not the photo itself
  });
  el.lightboxPrev.addEventListener('click', (e) => { e.stopPropagation(); stepLightbox(-1); });
  el.lightboxNext.addEventListener('click', (e) => { e.stopPropagation(); stepLightbox(1); });
  el.lightboxCategory.addEventListener('click', (e) => e.stopPropagation()); // don't let picking an option close the lightbox
  el.lightboxCategory.addEventListener('change', () => {
    if (!currentLightboxShotId) return;
    setShotCategory(currentLightboxShotId, el.lightboxCategory.value);
    const shot = existingManifest.shots.find(s => s.id === currentLightboxShotId);
    el.lightboxCategory.className = `shot-card__category shot-card__category--${shot.category || 'other'}`;
    endTwistTrace(); // recategorizing mid-trace would leave a stale reference to the wrong tool
    if (shot) renderTwistSection(shot);
  });
  el.lightboxDelete.addEventListener('click', () => {
    if (!currentLightboxShotId) return;
    if (deleteShot(currentLightboxShotId)) closeLightbox();
  });
  el.lightboxComment.addEventListener('input', () => {
    if (!currentLightboxShotId) return;
    setShotComment(currentLightboxShotId, el.lightboxComment.value);
  });
  el.lightboxComment.addEventListener('blur', () => flushPendingPublish());
  document.addEventListener('keydown', (e) => {
    if (el.lightbox.classList.contains('is-hidden')) return;
    // Don't hijack the left/right arrow keys for prev/next while the
    // comment box has focus — that's just normal cursor movement while typing.
    const typingComment = document.activeElement === el.lightboxComment;
    if (e.key === 'Escape') closeLightbox();
    else if (!typingComment && e.key === 'ArrowLeft') stepLightbox(-1);
    else if (!typingComment && e.key === 'ArrowRight') stepLightbox(1);
  });

  // ---------- framing: crop/zoom/straighten, all categories ----------
  // Non-destructive — the original photo on R2 is never touched. A saved
  // frame is just { rotationDeg, zoom, posX, posY } on the shot, and every
  // place the photo is drawn (gallery thumbnail, lightbox) renders it the
  // same way: object-fit:cover + object-position handle the crop/pan (the
  // browser's own "which part of the image shows in this box" math, so it
  // scales correctly whether the box is a small grid tile or the big
  // lightbox view), and a scale()/rotate() transform layered on top handles
  // the extra zoom and straightening. posX/posY are the object-position
  // percentages (50/50 = centered); zoom is a multiplier >=1.

  // A frame's crop can be any shape the user drags — there's no longer a
  // fixed target ratio for it. The gallery TILE is still a fixed 4:3 box
  // (a uniform-grid layout choice, unrelated to the user's chosen crop),
  // so a saved frame carries two independently pre-fit renderings —
  // 'grid' (that free-shaped crop cover-fit into 4:3, same idea as
  // object-fit:cover treating a differently-shaped photo) and 'lightbox'
  // (the crop shown at its own exact shape) — plus the crop's own aspect
  // ratio, used to size the lightbox <img> itself. Pre-fitting both at
  // Save time (rather than recomputing from a raw box on every render)
  // means applying a frame never needs to know the image's pixel
  // dimensions again — only object-position/scale percentages, which work
  // on any <img> showing that same photo regardless of its on-screen size.
  const GRID_TARGET_AR = 4 / 3;

  // Puts an <img> in "render fit" mode: absolutely positioned, sized and
  // panned via percentages (relative to its containing block, which is
  // always sized/clipped to exactly the visible crop — see
  // sizeLightboxWrapToFrameAR and the fixed-AR grid tiles), rotated around
  // the crop's own center. See frameRenderFit below for why this replaced
  // object-fit:cover + object-position + scale().
  function setImgRenderFit(img, fit, rotationDeg) {
    img.classList.add('is-framed');
    img.style.position = 'absolute';
    img.style.width = `${fit.widthPct}%`;
    img.style.height = `${fit.heightPct}%`;
    img.style.left = `${fit.leftPct}%`;
    img.style.top = `${fit.topPct}%`;
    img.style.transformOrigin = `${fit.originXPct}% ${fit.originYPct}%`;
    img.style.transform = `rotate(${rotationDeg}deg)`;
  }
  function clearImgRenderFit(img) {
    img.classList.remove('is-framed');
    img.style.position = '';
    img.style.width = '';
    img.style.height = '';
    img.style.left = '';
    img.style.top = '';
    img.style.transformOrigin = '';
    img.style.transform = '';
  }

  // Applies a shot's saved frame (if any) to a plain <img>. kind is 'grid'
  // (fixed 4:3 tile) or 'lightbox' (the crop's own shape).
  function applyFrameToImg(img, shot, kind) {
    const f = shot && shot.frame;
    const fit = f && f[kind];
    if (fit) setImgRenderFit(img, fit, f.rotationDeg);
    else clearImgRenderFit(img);
  }

  // Updates just this shot's own thumbnail(s) already in the grid, without
  // a full renderGallery() — that would reset currentGalleryOrder and drop
  // out of a manoeuvre-group-scoped lightbox session for no good reason
  // when all that actually changed is how one photo is framed.
  function refreshVisibleShotThumbnail(shot) {
    document.querySelectorAll(`#shotGrid img[data-shot-id="${CSS.escape(shot.id)}"]`)
      .forEach(img => applyFrameToImg(img, shot, 'grid'));
  }

  // A frame's aspect ratio isn't fixed, so the lightbox wrap can't just be
  // "width:56vw, aspect-ratio:something" in CSS — a very tall/narrow crop
  // combined with a fixed width could overflow max-height without the
  // width shrinking to compensate. Instead: the .is-framed rule on the wrap
  // gives it the same max-width/max-height the plain (unframed) <img> rule
  // resolves to at the current breakpoint (56vw/88vh on desktop, 100%/50vh
  // on phones), then this fits the crop's own ratio inside that box in JS
  // and sets an explicit pixel width/height on the WRAP — the <img> inside
  // it is absolutely positioned and sized in percentages of that, per
  // frameRenderFit, and the wrap's overflow:hidden clips it to the crop.
  function sizeLightboxWrapToFrameAR(ar) {
    const cs = getComputedStyle(el.lightboxImageWrap);
    const maxW = parseFloat(cs.maxWidth), maxH = parseFloat(cs.maxHeight);
    if (!maxW || !maxH || !ar) return;
    let w = maxW, h = w / ar;
    if (h > maxH) { h = maxH; w = h * ar; }
    el.lightboxImageWrap.style.width = `${w}px`;
    el.lightboxImageWrap.style.height = `${h}px`;
  }

  // The lightbox photo isn't normally boxed to a fixed aspect ratio (it
  // shows the whole original at its own aspect ratio) — the .is-framed
  // class switches it to the crop's own shape, only while a frame is
  // actually in effect. forceUnframed shows the full original regardless
  // (used by the Center-boat tool, which needs to click anywhere on the
  // untouched photo).
  function updateLightboxFrameDisplay(shot, forceUnframed) {
    const hasFrame = !!(shot && shot.frame) && !forceUnframed;
    applyFrameToImg(el.lightboxImg, hasFrame ? shot : null, 'lightbox');
    el.lightboxImageWrap.classList.toggle('is-framed', hasFrame);
    if (hasFrame) {
      sizeLightboxWrapToFrameAR(shot.frame.lightbox.aspectRatio);
    } else {
      el.lightboxImageWrap.style.width = '';
      el.lightboxImageWrap.style.height = '';
    }
    syncTwistOverlayViewBox();
  }

  function renderFrameSection(shot) {
    const hasFrame = !!shot.frame;
    el.frameEditBtn.textContent = hasFrame ? 'Edit' : 'Add';
    el.frameEditBtn.classList.remove('is-hidden');
    el.frameResetBtn.classList.toggle('is-hidden', !hasFrame);
    el.frameSaveBtn.classList.add('is-hidden');
    el.frameCancelBtn.classList.add('is-hidden');
    // The one-click "center the boat" shortcut only makes sense for
    // Manoeuvre Sequence bursts — that's the case it was built for (keeping
    // the boat in the same screen position while stepping through a tack
    // or gybe for side-by-side comparison).
    el.frameCenterBtn.classList.toggle('is-hidden', shot.category !== 'manoeuvre');
    el.frameCenterCancelBtn.classList.add('is-hidden');
  }

  // Re-applies the live edit state to the photo from frameState.cropBox —
  // called while straightening (rotate slider) so the preview always
  // matches frameState. The preview is fit to the crop box's OWN aspect
  // ratio (not a fixed one), matching what Save will actually persist.
  function applyFrameEditLive() {
    if (!frameState || !frameState.cropBox) return;
    const iw = el.lightboxImg.naturalWidth, ih = el.lightboxImg.naturalHeight;
    if (!iw || !ih) return;
    const box = frameState.cropBox;
    const boxAR = (box.wFrac * iw) / (box.hFrac * ih);
    const fit = frameRenderFit(box, iw, ih);
    el.lightboxImageWrap.classList.add('is-framed');
    sizeLightboxWrapToFrameAR(boxAR);
    setImgRenderFit(el.lightboxImg, fit, frameState.rotationDeg);
  }

  // Converts a crop box (natural-image-pixel fractions) into the CSS
  // percentages that render it filling its container exactly:
  // position:absolute + percentage width/height/left/top, rotated around
  // the crop's own center via transform-origin. Unlike the old
  // object-fit:cover + object-position + scale() approach, this can place
  // the crop's pan on BOTH axes independently and exactly, because nothing
  // is first clamped to a "cover" rectangle (that clamping is what silently
  // pinned one axis to dead-center once zoomed in — see the diagnostic
  // writeup in git history for the full derivation).
  //
  // The container this is rendered into must itself be sized to exactly
  // the crop box's own aspect ratio (sizeLightboxWrapToFrameAR does that
  // for the lightbox wrap; the grid tiles are a fixed 4:3 by CSS, matching
  // GRID_TARGET_AR) — that's what keeps the <img>'s resulting pixel
  // width:height ratio equal to the photo's own natural ratio, undistorted.
  function frameRenderFit(box, iw, ih) {
    const bw = box.wFrac * iw, bh = box.hFrac * ih;
    const centerX = box.xFrac * iw + bw / 2, centerY = box.yFrac * ih + bh / 2;
    return {
      widthPct: (iw / bw) * 100,
      heightPct: (ih / bh) * 100,
      leftPct: 50 - (centerX / bw) * 100,
      topPct: 50 - (centerY / bh) * 100,
      originXPct: (centerX / iw) * 100,
      originYPct: (centerY / ih) * 100,
    };
  }
  // Inverse of frameRenderFit — reconstructs the natural-image-fraction
  // crop box from a saved render fit, so reopening the crop editor (or
  // re-centering) starts from exactly the saved crop.
  function frameBoxFromRenderFit(fit, iw, ih) {
    const bw = iw * 100 / fit.widthPct, bh = ih * 100 / fit.heightPct;
    const centerX = bw * (50 - fit.leftPct) / 100, centerY = bh * (50 - fit.topPct) / 100;
    return { xFrac: (centerX - bw / 2) / iw, yFrac: (centerY - bh / 2) / ih, wFrac: bw / iw, hFrac: bh / ih };
  }

  // Crops an arbitrary box down to a centered sub-rectangle of exactly
  // targetAR — the same idea as object-fit:cover treating a photo shaped
  // like the box as it's placed into a targetAR tile: crop the box's
  // longer axis, keep its shorter axis in full. Used to fit a free-ratio
  // crop into the gallery's fixed 4:3 tile.
  function subRectForTargetAR(box, iw, ih, targetAR) {
    const bw = box.wFrac * iw, bh = box.hFrac * ih;
    const boxAR = bw / bh;
    let subW, subH;
    if (boxAR > targetAR) { subH = bh; subW = bh * targetAR; }
    else { subW = bw; subH = subW / targetAR; }
    const subX = box.xFrac * iw + (bw - subW) / 2;
    const subY = box.yFrac * ih + (bh - subH) / 2;
    return { xFrac: subX / iw, yFrac: subY / ih, wFrac: subW / iw, hFrac: subH / ih };
  }

  // Places the crop-box overlay div to match frameState.cropBox — the box
  // lives in image-fraction coordinates so this is the only place that
  // needs to know the image's current on-screen size.
  function positionFrameCropBoxDom() {
    if (!frameState || !frameState.cropBox) return;
    const wrapRect = el.lightboxImageWrap.getBoundingClientRect();
    const imgRect = el.lightboxImg.getBoundingClientRect();
    const box = frameState.cropBox;
    el.frameCropBox.style.left = `${imgRect.left - wrapRect.left + box.xFrac * imgRect.width}px`;
    el.frameCropBox.style.top = `${imgRect.top - wrapRect.top + box.yFrac * imgRect.height}px`;
    el.frameCropBox.style.width = `${box.wFrac * imgRect.width}px`;
    el.frameCropBox.style.height = `${box.hFrac * imgRect.height}px`;
  }

  // Crop mode: show the full, untouched photo with a freely resizable box
  // on top of it (dragging the box or a corner is how the crop is chosen —
  // any shape, no locked ratio). frameState.cropBox is the single source
  // of truth for the crop's geometry throughout the whole edit — Straighten
  // mode only adds rotation on top of it, so nothing needs converting back
  // and forth when switching modes.
  function enterFrameCropMode() {
    if (!frameState) return;
    frameState.mode = 'crop';
    clearImgRenderFit(el.lightboxImg);
    el.lightboxImageWrap.classList.remove('is-framed');
    el.lightboxImageWrap.style.width = '';
    el.lightboxImageWrap.style.height = '';
    el.frameGrid.classList.add('is-hidden');
    el.frameCropBox.classList.remove('is-hidden');
    el.frameRotateRow.classList.add('is-hidden');
    el.frameCropHint.classList.remove('is-hidden');
    el.frameStraightenHint.classList.add('is-hidden');
    el.frameCropModeBtn.classList.add('is-active');
    el.frameStraightenModeBtn.classList.remove('is-active');
    positionFrameCropBoxDom();
  }

  // Straighten mode: show the cropped result (frameState.cropBox, at its
  // own shape) with the fixed thirds-grid and the rotate slider.
  function enterFrameStraightenMode() {
    if (!frameState) return;
    frameState.mode = 'straighten';
    el.frameCropBox.classList.add('is-hidden');
    el.frameGrid.classList.remove('is-hidden');
    el.frameRotateRow.classList.remove('is-hidden');
    el.frameCropHint.classList.add('is-hidden');
    el.frameStraightenHint.classList.remove('is-hidden');
    el.frameStraightenModeBtn.classList.add('is-active');
    el.frameCropModeBtn.classList.remove('is-active');
    applyFrameEditLive();
  }

  function startFrameEdit() {
    const shot = currentLightboxShot();
    if (!shot) return;
    endTwistTrace(); // the two tools need conflicting views of the photo (cropped vs. full) — only one at a time
    endCenterPick();
    const iw = el.lightboxImg.naturalWidth, ih = el.lightboxImg.naturalHeight;
    const existing = shot.frame;
    frameState = {
      rotationDeg: existing ? existing.rotationDeg : 0,
      // Reopening restores the exact saved box; a brand-new frame starts
      // as the whole photo selected, so "pull the edges in to crop" reads
      // literally rather than starting from some arbitrary default shape.
      cropBox: existing
        ? frameBoxFromRenderFit(existing.lightbox, iw, ih)
        : { xFrac: 0, yFrac: 0, wFrac: 1, hFrac: 1 },
      mode: 'crop',
      dragging: null,
    };
    el.frameRotateRange.value = String(frameState.rotationDeg);
    el.frameRotateValue.textContent = `${frameState.rotationDeg}°`;
    el.frameControls.classList.remove('is-hidden');
    el.frameEditBtn.classList.add('is-hidden');
    el.frameResetBtn.classList.add('is-hidden');
    el.frameSaveBtn.classList.remove('is-hidden');
    el.frameCancelBtn.classList.remove('is-hidden');
    enterFrameCropMode();
  }

  function endFrameEdit() {
    if (!frameState) return;
    frameState = null;
    el.frameControls.classList.add('is-hidden');
    el.frameGrid.classList.add('is-hidden');
    el.frameCropBox.classList.add('is-hidden');
  }

  // Converts a mouse event to a point in natural-image-pixel coordinates —
  // the crop box's own math (and its stored fractions) all live there, so
  // this is the one place that needs to know the image's on-screen rect.
  function frameNaturalPointFromEvent(e) {
    const imgRect = el.lightboxImg.getBoundingClientRect();
    const iw = el.lightboxImg.naturalWidth, ih = el.lightboxImg.naturalHeight;
    return {
      x: (e.clientX - imgRect.left) * (iw / imgRect.width),
      y: (e.clientY - imgRect.top) * (ih / imgRect.height),
    };
  }

  // Resizes the crop box from one corner handle, keeping the opposite
  // corner fixed. Width and height move independently — no locked ratio —
  // clamped so the box never runs off the photo or shrinks to a sliver.
  function frameResizeCropBox(handle, startBox, point, iw, ih) {
    const startBx = startBox.xFrac * iw, startBy = startBox.yFrac * ih;
    const startBw = startBox.wFrac * iw, startBh = startBox.hFrac * ih;
    const minW = iw * 0.05, minH = ih * 0.05;
    const growRight = handle === 'se' || handle === 'ne';
    const growDown = handle === 'se' || handle === 'sw';
    const anchorX = growRight ? startBx : startBx + startBw;
    const anchorY = growDown ? startBy : startBy + startBh;

    let w = Math.max(minW, Math.abs(point.x - anchorX));
    w = Math.min(w, growRight ? iw - anchorX : anchorX);
    let h = Math.max(minH, Math.abs(point.y - anchorY));
    h = Math.min(h, growDown ? ih - anchorY : anchorY);

    const bx = growRight ? anchorX : anchorX - w;
    const by = growDown ? anchorY : anchorY - h;
    return { xFrac: bx / iw, yFrac: by / ih, wFrac: w / iw, hFrac: h / ih };
  }

  el.frameCropBox.addEventListener('mousedown', (e) => {
    if (!frameState || frameState.mode !== 'crop' || e.target.classList.contains('lightbox__frame-handle')) return;
    e.preventDefault();
    frameState.dragging = { type: 'move', startPoint: frameNaturalPointFromEvent(e), startBox: { ...frameState.cropBox } };
  });
  el.frameCropBox.querySelectorAll('.lightbox__frame-handle').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      if (!frameState || frameState.mode !== 'crop') return;
      e.preventDefault();
      e.stopPropagation();
      frameState.dragging = { type: 'resize', handle: handle.dataset.handle, startBox: { ...frameState.cropBox } };
    });
  });
  window.addEventListener('mousemove', (e) => {
    if (!frameState || !frameState.dragging || frameState.mode !== 'crop') return;
    const iw = el.lightboxImg.naturalWidth, ih = el.lightboxImg.naturalHeight;
    if (!iw || !ih) return;
    const point = frameNaturalPointFromEvent(e);
    if (frameState.dragging.type === 'move') {
      const { startPoint, startBox } = frameState.dragging;
      const dxFrac = (point.x - startPoint.x) / iw, dyFrac = (point.y - startPoint.y) / ih;
      frameState.cropBox = {
        ...startBox,
        xFrac: Math.min(1 - startBox.wFrac, Math.max(0, startBox.xFrac + dxFrac)),
        yFrac: Math.min(1 - startBox.hFrac, Math.max(0, startBox.yFrac + dyFrac)),
      };
    } else {
      frameState.cropBox = frameResizeCropBox(frameState.dragging.handle, frameState.dragging.startBox, point, iw, ih);
    }
    positionFrameCropBoxDom();
  });
  window.addEventListener('mouseup', () => {
    if (frameState) frameState.dragging = null;
  });

  el.frameCropModeBtn.addEventListener('click', () => enterFrameCropMode());
  el.frameStraightenModeBtn.addEventListener('click', () => enterFrameStraightenMode());
  el.frameRotateRange.addEventListener('input', () => {
    if (!frameState) return;
    frameState.rotationDeg = Number(el.frameRotateRange.value);
    el.frameRotateValue.textContent = `${frameState.rotationDeg}°`;
    applyFrameEditLive();
  });

  el.frameEditBtn.addEventListener('click', () => startFrameEdit());
  el.frameCancelBtn.addEventListener('click', () => {
    const shot = currentLightboxShot();
    endFrameEdit();
    if (shot) { updateLightboxFrameDisplay(shot); renderFrameSection(shot); }
  });
  el.frameSaveBtn.addEventListener('click', () => {
    const shot = currentLightboxShot();
    if (!shot || !frameState || !frameState.cropBox) return;
    const iw = el.lightboxImg.naturalWidth, ih = el.lightboxImg.naturalHeight;
    const cropBox = frameState.cropBox;
    const boxAR = (cropBox.wFrac * iw) / (cropBox.hFrac * ih);
    const lightboxFit = frameRenderFit(cropBox, iw, ih);
    const gridSub = subRectForTargetAR(cropBox, iw, ih, GRID_TARGET_AR);
    const gridFit = frameRenderFit(gridSub, iw, ih);
    shot.frame = {
      rotationDeg: frameState.rotationDeg,
      lightbox: { ...lightboxFit, aspectRatio: boxAR },
      grid: gridFit,
    };
    markManifestDirty();
    endFrameEdit();
    updateLightboxFrameDisplay(shot);
    renderFrameSection(shot);
    refreshVisibleShotThumbnail(shot);
  });
  el.frameResetBtn.addEventListener('click', () => {
    const shot = currentLightboxShot();
    if (!shot || !shot.frame) return;
    if (!confirm('Reset the framing for this photo back to the original?')) return;
    delete shot.frame;
    markManifestDirty();
    updateLightboxFrameDisplay(shot);
    renderFrameSection(shot);
    refreshVisibleShotThumbnail(shot);
  });

  // ---------- "Center" — one-click boat-centering for Manoeuvre Sequence bursts ----------
  // Dragging a crop box by hand for every photo in a 10+ shot burst is slow.
  // This is a fast alternative for that specific case: click once where the
  // boat is, and the photo is framed (reusing the exact same shot.frame
  // model Framing saves) so that point sits centered. Re-clicking on an
  // already-framed shot re-centers on the new point but keeps the same zoom
  // level, so stepping through the burst afterwards holds a consistent
  // frame — only the pan changes, matching where the boat actually was.
  const CENTER_BOX_FRAC = 0.6; // default zoom for a shot with no frame yet — leaves room to pan without re-scanning the whole photo
  let centerPickActive = false;

  function startCenterPick() {
    const shot = currentLightboxShot();
    if (!shot) return;
    endTwistTrace();
    endFrameEdit();
    centerPickActive = true;
    updateLightboxFrameDisplay(shot, true); // show the full unframed photo so any point on it can be clicked
    el.frameCenterHint.classList.remove('is-hidden');
    el.frameCenterBtn.classList.add('is-hidden');
    el.frameCenterCancelBtn.classList.remove('is-hidden');
    el.frameEditBtn.classList.add('is-hidden');
    el.frameResetBtn.classList.add('is-hidden');
  }

  function endCenterPick() {
    if (!centerPickActive) return;
    centerPickActive = false;
    el.frameCenterHint.classList.add('is-hidden');
    el.frameCenterCancelBtn.classList.add('is-hidden');
  }

  function applyCenterPick(clickFrac) {
    const shot = currentLightboxShot();
    if (!shot || !centerPickActive) return;
    const iw = el.lightboxImg.naturalWidth, ih = el.lightboxImg.naturalHeight;
    if (!iw || !ih) { endCenterPick(); return; }
    let wFrac = CENTER_BOX_FRAC, hFrac = CENTER_BOX_FRAC;
    if (shot.frame) {
      // Keep the existing zoom level — only move where it's centered.
      const existingBox = frameBoxFromRenderFit(shot.frame.lightbox, iw, ih);
      wFrac = existingBox.wFrac;
      hFrac = existingBox.hFrac;
    }
    wFrac = Math.min(1, wFrac);
    hFrac = Math.min(1, hFrac);
    const cropBox = {
      xFrac: Math.min(1 - wFrac, Math.max(0, clickFrac.xFrac - wFrac / 2)),
      yFrac: Math.min(1 - hFrac, Math.max(0, clickFrac.yFrac - hFrac / 2)),
      wFrac,
      hFrac,
    };
    const boxAR = (cropBox.wFrac * iw) / (cropBox.hFrac * ih);
    const lightboxFit = frameRenderFit(cropBox, iw, ih);
    const gridSub = subRectForTargetAR(cropBox, iw, ih, GRID_TARGET_AR);
    const gridFit = frameRenderFit(gridSub, iw, ih);
    shot.frame = {
      rotationDeg: shot.frame ? shot.frame.rotationDeg : 0,
      lightbox: { ...lightboxFit, aspectRatio: boxAR },
      grid: gridFit,
    };
    markManifestDirty();
    endCenterPick();
    updateLightboxFrameDisplay(shot);
    renderFrameSection(shot);
    refreshVisibleShotThumbnail(shot);
  }

  el.lightboxImageWrap.addEventListener('click', (e) => {
    if (!centerPickActive) return;
    applyCenterPick(twistFracFromEvent(e));
  });
  el.frameCenterBtn.addEventListener('click', () => startCenterPick());
  el.frameCenterCancelBtn.addEventListener('click', () => {
    const shot = currentLightboxShot();
    endCenterPick();
    if (shot) { updateLightboxFrameDisplay(shot); renderFrameSection(shot); }
  });

  // ---------- twist profile: trace the mainsail leech and plot its offset from the boom up to the masthead, as a % of mast height ----------
  // Straight Line Upwind shots only. The user clicks two points on the
  // photo — the boom/traveller reference (bottom) and roughly the masthead
  // (top) — and the app auto-traces the leech edge between them by
  // following the strongest local brightness edge column-by-column. The
  // result is editable: double-click a point to pick it up, move the
  // mouse, double-click again to drop it in its corrected spot.
  //
  // Persisted on the shot as `twistProfile: { points: [{xFrac,yFrac}, ...] }`
  // — image-fraction coordinates (0-1 of the photo's natural width/height),
  // ordered bottom (boom) to top (head) — so it survives a re-render at any
  // display size and publishes/downloads the same way every other edit does.

  function currentLightboxShot() {
    return existingManifest.shots.find(s => s.id === currentLightboxShotId) || null;
  }

  // Keeps the overlay's viewBox matched to the photo's own pixel aspect
  // ratio. Without this, a square-ish default viewBox stretched onto a
  // tall/narrow sail crop would draw the point handles as ellipses instead
  // of circles — this makes 1 viewBox unit = 1 photo pixel in both axes.
  // Keeps the overlay tracking the photo's current on-screen geometry —
  // whether that's the full original (unframed) or a saved crop/rotation
  // (framed). The viewBox always covers the FULL natural photo pixel space
  // (0 0 w h), so a point's stored {xFrac,yFrac} is always a fraction of
  // the whole original photo regardless of what's currently visible — but
  // when a frame is in effect, the overlay's own CSS box (and its rotate())
  // is set to the exact same position:absolute/width/height/left/top/
  // transform-origin/rotate as the <img>'s, so its coordinate space maps
  // onto the screen identically to the photo's, crop and rotation included.
  // Points and clicks are then converted with the SVG's own screen CTM
  // (twistNaturalFracFromEvent) rather than hand-derived trig, so this is
  // the only place that needs to know the current frame's geometry.
  function syncTwistOverlayViewBox() {
    const w = el.lightboxImg.naturalWidth, h = el.lightboxImg.naturalHeight;
    if (!w || !h) return;
    el.twistOverlay.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const isFramed = el.lightboxImg.classList.contains('is-framed');
    const shot = currentLightboxShot();
    if (isFramed && shot && shot.frame) {
      const fit = shot.frame.lightbox;
      el.twistOverlay.style.position = 'absolute';
      el.twistOverlay.style.width = `${fit.widthPct}%`;
      el.twistOverlay.style.height = `${fit.heightPct}%`;
      el.twistOverlay.style.left = `${fit.leftPct}%`;
      el.twistOverlay.style.top = `${fit.topPct}%`;
      el.twistOverlay.style.right = 'auto';
      el.twistOverlay.style.bottom = 'auto';
      el.twistOverlay.style.transformOrigin = `${fit.originXPct}% ${fit.originYPct}%`;
      el.twistOverlay.style.transform = `rotate(${shot.frame.rotationDeg}deg)`;
    } else {
      el.twistOverlay.style.position = '';
      el.twistOverlay.style.width = '';
      el.twistOverlay.style.height = '';
      el.twistOverlay.style.left = '';
      el.twistOverlay.style.top = '';
      el.twistOverlay.style.right = '';
      el.twistOverlay.style.bottom = '';
      el.twistOverlay.style.transformOrigin = '';
      el.twistOverlay.style.transform = '';
    }
    if (twistState) renderTwistOverlay();
  }

  function twistImgDims() {
    return { w: el.lightboxImg.naturalWidth || 1000, h: el.lightboxImg.naturalHeight || 1000 };
  }

  function updateTwistHint(text) {
    el.twistHint.textContent = text || '';
    el.twistHint.classList.toggle('is-hidden', !text);
  }

  // Converts a pointer event over the photo into image-fraction coordinates
  // (0-1), regardless of how the photo is currently scaled on screen.
  function twistFracFromEvent(e) {
    const rect = el.lightboxImageWrap.getBoundingClientRect();
    const xFrac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const yFrac = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    return { xFrac, yFrac };
  }

  // Same job as twistFracFromEvent (screen click -> fraction of the full
  // original photo), but correct even while a crop/rotation frame is
  // showing: it goes through the overlay SVG's own screen CTM, which the
  // browser keeps accurate for whatever position/size/rotate transform
  // syncTwistOverlayViewBox last applied to it — no hand-derived trig
  // needed. The overlay's viewBox is always 0 0 naturalWidth naturalHeight,
  // so the point it resolves to is already in natural-pixel coordinates.
  function twistNaturalFracFromEvent(e) {
    const svg = el.twistOverlay;
    const iw = el.lightboxImg.naturalWidth, ih = el.lightboxImg.naturalHeight;
    const ctm = svg.getScreenCTM();
    if (!ctm || !iw || !ih) return twistFracFromEvent(e);
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgP = pt.matrixTransform(ctm.inverse());
    return {
      xFrac: Math.min(1, Math.max(0, svgP.x / iw)),
      yFrac: Math.min(1, Math.max(0, svgP.y / ih)),
    };
  }

  // ---- pixel analysis: load the photo into an offscreen canvas we can read back ----
  // Requires the image host to send CORS headers (the R2 bucket now does —
  // see its CORS Policy setting); without that, getImageData throws and the
  // trace falls back to a straight line between the two clicked points.
  function loadImageDataForAnalysis(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const scale = Math.min(1, TWIST_ANALYSIS_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        try {
          resolve({ imageData: ctx.getImageData(0, 0, w, h), width: w, height: h });
        } catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error('could not load the photo for analysis'));
      // The lightbox's own <img> already loaded this same URL without a
      // crossorigin attribute, which the browser caches as a non-CORS-
      // validated response. Requesting the identical URL here with
      // crossOrigin='anonymous' would reuse that cached response and fail
      // to load every time, silently defeating auto-trace. A cache-busting
      // query param forces a fresh, properly CORS-validated request.
      const bust = (url.includes('?') ? '&' : '?') + '_cb=' + Date.now();
      img.src = url + bust;
    });
  }

  // Shared pixel-edge helpers, used both by the initial dense trace
  // (traceLeechEdge) and by the per-point snapping that runs whenever a
  // point is added or dragged (see snapFracToLeech below). Kept as plain
  // functions closing over an {imageData,width,height} triple so both call
  // sites can reuse the identical scoring logic.
  function twistLuminanceAt(imageData, width, height, x, y) {
    x = Math.max(0, Math.min(width - 1, Math.round(x)));
    y = Math.max(0, Math.min(height - 1, Math.round(y)));
    const data = imageData.data;
    const i = (y * width + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  function twistEdgeStrengthAt(imageData, width, height, x, y) {
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) {
      sum += Math.abs(
        twistLuminanceAt(imageData, width, height, x + 2, y + dy) -
        twistLuminanceAt(imageData, width, height, x - 2, y + dy)
      );
    }
    return sum;
  }
  // Searches a window around aroundX (at fixed pixel row y) for the
  // strongest vertical edge (biggest horizontal brightness gradient) —
  // that's the sail/background boundary. Returns both the best x found and
  // its score, so callers can decide whether the signal was strong enough
  // to trust (see TWIST_EDGE_MIN_SCORE).
  function twistFindEdgeX(imageData, width, height, y, aroundX) {
    const searchRadius = Math.max(12, Math.round(width * TWIST_SEARCH_RADIUS_FRAC));
    const lo = Math.max(0, Math.round(aroundX - searchRadius));
    const hi = Math.min(width - 1, Math.round(aroundX + searchRadius));
    let bestX = aroundX, bestScore = -1;
    for (let x = lo; x <= hi; x++) {
      const score = twistEdgeStrengthAt(imageData, width, height, x, y);
      if (score > bestScore) { bestScore = score; bestX = x; }
    }
    return { x: bestX, score: bestScore };
  }

  // Follows the leech edge from (startX,startY) up to (endX,endY) in image
  // pixel space, sampling TWIST_DENSE_STEPS+1 evenly-spaced heights. At each
  // height it searches a window around the previous point's x for the
  // strongest vertical edge — that's the sail/background boundary. A
  // weak/ambiguous local signal (open sky, low contrast) falls back toward
  // the straight reference line rather than snapping onto noise. Always
  // traces at the same dense resolution regardless of how many points the
  // user wants to see — see resamplePoints() for the step that thins this
  // down.
  function traceLeechEdge(imageData, width, height, startX, startY, endX, endY) {
    const points = [{ x: startX, y: startY }];
    let curX = startX;
    for (let s = 1; s <= TWIST_DENSE_STEPS; s++) {
      const y = startY + ((endY - startY) * s) / TWIST_DENSE_STEPS;
      const predictedX = startX + ((endX - startX) * s) / TWIST_DENSE_STEPS;
      const found = twistFindEdgeX(imageData, width, height, y, curX);
      let bestX = found.x;
      if (found.score < TWIST_EDGE_MIN_SCORE) bestX = curX + (predictedX - curX) * 0.5;
      points.push({ x: bestX, y });
      curX = bestX;
    }
    return points;
  }

  // Thins an evenly-height-spaced point list down to n points, still evenly
  // spaced by the same height parameter (interpolating between the two
  // nearest dense points when n doesn't divide evenly). Used to turn the
  // dense pixel-level trace into the handful of points the user actually
  // sees and can drag.
  function resamplePoints(pts, n) {
    n = Math.max(2, Math.min(n, pts.length));
    if (n === pts.length) return pts.slice();
    const lastIdx = pts.length - 1;
    const out = [];
    for (let i = 0; i < n; i++) {
      const pos = (i / (n - 1)) * lastIdx;
      const lo = Math.floor(pos), hi = Math.min(lastIdx, Math.ceil(pos));
      const t = pos - lo;
      const a = pts[lo], b = pts[hi];
      out.push({ xFrac: a.xFrac + (b.xFrac - a.xFrac) * t, yFrac: a.yFrac + (b.yFrac - a.yFrac) * t });
    }
    return out;
  }

  // Loads (once) and caches the analyzable pixel data for the shot currently
  // being traced, on twistState itself, so that per-point edge snapping
  // (snapFracToLeech below) doesn't have to reload/redecode the photo on
  // every drag — it's the same canvas ImageData the dense trace used.
  async function getTwistImageAnalysis(shot) {
    if (twistState && twistState.imageAnalysis && twistState.imageAnalysisFile === shot.file) {
      return twistState.imageAnalysis;
    }
    const analysis = await loadImageDataForAnalysis(shot.file);
    if (twistState) {
      twistState.imageAnalysis = analysis;
      twistState.imageAnalysisFile = shot.file;
    }
    return analysis;
  }

  // Traces the leech edge at full (dense) resolution and returns it as
  // image-fraction points. Point-count reduction happens separately, in
  // resamplePoints(), so adjusting the point count later doesn't need to
  // re-scan the photo.
  async function traceDenseFrac(shot, referenceFrac, headFrac) {
    try {
      const { imageData, width, height } = await getTwistImageAnalysis(shot);
      const startX = referenceFrac.xFrac * width, startY = referenceFrac.yFrac * height;
      const endX = headFrac.xFrac * width, endY = headFrac.yFrac * height;
      const pxPoints = traceLeechEdge(imageData, width, height, startX, startY, endX, endY);
      return pxPoints.map(p => ({ xFrac: p.x / width, yFrac: p.y / height }));
    } catch (e) {
      // CORS/network failure — still give the user something to correct by
      // hand rather than a dead end: a straight line between their two clicks.
      console.error('Twist auto-trace fell back to a straight line:', e);
      const pts = [];
      for (let s = 0; s <= TWIST_DENSE_STEPS; s++) {
        const t = s / TWIST_DENSE_STEPS;
        pts.push({
          xFrac: referenceFrac.xFrac + (headFrac.xFrac - referenceFrac.xFrac) * t,
          yFrac: referenceFrac.yFrac + (headFrac.yFrac - referenceFrac.yFrac) * t,
        });
      }
      return pts;
    }
  }

  // Snaps a single image-fraction point onto the nearest strong leech edge
  // at that same height, using the cached analysis from the trace already
  // in progress. Synchronous (no re-decoding), so it's cheap enough to run
  // on every pointer-move while dragging. If no analysis is cached yet (or
  // the local signal is too weak/ambiguous to trust), the point is
  // returned unchanged — same "don't snap onto noise" fallback the dense
  // trace uses.
  function snapFracToLeech(frac) {
    const analysis = twistState && twistState.imageAnalysis;
    if (!analysis) return frac;
    const { imageData, width, height } = analysis;
    const x = frac.xFrac * width, y = frac.yFrac * height;
    const found = twistFindEdgeX(imageData, width, height, y, x);
    if (found.score < TWIST_EDGE_MIN_SCORE) return frac;
    return { xFrac: found.x / width, yFrac: frac.yFrac };
  }

  // Softens a point list so a single point that snapped to a slightly
  // different spot on the leech than its neighbors doesn't read as a kink —
  // one pass blending each interior point toward the average of its two
  // neighbors. The two endpoints (the user's original boom/masthead
  // reference clicks) are left alone so the trace still starts and ends
  // exactly where the user anchored it.
  function smoothTwistPoints(points) {
    if (!points || points.length < 3) return points;
    const out = points.map(p => ({ ...p }));
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1], cur = points[i], next = points[i + 1];
      out[i].xFrac = cur.xFrac * 0.5 + (prev.xFrac + next.xFrac) * 0.25;
    }
    return out;
  }

  // The combined "put it on the leech, then smooth it out" pass run
  // whenever the point set changes shape (a point count change, or a
  // finished drag): snaps every point to its local edge, then smooths.
  function refineTwistPoints(points) {
    const snapped = points.map(p => snapFracToLeech(p));
    return smoothTwistPoints(snapped);
  }

  // ---- overlay: the traced line + draggable points, drawn on the photo itself ----
  function renderTwistOverlay() {
    const svg = el.twistOverlay;
    svg.innerHTML = '';
    if (!twistState) return;
    const pts = (twistState.points && twistState.points.length) ? twistState.points
      : (twistState.referenceFrac ? [twistState.referenceFrac] : []);
    if (pts.length === 0) return;
    const { w, h } = twistImgDims();
    const px = (p) => ({ x: p.xFrac * w, y: p.yFrac * h });
    const r = Math.max(4, Math.round(Math.min(w, h) * 0.006));

    if (pts.length > 1) {
      const line = document.createElementNS(SVG_NS, 'polyline');
      line.setAttribute('points', pts.map(p => { const c = px(p); return `${c.x},${c.y}`; }).join(' '));
      line.setAttribute('class', 'twist-overlay__line');
      svg.appendChild(line);
    }
    pts.forEach((p, i) => {
      const c = px(p);
      const isEndpoint = i === 0 || i === pts.length - 1;
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', c.x);
      circle.setAttribute('cy', c.y);
      circle.setAttribute('r', isEndpoint ? r * 1.3 : r);
      circle.setAttribute('class', 'twist-overlay__point' + (isEndpoint ? ' is-endpoint' : '') + (twistState.dragIndex === i ? ' is-dragging' : ''));
      svg.appendChild(circle);
    });
  }

  function startTwistTrace() {
    const shot = currentLightboxShot();
    if (!shot) return;
    // Traces at whatever scale the photo is currently shown at — cropped/
    // zoomed if the shot has a saved frame, full otherwise — so a trace
    // made while zoomed into the sail stays at that same zoom instead of
    // jumping back out to the full photo. The overlay tracks the frame's
    // geometry (see syncTwistOverlayViewBox) so clicks still land correctly
    // either way.
    twistState = { mode: 'await-reference', referenceFrac: null, headFrac: null, points: [], dragIndex: null, imageAnalysis: null, imageAnalysisFile: null };
    el.twistOverlay.classList.remove('is-hidden');
    el.twistOverlay.classList.add('is-active');
    el.twistTraceBtn.classList.add('is-hidden');
    el.twistClearBtn.classList.add('is-hidden');
    el.twistSaveBtn.classList.add('is-hidden');
    el.twistCancelBtn.classList.remove('is-hidden');
    updateTwistHint('Click the boom/traveller reference point on the photo.');
    renderTwistOverlay();
  }

  function endTwistTrace() {
    twistState = null;
    el.twistOverlay.classList.add('is-hidden');
    el.twistOverlay.classList.remove('is-active');
    el.twistOverlay.innerHTML = '';
    updateTwistHint('');
  }

  async function advanceTwistPick(frac) {
    if (twistState.mode === 'await-reference') {
      twistState.referenceFrac = frac;
      twistState.mode = 'await-head';
      updateTwistHint('Now click near the top of the leech (the masthead).');
      renderTwistOverlay();
    } else if (twistState.mode === 'await-head') {
      twistState.headFrac = frac;
      twistState.mode = 'tracing';
      updateTwistHint('Tracing the leech edge…');
      const shot = currentLightboxShot();
      const dense = await traceDenseFrac(shot, twistState.referenceFrac, twistState.headFrac);
      if (!twistState || twistState.mode !== 'tracing') return; // trace was cancelled while awaiting
      twistState.densePoints = dense; // kept so the point-count stepper can re-thin without re-scanning the photo
      twistState.points = refineTwistPoints(resamplePoints(dense, twistPointCount));
      twistState.mode = 'editing';
      twistState.dragIndex = null;
      updateTwistHint('Double-click a point to pick it up, double-click again to drop it in place. Then Save.');
      el.twistSaveBtn.classList.remove('is-hidden');
      renderTwistOverlay();
    }
  }

  // Changes how many points are shown/edited — clamped to
  // [TWIST_POINT_COUNT_MIN, TWIST_POINT_COUNT_MAX]. If a trace is already in
  // progress, re-thins it from the cached dense trace immediately (no need
  // to re-scan the photo); otherwise it just applies to the next trace.
  function setTwistPointCount(n) {
    n = Math.max(TWIST_POINT_COUNT_MIN, Math.min(TWIST_POINT_COUNT_MAX, n));
    if (n === twistPointCount) return;
    twistPointCount = n;
    el.twistPointCountLabel.textContent = String(twistPointCount);
    if (twistState && twistState.mode === 'editing' && twistState.densePoints) {
      twistState.points = refineTwistPoints(resamplePoints(twistState.densePoints, twistPointCount));
      twistState.dragIndex = null;
      renderTwistOverlay();
    }
  }
  el.twistPointsMinus.addEventListener('click', () => setTwistPointCount(twistPointCount - 1));
  el.twistPointsPlus.addEventListener('click', () => setTwistPointCount(twistPointCount + 1));
  el.twistPointCountLabel.textContent = String(twistPointCount);

  el.twistOverlay.addEventListener('click', (e) => {
    if (!twistState || (twistState.mode !== 'await-reference' && twistState.mode !== 'await-head')) return;
    advanceTwistPick(twistNaturalFracFromEvent(e));
  });
  el.twistOverlay.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (!twistState || twistState.mode !== 'editing') return;
    const frac = twistNaturalFracFromEvent(e);
    if (twistState.dragIndex === null) {
      let bestI = -1, bestD = Infinity;
      twistState.points.forEach((p, i) => {
        const d = Math.hypot(p.xFrac - frac.xFrac, p.yFrac - frac.yFrac);
        if (d < bestD) { bestD = d; bestI = i; }
      });
      if (bestI >= 0 && bestD < 0.06) twistState.dragIndex = bestI;
    } else {
      // Dropping a point: snap it onto the nearest leech edge at that
      // height, then smooth the whole line so the newly-placed point
      // doesn't read as a kink against its neighbors.
      twistState.points[twistState.dragIndex] = snapFracToLeech(frac);
      twistState.dragIndex = null;
      twistState.points = smoothTwistPoints(twistState.points);
    }
    renderTwistOverlay();
  });
  el.twistOverlay.addEventListener('mousemove', (e) => {
    if (!twistState || twistState.dragIndex === null) return;
    // Snap live while dragging too, so the line visibly follows the leech
    // as the point moves, not just once it's dropped.
    twistState.points[twistState.dragIndex] = snapFracToLeech(twistNaturalFracFromEvent(e));
    renderTwistOverlay();
  });

  el.twistTraceBtn.addEventListener('click', () => startTwistTrace());
  el.twistCancelBtn.addEventListener('click', () => {
    endTwistTrace();
    const shot = currentLightboxShot();
    if (shot) { renderTwistSection(shot); updateLightboxFrameDisplay(shot); }
  });
  el.twistSaveBtn.addEventListener('click', () => {
    const shot = currentLightboxShot();
    if (!shot || !twistState || !twistState.points || twistState.points.length < 2) return;
    shot.twistProfile = { points: twistState.points.map(p => ({ xFrac: p.xFrac, yFrac: p.yFrac })) };
    markManifestDirty();
    endTwistTrace();
    renderTwistSection(shot);
    updateLightboxFrameDisplay(shot);
  });
  el.twistClearBtn.addEventListener('click', () => {
    const shot = currentLightboxShot();
    if (!shot || !shot.twistProfile) return;
    if (!confirm('Clear the twist trace for this photo?')) return;
    delete shot.twistProfile;
    markManifestDirty();
    renderTwistSection(shot);
  });

  // ---- graph: height% (0=boom, 100=masthead) vs leech offset (% of mast height) ----
  function computeTwistCurve(shot) {
    const tp = shot.twistProfile;
    if (!tp || !Array.isArray(tp.points) || tp.points.length < 2) return null;
    const iw = el.lightboxImg.naturalWidth, ih = el.lightboxImg.naturalHeight;
    if (!iw || !ih) return null;
    const pts = tp.points;
    const ref = pts[0], head = pts[pts.length - 1];
    const refPx = { x: ref.xFrac * iw, y: ref.yFrac * ih };
    const headPx = { x: head.xFrac * iw, y: head.yFrac * ih };
    const mastHeightPx = refPx.y - headPx.y; // image y grows downward, so the head sits at a smaller y
    if (!(mastHeightPx > 0)) return null;
    return pts.map(p => {
      const ppx = { x: p.xFrac * iw, y: p.yFrac * ih };
      return {
        heightPct: ((refPx.y - ppx.y) / mastHeightPx) * 100,
        offsetPct: ((ppx.x - refPx.x) / mastHeightPx) * 100,
      };
    });
  }

  function renderTwistGraph(shot) {
    const curve = computeTwistCurve(shot);
    const svg = el.twistGraph;
    svg.innerHTML = '';
    if (!curve) return;
    const plotW = TWIST_GRAPH_W - TWIST_GRAPH_PAD.left - TWIST_GRAPH_PAD.right;
    const plotH = TWIST_GRAPH_H - TWIST_GRAPH_PAD.top - TWIST_GRAPH_PAD.bottom;
    const offsets = curve.map(p => p.offsetPct);
    let xMin = Math.min(0, ...offsets), xMax = Math.max(0, ...offsets);
    if (xMax - xMin < 1) { xMax += 1; xMin -= 1; }
    const xPad = (xMax - xMin) * 0.12;
    xMin -= xPad; xMax += xPad;
    const xOf = (v) => TWIST_GRAPH_PAD.left + ((v - xMin) / (xMax - xMin)) * plotW;
    const yOf = (v) => TWIST_GRAPH_PAD.top + (1 - v / 100) * plotH;

    const axisX = document.createElementNS(SVG_NS, 'line');
    axisX.setAttribute('x1', xOf(xMin)); axisX.setAttribute('x2', xOf(xMax));
    axisX.setAttribute('y1', yOf(0)); axisX.setAttribute('y2', yOf(0));
    axisX.setAttribute('class', 'twist-graph__axis');
    svg.appendChild(axisX);
    const axisY = document.createElementNS(SVG_NS, 'line');
    axisY.setAttribute('x1', xOf(0)); axisY.setAttribute('x2', xOf(0));
    axisY.setAttribute('y1', yOf(0)); axisY.setAttribute('y2', yOf(100));
    axisY.setAttribute('class', 'twist-graph__axis');
    svg.appendChild(axisY);

    [0, 50, 100].forEach(hPct => {
      const gl = document.createElementNS(SVG_NS, 'line');
      gl.setAttribute('x1', xOf(xMin)); gl.setAttribute('x2', xOf(xMax));
      gl.setAttribute('y1', yOf(hPct)); gl.setAttribute('y2', yOf(hPct));
      gl.setAttribute('class', 'twist-graph__grid');
      svg.appendChild(gl);
      const lbl = document.createElementNS(SVG_NS, 'text');
      lbl.setAttribute('x', TWIST_GRAPH_PAD.left - 6);
      lbl.setAttribute('y', yOf(hPct) + 3);
      lbl.setAttribute('class', 'twist-graph__label twist-graph__label--y');
      lbl.textContent = hPct + '%';
      svg.appendChild(lbl);
    });

    const poly = document.createElementNS(SVG_NS, 'polyline');
    poly.setAttribute('points', curve.map(p => `${xOf(p.offsetPct)},${yOf(p.heightPct)}`).join(' '));
    poly.setAttribute('class', 'twist-graph__curve');
    svg.appendChild(poly);
    curve.forEach(p => {
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', xOf(p.offsetPct));
      dot.setAttribute('cy', yOf(p.heightPct));
      dot.setAttribute('r', 2);
      dot.setAttribute('class', 'twist-graph__dot');
      svg.appendChild(dot);
    });

    const cap = document.createElementNS(SVG_NS, 'text');
    cap.setAttribute('x', TWIST_GRAPH_W / 2);
    cap.setAttribute('y', TWIST_GRAPH_H - 4);
    cap.setAttribute('class', 'twist-graph__label twist-graph__label--x');
    cap.textContent = 'Leech offset (% of mast height)';
    svg.appendChild(cap);
  }

  function renderTwistSection(shot) {
    const isUpwind = (shot.category || 'other') === 'upwind';
    el.twistSection.classList.toggle('is-hidden', !isUpwind);
    if (!isUpwind) return;
    const hasTrace = shot.twistProfile && Array.isArray(shot.twistProfile.points) && shot.twistProfile.points.length >= 2;
    el.twistTraceBtn.textContent = hasTrace ? 'Re-trace' : 'Trace';
    el.twistTraceBtn.classList.remove('is-hidden');
    el.twistClearBtn.classList.toggle('is-hidden', !hasTrace);
    el.twistSaveBtn.classList.add('is-hidden');
    el.twistCancelBtn.classList.add('is-hidden');
    updateTwistHint('');
    if (hasTrace) {
      renderTwistGraph(shot);
      el.twistGraph.classList.remove('is-hidden');
    } else {
      el.twistGraph.innerHTML = '';
      el.twistGraph.classList.add('is-hidden');
    }
  }

  // ---------- gallery edits: delete a published shot, change its category, add a comment ----------
  // All three act straight on existingManifest so the gallery updates
  // immediately. What happens next depends on whether a GitHub token is on
  // file (see connectGithub() below): with one, the change publishes itself
  // in the background; without one, this falls back to the original
  // download/discard bar so nothing is ever silently lost.
  function currentManifestSnapshot(overrides = {}) {
    return {
      timestampColumn: existingManifest.timestampColumn || '',
      headingColumn: existingManifest.headingColumn || '',
      twaColumn: existingManifest.twaColumn || '',
      variables: existingManifest.variables || [],
      shots: existingManifest.shots || [],
      dayNotes: existingManifest.dayNotes || {},
      overlayLayout: existingManifest.overlayLayout || {},
      ...overrides,
    };
  }

  let publishDebounceTimer = null;
  let publishInFlight = false;
  let publishQueued = false;
  let githubStatusFadeTimer = null;

  function setGithubStatus(kind, message) {
    clearTimeout(githubStatusFadeTimer);
    el.githubStatus.innerHTML = '';
    el.githubStatus.classList.remove('github-status--saving', 'github-status--saved', 'github-status--error');
    if (kind === 'saving') {
      el.githubStatus.classList.remove('is-hidden');
      el.githubStatus.classList.add('github-status--saving');
      el.githubStatus.textContent = 'Saving to GitHub…';
    } else if (kind === 'saved') {
      el.githubStatus.classList.remove('is-hidden');
      el.githubStatus.classList.add('github-status--saved');
      el.githubStatus.textContent = 'Saved — live on the site in about a minute';
      githubStatusFadeTimer = setTimeout(() => el.githubStatus.classList.add('is-hidden'), 5000);
    } else if (kind === 'error') {
      el.githubStatus.classList.remove('is-hidden');
      el.githubStatus.classList.add('github-status--error');
      el.githubStatus.append(`Couldn't publish automatically: ${message || 'unknown error'}. `);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'text-link';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => publishManifestToGithub());
      el.githubStatus.appendChild(retry);
      // Fall back to the manual bar too, so the change is never stuck only
      // as an in-memory edit with no way out if retries keep failing.
      el.galleryChangesBar.classList.remove('is-hidden');
    } else {
      el.githubStatus.classList.add('is-hidden');
    }
  }

  // Reads the manifest file's current sha (required by GitHub's API to
  // confirm we're not overwriting someone else's newer commit) and PUTs the
  // updated content in its place — the same "get sha, then commit" dance
  // the GitHub web UI does under the hood.
  async function publishManifestToGithub() {
    const token = getGithubToken();
    if (!token) return false;
    if (publishInFlight) { publishQueued = true; return true; }
    publishInFlight = true;
    setGithubStatus('saving');
    try {
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
      const getRes = await fetch(`${GITHUB_API_URL}?ref=${GITHUB_BRANCH}`, { headers, cache: 'no-store' });
      if (!getRes.ok) throw new Error(getRes.status === 401 ? 'token rejected — reconnect GitHub' : `couldn't read the current file (${getRes.status})`);
      const currentFile = await getRes.json();
      const manifest = currentManifestSnapshot();
      const putRes = await fetch(GITHUB_API_URL, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Update sail shots manifest',
          content: utf8ToBase64(JSON.stringify(manifest, null, 2)),
          sha: currentFile.sha,
          branch: GITHUB_BRANCH,
        }),
      });
      if (!putRes.ok) {
        const errBody = await putRes.json().catch(() => ({}));
        throw new Error(errBody.message || `GitHub rejected the update (${putRes.status})`);
      }
      manifestDirty = false;
      el.galleryChangesBar.classList.add('is-hidden');
      setGithubStatus('saved');
      return true;
    } catch (err) {
      console.error('Publish to GitHub failed:', err);
      setGithubStatus('error', err.message);
      return false;
    } finally {
      publishInFlight = false;
      if (publishQueued) { publishQueued = false; publishManifestToGithub(); }
    }
  }

  // debounceMs lets frequent edits (typing a comment) wait for a pause
  // before publishing, instead of committing on every keystroke; discrete
  // edits (delete, category) publish right away.
  function schedulePublish(debounceMs) {
    if (publishDebounceTimer) { clearTimeout(publishDebounceTimer); publishDebounceTimer = null; }
    if (!debounceMs) { publishManifestToGithub(); return; }
    publishDebounceTimer = setTimeout(() => { publishDebounceTimer = null; publishManifestToGithub(); }, debounceMs);
  }
  function flushPendingPublish() {
    if (publishDebounceTimer) { clearTimeout(publishDebounceTimer); publishDebounceTimer = null; publishManifestToGithub(); }
  }

  function markManifestDirty(opts = {}) {
    manifestDirty = true;
    if (getGithubToken()) schedulePublish(opts.debounceMs || 0);
    else el.galleryChangesBar.classList.remove('is-hidden');
  }
  function clearManifestDirty() {
    manifestDirty = false;
    el.galleryChangesBar.classList.add('is-hidden');
  }

  function deleteShot(shotId) {
    const shot = existingManifest.shots.find(s => s.id === shotId);
    if (!shot) return false;
    const label = filenameOf(shot.file) || 'this photo';
    const publishNote = getGithubToken()
      ? 'This publishes automatically — it\'ll be off the live site in about a minute.'
      : 'This removes it from manifest.json — you\'ll still need to download and publish the update below.';
    if (!confirm(`Delete ${label} from the gallery?\n\n${publishNote} The photo file itself stays in the repo until that's done.`)) {
      return false;
    }
    existingManifest.shots = existingManifest.shots.filter(s => s.id !== shotId);
    markManifestDirty();
    renderGallery();
    return true;
  }

  function setShotCategory(shotId, category) {
    const shot = existingManifest.shots.find(s => s.id === shotId);
    if (!shot || shot.category === category) return;
    shot.category = category;
    markManifestDirty();
    renderGallery();
  }

  // Unlike category, a comment is free text typed one keystroke at a time —
  // re-rendering the whole grid on every keystroke (like setShotCategory
  // does) would blow away focus and cursor position mid-type, so this just
  // updates the data model and flags the manifest dirty without touching
  // the DOM. Both the card's comment box and the lightbox's write through
  // this same function, so either stays in sync with existingManifest.
  // Auto-publish is debounced here (unlike delete/category) so it commits
  // once after a pause in typing, not on every keystroke.
  function setShotComment(shotId, comment) {
    const shot = existingManifest.shots.find(s => s.id === shotId);
    if (!shot || (shot.comment || '') === comment) return;
    shot.comment = comment;
    syncShotCommentDom(shotId, comment);
    markManifestDirty({ debounceMs: 1500 });
  }

  // Whichever box the comment was just typed into updates existingManifest
  // above, but the *other* box (grid card vs. lightbox) still shows
  // whatever it had at its own last render — so mirror the new value into
  // it here. Skips the currently-focused element so this never clobbers an
  // in-progress keystroke or cursor position in the box the user is
  // actually typing in.
  function syncShotCommentDom(shotId, comment) {
    document.querySelectorAll(`.shot-card__comment[data-shot-id="${CSS.escape(shotId)}"]`).forEach(box => {
      if (box !== document.activeElement && box.value !== comment) box.value = comment;
    });
    if (currentLightboxShotId === shotId && el.lightboxComment !== document.activeElement && el.lightboxComment.value !== comment) {
      el.lightboxComment.value = comment;
    }
  }

  el.galleryDownloadChanges.addEventListener('click', () => {
    downloadManifestFile(currentManifestSnapshot());
    clearManifestDirty();
  });
  el.galleryDiscardChanges.addEventListener('click', () => {
    if (!confirm('Discard your unpublished deletes/category changes and reload the published manifest.json?')) return;
    clearManifestDirty();
    loadManifest();
  });

  // ---------- connecting GitHub for automatic publishing ----------
  function updateGithubConnectBtn() {
    const connected = !!getGithubToken();
    el.githubConnectBtn.textContent = connected ? 'GitHub: Connected' : 'Connect GitHub';
    el.githubConnectBtn.setAttribute('aria-pressed', connected ? 'true' : 'false');
  }
  el.githubConnectBtn.addEventListener('click', () => {
    if (getGithubToken()) {
      if (confirm('Disconnect GitHub?\n\nDeletes, category changes and comments will go back to the manual download/publish flow until you reconnect.')) {
        setGithubToken('');
        updateGithubConnectBtn();
        setGithubStatus('idle');
      }
      return;
    }
    const token = prompt(
      'Paste a GitHub personal access token to publish gallery edits automatically.\n\n' +
      'Create a fine-grained token at github.com/settings/personal-access-tokens/new, scoped ONLY to the "Seagull" repository, with "Contents" permission set to Read and write.\n\n' +
      'It\'s stored only in this browser and sent only to api.github.com — never anywhere else.'
    );
    if (token && token.trim()) {
      setGithubToken(token.trim());
      updateGithubConnectBtn();
    }
  });

  // ---------- import: CSV step ----------
  function populateTimestampSelect() {
    el.timestampSelect.innerHTML = '';
    csvHeaders.forEach(h => {
      const opt = document.createElement('option');
      opt.value = h; opt.textContent = h;
      el.timestampSelect.appendChild(opt);
    });
    const saved = loadConfig();
    timestampColumn = (saved.timestampColumn && csvHeaders.includes(saved.timestampColumn))
      ? saved.timestampColumn
      : guessTimestampHeader(csvHeaders);
    el.timestampSelect.value = timestampColumn;
  }

  function populateClassifyColumns() {
    const saved = loadConfig();
    [el.headingSelect, el.twaSelect].forEach(sel => {
      sel.innerHTML = '';
      const noneOpt = document.createElement('option');
      noneOpt.value = ''; noneOpt.textContent = '— none, skip auto-categorizing —';
      sel.appendChild(noneOpt);
      csvHeaders.forEach(h => {
        const opt = document.createElement('option');
        opt.value = h; opt.textContent = h;
        sel.appendChild(opt);
      });
    });
    headingColumn = (saved.headingColumn && csvHeaders.includes(saved.headingColumn)) ? saved.headingColumn : guessHeadingHeader(csvHeaders);
    twaColumn = (saved.twaColumn && csvHeaders.includes(saved.twaColumn)) ? saved.twaColumn : guessTwaHeader(csvHeaders);
    el.headingSelect.value = headingColumn;
    el.twaSelect.value = twaColumn;
  }

  function populateVariablePicker() {
    const saved = loadConfig();
    const savedVars = Array.isArray(saved.variables) ? saved.variables : null;
    const candidates = csvHeaders.filter(h => h !== timestampColumn);
    selectedVars = new Set(savedVars ? savedVars.filter(v => candidates.includes(v)) : candidates);
    if (selectedVars.size === 0 && !savedVars) candidates.forEach(v => selectedVars.add(v));
    renderVariablePicker(candidates);
  }

  function renderVariablePicker(candidates) {
    el.variablePicker.innerHTML = '';
    candidates.forEach(h => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'col-chip' + (selectedVars.has(h) ? ' is-active' : '');
      chip.textContent = h;
      chip.addEventListener('click', () => {
        if (selectedVars.has(h)) selectedVars.delete(h); else selectedVars.add(h);
        chip.classList.toggle('is-active');
        saveConfig();
        rematchAllPhotos();
      });
      el.variablePicker.appendChild(chip);
    });
  }

  el.csvInput.addEventListener('change', async () => {
    const file = el.csvInput.files[0];
    if (!file) return;
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length < 2) {
      alert('That CSV has no data rows below the header.');
      return;
    }
    csvHeaders = rows[0].map(h => h.trim());
    csvRows = rows.slice(1)
      .filter(r => r.some(c => c !== ''))
      .map(r => Object.fromEntries(csvHeaders.map((h, idx) => [h, (r[idx] ?? '').trim()])));

    el.csvDropLabel.textContent = file.name;
    el.csvSummary.textContent = `${csvRows.length} rows · ${csvHeaders.length} columns`;
    el.csvSummary.classList.remove('is-hidden');

    populateTimestampSelect();
    buildSortedRows();
    populateClassifyColumns();
    populateVariablePicker();
    el.csvConfig.classList.remove('is-hidden');
    saveConfig();
    rematchAllPhotos();
  });

  el.timestampSelect.addEventListener('change', () => {
    timestampColumn = el.timestampSelect.value;
    buildSortedRows();
    const candidates = csvHeaders.filter(h => h !== timestampColumn);
    selectedVars = new Set([...selectedVars].filter(v => candidates.includes(v)));
    renderVariablePicker(candidates);
    saveConfig();
    rematchAllPhotos();
  });

  el.headingSelect.addEventListener('change', () => {
    headingColumn = el.headingSelect.value;
    saveConfig();
    rematchAllPhotos();
  });
  el.twaSelect.addEventListener('change', () => {
    twaColumn = el.twaSelect.value;
    saveConfig();
    rematchAllPhotos();
  });

  el.varsAll.addEventListener('click', () => {
    csvHeaders.filter(h => h !== timestampColumn).forEach(h => selectedVars.add(h));
    renderVariablePicker(csvHeaders.filter(h => h !== timestampColumn));
    saveConfig();
    rematchAllPhotos();
  });
  el.varsNone.addEventListener('click', () => {
    selectedVars.clear();
    renderVariablePicker(csvHeaders.filter(h => h !== timestampColumn));
    saveConfig();
    rematchAllPhotos();
  });

  // ---------- import: photo step ----------
  function existingFileNames() {
    return new Set(existingManifest.shots.map(s => filenameOf(s.file)));
  }

  el.photoInput.addEventListener('change', async () => {
    const files = [...el.photoInput.files];
    if (files.length === 0) return;
    el.photoDropLabel.textContent = `${files.length} photo${files.length === 1 ? '' : 's'} selected`;

    const newPhotos = await Promise.all(files.map(async file => {
      const { date, source } = await readCaptureDate(file);
      return {
        file, name: file.name, capturedAt: date, source,
        matchedRow: null, matchedIndex: -1, gapSeconds: null,
        category: 'other', categoryManual: false,
      };
    }));
    photos = photos.concat(newPhotos);
    rematchAllPhotos();
    el.previewStep.classList.remove('is-hidden');
    el.publishStep.classList.remove('is-hidden');
    el.downloadManifest.disabled = photos.length === 0;
  });

  function renderPreview() {
    el.previewList.innerHTML = '';
    const existingNames = existingFileNames();
    const seenInBatch = new Set();
    photos.forEach((p, idx) => {
      const item = document.createElement('div');
      item.className = 'preview-item';

      const thumb = document.createElement('img');
      thumb.className = 'preview-item__thumb';
      thumb.src = URL.createObjectURL(p.file);
      thumb.alt = '';
      item.appendChild(thumb);

      const meta = document.createElement('div');
      meta.className = 'preview-item__meta';
      const name = document.createElement('span');
      name.className = 'preview-item__name';
      name.textContent = p.name;
      meta.appendChild(name);

      const detail = document.createElement('span');
      detail.className = 'preview-item__detail';
      if (!p.capturedAt) {
        detail.textContent = 'No capture time found';
      } else {
        const sourceLabel = p.source === 'exif' ? 'from photo EXIF' : 'from file date (approx.)';
        detail.textContent = `${p.capturedAt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${sourceLabel}`;
      }
      meta.appendChild(detail);

      let badge = null;
      if (!p.capturedAt || !timestampColumn || csvRows.length === 0) {
        badge = { cls: 'preview-badge--danger', text: csvRows.length === 0 ? 'No boat data loaded' : 'No capture time' };
      } else if (!p.matchedRow) {
        badge = { cls: 'preview-badge--danger', text: 'No match found' };
      } else if (p.gapSeconds > GAP_WARN_SECONDS) {
        badge = { cls: 'preview-badge--warn', text: `${Math.round(p.gapSeconds / 60)} min gap` };
      } else {
        badge = { cls: 'preview-badge--ok', text: `${Math.round(p.gapSeconds)}s gap` };
      }
      const badgeEl = document.createElement('span');
      badgeEl.className = `preview-badge ${badge.cls}`;
      badgeEl.textContent = badge.text;
      meta.appendChild(document.createElement('br'));
      meta.appendChild(badgeEl);

      const isDuplicate = existingNames.has(p.name) || seenInBatch.has(p.name);
      seenInBatch.add(p.name);
      if (isDuplicate) {
        const dupBadge = document.createElement('span');
        dupBadge.className = 'preview-badge preview-badge--warn';
        dupBadge.textContent = 'Filename already used — rename before uploading';
        meta.appendChild(document.createElement('br'));
        meta.appendChild(dupBadge);
      }

      const catLabel = document.createElement('label');
      catLabel.className = 'preview-item__category';
      const catLabelText = document.createElement('span');
      catLabelText.textContent = p.categoryManual ? 'Category (set by you)' : 'Category (auto-suggested)';
      catLabel.appendChild(catLabelText);
      const catSelect = document.createElement('select');
      CATEGORIES.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.value; opt.textContent = c.label;
        if ((p.category || 'other') === c.value) opt.selected = true;
        catSelect.appendChild(opt);
      });
      catSelect.addEventListener('change', () => {
        p.category = catSelect.value;
        p.categoryManual = true;
        catLabelText.textContent = 'Category (set by you)';
      });
      catLabel.appendChild(catSelect);
      meta.appendChild(catLabel);

      item.appendChild(meta);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'preview-item__remove';
      removeBtn.setAttribute('aria-label', `Remove ${p.name}`);
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        photos.splice(idx, 1);
        renderPreview();
        el.downloadManifest.disabled = photos.length === 0;
      });
      item.appendChild(removeBtn);

      el.previewList.appendChild(item);
    });
  }

  // ---------- publish ----------
  function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  function buildManifest() {
    const newShots = photos
      .filter(p => p.capturedAt)
      .map(p => ({
        id: `${p.capturedAt.toISOString().replace(/[:.]/g, '-')}-${slugify(p.name.replace(/\.[^.]+$/, '')) || 'shot'}`,
        // The photo itself isn't published through this page — it's dragged
        // into the R2 bucket separately (see the Publish step below), using
        // this exact filename as the object name.
        file: `${R2_PHOTO_BASE_URL}/${encodeURIComponent(p.name)}`,
        capturedAt: p.capturedAt.toISOString(),
        capturedAtSource: p.source,
        gapSeconds: p.gapSeconds,
        category: p.category || 'other',
        row: p.matchedRow || {},
        comment: '',
      }));

    const dayNotes = { ...(existingManifest.dayNotes || {}) };
    const noteText = (el.dayNotesInput.value || '').trim();
    if (noteText) {
      const datesInBatch = new Set(photos.filter(p => p.capturedAt).map(p => dateKeyOf({ capturedAt: p.capturedAt.toISOString() })));
      datesInBatch.forEach(d => { dayNotes[d] = noteText; });
    }

    return {
      timestampColumn,
      headingColumn,
      twaColumn,
      variables: [...selectedVars],
      shots: [...existingManifest.shots, ...newShots],
      dayNotes,
      overlayLayout: existingManifest.overlayLayout || {},
    };
  }

  function downloadManifestFile(manifest) {
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'manifest.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  el.downloadManifest.addEventListener('click', () => {
    downloadManifestFile(buildManifest());
  });

  // ---------- add-shots toggle ----------
  el.addBtn.addEventListener('click', () => {
    const isOpen = !el.importView.classList.contains('is-hidden');
    el.importView.classList.toggle('is-hidden', isOpen);
    el.addBtn.setAttribute('aria-pressed', String(!isOpen));
    el.addBtn.textContent = isOpen ? 'Add Shots' : 'Hide';
  });

  updateGithubConnectBtn();
  loadManifest();
})();
