import { parseFlights, filterFlights, summarize, greatCirclePoints, exportCSV } from "./flight-model.js";

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const number = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const state = { flights: [], filtered: [], year: "", airline: "", query: "", route: "", descending: true };
let camera = [0, 0, 1200, 560];
let region = "fit";
let drag = null;
let dragged = false;

function element(tag, attributes = {}, text = "") {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  node.textContent = text;
  return node;
}

function svg(tag, attributes = {}, text = "") {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  node.textContent = text;
  return node;
}

function project([lon, lat]) {
  return [(lon + 180) * 1200 / 360, (85 - lat) * 560 / 170];
}

function path(points, close = false) {
  return points.map((p, i) => {
    const [x, y] = project(p);
    const crossesDateLine = i && Math.abs(p[0] - points[i - 1][0]) > 180;
    return `${i && !crossesDateLine ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join("") + (close ? "Z" : "");
}

function drawLand(features) {
  for (const feature of features) {
    if (feature.properties.CONTINENT === "Antarctica") continue;
    const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    $("land").append(svg("path", {
      d: polygons.map((polygon) => polygon.map((ring) => path(ring, true)).join("")).join(""),
      class: "land", "fill-rule": "evenodd",
    }));
  }
}

function updateCamera() {
  $("map").setAttribute("viewBox", camera.join(" "));
  const scale = camera[2] / 1200;
  for (const point of $("airport-points").children) {
    point.querySelector("circle").setAttribute("r", 3.2 * scale);
    const label = point.querySelector("text");
    label.setAttribute("font-size", 9 * scale);
    label.style.fontSize = `${9 * scale}px`;
    label.setAttribute("dx", 7 * scale);
    label.setAttribute("dy", -5 * scale);
    label.style.strokeWidth = `${2.5 * scale}px`;
  }
}

function frameMap(mode = region) {
  region = mode;
  for (const id of ["fit", "europe", "world"]) $(id).classList.toggle("active", id === mode);
  if (mode === "world") camera = [0, 0, 1200, 560];
  else if (mode === "europe") {
    const [x, y] = project([-20, 72]);
    camera = [x, y, 250, 150];
  } else {
    const points = summarize(state.filtered).routes.flatMap((r) => greatCirclePoints(r.origin, r.destination));
    if (!points.length) camera = [0, 0, 1200, 560];
    else {
      const xy = points.map(project);
      const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const width = Math.max(100, maxX - minX + 65);
      const height = Math.max(90, maxY - minY + 55, width * .44);
      camera = [(minX + maxX - width) / 2, (minY + maxY - height) / 2, width, height];
    }
  }
  updateCamera();
}

function zoom(factor) {
  const [x, y, width, height] = camera;
  const next = Math.min(1400, Math.max(35, width * factor));
  const ratio = next / width;
  camera = [x + width * (1 - ratio) / 2, y + height * (1 - ratio) / 2, next, height * ratio];
  updateCamera();
}

function selectRoute(key) {
  state.route = state.route === key ? "" : key;
  render();
}

function drawRoutes(summary) {
  $("routes").replaceChildren();
  $("airport-points").replaceChildren();
  for (const r of summary.routes) {
    const group = svg("g", {
      class: `route-group${state.route === r.key ? " selected" : state.route ? " dim" : ""}`,
      tabindex: "0", role: "button", "aria-label": `${r.key}, ${r.count} flight${r.count === 1 ? "" : "s"}`,
      "aria-pressed": String(state.route === r.key),
    });
    const d = path(greatCirclePoints(r.origin, r.destination));
    group.append(svg("title", {}, `${r.key} · ${r.count} flight${r.count === 1 ? "" : "s"}`));
    group.append(svg("path", { d, class: "flight-path", "stroke-width": Math.min(5, 1 + Math.sqrt(r.count) * .65) }));
    group.append(svg("path", { d, class: "route-hit" }));
    group.addEventListener("click", () => { if (!dragged) selectRoute(r.key); });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectRoute(r.key); }
    });
    $("routes").append(group);
  }
  const visits = new Map();
  for (const f of filterFlights(state.flights, { ...state, route: "" })) {
    for (const a of [f.origin, f.destination]) visits.set(a.code, (visits.get(a.code) || 0) + 1);
  }
  // Label the busiest airports first and avoid overlapping labels at the current view.
  const labeled = [];
  for (const a of [...summary.airports.values()].sort((a, b) => visits.get(b.code) - visits.get(a.code))) {
    const [x, y] = project([a.lon, a.lat]);
    const group = svg("g", { transform: `translate(${x} ${y})` });
    const dot = svg("circle", { r: 3, class: "airport", tabindex: "0", role: "button", "aria-label": `Find flights for ${a.code}, ${a.name}` });
    dot.append(svg("title", {}, `${a.code} · ${a.name}`));
    const findAirport = () => {
      state.query = a.code;
      state.route = "";
      $("search").value = a.code;
      render();
    };
    dot.addEventListener("click", () => { if (!dragged) findAirport(); });
    dot.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); findAirport(); }
    });
    const tooClose = labeled.some((p) => Math.abs(x - p[0]) < camera[2] * .045 && Math.abs(y - p[1]) < camera[2] * .018);
    const text = svg("text", { class: "airport-label", hidden: tooClose ? "hidden" : "" }, a.code);
    if (!tooClose) { text.removeAttribute("hidden"); labeled.push([x, y]); }
    else text.setAttribute("display", "none");
    group.append(dot, text);
    $("airport-points").append(group);
  }
  updateCamera();
}

function ranking(target, entries, selected, action) {
  const container = $(target);
  container.replaceChildren();
  if (!entries.length) { container.append(element("p", { class: "muted" }, "No matching flights.")); return; }
  const max = entries[0][1];
  for (const [name, count] of entries.slice(0, 5)) {
    const button = element("button", { class: "ranking", "aria-pressed": String(selected === name) });
    const line = element("div");
    line.append(element("span", {}, name), element("span", {}, `${count} flight${count === 1 ? "" : "s"}`));
    const bar = element("span", { class: "bar" }), fill = element("i");
    fill.style.width = `${count / max * 100}%`;
    bar.append(fill);
    button.append(line, bar);
    button.addEventListener("click", () => action(name));
    container.append(button);
  }
}

function renderYears() {
  // Keep the other years visible while drilling into one year.
  const summary = summarize(filterFlights(state.flights, { ...state, year: "", route: "" }));
  const years = [...new Set(state.flights.map((f) => f.year))].sort();
  const max = Math.max(1, ...summary.years.values());
  $("year-chart").replaceChildren();
  for (const year of years) {
    const count = summary.years.get(year) || 0;
    const button = element("button", { class: "year-column", "aria-label": `${year}: ${count} flights`, "aria-pressed": String(state.year === year) });
    const bar = element("i");
    bar.style.height = `${count / max * 115}px`;
    button.append(element("strong", {}, count), bar, element("span", {}, year.slice(2)));
    button.addEventListener("click", () => { state.year = state.year === year ? "" : year; state.route = ""; $("year").value = state.year; render(); });
    $("year-chart").append(button);
  }
}

function renderLog() {
  $("flight-log").replaceChildren();
  const sorted = [...state.filtered].sort((a, b) => (state.descending ? -1 : 1) * a.date.localeCompare(b.date) || a.id - b.id);
  for (const f of sorted) {
    const row = element("tr", { class: state.route === f.route ? "selected" : "" });
    const journey = element("td"), button = element("button", { class: "route-button", "aria-label": `Show route ${f.origin.code} to ${f.destination.code}` });
    button.append(element("span", {}, f.origin.code), element("span", { class: "arrow" }, "→"), element("span", {}, f.destination.code));
    button.addEventListener("click", () => selectRoute(f.route));
    journey.append(button, element("small", { title: `${f.origin.name} → ${f.destination.name}` }, `${f.origin.name} → ${f.destination.name}`));
    row.append(element("td", {}, dateFormat.format(new Date(`${f.date}T00:00:00Z`))), journey,
      element("td", {}, f.airline), element("td", { class: "numeric", title: f.estimated ? "Calculated great-circle distance" : "Distance supplied in your flight file" }, `${number.format(f.distance)} km${f.estimated ? " *" : ""}`));
    $("flight-log").append(row);
  }
  $("empty").hidden = state.filtered.length > 0;
}

function render() {
  const base = filterFlights(state.flights, { ...state, route: "" });
  const network = summarize(base);
  state.filtered = filterFlights(base, { route: state.route });
  const summary = summarize(state.filtered);
  $("flight-count").textContent = number.format(state.filtered.length);
  $("distance").textContent = number.format(summary.distance);
  $("distance-note").textContent = summary.estimated ? `kilometers · ${summary.estimated} calculated distances *` : "kilometers, airport to airport";
  $("airports").textContent = summary.airports.size;
  $("route-count").textContent = `${summary.routes.length} unique airport pairs`;
  $("earth").textContent = `${(summary.distance / 40075.017).toFixed(2)}×`;
  $("result-count").textContent = `${state.filtered.length} of ${state.flights.length} flights`;
  $("log-count").textContent = `(${state.filtered.length})`;
  $("map-summary").textContent = `${base.length} flights · ${network.airports.size} airports · drag to explore`;
  $("clear-route").hidden = !state.route;
  $("export").disabled = !state.filtered.length;
  if (state.route) {
    $("selection-title").textContent = state.route.replace("–", " ↔ ");
    $("selection-detail").textContent = `${state.filtered.length} flight legs · ${number.format(summary.distance)} km in this selection. Highlighted on the map; the log and totals show this route only.`;
  } else {
    const longest = state.filtered.reduce((best, f) => !best || f.distance > best.distance ? f : best, null);
    $("selection-title").textContent = longest ? "Your longest connection." : "A blank page, not a dead end.";
    $("selection-detail").textContent = longest
      ? `${longest.origin.code} → ${longest.destination.code} · ${number.format(longest.distance)} km${longest.estimated ? " (calculated)" : ""}. Choose a route to see its flights, or an airport to search.`
      : "No flights match this selection. Reset your filters to see your full network.";
  }
  frameMap(region);
  drawRoutes(network);
  ranking("top-routes", network.routes.map((r) => [r.key, r.count]), state.route, selectRoute);
  ranking("top-airlines", summarize(filterFlights(state.flights, { ...state, airline: "", route: "" })).airlines, state.airline, (name) => {
    state.airline = state.airline === name ? "" : name;
    state.route = "";
    $("airline").value = state.airline;
    render();
  });
  renderYears();
  renderLog();
}

function installControls() {
  for (const id of ["year", "airline", "search"]) {
    $(id).addEventListener(id === "search" ? "input" : "change", () => {
      state[id === "search" ? "query" : id] = $(id).value;
      state.route = "";
      render();
    });
  }
  $("reset").addEventListener("click", () => {
    Object.assign(state, { year: "", airline: "", query: "", route: "" });
    for (const id of ["year", "airline", "search"]) $(id).value = "";
    region = "fit";
    render();
  });
  $("clear-route").addEventListener("click", () => { state.route = ""; render(); });
  for (const id of ["fit", "europe", "world"]) $(id).addEventListener("click", () => { frameMap(id); drawRoutes(summarize(filterFlights(state.flights, { ...state, route: "" }))); });
  $("zoom-in").addEventListener("click", () => zoom(.75));
  $("zoom-out").addEventListener("click", () => zoom(1 / .75));
  $("sort-date").addEventListener("click", () => {
    state.descending = !state.descending;
    $("sort-date").textContent = `Date ${state.descending ? "↓" : "↑"}`;
    $("sort-date").closest("th").setAttribute("aria-sort", state.descending ? "descending" : "ascending");
    renderLog();
  });
  $("sort-date").closest("th").setAttribute("aria-sort", "descending");
  $("export").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([exportCSV(state.filtered)], { type: "text/csv;charset=utf-8" }));
    const link = element("a", { href: url, download: "roam-flights.csv" });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const map = $("map");
  map.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragged = false;
    drag = { x: event.clientX, y: event.clientY, camera: [...camera] };
  });
  map.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) < 4 && !dragged) return;
    dragged = true;
    map.setPointerCapture(event.pointerId);
    const rect = map.getBoundingClientRect();
    const scale = Math.max(drag.camera[2] / rect.width, drag.camera[3] / rect.height);
    camera = [drag.camera[0] - dx * scale, drag.camera[1] - dy * scale, ...drag.camera.slice(2)];
    updateCamera();
  });
  const stopDrag = () => { drag = null; };
  map.addEventListener("pointerup", stopDrag);
  map.addEventListener("pointercancel", stopDrag);
  map.addEventListener("pointerleave", () => { if (!dragged) stopDrag(); });
  map.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoom(event.deltaY > 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });
}

async function load(url, format) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status}).`);
  return format === "json" ? response.json() : response.text();
}

try {
  const [text, world] = await Promise.all([load("../api/flights.tsv", "text"), load("/shared/data/countries.geojson", "json")]);
  state.flights = parseFlights(text);
  const dates = state.flights.map((f) => f.date).sort();
  $("date-range").textContent = `${dates[0].slice(0, 4)} — ${dates.at(-1).slice(0, 4)}`;
  for (const year of [...new Set(state.flights.map((f) => f.year))].sort().reverse()) $("year").append(element("option", { value: year }, year));
  for (const airline of [...new Set(state.flights.map((f) => f.airline))].sort()) $("airline").append(element("option", { value: airline }, airline));
  drawLand(world.features);
  installControls();
  render();
} catch (error) {
  console.error("Could not load flight atlas:", error);
  $("error").textContent = `Your atlas couldn't load. ${error.message} Check the local server and flight data, then reload.`;
  $("error").hidden = false;
  $("result-count").textContent = "Flight data unavailable";
  $("date-range").textContent = "Unable to load journeys";
  for (const node of document.querySelectorAll("main button, main input, main select")) node.disabled = true;
}
