'use strict';

const {
  localDateKey, addDaysKey, formatHHmm, zonedParts, parseHHmm,
} = require('./time');
const { distanceKm } = require('./geo');

/** How late a trigger may still fire, e.g. after a Homey restart. */
const DEFAULT_MAX_LATE_MS = 5 * 60 * 1000;

function isActive(b) {
  return !b.waitlisted && !b.cancelled;
}

function eventKey(kind, booking, minutes = '') {
  return `${kind}|${booking.id}|${booking.start.toISOString()}|${minutes}`;
}

/**
 * Work out which time-based triggers are due.
 *
 * "start" events: for each offset N, fire time = start - N minutes.
 * "end" events: fire time = end (skipped when the end time is unknown).
 * An event is due when its fire time falls in (windowStart, now], where
 * windowStart = max(lastCheck, now - maxLate). Fired keys are skipped,
 * so each event fires once per booking (and offset).
 *
 * @returns {{kind: 'start'|'end', booking: object, minutes?: number, key: string, fireAt: Date}[]}
 */
function computeDueEvents({
  bookings, offsets = [], now, lastCheck, firedKeys = new Set(), maxLateMs = DEFAULT_MAX_LATE_MS,
}) {
  const nowMs = now.getTime();
  const floor = nowMs - maxLateMs;
  const windowStart = lastCheck ? Math.max(lastCheck.getTime(), floor) : floor;
  const due = [];
  const consider = (kind, booking, fireAtMs, minutes) => {
    if (fireAtMs > windowStart && fireAtMs <= nowMs) {
      const key = eventKey(kind, booking, minutes);
      if (!firedKeys.has(key)) {
        due.push({
          kind, booking, minutes, key, fireAt: new Date(fireAtMs),
        });
      }
    }
  };

  for (const booking of bookings) {
    if (!isActive(booking)) continue;
    for (const minutes of offsets) {
      if (!Number.isFinite(minutes) || minutes < 0) continue;
      consider('start', booking, booking.start.getTime() - minutes * 60000, minutes);
    }
    if (booking.end) consider('end', booking, booking.end.getTime(), undefined);
  }
  return due.sort((a, b) => a.fireAt - b.fireAt);
}

/** Backwards-compatible helper: only the "starts in N minutes" events. */
function computeDueTriggers(params) {
  return computeDueEvents(params).filter((e) => e.kind === 'start');
}

function bookingKey(b) {
  return `${b.id}|${b.start.getTime()}`;
}

/**
 * Compare two polls of one member's list (both parsed with waiting-list places included).
 *
 * - cancelled: classes (booked or on the waiting list) that had not started, and are
 *   now marked cancelled (`cancelledBy: 'sats'`) or gone from the list (`cancelledBy: 'unknown'`;
 *   the member may have cancelled it). If 3+ upcoming classes vanish at once and nothing is
 *   left, that more likely means the API response changed shape, so nothing is reported
 *   and `suspicious` is set.
 * - promoted: was on the waiting list, now booked.
 * - demoted: was booked, now on the waiting list (rare; no trigger, state only).
 * - positionChanged: on the waiting list both times, position differs (both known).
 */
function detectChanges({ previous, current, now }) {
  const nowMs = now.getTime();
  const before = previous.filter((b) => !b.cancelled && b.start.getTime() > nowMs);
  const byKey = new Map(current.map((b) => [bookingKey(b), b]));
  const result = {
    cancelled: [], promoted: [], demoted: [], positionChanged: [], suspicious: false,
  };

  for (const prev of before) {
    const cur = byKey.get(bookingKey(prev));
    if (!cur || cur.cancelled) {
      result.cancelled.push({
        booking: cur ? { ...prev, ...cur, cancelled: true } : { ...prev, cancelled: true },
        previousStatus: prev.waitlisted ? 'waitlist' : 'booked',
        cancelledBy: cur ? 'sats' : 'unknown',
      });
    } else if (prev.waitlisted && !cur.waitlisted) {
      result.promoted.push({ booking: cur, previousPosition: prev.waitlistPosition });
    } else if (!prev.waitlisted && cur.waitlisted) {
      result.demoted.push({ booking: cur });
    } else if (prev.waitlisted && cur.waitlisted
      && prev.waitlistPosition && cur.waitlistPosition && prev.waitlistPosition !== cur.waitlistPosition) {
      result.positionChanged.push({ booking: cur, oldPosition: prev.waitlistPosition, newPosition: cur.waitlistPosition });
    }
  }

  const vanished = result.cancelled.filter((c) => c.cancelledBy === 'unknown');
  const remaining = current.filter((b) => !b.cancelled).length;
  if (vanished.length >= 3 && vanished.length === before.length && remaining === 0) {
    result.cancelled = [];
    result.suspicious = true;
  }
  return result;
}

/** Backwards-compatible view used by older callers/tests: booked classes only. */
function detectCancellations({ previous, current, now }) {
  const r = detectChanges({ previous, current, now });
  return { cancelled: r.cancelled.map((c) => c.booking), suspicious: r.suspicious };
}

/** Counts for the device capabilities. */
function summarize(bookings, now) {
  const nowMs = now.getTime();
  const upcoming = bookings.filter((b) => !b.cancelled && b.start.getTime() > nowMs);
  const booked = upcoming.filter((b) => !b.waitlisted);
  const waiting = upcoming.filter((b) => b.waitlisted);
  const positions = waiting.map((b) => b.waitlistPosition).filter((n) => Number.isInteger(n) && n > 0);
  return {
    nextBooked: booked[0] || null,
    bookedCount: booked.length,
    waitlistCount: waiting.length,
    bestWaitlistPosition: positions.length ? Math.min(...positions) : null,
  };
}

/**
 * "Has a booked class before [time] today/tomorrow" for one member's bookings.
 * For "today", classes that already started still count, so a Flow at 06:45
 * still sees the 06:30 class.
 */
function hasClassBefore({
  bookings, time, day, now, timeZone,
}) {
  const limit = parseHHmm(time);
  if (limit === null) throw new Error(`Invalid time "${time}"`);
  const targetKey = day === 'tomorrow' ? addDaysKey(now, 1, timeZone) : localDateKey(now, timeZone);
  return bookings.some((b) => {
    if (!isActive(b)) return false;
    if (localDateKey(b.start, timeZone) !== targetKey) return false;
    const p = zonedParts(b.start, timeZone);
    return p.hour * 60 + p.minute < limit;
  });
}

/** App-level condition: true if any member has such a class. */
function anyMemberHasClassBefore(members, args) {
  return members.some((bookings) => hasClassBefore({ ...args, bookings }));
}

/** Distance from home to the class's centre in km, or null when either location is unknown. */
function bookingDistanceKm(booking, home) {
  const c = booking && booking.centre;
  if (!c || c.lat === null || c.lat === undefined) return null;
  return distanceKm(home, { lat: c.lat, lon: c.lon });
}

function isWithinKm(booking, home, km) {
  const d = bookingDistanceKm(booking, home);
  return d !== null && d <= Number(km);
}

function normaliseCentreName(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Parse the "home centres" device setting (one per line, or comma separated). */
function parseHomeCentres(text) {
  return String(text || '')
    .split(/[\n,;]/)
    .map(normaliseCentreName)
    .filter(Boolean);
}

/** True when the class's centre name (or id) is in the member's home centre list. */
function isAtHomeCentre(booking, homeCentres) {
  const c = booking && booking.centre;
  if (!c) return false;
  const list = Array.isArray(homeCentres) ? homeCentres.map(normaliseCentreName) : parseHomeCentres(homeCentres);
  const name = normaliseCentreName(c.name);
  const id = normaliseCentreName(c.id);
  return list.some((entry) => (name && entry === name) || (id && entry === id));
}

/**
 * The class a device condition talks about: the one whose event most recently
 * fired a trigger for this member (if within `recentMs`), otherwise the next
 * class that hasn't ended yet.
 */
function subjectBooking({
  bookings, lastEvent, now, recentMs = 10 * 60 * 1000,
}) {
  if (lastEvent && now.getTime() - lastEvent.at.getTime() <= recentMs) {
    const b = bookings.find((x) => x.id === lastEvent.bookingId) || lastEvent.booking;
    if (b) return b;
  }
  const nowMs = now.getTime();
  return bookings.find((b) => isActive(b) && (b.end ? b.end.getTime() : b.start.getTime()) > nowMs) || null;
}

/** Tokens for the device trigger cards. distance_km is -1 when unknown. */
function triggerTokens(booking, timeZone, home) {
  const c = booking.centre || {};
  const d = bookingDistanceKm(booking, home);
  return {
    class_name: booking.name || '',
    start: formatHHmm(booking.start, timeZone),
    end: booking.end ? formatHHmm(booking.end, timeZone) : '',
    centre: c.name || '',
    city: c.city || '',
    country: c.country || '',
    distance_km: d === null ? -1 : Math.round(d * 10) / 10,
  };
}

/** Drop fired keys for classes that started more than a day ago. */
function pruneFiredKeys(keys, now) {
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  return [...keys].filter((k) => {
    const t = Date.parse(k.split('|')[2]);
    return Number.isFinite(t) && t > cutoff;
  });
}

module.exports = {
  computeDueEvents,
  computeDueTriggers,
  detectChanges,
  detectCancellations,
  summarize,
  hasClassBefore,
  anyMemberHasClassBefore,
  bookingDistanceKm,
  isWithinKm,
  parseHomeCentres,
  isAtHomeCentre,
  subjectBooking,
  triggerTokens,
  eventKey,
  pruneFiredKeys,
  DEFAULT_MAX_LATE_MS,
};
