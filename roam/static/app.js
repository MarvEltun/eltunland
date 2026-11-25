"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  countries: [], trips: [], stadiums: [], selected: null, view: "map", filter: "all",
  continent: "", query: "", limit: 12, saving: false, deleting: null,
};
const camera = createCamera("map-transform", 7);
const stadiumCamera = createCamera("stadium-map-transform", 8);
const NS = "http://www.w3.org/2000/svg";
let toastTimer;

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function flag(country) {
  const iso = country.iso2;
  return /^[A-Z]{2}$/.test(iso)
    ? [...iso].map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))).join("")
    : "◈";
}

function notify(message, error = false) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.toggle("error", error);
  $("toast").hidden = false;
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, error ? 7000 : 3000);
}

async function api(url, method = "GET", data) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: data === undefined ? {} : { "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  } catch (error) {
    console.error("Local server connection failed:", error);
    throw new Error("Cannot reach your local server. Check that the app is still running.");
  }
  if (response.status === 204) return null;
  let result;
  try {
    result = await response.json();
  } catch (error) {
    console.error("Invalid local server response:", error);
    throw new Error("The server returned an unexpected response. Check its terminal.");
  }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function project(point) {
  return [(point[0] + 180) * 1000 / 360, (85 - point[1]) * 500 / 145];
}

function geometryPath(geometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.map((polygon) => polygon.map((ring) => ring.map((point, index) => {
    const [x, y] = project(point);
    return `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join("") + "Z").join("")).join("");
}

function svgElement(name, attrs) {
  const element = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

function createMap() {
  const grid = $("graticule");
  for (let lon = -150; lon <= 150; lon += 30) {
    const x = project([lon, 0])[0];
    grid.append(svgElement("path", { d: `M${x},0V500`, class: "grid-line" }));
  }
  for (let lat = -60; lat <= 80; lat += 20) {
    const y = project([0, lat])[1];
    grid.append(svgElement("path", { d: `M0,${y}H1000`, class: "grid-line" }));
  }
  for (const country of state.countries) {
    const path = svgElement("path", {
      d: geometryPath(country.geometry), "data-country": country.id,
      id: `map-${country.id}`, class: "country-shape", tabindex: "0",
      role: "button", "fill-rule": "evenodd", "aria-label": country.name,
    });
    path.addEventListener("keydown", activateOnKey(() => selectCountry(country.id)));
    path.addEventListener("pointermove", (event) => {
      if ($("world-map").classList.contains("dragging")) return;
      showTooltip("map-tooltip", "map-viewport", event, country.name);
    });
    path.addEventListener("pointerleave", () => { $("map-tooltip").hidden = true; });
    $("country-paths").append(path);
  }
  for (const [name, lon, lat] of [
    ["NORTH AMERICA", -110, 50], ["SOUTH AMERICA", -58, -16],
    ["EUROPE", 20, 54], ["AFRICA", 18, 8], ["ASIA", 95, 48], ["OCEANIA", 140, -23],
  ]) {
    const [x, y] = project([lon, lat]);
    const label = svgElement("text", { x, y, class: "continent-label" });
    label.textContent = name;
    $("country-paths").append(label);
  }
  installMapControls();
}

// A pan/zoom camera for an SVG group that fills a 1000x500 viewBox.
function createCamera(transformId, maxScale) {
  const camera = {
    scale: 1, x: 0, y: 0,
    apply() {
      camera.x = Math.min(0, Math.max(1000 * (1 - camera.scale), camera.x));
      camera.y = Math.min(0, Math.max(500 * (1 - camera.scale), camera.y));
      $(transformId).setAttribute("transform", `translate(${camera.x} ${camera.y}) scale(${camera.scale})`);
    },
    zoom(factor, point = { x: 500, y: 250 }) {
      const next = Math.min(maxScale, Math.max(1, camera.scale * factor));
      const ratio = next / camera.scale;
      camera.x = point.x - (point.x - camera.x) * ratio;
      camera.y = point.y - (point.y - camera.y) * ratio;
      camera.scale = next;
      camera.apply();
    },
    reset() {
      Object.assign(camera, { scale: 1, x: 0, y: 0 });
      camera.apply();
    },
  };
  return camera;
}

function svgPoint(svg, event) {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(svg.getScreenCTM().inverse());
}

function showTooltip(tooltipId, viewportId, event, text) {
  const rect = $(viewportId).getBoundingClientRect();
  const tooltip = $(tooltipId);
  tooltip.textContent = text;
  tooltip.style.left = `${Math.min(event.clientX - rect.left + 12, rect.width - 170)}px`;
  tooltip.style.top = `${Math.max(3, event.clientY - rect.top - 35)}px`;
  tooltip.hidden = false;
}

function activateOnKey(action) {
  return (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  };
}

function bindZoom(camera, svg, buttonIds) {
  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    camera.zoom(event.deltaY < 0 ? 1.15 : 1 / 1.15, svgPoint(svg, event));
  }, { passive: false });
  const [zoomIn, zoomOut, reset] = buttonIds.map($);
  zoomIn.addEventListener("click", () => camera.zoom(1.4));
  zoomOut.addEventListener("click", () => camera.zoom(1 / 1.4));
  reset.addEventListener("click", () => camera.reset());
}

function installMapControls() {
  const svg = $("world-map");
  let drag = null;
  bindZoom(camera, svg, ["zoom-in", "zoom-out", "zoom-reset"]);
  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    drag = {
      start: svgPoint(svg, event), x: camera.x, y: camera.y, moved: false,
      country: event.target.closest("[data-country]")?.dataset.country,
    };
  });
  svg.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const point = svgPoint(svg, event);
    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    if (Math.hypot(dx, dy) > 4) {
      drag.moved = true;
      svg.classList.add("dragging");
      svg.setPointerCapture(event.pointerId);
      $("map-tooltip").hidden = true;
    }
    if (drag.moved) {
      camera.x = drag.x + dx;
      camera.y = drag.y + dy;
      camera.apply();
    }
  });
  svg.addEventListener("pointerup", (event) => {
    if (!drag) return;
    if (!drag.moved && drag.country) selectCountry(drag.country);
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    drag = null;
    svg.classList.remove("dragging");
  });
  svg.addEventListener("pointercancel", () => {
    drag = null;
    svg.classList.remove("dragging");
  });
  svg.addEventListener("pointerleave", () => {
    if (drag && !drag.moved) drag = null;
  });
}

function createStadiumMap() {
  for (const country of state.countries) {
    $("stadium-map-land").append(svgElement("path", {
      d: geometryPath(country.geometry), class: "stadium-map-country", "fill-rule": "evenodd",
    }));
  }
  bindZoom(stadiumCamera, $("stadium-world-map"), ["stadium-zoom-in", "stadium-zoom-out", "stadium-zoom-reset"]);
}

function renderStadiumMap() {
  const markers = $("stadium-map-markers");
  markers.replaceChildren();
  const mapped = state.stadiums.filter((stadium) => (
    Number.isFinite(stadium.latitude) && Number.isFinite(stadium.longitude)
  ));
  for (const stadium of mapped) {
    const [x, y] = project([stadium.longitude, stadium.latitude]);
    const marker = svgElement("g", {
      class: "stadium-map-marker", transform: `translate(${x} ${y})`,
      "data-stadium": stadium.id, tabindex: "0", role: "button",
      "aria-label": stadium.name,
    });
    const title = svgElement("title", {});
    title.textContent = stadium.name;
    marker.append(title, svgElement("circle", { cx: 0, cy: 0, r: 11 }));
    marker.append(svgElement("path", {
      d: "M-7 6V-1A7 7 0 0 1 7-1V6M-9 6H9M-5 6V1h3v5M2 6V1h3v5",
      class: "stadium-marker-icon",
    }));
    marker.addEventListener("pointermove", (event) => {
      showTooltip("stadium-map-tooltip", "stadium-map-viewport", event, stadium.name);
    });
    marker.addEventListener("pointerleave", () => { $("stadium-map-tooltip").hidden = true; });
    marker.addEventListener("click", () => focusStadium(stadium.id));
    marker.addEventListener("keydown", activateOnKey(() => focusStadium(stadium.id)));
    markers.append(marker);
  }
  $("stadium-map-count").textContent = `${mapped.length} of ${state.stadiums.length} locations mapped`;
}

function focusStadium(id) {
  const card = document.getElementById(`stadium-card-${id}`);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.add("map-selected");
  setTimeout(() => card.classList.remove("map-selected"), 1800);
}

function matches(country) {
  return (!state.continent || country.continent === state.continent)
    && (!state.query || country.name.toLocaleLowerCase().includes(state.query))
    && (state.filter === "all" || country.status === state.filter);
}

function renderStats() {
  const visited = state.countries.filter((country) => country.status === "visited").length;
  const bucket = state.countries.filter((country) => country.status === "bucket").length;
  const percent = state.countries.length ? (visited / state.countries.length * 100).toFixed(1) : "0";
  $("stat-visited").textContent = visited;
  $("stat-total").textContent = ` / ${state.countries.length}`;
  $("stat-percent").textContent = percent;
  $("stat-bucket").textContent = bucket;
  $("nav-bucket").textContent = bucket;
  $("nav-stadiums").textContent = state.stadiums.length;
  $("stat-trips").textContent = state.trips.length;
  $("world-progress").style.width = `${percent}%`;
  $("coverage-note").textContent = `${state.countries.length} mapped countries & territories · Natural Earth (public domain)`;
}

function renderMap() {
  for (const country of state.countries) {
    const path = $(`map-${country.id}`);
    path.classList.toggle("visited", country.status === "visited");
    path.classList.toggle("bucket", country.status === "bucket");
    path.classList.toggle("selected", country.id === state.selected);
    path.classList.toggle("dimmed", !matches(country));
    path.setAttribute("aria-label", `${country.name}: ${country.status === "none" ? "not tracked" : country.status === "bucket" ? "want to go" : "visited"}`);
    path.setAttribute("aria-pressed", country.id === state.selected ? "true" : "false");
  }
}

function renderCountries() {
  const countries = state.countries.filter(matches);
  $("places-heading").textContent = state.view === "bucket" ? "Someday starts here" : state.filter === "visited" ? "The places in your story" : "Make the map yours";
  $("places-summary").textContent = `${countries.length} ${countries.length === 1 ? "place" : "places"}${state.continent ? ` in ${state.continent}` : " to explore"} · Select a place to make it part of your story.`;
  $("country-grid").innerHTML = countries.slice(0, state.limit).map((country) => `
    <button class="country-card ${country.status} ${state.selected === country.id ? "selected" : ""}" data-select="${escapeHTML(country.id)}">
      <span class="flag" aria-hidden="true">${flag(country)}</span><span><strong>${escapeHTML(country.name)}</strong><small>${escapeHTML(country.continent.toUpperCase())}</small></span><span class="status-mark" aria-label="${country.status === "visited" ? "Visited" : country.status === "bucket" ? "Want to go" : "Not tracked"}">${country.status === "visited" ? "✓" : country.status === "bucket" ? "✦" : "＋"}</span>
    </button>`).join("");
  if (!countries.length) {
    const message = state.query ? "Try a different search or continent." : state.filter === "bucket" ? "Add a country to your bucket list from the map." : state.filter === "visited" ? "Mark a country as visited to start your story." : "Try choosing another continent.";
    $("country-grid").innerHTML = `<div class="empty-state"><h3>No places here. Yet.</h3><p>${message}</p></div>`;
  }
  $("show-more").hidden = countries.length <= state.limit;
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === state.filter);
    button.setAttribute("aria-pressed", button.dataset.filter === state.filter ? "true" : "false");
  });
}

function renderDetail() {
  const country = state.countries.find((item) => item.id === state.selected);
  $("country-empty").hidden = Boolean(country);
  $("country-detail").hidden = !country;
  if (!country) return;
  $("detail-flag").textContent = flag(country);
  $("detail-name").textContent = country.name;
  $("detail-region").textContent = country.region || country.continent;
  $("detail-caption").textContent = country.status === "visited"
    ? "A little piece of your world, explored."
    : country.status === "bucket" ? "An adventure waiting to happen." : "A new chapter could start right here.";
  $("mark-visited").classList.toggle("active", country.status === "visited");
  $("mark-bucket").classList.toggle("active", country.status === "bucket");
  $("mark-visited").setAttribute("aria-pressed", country.status === "visited" ? "true" : "false");
  $("mark-bucket").setAttribute("aria-pressed", country.status === "bucket" ? "true" : "false");
  $("clear-status").hidden = country.status === "none";
  $("country-notes").value = country.notes;
}

function selectCountry(id) {
  if (!confirmDiscardNotes()) return;
  state.selected = id;
  renderDetail();
  renderMap();
  renderCountries();
  if (matchMedia("(max-width: 760px)").matches) {
    document.querySelector(".country-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function confirmDiscardNotes() {
  const country = state.countries.find((item) => item.id === state.selected);
  return !country || country.notes === $("country-notes").value
    || window.confirm("You have an unsaved country note. Discard these changes?");
}

async function saveCountry(status) {
  if (state.saving) return;
  const country = state.countries.find((item) => item.id === state.selected);
  if (!country) return;
  state.saving = true;
  const buttons = ["mark-visited", "mark-bucket", "clear-status", "save-country-notes"];
  buttons.forEach((id) => { $(id).disabled = true; });
  try {
    const result = await api(`api/countries/${encodeURIComponent(country.id)}`, "PUT", {
      status: status ?? country.status, notes: $("country-notes").value,
    });
    Object.assign(country, { status: result.status, notes: result.notes });
    renderStats();
    renderMap();
    renderCountries();
    renderDetail();
    notify(status === "visited" ? `${country.name} is on your visited map.` : status === "bucket" ? `${country.name} is on your bucket list.` : status === "none" ? "Removed from your map. Your note is kept." : "Your note is saved.");
  } catch (error) {
    notify(error.message, true);
  } finally {
    state.saving = false;
    buttons.forEach((id) => { $(id).disabled = false; });
  }
}

function setView(view) {
  if (!confirmDiscardNotes()) return;
  state.view = view;
  state.filter = view === "bucket" ? "bucket" : "all";
  state.query = "";
  state.continent = "";
  state.limit = 12;
  $("country-search").value = "";
  $("continent-filter").value = "";
  $("map-view").hidden = view === "trips" || view === "stadiums";
  $("trips-view").hidden = view !== "trips";
  $("stadiums-view").hidden = view !== "stadiums";
  $("new-trip").hidden = view === "stadiums";
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
    if (button.dataset.view === view) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  renderMap();
  renderCountries();
  renderTrips();
  renderStadiums();
  renderStadiumMap();
}

function formatDate(value) {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  });
}

function renderTrips() {
  const today = new Date();
  const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  $("trip-list").innerHTML = [...state.trips]
    .sort((a, b) => b.start_date.localeCompare(a.start_date))
    .map((trip) => {
      const country = state.countries.find((item) => item.id === trip.country_id);
      return `<article class="trip-card">
        <div class="trip-country-art" aria-hidden="true">${flag(country)}</div>
        <div class="trip-content"><p class="eyebrow">${escapeHTML(country.name.toUpperCase())} · ${escapeHTML(country.continent.toUpperCase())}</p>
        <h3>${escapeHTML(trip.title)}</h3><p class="trip-dates">${formatDate(trip.start_date)} — ${formatDate(trip.end_date)} <span class="trip-badge">${trip.start_date > localToday ? "ON THE HORIZON" : trip.end_date >= localToday ? "HAPPENING NOW" : "IN THE MEMORY BOOK"}</span></p>
        ${trip.notes ? `<p class="trip-notes">${escapeHTML(trip.notes)}</p>` : ""}</div>
        <div class="trip-actions"><button class="button secondary small" data-edit-trip="${escapeHTML(trip.id)}">Edit</button><button class="text-button" data-delete-trip="${escapeHTML(trip.id)}" aria-label="Delete ${escapeHTML(trip.title)}">Delete</button></div></article>`;
    }).join("");
  if (!state.trips.length) {
    $("trip-list").innerHTML = '<div class="empty-state"><h3>Your next chapter is a blank page.</h3><p>Add your first trip to start a journal of the places, people, and moments you love.</p><br><button class="button primary" id="empty-new-trip">＋ Add your first trip</button></div>';
    $("empty-new-trip").addEventListener("click", () => openTrip());
  }
}

function renderStadiums() {
  $("stadium-list").innerHTML = [...state.stadiums]
    .sort((a, b) => b.visited_on.localeCompare(a.visited_on) || a.name.localeCompare(b.name))
    .map((stadium) => `<article class="stadium-card" id="stadium-card-${escapeHTML(stadium.id)}">
      <div class="stadium-mark" aria-hidden="true">⌂</div>
      <div class="trip-content"><p class="eyebrow">${escapeHTML(stadium.location || "A stadium visit")}</p>
        <h3>${escapeHTML(stadium.name)}</h3>
        ${stadium.visited_on ? `<p class="trip-dates">Visited ${formatDate(stadium.visited_on)}</p>` : ""}
        ${stadium.notes ? `<p class="trip-notes">${escapeHTML(stadium.notes)}</p>` : ""}
        ${stadium.map_url ? `<a class="stadium-map-link" href="${escapeHTML(stadium.map_url)}" target="_blank" rel="noopener noreferrer">Open in Google Maps ↗</a>` : ""}
      </div>
      <div class="trip-actions"><button class="button secondary small" data-edit-stadium="${escapeHTML(stadium.id)}">Edit</button><button class="text-button" data-delete-stadium="${escapeHTML(stadium.id)}" aria-label="Delete ${escapeHTML(stadium.name)}">Delete</button></div>
    </article>`).join("");
  if (!state.stadiums.length) {
    $("stadium-list").innerHTML = '<div class="empty-state"><h3>Your first ground is waiting.</h3><p>Save a stadium you have visited, along with the match and memories.</p><br><button class="button primary" id="empty-new-stadium">＋ Add your first stadium</button></div>';
    $("empty-new-stadium").addEventListener("click", () => openStadium());
  }
}

function openTrip(trip = null, countryId = "") {
  $("trip-form").reset();
  $("trip-id").value = trip?.id || "";
  $("trip-dialog-title").textContent = trip ? "The story continues" : "A trip to remember";
  $("trip-title").value = trip?.title || "";
  $("trip-country").value = trip?.country_id || countryId;
  $("trip-start").value = trip?.start_date || "";
  $("trip-end").value = trip?.end_date || "";
  $("trip-end").min = trip?.start_date || "";
  $("trip-notes").value = trip?.notes || "";
  $("trip-error").hidden = true;
  $("trip-dialog").showModal();
}

async function submitTrip(event) {
  event.preventDefault();
  const id = $("trip-id").value;
  $("save-trip").disabled = true;
  $("trip-error").hidden = true;
  try {
    const trip = await api(id ? `api/trips/${encodeURIComponent(id)}` : "api/trips", id ? "PUT" : "POST", {
      title: $("trip-title").value, country_id: $("trip-country").value,
      start_date: $("trip-start").value, end_date: $("trip-end").value, notes: $("trip-notes").value,
    });
    state.trips = [...state.trips.filter((item) => item.id !== trip.id), trip];
    $("trip-dialog").close();
    renderStats();
    renderTrips();
    setView("trips");
    notify(id ? "Your chapter is updated." : "A new chapter, saved.");
  } catch (error) {
    $("trip-error").textContent = error.message;
    $("trip-error").hidden = false;
  } finally {
    $("save-trip").disabled = false;
  }
}

function openStadium(stadium = null) {
  $("stadium-form").reset();
  $("stadium-id").value = stadium?.id || "";
  $("stadium-dialog-title").textContent = stadium ? "Edit stadium visit" : "Add a stadium visit";
  $("stadium-name").value = stadium?.name || "";
  $("stadium-location").value = stadium?.location || "";
  $("stadium-visited-on").value = stadium?.visited_on || "";
  $("stadium-latitude").value = stadium?.latitude ?? "";
  $("stadium-longitude").value = stadium?.longitude ?? "";
  $("stadium-map-url").value = stadium?.map_url || "";
  $("stadium-notes").value = stadium?.notes || "";
  $("stadium-error").hidden = true;
  $("stadium-dialog").showModal();
}

async function submitStadium(event) {
  event.preventDefault();
  const id = $("stadium-id").value;
  $("save-stadium").disabled = true;
  $("stadium-error").hidden = true;
  try {
    const stadium = await api(id ? `api/stadiums/${encodeURIComponent(id)}` : "api/stadiums", id ? "PUT" : "POST", {
      name: $("stadium-name").value, location: $("stadium-location").value,
      visited_on: $("stadium-visited-on").value, map_url: $("stadium-map-url").value,
      latitude: $("stadium-latitude").value, longitude: $("stadium-longitude").value,
      notes: $("stadium-notes").value,
    });
    state.stadiums = [...state.stadiums.filter((item) => item.id !== stadium.id), stadium];
    $("stadium-dialog").close();
    renderStats();
    setView("stadiums");
    notify(id ? "Stadium visit updated." : "Stadium visit saved.");
  } catch (error) {
    $("stadium-error").textContent = error.message;
    $("stadium-error").hidden = false;
  } finally {
    $("save-stadium").disabled = false;
  }
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      state.limit = 12;
      renderMap();
      renderCountries();
    });
  });
  $("continent-filter").addEventListener("change", (event) => {
    state.continent = event.target.value;
    state.limit = 12;
    renderMap();
    renderCountries();
  });
  $("country-search").addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLocaleLowerCase();
    state.limit = 12;
    renderCountries();
    renderMap();
  });
  $("country-grid").addEventListener("click", (event) => {
    const card = event.target.closest("[data-select]");
    if (card) selectCountry(card.dataset.select);
  });
  $("show-more").addEventListener("click", () => { state.limit += 24; renderCountries(); });
  $("explore-countries").addEventListener("click", () => {
    $("country-search").scrollIntoView({ behavior: "smooth", block: "center" });
    $("country-search").focus({ preventScroll: true });
  });
  $("close-country").addEventListener("click", () => {
    if (!confirmDiscardNotes()) return;
    state.selected = null;
    renderDetail();
    renderMap();
    renderCountries();
  });
  $("mark-visited").addEventListener("click", () => saveCountry("visited"));
  $("mark-bucket").addEventListener("click", () => saveCountry("bucket"));
  $("clear-status").addEventListener("click", () => saveCountry("none"));
  $("save-country-notes").addEventListener("click", () => saveCountry());
  $("new-trip").addEventListener("click", () => openTrip());
  $("new-stadium").addEventListener("click", () => openStadium());
  $("country-add-trip").addEventListener("click", () => openTrip(null, state.selected));
  $("close-trip").addEventListener("click", () => $("trip-dialog").close());
  $("trip-start").addEventListener("change", () => { $("trip-end").min = $("trip-start").value; });
  $("trip-form").addEventListener("submit", submitTrip);
  $("close-stadium").addEventListener("click", () => $("stadium-dialog").close());
  $("stadium-form").addEventListener("submit", submitStadium);
  $("trip-list").addEventListener("click", (event) => {
    const edit = event.target.closest("[data-edit-trip]");
    const remove = event.target.closest("[data-delete-trip]");
    if (edit) openTrip(state.trips.find((trip) => trip.id === edit.dataset.editTrip));
    if (remove) {
      state.deleting = remove.dataset.deleteTrip;
      $("delete-dialog").showModal();
    }
  });
  $("stadium-list").addEventListener("click", async (event) => {
    const edit = event.target.closest("[data-edit-stadium]");
    const remove = event.target.closest("[data-delete-stadium]");
    if (edit) {
      openStadium(state.stadiums.find((stadium) => stadium.id === edit.dataset.editStadium));
      return;
    }
    if (!remove || !window.confirm("Delete this stadium visit? This cannot be undone.")) return;
    try {
      await api(`api/stadiums/${encodeURIComponent(remove.dataset.deleteStadium)}`, "DELETE");
      state.stadiums = state.stadiums.filter((stadium) => stadium.id !== remove.dataset.deleteStadium);
      renderStats();
      renderStadiums();
      renderStadiumMap();
      notify("Stadium visit deleted.");
    } catch (error) {
      notify(error.message, true);
    }
  });
  $("cancel-delete").addEventListener("click", () => $("delete-dialog").close());
  $("confirm-delete").addEventListener("click", async () => {
    $("confirm-delete").disabled = true;
    const id = state.deleting;
    try {
      await api(`api/trips/${encodeURIComponent(id)}`, "DELETE");
      state.trips = state.trips.filter((trip) => trip.id !== id);
      $("delete-dialog").close();
      renderStats();
      renderTrips();
      notify("Trip deleted.");
    } catch (error) {
      $("delete-dialog").close();
      notify(error.message, true);
    } finally {
      $("confirm-delete").disabled = false;
    }
  });
  window.addEventListener("beforeunload", (event) => {
    const country = state.countries.find((item) => item.id === state.selected);
    if (country && country.notes !== $("country-notes").value) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}

async function initialize() {
  $("new-trip").disabled = true;
  try {
    const data = await api("api/bootstrap");
    state.countries = data.countries;
    state.trips = data.trips;
    state.stadiums = data.stadiums;
    for (const continent of [...new Set(state.countries.map((country) => country.continent))].sort()) {
      $("continent-filter").add(new Option(continent, continent));
    }
    $("trip-country").add(new Option("Choose a destination...", ""));
    for (const country of state.countries) {
      $("trip-country").add(new Option(`${flag(country)} ${country.name}`, country.id));
    }
    createMap();
    createStadiumMap();
    renderStats();
    renderCountries();
    renderMap();
    renderTrips();
    renderStadiums();
    renderStadiumMap();
    bindEvents();
    $("new-trip").disabled = false;
  } catch (error) {
    console.error("Dashboard startup failed:", error);
    $("global-error").textContent = `${error.message} Reload this page to try again.`;
    $("global-error").hidden = false;
  }
}

initialize();
