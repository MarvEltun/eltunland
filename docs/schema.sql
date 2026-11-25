-- Unified schema for Roam, MyFuad, Trading and MyActivities.
-- Target: SQLite 3.37+ (STRICT tables). Types and constraints port directly to PostgreSQL.
-- Conventions: TEXT UUID primary keys, ISO-8601 dates, money as integer cents,
-- booleans as 0/1, timestamps in UTC.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Shared
-- ---------------------------------------------------------------------------

CREATE TABLE schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
) STRICT;

CREATE TABLE app_settings (
    app   TEXT NOT NULL CHECK (app IN ('roam', 'myfuad', 'trading', 'myactivities')),
    key   TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (app, key)
) STRICT;

-- ---------------------------------------------------------------------------
-- Roam: countries, trips, flights, stadiums
-- ---------------------------------------------------------------------------

CREATE TABLE countries (
    id        TEXT PRIMARY KEY CHECK (length(id) = 3),   -- ISO 3166-1 alpha-3 (ADM0_A3)
    iso2      TEXT,
    name      TEXT NOT NULL,
    continent TEXT NOT NULL,
    region    TEXT
) STRICT;

CREATE TABLE country_states (
    country_id TEXT PRIMARY KEY REFERENCES countries(id) ON DELETE CASCADE,
    status     TEXT NOT NULL CHECK (status IN ('none', 'visited', 'bucket')),
    notes      TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 5000)
) STRICT;

CREATE TABLE trips (
    id         TEXT PRIMARY KEY,
    country_id TEXT NOT NULL REFERENCES countries(id),
    title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
    start_date TEXT NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    end_date   TEXT NOT NULL CHECK (end_date   GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    notes      TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 5000),
    CHECK (end_date >= start_date)
) STRICT;
CREATE INDEX idx_trips_start ON trips (start_date DESC);
CREATE INDEX idx_trips_country ON trips (country_id);

CREATE TABLE airports (
    iata       TEXT PRIMARY KEY CHECK (length(iata) = 3),
    icao       TEXT,
    name       TEXT,
    country_id TEXT REFERENCES countries(id),
    latitude   REAL NOT NULL CHECK (latitude  BETWEEN -90  AND 90),
    longitude  REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180)
) STRICT;

CREATE TABLE flights (
    id               TEXT PRIMARY KEY,
    flown_on         TEXT NOT NULL CHECK (flown_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    origin_iata      TEXT NOT NULL REFERENCES airports(iata),
    destination_iata TEXT NOT NULL REFERENCES airports(iata),
    airline          TEXT NOT NULL DEFAULT '',
    distance_km      REAL CHECK (distance_km IS NULL OR distance_km >= 0),
    distance_source  TEXT NOT NULL DEFAULT 'supplied'
                     CHECK (distance_source IN ('supplied', 'calculated great-circle')),
    duration_min     INTEGER CHECK (duration_min IS NULL OR duration_min > 0),
    co2_kg           REAL CHECK (co2_kg IS NULL OR co2_kg >= 0),
    trip_id          TEXT REFERENCES trips(id) ON DELETE SET NULL,
    CHECK (origin_iata <> destination_iata)
) STRICT;
CREATE INDEX idx_flights_date ON flights (flown_on DESC);
CREATE INDEX idx_flights_route ON flights (origin_iata, destination_iata);

-- A stadium is a place; a visit is one occasion there (re-visits and match details live here).
CREATE TABLE stadiums (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    city       TEXT NOT NULL DEFAULT '' CHECK (length(city) <= 120),
    country_id TEXT REFERENCES countries(id),
    latitude   REAL CHECK (latitude  IS NULL OR latitude  BETWEEN -90  AND 90),
    longitude  REAL CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
    map_url    TEXT NOT NULL DEFAULT '' CHECK (length(map_url) <= 500),
    CHECK ((latitude IS NULL) = (longitude IS NULL))
) STRICT;
CREATE INDEX idx_stadiums_country ON stadiums (country_id);

CREATE TABLE stadium_visits (
    id          TEXT PRIMARY KEY,
    stadium_id  TEXT NOT NULL REFERENCES stadiums(id) ON DELETE CASCADE,
    visited_on  TEXT CHECK (visited_on IS NULL OR visited_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    match_title TEXT NOT NULL DEFAULT '',            -- e.g. "Liverpool v Real Madrid"
    score       TEXT NOT NULL DEFAULT '',
    trip_id     TEXT REFERENCES trips(id) ON DELETE SET NULL,
    notes       TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 5000)
) STRICT;
CREATE INDEX idx_stadium_visits_stadium ON stadium_visits (stadium_id);

-- ---------------------------------------------------------------------------
-- MyFuad: cars, expenses, reminders
-- ---------------------------------------------------------------------------

CREATE TABLE vehicles (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    make      TEXT NOT NULL DEFAULT '',
    model     TEXT NOT NULL DEFAULT '',
    year      INTEGER CHECK (year IS NULL OR year BETWEEN 1900 AND 2100),
    fuel_type TEXT NOT NULL DEFAULT 'petrol',
    currency  TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3),
    archived  INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
) STRICT;

CREATE TABLE expense_categories (
    name       TEXT PRIMARY KEY,
    color      TEXT NOT NULL DEFAULT '#a4aaa8',
    is_fuel    INTEGER NOT NULL DEFAULT 0 CHECK (is_fuel IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0
) STRICT;

INSERT INTO expense_categories (name, color, is_fuel, sort_order) VALUES
    ('Gas', '#a8cf68', 1, 1), ('Insurance', '#89a7cb', 0, 2), ('Installment', '#213d35', 0, 3),
    ('Maintenance', '#ddaa72', 0, 4), ('Registration', '#b59bc5', 0, 5), ('Tax', '#e1c66d', 0, 6),
    ('ACV', '#7eb7ad', 0, 7), ('Parking ticket', '#d17b79', 0, 8), ('Speed ticket', '#ba6b78', 0, 9),
    ('Parking', '#839c88', 0, 10), ('Other', '#a4aaa8', 0, 11);

CREATE TABLE expenses (
    id             TEXT PRIMARY KEY,
    vehicle_id     TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    spent_on       TEXT NOT NULL,                     -- 'YYYY-MM-DD', or month-only 'YYYY-MM'
    date_precision TEXT GENERATED ALWAYS AS (CASE WHEN length(spent_on) = 7 THEN 'month' ELSE 'day' END) VIRTUAL,
    category       TEXT NOT NULL REFERENCES expense_categories(name),
    amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
    litres         REAL CHECK (litres IS NULL OR litres > 0),
    odometer_km    INTEGER CHECK (odometer_km IS NULL OR odometer_km > 0),
    full_tank      INTEGER NOT NULL DEFAULT 0 CHECK (full_tank IN (0, 1)),
    notes          TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
    CHECK (spent_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
           OR spent_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    -- Fuel and odometer readings need an exact day; a full tank needs both readings.
    CHECK ((litres IS NULL AND odometer_km IS NULL AND full_tank = 0) OR length(spent_on) = 10),
    CHECK (full_tank = 0 OR (litres IS NOT NULL AND odometer_km IS NOT NULL))
) STRICT;
CREATE INDEX idx_expenses_vehicle_date ON expenses (vehicle_id, spent_on DESC);
CREATE INDEX idx_expenses_category ON expenses (category);

CREATE TABLE reminders (
    id           TEXT PRIMARY KEY,
    vehicle_id   TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
    due_on       TEXT NOT NULL CHECK (due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    completed_at TEXT
) STRICT;
CREATE INDEX idx_reminders_due ON reminders (vehicle_id, due_on) WHERE completed_at IS NULL;

CREATE VIEW v_monthly_spend AS
SELECT vehicle_id, substr(spent_on, 1, 7) AS month, category, SUM(amount_cents) / 100.0 AS total
FROM expenses
GROUP BY vehicle_id, month, category;

-- ---------------------------------------------------------------------------
-- Trading: instruments and cached daily bars.
-- API keys are deliberately NOT stored here; keep them in the environment.
-- ---------------------------------------------------------------------------

CREATE TABLE instruments (
    ticker   TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    exchange TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
    watched  INTEGER NOT NULL DEFAULT 1 CHECK (watched IN (0, 1))
) STRICT;

CREATE TABLE daily_bars (
    ticker     TEXT NOT NULL REFERENCES instruments(ticker) ON DELETE CASCADE,
    day        TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    open       REAL NOT NULL CHECK (open  > 0),
    high       REAL NOT NULL CHECK (high  > 0),
    low        REAL NOT NULL CHECK (low   > 0),
    close      REAL NOT NULL CHECK (close > 0),
    volume     REAL NOT NULL CHECK (volume >= 0),
    adjusted   INTEGER NOT NULL DEFAULT 1 CHECK (adjusted IN (0, 1)),   -- split-adjusted
    source     TEXT NOT NULL DEFAULT 'massive',
    fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (ticker, day),
    CHECK (low <= open AND low <= close AND high >= open AND high >= close)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- MyActivities (Strava): connection state ONLY.
-- Strava's API policy rules out a long-term activity archive, so activities,
-- routes and profile data are intentionally not modelled. Keep file mode 0600.
-- ---------------------------------------------------------------------------

CREATE TABLE strava_credentials (
    id            INTEGER PRIMARY KEY CHECK (id = 1),      -- single connection
    athlete_id    INTEGER NOT NULL,
    access_token  TEXT NOT NULL,
    refresh_token TEXT NOT NULL DEFAULT '',                -- empty for imported tokens
    expires_at    INTEGER NOT NULL
) STRICT;

INSERT INTO schema_migrations (version) VALUES (1);
