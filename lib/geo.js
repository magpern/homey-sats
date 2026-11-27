'use strict';

const { request: httpsRequest } = require('./http');

const EARTH_RADIUS_KM = 6371.0088;

/** Great-circle distance in km between two {lat, lon} points (haversine). */
function distanceKm(a, b) {
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)
    || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) return null;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const MIN_INTERVAL_MS = 1100; // Nominatim usage policy: at most 1 request per second
const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Stable cache key for a centre. */
function centreKey(centre) {
  if (centre.id) return `id:${centre.id}`;
  return `q:${[centre.name, centre.address, centre.city, centre.country].filter(Boolean).join('|').toLowerCase()}`;
}

function buildQuery(centre) {
  if (centre.address) {
    return [centre.address, [centre.postalCode, centre.city].filter(Boolean).join(' '), centre.country]
      .filter(Boolean).join(', ');
  }
  return [centre.name, centre.city, centre.country].filter(Boolean).join(', ');
}

/**
 * Geocodes centre addresses with OpenStreetMap Nominatim when the SATS API
 * response has no coordinates. Only the centre's public name/address is
 * sent. The Homey's own location and member data are never sent.
 * Results are cached (in the app's settings store) so each centre is looked up once.
 */
class Geocoder {
  constructor({
    cache, transport = httpsRequest, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    userAgent = 'HomeySATS/1.0 (+https://github.com/magpern/homey-sats)', log = () => {},
  }) {
    this.cache = cache; // { get(key) -> object|null, set(key, object) }
    this.transport = transport;
    this.now = now;
    this.sleep = sleep;
    this.userAgent = userAgent;
    this.log = log;
    this.lastRequestAt = 0;
    this.queue = Promise.resolve();
  }

  _readCache() {
    return this.cache.get('geocache') || {};
  }

  _writeCache(key, value) {
    const all = this._readCache();
    all[key] = value;
    this.cache.set('geocache', all);
  }

  /**
   * @param {object} centre {name, id, address, postalCode, city, country}
   * @returns {Promise<{lat:number, lon:number, city:string, country:string}|null>}
   */
  locate(centre) {
    // Serialise lookups so the rate limit holds across all members.
    const run = this.queue.then(() => this._locate(centre));
    this.queue = run.catch(() => {});
    return run;
  }

  async _locate(centre) {
    const query = buildQuery(centre);
    if (!query) return null;
    const key = centreKey(centre);
    const cached = this._readCache()[key];
    if (cached) {
      if (cached.miss && this.now() - cached.at < NEGATIVE_TTL_MS) return null;
      if (!cached.miss) return cached;
    }

    const wait = this.lastRequestAt + MIN_INTERVAL_MS - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();

    const url = `${NOMINATIM_URL}?${new URLSearchParams({
      q: query, format: 'jsonv2', addressdetails: '1', limit: '1',
    })}`;
    let res;
    try {
      res = await this.transport(url, {
        method: 'GET',
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json', 'Accept-Language': 'en' },
      });
    } catch (err) {
      this.log(`Geocoding failed (${err.code || err.message})`);
      return null; // transient: don't cache
    }
    if (res.status !== 200) {
      this.log(`Geocoding returned HTTP ${res.status}`);
      return null;
    }
    let list;
    try {
      list = JSON.parse(res.text);
    } catch (e) {
      return null;
    }
    const hit = Array.isArray(list) ? list[0] : null;
    const lat = hit ? Number(hit.lat) : NaN;
    const lon = hit ? Number(hit.lon) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      this._writeCache(key, { miss: true, at: this.now() });
      return null;
    }
    const a = hit.address || {};
    const result = {
      lat,
      lon,
      city: a.city || a.town || a.village || a.municipality || '',
      country: a.country || '',
      at: this.now(),
    };
    this._writeCache(key, result);
    return result;
  }
}

module.exports = {
  distanceKm, Geocoder, centreKey, buildQuery,
};
