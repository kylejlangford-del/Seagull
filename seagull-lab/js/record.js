/* record.js — a screen recording of the race itself, timed to the race clock
 * rather than to the sailor's own attention.
 *
 * "Screen recording" is the Screen Capture API under the hood, and it is one
 * of the handful of browser APIs that flatly refuses to run without a click
 * directly on it — no amount of clock-watching from this file can skip that
 * permission prompt. So the flow is: ARM RECORDING (one click, any time
 * before or during the pre-start) grants a capture of this tab and holds it
 * open; everything after that runs on its own off the race clock —
 *
 *   - starts the actual recording at T−4:00, or immediately if armed later
 *     than that;
 *   - stops it once every boat still reporting has crossed the course's own
 *     finish line — detected fresh here, since nothing upstream tracks a
 *     race that far (the rest of this tool is a pre-start and first-beat
 *     instrument) — and is silently unavailable on a course file with no
 *     finish line;
 *   - saves the file to Downloads the moment it stops.
 *
 * The STOP & SAVE button on the same control covers both "the auto-detect
 * has nothing to detect against" and "end it now regardless" — it is live
 * for the whole time a recording is running, not just as a fallback.
 *
 * Driven off the feed's own clock (LiveFeed.wallT(), gun-vs-wall-clock), not
 * off feed.t: feed.t is what the scrubber pins when looking back through
 * what has already arrived, and scrubbing to check something mid-race must
 * not pause the recording of what is actually happening live.
 */

const REC_LEAD = 240;   // T−4:00 — when an armed recording actually starts

const REC = {
  armed: false,
  recording: false,
  stream: null,
  recorder: null,
  chunks: [],
  startedWallAt: null,
  label: '',
};

function recSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.MediaRecorder);
}

async function recArm() {
  if (!recSupported()) { alert('This browser cannot record its own screen.'); return; }
  if (REC.armed || REC.recording) return;
  let stream;
  try {
    try {
      // Chrome-only hints that bias its picker toward "this tab" and skip the
      // "also share tab audio" ask — harmless where a browser does not know
      // them, since an unrecognised dictionary member is just ignored.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 }, audio: false,
        preferCurrentTab: true, selfBrowserSurface: 'include',
      });
    } catch {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    }
  } catch (e) {
    return;   // picker dismissed or denied — stay idle, nothing to report
  }
  REC.stream = stream;
  REC.armed = true;
  // The browser's own "stop sharing" pill (or closing the shared tab) ends
  // the track without ever going through recStop() below — catch it so REC
  // does not sit lit believing it still has somewhere to write frames.
  stream.getVideoTracks()[0].onended = () => {
    if (REC.recording) recStop('the shared tab or window was closed');
    else recDisarm();
  };
  syncRecBtn();
}

function recDisarm() {
  if (REC.stream) for (const t of REC.stream.getTracks()) t.stop();
  REC.stream = null;
  REC.armed = false;
  syncRecBtn();
}

function recPickMime() {
  for (const m of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9',
                    'video/webm;codecs=vp8', 'video/webm'])
    if (window.MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

function recStart(label) {
  if (!REC.armed || REC.recording || !REC.stream) return;
  REC.label = label || 'race';
  REC.chunks = [];
  const mime = recPickMime();
  try { REC.recorder = new MediaRecorder(REC.stream, mime ? { mimeType: mime } : undefined); }
  catch (e) { recDisarm(); return; }
  REC.recorder.ondataavailable = e => { if (e.data && e.data.size) REC.chunks.push(e.data); };
  REC.recorder.onstop = recSave;
  REC.recorder.start(1000);     // 1 s chunks, so a crash loses at most a second
  REC.recording = true;
  REC.startedWallAt = Date.now();
  syncRecBtn();
}

/* Both the automatic finish-line trigger and the manual STOP & SAVE button
 * land here. recSave() (below) is what actually writes the file, once the
 * recorder's own onstop fires — asynchronous, because MediaRecorder flushes
 * its last chunk before it does. */
function recStop() {
  if (!REC.recording || !REC.recorder) return;
  REC.recording = false;
  try { REC.recorder.stop(); } catch { recSave(); }
  syncRecBtn();
}

function recSave() {
  const blob = new Blob(REC.chunks, { type: (REC.recorder && REC.recorder.mimeType) || 'video/webm' });
  REC.chunks = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `seagull-${(REC.label || 'race').replace(/[^\w-]+/g, '_')}-${stamp}.webm`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
  recDisarm();                  // one arm covers one recording; back to idle
}

/* ── finish detection ───────────────────────────────────────────────────────
 *
 * Nothing upstream in rd tracks a boat past the first beat, so this scans the
 * raw tracks itself: find the course's FinishLine element (already projected
 * into the same rx/ry frame every track is in — see metrics.js's rd.course),
 * then walk each boat's samples after the gun for the first sign change of
 * signed distance to that line, clipped to close around the segment itself
 * so a boat crossing the extended line far from the real one is not counted.
 * Absent a FinishLine in the course file, this is silently unavailable —
 * REC.recording just keeps running until the STOP & SAVE button ends it. */
function recFinishFrame(rd) {
  if (!rd || !rd.course || !Array.isArray(rd.course.elements)) return null;
  const el = rd.course.elements.find(e => e.type === 'FinishLine');
  if (!el || !el.p1 || !el.p2) return null;
  const dx = el.p2.rx - el.p1.rx, dy = el.p2.ry - el.p1.ry;
  const len = Math.hypot(dx, dy);
  if (!(len > 1)) return null;
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  return {
    dtl: p => (p.rx - el.p1.rx) * nx + (p.ry - el.p1.ry) * ny,
    pct: p => ((p.rx - el.p1.rx) * ux + (p.ry - el.p1.ry) * uy) / len * 100,
  };
}

function recFinishCrossT(tr, ff) {
  if (!tr || !ff) return null;
  let prev = null;
  for (let i = 0; i < tr.n; i++) {
    const t = tr.t[i];
    if (t <= 0) continue;
    const p = tr.pts[i], d = ff.dtl(p);
    if (prev != null && prev !== 0 && (prev < 0) !== (d < 0)) {
      const pct = ff.pct(p);
      // the same slack the rest of the tool gives the start line — a hair
      // past either end still counts as crossing it, not a nearby manoeuvre
      if (pct > -25 && pct < 125) return t;
    }
    prev = d;
  }
  return null;
}

function recAllFinished(rd) {
  const ff = recFinishFrame(rd);
  if (!ff) return false;
  const teams = (rd.activeTeams && rd.activeTeams.length ? rd.activeTeams : rd.teams) || [];
  if (!teams.length) return false;
  return teams.every(team => recFinishCrossT(rd.tracks[team], ff) != null);
}

function recLabel(rd) {
  const m = (rd && rd.raw) || {};
  return m.raceId || m.venue || m.label || 'race';
}

/* Called once a frame, live tab only. wallT is the feed's own elapsed-since-
 * gun clock — see LiveFeed.wallT() in feed.js — immune to the scrubber. */
function recTick(feed, rd) {
  if (!feed || feed.kind !== 'live') return;
  const wallT = feed.wallT ? feed.wallT() : null;
  if (REC.armed && !REC.recording && wallT != null && wallT >= -REC_LEAD)
    recStart(recLabel(rd));
  if (REC.recording && rd && recAllFinished(rd))
    recStop();
  syncRecBtn();
}

function recElapsed() {
  const s = Math.max(0, (Date.now() - REC.startedWallAt) / 1000);
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function syncRecBtn() {
  const btn = document.getElementById('recBtn');
  if (!btn) return;
  btn.classList.toggle('armed', REC.armed && !REC.recording);
  btn.classList.toggle('recording', REC.recording);
  // The coloured dot is drawn by CSS (.recbtn.armed/.recording::before) —
  // putting one in the text too, as an earlier pass did, doubled it up.
  btn.textContent = REC.recording ? `REC ${recElapsed()}`
                   : REC.armed    ? 'ARMED — WAITING FOR T−4:00'
                   : 'ARM RECORDING';
  btn.title = REC.recording
    ? 'recording — click to stop and save now'
    : REC.armed
    ? 'waiting for T−4:00 (or click to cancel)'
    : 'record this screen from T−4:00 to the finish, saved to Downloads when it stops';
}

/* Called whenever the live feed underneath a recording is torn down — a tab
 * switch, a fresh CONNECT/RUN MOCK, or reopening LIVE — so a recording never
 * keeps rolling against a feed that no longer exists. A recording already in
 * progress is stopped and saved rather than silently discarded; merely armed
 * and waiting is just released, since nothing has been captured yet. */
function recTeardown() {
  if (REC.recording) recStop();
  else if (REC.armed) recDisarm();
}

function wireRecBtn() {
  const btn = document.getElementById('recBtn');
  if (!btn) return;
  btn.onclick = () => {
    if (REC.recording) recStop();
    else if (REC.armed) recDisarm();
    else recArm();
  };
  syncRecBtn();
}

// A closed tab is a lost recording — nothing left in memory to write out.
// The one thing this file CAN do about it is ask first, the same native
// "leave site?" prompt any unsaved-changes page uses.
addEventListener('beforeunload', e => {
  if (REC.recording) { e.preventDefault(); e.returnValue = ''; }
});
