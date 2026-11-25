# Roam

Local travel map, country bucket list, trip journal, and personal flight atlas.

## Run

Roam is part of the Hub project: start the one server from the project folder
(`.venv/bin/python main.py`, see the main README) and open
**http://127.0.0.1:5173/roam/**. Choose **Flights**, or go directly to
http://127.0.0.1:5173/roam/static/flights.html.

## Stadium visits

Choose **Stadiums** to keep a local log of grounds you have visited, including
the stadium name, location, optional visit date, Google Maps link, and a note
about the match or visit. Entries can be edited or deleted and are stored in
`data/users/<username>/roam.sqlite3` alongside the journal. Stadiums with coordinates appear as
selectable icons on a zoomable world map.

## Flight atlas

Each person's flight history is the file `data/users/<name>/flights.tsv` (served only to
that signed-in person). No external
services, map tiles, accounts, or JavaScript packages are required. The dashboard
shows great-circle route paths, flight totals, distance, unique airports, annual
activity, most-flown airport pairs, airlines, and a searchable flight log.

- Year, airline, and airport/name search filters work together.
- Select a route on the map, in the rankings, or in the log to narrow totals and
  the log to that route. Both directions count as one airport pair.
- Select an airport to search for its flights, or a year/airline to filter.
- Drag or zoom the map; use **Your network**, **Europe**, or **World** to reframe.
- Export the current selection as CSV, including distance provenance.
- **Reset filters** restores the whole history.

All rows are individual flight legs, not inferred trips. Repeated airport
coordinates in the file fill missing coordinates in other rows. Four supplied
rows lack distances: these are calculated from airport coordinates and marked
with `*`. Supplied distances are retained. Distances are not actual aircraft
tracks. Unreported flight times and emissions are not inferred. Airport visits
do not imply country visits, and the atlas does not modify the country map or
journal.

To update your history, replace `data/users/<name>/flights.tsv` with a tab-separated
export using the same column headers, then reload. Dates use `M/D/YYYY`, distances
use `km`, and each airport needs coordinates in at least one row. Invalid data
produces an explicit error instead of silently omitting flights. Filters are
temporary; the bundled flight file is persistent.

Your flight file and journal are private local files: do not publish them.
Journal, country, and stadium data persist in `data/users/<name>/roam.sqlite3`; back up that
file and `flights.tsv` to preserve them.

## Tests

From the project folder, run `.venv/bin/python -m unittest discover -s tests -t .`
(see the main README). For flight-model tests, open the app in a browser and run:

```js
await (await import("/roam/static/flight-tests.js")).runTests()
```

The tests run against an invented sample (`static/fixtures/sample-flights.tsv`), never your own file. They exercise missing-distance enrichment, validation,
combined filters, route grouping, great-circle geometry, and CSV export.

Map data: Natural Earth (public domain).
