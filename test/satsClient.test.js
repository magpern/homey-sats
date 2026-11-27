'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SatsClient, SatsAuthError, SatsError } = require('../lib/SatsClient');
const {
  TEST_USERNAME, TEST_PASSWORD, tokenResponse, fakeTransport, loadFixture,
} = require('./helpers');

const TOKEN_URL = 'https://auth.satsgroup.com/realms/sats/protocol/openid-connect/token';
const API = 'https://api.sats.com/sats-mab-api';

function makeClient(transport, extra = {}) {
  let now = Date.parse('2026-11-29T20:00:00Z');
  const saved = [];
  const client = new SatsClient({
    transport,
    diagnosticDelayMs: 0,
    now: () => now,
    onRefreshToken: (t) => saved.push(t),
    ...extra,
  });
  client.advance = (ms) => { now += ms; };
  client.saved = saved;
  return client;
}

function form(body) {
  return Object.fromEntries(new URLSearchParams(body));
}

const okApi = (body) => (call) => (call.url === TOKEN_URL
  ? { status: 200, body: tokenResponse() }
  : { status: 200, body });

test('login uses the Keycloak password grant with the member-app client id', async () => {
  const transport = fakeTransport(() => ({ status: 200, body: tokenResponse() }));
  const client = makeClient(transport);
  const account = await client.login(TEST_USERNAME, TEST_PASSWORD);

  assert.equal(transport.calls.length, 1);
  const call = transport.calls[0];
  assert.equal(call.url, TOKEN_URL);
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(form(call.body), {
    grant_type: 'password',
    username: TEST_USERNAME,
    password: TEST_PASSWORD,
    scope: 'openid offline_access',
    client_id: 'memberapp-android',
  });
  assert.equal(account.refreshToken, 'fake-refresh-R1');
  assert.match(account.memberKey, /^[0-9a-f]{24}$/, 'opaque hash, not the raw SATS id');
  assert.ok(!account.memberKey.includes('999999'));
  assert.deepEqual(client.saved, ['fake-refresh-R1'], 'refresh token handed over for the device store');
});

test('login retries without offline_access if the client may not use that scope', async () => {
  const transport = fakeTransport((call) => (form(call.body).scope
    ? { status: 400, body: { error: 'invalid_scope' } }
    : { status: 200, body: tokenResponse() }));
  const client = makeClient(transport);
  await client.login(TEST_USERNAME, TEST_PASSWORD);
  assert.deepEqual(transport.calls.map((c) => form(c.body).scope), ['openid offline_access', undefined]);
});

test('invalid credentials raise SatsAuthError without leaking username or password', async () => {
  const transport = fakeTransport(() => ({
    status: 401,
    body: { error: 'invalid_grant', error_description: `Invalid user credentials for ${TEST_USERNAME} / ${TEST_PASSWORD}` },
  }));
  const client = makeClient(transport);
  await assert.rejects(client.login(TEST_USERNAME, TEST_PASSWORD), (err) => {
    assert.ok(err instanceof SatsAuthError);
    assert.equal(err.code, 'INVALID_CREDENTIALS');
    assert.ok(!err.message.includes(TEST_PASSWORD));
    assert.ok(!err.message.includes(TEST_USERNAME));
    return true;
  });
});

test('empty credentials fail before any network call', async () => {
  const transport = fakeTransport(() => ({ status: 200, body: tokenResponse() }));
  const client = makeClient(transport);
  await assert.rejects(client.login('', ''), { code: 'NO_CREDENTIALS' });
  assert.equal(transport.calls.length, 0);
});

test('a client restored from a stored refresh token never needs the password', async () => {
  const fixture = loadFixture('upcoming-workouts.json');
  const transport = fakeTransport(okApi(fixture));
  const client = makeClient(transport, { refreshToken: 'stored-refresh-1', market: 'se' });
  const json = await client.getUpcomingWorkouts();

  assert.deepEqual(json, fixture);
  assert.deepEqual(form(transport.calls[0].body), {
    grant_type: 'refresh_token',
    refresh_token: 'stored-refresh-1',
    client_id: 'memberapp-android',
  });
  const apiCall = transport.calls[1];
  assert.equal(apiCall.method, 'GET');
  assert.equal(apiCall.url, `${API}/v2/se/upcoming-workouts`);
  assert.match(apiCall.headers.Authorization, /^Bearer ey/);
  assert.equal(apiCall.headers['Accept-Language'], 'sv-SE');
  assert.deepEqual(client.saved, ['fake-refresh-R1'], 'rotated refresh token is persisted');
});

test('without a session the client asks for a repair', async () => {
  const transport = fakeTransport(okApi({}));
  const client = makeClient(transport);
  await assert.rejects(client.getUpcomingWorkouts(), { code: 'NO_SESSION' });
  assert.equal(transport.calls.length, 0);
});

test('a rejected refresh token means the session expired (no password fallback)', async () => {
  const transport = fakeTransport(() => ({ status: 400, body: { error: 'invalid_grant' } }));
  const client = makeClient(transport, { refreshToken: 'stale' });
  await assert.rejects(client.getUpcomingWorkouts(), (err) => {
    assert.ok(err instanceof SatsAuthError);
    assert.equal(err.code, 'SESSION_EXPIRED');
    return true;
  });
  assert.equal(client.hasSession(), false);
});

test('access token is reused until it expires, then renewed', async () => {
  const transport = fakeTransport(okApi({ upcomingWorkouts: [] }));
  const client = makeClient(transport, { refreshToken: 'r0' });
  await client.getUpcomingWorkouts();
  await client.getUpcomingWorkouts();
  assert.equal(transport.calls.filter((c) => c.url === TOKEN_URL).length, 1);
  client.advance(10 * 60 * 1000); // past expires_in (300 s)
  await client.getUpcomingWorkouts();
  const tokenCalls = transport.calls.filter((c) => c.url === TOKEN_URL).map((c) => form(c.body));
  assert.equal(tokenCalls.length, 2);
  assert.equal(tokenCalls[1].refresh_token, 'fake-refresh-R1', 'uses the rotated token');
});

test('booking list: tries the next path segment on 404 and remembers the one that works', async () => {
  const transport = fakeTransport((call) => {
    if (call.url === TOKEN_URL) return { status: 200, body: tokenResponse() };
    if (call.url.endsWith('/v2/sats/upcoming-workouts')) return { status: 200, body: { upcomingWorkouts: [] } };
    return { status: 404, body: { message: 'Not found' } };
  });
  const client = makeClient(transport, { refreshToken: 'r0' });
  await client.getUpcomingWorkouts();
  assert.equal(client.resolvedSegment, 'sats');

  transport.calls.length = 0;
  await client.getUpcomingWorkouts();
  assert.equal(transport.calls.length, 1);
  assert.ok(transport.calls[0].url.endsWith('/v2/sats/upcoming-workouts'));
});

test('a configured path segment is used as-is', async () => {
  const transport = fakeTransport((call) => (call.url === TOKEN_URL
    ? { status: 200, body: tokenResponse() }
    : { status: 404, body: {} }));
  const client = makeClient(transport, { refreshToken: 'r0', pathSegment: 'custom' });
  await assert.rejects(client.getUpcomingWorkouts(), { code: 'ENDPOINT_NOT_FOUND' });
  const apiCalls = transport.calls.filter((c) => c.url !== TOKEN_URL);
  assert.deepEqual(apiCalls.map((c) => c.url), [`${API}/v2/custom/upcoming-workouts`]);
});

test('401 from the API forces a token refresh and one retry', async () => {
  let apiCalls = 0;
  const transport = fakeTransport((call) => {
    if (call.url === TOKEN_URL) return { status: 200, body: tokenResponse() };
    apiCalls += 1;
    return apiCalls === 1 ? { status: 401, body: {} } : { status: 200, body: { upcomingWorkouts: [] } };
  });
  const client = makeClient(transport, { refreshToken: 'r0' });
  await client.getUpcomingWorkouts();
  assert.equal(apiCalls, 2);
  assert.equal(transport.calls.filter((c) => c.url === TOKEN_URL).length, 2);
});

test('API errors never contain tokens or response bodies', async () => {
  const tokens = tokenResponse();
  const transport = fakeTransport((call) => {
    if (call.url === TOKEN_URL) return { status: 200, body: tokens };
    return { status: 503, body: { message: `echo ${tokens.access_token}`, member: 'Invented Person' } };
  });
  const client = makeClient(transport, { refreshToken: 'r0' });
  await assert.rejects(client.getUpcomingWorkouts(), (err) => {
    assert.ok(err instanceof SatsError);
    assert.equal(err.status, 503);
    for (const secret of [tokens.access_token, tokens.refresh_token, 'r0', 'Invented Person']) {
      assert.ok(!err.message.includes(secret));
    }
    return true;
  });
});

test('429 is reported as rate limiting', async () => {
  const transport = fakeTransport(() => ({ status: 429, body: {} }));
  const client = makeClient(transport);
  await assert.rejects(client.login(TEST_USERNAME, TEST_PASSWORD), { code: 'RATE_LIMIT' });
});

test('shapeOf lists key names only and masks id-like keys', () => {
  const { shapeOf } = require('../lib/SatsClient');
  const shape = shapeOf({
    firstName: 'Invented Person',
    email: 'someone@example.com',
    items: [{ id: 1, name: 'Strength 45', startTime: '2026-11-30T06:30:00Z' }],
    byDate: { '2026-11-30': { count: 2 }, 'someone@example.com': 1 },
  });
  assert.equal(shape, '{firstName,email,items:[1]{id,name,startTime},byDate:{<key>:{count},<key>}}');
  for (const secret of ['Invented Person', 'someone@example.com', 'Strength 45', '2026-11-30']) {
    assert.ok(!shape.includes(secret));
  }
});

test('diagnostics sweep prefixes, report status codes and shapes, and mask member ids', async () => {
  const transport = fakeTransport((call) => {
    if (call.url === TOKEN_URL) return { status: 200, body: tokenResponse() };
    if (call.url.endsWith('/v2/booking-landing-page')) {
      return { status: 200, body: { items: [{ type: 'GxOfferings', content: { title: 'x' } }, { type: 'Recommendation', content: { list: [] } }] } };
    }
    if (call.url.endsWith('/profile/v2/999999/upcoming-workouts')) return { status: 200, body: { upcoming: [{ name: 'Strength 45', type: 'upcoming-group-exercise' }] } };
    return { status: 404, body: { message: 'Not found' } };
  });
  const client = makeClient(transport, { refreshToken: 'r0' });
  const report = await client.diagnose();
  const text = JSON.stringify(report);
  assert.ok(report.claimNames.includes('exerpMemberId'));
  assert.ok(!text.includes('999999'), 'member id from the token is masked');
  assert.ok(!text.includes('user-0000-test'), 'sub is masked');
  assert.ok(!text.includes('Invented Person') && !text.includes('Strength 45'), 'no values');
  const byPath = Object.fromEntries(report.requests.map((r) => [r.path, r]));
  assert.equal(byPath['/profile/v2/<exerpMemberId>/upcoming-workouts'].status, 200);
  assert.equal(byPath['/profile/v2/<exerpMemberId>/upcoming-workouts'].shape, '{upcoming:[1]{name,type=upcoming-group-exercise}}');
  assert.equal(byPath['/v2/booking-landing-page'].shape, '{items:[2]{type=GxOfferings,content:{title}}|{type=Recommendation,content:{list:[0]}}}');
  assert.equal(byPath['/v2/se/upcoming-workouts'].status, 404);
  assert.ok(report.requests.length > 50 && report.requests.length <= 120, `${report.requests.length} requests`);
});
