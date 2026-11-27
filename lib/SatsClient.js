'use strict';

const crypto = require('crypto');
const { request: httpsRequest } = require('./http');

/*
 * Client for the SATS member API used by the SATS mobile app.
 * See docs/sats-api.md for where each constant comes from and what is unverified.
 *
 * Secrets policy:
 * - The password is only used inside login() (pairing / repair) and is never kept.
 * - The refresh token is handed to `onRefreshToken` so the device can persist it
 *   in its store (it may rotate on every refresh). The access token stays in memory.
 * - None of these, nor response bodies, ever appear in logs or error messages.
 */

const DEFAULTS = {
  authBase: 'https://auth.satsgroup.com',
  realm: 'sats',
  clientId: 'memberapp-android',
  apiBase: 'https://api.sats.com/sats-mab-api',
  upcomingPath: '/profile/v2/{segment}/upcoming-workouts', // observed live 2026-11-27
  userAgent: 'HomeySATS/1.0',
  diagnosticDelayMs: 150, // spacing between diagnostic requests
};

const LANGUAGE_BY_MARKET = {
  se: 'sv-SE', no: 'nb-NO', dk: 'da-DK', fi: 'fi-FI',
};

class SatsError extends Error {
  constructor(message, { code = 'SATS_ERROR', status } = {}) {
    super(message);
    this.name = 'SatsError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

class SatsAuthError extends SatsError {
  constructor(message, opts = {}) {
    super(message, { code: 'AUTH', ...opts });
    this.name = 'SatsAuthError';
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function decodeJwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

/** Keycloak / OAuth error codes are short identifiers, safe to show. */
function oauthErrorCode(body) {
  const code = body && typeof body.error === 'string' ? body.error : '';
  return /^[a-z_]{1,64}$/i.test(code) ? code : '';
}

class SatsClient {
  /**
   * @param {object} opts
   * @param {string} [opts.refreshToken] Persisted refresh token (from the device store).
   * @param {(token: string) => void} [opts.onRefreshToken] Called whenever a new refresh token is issued.
   * @param {string} [opts.market] 'se' | 'no' | 'dk' | 'fi'
   * @param {string} [opts.pathSegment] Override for the {segment} in the upcoming-workouts path.
   * @param {Function} [opts.transport] (url, {method, headers, body}) => Promise<{status, text}>
   * @param {() => number} [opts.now]
   */
  constructor({
    refreshToken = null, onRefreshToken = () => {}, market = 'se', pathSegment = '',
    transport = httpsRequest, now = Date.now, ...rest
  } = {}) {
    this.config = { ...DEFAULTS, ...rest };
    this.market = market;
    this.pathSegment = pathSegment;
    this.transport = transport;
    this.now = now;
    this.onRefreshToken = onRefreshToken;
    this.resolvedSegment = null;
    this._tokens = refreshToken ? {
      accessToken: null, refreshToken, expiresAt: 0, refreshExpiresAt: null, claims: {},
    } : null;
  }

  get tokenUrl() {
    return `${this.config.authBase}/realms/${this.config.realm}/protocol/openid-connect/token`;
  }

  hasSession() {
    return Boolean(this._tokens && this._tokens.refreshToken);
  }

  /** Claims of the current access token (member's own identifiers). Never log these. */
  get claims() {
    return (this._tokens && this._tokens.claims) || {};
  }

  /**
   * Opaque, stable id for the logged-in member, used as the Homey device id.
   * A hash, so the raw SATS identifiers aren't exposed in device data.
   */
  memberKey() {
    const c = this.claims;
    const raw = c.sub || c.exerpMemberId || c.memberId || c.externalId;
    if (!raw) return null;
    return crypto.createHash('sha256').update(`sats-member:${raw}`).digest('hex').slice(0, 24);
  }

  async _tokenRequest(params) {
    const body = new URLSearchParams({ ...params, client_id: this.config.clientId }).toString();
    let res;
    try {
      res = await this.transport(this.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': this.config.userAgent,
        },
        body,
      });
    } catch (err) {
      throw new SatsError(`Could not reach SATS login service (${err.code || 'network error'})`, { code: 'NETWORK' });
    }
    const json = safeJson(res.text);
    if (res.status >= 200 && res.status < 300 && json && json.access_token) {
      return json;
    }
    const code = oauthErrorCode(json);
    if (res.status === 429) {
      throw new SatsError('SATS login is rate limited, retrying later', { code: 'RATE_LIMIT', status: 429 });
    }
    if (res.status === 400 && code === 'invalid_scope') {
      throw new SatsError('Scope not allowed', { code: 'INVALID_SCOPE', status: 400 });
    }
    if (res.status === 400 || res.status === 401) {
      if (params.grant_type === 'refresh_token') {
        throw new SatsAuthError('The SATS session has expired. Repair the device to log in again.', { code: 'SESSION_EXPIRED', status: res.status });
      }
      throw new SatsAuthError('SATS did not accept this member id/e-mail and password.', { code: 'INVALID_CREDENTIALS', status: res.status });
    }
    throw new SatsError(`SATS login failed with HTTP ${res.status}${code ? ` (${code})` : ''}`, { code: 'HTTP', status: res.status });
  }

  _storeTokens(json) {
    const nowMs = this.now();
    const claims = decodeJwtPayload(json.access_token) || {};
    let expiresAt = Number(json.expires_in) > 0 ? nowMs + Number(json.expires_in) * 1000 : null;
    if (!expiresAt && Number(claims.exp) > 0) expiresAt = Number(claims.exp) * 1000;
    if (!expiresAt) expiresAt = nowMs + 5 * 60 * 1000;
    const previousRefresh = this._tokens && this._tokens.refreshToken;
    this._tokens = {
      accessToken: json.access_token,
      // Keycloak may or may not rotate the refresh token; keep the old one if none is returned.
      refreshToken: json.refresh_token || previousRefresh || null,
      expiresAt,
      refreshExpiresAt: Number(json.refresh_expires_in) > 0 ? nowMs + Number(json.refresh_expires_in) * 1000 : null,
      claims,
    };
    if (json.refresh_token && json.refresh_token !== previousRefresh) {
      this.onRefreshToken(json.refresh_token);
    }
  }

  /**
   * Log in with the member's own credentials (pairing / repair only).
   * Asks for `offline_access` first so the refresh token outlives the SSO session;
   * falls back to the app's plain request if the client may not use that scope.
   * The password is not stored anywhere.
   */
  async login(username, password) {
    if (!username || !password) {
      throw new SatsAuthError('Enter your SATS member id or e-mail and password.', { code: 'NO_CREDENTIALS' });
    }
    const params = {
      grant_type: 'password',
      username: String(username).trim(),
      password: String(password),
    };
    let json;
    try {
      json = await this._tokenRequest({ ...params, scope: 'openid offline_access' });
    } catch (err) {
      if (err.code !== 'INVALID_SCOPE') throw err;
      json = await this._tokenRequest(params);
    }
    this._tokens = null;
    this._storeTokens(json);
    if (!this._tokens.refreshToken) {
      throw new SatsError('SATS did not return a refresh token', { code: 'NO_REFRESH_TOKEN' });
    }
    return { memberKey: this.memberKey(), refreshToken: this._tokens.refreshToken };
  }

  async _refresh() {
    const json = await this._tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: this._tokens.refreshToken,
    });
    this._storeTokens(json);
  }

  /** Make sure we hold a usable access token, renewing it with the refresh token. */
  async ensureAccessToken({ force = false } = {}) {
    const t = this._tokens;
    if (!t || !t.refreshToken) {
      throw new SatsAuthError('Not logged in to SATS. Repair the device to log in.', { code: 'NO_SESSION' });
    }
    if (!force && t.accessToken && t.expiresAt - 60 * 1000 > this.now()) return t.accessToken;
    try {
      await this._refresh();
    } catch (err) {
      if (err instanceof SatsAuthError) this._tokens = null; // session is gone for good
      throw err;
    }
    return this._tokens.accessToken;
  }

  _segmentCandidates() {
    if (this.pathSegment) return [this.pathSegment];
    if (this.resolvedSegment) return [this.resolvedSegment];
    // Observed live: the segment is the member's own exerpMemberId (externalId also works).
    // A wrong segment returns 500, not 404, so only the member's own ids are tried.
    const c = this.claims;
    const list = [c.exerpMemberId, c.externalId, c.memberId];
    return [...new Set(list.filter((v) => typeof v === 'string' || typeof v === 'number').map(String))];
  }

  /**
   * Diagnostics for an unknown API layout, run once with the member's own token.
   * Returns HTTP status codes and JSON key names only (shapeOf), never values.
   * Segments taken from the member's own token claims are shown as placeholders.
   */
  async diagnose() {
    await this.ensureAccessToken();
    const c = this.claims;
    const m = String(this.market || 'se');
    const personal = new Map();
    for (const k of ['exerpMemberId', 'externalId', 'sub']) {
      if (c[k] !== undefined && c[k] !== null) personal.set(String(c[k]), `<${k}>`);
    }
    const mask = (path) => {
      let out = path;
      for (const [value, label] of personal) out = out.split(encodeURIComponent(value)).join(label);
      return out;
    };
    // The SATS app builds "/v2/{segment}/upcoming-workouts" on top of a feature base path.
    // Observed live (2026-11-27): it is "/profile". The sweep is kept in case SATS moves it.
    const prefixes = ['', '/profile', '/activities', '/social/v2/friends', '/group-exercises', '/group-exercises/participation',
      '/booking', '/booking/v3/gx', '/v3/group-exercises', '/personal-training', '/boot-camp/sessions', '/smart-training', '/wallet'];
    const segments = [m, 'sats', 'me', ...personal.keys()];
    const paths = [];
    for (const prefix of prefixes) {
      for (const seg of segments) paths.push(`${prefix}/v2/${encodeURIComponent(seg)}/upcoming-workouts`);
      paths.push(`${prefix}/upcoming-workouts`);
    }
    paths.push('/v2/booking-landing-page', '/v2/home', '/home', '/v2/upcoming', '/upcoming', '/v2/discover', '/discover',
      '/profile/v2', '/v2/profile', '/v3/profile', '/booking/v3/gx/upcoming', '/v3/group-exercises/upcoming');

    const requests = [];
    for (const path of [...new Set(paths)]) {
      let status;
      let shape = '';
      try {
        const res = await this._apiGet(path);
        status = res.status;
        if (status >= 200 && status < 300) shape = shapeOf(safeJson(res.text));
      } catch (err) {
        status = err.status || err.code || 'error';
      }
      requests.push({ path: mask(path), status, shape });
      if (this.config.diagnosticDelayMs > 0) await new Promise((r) => setTimeout(r, this.config.diagnosticDelayMs));
    }
    const HINT_CLAIMS = ['azp', 'scope', 'market', 'brand', 'country', 'locale', 'realm_access'];
    const claimHints = {};
    for (const k of HINT_CLAIMS) if (c[k] !== undefined) claimHints[k] = c[k];
    return { claimNames: Object.keys(c).sort(), claimHints, requests };
  }


  async _apiGet(path) {
    const url = `${this.config.apiBase}${path}`;
    const doRequest = async (token) => {
      try {
        return await this.transport(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'Accept-Language': LANGUAGE_BY_MARKET[this.market] || 'sv-SE',
            'User-Agent': this.config.userAgent,
          },
        });
      } catch (err) {
        throw new SatsError(`Could not reach SATS API (${err.code || 'network error'})`, { code: 'NETWORK' });
      }
    };
    let res = await doRequest(await this.ensureAccessToken());
    if (res.status === 401) {
      // Access token revoked or expired early: renew and retry once.
      res = await doRequest(await this.ensureAccessToken({ force: true }));
      if (res.status === 401) {
        throw new SatsError('SATS API refused the access token', { code: 'API_UNAUTHORIZED', status: 401 });
      }
    }
    return res;
  }

  /**
   * GET the member's upcoming workouts. Returns the parsed JSON body.
   * The {segment} is the member's own id from the access token (observed live,
   * docs/sats-api.md). Unless it was configured, the first candidate the API
   * accepts is remembered.
   */
  async getUpcomingWorkouts() {
    await this.ensureAccessToken();
    const candidates = this._segmentCandidates();
    let lastStatus = null;
    for (const segment of candidates) {
      const path = this.config.upcomingPath.replace('{segment}', encodeURIComponent(segment));
      const res = await this._apiGet(path);
      if (res.status >= 200 && res.status < 300) {
        const json = safeJson(res.text);
        if (json === null) throw new SatsError('SATS API returned a response that is not JSON', { code: 'BAD_RESPONSE', status: res.status });
        this.resolvedSegment = segment;
        return json;
      }
      lastStatus = res.status;
      if (res.status === 429) throw new SatsError('SATS API is rate limited, retrying later', { code: 'RATE_LIMIT', status: 429 });
      if (res.status >= 500) throw new SatsError(`SATS API error HTTP ${res.status}`, { code: 'HTTP', status: res.status });
      if (res.status !== 404 && res.status !== 400 && res.status !== 403) {
        throw new SatsError(`SATS API returned HTTP ${res.status}`, { code: 'HTTP', status: res.status });
      }
      // 400/403/404: try the next candidate segment.
    }
    throw new SatsError(
      `No upcoming-workouts endpoint accepted the request (last HTTP ${lastStatus}). Set "API path segment" in the device settings; see docs/sats-api.md.`,
      { code: 'ENDPOINT_NOT_FOUND', status: lastStatus },
    );
  }
}

const TYPE_VALUE = /^[A-Za-z][A-Za-z0-9_.-]{0,59}$/;
const ID_LIKE_KEY = /^(\d+|[0-9a-f-]{16,}|\d{4}-\d{2}-\d{2}.*|.*@.*)$/i;

// Keys whose values are short enums (booking state, item type), not personal data.
// Deliberately not generic keys such as `state` or `status`: elsewhere those can hold e.g. a region name.
const ENUM_KEYS = new Set(['type', '@type', 'bookingState', 'participationState', 'memberParticipationState']);
// Lists that may describe other people or other bookings: key names only, no enum values either.
const KEYS_ONLY = new Set(['followingBookings', 'followeesBookings', 'followeesActivities', 'suggestedFollowees', 'friends']);

/**
 * Structure of a JSON value with key names only, e.g. `{items:[3]{id,name,startTime}}`.
 * No values are included, except short enum values of ENUM_KEYS (e.g. `type=upcoming-group-exercise`).
 * Keys that look like ids, dates or e-mail addresses are masked.
 * @param {*} value
 * @param {object} [opts]
 * @param {number} [opts.maxDepth=4] Nesting depth shown before eliding with `{…}`.
 */
function shapeOf(value, { maxDepth = 4 } = {}) {
  const walk = (v, depth, enums) => {
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) {
      const objects = v.filter((o) => o !== null && typeof o === 'object' && !Array.isArray(o));
      if (!objects.length || depth >= maxDepth) return `[${v.length}]`;
      // Show each distinct item shape (e.g. a list of differently typed items), at most 8.
      const shapes = [...new Set(objects.map((o) => walk(o, depth + 1, enums)))];
      const shown = shapes.slice(0, 8).join('|') + (shapes.length > 8 ? '|…' : '');
      return `[${v.length}]${shown}`;
    }
    if (typeof v === 'object') {
      if (depth >= maxDepth) return '{…}';
      const keys = Object.keys(v);
      const parts = keys.slice(0, 30).map((k) => {
        const name = ID_LIKE_KEY.test(k) ? '<key>' : k;
        const child = v[k];
        if (enums && ENUM_KEYS.has(k) && typeof child === 'string' && TYPE_VALUE.test(child)) return `${name}=${child}`;
        return child !== null && typeof child === 'object'
          ? `${name}:${walk(child, depth + 1, enums && !KEYS_ONLY.has(k))}`
          : name;
      });
      if (keys.length > 30) parts.push(`…+${keys.length - 30}`);
      return `{${parts.join(',')}}`;
    }
    return typeof v;
  };
  return walk(value, 0, true);
}

module.exports = {
  shapeOf,
  SatsClient,
  SatsError,
  SatsAuthError,
  decodeJwtPayload,
  DEFAULTS,
};
