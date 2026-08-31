/* mock-live.js — a socket that is not a socket.
 *
 * The replay feed proves the tracker never reads ahead. This proves the LIVE
 * path itself: the message protocol, the meta-before-samples ordering, the
 * wall-clock gun countdown, the lag readout and the reconnect handling all run
 * for real — only the transport is faked. Open the tracker with ?live=mock.
 *
 * It takes an archived start, moves its gun to a few seconds from now, and
 * emits the protocol LiveFeed documents, at 1 Hz, out of a setInterval. So the
 * numbers on screen are a real start, arriving the way a real one would.
 *
 * When there is a real socket, delete nothing: pass ?live=wss://your-host and
 * this file is simply never used.
 */
class MockLiveSocket {
  /* race — a bundle entry. leadSec — how long before the gun to start. */
  constructor(race, opts = {}) {
    this.race = race;
    this.readyState = 0;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;

    const lead = opts.leadSec == null ? 75 : opts.leadSec;
    const from = Math.max(race.tRange ? race.tRange[0] : -150, -lead);
    // The gun is `lead` seconds from now, so the countdown on screen is a real
    // countdown against the viewer's own clock.
    this.gunTs = Date.now() + lead * 1000;

    this._rows = [];
    for (const [team, b] of Object.entries(race.boats || {}))
      for (let i = 0; i < b.t.length; i++)
        if (b.t[i] >= from) this._rows.push({ t: b.t[i], team, i });
    this._rows.sort((a, b) => a.t - b.t);
    this._i = 0;

    setTimeout(() => this._open(), 120);
  }

  _send(o) { if (this.onmessage) this.onmessage({ data: JSON.stringify(o) }); }

  _open() {
    this.readyState = 1;
    if (this.onopen) this.onopen();

    const r = this.race;
    this._send({
      type: 'meta', raceId: r.raceId, venue: r.venue, season: r.season,
      date: r.date, clock: r.clock, label: r.label, sessionType: r.sessionType,
      gunTs: this.gunTs, serverNow: Date.now(),
      marks: r.marks, line: r.line, limits: r.limits, wind: r.wind, course: r.course,
      configs: r.configs, pinEnd: r.pinEnd,
    });

    // One batch a second, exactly as a boat-side bridge would push it.
    this._timer = setInterval(() => this._tick(), 250);
  }

  _tick() {
    const t = (Date.now() - this.gunTs) / 1000;
    const rows = [];
    const b = this.race.boats;
    while (this._i < this._rows.length && this._rows[this._i].t <= t) {
      const r = this._rows[this._i++];
      const src = b[r.team];
      const s = { team: r.team, t: r.t };
      for (const k of SAMPLE_CHANNELS) s[k] = src[k] ? src[k][r.i] : null;
      rows.push(s);
    }
    if (rows.length) this._send({ type: 'samples', rows });
    if (this._i >= this._rows.length) {
      clearInterval(this._timer);
      this.close(1000);
    }
  }

  close(code = 1000) {
    clearInterval(this._timer);
    this.readyState = 3;
    if (this.onclose) this.onclose({ code });
  }
}
