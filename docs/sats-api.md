# SATS member API: reverse-engineering notes

> **Unofficial.** SATS publishes no documentation for this API. Everything here was
> pieced together from public evidence and may change without notice. Each fact has
> a source and a status:
>
> - **Observed**: seen in a live, unauthenticated HTTP exchange.
> - **Observed (live)**: seen with a real member login, run by the account holder on their own Homey
>   with `homey app run` (S7). Only HTTP status codes, JSON key names and booking-state enum values
>   were logged; no personal values, tokens or real bookings were recorded or are reproduced here.
> - **From app**: read from the public SATS Android app's code by static inspection. Not exercised against the live API.
> - **Unverified**: an assumption the code relies on. Nobody has checked it with a real login yet.

Research date: 2026-11-27. Live verification: 2026-11-27 (one Swedish member account).

## Sources

| # | Source | What it gave |
|---|--------|--------------|
| S1 | `GET https://auth.satsgroup.com/realms/sats/.well-known/openid-configuration` | Identity provider (Keycloak) endpoints, grant types, scopes |
| S2 | Following redirects from `https://www.sats.se/mina-sidor` without logging in | Web login flow (`sats-web` client, PKCE), login form fields |
| S3 | `https://www.sats.se/` and its bundles `/static-files/client.*.js`, `/static-files/vendor.*.js` | Marketing site only: Contentful CMS, Adyen, Mapbox. No member-API calls in the public bundles |
| S4 | SATS Android app `com.healthfitnessnordic.gxbooking`, version 2026.10.22 (build 5262), signing certificate O=Health & Fitness Nordic | Token request parameters, API base URL, upcoming-workouts path. The APK was the publicly distributed build from a public mirror; its v2/v3 signature was checked. Only strings and DTO names were inspected statically. The app was never run. The inspection stopped before every detail was resolved (see *Open questions*) |
| S5 | Unauthenticated `GET`s to `https://api.sats.com/sats-mab-api/...` | Base URL is live; auth is enforced before routing |
| S6 | Open-source clients on GitHub: `lindmik/sats-api` (2016), `lindmik/android-sats-api` (2017), `eripe970/sats-auto-booking` (2014, empty) | Only a legacy, unauthenticated class-schedule API, now gone |
| S7 | This Homey app run live with the account holder's own login (2026-11-27): the one-off diagnostics sweep (`SatsClient.diagnose()`, about 100 GETs) and the bookings poll, which logs the response's key names once per app start | Login, token scope and claim names, the real bookings path and response shape, waiting-list state and position |

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
- The app sends no `client_secret` and no `scope`, so `memberapp-android` looks like a public client: **from app**. Keycloak accepts the request from the Homey (Node.js, no extra headers, no client secret): **Observed (live)**, 2026-11-27.
- What `username` accepts: the Keycloak login page labels the field "Användarnamn eller e-post" (*username or e-mail*) (S2). Whether a SATS member number works there, as well as an e-mail, is **unverified**.

Response (S4 DTO `com.sats.data.auth.remote.dtos.OAuthTokensDto`). The app reads only two fields:

```json
{ "access_token": "<JWT>", "refresh_token": "<opaque or JWT>" }
```

A standard Keycloak response also carries `expires_in`, `refresh_expires_in`, `token_type` and `scope`. The Homey app uses `expires_in` when present. Otherwise it falls back to the JWT `exp` claim, then to 5 minutes. Lifetimes are **unverified**.

**What the Homey app sends that the mobile app doesn't:** `scope=openid offline_access`. The realm advertises `offline_access` (S1). If granted, Keycloak issues an *offline* refresh token that survives SSO-session expiry. That matters because the Homey app stores **only the refresh token** and discards the password. If Keycloak answers `invalid_scope`, the app retries once without `scope`, exactly like the mobile app.

- `memberapp-android` may use `offline_access`: the access token's `scope` claim is `openid offline_access subscriptions profile externalId email exerpMemberId` and `azp` is `memberapp-android`. **Observed (live)**, 2026-11-27.
- Access-token claim names: `acr, aud, azp, email, email_verified, exerpMemberId, exp, externalId, family_name, given_name, iat, iss, jti, name, preferred_username, scope, sid, sub, subscriptions, typ`. **Observed (live)**. There is no market/brand/country claim.
- How long the offline refresh token actually lives is **unverified**.

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
| Base URL | `https://api.sats.com/sats-mab-api` | From app (S4). Observed live (S5): `GET /sats-mab-api` returns 200 `Healthier and happier`. With a member token: **Observed (live)** (S7) |
| Auth | `Authorization: Bearer <access_token>` | Every unauthenticated path returns 401 (S5). The Keycloak access token works as is; no extra headers are needed beyond `Accept`, `Accept-Language` and `User-Agent`: **Observed (live)** (S7) |
| 401 body | `{"message":"Unauthorized access: /<path>.","userMessage":"...","traceId":"..."}` | Observed (S5) |

S5 also showed that **any** path, including nonsense ones, gets 401 without a token. So nobody can confirm without logging in which paths actually exist.

### Upcoming booked workouts (used by this Homey app)

```http
GET https://api.sats.com/sats-mab-api/profile/v2/{exerpMemberId}/upcoming-workouts
Authorization: Bearer <access_token>
Accept: application/json
```

- The app builds `"/v2/" + {segment} + "/upcoming-workouts"` on top of a feature base path (**from app**, S4). The base path is **`/profile`** and `{segment}` is the member's own **`exerpMemberId`** claim from the access token. The `externalId` claim works too. **Observed (live)**, 2026-11-27 (S7).
- A wrong segment (`se`, `sats`, `me`, the `sub` claim) under `/profile/v2/` returns **500**, not 404. `/profile/v2` and `/profile/upcoming-workouts` also return 500. Without the `/profile` prefix, every variant returned 404. **Observed (live)**.
- The Homey app therefore tries `exerpMemberId`, then `externalId`, and remembers the first one that works. It stops at a 5xx instead of guessing further. *Advanced → API path segment* in the device settings still overrides it, for troubleshooting only.

Response shape, **Observed (live)** 2026-11-27. All values below are invented; only key names, `type` and `bookingState` enum values come from the live response:

```json
{
  "workouts": [
    {
      "type": "upcoming-group-exercise",
      "content": {
        "id": "gx-1001",
        "name": "Strength 45",
        "startTime": { "timeZone": "Europe/Stockholm", "dateTime": "2026-11-30T05:30:00Z" },
        "durationInMinutes": 45,
        "club": { "name": "Example Centre North", "id": "c-1", "fullName": "Example Centre North (Example Town)" },
        "instructorName": "Instructor A",
        "bookingInfo": {
          "capacity": 30,
          "bookedCount": 30,
          "waitingListCount": 2,
          "memberBookingInfo": {
            "participationId": "p-0001",
            "bookingState": "Booked",
            "waitingListPosition": null
          }
        },
        "followingBookings": []
      }
    }
  ]
}
```

| Item | Status |
|------|--------|
| Envelope `{ workouts: [ { type, content } ] }` | **Observed (live)** |
| `type` = `upcoming-group-exercise` (the only type in the live sample, 3 items) | **Observed (live)**. `upcoming-pt-session`, `upcoming-boot-camp` and `upcoming-scheduled-workout` are strings in the app (S4) and were **not seen live** |
| `startTime` is an object `{ timeZone, dateTime }`. `dateTime` has the form `YYYY-MM-DDTHH:MM:SSZ` (UTC, trailing `Z`) and `timeZone` is an IANA zone name | **Observed (live)**: format seen digit-masked, values not logged |
| No end time; `durationInMinutes` instead | **Observed (live)** |
| `club` has only `name`, `id` and `fullName`: no address, city, country or coordinates | **Observed (live)** |
| `instructorName` is a plain string | **Observed (live)** |
| `bookingInfo.{capacity, bookedCount, waitingListCount}` describe the class; `bookingInfo.memberBookingInfo.{participationId, bookingState, waitingListPosition}` describe the member's own booking | **Observed (live)** |
| `bookingState` values `Booked` and `BookedOnWaitingList` | **Observed (live)** |
| `followingBookings` (an empty list in all three items) | **Observed (live)**. Its meaning is **unverified** |
| How cancelled classes appear (a state, or just gone) | **Unverified** |

How `lib/bookings.js` reads this:

- It takes any object with a start time (`startTime`, `start`, ...: an ISO string, an epoch number or a `{ dateTime, timeZone }` object) and a name (`name`, `title`, ...), on the object itself or one level down (e.g. `content`).
- A `dateTime` with an offset or `Z` is absolute. Without one, it is wall-clock time in the given `timeZone`, or in the Homey's zone if that's missing or unknown.
- The end is `startTime + durationInMinutes` when there's no end field.
- The centre comes from `club` (`name`). Since the API gives no coordinates, the centre name is geocoded (see below).
- Items whose type matches `scheduled-workout` (self-planned workouts, not bookings) are skipped.
- Items whose booking state contains "cancel" are flagged as cancelled. A class that was upcoming and then disappears from the list is also reported as cancelled. If 3 or more upcoming classes vanish at once and nothing is left, that is treated as a probable format change and not reported.
- On the first successful fetch after each app start, the app logs the response's key names, the booking-state enums and the digit-masked time format, never values. Every poll logs counts of bookings, waiting-list places and booking states. That makes a future format change visible without anyone sharing data.

### Waiting list and positions

| Item | Evidence | Status |
|------|----------|--------|
| The member app models waiting-list places | DTO names `GxBookingStateDto.BookedOnWaitingList`, `UpcomingOnWaitingListDto`, `MemberBookingInfoDto` (S4) | From app |
| Waiting-list places are part of `upcoming-workouts` | One of the three live items had `bookingInfo.memberBookingInfo.bookingState = BookedOnWaitingList`; the account holder confirmed they are on that waiting list | **Observed (live)**, 2026-11-27 |
| The member's position is `bookingInfo.memberBookingInfo.waitingListPosition`, a positive number for a waiting-list place | Parsed as a number for that item, and shown on the device as the best waiting-list position, which the account holder confirmed | **Observed (live)**, 2026-11-27 |
| `waitingListPosition` on a `Booked` item | The key is present. Its value isn't logged; the app ignores it whenever the state is `Booked` | Observed (live): key present |
| `bookingInfo.waitingListCount` is the length of the class's whole queue, not the member's position | Name only | **Unverified** |
| Moving from the waiting list to booked, and position changes between polls | Not seen happen live yet | **Unverified** |

How the app decides:

- An explicit booking state (`bookingState`, `participationState`, `memberParticipationState`, `state`, `status`, also inside `bookingInfo` / `memberBookingInfo`) decides. It is a waiting-list place when the state contains "wait", as `BookedOnWaitingList` does. A position number only counts when there is no state at all.
- The position is the first positive integer in `waitingListPosition`, `waitlistPosition`, `positionInWaitingList`, `waitingListNumber`, `queuePosition` or `position`, on the booking or its (nested) booking-info objects.

Transitions are detected by comparing two polls, matched on booking id + start time:

- waiting list → booked: *moved to booked*
- position changed, both known: *position changed*
- booked or waiting list → marked cancelled: *class cancelled*, `cancelled_by = SATS`
- booked or waiting list → gone: *class cancelled*, `cancelled_by = unknown`

### Centre location (for "within N km of home")

The live bookings response has **no** centre coordinates or address, only `club.name`, `club.id` and `club.fullName`: **Observed (live)**, 2026-11-27. So in practice the app geocodes the centre name. The parser still reads coordinates and an address if SATS ever adds them:

- Coordinates: `latitude`/`lat` + `longitude`/`lon`/`lng` on the centre object, or nested in `geoLocation`, `coordinates`, `position`, `location` or `address`.
- Address: `address.street`/`streetAddress`, `postalCode`, `city`, `country`. City and country are also read from the centre or booking object.

When there are no coordinates, the app geocodes the centre with OpenStreetMap Nominatim (`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&q=...`). It sends the street address if known, otherwise "name, city, country". It identifies itself with a `User-Agent`, makes at most 1 request per second, and caches each centre (misses for 7 days). Geocoded city/country only fill gaps; API values always win. Users can turn geocoding off per device. The Homey's own location is never sent anywhere.

### Other paths seen in the app (S4, not used)

These are all relative to the base URL above and all **from app**: `/profile`, `/v3/group-exercises`, `/booking/v3/gx`, `/group-exercises/participation`, `/v2/group-exercise-types`, `/booking-restrictions`, `/boot-camp/sessions`, `/personal-training`, `/activities`, `/social/v2/friends`.

Results of the live diagnostics sweep (GET only, member token, 2026-11-27), status codes only. About 100 paths were tried and 88 returned 404:

| Path | Status |
|------|--------|
| `/profile/v2/{exerpMemberId}/upcoming-workouts`, `/profile/v2/{externalId}/upcoming-workouts` | 200 (the bookings, above) |
| `/v2/booking-landing-page` | 200: `{ extraLinks[], items[] }` with item types `GroupExerciseSearchCollection`, `BookGroupExercises`, `Recommendations`, `GroupExerciseOffering`, `FeaturedPersonalTrainers` |
| `/discover` | 200: `{ items[] }` with item types `followees-bookings`, `followees-suggestions`, `followees-activities`, `workout-programs`, `editorial-content`, `navigation-buttons`. These hold data about *other* members; this app doesn't use them |
| `/profile/v2/{se,sats,me,sub}/upcoming-workouts`, `/profile/v2`, `/profile/upcoming-workouts`, `/social/v2/friends/upcoming-workouts`, `/group-exercises/upcoming-workouts`, `/v3/group-exercises/upcoming-workouts`, `/v3/group-exercises/upcoming`, `/boot-camp/sessions/upcoming-workouts` | 500: the route exists, but the parameters are wrong |
| `/group-exercises/participation` (GET, no parameters) | 500 |
| `/v2/{anything}/upcoming-workouts` at the API root, and the other prefixes | 404 |

### Unrelated or legacy hosts

- `hfnapi.sats.com`: resolves to an Azure API Management front door and returns 404 at `/` (observed). Its role is unknown and it isn't used.
- `https://www.elixia.fi/sats-api/fi/classes?centers=<id>&dates=<yyyyMMdd>` and `/sats-api/fi/centers`: an old, unauthenticated, public class-schedule API used by `lindmik/android-sats-api` (S6). The equivalent `https://www.sats.se/sats-api/se/centers` now returns 404 (observed). It had no bookings anyway.

## Open questions: what has NOT been verified against the real API

Settled live on 2026-11-27 (see above): the password grant from a non-app client, the `offline_access` scope, the bookings path and segment, the response shape and time format, extra headers (none needed), whether centre coordinates are returned (no), and whether waiting-list places and positions are in `upcoming-workouts` (yes).

Still open:

1. Whether `username` accepts a member number as well as an e-mail address.
2. Token lifetimes, and how long the offline refresh token lives and whether it rotates.
3. Rate limits and account-lockout thresholds. Keycloak brute-force protection may lock an account after repeated failed logins. The Homey app therefore logs in only when the user submits the pairing/repair form, never automatically.
4. Whether cancelled classes are marked as cancelled in the list or simply disappear, and the exact state value if marked.
5. How PT sessions, boot camps and self-planned workouts appear (only `upcoming-group-exercise` was seen).
6. The meaning of `followingBookings`, and how promotion from the waiting list and position changes show up between polls.
7. Whether other markets (Norway, Denmark, Finland) use the same path. Only one Swedish account was checked; the path carries no market code.

## How to verify (for whoever runs the app with a real account)

1. Install the app (see README) and pair a *SATS member* device with your own account. A failed login shows up in the pairing view.
2. Run it in development mode with `homey app run` and watch the log. It reports counts, HTTP status codes, error codes, JSON key names and booking-state enums only, never the password, tokens or response values.
3. The device shows the state: the next class on the tile, a warning with the last error (e.g. *endpoint not found* plus HTTP status), or *unavailable* when the session expired. If the bookings path stops working, the app runs the diagnostics sweep once per app start and logs one line per non-404 path with its key names.
4. If you capture traffic from your own phone to investigate an API change, save captures under `captures/`. That folder is in `.gitignore`. Redact before sharing anything: captures contain your tokens and personal data. Never commit them.

Please contribute findings (shape, segment, headers) as **redacted** descriptions or invented examples, never as real captured responses.
