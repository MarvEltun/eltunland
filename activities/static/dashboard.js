// Draws the Activities dashboard from /api/dashboard. Plain SVG, no libraries, no external requests.
import { sportName as sportLabel } from "./model.js";

const NS = "http://www.w3.org/2000/svg";
const RUN_COLOR = "#245e4b";
const OTHER_COLOR = "#bb944d";

function el(tag, attrs = {}, parent = null, text = "") {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text) node.textContent = text;
  parent?.append(node);
  return node;
}

function html(tag, attrs = {}, text = "", parent = null) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.textContent = text;
  parent?.append(node);
  return node;
}

function duration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours} h ${String(minutes).padStart(2, "0")} m` : `${minutes} m`;
}

function paceText(secondsPerKm) {
  return `${Math.floor(secondsPerKm / 60)}:${String(Math.round(secondsPerKm % 60)).padStart(2, "0")} /km`;
}

const short = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
const long = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const monthName = (month) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });

function niceMax(value) {
  const steps = [4, 8, 12, 20, 40, 60, 80, 100, 120, 160, 200, 240, 320, 400, 600, 800, 1000];
  return steps.find((step) => step >= value) ?? Math.ceil(value / 500) * 500;
}

function chart(container, width, height) {
  container.replaceChildren();
  return el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", class: "svg-chart" }, container);
}

function gridlines(svg, box, max, unit) {
  for (let step = 0; step <= 4; step++) {
    const y = box.top + (box.height * step) / 4;
    el("line", { x1: box.left, x2: box.left + box.width, y1: y, y2: y, class: "grid" }, svg);
    el("text", { x: box.left - 6, y: y + 3, class: "axis", "text-anchor": "end" }, svg, `${Math.round(max * (1 - step / 4))}${unit}`);
  }
}

function raceWeek(weeks, race) {
  const day = race.race_date.length === 7 ? `${race.race_date}-15` : race.race_date;
  let found = -1;
  weeks.forEach((week, index) => { if (week.start <= day) found = index; });
  return found >= 0 && Date.parse(`${day}T00:00:00Z`) - Date.parse(`${weeks[found].start}T00:00:00Z`) < 7 * 864e5 ? found : -1;
}

function weeklyChart(container, weeks, races) {
  const W = 900, H = 270, box = { left: 44, top: 18, width: 840, height: 214 };
  const svg = chart(container, W, H);
  const totals = weeks.map((week) => week.runs_km + week.other_km);
  const max = niceMax(Math.max(...totals, 1));
  gridlines(svg, box, max, "");
  const slot = box.width / weeks.length;
  const barWidth = Math.max(1.5, slot * 0.72);
  weeks.forEach((week, index) => {
    const x = box.left + index * slot + (slot - barWidth) / 2;
    const group = el("g", {}, svg);
    el("title", {}, group, `Week of ${long(week.start)}: ${(week.runs_km + week.other_km).toFixed(1)} km, ${week.count} ${week.count === 1 ? "activity" : "activities"}, ${duration(week.seconds)}`);
    const runsHeight = (week.runs_km / max) * box.height;
    const otherHeight = (week.other_km / max) * box.height;
    el("rect", { x, y: box.top + box.height - runsHeight, width: barWidth, height: runsHeight, fill: RUN_COLOR, rx: 1.5 }, group);
    el("rect", { x, y: box.top + box.height - runsHeight - otherHeight, width: barWidth, height: otherHeight, fill: OTHER_COLOR, rx: 1.5 }, group);
  });
  // Four-week average smooths out the rest weeks.
  const points = totals.map((_, index) => {
    const slice = totals.slice(Math.max(0, index - 3), index + 1);
    const average = slice.reduce((a, b) => a + b, 0) / slice.length;
    return `${box.left + index * slot + slot / 2},${box.top + box.height - (average / max) * box.height}`;
  });
  el("polyline", { points: points.join(" "), class: "trend" }, svg);
  let lastMonth = "";
  let lastLabelX = -Infinity;
  weeks.forEach((week, index) => {
    const month = week.start.slice(0, 7);
    const x = box.left + index * slot;
    if (month !== lastMonth && x - lastLabelX >= 44) {
      el("text", { x, y: H - 8, class: "axis" }, svg, monthName(month));
      lastLabelX = x;
    }
    lastMonth = month;
  });
  for (const race of races) {
    const index = raceWeek(weeks, race);
    if (index < 0) continue;
    const x = box.left + index * slot + slot / 2;
    const marker = el("g", {}, svg);
    el("title", {}, marker, `${race.title}, ${race.race_date}`);
    el("line", { x1: x, x2: x, y1: box.top - 4, y2: box.top + box.height, class: "race-line" }, marker);
    el("path", { d: `M${x},${box.top - 4}l9,4l-9,4z`, class: "race-flag" }, marker);
  }
}

function monthlyChart(container, months) {
  const W = 900, H = 270, box = { left: 44, top: 18, width: 790, height: 214 };
  const svg = chart(container, W, H);
  const max = niceMax(Math.max(...months.map((month) => month.runs_km), 1));
  gridlines(svg, box, max, "");
  const slot = box.width / months.length;
  const barWidth = Math.min(46, slot * 0.7);
  months.forEach((month, index) => {
    const x = box.left + index * slot + (slot - barWidth) / 2;
    const height = (month.runs_km / max) * box.height;
    const group = el("g", {}, svg);
    el("title", {}, group, `${monthName(month.month)}: ${month.runs_km} km running${month.run_pace_seconds_per_km ? ` at ${paceText(month.run_pace_seconds_per_km)}` : ""}`);
    el("rect", { x, y: box.top + box.height - height, width: barWidth, height, fill: RUN_COLOR, rx: 2, opacity: 0.85 }, group);
    el("text", { x: x + barWidth / 2, y: H - 8, class: "axis", "text-anchor": "middle" }, svg, monthName(month.month));
  });
  const paces = months.filter((month) => month.run_pace_seconds_per_km);
  if (paces.length) {
    const values = paces.map((month) => month.run_pace_seconds_per_km);
    const low = Math.min(...values) - 15;
    const high = Math.max(...values) + 15;
    // Faster pace is drawn higher.
    const y = (pace) => box.top + ((pace - low) / (high - low)) * box.height;
    const coordinates = months.map((month, index) => month.run_pace_seconds_per_km
      ? [box.left + index * slot + slot / 2, y(month.run_pace_seconds_per_km), month] : null);
    const path = coordinates.filter(Boolean);
    el("polyline", { points: path.map(([x, yy]) => `${x},${yy}`).join(" "), class: "pace-line" }, svg);
    for (const [x, yy, month] of path) {
      const dot = el("circle", { cx: x, cy: yy, r: 3.5, class: "pace-dot" }, svg);
      el("title", {}, dot, `${monthName(month.month)}: ${paceText(month.run_pace_seconds_per_km)}`);
    }
    for (const value of [low + 15, (low + high) / 2, high - 15]) {
      el("text", { x: box.left + box.width + 8, y: y(value) + 3, class: "axis pace-axis" }, svg, paceText(value).replace(" /km", ""));
    }
  }
}

function calendar(container, data) {
  const size = 14, gap = 3, left = 28, top = 18;
  const W = left + 53 * (size + gap), H = top + 7 * (size + gap) + 4;
  const svg = chart(container, W, H);
  const byDay = new Map(data.days.map((entry) => [entry.day, entry]));
  const start = Date.parse(`${data.start}T00:00:00Z`);
  const level = (seconds) => (seconds <= 0 ? 0 : seconds < 1800 ? 1 : seconds < 3600 ? 2 : seconds < 7200 ? 3 : 4);
  ["Mon", "Wed", "Fri"].forEach((label, index) => el("text", { x: 0, y: top + index * 2 * (size + gap) + 11 + (size + gap) * 0, class: "axis" }, svg, label));
  let lastMonth = -1;
  for (let week = 0; week < 53; week++) {
    for (let weekday = 0; weekday < 7; weekday++) {
      const date = new Date(start + (week * 7 + weekday) * 864e5);
      const iso = date.toISOString().slice(0, 10);
      if (Date.parse(`${iso}T00:00:00Z`) > Date.now()) continue;
      const entry = byDay.get(iso);
      const cell = el("rect", { x: left + week * (size + gap), y: top + weekday * (size + gap), width: size, height: size, rx: 3, class: `day lv${level(entry?.seconds || 0)}` }, svg);
      el("title", {}, cell, entry
        ? `${long(iso)}: ${entry.count} ${entry.count === 1 ? "activity" : "activities"} · ${entry.km} km · ${duration(entry.seconds)}`
        : `${long(iso)}: rest`);
      if (weekday === 0 && date.getUTCMonth() !== lastMonth && date.getUTCDate() <= 7) {
        el("text", { x: left + week * (size + gap), y: 11, class: "axis" }, svg, date.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" }));
        lastMonth = date.getUTCMonth();
      }
    }
  }
}

function weekdayChart(container, counts) {
  const W = 320, H = 130, box = { left: 8, top: 10, width: 304, height: 92 };
  const svg = chart(container, W, H);
  const max = Math.max(...counts, 1);
  const slot = box.width / 7;
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((name, index) => {
    const height = (counts[index] / max) * box.height;
    const group = el("g", {}, svg);
    el("title", {}, group, `${name}: ${counts[index]} activities`);
    el("rect", { x: box.left + index * slot + 6, y: box.top + box.height - height, width: slot - 12, height, rx: 3, fill: counts[index] === max ? RUN_COLOR : "#a8bfae" }, group);
    el("text", { x: box.left + index * slot + slot / 2, y: H - 8, class: "axis", "text-anchor": "middle" }, svg, name);
  });
}

function change(current, previous) {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function kpis(container, data) {
  container.replaceChildren();
  const now = data.totals;
  const before = data.previous;
  const cards = [
    ["Distance", `${now.distance_km.toLocaleString()} km`, change(now.distance_km, before?.distance_km)],
    ["Moving time", duration(now.moving_seconds), change(now.moving_seconds, before?.moving_seconds)],
    ["Activities", now.count.toLocaleString(), change(now.count, before?.count)],
    ["Climbing", `${now.elevation_m.toLocaleString()} m`, change(now.elevation_m, before?.elevation_m)],
    ["Active days", `${now.active_days} of ${Math.round((Date.parse(data.end) - Date.parse(data.start)) / 864e5) + 1}`, change(now.active_days, before?.active_days)],
  ];
  for (const [label, value, delta] of cards) {
    const card = html("article", { class: "kpi" }, "", container);
    html("span", {}, label, card);
    html("strong", {}, value, card);
    const note = html("small", { class: delta === null ? "" : delta >= 0 ? "up" : "down" }, delta === null ? (data.days ? "no earlier period" : "all time") : `${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta)}% vs previous ${data.days} days`, card);
    note.title = "Compared with the same number of days just before this period.";
  }
}

function sports(container, list) {
  container.replaceChildren();
  const max = Math.max(...list.map((entry) => entry.moving_seconds), 1);
  for (const entry of list) {
    const row = html("div", { class: "sport-row" }, "", container);
    const head = html("div", {}, "", row);
    html("strong", {}, sportLabel(entry.sport), head);
    html("span", {}, `${entry.count} ${entry.count === 1 ? "activity" : "activities"} · ${entry.distance_km} km · ${duration(entry.moving_seconds)}`, head);
    const track = html("div", { class: "bar-track" }, "", row);
    const fill = html("div", { class: "bar-fill" }, "", track);
    fill.style.width = `${(entry.moving_seconds / max) * 100}%`;
  }
  if (!list.length) html("p", { class: "muted" }, "No activities in this period.", container);
}

function streaks(container, data) {
  container.replaceChildren();
  const items = [
    [data.current_days, "day streak", `best ${data.best_days}`],
    [data.current_weeks, "week streak", `best ${data.best_weeks}`],
  ];
  for (const [value, label, best] of items) {
    const item = html("div", { class: "streak" }, "", container);
    html("strong", {}, String(value), item);
    html("span", {}, label, item);
    html("small", {}, best, item);
  }
}

function records(container, data) {
  container.replaceChildren();
  const items = [
    data.longest_run && ["Longest run", `${data.longest_run.km} km`, long(data.longest_run.day)],
    ["Longest activity", `${data.longest_activity.km} km`, `${sportLabel(data.longest_activity.sport)} · ${long(data.longest_activity.day)}`],
    ["Most climbing", `${data.most_climbing.m.toLocaleString()} m`, `${sportLabel(data.most_climbing.sport)} · ${long(data.most_climbing.day)}`],
    data.best_run_week && ["Biggest running week", `${data.best_run_week.km} km`, `week of ${short(data.best_run_week.start)}`],
    data.best_run_month && ["Biggest running month", `${data.best_run_month.km} km`, monthName(data.best_run_month.month)],
    ["On Strava since", long(data.first_activity), `${data.total_activities.toLocaleString()} activities saved`],
  ].filter(Boolean);
  for (const [label, value, note] of items) {
    const card = html("div", { class: "record" }, "", container);
    html("span", {}, label, card);
    html("strong", {}, value, card);
    html("small", {}, note, card);
  }
}

export function renderDashboard(data, races) {
  kpis(document.getElementById("kpis"), data);
  weeklyChart(document.getElementById("chart-weeks"), data.weeks, races);
  sports(document.getElementById("sports"), data.sports);
  streaks(document.getElementById("streaks"), data.streaks);
  weekdayChart(document.getElementById("weekdays"), data.weekdays);
  calendar(document.getElementById("calendar"), data.calendar);
  if (data.months.some((month) => month.runs_km > 0)) {
    monthlyChart(document.getElementById("chart-months"), data.months);
    document.getElementById("months-card").hidden = false;
  } else {
    document.getElementById("months-card").hidden = true;
  }
  records(document.getElementById("records"), data.records);
}
