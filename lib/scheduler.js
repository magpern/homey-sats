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

/**
 * Bookings that were upcoming before a refresh and are now gone or marked cancelled.
 * Only classes that hadn't started yet count. If every previous upcoming class
 * vanished at once (3 or more), that more likely means the API response changed
 * shape than that the member cancelled everything, so nothing is reported and
 * `suspicious` is set.
 */
function detectCancellations({ previous, current, now }) {
  const nowMs = now.getTime();
  const upcomingBefore = previous.filter((b) => isActive(b) && b.start.getTime() > nowMs);
  const byKey = new Map(current.map((b) => [`${b.id}|${b.start.getTime()}`, b]));
  const cancelled = upcomingBefore.filter((b) => {
    const match = byKey.get(`${b.id}|${b.start.getTime()}`);
    return !match || match.cancelled;
  });
  const activeNow = current.filter(isActive).length;
  if (cancelled.length >= 3 && cancelled.length === upcomingBefore.length && activeNow === 0) {
    return { cancelled: [], suspicious: true };
  }
  return { cancelled, suspicious: false };
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
  detectCancellations,
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
