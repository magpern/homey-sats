'use strict';

/**
 * Small time-zone helpers built on Intl, so the app needs no dependencies.
 * All "local" values refer to the Homey's configured time zone
 * (e.g. Europe/Stockholm), never the process time zone.
 */

const formatterCache = new Map();

function getFormatter(timeZone) {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** Wall-clock parts of `date` in `timeZone`. */
function zonedParts(date, timeZone) {
  const parts = {};
  for (const p of getFormatter(timeZone).formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** Offset (ms) of `timeZone` from UTC at instant `date`. Positive east of Greenwich. */
function tzOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (date.getTime() - date.getMilliseconds());
}

/** Convert a wall-clock time in `timeZone` to a Date (instant). */
function zonedTimeToDate({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = tzOffsetMs(new Date(guess), timeZone);
  let result = guess - offset;
  // Re-check once: the offset can differ on the other side of a DST switch.
  const offset2 = tzOffsetMs(new Date(result), timeZone);
  if (offset2 !== offset) {
    offset = offset2;
    result = guess - offset;
  }
  return new Date(result);
}

const ISO_WITH_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/**
 * Parse a timestamp from the SATS API.
 * - ISO strings with `Z` or an offset are absolute.
 * - ISO strings without a zone are treated as wall-clock time at the centre,
 *   which we assume is in the Homey's time zone.
 * - Numbers are epoch milliseconds (or seconds if they look like seconds).
 * Returns null when the value can't be parsed.
 */
function parseApiTime(value, timeZone) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const ms = value < 1e11 ? value * 1000 : value;
    return new Date(ms);
  }
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (ISO_WITH_ZONE.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = ISO_LOCAL.exec(s);
  if (m) {
    return zonedTimeToDate({
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5]),
      second: m[6] ? Number(m[6]) : 0,
    }, timeZone);
  }
  return null;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 'YYYY-MM-DD' of `date` in `timeZone`. */
function localDateKey(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** 'HH:mm' of `date` in `timeZone`. */
function formatHHmm(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Date key `days` after the local date of `date`. */
function addDaysKey(date, days, timeZone) {
  const p = zonedParts(date, timeZone);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Parse 'HH:mm' into minutes after midnight, or null. */
function parseHHmm(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

module.exports = {
  zonedParts,
  tzOffsetMs,
  zonedTimeToDate,
  parseApiTime,
  localDateKey,
  formatHHmm,
  addDaysKey,
  parseHHmm,
};
