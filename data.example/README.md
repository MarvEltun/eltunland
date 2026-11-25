# Example data folder

Copy this folder to `data/` to see the file formats. The real `data/` folder holds everything
personal and is never committed (see `.gitignore`).

| File | What it is |
|---|---|
| `accounts.json` | Who can sign in, and which apps each person sees (`"all"` or a list of `roam`, `runs`, `fitness`, `fuad`, `trading`). Without it, one account called `owner` is used. |
| `users/<username>/fuad-seed.json` | Optional starting data for MyFuad on a browser's first visit: your number plate and past expenses. |

The server creates the rest by itself, per person, in `data/users/<username>/`: `roam.sqlite3`,
`runs.sqlite3`, `activities.sqlite3`, `fitness.sqlite3` and `flights.tsv` (your flight history, a
tab-separated file you drop in yourself; `roam/static/fixtures/sample-flights.tsv` shows the format).
Hub-wide files `users.sqlite3` (PIN hashes), `secret.key` and an optional `ca-bundle.pem` sit in `data/`.
Put one-off source files such as CSV exports in `data/imports/`.
