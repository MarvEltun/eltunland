import { sportName, formatDate, duration, metric, pace, filterPage, decodePolyline, project, routeGeometry } from "./model.js";
import { renderDashboard } from "./dashboard.js";

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const state = { configured: false, connected: false, tokenOnly: false, fromEnvironment: false, cache: { count: 0, last_synced: null }, view: "dashboard", days: 365, listLoaded: false, activities: [], page: 1, hasMore: false, selected: null, busy: false, generation: 0, loadError: false };
let detailRequest = null;
let camera = [0, 0, 1000, 500];
let fittedCamera = [...camera];
let drag = null;

function node(tag, attrs = {}, text = "") {
  const result = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) result.setAttribute(key, value);
  result.textContent = text;
  return result;
}

function message(id, text) {
  $(id).textContent = text;
  $(id).hidden = !text;
}

function clearActivities() {
  state.generation++;
  state.listLoaded = false;
  detailRequest?.abort();
  state.activities = [];
  state.selected = null;
  $("activity-list").replaceChildren();
  $("detail-content").hidden = true;
  $("detail-empty").hidden = false;
  $("detail-empty").querySelector("h2").textContent = "A day worth revisiting.";
  $("detail-empty").querySelector("p").textContent = "Select an activity to see its route and details.";
  for (const id of ["detail-name", "detail-date", "description", "detail-sport"]) $(id).textContent = "";
  $("metrics").replaceChildren();
  $("extra-details").replaceChildren();
  $("route-line").setAttribute("d", "");
  $("route-start").setAttribute("hidden", "");
  $("route-end").setAttribute("hidden", "");
  for (const id of ["route-start", "route-end"]) {
    $(id).removeAttribute("cx");
    $(id).removeAttribute("cy");
  }
  camera = [0, 0, 1000, 500];
  fittedCamera = [...camera];
  updateCamera();
  $("strava-link").removeAttribute("href");
  $("welcome").textContent = "A run before sunrise. A ride with no destination. Your activities, in one place.";
  $("avatar").textContent = "YOU";
  $("rate-note").textContent = "";
}

function renderConnection() {
  $("connection-label").textContent = state.connected ? state.tokenOnly ? "Connected · temporary token" : "Connected to Strava" : state.configured ? "Ready to authorize" : "Not connected";
  $("connection-dot").classList.toggle("connected", state.connected);
  $("connect").textContent = state.connected ? "Connection settings" : state.configured ? "Authorize with Strava ↗" : "Set up Strava ↗";
  $("connect").disabled = false;
  $("refresh").hidden = !state.connected || state.view !== "explorer";
  $("explorer").hidden = !state.connected || state.view !== "explorer";
  $("dashboard").hidden = !state.connected || state.view !== "dashboard";
  $("connected-bar").hidden = !state.connected;
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  $("onboarding").hidden = state.connected;
  $("setup-section").hidden = state.configured || state.connected || state.fromEnvironment;
  $("configured-section").hidden = !state.configured || state.connected;
  $("disconnect-section").hidden = !state.configured && !state.connected;
  $("token-section").hidden = state.connected;
  $("token-only-note").hidden = !state.connected || !state.tokenOnly;
  renderCache();
  $("client-secret").value = "";
  $("access-token").value = "";
}

function renderCache() {
  const { count, last_synced: synced } = state.cache;
  $("cache-note").textContent = count
    ? `${count.toLocaleString()} activity summaries saved for My Runs' training totals${synced ? ` · synced ${new Date(synced * 1000).toLocaleString()}` : ""}.`
    : "Sync once so My Runs can show how much you trained between races. Only date, sport, distance, time and elevation are saved.";
  $("sync-cache").hidden = !state.connected;
  $("cache-note").hidden = !state.connected;
}

async function syncCache() {
  $("sync-cache").disabled = true;
  $("sync-cache").textContent = "Syncing…";
  message("error", "");
  try {
    const result = await api("api/sync", "POST", {});
    state.cache = result.cache;
    renderCache();
    await loadDashboard();
    message("notice", result.complete
      ? `Synced ${result.cache.count.toLocaleString()} activities. See the Races tab for your training totals.`
      : "Synced part of your history. Press sync again to continue.");
  } catch (error) { message("error", error.message); }
  finally {
    $("sync-cache").disabled = false;
    $("sync-cache").textContent = "↻ Sync for training stats";
  }
}

function renderRate(rate = {}) {
  const limit = rate.read_limit || rate.overall_limit;
  const usage = rate.read_usage || rate.overall_usage;
  if (limit && usage) {
    $("rate-note").textContent = `Strava API: ${usage[0]} / ${limit[0]} requests this 15-minute window · ${usage[1]} / ${limit[1]} today (UTC). No background requests.`;
  }
}

class APIError extends Error {
  constructor(text, status) { super(text); this.status = status; }
}

async function api(url, method = "GET", data, signal) {
  let response;
  try {
    response = await fetch(url, {
      method, signal, cache: "no-store",
      headers: data === undefined ? {} : { "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new APIError("Cannot reach your local app. Check that the server is still running.", 0);
  }
  let result;
  try { result = await response.json(); }
  catch { throw new APIError(`The local server returned an unexpected response (${response.status}).`, response.status); }
  renderRate(result.rate);
  if (!response.ok) {
    if (response.status === 401) {
      clearActivities();
      state.connected = false;
      renderConnection();
    }
    throw new APIError(result.error || `Request failed (${response.status}).`, response.status);
  }
  return result;
}

function openSettings() {
  message("setup-error", "");
  message("connection-error", "");
  message("token-error", "");
  renderConnection();
  $("settings-dialog").showModal();
}

function sportIcon(sport) {
  if (/Ride|Bike/.test(sport)) return "↠";
  if (/Run|Walk|Hike/.test(sport)) return "↗";
  if (/Swim/.test(sport)) return "≈";
  return "✳";
}

function renderList() {
  const items = filterPage(state.activities, $("search").value, $("sport").value);
  $("activity-list").replaceChildren();
  for (const a of items) {
    const sport = a.sport_type || a.type;
    const button = node("button", { class: "activity-item", "aria-pressed": String(a.id === state.selected), "aria-label": `${a.name || "Untitled activity"}, ${formatDate(a.start_date_local || a.start_date)}` });
    const text = node("span", { class: "activity-text" });
    text.append(node("strong", {}, a.name || "Untitled activity"),
      node("small", {}, `${sportName(sport)} · ${formatDate(a.start_date_local || a.start_date)}`),
      node("small", { class: "activity-meta" }, `${metric(typeof a.distance === "number" ? a.distance / 1000 : null, 2, "km")} · ${duration(a.moving_time)}`));
    button.append(node("span", { class: "sport-icon", "aria-hidden": "true" }, sportIcon(sport)), text, node("span", { class: "activity-chevron", "aria-hidden": "true" }, "↗"));
    button.addEventListener("click", () => selectActivity(a.id));
    $("activity-list").append(button);
  }
  $("page-summary").textContent = `${items.length} shown · ${state.activities.length} loaded on this page`;
  $("empty-list").hidden = items.length > 0;
  $("empty-list").textContent = state.loadError ? "Could not load this page. Use Refresh page to retry." : state.activities.length ? "No activities match this page's filters." : state.page === 1 ? "No activities were returned. Add an activity in Strava or check your granted permissions." : "You've reached the end of the available activities. Go back to the previous page.";
  $("page-number").textContent = `Page ${state.page}`;
  $("previous").disabled = state.busy || state.page === 1;
  $("next").disabled = state.busy || !state.hasMore;
}

function updateCamera() {
  $("route-map").setAttribute("viewBox", camera.join(" "));
  const rect = $("route-map").getBoundingClientRect();
  const radius = Math.max(camera[2] / Math.max(1, rect.width), camera[3] / Math.max(1, rect.height)) * 4;
  for (const id of ["route-start", "route-end"]) $(id).setAttribute("r", radius);
}

function zoom(factor) {
  const [x, y, w, h] = camera;
  const width = Math.min(1400, Math.max(.002, w * factor)), ratio = width / w;
  camera = [x + w * (1 - ratio) / 2, y + h * (1 - ratio) / 2, width, h * ratio];
  updateCamera();
}

function renderRoute(encoded) {
  const geometry = routeGeometry(encoded ? decodePolyline(encoded) : []);
  const available = Boolean(geometry.path);
  $("no-route").hidden = available;
  $("map-label").hidden = !available;
  document.querySelector(".map-controls").hidden = !available;
  $("route-line").setAttribute("d", geometry.path);
  for (const [id, point] of [["route-start", geometry.start], ["route-end", geometry.end]]) {
    $(id).toggleAttribute("hidden", !point);
    if (point) { $(id).setAttribute("cx", point[0]); $(id).setAttribute("cy", point[1]); }
  }
  camera = geometry.bounds;
  fittedCamera = [...camera];
  updateCamera();
}

function renderDetail(a) {
  $("detail-content").hidden = false;
  $("detail-empty").hidden = true;
  $("detail-sport").textContent = sportName(a.sport_type || a.type);
  $("detail-name").textContent = a.name || "Untitled activity";
  const time = String(a.start_date_local || "").slice(11, 16);
  $("detail-date").textContent = `${formatDate(a.start_date_local || a.start_date)}${time ? " · " + time + " local" : ""}`;
  $("strava-link").href = `https://www.strava.com/activities/${a.id}`;
  $("description").textContent = a.description || "No description was provided for this activity.";
  const running = /Run|Walk|Hike/.test(a.sport_type || a.type);
  const fields = [
    ["Distance", metric(typeof a.distance === "number" ? a.distance / 1000 : null, 2, "km")],
    ["Moving time", duration(a.moving_time)],
    ["Elevation gain", metric(a.total_elevation_gain, 0, "m")],
    [running ? "Average pace" : "Average speed", running ? pace(a.average_speed) : metric(typeof a.average_speed === "number" ? a.average_speed * 3.6 : null, 1, "km/h")],
    ["Average heart rate", metric(a.average_heartrate, 0, "bpm")],
    ["Calories", metric(a.calories, 0, "kcal")],
  ];
  $("metrics").replaceChildren();
  for (const [label, value] of fields) {
    const item = node("div", { class: "metric" });
    item.append(node("label", {}, label), node("strong", { class: value === "Not provided" ? "missing" : "" }, value));
    $("metrics").append(item);
  }
  $("extra-details").replaceChildren();
  for (const [key, value] of [
    ["Elapsed time", duration(a.elapsed_time)], ["Gear", a.gear || "Not provided"],
    ["Device", a.device_name || "Not provided"], ["Visibility", a.visibility || "Not provided"],
    ["Average power", metric(a.average_watts, 0, "W")], ["Max heart rate", metric(a.max_heartrate, 0, "bpm")],
    ["Indoor", typeof a.trainer === "boolean" ? a.trainer ? "Yes" : "No" : "Not provided"],
  ]) {
    const item = node("div");
    item.append(node("dt", {}, key), node("dd", {}, value));
    $("extra-details").append(item);
  }
  renderRoute(a.polyline);
}

async function selectActivity(id) {
  detailRequest?.abort();
  const controller = new AbortController();
  detailRequest = controller;
  const generation = state.generation;
  state.selected = id;
  renderList();
  $("detail-content").hidden = true;
  $("detail-empty").hidden = false;
  $("detail-empty").querySelector("h2").textContent = "Revisiting your activity...";
  $("detail-empty").querySelector("p").textContent = "Loading the details directly from Strava.";
  $("activity-detail").setAttribute("aria-busy", "true");
  try {
    const result = await api(`api/activities/${id}`, "GET", undefined, controller.signal);
    if (generation !== state.generation || state.selected !== id) return;
    renderDetail(result.activity);
    message("error", "");
  } catch (error) {
    if (error.name === "AbortError") return;
    if (generation !== state.generation && error.status !== 401) return;
    message("error", error.message);
    if (error.status === 404) {
      state.activities = state.activities.filter((a) => a.id !== id);
      renderList();
    }
    $("detail-content").hidden = true;
    $("detail-empty").querySelector("h2").textContent = "Couldn't load this activity.";
    $("detail-empty").querySelector("p").textContent = "Choose another activity or select this one to retry.";
  } finally {
    if (detailRequest === controller) $("activity-detail").setAttribute("aria-busy", "false");
  }
}

async function loadPage(pageNumber) {
  if (state.busy) return;
  state.busy = true;
  state.page = pageNumber;
  state.loadError = false;
  const generation = ++state.generation;
  detailRequest?.abort();
  message("error", "");
  $("refresh").disabled = true;
  $("previous").disabled = true;
  $("next").disabled = true;
  $("page-summary").textContent = "Fetching a fresh page from Strava...";
  $("activity-list").replaceChildren();
  $("detail-content").hidden = true;
  $("detail-empty").hidden = false;
  $("detail-empty").querySelector("h2").textContent = "Loading your activities...";
  $("detail-empty").querySelector("p").textContent = "A fresh page, straight from Strava.";
  $("empty-list").hidden = true;
  state.activities = [];
  state.selected = null;
  try {
    const result = await api(`api/activities?page=${pageNumber}`);
    if (generation !== state.generation) return;
    state.activities = result.activities;
    state.page = result.page;
    state.hasMore = result.has_more;
    $("search").value = "";
    $("sport").replaceChildren(node("option", { value: "" }, "All sports on this page"));
    const sports = [...new Set(state.activities.map((a) => a.sport_type || a.type).filter(Boolean))].sort();
    for (const sport of sports) $("sport").append(node("option", { value: sport }, sportName(sport)));
    if (state.activities.length) await selectActivity(state.activities[0].id);
  } catch (error) {
    message("error", error.message);
    state.loadError = true;
    state.hasMore = false;
    $("detail-empty").querySelector("h2").textContent = "Let's try that again.";
    $("detail-empty").querySelector("p").textContent = "Use Refresh page to retry the request.";
  } finally {
    state.busy = false;
    $("refresh").disabled = false;
    renderList();
  }
}

async function authorize() {
  const button = $("authorize");
  button.disabled = true;
  try {
    const result = await api("api/connect", "POST", {});
    window.location.assign(result.url);
  } catch (error) {
    message($("settings-dialog").open ? "connection-error" : "error", error.message);
    button.disabled = false;
  }
}

async function disconnect(forgetOnly) {
  $("disconnect").disabled = true;
  $("forget").disabled = true;
  try {
    const result = await api("api/disconnect", "POST", forgetOnly ? { forget_only: true } : {});
    clearActivities();
    state.connected = false;
    state.configured = false;
    state.cache = { count: 0, last_synced: null };
    renderConnection();
    $("settings-dialog").close();
    message("error", "");
    message("notice", result.message + (result.revoked ? " Strava access has been revoked." : " Revoke access separately in your Strava settings."));
  } catch (error) {
    message("connection-error", error.message);
  } finally {
    $("disconnect").disabled = false;
    $("forget").disabled = false;
  }
}

async function loadDashboard() {
  let data;
  let races = [];
  try {
    [data, races] = await Promise.all([
      api(`api/dashboard?days=${state.days}`),
      fetch("../api/races", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { races: [] })).then((r) => r.races.filter((race) => race.status === "run" && race.race_date)).catch(() => []),
    ]);
  } catch (error) {
    message("error", error.message);
    return;
  }
  state.cache = data.cache;
  renderCache();
  $("dash-empty").hidden = !data.empty;
  $("dash-body").hidden = data.empty;
  if (!data.empty) renderDashboard(data, races);
}

async function showView(view) {
  state.view = view;
  renderConnection();
  if (view === "dashboard") await loadDashboard();
  else if (!state.listLoaded) {
    state.listLoaded = true;
    await loadPage(1);
  }
}

function installControls() {
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  document.querySelectorAll("[data-days]").forEach((button) => button.addEventListener("click", () => {
    state.days = Number(button.dataset.days);
    document.querySelectorAll("[data-days]").forEach((other) => other.classList.toggle("active", other === button));
    loadDashboard();
  }));
  for (const id of ["settings-button", "get-started"]) $(id).addEventListener("click", openSettings);
  $("connect").addEventListener("click", () => state.configured && !state.connected ? authorize() : openSettings());
  $("close-settings").addEventListener("click", () => { $("client-secret").value = ""; $("settings-dialog").close(); });
  $("settings-dialog").addEventListener("close", () => {
    $("client-secret").value = "";
    $("access-token").value = "";
  });
  $("authorize").addEventListener("click", authorize);
  $("disconnect").addEventListener("click", () => disconnect(false));
  $("forget").addEventListener("click", () => disconnect(true));
  $("setup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("save-settings").disabled = true;
    message("setup-error", "");
    try {
      const result = await api("api/setup", "POST", { client_id: $("client-id").value.trim(), client_secret: $("client-secret").value });
      state.configured = true;
      renderConnection();
      message("notice", result.message);
    } catch (error) { message("setup-error", error.message); }
    finally { $("save-settings").disabled = false; }
  });
  $("token-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("save-token").disabled = true;
    message("token-error", "");
    try {
      const result = await api("api/token", "POST", { access_token: $("access-token").value.trim() });
      $("access-token").value = "";
      state.connected = true;
      state.tokenOnly = true;
      renderConnection();
      $("settings-dialog").close();
      message("error", "");
      message("notice", result.message);
      clearActivities();
      await loadPage(1);
    } catch (error) { message("token-error", error.message); }
    finally { $("save-token").disabled = false; }
  });
  for (const id of ["privacy-link", "privacy-button"]) {
    $(id).addEventListener("click", (event) => { event.preventDefault(); $("privacy-dialog").showModal(); });
  }
  $("close-privacy").addEventListener("click", () => $("privacy-dialog").close());
  $("search").addEventListener("input", renderList);
  $("sport").addEventListener("change", renderList);
  $("previous").addEventListener("click", () => loadPage(state.page - 1));
  $("next").addEventListener("click", () => loadPage(state.page + 1));
  $("refresh").addEventListener("click", () => loadPage(state.page));
  $("sync-cache").addEventListener("click", syncCache);
  $("zoom-in").addEventListener("click", () => zoom(.7));
  $("zoom-out").addEventListener("click", () => zoom(1 / .7));
  $("fit-route").addEventListener("click", () => { camera = [...fittedCamera]; updateCamera(); });
  window.addEventListener("resize", updateCamera);
  const map = $("route-map");
  map.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, camera: [...camera] };
    map.setPointerCapture(event.pointerId);
  });
  map.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const rect = map.getBoundingClientRect();
    const scale = Math.max(camera[2] / rect.width, camera[3] / rect.height);
    camera = [drag.camera[0] - (event.clientX - drag.x) * scale, drag.camera[1] - (event.clientY - drag.y) * scale, ...drag.camera.slice(2)];
    updateCamera();
  });
  map.addEventListener("pointerup", () => { drag = null; });
  map.addEventListener("pointercancel", () => { drag = null; });
}

async function loadLand() {
  const response = await fetch("/shared/data/countries.geojson");
  if (!response.ok) throw new Error("Offline map outlines could not be loaded.");
  const world = await response.json();
  for (const feature of world.features) {
    if (feature.properties.CONTINENT === "Antarctica") continue;
    const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    const d = polygons.map((polygon) => polygon.map((ring) => ring.map((point, index) => {
      const [x, y] = project(point);
      return `${index ? "L" : "M"}${x},${y}`;
    }).join("") + "Z").join("")).join("");
    const shape = document.createElementNS(NS, "path");
    shape.setAttribute("d", d);
    shape.setAttribute("class", "land");
    shape.setAttribute("fill-rule", "evenodd");
    $("land").append(shape);
  }
}

installControls();
const notices = {
  success: "Connected. Your activities will be loaded directly from Strava.",
  denied: "Authorization was cancelled. No new connection was saved.",
  invalid_state: "This authorization link expired or did not match your browser. Start again from this app.",
  missing_permissions: "Strava did not grant the required read and activity:read_all permissions. Authorize again with the private-activity permission checked.",
  exchange_failed: "Could not finish authorization. Check your Client ID and Secret, then try again.",
  tls_failed: "The local server could not verify Strava’s HTTPS certificate. Configure Python’s trusted CA bundle (SSL_CERT_FILE), restart the server, then authorize again. Do not disable certificate verification.",
  unavailable: "The local server could not reach Strava. Check its internet or proxy connection, then authorize again. This is not a confirmed Client ID or Secret error.",
};
const notice = new URLSearchParams(location.search).get("connection");
if (notice) {
  message(notice === "success" ? "notice" : "error", notices[notice] || "Unexpected authorization response. Please reconnect.");
  history.replaceState(null, "", location.pathname);
}
try {
  const status = await api("api/status");
  state.configured = status.configured;
  state.connected = status.connected;
  state.tokenOnly = status.token_only;
  state.fromEnvironment = status.from_environment;
  state.cache = status.cache;
  renderConnection();
  await loadLand();
  if (state.connected) {
    await loadDashboard();
    const result = await api("api/profile");
    const p = result.profile;
    $("welcome").textContent = `${p.firstname ? "Welcome back, " + p.firstname + ". " : ""}Your activities, one adventure at a time.`;
    $("avatar").textContent = [p.firstname, p.lastname].filter(Boolean).map((s) => s[0]).join("").slice(0, 2) || "YOU";
  }
} catch (error) {
  $("connection-label").textContent = "Connection needs attention";
  message("error", error.message);
}

window.addEventListener("pagehide", clearActivities);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});
