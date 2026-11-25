# My Activities (the Strava tab of My Runs)

A local Strava activity browser and the source of My Runs' training totals. Guided API
setup, OAuth, automatic token refresh, paginated activity history, page-local search/sport
filters, individual GPS traces, and activity details. No fake production data.

## Run

My Activities is the second tab of My Runs, part of the Hub project: start the one server
from the project folder (`.venv/bin/python main.py`, see the main README) and open
**http://127.0.0.1:5173/runs/activities/** (the old `/activities/` address redirects here).
Use the canonical `127.0.0.1` address throughout authorization (visiting via
`localhost` redirects you there).

## Hard-code your Strava details (environment variables)

Instead of the setup form, set these before starting the server:

```sh
export STRAVA_CLIENT_ID=12345
export STRAVA_CLIENT_SECRET=...
export STRAVA_REFRESH_TOKEN=...   # must have been granted activity:read_all
.venv/bin/python main.py
```

The first time Strava is needed the server trades the refresh token for working tokens,
saves them locally (Strava rotates the refresh token, so the environment value is only used
once) and signs in with no clicking. The Client ID and Secret alone are also enough: you then
press **Authorize with Strava** once. A refresh token from your API settings page usually has
only the basic `read` scope; one from the OAuth flow with `activity:read_all` is needed. If
Strava rejects it, the page says so. Keep these values out of source files and Git.

## Training stats for My Runs

Press **Sync for training stats** (here, or **Sync Strava** on the Races tab). The first sync
reads your whole history; later syncs read only recent activities, plus a few days back to
catch late edits. A **full** sync request (`POST api/sync` with `{"full": true}`) also removes
activities you deleted on Strava. Syncing stops at 8,000 activities per request, far inside
Strava's limit of 100 requests per 15 minutes.

## Connect your Strava account

1. Select **Set up Strava** in the app.
2. Register an application at <https://www.strava.com/settings/api>.
   Strava's current getting-started guide requires a Strava subscription to
   register. New API apps initially allow only the developer's own account.
3. Use **My Activities** as its name and `http://127.0.0.1:5173` as its website.
   Set **Authorization Callback Domain** to **127.0.0.1**, without a scheme,
   port or path. The full redirect URI is
   `http://127.0.0.1:5173/runs/activities/oauth/callback`. Strava only checks the
   domain, so an application registered for the old port keeps working.
4. Enter the application's **Client ID** and **Client Secret** into the local
   setup form, not into a chat, source file, screenshot or terminal command.
5. Select **Authorize with Strava**, sign in to Strava, and approve **read** and
   **activity:read_all**. The latter includes private activities and privacy-zone
   data. No write permission is requested.

Until you complete these steps, the app displays a real setup state and cannot
retrieve your activities. Access remains subject to Strava's subscription,
application eligibility, rate limits and authorization.

### Use an existing access token

Open **Connection settings → Or connect with an existing access token**.
Enter a Strava **access token**, not a Client Secret or refresh token. No new
login is needed if the token already has `activity:read` or `activity:read_all`.
Only `activity:read_all` includes private activities. The basic `read` token
shown in API settings may not have activity permission; importing it cannot
upgrade its scopes.

The backend validates the token using your athlete endpoint and a one-activity
permission check. It saves only the token and athlete ID, not either response.
Existing connections must be disconnected before replacement. Tokens are never
returned to the browser after saving. Automatic renewal is unavailable for this
mode: import a fresh token when the current one expires or is revoked, or use
OAuth for automatic refresh. A rejected token is removed when detected; no
refresh request is attempted without a refresh token.

### HTTPS certificate errors

If authorization reports a certificate-verification failure, the local Python
server could not establish a trusted HTTPS connection to Strava. This is not
evidence that the Client ID or Secret is wrong. If your network uses an HTTPS
inspection proxy, obtain its trusted CA bundle from your administrator. Set
`SSL_CERT_FILE` to that approved PEM bundle when starting the server, for example:

```sh
SSL_CERT_FILE=/absolute/path/to/approved-ca-bundle.pem .venv/bin/python main.py
```

The bundle should contain the roots required by your network. Do not download
an arbitrary certificate or disable certificate or hostname verification.
Alternatively, place the approved PEM bundle at `data/ca-bundle.pem` for this
app only. It is excluded from Git along with the credential database.
`SSL_CERT_FILE` takes precedence over that local bundle; without either setting,
Python uses its default trust configuration. An invalid configured bundle
stops the request rather than falling back to unverified HTTPS.
Restart the server and begin authorization again: the previous callback code
and authorization state cannot be reused.

## Browsing

- Activities are fetched **live**, 30 at a time, newest first. Use previous/next
  to browse the available history. A full page may be followed by an empty page.
- Search and sport filters apply **only to the loaded page**, not your entire
  account. The interface labels this explicitly.
- Select an activity to fetch its current detailed representation. Summary
  and detailed API responses can expose different fields.
- The detail view shows individual distance, moving/elapsed time, elevation,
  speed/pace, heart rate, calories, power, gear, device and description where
  Strava supplies them. Zero is distinct from unreported data.
- GPS routes use bundled Natural Earth country outlines, with no external
  tiles or street basemap. Pan, zoom or fit the route. Indoor/manual activities
  may have no route.
- Rate-limit errors are displayed, not retried in a loop. The app shows usage
  headers when supplied. Refresh a failed page manually after the limit resets.
- A missing activity is removed from the current page immediately. Revoked or
  invalid authorization clears the displayed data when detected.

## Privacy and scope

Browsing is live: activity and profile responses are sent with `Cache-Control: no-store`
and exist only in the open page's memory. There is no service worker, CSV export,
background synchronization, aggregate analytics or AI integration. Strava itself may
collect API usage data under its policy.

The one thing saved is what you ask for with **Sync for training stats**: a summary of
each activity (id, name, sport, date, distance, moving time, elevation gain) in the
`activities` table of `data/users/<username>/activities.sqlite3`. Routes, heart rate and power
are never saved. My Runs uses these to total your training between races. Disconnecting
deletes them.

The API client credentials, OAuth tokens and connected athlete ID are in the same file;
the session-signing key is in `data/secret.key`. Both are excluded by `.gitignore`. New
database files are created with owner read/write permissions
(`0600`); the file is **not encrypted**. OAuth tokens never go to the frontend.
The browser holds only an HTTP-only, SameSite=Lax signed session cookie for
the OAuth handshake. Authorization state expires after ten minutes and is
single-use. The local server avoids logging OAuth query strings.

Use **Connection settings → Disconnect & delete local connection** to revoke
access on Strava and delete the local API credentials and saved summaries. A written
confirmation appears in the app. If Strava is unreachable, use **Forget local
connection only**, then revoke access at <https://www.strava.com/settings/apps>.

Do not expose this server beyond loopback, use a tunnel, deploy it as a
multi-user service, publish the database, or leave it accessible on a shared
computer. Sign-in is only a 4-digit PIN. The app has no hosted support service;
maintain your own local installation and consult the server terminal for errors.

This is a personal, single-user app that reads only your own data. It is not a statement
of legal approval by Strava; review the current API Agreement and your registered
application's eligibility before use, especially before sharing the app with anyone else.

## Validation

Run `.venv/bin/python -m unittest discover -s tests -t .` from the project folder.

Backend tests use an injected fake Strava transport: no real account, tokens,
activities or API requests are involved. They cover OAuth state, permissions,
token rotation, pagination, response sanitization, rate limits, revocation,
credential deletion and non-persistence of activity data.

For browser-side model tests, run in the browser developer console:

```js
(await import("/static/model-tests.js")).runTests()
```

Tests use synthetic GPS coordinates and activity names, not real athlete data.
Live end-to-end authorization must be verified by the account owner after API
registration. Never share real account responses or secrets with an AI tool.

## References

- [API reference](https://developers.strava.com/docs/reference/)
- [Authentication](https://developers.strava.com/docs/authentication/)
- [Getting started](https://developers.strava.com/docs/getting-started/)
- [Rate limits](https://developers.strava.com/docs/rate-limits/)
- [API policy](https://www.strava.com/legal/api_policy)
- [API agreement](https://www.strava.com/legal/api)
- [Brand guidelines](https://developers.strava.com/guidelines/)

Country outlines: Natural Earth (public domain).
