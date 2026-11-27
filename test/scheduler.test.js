'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeDueEvents, computeDueTriggers, detectCancellations, hasClassBefore, anyMemberHasClassBefore,
  triggerTokens, pruneFiredKeys, isAtHomeCentre, parseHomeCentres, subjectBooking,
} = require('../lib/scheduler');
const { parseUpcomingWorkouts } = require('../lib/bookings');
const { formatHHmm, parseHHmm } = require('../lib/time');
const { loadFixture } = require('./helpers');

const TZ = 'Europe/Stockholm';
const HOME = { lat: 59.3293, lon: 18.0686 }; // a point in central Stockholm
const bookings = parseUpcomingWorkouts(loadFixture('upcoming-workouts.json'), { timeZone: TZ });
// Monday 2026-11-30: "Strength 45" 06:30-07:15 and "Cycling 50" 18:00-18:50 (Stockholm time, UTC+1).

/** Local Stockholm time on Monday 2026-11-30 -> Date. */
function mon(hhmm, ss = '00') {
  return new Date(`2026-11-30T${hhmm}:${ss}+01:00`);
}

/**
 * Simulate the app's tick loop (every 30 s) from `from` to `to` and collect
 * every "starts in N minutes" trigger that fires, with the local time it fired.
 */
function simulate({
  from, to, offsets, list = bookings, stepMs = 30 * 1000,
}) {
  const fired = [];
  const firedKeys = new Set();
  let lastCheck = null;
  for (let t = from.getTime(); t <= to.getTime(); t += stepMs) {
    const now = new Date(t);
    for (const d of computeDueEvents({
      bookings: list, offsets, now, lastCheck, firedKeys,
    })) {
      firedKeys.add(d.key);
      fired.push({
        at: formatHHmm(now, TZ), kind: d.kind, minutes: d.minutes, ...triggerTokens(d.booking, TZ, HOME),
      });
    }
    lastCheck = now;
  }
  return fired;
}

/** Homey's built-in "the time is before 09:00" condition, evaluated when the trigger fires. */
function timeIsBefore(hhmm, atHHmm) {
  return parseHHmm(atHHmm) < parseHHmm(hhmm);
}

test('06:30 class with a 60-minute trigger fires at 05:30, once, with all tokens', () => {
  const fired = simulate({ from: mon('04:00'), to: mon('07:00'), offsets: [60] }).filter((f) => f.kind === 'start');
  assert.equal(fired.length, 1);
  const f = fired[0];
  assert.equal(f.at, '05:30');
  assert.equal(f.minutes, 60);
  assert.deepEqual({ ...f, distance_km: undefined }, {
    at: '05:30',
    kind: 'start',
    minutes: 60,
    class_name: 'Strength 45',
    start: '06:30',
    end: '07:15',
    centre: 'Example Centre North',
    city: 'Stockholm',
    country: 'Sweden',
    distance_km: undefined,
  });
  assert.ok(f.distance_km > 1 && f.distance_km < 3, `about 1.6 km, got ${f.distance_km}`);
});

test('the trigger is not due one second early, and is due exactly at 05:30:00', () => {
  const early = computeDueTriggers({
    bookings, offsets: [60], now: mon('05:29', '59'), lastCheck: mon('05:29', '29'),
  });
  assert.equal(early.length, 0);
  const onTime = computeDueTriggers({
    bookings, offsets: [60], now: mon('05:30', '00'), lastCheck: mon('05:29', '30'),
  });
  assert.equal(onTime.length, 1);
  assert.equal(onTime[0].booking.name, 'Strength 45');
});

test('evening class does not fire the morning curtain Flow', () => {
  const morning = simulate({ from: mon('00:00'), to: mon('09:00'), offsets: [60] }).filter((f) => f.kind === 'start');
  assert.deepEqual(morning.map((f) => f.class_name), ['Strength 45']);

  const day = simulate({ from: mon('00:00'), to: mon('23:59'), offsets: [60] }).filter((f) => f.kind === 'start');
  const evening = day.find((f) => f.class_name === 'Cycling 50');
  assert.equal(evening.at, '17:00');
  assert.equal(evening.distance_km, -1, 'centre has no coordinates in this test');

  // The Flow's "AND the time is before 09:00" stops the evening one.
  assert.deepEqual(day.filter((f) => timeIsBefore('09:00', f.at)).map((f) => f.class_name), ['Strength 45']);
});

test('"class ends" fires at the end time, including an end derived from the duration', () => {
  const ends = simulate({ from: mon('00:00'), to: mon('23:59'), offsets: [] }).filter((f) => f.kind === 'end');
  assert.deepEqual(ends.map((f) => `${f.at} ${f.class_name}`), ['07:15 Strength 45', '18:50 Cycling 50']);
});

test('several offsets fire independently', () => {
  const fired = simulate({ from: mon('04:00'), to: mon('07:00'), offsets: [60, 15] }).filter((f) => f.kind === 'start');
  assert.deepEqual(fired.map((f) => `${f.at}/${f.minutes}`), ['05:30/60', '06:15/15']);
});

test('waiting-list and cancelled bookings never fire', () => {
  const blocked = [{ ...bookings[0], waitlisted: true }, { ...bookings[1], cancelled: true }];
  assert.equal(simulate({
    from: mon('00:00'), to: mon('23:59'), offsets: [60], list: blocked,
  }).length, 0);
});

test('after a restart a trigger is caught up only if at most 5 minutes late', () => {
  assert.equal(computeDueTriggers({
    bookings, offsets: [60], now: mon('05:34'), lastCheck: null,
  }).length, 1);
  assert.equal(computeDueTriggers({
    bookings, offsets: [60], now: mon('05:40'), lastCheck: null,
  }).length, 0);
});

test('cancellations: a vanished or cancelled upcoming class is reported, a past one is not', () => {
  const now = mon('12:00');
  const current = [{ ...bookings[2] }]; // only the PT session remains
  const { cancelled, suspicious } = detectCancellations({ previous: bookings, current, now });
  assert.equal(suspicious, false);
  // 06:30 class already happened, so only the 18:00 class counts as cancelled.
  assert.deepEqual(cancelled.map((b) => b.id), ['gx-1002']);

  const flagged = detectCancellations({
    previous: bookings, current: [bookings[0], { ...bookings[1], cancelled: true }, bookings[2]], now,
  });
  assert.deepEqual(flagged.cancelled.map((b) => b.id), ['gx-1002']);
});

test('cancellations: everything vanishing at once is treated as suspicious', () => {
  const { cancelled, suspicious } = detectCancellations({ previous: bookings, current: [], now: mon('00:00') });
  assert.equal(suspicious, true);
  assert.equal(cancelled.length, 0);
});

test('condition: class before 09:00 today / tomorrow', () => {
  const sunEvening = new Date('2026-11-29T21:00:00+01:00');
  assert.equal(hasClassBefore({
    bookings, time: '09:00', day: 'tomorrow', now: sunEvening, timeZone: TZ,
  }), true);
  assert.equal(hasClassBefore({
    bookings, time: '09:00', day: 'today', now: sunEvening, timeZone: TZ,
  }), false);
  assert.equal(hasClassBefore({
    bookings, time: '06:30', day: 'today', now: mon('05:00'), timeZone: TZ,
  }), false, 'strictly before');
  assert.equal(hasClassBefore({
    bookings, time: '06:31', day: 'today', now: mon('05:00'), timeZone: TZ,
  }), true);
});

test('condition: an evening class is not "before 09:00"', () => {
  const eveningOnly = bookings.filter((b) => b.name === 'Cycling 50');
  assert.equal(hasClassBefore({
    bookings: eveningOnly, time: '09:00', day: 'today', now: mon('05:00'), timeZone: TZ,
  }), false);
});

test('app-level condition: any member', () => {
  const eveningOnly = bookings.filter((b) => b.name === 'Cycling 50');
  const args = {
    time: '09:00', day: 'today', now: mon('05:00'), timeZone: TZ,
  };
  assert.equal(anyMemberHasClassBefore([eveningOnly, bookings], args), true);
  assert.equal(anyMemberHasClassBefore([eveningOnly], args), false);
  assert.equal(anyMemberHasClassBefore([], args), false);
});

test('condition rejects an invalid time', () => {
  assert.throws(() => hasClassBefore({
    bookings, time: '25:00', day: 'today', now: mon('05:00'), timeZone: TZ,
  }));
});

test('home centres: one per line, case and spacing ignored, id also accepted', () => {
  assert.deepEqual(parseHomeCentres(' Example Centre North \n\nexample centre south,  c-7 '), ['example centre north', 'example centre south', 'c-7']);
  assert.equal(isAtHomeCentre(bookings[0], 'example  centre NORTH'), true);
  assert.equal(isAtHomeCentre(bookings[1], 'Example Centre North'), false);
  assert.equal(isAtHomeCentre(bookings[1], 'c-2'), true);
  assert.equal(isAtHomeCentre(bookings[0], ''), false);
});

test('subject class: the one that just triggered, else the next one', () => {
  const lastEvent = { bookingId: 'gx-1002', at: mon('17:00') };
  assert.equal(subjectBooking({ bookings, lastEvent, now: mon('17:01') }).id, 'gx-1002');
  assert.equal(subjectBooking({ bookings, lastEvent, now: mon('17:30') }).id, 'gx-1002', 'next class anyway');
  assert.equal(subjectBooking({ bookings, lastEvent: null, now: mon('05:00') }).id, 'gx-1001');
  assert.equal(subjectBooking({ bookings, lastEvent: null, now: mon('06:45') }).id, 'gx-1001', 'still running');
  assert.equal(subjectBooking({ bookings, lastEvent: null, now: mon('08:00') }).id, 'gx-1002');
});

test('old fired keys are pruned', () => {
  const keys = ['start|a|2026-11-28T05:30:00.000Z|60', 'end|b|2026-11-30T05:30:00.000Z|'];
  assert.deepEqual(pruneFiredKeys(keys, mon('12:00')), ['end|b|2026-11-30T05:30:00.000Z|']);
});

test('"class starts at [time] on [day]" matches local start time and weekday', () => {
  const { startsAt } = require('../lib/scheduler');
  const [strength, cycling] = bookings; // Monday 06:30 and Monday 18:00, Stockholm time
  assert.equal(startsAt(cycling, { time: '18:00', day: 'mon' }, TZ), true);
  assert.equal(startsAt(cycling, { time: '18:00', day: 'any' }, TZ), true);
  assert.equal(startsAt(cycling, { time: '18:00', day: 'weekdays' }, TZ), true);
  assert.equal(startsAt(cycling, { time: '18:00', day: 'weekend' }, TZ), false);
  assert.equal(startsAt(cycling, { time: '18:00', day: 'tue' }, TZ), false);
  assert.equal(startsAt(cycling, { time: '17:00', day: 'mon' }, TZ), false, 'UTC time does not match');
  assert.equal(startsAt(strength, { time: '6:30', day: 'mon' }, TZ), true, 'H:mm is accepted');
  assert.equal(startsAt(strength, { time: '18:00', day: 'mon' }, TZ), false);
  assert.equal(startsAt(strength, { time: 'nonsense', day: 'mon' }, TZ), false);
  assert.equal(startsAt(null, { time: '18:00', day: 'mon' }, TZ), false);
  // The weekday is the local one: 00:30 Saturday in Stockholm is still Friday in UTC.
  const late = { start: new Date('2026-12-04T23:30:00Z') };
  assert.equal(startsAt(late, { time: '00:30', day: 'sat' }, TZ), true);
  assert.equal(startsAt(late, { time: '00:30', day: 'fri' }, TZ), false);
});
