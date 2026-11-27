'use strict';

const { formatHHmm, localDateKey, addDaysKey } = require('./time');
const { bookingDistanceKm } = require('./scheduler');

function weekdayShort(date, timeZone, locale = 'en') {
  try {
    return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone }).format(date);
  } catch (e) {
    return new Intl.DateTimeFormat('en', { weekday: 'short', timeZone }).format(date);
  }
}

/** "Mon 06:30 Spinning, Example Centre" for the next_class capability. */
function formatNextClass(booking, timeZone, locale = 'en') {
  if (!booking) return '';
  const centre = booking.centre && booking.centre.name;
  const text = `${weekdayShort(booking.start, timeZone, locale)} ${formatHHmm(booking.start, timeZone)} ${booking.name}`;
  return centre ? `${text}, ${centre}` : text;
}

function statusOf(b) {
  if (b.cancelled) return 'cancelled';
  if (b.waitlisted) return 'waitlist';
  return 'booked';
}

/**
 * Data model for the "SATS classes" dashboard widget.
 * Classes from now (still running ones included) up to `days` local days ahead,
 * for one member or all members, sorted by start time.
 *
 * @param {object} p
 * @param {{id: string, name: string, bookings: object[], cancelled?: object[]}[]} p.members
 * @param {string} [p.member='all'] Device id to show, or 'all'.
 * @param {Date} p.now
 * @param {string} p.timeZone
 * @param {number} [p.days=7]
 * @param {{lat:number, lon:number}|null} p.home
 * @param {number} [p.awayKm=10] Classes further away than this are flagged `away`.
 * @param {string} [p.locale='en']
 */
function buildWidgetModel({
  members, member = 'all', now, timeZone, days = 7, home = null, awayKm = 10, locale = 'en',
}) {
  const todayKey = localDateKey(now, timeZone);
  const lastKey = addDaysKey(now, days - 1, timeZone);
  const nowMs = now.getTime();
  const selected = member && member !== 'all' ? members.filter((m) => m.id === member) : members;

  const rows = [];
  for (const m of selected) {
    const seen = new Set();
    for (const b of [...(m.bookings || []), ...(m.cancelled || [])]) {
      const key = `${b.id}|${b.start.getTime()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const endMs = b.end ? b.end.getTime() : b.start.getTime() + 60 * 60000;
      const dayKey = localDateKey(b.start, timeZone);
      if (endMs <= nowMs || dayKey > lastKey) continue;
      const distance = bookingDistanceKm(b, home);
      rows.push({
        key: `${m.id}|${key}`,
        start: b.start.toISOString(),
        dayKey,
        weekday: weekdayShort(b.start, timeZone, locale),
        time: formatHHmm(b.start, timeZone),
        className: b.name,
        centre: (b.centre && b.centre.name) || '',
        who: m.name,
        memberId: m.id,
        status: statusOf(b),
        position: b.waitlisted ? (b.waitlistPosition || null) : null,
        distanceKm: distance === null ? null : Math.round(distance * 10) / 10,
        away: distance !== null && distance > awayKm,
      });
    }
  }
  rows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.who.localeCompare(b.who)));

  return {
    generatedAt: now.toISOString(),
    todayKey,
    tomorrowKey: addDaysKey(now, 1, timeZone),
    days,
    awayKm,
    homeKnown: Boolean(home),
    member: member && member !== 'all' ? member : 'all',
    rows,
  };
}

module.exports = { formatNextClass, buildWidgetModel, weekdayShort };
