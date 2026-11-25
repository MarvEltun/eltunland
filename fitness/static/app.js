"use strict";

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const RING = 2 * Math.PI * 52;
const ICONS = { run: "🏃", walk: "🚶", cycle: "🚴", swim: "🏊", gym: "🏋️", yoga: "🧘", hike: "🥾", other: "✨" };
const state = { workouts: [], goal: 150, kinds: [], shown: 12, deleting: null };
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
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, error ? 7000 : 2800);
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
    throw new Error("Cannot reach your local server. Check that it is still running.");
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

// Dates are handled as local YYYY-MM-DD strings so weeks match the user's calendar.
const dayString = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const addDays = (date, days) => { const next = new Date(date); next.setDate(next.getDate() + days); return next; };
const mondayOf = (date) => addDays(date, -((date.getDay() + 6) % 7));
const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] || 0), 0);
const between = (start, end) => state.workouts.filter((workout) => workout.day >= dayString(start) && workout.day <= dayString(end));

function streak() {
  const days = new Set(state.workouts.map((workout) => workout.day));
  const today = new Date();
  let cursor = days.has(dayString(today)) ? today : addDays(today, -1);
  let count = 0;
  while (days.has(dayString(cursor))) { count += 1; cursor = addDays(cursor, -1); }
  return count;
}

function formatDay(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

function weekMessage(minutes) {
  const left = state.goal - minutes;
  if (left <= 0) return `Goal reached with ${minutes - state.goal} minutes to spare. Enjoy your rest days!`;
  if (minutes === 0) return `A fresh week: ${state.goal} minutes to go. Even a short walk counts.`;
  return `${left} more minute${left === 1 ? "" : "s"} to reach your goal.`;
}

function svg(tag, attributes, text) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderSummary() {
  const today = new Date();
  const monday = mondayOf(today);
  const minutes = sum(between(monday, today), "minutes");
  const percent = Math.min(100, Math.round(minutes / state.goal * 100));
  $("week-minutes").textContent = minutes;
  $("goal-minutes").textContent = state.goal;
  $("ring-percent").textContent = `${percent}%`;
  $("ring-value").setAttribute("stroke-dasharray", `${RING * percent / 100} ${RING}`);
  $("ring-value").classList.toggle("done", minutes >= state.goal);
  $("week-message").textContent = weekMessage(minutes);
  const run = streak();
  $("streak").textContent = run;
  $("streak-note").textContent = run === 1 ? "day in a row" : "days in a row";
  const month = between(new Date(today.getFullYear(), today.getMonth(), 1), today);
  $("month-count").textContent = month.length;
  $("month-distance").textContent = Number(sum(month, "distance_km").toFixed(1));
}

function renderChart() {
  const chart = $("weeks-chart");
  chart.replaceChildren();
  const monday = mondayOf(new Date());
  const weeks = Array.from({ length: 8 }, (_, index) => {
    const start = addDays(monday, -7 * (7 - index));
    return { start, minutes: sum(between(start, addDays(start, 6)), "minutes") };
  });
  const [width, height, left, top, bottom] = [640, 220, 12, 22, 28];
  const max = Math.max(state.goal * 1.15, ...weeks.map((week) => week.minutes));
  const y = (value) => top + (1 - value / max) * (height - top - bottom);
  const slot = (width - left * 2) / weeks.length;
  weeks.forEach((week, index) => {
    const barHeight = Math.max(2, height - bottom - y(week.minutes));
    const classes = ["bar", index === 7 ? "current" : "", week.minutes >= state.goal ? "met" : ""].join(" ").trim();
    chart.append(svg("rect", { class: classes, x: left + index * slot + slot * 0.18, y: height - bottom - barHeight, width: slot * 0.64, height: barHeight, rx: 8 }));
    chart.append(svg("text", { class: "value-label", x: left + index * slot + slot / 2, y: height - bottom - barHeight - 6, "text-anchor": "middle" }, week.minutes));
    chart.append(svg("text", { class: "axis-label", x: left + index * slot + slot / 2, y: height - 8, "text-anchor": "middle" },
      week.start.toLocaleDateString(undefined, { day: "numeric", month: "short" })));
  });
  chart.append(svg("line", { class: "goal-line", x1: left, x2: width - left, y1: y(state.goal), y2: y(state.goal) }));
}

function workoutCard(workout) {
  const facts = [`${workout.minutes} min`];
  if (workout.distance_km) facts.push(`${workout.distance_km} km`);
  const dots = [1, 2, 3, 4, 5].map((level) => `<i class="${level <= workout.effort ? "on" : ""}"></i>`).join("");
  return `<article class="workout">
    <div class="kind" aria-hidden="true">${ICONS[workout.kind] || ICONS.other}</div>
    <div class="workout-body"><h3>${escapeHTML(workout.kind)}</h3>
      <p class="workout-meta">${escapeHTML(formatDay(workout.day))} · ${escapeHTML(facts.join(" · "))}<span class="effort" title="Effort ${workout.effort} of 5">${dots}</span></p>
      ${workout.notes ? `<p class="workout-note">${escapeHTML(workout.notes)}</p>` : ""}</div>
    <div class="workout-actions"><button class="button small" data-edit="${escapeHTML(workout.id)}">Edit</button><button class="text-button" data-delete="${escapeHTML(workout.id)}" aria-label="Delete ${escapeHTML(workout.kind)} on ${escapeHTML(workout.day)}">Delete</button></div>
  </article>`;
}

function renderList() {
  const shown = state.workouts.slice(0, state.shown);
  $("workout-list").innerHTML = shown.length ? shown.map(workoutCard).join("")
    : '<div class="empty">No workouts yet. Log your first one to start your streak.</div>';
  $("workout-count").textContent = state.workouts.length ? `${state.workouts.length} logged` : "";
  $("show-more").hidden = state.workouts.length <= state.shown;
}

function render() {
  renderSummary();
  renderChart();
  renderList();
}

function openWorkout(workout = null) {
  $("workout-form").reset();
  $("workout-id").value = workout?.id || "";
  $("workout-dialog-title").textContent = workout ? "Edit workout" : "Log a workout";
  $("workout-day").value = workout?.day || dayString(new Date());
  $("workout-day").max = dayString(new Date());
  $("workout-kind").value = workout?.kind || "run";
  $("workout-minutes").value = workout?.minutes || "";
  $("workout-distance").value = workout?.distance_km ?? "";
  $("workout-effort").value = workout?.effort || 3;
  $("workout-notes").value = workout?.notes || "";
  $("workout-error").hidden = true;
  $("workout-dialog").showModal();
}

async function submitWorkout(event) {
  event.preventDefault();
  const id = $("workout-id").value;
  $("save-workout").disabled = true;
  $("workout-error").hidden = true;
  try {
    const distance = $("workout-distance").value;
    const saved = await api(id ? `api/workouts/${encodeURIComponent(id)}` : "api/workouts", id ? "PUT" : "POST", {
      day: $("workout-day").value, kind: $("workout-kind").value,
      minutes: Number($("workout-minutes").value), distance_km: distance === "" ? null : Number(distance),
      effort: Number($("workout-effort").value), notes: $("workout-notes").value,
    });
    state.workouts = [...state.workouts.filter((item) => item.id !== saved.id), saved]
      .sort((a, b) => b.day.localeCompare(a.day));
    $("workout-dialog").close();
    render();
    notify(id ? "Workout updated." : "Workout logged. Nice work!");
  } catch (error) {
    $("workout-error").textContent = error.message;
    $("workout-error").hidden = false;
  } finally {
    $("save-workout").disabled = false;
  }
}

async function submitGoal(event) {
  event.preventDefault();
  $("goal-error").hidden = true;
  try {
    const result = await api("api/goal", "PUT", { minutes: Number($("goal-input").value) });
    state.goal = result.goal_minutes;
    $("goal-dialog").close();
    render();
    notify("Weekly goal updated.");
  } catch (error) {
    $("goal-error").textContent = error.message;
    $("goal-error").hidden = false;
  }
}

function bindEvents() {
  $("new-workout").addEventListener("click", () => openWorkout());
  $("close-workout").addEventListener("click", () => $("workout-dialog").close());
  $("workout-form").addEventListener("submit", submitWorkout);
  $("edit-goal").addEventListener("click", () => { $("goal-input").value = state.goal; $("goal-error").hidden = true; $("goal-dialog").showModal(); });
  $("close-goal").addEventListener("click", () => $("goal-dialog").close());
  $("goal-form").addEventListener("submit", submitGoal);
  $("show-more").addEventListener("click", () => { state.shown += 20; renderList(); });
  $("workout-list").addEventListener("click", (event) => {
    const edit = event.target.closest("[data-edit]");
    const remove = event.target.closest("[data-delete]");
    if (edit) openWorkout(state.workouts.find((item) => item.id === edit.dataset.edit));
    if (remove) {
      const workout = state.workouts.find((item) => item.id === remove.dataset.delete);
      state.deleting = workout.id;
      $("delete-name").textContent = `${workout.kind} on ${formatDay(workout.day)}`;
      $("delete-dialog").showModal();
    }
  });
  $("cancel-delete").addEventListener("click", () => $("delete-dialog").close());
  $("confirm-delete").addEventListener("click", async () => {
    $("confirm-delete").disabled = true;
    try {
      await api(`api/workouts/${encodeURIComponent(state.deleting)}`, "DELETE");
      state.workouts = state.workouts.filter((item) => item.id !== state.deleting);
      render();
      notify("Workout deleted.");
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
    const data = await api("api/workouts");
    Object.assign(state, { workouts: data.workouts, goal: data.goal_minutes, kinds: data.kinds });
    for (const kind of state.kinds) $("workout-kind").add(new Option(`${ICONS[kind]} ${kind[0].toUpperCase()}${kind.slice(1)}`, kind));
    bindEvents();
    render();
    $("new-workout").disabled = false;
  } catch (error) {
    console.error("Startup failed:", error);
    $("global-error").textContent = `${error.message} Reload this page to try again.`;
    $("global-error").hidden = false;
  }
}

initialize();
