"use strict";

const $ = (id) => document.getElementById(id);
const KIND_LABELS = { marathon: "Marathon", half: "Half-marathon", "10k": "10k", "5.6k": "5.6k", other: "Other" };
const KIND_ORDER = ["marathon", "half", "10k", "5.6k", "other"];
const state = {
  races: [], catalog: [], status: "all", kind: "", series: "", query: "", deleting: null,
  training: {}, strava: { count: 0, last_synced: null }, sport: "runs", between: null, betweenToken: 0,
};
let toastTimer;

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
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

function formatDate(value) {
  if (!value) return "No date yet";
  const [year, month, day] = value.split("-").map(Number);
  const options = { month: "short", year: "numeric", timeZone: "UTC" };
  if (day) options.day = "numeric";
  return new Date(Date.UTC(year, month - 1, day || 1)).toLocaleDateString(undefined, options);
}

function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function formatPace(seconds, km) {
  const perKm = Math.round(seconds / km);
  return `${Math.floor(perKm / 60)}:${String(perKm % 60).padStart(2, "0")} /km`;
}

function formatKm(km) {
  return `${Number(km.toFixed(2))} km`;
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  return hours ? `${hours} h ${minutes} m` : `${Math.floor(seconds / 60)} m`;
}

function formatDay(value) {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function trainingStats(training) {
  const totals = training[state.sport];
  const noun = state.sport === "runs" ? "runs" : "activities";
  if (!totals.count) return `<p class="training-empty">No ${noun} found in this period.</p>`;
  const cells = [
    [`${totals.distance_km} km`, "distance"],
    [totals.count, noun],
    [formatDuration(totals.moving_seconds), "moving time"],
    totals.pace_seconds_per_km ? [formatPace(totals.pace_seconds_per_km, 1), "average pace"] : null,
    [`${totals.elevation_m.toLocaleString()} m`, "elevation gain"],
    [`${totals.longest_km} km`, state.sport === "runs" ? "longest run" : "longest activity"],
    [`${totals.weekly_avg_km} km`, "per week"],
    [`${totals.peak_week_km} km`, "peak week"],
  ].filter(Boolean);
  return `<div class="training-grid">${cells.map(([value, label]) => `<div><strong>${escapeHTML(value)}</strong><span>${label}</span></div>`).join("")}</div>`;
}

function trainingBlock(race) {
  const training = state.training[race.id];
  if (!training) return "";
  const days = `${training.days} days`;
  const heading = training.so_far
    ? `Training since ${training.since.title} (${days} so far)`
    : `Training since ${training.since.title} (${days})`;
  const approx = training.approximate ? '<small class="training-approx">A race known only by its month is counted from mid-month.</small>' : "";
  return `<div class="training"><h4>${escapeHTML(heading)}</h4>${trainingStats(training)}${approx}</div>`;
}

function badge(race) {
  return `${Number(race.distance_km.toFixed(1))}k`;
}

function monthIndex(value) {
  const [year, month] = value.split("-").map(Number);
  return year * 12 + month - 1;
}

function currentMonth() {
  const now = new Date();
  return now.getFullYear() * 12 + now.getMonth();
}

// A planned race whose month has passed needs updating rather than a countdown.
function isOverdue(race) {
  return race.status === "planned" && race.race_date && monthIndex(race.race_date) < currentMonth();
}

function countdown(race) {
  const months = monthIndex(race.race_date) - currentMonth();
  if (race.race_date.length === 10) {
    const days = Math.ceil((new Date(`${race.race_date}T00:00:00`) - new Date().setHours(0, 0, 0, 0)) / 864e5);
    if (days === 0) return "today";
    if (days === 1) return "tomorrow";
    if (days > 1 && days <= 60) return `in ${days} days`;
  }
  if (months === 0) return "this month";
  if (months === 1) return "next month";
  return `in ${months} months`;
}

function byDateAsc(a, b) {
  return (a.race_date || "9999").localeCompare(b.race_date || "9999") || a.title.localeCompare(b.title);
}

function seriesLabel(key) {
  return state.catalog.find((item) => item.key === key)?.label || key;
}

function matches(race) {
  const text = `${race.title} ${race.city} ${race.country}`.toLocaleLowerCase();
  return (state.status === "all" || race.status === state.status)
    && (!state.kind || race.kind === state.kind)
    && (!state.series || race.series.includes(state.series))
    && (!state.query || text.includes(state.query));
}

function renderSeries() {
  $("series-list").innerHTML = state.catalog.map((item) => {
    const races = state.races.filter((race) => race.series.includes(item.key));
    const count = (status) => races.filter((race) => race.status === status).length;
    const run = count("run");
    const planned = count("planned");
    const wishlist = count("wishlist");
    const untracked = Math.max(0, item.total - races.length);
    const note = [
      planned ? `${planned} planned` : "",
      wishlist ? `${wishlist} on your wishlist` : "",
      untracked ? `${untracked} not on your list` : "",
    ].filter(Boolean).join(" · ") || "Complete";
    return `<button class="series-card ${state.series === item.key ? "active" : ""}" data-series="${escapeHTML(item.key)}" aria-pressed="${state.series === item.key}">
      <span class="series-name">${escapeHTML(item.label)}</span>
      <span class="series-count">${run}<small> / ${item.total} run</small></span>
      <span class="series-note">${escapeHTML(note)}</span>
      <span class="series-bar" aria-hidden="true"><span class="done" data-width="${run / item.total * 100}"></span><span class="soon" data-width="${planned / item.total * 100}"></span></span>
    </button>`;
  }).join("");
  // Widths are set through the DOM because the page's CSP blocks inline style attributes.
  $("series-list").querySelectorAll("[data-width]").forEach((bar) => { bar.style.width = `${bar.dataset.width}%`; });
}

function renderStats() {
  const run = state.races.filter((race) => race.status === "run");
  const planned = state.races.filter((race) => race.status === "planned");
  const wishlist = state.races.filter((race) => race.status === "wishlist");
  const km = run.reduce((total, race) => total + race.distance_km, 0);
  const countries = new Set(run.map((race) => race.country).filter(Boolean));
  const longRaces = run.filter((race) => race.kind === "marathon" || race.kind === "half").length;
  $("stat-run").textContent = run.length;
  $("stat-run-note").textContent = longRaces ? `${longRaces} half or full marathon${longRaces === 1 ? "" : "s"}` : "";
  $("stat-km").textContent = Number(km.toFixed(1));
  $("stat-km-note").textContent = countries.size ? `${countries.size} ${countries.size === 1 ? "country" : "countries"} with a known location` : "";
  $("stat-planned").textContent = planned.length;
  $("stat-planned-note").textContent = planned.filter(isOverdue).length ? "some dates have passed" : "";
  $("stat-wishlist").textContent = wishlist.length;
  $("stat-wishlist-note").textContent = "races you want to run";
  const next = planned.filter((race) => !isOverdue(race)).sort(byDateAsc)[0];
  $("stat-next").textContent = next ? next.title : "Nothing planned";
  $("stat-next-note").textContent = next ? `${formatDate(next.race_date)} · ${countdown(next)}` : "Plan one from your wishlist";
}

function renderPersonalBests() {
  const bests = KIND_ORDER.map((kind) => {
    const timed = state.races.filter((race) => race.status === "run" && race.kind === kind && race.finish_seconds);
    return timed.sort((a, b) => a.finish_seconds - b.finish_seconds)[0];
  }).filter(Boolean);
  $("pb-list").innerHTML = bests.length
    ? bests.map((race) => `<div class="pb"><span>${escapeHTML(KIND_LABELS[race.kind])}</span><strong>${formatTime(race.finish_seconds)}</strong><small>${formatPace(race.finish_seconds, race.distance_km)} · ${escapeHTML(formatDate(race.race_date))}</small></div>`).join("")
    : '<p class="pb-empty">Add finish times to the races you have run and your personal bests will appear here.</p>';
}

function raceCard(race) {
  const place = [race.city, race.country].filter(Boolean).join(", ");
  const meta = [place, formatDate(race.race_date), formatKm(race.distance_km)].filter(Boolean).join(" · ");
  const result = race.finish_seconds
    ? `<p class="race-result">${formatTime(race.finish_seconds)} · ${formatPace(race.finish_seconds, race.distance_km)}</p>` : "";
  const overdue = isOverdue(race) ? '<span class="flag">Date has passed — mark as run or update it</span>' : "";
  const tags = race.series.length
    ? `<div class="tags">${race.series.map((key) => `<span class="tag tag-${escapeHTML(key)}">${escapeHTML(seriesLabel(key))}</span>`).join("")}</div>` : "";
  const primary = race.status === "planned"
    ? `<button class="button small" data-promote="run" data-id="${escapeHTML(race.id)}">Mark as run</button>`
    : race.status === "wishlist"
      ? `<button class="button small" data-promote="planned" data-id="${escapeHTML(race.id)}">Plan it</button>` : "";
  return `<article class="race-card ${race.status}">
    <div class="race-kind" aria-hidden="true">${badge(race)}</div>
    <div class="race-body"><h3>${escapeHTML(race.title)}</h3><p class="race-meta">${escapeHTML(meta)}</p>${tags}${result}${race.notes ? `<p class="race-note">${escapeHTML(race.notes)}</p>` : ""}${overdue}${trainingBlock(race)}</div>
    <div class="race-actions">${primary}<button class="button small" data-edit="${escapeHTML(race.id)}">Edit</button><button class="text-button" data-delete="${escapeHTML(race.id)}" aria-label="Delete ${escapeHTML(race.title)}">Delete</button></div>
  </article>`;
}

function renderRaces() {
  const sections = [
    ["planned", "Planned", (a, b) => byDateAsc(a, b)],
    ["run", "Run", (a, b) => byDateAsc(b, a)],
    ["wishlist", "Wishlist", (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.title.localeCompare(b.title)],
  ];
  const html = sections.map(([status, label, sorter]) => {
    const races = state.races.filter((race) => race.status === status && matches(race)).sort(sorter);
    if (!races.length) return "";
    return `<div class="section-title"><h2>${label}</h2><span>${races.length} ${races.length === 1 ? "race" : "races"}</span></div>
      <div class="race-list">${races.map(raceCard).join("")}</div>`;
  }).join("");
  $("race-sections").innerHTML = html || '<div class="empty-state"><h3>No races here.</h3><p>Try another filter or add a race.</p></div>';
  document.querySelectorAll("[data-status]").forEach((button) => {
    button.classList.toggle("active", button.dataset.status === state.status);
    button.setAttribute("aria-pressed", button.dataset.status === state.status ? "true" : "false");
  });
}

function formatAgo(timestamp) {
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - timestamp) / 60));
  if (minutes < 2) return "just now";
  if (minutes < 120) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

function renderSyncNote() {
  const { count, last_synced: synced } = state.strava;
  $("sync-note").innerHTML = count
    ? `Strava: ${count.toLocaleString()} activities cached${synced ? ` · synced ${formatAgo(synced)}` : ""}.`
    : 'Strava has not been synced yet. Connect it on the <a href="activities/">Activities tab</a>, then press Sync Strava to see how you trained between races.';
  $("between").hidden = !count;
}

function fillBetween() {
  const dated = state.races.filter((race) => race.race_date && race.status !== "wishlist").sort(byDateAsc);
  const label = (race) => `${race.title} · ${formatDate(race.race_date)}`;
  const kept = { from: $("between-from").value, to: $("between-to").value };
  $("between-from").replaceChildren(...dated.map((race) => new Option(label(race), race.id)));
  $("between-to").replaceChildren(new Option("today", ""), ...dated.map((race) => new Option(label(race), race.id)));
  const lastRun = dated.filter((race) => race.status === "run").at(-1);
  $("between-from").value = dated.some((race) => race.id === kept.from) ? kept.from : lastRun?.id || dated[0]?.id || "";
  $("between-to").value = dated.some((race) => race.id === kept.to) ? kept.to : "";
}

function renderBetween() {
  const data = state.between;
  if (!data) { $("between-result").innerHTML = ""; return; }
  if (data.error) { $("between-result").innerHTML = `<p class="training-empty">${escapeHTML(data.error)}</p>`; return; }
  const approx = data.approximate ? '<small class="training-approx">A race known only by its month is counted from mid-month.</small>' : "";
  $("between-result").innerHTML = `<h4>${escapeHTML(formatDay(data.start))} – ${escapeHTML(formatDay(data.end))} · ${data.days} days</h4>${trainingStats(data)}${approx}`;
}

async function loadBetween() {
  const token = ++state.betweenToken;
  const from = $("between-from").value;
  const to = $("between-to").value;
  if (!from) { state.between = null; renderBetween(); return; }
  let data;
  try {
    data = await api(`api/training?from=${encodeURIComponent(from)}${to ? `&to=${encodeURIComponent(to)}` : ""}`);
  } catch (error) {
    data = { error: error.message };
  }
  if (token !== state.betweenToken) return;
  state.between = data;
  renderBetween();
}

async function loadRaces() {
  const data = await api("api/races");
  state.races = data.races;
  state.catalog = data.series_catalog;
  state.training = data.training;
  state.strava = data.strava;
  render();
  fillBetween();
  await loadBetween();
}

async function syncStrava() {
  const button = $("sync-strava");
  button.disabled = true;
  button.textContent = "Syncing…";
  try {
    const result = await api("activities/api/sync", "POST", {});
    await loadRaces();
    notify(result.complete
      ? `Strava synced: ${result.cache.count.toLocaleString()} activities.`
      : "Synced part of your history. Press Sync Strava again to continue.");
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "↻ Sync Strava";
  }
}

function render() {
  renderStats();
  renderSeries();
  renderPersonalBests();
  renderRaces();
  renderSyncNote();
}

function syncForm() {
  $("distance-field").hidden = $("race-kind").value !== "other";
  $("race-distance").required = $("race-kind").value === "other";
  const canFinish = $("race-status").value === "run";
  $("finish-field").hidden = !canFinish;
  if (!canFinish) $("race-finish").value = "";
}

function openRace(race = null, status = null) {
  $("race-form").reset();
  $("race-id").value = race?.id || "";
  $("race-dialog-title").textContent = race ? "Edit race" : "Add a race";
  $("race-title").value = race?.title || "";
  $("race-city").value = race?.city || "";
  $("race-country").value = race?.country || "";
  $("race-kind").value = race?.kind || "half";
  $("race-distance").value = race?.kind === "other" ? race.distance_km : "";
  $("race-status").value = status || race?.status || "planned";
  $("race-date").value = race?.race_date || "";
  $("race-finish").value = race?.finish_seconds ? formatTime(race.finish_seconds) : "";
  $("race-notes").value = race?.notes || "";
  document.querySelectorAll("#series-options input").forEach((box) => {
    box.checked = Boolean(race?.series.includes(box.value));
  });
  $("race-error").hidden = true;
  syncForm();
  $("race-dialog").showModal();
}

async function submitRace(event) {
  event.preventDefault();
  const id = $("race-id").value;
  $("save-race").disabled = true;
  $("race-error").hidden = true;
  try {
    await api(id ? `api/races/${encodeURIComponent(id)}` : "api/races", id ? "PUT" : "POST", {
      title: $("race-title").value, city: $("race-city").value, country: $("race-country").value,
      kind: $("race-kind").value, distance_km: $("race-distance").value,
      status: $("race-status").value, race_date: $("race-date").value,
      finish_time: $("race-finish").value, notes: $("race-notes").value,
      series: [...document.querySelectorAll("#series-options input:checked")].map((box) => box.value),
    });
    await loadRaces();
    $("race-dialog").close();
    notify(id ? "Race updated." : "Race added.");
  } catch (error) {
    $("race-error").textContent = error.message;
    $("race-error").hidden = false;
  } finally {
    $("save-race").disabled = false;
  }
}

function bindEvents() {
  document.querySelectorAll("[data-status]").forEach((button) => {
    button.addEventListener("click", () => { state.status = button.dataset.status; renderRaces(); });
  });
  $("kind-filter").addEventListener("change", (event) => { state.kind = event.target.value; renderRaces(); });
  $("series-filter").addEventListener("change", (event) => {
    state.series = event.target.value;
    renderSeries();
    renderRaces();
  });
  $("series-list").addEventListener("click", (event) => {
    const card = event.target.closest("[data-series]");
    if (!card) return;
    state.series = state.series === card.dataset.series ? "" : card.dataset.series;
    $("series-filter").value = state.series;
    renderSeries();
    renderRaces();
  });
  $("search").addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLocaleLowerCase();
    renderRaces();
  });
  $("new-race").addEventListener("click", () => openRace());
  $("sync-strava").addEventListener("click", syncStrava);
  $("between-from").addEventListener("change", loadBetween);
  $("between-to").addEventListener("change", loadBetween);
  document.querySelectorAll("[data-sport]").forEach((button) => {
    button.addEventListener("click", () => {
      state.sport = button.dataset.sport;
      document.querySelectorAll("[data-sport]").forEach((other) => {
        other.classList.toggle("active", other === button);
        other.setAttribute("aria-pressed", other === button ? "true" : "false");
      });
      renderRaces();
      renderBetween();
    });
  });
  $("close-race").addEventListener("click", () => $("race-dialog").close());
  $("race-kind").addEventListener("change", syncForm);
  $("race-status").addEventListener("change", syncForm);
  $("race-form").addEventListener("submit", submitRace);
  $("race-sections").addEventListener("click", (event) => {
    const edit = event.target.closest("[data-edit]");
    const promote = event.target.closest("[data-promote]");
    const remove = event.target.closest("[data-delete]");
    if (edit) openRace(state.races.find((race) => race.id === edit.dataset.edit));
    if (promote) openRace(state.races.find((race) => race.id === promote.dataset.id), promote.dataset.promote);
    if (remove) {
      const race = state.races.find((item) => item.id === remove.dataset.delete);
      state.deleting = race.id;
      $("delete-name").textContent = race.title;
      $("delete-dialog").showModal();
    }
  });
  $("cancel-delete").addEventListener("click", () => $("delete-dialog").close());
  $("confirm-delete").addEventListener("click", async () => {
    $("confirm-delete").disabled = true;
    const id = state.deleting;
    try {
      await api(`api/races/${encodeURIComponent(id)}`, "DELETE");
      await loadRaces();
      notify("Race deleted.");
    } catch (error) {
      notify(error.message, true);
    } finally {
      $("delete-dialog").close();
      $("confirm-delete").disabled = false;
    }
  });
}

async function initialize() {
  try {
    const data = await api("api/races");
    state.catalog = data.series_catalog;
    for (const item of state.catalog) {
      $("series-filter").add(new Option(item.label, item.key));
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = item.key;
      label.append(box, item.label);
      $("series-options").append(label);
    }
    bindEvents();
    await loadRaces();
    $("new-race").disabled = false;
    $("sync-strava").disabled = false;
  } catch (error) {
    console.error("Startup failed:", error);
    $("global-error").textContent = `${error.message} Reload this page to try again.`;
    $("global-error").hidden = false;
  }
}

initialize();
