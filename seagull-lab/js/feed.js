/* feed.js — where the boats come from.
 *
 * The whole point of this file is that the rest of the tracker never learns
 * whether it is watching a live start or an archived one. There is one contract
 * — a feed pushes samples into a StartBuffer and reports a clock — and two
 * implementations behind it:
 *
 *   ReplayFeed   drives an archived start out of a data bundle at wall-clock
 *                rate. It never hands over a sample the clock has not reached,
 *                so the tracker sees exactly what it would see live: no future,
 *                gaps where the telemetry dropped out, boats appearing late.
 *
 *   LiveFeed     the same contract over a WebSocket. Written, documented and
 *                unwired — point it at a URL and it takes over from the replay
 *                with no change anywhere else.
 *
 * Getting this boundary right is the reason to build offline first. Anything
 * that reads the whole race at once — an average, a ranking, a correlation —
 * cannot exist on this side of it, and building against the replay is what
 * keeps that honest.
 */

/* Every channel a sample can carry, in the ingest pipeline's own names so an
 * archived bundle and a live message are the same object. Absent channels are
 * stored as null rather than dropped: the arrays are parallel and index i must
 * mean the same instant in all of them. */
const SAMPLE_CHANNELS =
  ['lat', 'lon', 'sog', 'hdg', 'cog', 'twd', 'tws', 'twa', 'rot',
   'dtl', 'linePct', 'pcRatio', 'pcTtk', 'pcTts',
   // carried when a harvest includes them — the boat's own target angle and
   // its leg number, which laylines prefer over inferring both
   'targTwa', 'targSog', 'leg'];

/* Channels a boat cannot be drawn without. A sample missing one of these is
 * dropped rather than stored as a hole for the spline to interpolate across. */
const SAMPLE_REQUIRED = ['lat', 'lon'];


/* ── the buffer ─────────────────────────────────────────────────────────────
 *
 * Holds everything received so far in the exact shape buildRace() reads, so the
 * live path and the archive path run the same builder. It only ever grows
 * forwards; seeking backwards in a replay resets it and replays into it again,
 * which is cheaper than it sounds and, more to the point, cannot leave a stale
 * sample from the future sitting in the arrays.
 */
class StartBuffer {
  constructor(meta) { this.meta = meta || {}; this.clear(); }

  clear() {
    this.boats = {};
    this.markWind = [];
    this._markIx = new Map();
    this.tFirst = null;
    this.tLast = null;
    this.count = 0;
    this.rev = 0;            // bumped on every accepted sample
    this.dropped = 0;
  }

  setMeta(meta) { this.meta = meta || {}; }

  _boat(team) {
    let b = this.boats[team];
    if (!b) {
      b = this.boats[team] = { t: [], manoeuvres: [], speedCheck: null, config: null };
      for (const k of SAMPLE_CHANNELS) b[k] = [];
    }
    return b;
  }

  /* Append one boat sample. Returns true if it was stored. */
  push(s) {
    if (!s || s.team == null || s.t == null || !isFinite(s.t)) { this.dropped++; return false; }
    for (const k of SAMPLE_REQUIRED)
      if (s[k] == null || !isFinite(s[k])) { this.dropped++; return false; }

    const b = this._boat(s.team);
    const n = b.t.length;
    // Out of order or a repeat of the last instant: drop it. Every reader
    // downstream binary-searches b.t and assumes it ascends.
    if (n && s.t <= b.t[n - 1]) { this.dropped++; return false; }

    b.t.push(s.t);
    for (const k of SAMPLE_CHANNELS) {
      const v = s[k];
      b[k].push(v == null || (typeof v === 'number' && !isFinite(v)) ? null : v);
    }
    if (s.config && !b.config) b.config = s.config;

    if (this.tFirst == null || s.t < this.tFirst) this.tFirst = s.t;
    if (this.tLast == null || s.t > this.tLast) this.tLast = s.t;
    this.count++;
    this.rev++;
    return true;
  }

  /* Append one course-mark wind reading. Marks are fixed, so each carries one
   * position and a growing series rather than a track. */
  pushWind(w) {
    if (!w || w.name == null || w.t == null) return false;
    let m = this._markIx.get(w.name);
    if (!m) {
      m = { name: w.name, lat: w.lat, lon: w.lon, t: [], twd: [], tws: [] };
      this._markIx.set(w.name, m);
      this.markWind.push(m);
    }
    const n = m.t.length;
    if (n && w.t <= m.t[n - 1]) return false;
    m.t.push(w.t);
    m.twd.push(w.twd == null ? null : w.twd);
    m.tws.push(w.tws == null ? null : w.tws);
    this.rev++;
    return true;
  }

  get teams() { return Object.keys(this.boats).sort(); }

  /* True once there is enough to build a frame: a line to draw and a boat on
   * the water. Marks come from the meta, so this flips on the first sample. */
  ready() {
    const m = this.meta && this.meta.marks;
    return this.count > 0 && !!(m && m.windward && m.leeward);
  }

  /* The `raw` object buildRace() wants, over the data received so far. */
  race() {
    return Object.assign({}, this.meta, {
      tRange: [this.tFirst == null ? 0 : this.tFirst, this.tLast == null ? 0 : this.tLast],
      boats: this.boats,
      markWind: this.markWind,
    });
  }
}


/* ── the contract ───────────────────────────────────────────────────────────
 *
 * A feed owns a buffer and a clock. The app calls poll() once per animation
 * frame and reads feed.t; the feed decides what that means. Everything else —
 * play, pause, seek, speed — is optional and only a replay implements it, so
 * the UI asks (`feed.seekable`) rather than assuming.
 */
class Feed {
  constructor(meta) {
    this.buffer = new StartBuffer(meta);
    this.t = 0;
    this.kind = 'feed';
    this.label = 'FEED';
    this.seekable = false;
    this.status = 'idle';      // idle | running | paused | ended | error | connecting
    this.note = '';
    this._handlers = {};
  }

  on(evt, fn) { (this._handlers[evt] || (this._handlers[evt] = [])).push(fn); return this; }
  emit(evt, payload) { for (const fn of this._handlers[evt] || []) fn(payload); }

  setStatus(status, note) {
    if (status === this.status && note === this.note) return;
    this.status = status;
    this.note = note || '';
    this.emit('status', this);
  }

  start() {}
  stop() {}
  /* Called once per frame with the wall clock in ms. Returns true if any new
   * sample landed, which is the app's cue to rebuild. */
  poll(_wallMs) { return false; }
}


/* ── replay ─────────────────────────────────────────────────────────────────
 *
 * An archived start, played out at wall-clock rate. The bundle holds the whole
 * race, and the entire job of this class is to refuse to hand most of it over:
 * samples are released only as the clock reaches them.
 */
class ReplayFeed extends Feed {
  constructor(race, opts = {}) {
    super(ReplayFeed.metaOf(race));
    this.kind = 'replay';
    this.label = 'REPLAY';
    this.seekable = true;
    this.race = race;
    this.speed = opts.speed || 1;

    const r = race.tRange || [-150, 90];
    this.tMin = r[0];
    this.tMax = r[1];
    this.t = opts.from != null ? opts.from : this.tMin;
    this.playing = false;
    this._wall = null;

    // One flat, time-ordered release schedule across every boat, so the order
    // samples arrive in is the order they were recorded in rather than
    // boat-by-boat. A live socket interleaves; a replay that did not would hide
    // every bug that interleaving causes.
    this._rows = [];
    for (const [team, b] of Object.entries(race.boats || {}))
      for (let i = 0; i < b.t.length; i++) this._rows.push({ t: b.t[i], team, i });
    this._rows.sort((a, b) => a.t - b.t);
    this._i = 0;

    this._wind = [];
    for (const m of race.markWind || [])
      for (let i = 0; i < (m.t || []).length; i++) this._wind.push({ t: m.t[i], m, i });
    this._wind.sort((a, b) => a.t - b.t);
    this._wi = 0;

    this._fill();                      // release whatever is already in the past
  }

  /* Everything about the start that is known before it starts: the line, the
   * course, the boats' configuration. Never the tracks. */
  static metaOf(race) {
    const m = {};
    // Whitelisted, not copied wholesale, so a bundle field that is really per
    // sample can never be mistaken for something known before the race. Which
    // means a genuinely new field has to be added here — `course` was, and its
    // absence showed up as a course that silently would not draw.
    for (const k of ['raceId', 'venue', 'season', 'date', 'clock', 'label', 'sessionType',
                     'gunTs', 'gunIso', 'gunClock', 'wind', 'marks', 'line', 'configs',
                     'limits', 'pinEnd', 'markScale', 'courseFile', 'course'])
      if (race[k] !== undefined) m[k] = race[k];
    return m;
  }

  play()  { if (this.t >= this.tMax) this.seek(this.tMin);
            this.playing = true;  this._wall = null; this.setStatus('running'); }
  pause() { this.playing = false; this.setStatus('paused'); }
  toggle() { this.playing ? this.pause() : this.play(); }
  setSpeed(x) { this.speed = x; this._wall = null; }

  seek(t) {
    t = Math.max(this.tMin, Math.min(this.tMax, t));
    if (t < this.t) { this.buffer.clear(); this._i = 0; this._wi = 0; }
    this.t = t;
    this._wall = null;
    this._fill();
    this.emit('data', this);
  }

  /* Release every sample the clock has passed. */
  _fill() {
    let any = false;
    const rows = this._rows, b = this.race.boats;
    while (this._i < rows.length && rows[this._i].t <= this.t) {
      const r = rows[this._i++];
      const src = b[r.team];
      const s = { team: r.team, t: r.t };
      for (const k of SAMPLE_CHANNELS) s[k] = src[k] ? src[k][r.i] : null;
      s.config = src.config;
      any = this.buffer.push(s) || any;
    }
    while (this._wi < this._wind.length && this._wind[this._wi].t <= this.t) {
      const w = this._wind[this._wi++];
      any = this.buffer.pushWind({ name: w.m.name, lat: w.m.lat, lon: w.m.lon, t: w.t,
                                   twd: w.m.twd[w.i], tws: w.m.tws[w.i] }) || any;
    }
    return any;
  }

  poll(wallMs) {
    if (!this.playing) return false;
    if (this._wall == null) { this._wall = wallMs; return false; }
    const dt = (wallMs - this._wall) / 1000 * this.speed;
    this._wall = wallMs;
    this.t = Math.min(this.tMax, this.t + dt);
    if (this.t >= this.tMax) { this.playing = false; this.setStatus('ended', 'replay finished'); }
    return this._fill();
  }
}


/* ── live ───────────────────────────────────────────────────────────────────
 *
 * The same contract over a WebSocket. Nothing in the tracker changes when this
 * replaces the replay; what has to exist on the other end is a socket that
 * sends these messages, all of them JSON, one per frame:
 *
 *   { "type": "meta",  "raceId": "...", "gunTs": 1787148900000,
 *     "marks": { "windward": {"lat":..,"lon":..}, "leeward": {...}, "M1": {...} },
 *     "wind":  { "twd": 245.3, "tws": 35.1, "confidence": "HIGH" },
 *     "limits": { "Boundary": [[lat,lon], ...] },
 *     "course": { "legs": 5, "elements": [
 *         {"type":"StartLine","coord1":{"lat":..,"lon":..},"coord2":{"lat":..,"lon":..}},
 *         {"type":"Mark","coord1":{"lat":..,"lon":..}},
 *         {"type":"Gate","coord1":{...},"coord2":{...}},
 *         {"type":"FinishLine","coord1":{...},"coord2":{...}} ] },
 *     "configs": ["m15_HAW_HSB2_HSRW2"], "pinEnd": "leeward" }
 *
 *   { "type": "sample", "team": "ITA", "t": -63.2,
 *     "lat": 54.5083, "lon": 13.6543, "sog": 68.2, "hdg": 212, "cog": 214,
 *     "twd": 245, "tws": 35, "twa": -41, "dtl": 180, "linePct": 62,
 *     "pcRatio": 1.84, "pcTtk": 12.1, "pcTts": 6.6 }
 *
 *   { "type": "samples", "rows": [ ...as above, without the type... ] }
 *   { "type": "wind", "name": "CM1", "lat":.., "lon":.., "t": -60, "twd":.., "tws":.. }
 *   { "type": "gun", "ts": 1787148900000 }        // gun time moved
 *
 * `t` is seconds from the gun, negative before it — the same clock the whole
 * tracker runs on. A sender that only knows epoch milliseconds can leave `t`
 * out and send `ts`, and it is converted here against the gun.
 *
 * Meta must arrive before the first sample: without a line there is nothing to
 * measure against. Everything else may arrive in any order, late, or twice —
 * the buffer drops what it cannot use rather than corrupting the arrays.
 */
class LiveFeed extends Feed {
  constructor(url, opts = {}) {
    super(opts.meta || null);
    this.kind = 'live';
    this.label = 'LIVE';
    // seekable gates the REPLAY transport — play/pause/speed — which a live
    // feed has none of; it is not the same question as "can you scrub back",
    // which is `live` below. Left false on purpose.
    this.seekable = false;
    this.url = url;
    this.gunTs = opts.gunTs || (opts.meta && opts.meta.gunTs) || null;
    this.clockSkewMs = 0;          // server time minus ours, if the server says
    this.lastMsgAt = null;
    // Injectable so the transport can be swapped for a mock without touching a
    // line of the protocol handling below — see js/mock-live.js.
    this.socket = opts.socket || (url => new WebSocket(url));
    this._ws = null;
    this._retry = 0;
    this._timer = null;
    this._new = false;
    // True while `t` tracks the wall clock against the gun, as it always used
    // to. seek() drops this to look back through whatever has already been
    // received — the buffer keeps filling underneath either way, since
    // ingest (below) never once asks poll() or `t` what they think the time
    // is — and goLive() (or the bottom bar's LIVE button) picks it back up.
    this.live = true;
  }

  /* The window of time there is anything to show for. Getters, not fields set
   * once like ReplayFeed's: an archive's range is fixed at open, a live
   * buffer's grows every time a sample lands. Falls back to `t` itself before
   * the first sample, so the scrubber has something sane to show at 0/0. */
  get tMin() { return this.buffer.tFirst == null ? this.t : this.buffer.tFirst; }
  get tMax() { return this.buffer.tLast  == null ? this.t : this.buffer.tLast;  }

  /* Pin the clock to a past instant already in the buffer — dragging the
   * scrubber, or the ⟲ button. Never touches the buffer itself: unlike a
   * replay's seek(), there is nothing to clear and refill, because a live
   * buffer never holds a sample from later than it was told about. */
  seek(t) {
    t = Math.max(this.tMin, Math.min(this.tMax, t));
    this.t = t;
    this.live = false;
    this.emit('data', this);
  }

  /* The LIVE button. Hands the clock back to poll() below. */
  goLive() {
    this.live = true;
    this.emit('data', this);
  }

  start() {
    this.setStatus('connecting', this.url);
    let ws;
    try { ws = this.socket(this.url); }
    catch (e) { this._reconnect(String(e.message || e)); return; }
    this._ws = ws;

    ws.onopen = () => { this._retry = 0; this.setStatus('running', 'connected'); };
    ws.onmessage = ev => {
      this.lastMsgAt = Date.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this._ingest(msg);
    };
    ws.onerror = () => { /* onclose always follows; report there */ };
    ws.onclose = ev => this._reconnect(`socket closed (${ev.code})`);
  }

  stop() {
    clearTimeout(this._timer);
    if (this._ws) { this._ws.onclose = null; this._ws.close(); this._ws = null; }
    this.setStatus('idle', 'stopped');
  }

  _reconnect(why) {
    this._ws = null;
    // Exponential back-off to 15 s. A race is 4 minutes; hammering a socket
    // that is down is how you get rate-limited off the one that comes back.
    const wait = Math.min(15000, 500 * Math.pow(2, this._retry++));
    this.setStatus('error', `${why} — retrying in ${(wait / 1000).toFixed(1)}s`);
    this._timer = setTimeout(() => this.start(), wait);
  }

  _tOf(o) {
    if (o.t != null) return o.t;
    if (o.ts != null && this.gunTs) return (o.ts - this.gunTs) / 1000;
    return null;
  }

  _ingest(msg) {
    switch (msg.type) {
      case 'meta':
        if (msg.gunTs) this.gunTs = msg.gunTs;
        if (msg.serverNow) this.clockSkewMs = msg.serverNow - Date.now();
        this.buffer.setMeta(msg);
        this.emit('meta', this);
        break;
      case 'gun':
        this.gunTs = msg.ts;
        break;
      case 'wind':
        this._new = this.buffer.pushWind(Object.assign({}, msg, { t: this._tOf(msg) })) || this._new;
        break;
      case 'samples':
        for (const r of msg.rows || [])
          this._new = this.buffer.push(Object.assign({}, r, { t: this._tOf(r) })) || this._new;
        break;
      case 'sample':
        this._new = this.buffer.push(Object.assign({}, msg, { t: this._tOf(msg) })) || this._new;
        break;
    }
  }

  poll() {
    // The live clock is the wall clock against the gun, not the last sample:
    // the countdown has to keep running through a telemetry dropout, and the
    // boats have to visibly stop rather than the clock quietly stopping with
    // them. That is the difference between "the feed is down" and "the fleet
    // is parked", and only one of them is the crew's problem.
    //
    // Only while `live` — scrubbed back, `t` stays exactly where seek() left
    // it and this is skipped, or every frame would drag it straight back to
    // the edge. Ingest is unaffected either way: onmessage above pushes into
    // the buffer regardless of what `t` is doing, so time spent scrubbed back
    // costs nothing off the record being kept.
    if (this.live) {
      if (this.gunTs) this.t = (Date.now() + this.clockSkewMs - this.gunTs) / 1000;
      else if (this.buffer.tLast != null) this.t = this.buffer.tLast;
    }
    const had = this._new;
    this._new = false;
    return had;
  }

  /* The real elapsed-since-gun time, independent of `t` — `t` is whatever the
   * scrubber is pinned to when looking back, and record.js needs the actual
   * clock even while the display is showing a past instant. Same formula
   * poll() uses above when `live` is true, kept in step with it on purpose. */
  wallT() {
    if (this.gunTs) return (Date.now() + this.clockSkewMs - this.gunTs) / 1000;
    return this.buffer.tLast;
  }

  /* Seconds since the last sample landed — the number that says whether what is
   * on screen is current. */
  lagSec() {
    if (this.buffer.tLast == null) return null;
    return Math.max(0, this.t - this.buffer.tLast);
  }
}
