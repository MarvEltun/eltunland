const EARTH_KM = 6371.0088;
const radians = (value) => value * Math.PI / 180;
const degrees = (value) => value * 180 / Math.PI;

export function greatCircleDistance(a, b) {
  const lat = radians(b.lat - a.lat);
  const lon = radians(b.lon - a.lon);
  const h = Math.sin(lat / 2) ** 2
    + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(lon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function greatCirclePoints(a, b, steps = 48) {
  const vector = (p) => [
    Math.cos(radians(p.lat)) * Math.cos(radians(p.lon)),
    Math.cos(radians(p.lat)) * Math.sin(radians(p.lon)), Math.sin(radians(p.lat)),
  ];
  const start = vector(a), end = vector(b);
  const angle = Math.acos(Math.max(-1, Math.min(1, start.reduce((sum, n, i) => sum + n * end[i], 0))));
  if (angle < 1e-8) return [[a.lon, a.lat], [b.lon, b.lat]];
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const v = start.map((n, j) => (
      n * Math.sin((1 - t) * angle) + end[j] * Math.sin(t * angle)
    ) / Math.sin(angle));
    return [degrees(Math.atan2(v[1], v[0])), degrees(Math.atan2(v[2], Math.hypot(v[0], v[1])))];
  });
}

export const routeKey = (a, b) => [a, b].sort().join("–");

export function parseFlights(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift().split("\t").map((s) => s.trim());
  const required = ["date", "airline", "origin_code", "destination_code", "distance", "distance_units"];
  if (required.some((key) => !headers.includes(key))) throw new Error("Flight file is missing required columns.");
  const rows = lines.filter((line) => line.trim()).map((line, i) => {
    const cells = line.split("\t");
    const row = Object.fromEntries(headers.map((key, j) => [key, (cells[j] ?? "").trim()]));
    row.line = i + 2;
    return row;
  });
  if (!rows.length) throw new Error("The flight file contains no flights.");
  const airports = new Map();
  for (const row of rows) {
    for (const side of ["origin", "destination"]) {
      const code = row[`${side}_code`];
      if (!/^[A-Z]{3}$/.test(code)) throw new Error(`Invalid airport code on line ${row.line}.`);
      const latText = row[`${side}_latitude`] ?? "", lonText = row[`${side}_longitude`] ?? "";
      if (!latText && !lonText) continue;
      const lat = Number(latText), lon = Number(lonText);
      if (!latText || !lonText || !Number.isFinite(lat) || !Number.isFinite(lon)
          || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        throw new Error(`Invalid coordinates for ${code} on line ${row.line}.`);
      }
      airports.set(code, { code, lat, lon, name: row[`${side}_name`] || code });
    }
  }
  return rows.map((row, id) => {
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(row.date);
    if (!match) throw new Error(`Invalid date on line ${row.line}.`);
    const [, m, d, y] = match;
    const date = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new Error(`Invalid date on line ${row.line}.`);
    }
    if (!row.airline) throw new Error(`Missing airline on line ${row.line}.`);
    const origin = airports.get(row.origin_code), destination = airports.get(row.destination_code);
    if (!origin || !destination) throw new Error(`Missing airport coordinates on line ${row.line}.`);
    const estimated = row.distance === "";
    if (!estimated && row.distance_units !== "km") throw new Error(`Expected kilometer distance on line ${row.line}.`);
    const distance = estimated ? greatCircleDistance(origin, destination) : Number(row.distance);
    if (!Number.isFinite(distance) || distance <= 0) throw new Error(`Invalid distance on line ${row.line}.`);
    return { id, date, year: y, airline: row.airline, origin, destination, distance, estimated,
      route: routeKey(origin.code, destination.code) };
  });
}

export function filterFlights(flights, { year = "", airline = "", query = "", route = "" } = {}) {
  const term = query.trim().toLocaleLowerCase();
  return flights.filter((f) => (!year || f.year === year) && (!airline || f.airline === airline)
    && (!route || f.route === route)
    && (!term || [f.origin.code, f.origin.name, f.destination.code, f.destination.name, f.airline,
      `${f.origin.code} ${f.destination.code}`].join(" ").toLocaleLowerCase().includes(term)));
}

export function summarize(flights) {
  const routes = new Map(), airlines = new Map(), airports = new Map(), years = new Map();
  let distance = 0, estimated = 0;
  for (const f of flights) {
    distance += f.distance;
    estimated += Number(f.estimated);
    airports.set(f.origin.code, f.origin);
    airports.set(f.destination.code, f.destination);
    const route = routes.get(f.route) || { key: f.route, origin: f.origin, destination: f.destination, count: 0 };
    route.count++;
    routes.set(f.route, route);
    airlines.set(f.airline, (airlines.get(f.airline) || 0) + 1);
    years.set(f.year, (years.get(f.year) || 0) + 1);
  }
  return { distance, estimated, airports, routes: [...routes.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    airlines: [...airlines].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), years };
}

export function exportCSV(flights) {
  const cell = (value) => {
    const text = String(value);
    // Keep imported text from being interpreted as a spreadsheet formula.
    return `"${(/^[=+@\-\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
  };
  const rows = [["date", "origin", "destination", "airline", "distance_km", "distance_source"],
    ...flights.map((f) => [f.date, f.origin.code, f.destination.code, f.airline,
      f.distance.toFixed(2), f.estimated ? "calculated great-circle" : "supplied"])];
  return rows.map((row) => row.map(cell).join(",")).join("\r\n");
}
