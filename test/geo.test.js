'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { distanceKm, Geocoder, buildQuery } = require('../lib/geo');
const { isWithinKm } = require('../lib/scheduler');
const { fakeTransport, memorySettings } = require('./helpers');

const STOCKHOLM = { lat: 59.3293, lon: 18.0686 };
const OSLO = { lat: 59.9139, lon: 10.7522 };

test('haversine distance Stockholm-Oslo is about 416 km', () => {
  const d = distanceKm(STOCKHOLM, OSLO);
  assert.ok(d > 410 && d < 420, `got ${d}`);
  assert.equal(distanceKm(STOCKHOLM, STOCKHOLM), 0);
  assert.equal(distanceKm(STOCKHOLM, { lat: null, lon: 1 }), null);
});

test('a class in Oslo fails "within 10 km of home" for a Stockholm home', () => {
  const osloClass = { centre: { name: 'Example Centre Oslo', ...OSLO } };
  const nearbyClass = { centre: { name: 'Example Centre North', lat: 59.342, lon: 18.049 } };
  assert.equal(isWithinKm(osloClass, STOCKHOLM, 10), false);
  assert.equal(isWithinKm(osloClass, STOCKHOLM, 500), true);
  assert.equal(isWithinKm(nearbyClass, STOCKHOLM, 10), true);
  assert.equal(isWithinKm({ centre: { name: 'Unknown', lat: null, lon: null } }, STOCKHOLM, 10000), false, 'unknown location never passes');
});

test('query uses the street address when present, else name and city', () => {
  assert.equal(buildQuery({
    name: 'X', address: 'Example Street 1', postalCode: '113 00', city: 'Stockholm', country: 'Sweden',
  }), 'Example Street 1, 113 00 Stockholm, Sweden');
  assert.equal(buildQuery({ name: 'Example Centre Oslo', city: 'Oslo', country: 'Norway' }), 'Example Centre Oslo, Oslo, Norway');
});

function nominatim(hits) {
  return fakeTransport(() => ({ status: 200, body: hits }));
}

test('geocoder calls Nominatim with a User-Agent, caches hits, and respects 1 request/s', async () => {
  const transport = nominatim([{ lat: '59.9139', lon: '10.7522', address: { city: 'Oslo', country: 'Norway' } }]);
  let clock = 1000000;
  const sleeps = [];
  const cache = memorySettings();
  const geocoder = new Geocoder({
    cache, transport, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  const a = await geocoder.locate({ id: 'c-9', name: 'Example Centre Oslo', city: 'Oslo' });
  assert.equal(a.lat, 59.9139);
  assert.equal(a.city, 'Oslo');
  assert.equal(a.country, 'Norway');
  const call = transport.calls[0];
  assert.match(call.url, /^https:\/\/nominatim\.openstreetmap\.org\/search\?/);
  assert.match(call.url, /q=Example\+Centre\+Oslo%2C\+Oslo/);
  assert.match(call.headers['User-Agent'], /HomeySATS/);

  // cached: no second request for the same centre
  await geocoder.locate({ id: 'c-9', name: 'Example Centre Oslo', city: 'Oslo' });
  assert.equal(transport.calls.length, 1);
  assert.ok(cache.get('geocache')['id:c-9']);

  // a different centre right away has to wait ~1.1 s
  await geocoder.locate({ id: 'c-10', name: 'Example Centre Bergen' });
  assert.equal(transport.calls.length, 2);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 1000 && sleeps[0] <= 1100);
});

test('geocoder caches misses and tolerates errors', async () => {
  const cache = memorySettings();
  const empty = new Geocoder({ cache, transport: nominatim([]), sleep: async () => {} });
  assert.equal(await empty.locate({ name: 'Nowhere Centre' }), null);
  assert.equal(cache.get('geocache')['q:nowhere centre'].miss, true);

  const broken = new Geocoder({
    cache: memorySettings(),
    transport: async () => { throw Object.assign(new Error('boom'), { code: 'ECONNRESET' }); },
    sleep: async () => {},
  });
  assert.equal(await broken.locate({ name: 'Example Centre' }), null);
});
