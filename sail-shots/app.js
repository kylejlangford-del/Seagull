(() => {
  const MANIFEST_PATH = './manifest.json';
  const CONFIG_KEY = 'seagull-sailshots-config-v1';
  const GAP_WARN_SECONDS = 30 * 60; // 30 minutes

  const el = {
    addBtn: document.getElementById('addBtn'),
    importView: document.getElementById('importView'),
    galleryView: document.getElementById('galleryView'),
    emptyState: document.getElementById('emptyState'),
    shotGrid: document.getElementById('shotGrid'),

    csvInput: document.getElementById('csvInput'),
    csvDropLabel: document.getElementById('csvDropLabel'),
    csvSummary: document.getElementById('csvSummary'),
    csvConfig: document.getElementById('csvConfig'),
    timestampSelect: document.getElementById('timestampSelect'),
    variablePicker: document.getElementById('variablePicker'),
    varsAll: document.getElementById('varsAll'),
    varsNone: document.getElementById('varsNone'),

    photoInput: document.getElementById('photoInput'),
    photoDropLabel: document.getElementById('photoDropLabel'),

    previewStep: document.getElementById('previewStep'),
    previewList: document.getElementById('previewList'),

    publishStep: document.getElementById('publishStep'),
    downloadManifest: document.getElementById('downloadManifest'),
  };

  let existingManifest = { timestampColumn: '', variables: [], shots: [] };
  let csvHeaders = [];
  let csvRows = [];
  let timestampColumn = '';
  let selectedVars = new Set();
  let photos = []; // { file, name, capturedAt: Date|null, source: 'exif'|'file-modified'|null, matchedRow, gapSeconds, matched: bool }

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
      localStorage.setItem(CONFIG_KEY, JSON.stringify({ timestampColumn, variables: [...selectedVars] }));
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

  // ---------- matching ----------
  function matchNearestRow(capturedAt) {
    if (!capturedAt || !timestampColumn || csvRows.length === 0) return null;
    let best = null, bestDiff = Infinity;
    for (const row of csvRows) {
      const rowDate = parseTimestampValue(row[timestampColumn]);
      if (!rowDate) continue;
      const diff = Math.abs(rowDate.getTime() - capturedAt.getTime());
      if (diff < bestDiff) { bestDiff = diff; best = row; }
    }
    if (!best) return null;
    return { row: best, gapSeconds: bestDiff / 1000 };
  }

  function rematchAllPhotos() {
    photos.forEach(p => {
      const m = matchNearestRow(p.capturedAt);
      p.matchedRow = m ? m.row : null;
      p.gapSeconds = m ? m.gapSeconds : null;
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
    renderGallery();
  }

  function formatShotDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'Unknown time';
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function renderGallery() {
    const shots = [...existingManifest.shots].sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));
    el.emptyState.classList.toggle('is-hidden', shots.length > 0);
    el.shotGrid.innerHTML = '';
    const vars = existingManifest.variables || [];
    shots.forEach(shot => {
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
      card.appendChild(imgWrap);

      const body = document.createElement('div');
      body.className = 'shot-card__body';
      const row = shot.row || {};
      const shownVars = vars.filter(v => row[v] !== undefined && row[v] !== '');
      if (shownVars.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'shot-card__empty-vars';
        empty.textContent = 'No boat data matched';
        body.appendChild(empty);
      } else {
        const varsWrap = document.createElement('div');
        varsWrap.className = 'shot-card__vars';
        shownVars.forEach(v => {
          const chip = document.createElement('span');
          chip.className = 'var-chip';
          chip.innerHTML = `<b></b><span></span>`;
          chip.querySelector('b').textContent = row[v];
          chip.querySelector('span').textContent = v;
          varsWrap.appendChild(chip);
        });
        body.appendChild(varsWrap);
      }
      card.appendChild(body);
      el.shotGrid.appendChild(card);
    });
  }

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
    populateVariablePicker();
    el.csvConfig.classList.remove('is-hidden');
    saveConfig();
    rematchAllPhotos();
  });

  el.timestampSelect.addEventListener('change', () => {
    timestampColumn = el.timestampSelect.value;
    const candidates = csvHeaders.filter(h => h !== timestampColumn);
    selectedVars = new Set([...selectedVars].filter(v => candidates.includes(v)));
    renderVariablePicker(candidates);
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
      return { file, name: file.name, capturedAt: date, source, matchedRow: null, gapSeconds: null };
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
        row: p.matchedRow || {},
      }));
    return {
      timestampColumn,
      variables: [...selectedVars],
      shots: [...existingManifest.shots, ...newShots],
    };
  }

  el.downloadManifest.addEventListener('click', () => {
    const manifest = buildManifest();
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'manifest.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
