'use strict';

const fs = require('fs');
const path = require('path');

// All values below are invented for tests.
const TEST_USERNAME = 'test.member@example.com';
const TEST_PASSWORD = 'not-a-real-password-123';

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Unsigned fake JWT with invented claims. */
function fakeJwt(claims) {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.fake-signature`;
}

function tokenResponse({ access = 'A1', refresh = 'R1', expiresIn = 300 } = {}) {
  const base = loadFixture('token-response.json');
  delete base._comment;
  return {
    ...base,
    expires_in: expiresIn,
    access_token: fakeJwt({ sub: 'user-0000-test', exerpMemberId: '999999', marker: access }),
    refresh_token: `fake-refresh-${refresh}`,
  };
}

/**
 * Scripted fake transport. `routes` is a list of handlers tried in order;
 * every call is recorded in `calls`.
 */
function fakeTransport(handler) {
  const calls = [];
  const transport = async (url, opts) => {
    const call = { url, ...opts };
    calls.push(call);
    const res = await handler(call, calls.length);
    return { status: res.status, headers: {}, text: typeof res.body === 'string' ? res.body : JSON.stringify(res.body) };
  };
  transport.calls = calls;
  return transport;
}

/** In-memory replacement for homey.settings. */
function memorySettings(initial = {}) {
  const store = { ...initial };
  return {
    get: (k) => (k in store ? store[k] : null),
    set: (k, v) => { store[k] = v; },
    unset: (k) => { delete store[k]; },
    store,
  };
}

/** Manual timers so tests control time. */
function manualTimers() {
  let id = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout: (fn, ms) => { id += 1; pending.set(id, { fn, ms, kind: 'timeout' }); return id; },
    clearTimeout: (t) => pending.delete(t),
    setInterval: (fn, ms) => { id += 1; pending.set(id, { fn, ms, kind: 'interval' }); return id; },
    clearInterval: (t) => pending.delete(t),
    timeouts: () => [...pending.values()].filter((p) => p.kind === 'timeout'),
  };
}

module.exports = {
  TEST_USERNAME,
  TEST_PASSWORD,
  loadFixture,
  fakeJwt,
  tokenResponse,
  fakeTransport,
  memorySettings,
  manualTimers,
};
