'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MemberService } = require('../lib/MemberService');
const { SatsClient } = require('../lib/SatsClient');
const { Geocoder } = require('../lib/geo');
const { anyMemberHasClassBefore } = require('../lib/scheduler');
const { nextDelay, MINUTE } = require('../lib/backoff');
const {
  tokenResponse, fakeTransport, memorySettings, manualTimers, loadFixture,
} = require('./helpers');

const TOKEN_URL = 'https://auth.satsgroup.com/realms/sats/protocol/openid-connect/token';
const TZ = 'Europe/Stockholm';
const STOCKHOLM_HOME = { lat: 59.3293, lon: 18.0686 };

/** Mocked OpenStreetMap: knows only the invented Oslo centre. */
function osloGeocoder() {
  const transport = fakeTransport((call) => (call.url.includes('Oslo')
    ? { status: 200, body: [{ lat: '59.9139', lon: '10.7522', address: { city: 'Oslo', country: 'Norway' } }] }
    : { status: 200, body: [] }));
  const geocoder = new Geocoder({ cache: memorySettings(), transport, sleep: async () => {} });
  geocoder.transport.calls = transport.calls;
  return geocoder;
}

function makeMember({
  fixture, clock, geocoder = null, store = { refreshToken: 'stored-refresh' }, handler, home = STOCKHOLM_HOME, offsets = [60],
}) {
  const transport = fakeTransport(handler || ((call) => (call.url === TOKEN_URL
    ? { status: 200, body: tokenResponse() }
    : { status: 200, body: loadFixture(fixture) })));
  const timers = manualTimers();
  const fired = [];
  const logs = [];
  const statuses = [];
  const deviceStore = memorySettings(store);
  const fire = (kind) => async (tokens, state) => fired.push({ kind, tokens, state });
  const service = new MemberService({
    store: deviceStore,
    getConfig: () => ({ market: 'se', geocoding: true }),
    getTimeZone: () => TZ,
    getHome: () => home,
    geocoder,
    events: { onStart: fire('start'), onEnd: fire('end'), onCancelled: fire('cancelled') },
    getStartOffsets: async () => offsets,
    onStatus: (s) => statuses.push(s),
    log: (...a) => logs.push(a.join(' ')),
    error: (...a) => logs.push(a.join(' ')),
    now: () => new Date(clock.t),
    timers,
    random: () => 0.5, // no jitter
    clientFactory: (opts) => new SatsClient({ ...opts, transport, diagnosticDelayMs: 0 }),
  });
  return {
    service, transport, timers, fired, logs, statuses, deviceStore,
  };
}

function at(iso) {
  return { t: new Date(iso).getTime() };
}

async function runTicks(members, clock, untilIso, stepMs = 30 * 1000) {
  const end = new Date(untilIso).getTime();
  while (clock.t < end) {
    clock.t += stepMs;
    for (const m of members) await m.service.tick();
  }
}

test('two members with different schedules fire their own triggers', async () => {
  const clock = at('2026-11-30T05:00:00+01:00');
  const a = makeMember({ fixture: 'upcoming-workouts.json', clock });
  const b = makeMember({ fixture: 'upcoming-workouts-member-b.json', clock, geocoder: osloGeocoder() });
  await a.service.refresh();
  await b.service.refresh();

  await runTicks([a, b], clock, '2026-11-30T13:00:00+01:00');

  const starts = (m) => m.fired.filter((f) => f.kind === 'start').map((f) => `${f.tokens.start} ${f.tokens.class_name}`);
  assert.deepEqual(starts(a), ['06:30 Strength 45']);
  assert.deepEqual(starts(b), ['12:00 Core 30']);

  // App-level condition across members (Sunday evening, asking about Monday).
  const sun = new Date('2026-11-29T21:00:00+01:00');
  const args = {
    time: '09:00', day: 'tomorrow', now: sun, timeZone: TZ,
  };
  assert.equal(anyMemberHasClassBefore([a.service.bookings, b.service.bookings], args), true, 'member A has 06:30');
  assert.equal(anyMemberHasClassBefore([b.service.bookings], args), false, 'member B only has 12:00 on Monday');
  const tue = { ...args, now: new Date('2026-11-30T21:00:00+01:00') };
  assert.equal(anyMemberHasClassBefore([b.service.bookings], tue), true, 'member B has 07:00 on Tuesday');
  assert.equal(anyMemberHasClassBefore([a.service.bookings], tue), false, "member A's Tuesday class is waitlisted");
});

test('a class in Oslo fails "within 10 km" for a Stockholm home; geocoded city/country become tokens', async () => {
  const clock = at('2026-12-01T05:00:00+01:00');
  const geocoder = osloGeocoder();
  const b = makeMember({ fixture: 'upcoming-workouts-member-b.json', clock, geocoder });
  await b.service.refresh();

  const oslo = b.service.bookings.find((x) => x.id === 'gx-5002');
  assert.equal(oslo.centre.locationSource, 'geocoded');
  assert.equal(geocoder.transport.calls.length, 1, 'only the centre without API coordinates is geocoded');

  await runTicks([b], clock, '2026-12-01T06:01:00+01:00');
  const [fired] = b.fired;
  assert.equal(fired.tokens.class_name, 'Spinning 45');
  assert.equal(fired.tokens.city, 'Oslo');
  assert.equal(fired.tokens.country, 'Norway');
  assert.ok(fired.tokens.distance_km > 400, `distance ${fired.tokens.distance_km}`);

  // The condition looks at the class that just triggered.
  assert.equal(b.service.isWithinKm(10), false);
  assert.equal(b.service.isWithinKm(500), true);
  assert.equal(b.service.isAtHomeCentre('Example Centre North'), false);
  assert.equal(b.service.isAtHomeCentre('Example Centre Oslo'), true);
});

test('a Stockholm class passes "within 10 km" and the home-centre condition', async () => {
  const clock = at('2026-11-30T05:00:00+01:00');
  const a = makeMember({ fixture: 'upcoming-workouts.json', clock });
  await a.service.refresh();
  await runTicks([a], clock, '2026-11-30T05:31:00+01:00');
  assert.equal(a.fired.length, 1);
  assert.equal(a.service.isWithinKm(10), true);
  assert.equal(a.service.isAtHomeCentre('example centre north\nExample Centre South'), true);
});

test('without a known home location the distance condition is false', async () => {
  const clock = at('2026-11-30T05:00:00+01:00');
  const a = makeMember({ fixture: 'upcoming-workouts.json', clock, home: null });
  await a.service.refresh();
  assert.equal(a.service.isWithinKm(10000), false);
});

test('a class that disappears between polls fires "class cancelled" once', async () => {
  const clock = at('2026-11-30T05:00:00+01:00');
  let fixture = loadFixture('upcoming-workouts.json');
  const a = makeMember({
    fixture: null,
    clock,
    handler: (call) => (call.url === TOKEN_URL ? { status: 200, body: tokenResponse() } : { status: 200, body: fixture }),
  });
  await a.service.refresh();
  fixture = { workouts: fixture.workouts.filter((w) => w.content.id !== 'gx-1002') };
  await a.service.refresh();
  await a.service.refresh();
  const cancelled = a.fired.filter((f) => f.kind === 'cancelled');
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].tokens.class_name, 'Cycling 50');
  assert.equal(cancelled[0].tokens.start, '18:00');
});

test('"class ends" fires at the end time', async () => {
  const clock = at('2026-11-30T07:00:00+01:00');
  const a = makeMember({ fixture: 'upcoming-workouts.json', clock, offsets: [] });
  await a.service.refresh();
  await runTicks([a], clock, '2026-11-30T07:16:00+01:00');
  assert.deepEqual(a.fired.map((f) => `${f.kind} ${f.tokens.class_name} ${f.tokens.end}`), ['end Strength 45 07:15']);
});

test('backoff: 30 min normally, then 2, 4, 8 ... capped at 4 h', () => {
  const r = () => 0.5;
  assert.equal(nextDelay(0, {}, r), 30 * MINUTE);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map((n) => nextDelay(n, {}, r) / MINUTE), [2, 4, 8, 16, 32, 64, 128, 240, 240, 240]);
  assert.equal(nextDelay(0, {}, () => 0), 27 * MINUTE, '10 % jitter');
});

test('errors back off exponentially; success resets the 30-minute interval', async () => {
  const clock = at('2026-11-30T05:00:00+01:00');
  let fail = true;
  const a = makeMember({
    fixture: null,
    clock,
    handler: (call) => {
      if (call.url === TOKEN_URL) return { status: 200, body: tokenResponse() };
      return fail ? { status: 503, body: {} } : { status: 200, body: { upcomingWorkouts: [] } };
    },
  });
  const delays = [];
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(a.service.refresh());
    delays.push(a.timers.timeouts()[0].ms / MINUTE);
  }
  assert.deepEqual(delays, [2, 4, 8]);
  assert.equal(a.statuses.at(-1).state, 'error');
  fail = false;
  await a.service.refresh();
  assert.equal(a.timers.timeouts()[0].ms, 30 * MINUTE);
  assert.equal(a.statuses.at(-1).state, 'ok');
});

test('an expired session pauses polling until the device is repaired', async () => {
  const clock = at('2026-11-30T05:00:00+01:00');
  const a = makeMember({
    fixture: null,
    clock,
    handler: () => ({ status: 400, body: { error: 'invalid_grant' } }),
  });
  await assert.rejects(a.service.refresh(), /session has expired/);
  assert.equal(a.timers.timeouts().length, 0, 'no retry scheduled');
  assert.equal(a.statuses.at(-1).state, 'auth_error');
  assert.equal(a.transport.calls.length, 1);

  // Repair stores a new refresh token and reconfigures.
  a.deviceStore.set('refreshToken', 'new-refresh-after-repair');
  a.service.reconfigure();
  assert.equal(a.timers.timeouts().length, 1, 'poll scheduled after repair');
});

test('the rotated refresh token is written to the device store; no password is ever stored', async () => {
  const clock = at('2026-11-30T05:00:00+01:00');
  const a = makeMember({ fixture: 'upcoming-workouts.json', clock });
  await a.service.refresh();
  assert.equal(a.deviceStore.get('refreshToken'), 'fake-refresh-R1');
  const allowed = new Set(['refreshToken', 'bookingsCache', 'cancelledCache', 'firedKeys']);
  for (const key of Object.keys(a.deviceStore.store)) assert.ok(allowed.has(key), `unexpected store key ${key}`);
  assert.ok(!JSON.stringify(a.deviceStore.store).includes('password'));
});

test('logs and status never contain tokens, class names, centres or response data', async () => {
  const clock = at('2026-11-30T05:00:00+01:00');
  const a = makeMember({ fixture: 'upcoming-workouts.json', clock });
  await a.service.refresh();
  await runTicks([a], clock, '2026-11-30T05:31:00+01:00');
  const b = makeMember({ fixture: null, clock, handler: () => ({ status: 400, body: { error: 'invalid_grant' } }) });
  await assert.rejects(b.service.refresh());

  const all = [...a.logs, ...b.logs, JSON.stringify(a.statuses), JSON.stringify(b.statuses)].join('\n');
  for (const secret of ['stored-refresh', 'fake-refresh', 'eyJ', 'Strength 45', 'Example Centre', 'Instructor A']) {
    assert.ok(!all.includes(secret), `"${secret}" leaked into logs/status`);
  }
});

test('endpoint not found runs diagnostics once and logs no personal data', async () => {
  const clock = at('2026-11-30T05:00:00+01:00');
  const a = makeMember({
    fixture: null,
    clock,
    handler: (call) => {
      if (call.url === TOKEN_URL) return { status: 200, body: tokenResponse() };
      if (call.url.endsWith('/v2/booking-landing-page')) return { status: 200, body: { firstName: 'Invented Person' } };
      return { status: 404, body: {} };
    },
  });
  await assert.rejects(a.service.refresh(), /No upcoming-workouts endpoint/);
  const diagLines = a.logs.filter((l) => l.startsWith('Diagnostics:'));
  assert.ok(diagLines.some((l) => l.includes('GET /v2/booking-landing-page -> 200 keys {firstName}')));
  assert.ok(diagLines.some((l) => /paths tried, \d+ returned 404/.test(l)));
  assert.ok(!diagLines.some((l) => l.includes('-> 404')), '404s are only counted');
  const all = a.logs.join('\n');
  for (const secret of ['Invented Person', '999999', 'user-0000-test', 'fake-refresh', 'eyJ']) {
    assert.ok(!all.includes(secret), `"${secret}" leaked`);
  }
  const before = a.transport.calls.length;
  await assert.rejects(a.service.refresh());
  const apiCalls = a.transport.calls.slice(before).filter((c) => c.url !== TOKEN_URL).length;
  assert.ok(apiCalls <= 9, `second failure does not re-run diagnostics (${apiCalls} API calls)`);
});
