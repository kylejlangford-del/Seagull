(() => {
  const MANIFEST_PATH = './manifest.json';
  const CONFIG_KEY = 'seagull-sailshots-config-v1';
  const GAP_WARN_SECONDS = 30 * 60; // 30 minutes

  // ---------- categorization tuning ----------
  const CLASSIFY_WINDOW_SECONDS = 15; // how far either side of the photo to look
  const TURN_RATE_THRESHOLD = 3; // avg deg/sec heading swing across the window counts as "turning"
  const DOWNWIND_TWA_THRESHOLD = 90; // |TWA| >= this => downwind, below => upwind
  const GYBE_TWA_THRESHOLD = 150; // |TWA| passing this close to dead-run during a turn => gybe, not a tack

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
    importView: document.getElementById('importView'),
    galleryView: document.getElementById('galleryView'),
    emptyState: document.getElementById('emptyState'),
    editLayoutBtn: document.getElementById('editLayoutBtn'),
    dateTabs: document.getElementById('dateTabs'),
    categoryChips: document.getElementById('categoryChips'),
    shotGrid: document.getElementById('shotGrid'),
    galleryChangesBar: document.getElementById('galleryChangesBar'),
    galleryDiscardChanges: document.getElementById('galleryDiscardChanges'),
    galleryDownloadChanges: document.getElementById('galleryDownloadChanges'),

    overlayEditor: document.getElementById('overlayEditor'),
    overlayEditorClose: document.getElementById('overlayEditorClose'),
    overlayEditorShotSelect: document.getElementById('overlayEditorShotSelect'),
    overlayEditorImageWrap: document.getElementById('overlayEditorImageWrap'),
    overlayEditorImg: document.getElementById('overlayEditorImg'),
    overlayEditorBoxes: document.getElementById('overlayEditorBoxes'),
    overlayEditorReset: document.getElementById('overlayEditorReset'),
    overlayEditorCancel: document.getElementById('overlayEditorCancel'),
    overlayEditorLock: document.getElementById('overlayEditorLock'),

    lightbox: document.getElementById('lightbox'),
    lightboxClose: document.getElementById('lightboxClose'),
    lightboxDelete: document.getElementById('lightboxDelete'),
    lightboxImageWrap: document.getElementById('lightboxImageWrap'),
    lightboxImg: document.getElementById('lightboxImg'),
    lightboxBoxes: document.getElementById('lightboxBoxes'),
    lightboxCategory: document.getElementById('lightboxCategory'),
    lightboxDate: document.getElementById('lightboxDate'),

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

  // set once a shot is deleted or re-categorized from the gallery (not the
  // import flow) — these edits happen straight against existingManifest so
  // the page reflects them immediately, but like everything else here they
  // aren't "real" until published, so a banner offers a manifest download
  // rather than firing one on every click
  let manifestDirty = false;

  // working copy of overlayLayout edited while the overlay editor is open —
  // nothing here touches existingManifest (or the published site) until the
  // user hits "Lock positions", same as every other edit in this app
  let overlayWorkingPositions = {};
  let overlayEditorShotId = null;

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

  // ---------- overlay box positioning (shared by the gallery and the editor) ----------
  // Vars with no locked position yet default into two columns — the first
  // half of the variable list down the left edge, the second half down the
  // right — with nothing placed in the horizontal middle, since that's where
  // the boat/mast usually sits in these shots. Each column's row spacing is
  // computed from how many variables actually landed in it, spread evenly
  // between a top and bottom margin, so it always fits the frame regardless
  // of how many variables are selected (rather than a fixed step that could
  // run past the bottom on a long list). The right column is anchored from
  // the RIGHT edge (not left, like the left column) so a long label's own
  // width never pushes it past the edge of the photo — only left/top offsets
  // can't guarantee that, since box width varies with the variable name.
  // This is only ever the un-arranged starting point; the same order is used
  // in the gallery, the lightbox and the editor so a box looks the same
  // wherever it appears until it's dragged onto a custom saved position.
  const OVERLAY_TOP_PCT = 32;
  const OVERLAY_BOTTOM_PCT = 78;
  const OVERLAY_EDGE_PCT = 3;
  // Single-column mode stacks every box down one edge instead of splitting
  // left/right, so it doesn't need the tighter 32-78 band that two-column
  // mode uses to dodge the gallery card's delete button and category badge
  // (the lightbox's own delete/category controls sit outside this band, or
  // off to the opposite side). With up to ~20+ variables all in one column,
  // it needs the extra room — 32-78 only leaves enough vertical space per
  // row for roughly a dozen items before rows start overlapping each other.
  const OVERLAY_SINGLE_TOP_PCT = 6;
  const OVERLAY_SINGLE_BOTTOM_PCT = 97;
  // A left/right split only makes sense when the photo is wide enough that
  // "3% from the left" and "3% from the right" land nowhere near each other.
  // The gallery card is always cropped to a fixed 4:3 box, so it's always
  // wide enough — but the lightbox and the overlay editor show the photo at
  // its own natural size, and a portrait-oriented shot (common for an
  // on-the-water action photo — see DSC01118, 3376x6000 once its EXIF
  // rotation is applied) is narrow enough that both columns collide right
  // over the boat in the middle. singleColumn stacks every box down one
  // edge instead, so it never happens.
  const OVERLAY_LANDSCAPE_MIN_RATIO = 1.15;
  function isLandscapeImage(imgEl) {
    if (!imgEl || !imgEl.naturalWidth || !imgEl.naturalHeight) return true; // unknown yet — assume the normal (two-column) case
    return imgEl.naturalWidth / imgEl.naturalHeight >= OVERLAY_LANDSCAPE_MIN_RATIO;
  }
  function defaultOverlayPosition(index, total, singleColumn) {
    if (singleColumn) {
      const yPct = total <= 1 ? OVERLAY_SINGLE_TOP_PCT : OVERLAY_SINGLE_TOP_PCT + (index * (OVERLAY_SINGLE_BOTTOM_PCT - OVERLAY_SINGLE_TOP_PCT)) / (total - 1);
      return { xPct: OVERLAY_EDGE_PCT, yPct };
    }
    const leftCount = Math.ceil(total / 2);
    const inLeft = index < leftCount;
    const col = inLeft ? index : index - leftCount;
    const colSize = inLeft ? leftCount : (total - leftCount);
    const yPct = colSize <= 1 ? OVERLAY_TOP_PCT : OVERLAY_TOP_PCT + (col * (OVERLAY_BOTTOM_PCT - OVERLAY_TOP_PCT)) / (colSize - 1);
    return inLeft ? { xPct: OVERLAY_EDGE_PCT, yPct } : { rightPct: OVERLAY_EDGE_PCT, yPct };
  }
  function getOverlayPosition(varName, index, positions, total, singleColumn) {
    const saved = positions && positions[varName];
    return (saved && typeof saved.xPct === 'number' && typeof saved.yPct === 'number') ? saved : defaultOverlayPosition(index, total, singleColumn);
  }
  // Applies a computed position to a box element — left-anchored ({xPct}) or
  // right-anchored ({rightPct}, only ever a default, never a dragged/saved
  // position — dragging always saves an {xPct} from the left, same as before).
  function placeOverlayBox(box, pos) {
    if (pos.rightPct !== undefined) { box.style.right = `${pos.rightPct}%`; box.style.left = ''; }
    else { box.style.left = `${pos.xPct}%`; box.style.right = ''; }
    box.style.top = `${pos.yPct}%`;
  }
  function round1(n) { return Math.round(n * 10) / 10; }

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

  function formatShotDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'Unknown time';
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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

  function renderGallery() {
    const shots = existingManifest.shots || [];
    const hasShots = shots.length > 0;
    el.emptyState.classList.toggle('is-hidden', hasShots);
    el.editLayoutBtn.classList.toggle('is-hidden', !hasShots);
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
    const sorted = [...filtered].sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));

    el.shotGrid.innerHTML = '';
    const vars = existingManifest.variables || [];
    sorted.forEach(shot => {
      const card = document.createElement('article');
      card.className = 'shot-card';

      const imgWrap = document.createElement('div');
      imgWrap.className = 'shot-card__image-wrap';
      const img = document.createElement('img');
      img.src = `./${shot.file}`;
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

      const row = shot.row || {};
      const overlayLayout = existingManifest.overlayLayout || {};
      // The gallery card always crops the photo to a fixed 4:3 tile (see
      // .shot-card__image-wrap), so it's always wide enough for two columns
      // regardless of the source photo's own orientation.
      vars.forEach((v, i) => {
        if (row[v] === undefined || row[v] === '') return;
        const pos = getOverlayPosition(v, i, overlayLayout, vars.length, false);
        const box = document.createElement('div');
        box.className = 'overlay-box';
        placeOverlayBox(box, pos);
        box.innerHTML = `<span></span><b></b>`;
        box.querySelector('b').textContent = formatOverlayValue(v, row[v]);
        box.querySelector('span').textContent = v;
        imgWrap.appendChild(box);
      });

      imgWrap.classList.add('is-clickable');
      imgWrap.addEventListener('click', () => openLightbox(shot));

      card.appendChild(imgWrap);
      el.shotGrid.appendChild(card);
    });
  }

  // ---------- lightbox (full-size photo view) ----------
  // The card thumbnails are cropped to a 4:3 tile; the lightbox shows the
  // whole, uncropped photo instead — that's the point of "full screen". The
  // image wrap has no explicit size of its own (see CSS: display:inline-block
  // around a size-capped <img>), so it shrink-wraps to exactly the image's
  // rendered box with no letterboxing, and the same percentage-based overlay
  // positions land correctly on the full photo without any extra math.
  let currentLightboxShotId = null;

  function openLightbox(shot) {
    const vars = existingManifest.variables || [];
    const overlayLayout = existingManifest.overlayLayout || {};
    const row = shot.row || {};
    currentLightboxShotId = shot.id;

    // The lightbox shows the photo at its own natural (uncropped) aspect
    // ratio, so whether a two-column default layout fits depends on this
    // particular photo's orientation — which isn't known until it has
    // actually loaded. Render once immediately in case it's already
    // decoded (e.g. reopening the same shot, where a repeat load event
    // isn't guaranteed), and again on load to correct it once known.
    const renderBoxes = () => {
      if (currentLightboxShotId !== shot.id) return; // a different shot opened in the meantime
      const singleColumn = !isLandscapeImage(el.lightboxImg);
      el.lightboxBoxes.innerHTML = '';
      vars.forEach((v, i) => {
        if (row[v] === undefined || row[v] === '') return;
        const pos = getOverlayPosition(v, i, overlayLayout, vars.length, singleColumn);
        const box = document.createElement('div');
        box.className = 'overlay-box';
        placeOverlayBox(box, pos);
        box.innerHTML = `<span></span><b></b>`;
        box.querySelector('b').textContent = formatOverlayValue(v, row[v]);
        box.querySelector('span').textContent = v;
        el.lightboxBoxes.appendChild(box);
      });
    };
    el.lightboxImg.onload = renderBoxes;
    el.lightboxImg.src = `./${shot.file}`;
    el.lightboxBoxes.innerHTML = '';
    if (el.lightboxImg.complete) renderBoxes();

    el.lightboxCategory.className = `shot-card__category shot-card__category--${shot.category || 'other'}`;
    el.lightboxCategory.innerHTML = '';
    CATEGORIES.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.value; opt.textContent = c.label;
      if ((shot.category || 'other') === c.value) opt.selected = true;
      el.lightboxCategory.appendChild(opt);
    });
    el.lightboxDate.textContent = formatShotDate(shot.capturedAt);

    el.lightbox.classList.remove('is-hidden');
  }
  function closeLightbox() {
    el.lightbox.classList.add('is-hidden');
    el.lightboxImg.src = '';
    currentLightboxShotId = null;
  }
  el.lightboxClose.addEventListener('click', closeLightbox);
  el.lightbox.addEventListener('click', (e) => {
    if (e.target === el.lightbox) closeLightbox(); // click on the backdrop, not the photo itself
  });
  el.lightboxCategory.addEventListener('click', (e) => e.stopPropagation()); // don't let picking an option close the lightbox
  el.lightboxCategory.addEventListener('change', () => {
    if (!currentLightboxShotId) return;
    setShotCategory(currentLightboxShotId, el.lightboxCategory.value);
    const shot = existingManifest.shots.find(s => s.id === currentLightboxShotId);
    el.lightboxCategory.className = `shot-card__category shot-card__category--${shot.category || 'other'}`;
  });
  el.lightboxDelete.addEventListener('click', () => {
    if (!currentLightboxShotId) return;
    if (deleteShot(currentLightboxShotId)) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el.lightbox.classList.contains('is-hidden')) closeLightbox();
    else if (!el.overlayEditor.classList.contains('is-hidden')) closeOverlayEditor();
  });

  // ---------- gallery edits: delete a published shot, change its category ----------
  // Both act straight on existingManifest so the gallery updates immediately,
  // but — same rule as everything else in this no-backend app — nothing is
  // "real" until manifest.json is republished, so these just flag the change
  // and surface a download/discard bar instead of downloading a file per click.
  function markManifestDirty() {
    manifestDirty = true;
    el.galleryChangesBar.classList.remove('is-hidden');
  }
  function clearManifestDirty() {
    manifestDirty = false;
    el.galleryChangesBar.classList.add('is-hidden');
  }
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

  function deleteShot(shotId) {
    const shot = existingManifest.shots.find(s => s.id === shotId);
    if (!shot) return false;
    const label = (shot.file || '').split('/').pop() || 'this photo';
    if (!confirm(`Delete ${label} from the gallery?\n\nThis removes it from manifest.json — you'll still need to download and publish the update below. The photo file itself stays in the repo until that's done.`)) {
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

  el.galleryDownloadChanges.addEventListener('click', () => {
    downloadManifestFile(currentManifestSnapshot());
    clearManifestDirty();
  });
  el.galleryDiscardChanges.addEventListener('click', () => {
    if (!confirm('Discard your unpublished deletes/category changes and reload the published manifest.json?')) return;
    clearManifestDirty();
    loadManifest();
  });

  // ---------- overlay layout editor ----------
  function populateOverlayEditorShotSelect() {
    const shots = [...existingManifest.shots].sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));
    el.overlayEditorShotSelect.innerHTML = '';
    shots.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${(s.file || '').split('/').pop()} — ${formatShotDate(s.capturedAt)}`;
      el.overlayEditorShotSelect.appendChild(opt);
    });
    return shots[0] ? shots[0].id : null;
  }

  function renderOverlayEditorPreview() {
    const shot = existingManifest.shots.find(s => s.id === overlayEditorShotId) || existingManifest.shots[0];
    if (!shot) return;
    el.overlayEditorImg.src = `./${shot.file}`;
    el.overlayEditorBoxes.innerHTML = '';
    const vars = existingManifest.variables || [];
    const row = shot.row || {};
    // Unlike the lightbox, the editor always crops the preview to a fixed
    // 4:3 box — same as the gallery card, and for the same reason (so a
    // dragged position lands in the same spot on the card). So it's always
    // wide enough for two columns regardless of the source photo's own
    // orientation; no orientation check needed here.
    vars.forEach((v, i) => {
      const pos = getOverlayPosition(v, i, overlayWorkingPositions, vars.length, false);
      const box = document.createElement('div');
      box.className = 'overlay-box overlay-box--editable';
      placeOverlayBox(box, pos);
      box.innerHTML = `<span></span><b></b>`;
      box.querySelector('b').textContent = (row[v] !== undefined && row[v] !== '') ? formatOverlayValue(v, row[v]) : '—';
      box.querySelector('span').textContent = v;
      box.addEventListener('pointerdown', (e) => startOverlayDrag(e, v, box));
      el.overlayEditorBoxes.appendChild(box);
    });
  }

  function startOverlayDrag(e, varName, boxEl) {
    e.preventDefault();
    boxEl.setPointerCapture(e.pointerId);
    const wrapRect = el.overlayEditorImageWrap.getBoundingClientRect();
    const boxRect = boxEl.getBoundingClientRect();
    const offsetX = e.clientX - boxRect.left;
    const offsetY = e.clientY - boxRect.top;
    boxEl.classList.add('is-dragging');
    // A right-anchored default box has only `right` set in its inline style;
    // dragging always switches to a left-anchored saved position (matching
    // every other custom position), so clear `right` up front — otherwise
    // having both left and right set at once would stretch the box's width
    // to fill the gap between them instead of sizing to its own content.
    boxEl.style.right = '';

    function move(ev) {
      let xPct = ((ev.clientX - offsetX - wrapRect.left) / wrapRect.width) * 100;
      let yPct = ((ev.clientY - offsetY - wrapRect.top) / wrapRect.height) * 100;
      xPct = Math.max(0, Math.min(96, xPct));
      yPct = Math.max(0, Math.min(94, yPct));
      boxEl.style.left = `${xPct}%`;
      boxEl.style.top = `${yPct}%`;
      overlayWorkingPositions[varName] = { xPct: round1(xPct), yPct: round1(yPct) };
    }
    function up() {
      boxEl.classList.remove('is-dragging');
      boxEl.removeEventListener('pointermove', move);
      boxEl.removeEventListener('pointerup', up);
      boxEl.removeEventListener('pointercancel', up);
    }
    boxEl.addEventListener('pointermove', move);
    boxEl.addEventListener('pointerup', up);
    boxEl.addEventListener('pointercancel', up);
  }

  function openOverlayEditor() {
    if (!existingManifest.shots.length) return;
    overlayWorkingPositions = {};
    Object.entries(existingManifest.overlayLayout || {}).forEach(([k, v]) => { overlayWorkingPositions[k] = { ...v }; });
    overlayEditorShotId = populateOverlayEditorShotSelect();
    renderOverlayEditorPreview();
    el.overlayEditor.classList.remove('is-hidden');
  }
  function closeOverlayEditor() {
    el.overlayEditor.classList.add('is-hidden');
  }

  el.editLayoutBtn.addEventListener('click', openOverlayEditor);
  el.overlayEditorClose.addEventListener('click', closeOverlayEditor);
  el.overlayEditorCancel.addEventListener('click', closeOverlayEditor);
  el.overlayEditorShotSelect.addEventListener('change', () => {
    overlayEditorShotId = el.overlayEditorShotSelect.value;
    renderOverlayEditorPreview();
  });
  el.overlayEditorReset.addEventListener('click', () => {
    overlayWorkingPositions = {};
    renderOverlayEditorPreview();
  });
  el.overlayEditorLock.addEventListener('click', () => {
    existingManifest.overlayLayout = { ...overlayWorkingPositions };
    downloadManifestFile(currentManifestSnapshot());
    closeOverlayEditor();
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
    return new Set(existingManifest.shots.map(s => (s.file || '').split('/').pop()));
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
        file: `photos/${p.name}`,
        capturedAt: p.capturedAt.toISOString(),
        capturedAtSource: p.source,
        gapSeconds: p.gapSeconds,
        category: p.category || 'other',
        row: p.matchedRow || {},
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

  loadManifest();
})();
