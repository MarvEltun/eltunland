# Hub

All my apps in one project, served by **one server**.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python main.py
```

On the laptop, open **http://127.0.0.1:5173**. For iPhone, Hub also serves HTTPS on port `5174`
using the laptop's `.local` hostname. Set `HUB_PORT`, `HUB_HTTPS_PORT`, `HUB_HOSTNAME`, or
`HUB_BIND` to change those defaults.

| Address | App | What it is |
|---|---|---|
| `/` | Home | Personal greeting, next race / weekly goal, launcher |
| `/roam/` | Roam | Travel map, bucket list, trip journal, flights, stadiums |
| `/runs/` | My Runs: Races | Race log with the training you did between races |
| `/runs/activities/` | My Runs: Activities | Live Strava browser; sync feeds the training totals |
| `/fitness/` | myFitness | Workout log, weekly minutes goal, streak, 8-week chart |
| `/fuad/` | MyFuad | Car expenses, fuel economy, reminders, 3D explorer |
| `/trading/` | Trading | Procter & Gamble daily stock dashboard |

Each app has a **⌂ Hub** link back to the home page. On the home page, keys `1`–`9`
open an app and `/` searches.

## Sign-in

Who can sign in is listed in `data/accounts.json` (format in `data.example/`); without that file a single
account called `owner` is used. Each person gets their own data folder and sees only the apps listed
for them. Everyone signs in with a **4-digit PIN**.

* The first sign-in creates the PIN.
* Five wrong PINs lock the profile for 30 seconds, doubling each time (up to 15 minutes).
* Forgot the PIN? `.venv/bin/python main.py reset-pin <username>` clears it; choose a new one at the next sign-in.
* A PIN is a convenience lock for a shared computer, not strong security.
  Four digits can be guessed, and the data files are not encrypted.

## iPhone and offline use

Hub is an installable web app. Keep the laptop server running and the iPhone on the same trusted
Wi-Fi. On the iPhone, open `https://<laptop-name>.local:5174/setup/ios` in Safari. The first
connection uses a local self-signed certificate, so Safari may show a certificate warning. Use
the setup page to download the certificate, install it from **Settings → General → VPN & Device
Management**, then enable full trust under **Settings → General → About → Certificate Trust
Settings**. Reopen the HTTPS address in Safari and use **Share → Add to Home Screen**.

The laptop's normal URL remains `http://127.0.0.1:5173`; it is loopback-only. HTTPS on port `5174`
is the LAN entry point. The local certificate authority and private keys are created in `data/tls/`;
keep that folder private and use Hub only on a trusted network. Only install the public
`hub-ca.crt` certificate on devices you control. Set `HUB_HOSTNAME` if the laptop's default `.local`
name does not resolve on the iPhone. On an IPv6-only network (for example some mobile hotspots,
where the laptop only shows a `192.0.0.2` address), Hub listens on IPv6 instead; use the `.local`
name there, since it resolves over IPv6 as well.

After sign-in, Hub pre-caches its app pages and assets. Open each app online at least once to cache
its data. Roam, My Runs, and Fitness edits made offline are queued locally; tap **Sync to laptop**
when connected to send them to the laptop's
SQLite databases. If an item changed on both devices, Hub asks which copy to keep. MyFuad's local
garage is synchronized as a per-user snapshot in `data/users/<username>/offline-sync.sqlite3`;
sync it from the existing laptop browser before switching to the HTTPS address so its existing
`localStorage` garage is preserved. Strava and market data are available offline only as the last
cached read-only results; refresh still needs internet.

Offline data and queued edits are stored in the browser's local IndexedDB/localStorage and are not
encrypted by Hub. Keep the iPhone protected, do not use a shared device, and do not clear Hub's
website data until pending changes have synced.

## Layout

```
main.py        starts the server (and `reset-pin`)
accounts.py    users, PINs, sign-in and per-app access
core.py        shared security headers, request limits, database helper
home/          sign-in page, launcher page and its read-only stats
roam/ runs/ activities/ fitness/ fuad/ trading/    one folder per app (code + static files)
shared/        files every app uses (hub link style, country outlines)
docs/          database design notes (schema.sql)
data.example/  the file formats, with invented values (committed)
data/          EVERYTHING PERSONAL: accounts, databases, secrets, imports (git-ignored)
tests/         all tests
```

Every app is a Flask *blueprint* mounted at its own address, with its own request-size
limit and content-security policy. Apps do not read each other's data; only the home
page reads small headline numbers, in read-only mode.

## Data: one folder, never committed

All personal information lives in `data/`, which `.gitignore` excludes, so the code can be
published safely. The code contains no names, races, flights, expenses, number plates or keys.

```
data/
  accounts.json            who can sign in and which apps they see
  users.sqlite3            PIN hashes
  secret.key               session-signing key
  tls/                     local HTTPS CA and server certificates/private keys
  ca-bundle.pem            optional corporate CA bundle for HTTPS to Strava
  imports/                 loose source files, e.g. CSV exports
  users/<username>/
    roam.sqlite3  runs.sqlite3  fitness.sqlite3
    activities.sqlite3     Strava connection and synced activity summaries
    offline-sync.sqlite3   MyFuad snapshot and offline change ledger
    flights.tsv            your flight history (format: roam/static/fixtures/sample-flights.tsv)
    fuad-seed.json         optional MyFuad starting data: plate and past expenses
```

Back up that folder to keep your data. The files are not encrypted. Strava keys are passed as
environment variables and are never written to a source file. Before publishing, run
`git status` and confirm nothing from `data/` is listed.

**MyFuad** keeps its garage in the browser (`localStorage`), tied to the address
`127.0.0.1:5173`. That is why this project uses port 5173, MyFuad's old port: your
saved garage appears automatically. If you change `HUB_PORT`, use MyFuad's
**Back up your data** first and restore it at the new address.

## Strava and training stats (My Runs → Activities)

Set `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` and `STRAVA_REFRESH_TOKEN` (with
`activity:read_all`) in the shell that starts the server, and Strava connects by itself.
Press **Sync Strava** on the Races tab to save a small summary of each activity; every run
race then shows what you trained since the previous race, and the **Training between races**
panel compares any two. The totals cover the days after one race up to the day before the
next (a race known only by its month counts from mid-month and is marked approximate).
Register your Strava application with **Authorization Callback Domain** `127.0.0.1`. See
`activities/README.md` for the full guide.

## Trading

Enter your Massive API key on the page (kept in the tab only), or set the
`MASSIVE_API_KEY` environment variable before starting the server. Responses are
cached for five minutes.

## Tests

```sh
.venv/bin/python -m unittest discover -s tests -t .
```
