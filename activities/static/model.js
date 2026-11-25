export function sportName(value) {
  return String(value || "Activity").replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function formatDate(value) {
  if (!value) return "Date not provided";
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return "Date not provided";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

export function duration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "Not provided";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  return h ? `${h}h ${m}m` : `${m}m ${s}s`;
}

export function metric(value, digits = 0, unit = "") {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Not provided";
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: digits }).format(value)}${unit ? " " + unit : ""}`;
}

export function pace(speed) {
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0) return "Not provided";
  const seconds = Math.round(1000 / speed);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} /km`;
}

export function filterPage(activities, query, sport) {
  const term = query.trim().toLocaleLowerCase();
  return activities.filter((a) => (!sport || (a.sport_type || a.type) === sport)
    && (!term || [a.name, sportName(a.sport_type || a.type), formatDate(a.start_date_local || a.start_date)].join(" ").toLocaleLowerCase().includes(term)));
}

export function decodePolyline(encoded) {
  if (typeof encoded !== "string" || encoded.length > 2000000) throw new Error("Invalid GPS route.");
  let index = 0, lat = 0, lon = 0;
  const points = [];
  function read() {
    let result = 0, shift = 0, value;
    do {
      if (index >= encoded.length || shift > 30) throw new Error("Incomplete GPS route.");
      value = encoded.charCodeAt(index++) - 63;
      if (value < 0 || value > 63) throw new Error("Invalid GPS route encoding.");
      result += (value & 31) * 2 ** shift;
      shift += 5;
    } while (value >= 32);
    return result % 2 ? -(result + 1) / 2 : result / 2;
  }
  while (index < encoded.length) {
    lat += read();
    lon += read();
    if (Math.abs(lat / 1e5) > 90 || Math.abs(lon / 1e5) > 180) throw new Error("GPS route contains invalid coordinates.");
    points.push([lon / 1e5, lat / 1e5]);
  }
  return points;
}

export function project([lon, lat]) {
  return [(lon + 180) * 1000 / 360, (85 - lat) * 500 / 170];
}

export function routeGeometry(points) {
  if (!points.length) return { path: "", bounds: [0, 0, 1000, 500] };
  // Unwrap longitude so a route crossing the date line stays continuous.
  let previous = points[0][0];
  const xy = points.map(([lon, lat]) => {
    while (lon - previous > 180) lon -= 360;
    while (lon - previous < -180) lon += 360;
    previous = lon;
    return project([lon, lat]);
  });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of xy) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const width = Math.max(.02, (maxX - minX) * 1.4);
  const height = Math.max(.02, (maxY - minY) * 1.4);
  return {
    path: xy.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(""),
    bounds: [(minX + maxX - width) / 2, (minY + maxY - height) / 2, width, height],
    start: xy[0], end: xy.at(-1),
  };
}
