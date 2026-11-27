'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUpcomingWorkouts, serializeBookings, deserializeBookings } = require('../lib/bookings');
const { loadFixture } = require('./helpers');

const TZ = 'Europe/Stockholm';

test('parses the mocked upcoming-workouts response', () => {
  const bookings = parseUpcomingWorkouts(loadFixture('upcoming-workouts.json'), { timeZone: TZ });
  assert.deepEqual(bookings.map((b) => b.id), ['gx-1001', 'gx-1002', 'pt-3001']);

  const [morning, evening, pt] = bookings;
  assert.equal(morning.name, 'Strength 45');
  assert.equal(morning.instructor, 'Instructor A');
  assert.equal(morning.start.toISOString(), '2026-11-30T05:30:00.000Z');
  assert.equal(morning.end.toISOString(), '2026-11-30T06:15:00.000Z');
  assert.deepEqual(morning.centre, {
    name: 'Example Centre North',
    id: 'c-1',
    address: 'Example Street 1',
    postalCode: '113 00',
    city: 'Stockholm',
    country: 'Sweden',
    lat: 59.342,
    lon: 18.049,
    locationSource: 'api',
  });

  assert.equal(evening.end.toISOString(), '2026-11-30T17:50:00.000Z', 'end from duration');
  assert.equal(evening.centre.city, 'Stockholm');
  assert.equal(evening.centre.lat, null, 'no coordinates in the API data');

  // Timestamp without offset is read as Stockholm wall-clock time.
  assert.equal(pt.name, 'PT session');
  assert.equal(pt.start.toISOString(), '2026-12-02T07:15:00.000Z');
  assert.equal(pt.centre.name, 'Example Centre North');
});

test('waiting-list places and self-planned workouts are not bookings', () => {
  const all = parseUpcomingWorkouts(loadFixture('upcoming-workouts.json'), { timeZone: TZ, includeWaitlisted: true });
  assert.ok(all.some((b) => b.id === 'gx-1003' && b.waitlisted));
  assert.ok(!all.some((b) => b.id === 'sw-2001'));
});

test('cancelled bookings are flagged', () => {
  const [b] = parseUpcomingWorkouts([
    {
      id: 'x', name: 'Pilates', startTime: '2026-12-03T12:00:00Z', bookingInfo: { bookingState: 'CANCELLED_BY_CENTRE' },
    },
  ], { timeZone: TZ });
  assert.equal(b.cancelled, true);
});

test('coordinates in different shapes are found', () => {
  const shapes = [
    { club: { name: 'A', geoLocation: { latitude: '59.1', longitude: '18.1' } } },
    { club: { name: 'A', coordinates: { lat: 59.1, lng: 18.1 } } },
    { club: { name: 'A', address: { lat: 59.1, lon: 18.1 } } },
  ];
  for (const s of shapes) {
    const [b] = parseUpcomingWorkouts([{ id: '1', name: 'X', startTime: '2026-12-03T12:00:00Z', ...s }], { timeZone: TZ });
    assert.equal(b.centre.lat, 59.1);
    assert.equal(b.centre.lon, 18.1);
  }
});

test('handles a bare array and nested class objects', () => {
  const json = [
    {
      bookingId: 'b-1',
      groupExercise: { name: 'Pilates', startTime: '2026-12-03T12:00:00Z', club: { name: 'Example Centre East' } },
    },
  ];
  const [b] = parseUpcomingWorkouts(json, { timeZone: TZ });
  assert.equal(b.id, 'b-1');
  assert.equal(b.name, 'Pilates');
  assert.equal(b.centre.name, 'Example Centre East');
  assert.equal(b.start.toISOString(), '2026-12-03T12:00:00.000Z');
});

test('ignores objects without a start time or a name, and empty responses', () => {
  assert.deepEqual(parseUpcomingWorkouts({}, { timeZone: TZ }), []);
  assert.deepEqual(parseUpcomingWorkouts(null, { timeZone: TZ }), []);
  assert.deepEqual(parseUpcomingWorkouts({ items: [{ name: 'No time' }, { startTime: '2026-12-03T12:00:00Z' }] }, { timeZone: TZ }), []);
});

test('local times across the DST change are converted correctly', () => {
  const json = [
    { id: 's', name: 'Summer', startTime: '2026-07-01T06:30:00' },
    { id: 'w', name: 'Winter', startTime: '2026-12-01T06:30:00' },
  ];
  const [summer, winter] = parseUpcomingWorkouts(json, { timeZone: TZ });
  assert.equal(summer.start.toISOString(), '2026-07-01T04:30:00.000Z');
  assert.equal(winter.start.toISOString(), '2026-12-01T05:30:00.000Z');
});

test('serialise/deserialise round trip for the device-store cache', () => {
  const bookings = parseUpcomingWorkouts(loadFixture('upcoming-workouts.json'), { timeZone: TZ });
  const back = deserializeBookings(JSON.parse(JSON.stringify(serializeBookings(bookings))));
  assert.deepEqual(back, bookings);
});
