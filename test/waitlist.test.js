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

/** All data invented. One class whose booking state the tests change between polls. */
function workout({ state = 'BOOKED', position, cancelled = false } = {}) {
  const bookingInfo = { bookingState: cancelled ? 'CANCELLED' : state };
  if (position !== undefined) bookingInfo.waitingListPosition = position;
  return {
    upcomingWorkouts: [
      {
        id: 'gx-7001',
        name: 'Spinning 45',
        startTime: '2026-12-01T06:30:00+01:00',
        endTime: '2026-12-01T07:15:00+01:00',
        club: { name: 'Example Centre North', latitude: 59.342, longitude: 18.049 },
        bookingInfo,
      },
      {
        id: 'gx-7002',
        name: 'Core 30',
        startTime: '2026-12-02T12:00:00+01:00',
        club: { name: 'Example Centre North', latitude: 59.342, longitude: 18.049 },
        bookingInfo: { bookingState: 'BOOKED' },
      },
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
  const m = member(workout({ state: 'ON_WAITING_LIST', position: 2 }));
  await m.service.refresh();
  assert.deepEqual(m.service.summary().waitlistCount, 1);
  assert.equal(m.service.summary().bestWaitlistPosition, 2);
  assert.equal(m.service.summary().bookedCount, 1);

  m.setBody(workout({ state: 'BOOKED' }));
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
  const m = member(workout({ state: 'BOOKED' }));
  await m.service.refresh();
  m.setBody(workout({ state: 'ON_WAITING_LIST', position: 4 }));
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
  const m = member(workout({ state: 'ON_WAITING_LIST', position: 5 }));
  await m.service.refresh();
  m.setBody(workout({ state: 'ON_WAITING_LIST', position: 3 }));
  await m.service.refresh();
  await m.service.refresh(); // unchanged: no second event
  assert.deepEqual(kinds(m.fired), ['positionChanged']);
  assert.equal(m.fired[0].tokens.old_position, 5);
  assert.equal(m.fired[0].tokens.new_position, 3);
  assert.equal(m.fired[0].tokens.class_name, 'Spinning 45');
  assert.equal(m.service.summary().bestWaitlistPosition, 3);
});

test('unknown positions never fire a position change', async () => {
  const m = member(workout({ state: 'ON_WAITING_LIST' }));
  await m.service.refresh();
  m.setBody(workout({ state: 'ON_WAITING_LIST', position: 3 }));
  await m.service.refresh();
  assert.deepEqual(kinds(m.fired), []);
});

test('"class cancelled" fires for a waiting-list class, and says SATS when SATS marked it', async () => {
  const m = member(workout({ state: 'ON_WAITING_LIST', position: 2 }));
  await m.service.refresh();
  m.setBody(workout({ cancelled: true }));
  await m.service.refresh();
  assert.deepEqual(kinds(m.fired), ['cancelled']);
  assert.equal(m.fired[0].tokens.previous_status, 'waiting list');
  assert.equal(m.fired[0].tokens.cancelled_by, 'SATS');
  assert.equal(m.service.cancelled.length, 1, 'kept for the widget');

  // A booked class that simply disappears: cancelled_by unknown.
  m.setBody({ upcomingWorkouts: [workout().upcomingWorkouts[0]] });
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

test('next_class text: weekday, time, class, centre', () => {
  const [b] = parseUpcomingWorkouts(loadFixture('upcoming-workouts.json'), { timeZone: TZ });
  assert.equal(formatNextClass(b, TZ, 'en'), 'Mon 06:30 Strength 45, Example Centre North');
  assert.equal(formatNextClass({ ...b, centre: { name: '' } }, TZ, 'en'), 'Mon 06:30 Strength 45');
  assert.equal(formatNextClass(null, TZ), '');
});

test('parser reads waiting-list positions from booking info', () => {
  const [b] = parseUpcomingWorkouts(workout({ state: 'ON_WAITING_LIST', position: 7 }), { timeZone: TZ, includeWaitlisted: true });
  assert.equal(b.waitlisted, true);
  assert.equal(b.waitlistPosition, 7);
  const [booked] = parseUpcomingWorkouts(workout(), { timeZone: TZ, includeWaitlisted: true });
  assert.equal(booked.waitlistPosition, null);
});
