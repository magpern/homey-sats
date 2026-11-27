'use strict';

const { parseApiTime } = require('./time');

/*
 * Turn the SATS "upcoming workouts" response into a flat list of bookings.
 *
 * The exact JSON shape of that endpoint has NOT been confirmed against the
 * live API (see docs/sats-api.md). The parser is therefore deliberately
 * tolerant: it walks the whole document and picks up every object that has
 * a recognisable start time plus a name, then reads centre, end time and
 * booking state from well-known keys on that object or on nested objects.
 */

const START_KEYS = ['startTime', 'start', 'startsAt', 'startDateTime', 'startDate', 'from', 'begin', 'startAt'];
const END_KEYS = ['endTime', 'end', 'endsAt', 'endDateTime', 'endDate', 'to', 'endAt'];
const DURATION_KEYS = ['durationInMinutes', 'durationMinutes', 'duration'];
const NAME_KEYS = ['name', 'title', 'className', 'activityName', 'groupExerciseName', 'typeName', 'displayName', 'heading'];
const ID_KEYS = ['id', 'bookingId', 'participationId', 'sessionId', 'classId', 'eventId'];
const CENTRE_KEYS = ['club', 'clubName', 'center', 'centre', 'centerName', 'centreName', 'location', 'locationName', 'venue', 'gym'];
const INSTRUCTOR_KEYS = ['instructor', 'instructorName', 'trainer', 'trainerName'];
const NESTED_KEYS = ['groupExercise', 'gxClass', 'class', 'activity', 'workout', 'session', 'event', 'content', 'details', 'classType', 'type'];

const CITY_KEYS = ['city', 'cityName', 'town', 'municipality', 'postalArea'];
const COUNTRY_KEYS = ['country', 'countryName', 'countryCode'];
const LAT_KEYS = ['latitude', 'lat'];
const LON_KEYS = ['longitude', 'lon', 'lng', 'long'];
const GEO_KEYS = ['geoLocation', 'geolocation', 'coordinates', 'position', 'geo', 'location', 'address'];

// Kinds that are not bookings with SATS (e.g. a workout the member planned for themselves).
const NON_BOOKING_KIND = /scheduled-workout|own-workout|custom-workout|manual/i;
const WAITING = /wait/i;
const CANCELLED = /cancel/i;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function firstValue(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function asText(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (isPlainObject(v)) {
    const inner = firstValue(v, ['name', 'title', 'displayName', 'text', 'value', 'fullName']);
    return typeof inner === 'string' ? inner.trim() : '';
  }
  return '';
}

/** Look on the object itself, then one level into common nested objects. */
function lookup(obj, keys) {
  const direct = firstValue(obj, keys);
  if (direct !== undefined) return direct;
  for (const nk of NESTED_KEYS) {
    if (isPlainObject(obj[nk])) {
      const v = firstValue(obj[nk], keys);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

function findStart(obj, timeZone) {
  for (const k of START_KEYS) {
    const d = parseApiTime(obj[k], timeZone);
    if (d) return d;
  }
  return null;
}

const STATE_KEYS = ['bookingState', 'state', 'status', 'participationState', 'memberParticipationState', 'type', '@type', 'kind'];
const BOOKING_INFO_KEYS = ['bookingInfo', 'memberBookingInfo', 'booking'];

/** True when any booking-state field on the object (or its booking info) matches `re`. */
function stateMatches(obj, re) {
  for (const k of STATE_KEYS) {
    const v = obj[k];
    const text = typeof v === 'string' ? v : (isPlainObject(v) ? asText(v) || v.type || '' : '');
    if (text && re.test(text)) return true;
  }
  return BOOKING_INFO_KEYS.some((nk) => isPlainObject(obj[nk]) && stateMatches(obj[nk], re));
}

const POSITION_KEYS = ['waitingListPosition', 'waitlistPosition', 'positionInWaitingList', 'waitingListNumber', 'queuePosition', 'position'];

/** Position on the waiting list (1 = next in line), or null when not given. */
function findWaitlistPosition(obj) {
  const sources = [obj, ...BOOKING_INFO_KEYS.map((k) => obj[k]).filter(isPlainObject)];
  for (const src of sources) {
    for (const k of POSITION_KEYS) {
      const n = toNumber(src[k]);
      if (n !== null && n > 0 && Number.isInteger(n)) return n;
    }
  }
  return null;
}

function detectWaitlisted(obj) {
  if (obj.isOnWaitingList === true || obj.onWaitingList === true || obj.waitingList === true) return true;
  const info = BOOKING_INFO_KEYS.map((k) => obj[k]).filter(isPlainObject);
  if ([obj, ...info].some((o) => toNumber(o.waitingListPosition) > 0 || toNumber(o.waitlistPosition) > 0)) return true;
  return stateMatches(obj, WAITING);
}

function detectCancelled(obj) {
  if (obj.isCancelled === true || obj.cancelled === true || obj.canceled === true) return true;
  return stateMatches(obj, CANCELLED);
}

function toNumber(v) {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Find a latitude/longitude pair on an object or in a nested geo object. */
function findCoordinates(obj, depth = 0) {
  if (!isPlainObject(obj) || depth > 2) return null;
  const lat = toNumber(firstValue(obj, LAT_KEYS));
  const lon = toNumber(firstValue(obj, LON_KEYS));
  if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  for (const k of GEO_KEYS) {
    const found = findCoordinates(obj[k], depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Centre (club) details: name, id, address, city, country and coordinates.
 * Coordinates are only set when the API response itself contains them;
 * otherwise lib/geo.js can geocode the address later.
 */
function extractCentre(obj) {
  let raw = lookup(obj, CENTRE_KEYS);
  const centre = {
    name: '', id: '', address: '', postalCode: '', city: '', country: '', lat: null, lon: null, locationSource: '',
  };
  if (typeof raw === 'string') {
    centre.name = raw.trim();
    raw = null;
  } else if (isPlainObject(raw)) {
    centre.name = asText(raw);
    const id = firstValue(raw, ['id', 'clubId', 'centerId', 'externalId']);
    centre.id = id !== undefined ? String(id) : '';
    const addr = isPlainObject(raw.address) ? raw.address : raw;
    centre.address = asText(firstValue(addr, ['street', 'streetAddress', 'addressLine1', 'address1', 'line1']))
      || (typeof raw.address === 'string' ? raw.address.trim() : '');
    centre.postalCode = asText(firstValue(addr, ['postalCode', 'postCode', 'zipCode', 'zip']));
    centre.city = asText(firstValue(addr, CITY_KEYS)) || asText(firstValue(raw, CITY_KEYS));
    centre.country = asText(firstValue(addr, COUNTRY_KEYS)) || asText(firstValue(raw, COUNTRY_KEYS));
    const coords = findCoordinates(raw);
    if (coords) {
      centre.lat = coords.lat;
      centre.lon = coords.lon;
      centre.locationSource = 'api';
    }
  }
  if (!centre.city) centre.city = asText(firstValue(obj, ['clubCity', 'centerCity', 'city']));
  if (!centre.country) centre.country = asText(firstValue(obj, ['clubCountry', 'centerCountry', 'country']));
  return centre;
}

function detectKind(obj) {
  const v = firstValue(obj, ['type', '@type', 'kind', 'workoutType', 'category']);
  return typeof v === 'string' ? v : '';
}

function toBooking(obj, timeZone) {
  const start = findStart(obj, timeZone) || (() => {
    for (const nk of NESTED_KEYS) {
      if (isPlainObject(obj[nk])) {
        const d = findStart(obj[nk], timeZone);
        if (d) return d;
      }
    }
    return null;
  })();
  if (!start) return null;

  const name = asText(lookup(obj, NAME_KEYS));
  if (!name) return null;

  let end = null;
  const endRaw = lookup(obj, END_KEYS);
  if (endRaw !== undefined) end = parseApiTime(endRaw, timeZone);
  if (!end) {
    const dur = Number(lookup(obj, DURATION_KEYS));
    if (Number.isFinite(dur) && dur > 0 && dur < 24 * 60) end = new Date(start.getTime() + dur * 60000);
  }

  const idRaw = lookup(obj, ID_KEYS);
  const centre = extractCentre(obj);
  const instructor = asText(lookup(obj, INSTRUCTOR_KEYS));
  const kind = detectKind(obj);
  const waitlisted = detectWaitlisted(obj);

  return {
    id: idRaw !== undefined ? String(idRaw) : `${name}@${start.toISOString()}`,
    name,
    start,
    end,
    centre,
    instructor,
    kind,
    waitlisted,
    waitlistPosition: waitlisted ? findWaitlistPosition(obj) : null,
    cancelled: detectCancelled(obj),
  };
}

/**
 * Walk any JSON value and return all bookings found, sorted by start time.
 * @param {*} json Parsed response body.
 * @param {object} opts
 * @param {string} opts.timeZone IANA zone used for timestamps without an offset.
 * @param {boolean} [opts.includeWaitlisted=false]
 * Cancelled bookings are kept (flag `cancelled`) so callers can detect cancellations.
 */
function parseUpcomingWorkouts(json, { timeZone, includeWaitlisted = false } = {}) {
  const found = [];
  const seen = new Set();

  const visit = (node, depth) => {
    if (depth > 12 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const booking = toBooking(node, timeZone);
    if (booking) {
      const key = `${booking.id}|${booking.start.getTime()}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push(booking);
      }
      return; // don't descend into a booking: nested objects would duplicate it
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };

  visit(json, 0);

  return found
    .filter((b) => !NON_BOOKING_KIND.test(b.kind))
    .filter((b) => includeWaitlisted || !b.waitlisted)
    .sort((a, b) => a.start - b.start);
}

/** JSON-safe form for the settings cache. */
function serializeBookings(bookings) {
  return bookings.map((b) => ({
    ...b,
    start: b.start.toISOString(),
    end: b.end ? b.end.toISOString() : null,
  }));
}

function deserializeBookings(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((b) => ({
      ...b,
      centre: typeof b.centre === 'string' ? { name: b.centre } : (b.centre || { name: '' }),
      start: new Date(b.start),
      end: b.end ? new Date(b.end) : null,
    }))
    .filter((b) => !Number.isNaN(b.start.getTime()));
}

module.exports = {
  parseUpcomingWorkouts,
  serializeBookings,
  deserializeBookings,
};
