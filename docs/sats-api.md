# SATS member API: reverse-engineering notes

> **Unofficial.** SATS publishes no documentation for this API. Everything here was
> pieced together from public evidence and may change without notice. Each fact has
> a source and a status:
>
> - **Observed**: seen in a live, unauthenticated HTTP exchange.
> - **From app**: read from the public SATS Android app's code by static inspection. Not exercised against the live API.
> - **Unverified**: an assumption the code relies on. Nobody has checked it with a real login yet.
>
> No real credentials were used. No authenticated request has been made while writing this.

Research date: 2026-11-27.

## Sources

| # | Source | What it gave |
|---|--------|--------------|
| S1 | `GET https://auth.satsgroup.com/realms/sats/.well-known/openid-configuration` | Identity provider (Keycloak) endpoints, grant types, scopes |
| S2 | Following redirects from `https://www.sats.se/mina-sidor` without logging in | Web login flow (`sats-web` client, PKCE), login form fields |
| S3 | `https://www.sats.se/` and its bundles `/static-files/client.*.js`, `/static-files/vendor.*.js` | Marketing site only: Contentful CMS, Adyen, Mapbox. No member-API calls in the public bundles |
| S4 | SATS Android app `com.healthfitnessnordic.gxbooking`, version 2026.10.22 (build 5262), signing certificate O=Health & Fitness Nordic | Token request parameters, API base URL, upcoming-workouts path. The APK was the publicly distributed build from a public mirror; its v2/v3 signature was checked. Only strings and DTO names were inspected statically. The app was never run. The inspection stopped before every detail was resolved (see *Open questions*) |
| S5 | Unauthenticated `GET`s to `https://api.sats.com/sats-mab-api/...` | Base URL is live; auth is enforced before routing |
| S6 | Open-source clients on GitHub: `lindmik/sats-api` (2016), `lindmik/android-sats-api` (2017), `eripe970/sats-auto-booking` (2014, empty) | Only a legacy, unauthenticated class-schedule API, now gone |

## Authentication

SATS Group runs a Keycloak realm at `https://auth.satsgroup.com/realms/sats` (S1).

| Item | Value | Status |
|------|-------|--------|
| Issuer | `https://auth.satsgroup.com/realms/sats` | Observed (S1) |
| Token endpoint | `https://auth.satsgroup.com/realms/sats/protocol/openid-connect/token` | Observed (S1); same path built by the app (S4) |
| Grant types offered by the realm | include `password`, `refresh_token`, `authorization_code` | Observed (S1) |
| Scopes offered | include `openid`, `profile`, `email`, `offline_access`, `exerpMemberId`, `externalId`, `subscriptions` | Observed (S1). `exerpMemberId` suggests the member system behind it is Exerp |
| Test environment | `https://auth-test.satsgroup.com`, `https://test-api.sats.com` | From app (S4). Not used |

### Mobile app login: resource owner password grant (used by this Homey app)

The Android app logs in with a plain OAuth2 password grant (S4):

```http
POST /realms/sats/protocol/openid-connect/token HTTP/1.1
Host: auth.satsgroup.com
Content-Type: application/x-www-form-urlencoded

grant_type=password&username=<user id or e-mail>&password=<password>&client_id=memberapp-android
```

- Parameters `grant_type`, `username`, `password`, `client_id=memberapp-android`: **from app**.
- The app sends no `client_secret` and no `scope`, so `memberapp-android` looks like a public client: **from app**. Whether Keycloak accepts the request from a non-Android client is **unverified**.
- What `username` accepts: the Keycloak login page labels the field "Användarnamn eller e-post" (*username or e-mail*) (S2). Whether a SATS member number works there, as well as an e-mail, is **unverified**.

Response (S4 DTO `com.sats.data.auth.remote.dtos.OAuthTokensDto`). The app reads only two fields:

```json
{ "access_token": "<JWT>", "refresh_token": "<opaque or JWT>" }
```

A standard Keycloak response also carries `expires_in`, `refresh_expires_in`, `token_type` and `scope`. The Homey app uses `expires_in` when present. Otherwise it falls back to the JWT `exp` claim, then to 5 minutes. Lifetimes are **unverified**.

**What the Homey app sends that the mobile app doesn't:** `scope=openid offline_access`. The realm advertises `offline_access` (S1). If granted, Keycloak issues an *offline* refresh token that survives SSO-session expiry. That matters because the Homey app stores **only the refresh token** and discards the password. If Keycloak answers `invalid_scope`, the app retries once without `scope`, exactly like the mobile app. Whether `memberapp-android` may use `offline_access`, and how long either kind of refresh token lives, is **unverified**.

### Refresh

```http
POST /realms/sats/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token=<refresh token>&client_id=memberapp-android
```

The parameters are **from app** (S4). The response has the same shape as the login response and may contain a new (rotated) `refresh_token`. The Homey app saves every new one to the device store. When a refresh fails with 400/401, the session is gone: the device goes unavailable and asks the user to *Repair* it, which logs in again. There is no stored password to fall back on.

### Web login (not used here, for reference)

`https://www.sats.se/mina-sidor` → `https://min.sats.se/concept/root` → `https://min.sats.se/api/sats-group-auth-log-in?redirect=/` →
`https://auth.satsgroup.com/realms/sats/protocol/openid-connect/auth?client_id=sats-web&response_type=code&scope=profile&code_challenge_method=S256&redirect_uri=https://min.sats.se/api/sats-group-auth-log-in-return&market=se&ui_locales=sv&...` (**observed**, S2).

That is an authorization-code + PKCE flow handled by the `min.sats.se` backend, which keeps the tokens server side in cookies (`.SATS_GROUP_FLOW*`). The member pages are behind that login, so their JavaScript and API calls can't be seen without an account. The Homey app therefore copies the mobile app's flow instead.

## Member API

| Item | Value | Status |
|------|-------|--------|
| Base URL | `https://api.sats.com/sats-mab-api` | From app (S4). Observed live (S5): `GET /sats-mab-api` returns 200 `Healthier and happier` |
| Auth | `Authorization: Bearer <access_token>` | Standard for Keycloak. Every unauthenticated path returns 401 (S5) |
| 401 body | `{"message":"Unauthorized access: /<path>.","userMessage":"...","traceId":"..."}` | Observed (S5) |

S5 also showed that **any** path, including nonsense ones, gets 401 without a token. So nobody can confirm without logging in which paths actually exist.

### Upcoming booked workouts (used by this Homey app)

```http
GET https://api.sats.com/sats-mab-api/v2/{segment}/upcoming-workouts
Authorization: Bearer <access_token>
Accept: application/json
```

- The path `"/v2/" + {segment} + "/upcoming-workouts"` comes from the app's code: **from app** (S4).
- `{segment}` is a value the app fills in at runtime. It's typed as a small value object with a `getValue()` and has two implementations. Its actual value was **not determined**. It might be a market/brand code (`se`, `sats`, ...) or a member identifier. **Unverified.**
  - The Homey app works around this. After login it tries, in order: the selected market (`se`/`no`/`dk`/`fi`), `sats`, then the `exerpMemberId`, `memberId`, `externalId` and `sub` claims from the user's own access token. It keeps the first one that returns 2xx and remembers it. The user can override the value under *Advanced → API path segment* in the device settings.
- The response JSON shape is **unverified**. The app has DTOs named under `com.sats.data.groupexercises.remote.dtos` (`GroupExerciseDto`, `GxBookingInfoDto`, `MemberBookingInfoDto`, `GxBookingStateDto.BookedOnWaitingList` ...). It also contains the strings `upcoming-group-exercise`, `upcoming-pt-session`, `upcoming-boot-camp` and `upcoming-scheduled-workout`, which might be polymorphic `type` values (S4). The Homey app's parser (`lib/bookings.js`) is therefore schema-tolerant:
  - It takes any object with a start-time field (`startTime`, `start`, `startsAt`, ...) and a name (`name`, `title`, ...), on the object itself or one level down.
  - Centre comes from `club`/`center`/`location`... (a string or an object with `name`).
  - Items whose type matches `scheduled-workout` (self-planned workouts, not bookings) are skipped.
  - Waiting-list places are skipped (any state containing "wait", or `waitingListPosition > 0`).
  - Timestamps with an offset are absolute. Timestamps without one are read as wall-clock time in the Homey's time zone.
  - Items whose booking state contains "cancel" are flagged as cancelled. A class that was upcoming and then disappears from the list is also reported as cancelled. If 3 or more upcoming classes vanish at once and nothing is left, that is treated as a probable format change and not reported.

### Centre location (for "within N km of home")

Whether the bookings response includes centre coordinates or an address is **unverified**. The parser reads both if present:

- Coordinates: `latitude`/`lat` + `longitude`/`lon`/`lng` on the centre object, or nested in `geoLocation`, `coordinates`, `position`, `location` or `address`.
- Address: `address.street`/`streetAddress`, `postalCode`, `city`, `country`. City and country are also read from the centre or booking object.

When there are no coordinates, the app geocodes the centre with OpenStreetMap Nominatim (`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&q=...`). It sends the street address if known, otherwise "name, city, country". It identifies itself with a `User-Agent`, makes at most 1 request per second, and caches each centre (misses for 7 days). Geocoded city/country only fill gaps; API values always win. Users can turn geocoding off per device. The Homey's own location is never sent anywhere.

### Other paths seen in the app (S4, not used)

These are all relative to the base URL above and all **from app**: `/profile`, `/v3/group-exercises`, `/booking/v3/gx`, `/group-exercises/participation`, `/v2/group-exercise-types`, `/booking-restrictions`, `/boot-camp/sessions`, `/personal-training`, `/activities`, `/social/v2/friends`.

### Unrelated or legacy hosts

- `hfnapi.sats.com`: resolves to an Azure API Management front door and returns 404 at `/` (observed). Its role is unknown and it isn't used.
- `https://www.elixia.fi/sats-api/fi/classes?centers=<id>&dates=<yyyyMMdd>` and `/sats-api/fi/centers`: an old, unauthenticated, public class-schedule API used by `lindmik/android-sats-api` (S6). The equivalent `https://www.sats.se/sats-api/se/centers` now returns 404 (observed). It had no bookings anyway.

## Open questions: what has NOT been verified against the real API

1. Keycloak accepts `grant_type=password` with `client_id=memberapp-android` from a non-app client. Bot protection or extra headers might be required.
2. Whether `username` accepts a member number as well as an e-mail address.
3. The value of `{segment}` in `/v2/{segment}/upcoming-workouts`.
4. The response shape of `upcoming-workouts`: field names, time format (offset or local), and how waiting-list places and PT sessions appear.
5. Any extra headers the API needs (app version, brand, platform, device id). The Homey app sends only `Authorization`, `Accept`, `Accept-Language` and `User-Agent`.
6. Token lifetimes, refresh-token lifetime and rotation, and whether `offline_access` is granted to `memberapp-android`.
7. Rate limits and account-lockout thresholds. Keycloak brute-force protection may lock an account after repeated failed logins. The Homey app therefore logs in only when the user submits the pairing/repair form, never automatically.
8. Whether the bookings response contains centre coordinates, an address, city and country, or only a name.
9. Whether cancelled classes are marked as cancelled in the list or simply disappear.

## How to verify (for whoever runs the app with a real account)

1. Install the app (see README) and pair a *SATS member* device with your own account. A failed login shows up in the pairing view.
2. Run it in development mode with `homey app run` and watch the log. It reports counts, HTTP status codes and error codes only, never the password, tokens or response bodies.
3. The device shows the state: the next class on the tile, a warning with the last error (e.g. *endpoint not found* plus HTTP status), or *unavailable* when the session expired.
4. If you capture traffic from your own phone to work out the real `{segment}` or response shape, save captures under `captures/`. That folder is in `.gitignore`. Redact before sharing anything: captures contain your tokens and personal data. Never commit them.

Please contribute findings (shape, segment, headers) as **redacted** descriptions or invented examples, never as real captured responses.
