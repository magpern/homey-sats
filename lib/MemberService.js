'use strict';

const { SatsClient, SatsAuthError, shapeOf } = require('./SatsClient');
const {
  parseUpcomingWorkouts, serializeBookings, deserializeBookings, describeTimeFormats,
} = require('./bookings');
const scheduler = require('./scheduler');
const { nextDelay } = require('./backoff');

const TICK_MS = 30 * 1000;
// Auth failures the user must fix by repairing the device: stop polling instead of retrying.
const STOP_CODES = new Set(['SESSION_EXPIRED', 'NO_SESSION', 'INVALID_CREDENTIALS', 'NO_CREDENTIALS']);

/**
 * Everything one SATS member device does, independent of the Homey runtime so it can be unit tested.
 * Homey pieces (device store, timers, time zone, home location, trigger cards) are injected.
 *
 * Logging policy: only counts, states and HTTP status codes are logged. Never
 * the password, tokens, class names, centres or response bodies: Homey includes app logs
 * in diagnostic reports.
 */
class MemberService {
  constructor({
    store, // { get(key), set(key, value) }: the device store
    getConfig = () => ({}), // () => { market, pathSegment, geocoding }
    getTimeZone,
    getHome = () => null, // () => { lat, lon } | null
    geocoder = null,
    events = {}, // { onStart, onEnd, onCancelled, onPromoted, onPositionChanged }: (tokens, state, booking)
    getStartOffsets = async () => [],
    onStatus = () => {},
    onBookings = () => {},
    log = () => {},
    error = () => {},
    now = () => new Date(),
    timers = {
      setTimeout, clearTimeout, setInterval, clearInterval,
    },
    clientFactory = (opts) => new SatsClient(opts),
    random = Math.random,
  }) {
    Object.assign(this, {
      store, getConfig, getTimeZone, getHome, geocoder, events, getStartOffsets, onStatus, onBookings, log, error, now, timers, clientFactory, random,
    });
    this.failures = 0;
    this.stopped = false;
    this.pollTimer = null;
    this.tickTimer = null;
    this.inFlight = null;
    this.lastCheck = null;
    this.lastEvent = null;
    this.status = { state: 'starting' };
    this.bookings = deserializeBookings(store.get('bookingsCache'));
    // Upcoming classes that were cancelled or removed; kept (until they start) for the widget.
    this.cancelled = deserializeBookings(store.get('cancelledCache'));
    this.firedKeys = new Set(store.get('firedKeys') || []);
    this.client = this._createClient();
  }

  _createClient() {
    const cfg = this.getConfig() || {};
    return this.clientFactory({
      refreshToken: this.store.get('refreshToken') || null,
      onRefreshToken: (token) => this.store.set('refreshToken', token),
      market: cfg.market || 'se',
      pathSegment: String(cfg.pathSegment || '').trim(),
      now: () => this.now().getTime(),
    });
  }

  start() {
    this._schedulePoll(5 * 1000);
    this.tickTimer = this.timers.setInterval(() => {
      this.tick().catch((err) => this.error(`Trigger check failed: ${err.code || ''} ${err.message || err}`.trim()));
    }, TICK_MS);
  }

  stop() {
    if (this.pollTimer) this.timers.clearTimeout(this.pollTimer);
    if (this.tickTimer) this.timers.clearInterval(this.tickTimer);
    this.pollTimer = null;
    this.tickTimer = null;
  }

  /** Settings changed, or a repair stored a new refresh token: rebuild the client and poll soon. */
  reconfigure() {
    this.client = this._createClient();
    this.failures = 0;
    this.stopped = false;
    this._schedulePoll(3 * 1000);
  }

  _schedulePoll(delayMs) {
    if (this.pollTimer) this.timers.clearTimeout(this.pollTimer);
    this.nextPollAt = new Date(this.now().getTime() + delayMs);
    this.pollTimer = this.timers.setTimeout(() => {
      this.pollTimer = null;
      this.refresh({ reason: 'poll' }).catch(() => {});
    }, delayMs);
  }

  _setStatus(status) {
    this.status = { ...status, nextPoll: this.nextPollAt ? this.nextPollAt.toISOString() : null };
    this.onStatus(this.status);
  }

  /**
   * Fetch this member's bookings. Concurrent calls share one request.
   * Rejects with a safe message when the fetch failed; polling continues with backoff
   * (or stops until repair, for an expired session).
   */
  refresh({ reason = 'manual' } = {}) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this._doRefresh(reason).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async _doRefresh(reason) {
    try {
      const json = await this.client.getUpcomingWorkouts();
      if (!this._shapeLogged) {
        // Once per app start: key names and booking-state enums only, never values.
        this._shapeLogged = true;
        this.log(`Bookings response keys: ${shapeOf(json, { maxDepth: 8 })}`);
        const formats = describeTimeFormats(json);
        if (formats.length) this.log(`Bookings time formats: ${formats.join('; ')}`);
      }
      const timeZone = this.getTimeZone();
      // Waiting-list places are kept here; triggers and conditions skip them themselves.
      const parsed = parseUpcomingWorkouts(json, { timeZone, includeWaitlisted: true });
      await this._enrichLocations(parsed);

      const now = this.now();
      const changes = scheduler.detectChanges({ previous: this.bookings, current: parsed, now });
      if (changes.suspicious) this.log('All upcoming classes disappeared at once; not reporting them as cancelled');

      this.bookings = parsed.filter((b) => !b.cancelled);
      this._updateCancelled(changes.cancelled.map((c) => c.booking), parsed, now);
      this.store.set('bookingsCache', serializeBookings(this.bookings));
      this.failures = 0;
      this._schedulePoll(nextDelay(0, {}, this.random));
      this._setStatus({ state: 'ok', lastSuccess: this.now().toISOString() });
      const waiting = this.bookings.filter((b) => b.waitlisted);
      const positioned = waiting.filter((b) => b.waitlistPosition !== null && b.waitlistPosition !== undefined).length;
      const states = {};
      for (const b of this.bookings) states[b.bookingState || '?'] = (states[b.bookingState || '?'] || 0) + 1;
      const stateText = Object.entries(states).map(([k, n]) => `${k} ${n}`).join(', ');
      this.log(`Bookings refreshed (${reason}): ${this.bookings.length} upcoming, ${waiting.length} on a waiting list `
        + `(${positioned} with a position); booking states: ${stateText || 'none'}`);
      this.onBookings(this.bookings);

      for (const c of changes.cancelled) {
        await this._fire('cancelled', c.booking, {}, {
          previous_status: c.previousStatus === 'waitlist' ? 'waiting list' : 'booked',
          cancelled_by: c.cancelledBy === 'sats' ? 'SATS' : 'unknown',
        });
      }
      for (const c of changes.promoted) {
        await this._fire('promoted', c.booking, {}, { previous_position: c.previousPosition || -1 });
      }
      for (const c of changes.positionChanged) {
        await this._fire('positionChanged', c.booking, {}, { old_position: c.oldPosition, new_position: c.newPosition });
      }
      await this.tick(); // new bookings may already be inside a trigger window
      return this.bookings;
    } catch (err) {
      const message = (err && err.message) || 'Unknown error';
      this.failures += 1;
      if (err instanceof SatsAuthError && STOP_CODES.has(err.code)) {
        this.stopped = true;
        if (this.pollTimer) this.timers.clearTimeout(this.pollTimer);
        this.pollTimer = null;
        this.nextPollAt = null;
        this._setStatus({ state: 'auth_error', code: err.code, message });
        this.error(`SATS session not usable (${err.code}); polling paused until the device is repaired`);
      } else {
        if (err.code === 'ENDPOINT_NOT_FOUND' && !this._diagnosed) {
          this._diagnosed = true;
          await this._runDiagnostics();
        }
        const delay = nextDelay(this.failures, {}, this.random);
        this._schedulePoll(delay);
        this._setStatus({ state: 'error', code: err.code || 'ERROR', message });
        this.error(`Refreshing bookings failed (${err.code || 'error'}${err.status ? `, HTTP ${err.status}` : ''}), attempt ${this.failures}, retry in ${Math.round(delay / 60000)} min`);
      }
      throw new Error(message);
    }
  }

  /**
   * One-off API diagnostics when the bookings endpoint can't be found.
   * Logs HTTP status codes and JSON *key names* only, never values, so no
   * personal data ends up in the log or in diagnostic reports.
   */
  async _runDiagnostics() {
    if (typeof this.client.diagnose !== 'function') return;
    try {
      const report = await this.client.diagnose();
      this.log(`Diagnostics: token claim names: ${report.claimNames.join(', ') || '(none)'}`);
      if (Object.keys(report.claimHints).length) {
        this.log(`Diagnostics: token claims (non-personal): ${JSON.stringify(report.claimHints)}`);
      }
      const notFound = report.requests.filter((r) => r.status === 404).length;
      this.log(`Diagnostics: ${report.requests.length} paths tried, ${notFound} returned 404`);
      for (const r of report.requests.filter((x) => x.status !== 404)) {
        this.log(`Diagnostics: GET ${r.path} -> ${r.status}${r.shape ? ` keys ${r.shape}` : ''}`);
      }
    } catch (err) {
      this.error(`Diagnostics failed (${err.code || 'error'}${err.status ? `, HTTP ${err.status}` : ''})`);
    }
  }

  /** Remember cancelled upcoming classes until they would have started. */
  _updateCancelled(newlyCancelled, parsed, now) {
    const nowMs = now.getTime();
    const key = (b) => `${b.id}|${b.start.getTime()}`;
    const activeKeys = new Set(parsed.filter((b) => !b.cancelled).map(key));
    const map = new Map();
    for (const b of [...this.cancelled, ...parsed.filter((x) => x.cancelled), ...newlyCancelled]) {
      if (b.start.getTime() > nowMs && !activeKeys.has(key(b))) map.set(key(b), { ...b, cancelled: true });
    }
    this.cancelled = [...map.values()].sort((a, b) => a.start - b.start);
    this.store.set('cancelledCache', serializeBookings(this.cancelled));
  }

  /**
   * Fill in centre coordinates/city/country that the API didn't provide,
   * using the geocoder (if enabled). Values from the API always win.
   */
  async _enrichLocations(bookings) {
    const cfg = this.getConfig() || {};
    if (!this.geocoder || cfg.geocoding === false) return;
    for (const b of bookings) {
      const c = b.centre;
      if (!c || !c.name || (c.lat !== null && c.lat !== undefined)) continue;
      try {
        const hit = await this.geocoder.locate(c);
        if (hit) {
          c.lat = hit.lat;
          c.lon = hit.lon;
          c.city = c.city || hit.city;
          c.country = c.country || hit.country;
          c.locationSource = 'geocoded';
        }
      } catch (e) {
        // geocoding is best effort
      }
    }
  }

  async _fire(kind, booking, state, extraTokens = {}) {
    const tokens = { ...scheduler.triggerTokens(booking, this.getTimeZone(), this.getHome()), ...extraTokens };
    this.lastEvent = {
      bookingId: booking.id, booking, at: this.now(), kind,
    };
    const handler = {
      start: this.events.onStart,
      end: this.events.onEnd,
      cancelled: this.events.onCancelled,
      promoted: this.events.onPromoted,
      positionChanged: this.events.onPositionChanged,
    }[kind];
    if (!handler) return;
    try {
      await handler(tokens, { bookingId: booking.id, ...state }, booking);
      this.log(`Triggered: class ${kind}${state.minutes !== undefined ? ` (${state.minutes} min)` : ''}`);
    } catch (err) {
      this.error(`Could not fire ${kind} trigger`);
    }
  }

  /** Fire every start/end trigger that became due since the last check. */
  async tick() {
    const now = this.now();
    const offsets = await this.getStartOffsets();
    const due = scheduler.computeDueEvents({
      bookings: this.bookings, offsets, now, lastCheck: this.lastCheck, firedKeys: this.firedKeys,
    });
    this.lastCheck = now;
    if (!due.length) return [];
    for (const d of due) {
      this.firedKeys.add(d.key);
      await this._fire(d.kind, d.booking, d.kind === 'start' ? { minutes: d.minutes } : {});
    }
    this.firedKeys = new Set(scheduler.pruneFiredKeys(this.firedKeys, now));
    this.store.set('firedKeys', [...this.firedKeys]);
    return due;
  }

  // ----- conditions -----

  subjectBooking() {
    return scheduler.subjectBooking({ bookings: this.bookings, lastEvent: this.lastEvent, now: this.now() });
  }

  isWithinKm(km) {
    const home = this.getHome();
    const b = this.subjectBooking();
    return Boolean(b && home && scheduler.isWithinKm(b, home, km));
  }

  startsAt({ time, day }) {
    const b = this.subjectBooking();
    return Boolean(b && scheduler.startsAt(b, { time, day }, this.getTimeZone()));
  }

  isAtHomeCentre(homeCentres) {
    const b = this.subjectBooking();
    return Boolean(b && scheduler.isAtHomeCentre(b, homeCentres));
  }

  hasClassBefore({ time, day }) {
    return scheduler.hasClassBefore({
      bookings: this.bookings, time, day, now: this.now(), timeZone: this.getTimeZone(),
    });
  }

  /** Counts for the device capabilities. */
  summary() {
    return scheduler.summarize(this.bookings, this.now());
  }

  /** Distinct centre names seen in this member's bookings (for the settings hint). */
  knownCentres() {
    return [...new Set(this.bookings.map((b) => b.centre && b.centre.name).filter(Boolean))].sort();
  }
}

module.exports = { MemberService, TICK_MS };
