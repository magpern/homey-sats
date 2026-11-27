'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MemberService } = require('../lib/MemberService');
const { SatsClient } = require('../lib/SatsClient');
const { parseUpcomingWorkouts } = require('../lib/bookings');
const { buildWidgetModel, formatNextClass } = require('../lib/present');
const {
  tokenResponse, fakeTransport, memorySettings, manualTimers, loadFixture,
} = require('./helpers');

const TOKEN_URL = 'https://auth.satsgroup.com/realms/sats/protocol/openid-connect/token';
const TZ = 'Europe/Stockholm';
const HOME = { lat: 59.3293, lon: 18.0686 };

/**
 * All data invented, in the shape observed live (docs/sats-api.md).
 * One class whose booking state the tests change between polls.
 * "Cancelled" is not a state seen live; it stands in for whatever SATS sends.
 */
function workout({
  state = 'Booked', position = null, cancelled = false, instructor = 'Instructor A',
} = {}) {
  const item = (id, name, dateTime, durationInMinutes, memberBookingInfo) => ({
    type: 'upcoming-group-exercise',
    content: {
      id,
      name,
      startTime: { timeZone: 'Europe/Stockholm', dateTime },
      durationInMinutes,
      club: {
        name: 'Example Centre North', id: 'c-1', fullName: 'Example Centre North (Example Town)', latitude: 59.342, longitude: 18.049,
      },
      instructorName: instructor,
      bookingInfo: {
        capacity: 20, bookedCount: 20, waitingListCount: 4, memberBookingInfo,
      },
      followingBookings: [],
    },
  });
  return {
    workouts: [
      item('gx-7001', 'Spinning 45', '2026-12-01T05:30:00Z', 45, {
        participationId: 'p-7001', bookingState: cancelled ? 'Cancelled' : state, waitingListPosition: position,
      }),
      item('gx-7002', 'Core 30', '2026-12-02T11:00:00Z', 30, {
        participationId: 'p-7002', bookingState: 'Booked', waitingListPosition: null,
      }),
    ],
  };
}

function member(initial) {
  const clock = { t: new Date('2026-11-30T20:00:00+01:00').getTime() };
  let body = initial;
  const transport = fakeTransport((call) => (call.url === TOKEN_URL
    ? { status: 200, body: tokenResponse() }
    : { status: 200, body }));
  const fired = [];
  const fire = (kind) => async (tokens, state) => fired.push({ kind, tokens, state });
  const service = new MemberService({
    store: memorySettings({ refreshToken: 'stored-refresh' }),
    getTimeZone: () => TZ,
    getHome: () => HOME,
    events: {
      onStart: fire('start'),
      onEnd: fire('end'),
      onCancelled: fire('cancelled'),
      onPromoted: fire('promoted'),
      onPositionChanged: fire('positionChanged'),
      onInstructorChanged: fire('instructorChanged'),
    },
    getStartOffsets: async () => [60],
    now: () => new Date(clock.t),
    timers: manualTimers(),
    random: () => 0.5,
    clientFactory: (opts) => new SatsClient({ ...opts, transport }),
  });
  return {
    service, fired, clock, setBody: (b) => { body = b; },
  };
}

const kinds = (fired) => fired.map((f) => f.kind);

test('waiting list -> booked between two polls fires "moved to booked" with the previous position', async () => {
  const m = member(workout({ state: 'BookedOnWaitingList', position: 2 }));
  await m.service.refresh();
  assert.deepEqual(m.service.summary().waitlistCount, 1);
  assert.equal(m.service.summary().bestWaitlistPosition, 2);
  assert.equal(m.service.summary().bookedCount, 1);
  assert.equal(m.service.summary().nextWaitlisted.name, 'Spinning 45');
  assert.equal(m.service.summary().nextBooked.name, 'Core 30', 'next_class stays booked-only');

  m.setBody(workout({ state: 'Booked' }));
  await m.service.refresh();
  assert.deepEqual(kinds(m.fired), ['promoted']);
  assert.deepEqual(m.fired[0].tokens, {
    class_name: 'Spinning 45',
    start: '06:30',
    end: '07:15',
    centre: 'Example Centre North',
    city: '',
    country: '',
    distance_km: 1.8,
    previous_position: 2,
  });
  const sum = m.service.summary();
  assert.equal(sum.bookedCount, 2);
  assert.equal(sum.waitlistCount, 0);
  assert.equal(sum.bestWaitlistPosition, null);

  // Now that it's booked, the 60-minute trigger fires at 05:30 next morning.
  m.clock.t = new Date('2026-12-01T05:30:10+01:00').getTime();
  await m.service.tick();
  assert.deepEqual(kinds(m.fired), ['promoted', 'start']);
});

test('booked -> waiting list between two polls: no promotion, counts move, no start trigger', async () => {
  const m = member(workout({ state: 'Booked' }));
  await m.service.refresh();
  m.setBody(workout({ state: 'BookedOnWaitingList', position: 4 }));
  await m.service.refresh();
  assert.deepEqual(kinds(m.fired), []);
  const sum = m.service.summary();
  assert.equal(sum.bookedCount, 1);
  assert.equal(sum.waitlistCount, 1);
  assert.equal(sum.bestWaitlistPosition, 4);
  assert.equal(sum.nextBooked.name, 'Core 30');

  m.clock.t = new Date('2026-12-01T05:30:10+01:00').getTime();
  await m.service.tick();
  assert.deepEqual(kinds(m.fired), [], 'waiting-list place does not fire "starts in"');
});

test('waiting-list position change fires once with old and new position', async () => {
  const m = member(workout({ state: 'BookedOnWaitingList', position: 5 }));
  await m.service.refresh();
  m.setBody(workout({ state: 'BookedOnWaitingList', position: 3 }));
  await m.service.refresh();
  await m.service.refresh(); // unchanged: no second event
  assert.deepEqual(kinds(m.fired), ['positionChanged']);
  assert.equal(m.fired[0].tokens.old_position, 5);
  assert.equal(m.fired[0].tokens.new_position, 3);
  assert.equal(m.fired[0].tokens.class_name, 'Spinning 45');
  assert.equal(m.service.summary().bestWaitlistPosition, 3);
});

test('a new instructor fires "class changed instructor" once, with old and new name', async () => {
  const m = member(workout());
  await m.service.refresh();
  m.setBody(workout({ instructor: 'Instructor B' }));
  await m.service.refresh();
  await m.service.refresh();
  const changed = m.fired.filter((f) => f.kind === 'instructorChanged');
  assert.equal(changed.length, 2, 'one per class: both test classes share the helper instructor');
  assert.equal(changed[0].tokens.class_name, 'Spinning 45');
  assert.equal(changed[0].tokens.old_instructor, 'Instructor A');
  assert.equal(changed[0].tokens.new_instructor, 'Instructor B');
});

test('no instructor change for the same name in other case, a missing name, or a cancelled class', async () => {
  const m = member(workout());
  await m.service.refresh();
  m.setBody(workout({ instructor: 'INSTRUCTOR A ' }));
  await m.service.refresh();
  m.setBody(workout({ instructor: '' }));
  await m.service.refresh();
  m.setBody(workout({ instructor: 'Instructor C' })); // previous poll had no name: nothing to compare
  await m.service.refresh();
  assert.deepEqual(m.fired.filter((f) => f.kind === 'instructorChanged'), []);
  m.setBody(workout({ instructor: 'Instructor D', cancelled: true }));
  await m.service.refresh();
  assert.ok(!m.fired.some((f) => f.kind === 'instructorChanged' && f.tokens.class_name === 'Spinning 45'));
});

test('unknown positions never fire a position change', async () => {
  const m = member(workout({ state: 'BookedOnWaitingList' }));
  await m.service.refresh();
  m.setBody(workout({ state: 'BookedOnWaitingList', position: 3 }));
  await m.service.refresh();
  assert.deepEqual(kinds(m.fired), []);
});

test('"class cancelled" fires for a waiting-list class, and says SATS when SATS marked it', async () => {
  const m = member(workout({ state: 'BookedOnWaitingList', position: 2 }));
  await m.service.refresh();
  m.setBody(workout({ cancelled: true }));
  await m.service.refresh();
  assert.deepEqual(kinds(m.fired), ['cancelled']);
  assert.equal(m.fired[0].tokens.previous_status, 'waiting list');
  assert.equal(m.fired[0].tokens.cancelled_by, 'SATS');
  assert.equal(m.service.cancelled.length, 1, 'kept for the widget');

  // A booked class that simply disappears: cancelled_by unknown.
  m.setBody({ workouts: [workout().workouts[0]] });
  await m.service.refresh();
  const last = m.fired.at(-1);
  assert.equal(last.kind, 'cancelled');
  assert.equal(last.tokens.class_name, 'Core 30');
  assert.equal(last.tokens.previous_status, 'booked');
  assert.equal(last.tokens.cancelled_by, 'unknown');
});

test('widget model: two members, next 7 days, status, away flag and member filter', () => {
  const a = parseUpcomingWorkouts(loadFixture('upcoming-workouts.json'), { timeZone: TZ, includeWaitlisted: true });
  const b = parseUpcomingWorkouts(loadFixture('upcoming-workouts-member-b.json'), { timeZone: TZ, includeWaitlisted: true });
  Object.assign(b.find((x) => x.id === 'gx-5002').centre, { lat: 59.9139, lon: 10.7522 }); // Oslo
  const cancelled = [{
    ...a[1], id: 'gx-x', name: 'HIIT 30', start: new Date('2026-12-01T18:00:00+01:00'), end: null, cancelled: true,
  }];
  const late = {
    ...a[0], id: 'gx-late', name: 'Too far ahead', start: new Date('2026-12-08T06:30:00+01:00'), end: null,
  };
  const members = [
    { id: 'a', name: 'Member A', bookings: [...a, late], cancelled },
    { id: 'b', name: 'Member B', bookings: b },
  ];
  const now = new Date('2026-11-30T07:00:00+01:00'); // Strength 45 (06:30-07:15) still running

  const model = buildWidgetModel({
    members, now, timeZone: TZ, home: HOME, awayKm: 10,
  });
  assert.equal(model.todayKey, '2026-11-30');
  assert.equal(model.tomorrowKey, '2026-12-01');
  assert.deepEqual(model.rows.map((r) => [r.dayKey, r.time, r.className, r.who, r.status, r.position, r.away]), [
    ['2026-11-30', '06:30', 'Strength 45', 'Member A', 'booked', null, false],
    ['2026-11-30', '12:00', 'Core 30', 'Member B', 'booked', null, false],
    ['2026-11-30', '18:00', 'Cycling 50', 'Member A', 'booked', null, false],
    ['2026-12-01', '07:00', 'Yoga Flow', 'Member A', 'waitlist', 3, false],
    ['2026-12-01', '07:00', 'Spinning 45', 'Member B', 'booked', null, true],
    ['2026-12-01', '18:00', 'HIIT 30', 'Member A', 'cancelled', null, false],
    ['2026-12-02', '08:15', 'PT session', 'Member A', 'booked', null, false],
  ]);
  assert.ok(!model.rows.some((r) => r.className === 'Too far ahead'), '8 days ahead is outside the 7-day window');
  assert.ok(model.rows.find((r) => r.className === 'Spinning 45').distanceKm > 400);

  const onlyB = buildWidgetModel({
    members, member: 'b', now, timeZone: TZ, home: HOME,
  });
  assert.deepEqual(onlyB.rows.map((r) => r.className), ['Core 30', 'Spinning 45']);
  assert.equal(onlyB.member, 'b');

  const noHome = buildWidgetModel({
    members, now, timeZone: TZ, home: null,
  });
  assert.ok(noHome.rows.every((r) => r.away === false), 'without a home location nothing is marked away');
  assert.equal(noHome.homeKnown, false);
});

test('next waiting-list class text carries the position', () => {
  const all = parseUpcomingWorkouts(loadFixture('upcoming-workouts.json'), { timeZone: TZ, includeWaitlisted: true });
  const yoga = all.find((b) => b.id === 'gx-1003');
  assert.equal(formatNextClass(yoga, TZ, 'en'), 'Tue 07:00 Yoga Flow, Example Centre North (#3)');
  assert.equal(formatNextClass({ ...yoga, waitlistPosition: null }, TZ, 'en'), 'Tue 07:00 Yoga Flow, Example Centre North');
});

test('next_class text: weekday, time, class, centre', () => {
  const [b] = parseUpcomingWorkouts(loadFixture('upcoming-workouts.json'), { timeZone: TZ });
  assert.equal(formatNextClass(b, TZ, 'en'), 'Mon 06:30 Strength 45, Example Centre North');
  assert.equal(formatNextClass({ ...b, centre: { name: '' } }, TZ, 'en'), 'Mon 06:30 Strength 45');
  assert.equal(formatNextClass(null, TZ), '');
});

test('parser reads waiting-list positions from booking info', () => {
  const [b] = parseUpcomingWorkouts(workout({ state: 'BookedOnWaitingList', position: 7 }), { timeZone: TZ, includeWaitlisted: true });
  assert.equal(b.waitlisted, true);
  assert.equal(b.waitlistPosition, 7);
  const [booked] = parseUpcomingWorkouts(workout(), { timeZone: TZ, includeWaitlisted: true });
  assert.equal(booked.waitlistPosition, null);
});
