"use strict";

const $ = (id) => document.getElementById(id);
const ICONS = {
  roam: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3.2 3 3.2 15 0 18M12 3c-3.2 3-3.2 15 0 18"/>',
  runs: '<path d="M5 21V4M5 4h12l-2.5 4L17 12H5"/>',
  activities: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  fuad: '<path d="M4 16l1.5-5.5A2 2 0 0 1 7.4 9h9.2a2 2 0 0 1 1.9 1.5L20 16v3h-2v-1.5H6V19H4z"/><circle cx="8" cy="14" r=".9"/><circle cx="16" cy="14" r=".9"/>',
  trading: '<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>',
  fitness: '<path d="M20.8 8.6a5 5 0 0 0-8.8-3 5 5 0 0 0-8.8 3c0 5.5 8.8 11 8.8 11s8.8-5.5 8.8-11z"/>',
};
const HIGHLIGHT_ICONS = { flag: ICONS.runs, pulse: ICONS.activities };
const state = { apps: [], group: "all", query: "" };

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function visible(app) {
  const text = `${app.name} ${app.tagline} ${app.group}`.toLocaleLowerCase();
  return (state.group === "all" || app.group === state.group) && (!state.query || text.includes(state.query));
}

function cardHTML(app, index) {
  const stats = app.stats.map((stat) => `<li><strong>${escapeHTML(stat.value)}</strong> ${escapeHTML(stat.label)}</li>`).join("");
  const shortcuts = app.shortcuts.length
    ? `<div class="shortcuts">${app.shortcuts.map((link) => `<a href="${escapeHTML(link.url)}">${escapeHTML(link.label)} →</a>`).join("")}</div>` : "";
  return `<article class="card g-${escapeHTML(app.group)}">
    <div class="card-top"><span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS[app.key] || ""}</svg></span><span class="group">${escapeHTML(app.group)}</span></div>
    <h2>${escapeHTML(app.name)}</h2>
    <p class="tagline">${escapeHTML(app.tagline)}</p>
    <ul class="chips">${stats}</ul>${shortcuts}
    <div class="card-foot"><a class="button primary" href="${escapeHTML(app.url)}">Open ${escapeHTML(app.name)} <span class="arrow">→</span></a><kbd title="Press ${index + 1} to open">${index + 1}</kbd></div>
  </article>`;
}

function renderGroups() {
  const groups = ["all", ...new Set(state.apps.map((app) => app.group))];
  $("groups").innerHTML = groups.map((group) =>
    `<button data-group="${escapeHTML(group)}" class="${group === state.group ? "active" : ""}" aria-pressed="${group === state.group}">${group === "all" ? "All" : escapeHTML(group)}</button>`).join("");
}

function render() {
  const cards = state.apps.map((app, index) => [app, index]).filter(([app]) => visible(app));
  $("apps").innerHTML = cards.length
    ? cards.map(([app, index]) => cardHTML(app, index)).join("")
    : `<div class="empty">No apps match “${escapeHTML(state.query)}”.</div>`;
  renderGroups();
}

function renderHighlight(highlight) {
  $("next-up").hidden = !highlight;
  if (!highlight) return;
  $("next-icon").innerHTML = HIGHLIGHT_ICONS[highlight.icon] || "";
  $("next-kicker").textContent = highlight.kicker;
  $("next-title").textContent = highlight.title;
  $("next-when").textContent = highlight.detail;
}

function renderUser(user) {
  $("avatar").textContent = user.initial;
  $("account-name").textContent = user.name;
  $("account").hidden = false;
  const hour = new Date().getHours();
  const hello = hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  $("greeting").textContent = `${hello}, ${user.name}.`;
  document.title = `Hub · ${user.name}`;
}

async function load() {
  try {
    const response = await fetch("/api/apps", { cache: "no-store" });
    if (response.status === 401) { location.href = "/login"; return; }
    if (!response.ok) throw new Error(`The server returned ${response.status}.`);
    const data = await response.json();
    state.apps = data.apps;
    renderUser(data.user);
    $("lede").textContent = data.message;
    $("summary").textContent = `${state.apps.length} ${state.apps.length === 1 ? "app" : "apps"} for you`;
    renderHighlight(data.highlight);
    render();
  } catch (error) {
    console.error("Could not load apps:", error);
    $("error").textContent = "Can't load your apps. Check that the server is still running, then reload.";
    $("error").hidden = false;
  }
}

async function signOut() {
  try {
    await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  } catch (error) {
    console.error("Sign-out request failed:", error);
  }
  location.href = "/login";
}

function isDark() {
  return document.documentElement.dataset.theme === "dark";
}

function syncThemeToggle() {
  const toggle = $("theme-toggle");
  toggle.setAttribute("aria-pressed", String(isDark()));
  toggle.setAttribute("aria-label", isDark() ? "Switch to light mode" : "Switch to dark mode");
  toggle.title = `${isDark() ? "Light" : "Dark"} mode (T)`;
}

function setTheme(dark, remember) {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  if (remember) {
    try { localStorage.setItem("hub-theme", dark ? "dark" : "light"); } catch { /* storage blocked: applies to this visit only */ }
  }
  syncThemeToggle();
}

function bindEvents() {
  $("theme-toggle").addEventListener("click", () => setTheme(!isDark(), true));
  $("sign-out").addEventListener("click", signOut);
  // Until you pick a theme yourself, follow the system setting as it changes.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
    let saved = null;
    try { saved = localStorage.getItem("hub-theme"); } catch { /* ignore */ }
    if (!saved) setTheme(event.matches, false);
  });
  // A soft light follows the pointer across each card.
  $("apps").addEventListener("pointermove", (event) => {
    const card = event.target.closest(".card");
    if (!card) return;
    const box = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${event.clientX - box.left}px`);
    card.style.setProperty("--my", `${event.clientY - box.top}px`);
  });
  $("groups").addEventListener("click", (event) => {
    const button = event.target.closest("[data-group]");
    if (button) { state.group = button.dataset.group; render(); }
  });
  $("search").addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLocaleLowerCase();
    render();
  });
  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target === $("search")) {
      if (event.key === "Escape") { $("search").value = ""; state.query = ""; $("search").blur(); render(); }
      return;
    }
    if (event.target.closest("input, textarea, select")) return;
    if (event.key === "/") {
      event.preventDefault();
      $("search").focus();
      return;
    }
    if (event.key.toLowerCase() === "t") {
      setTheme(!isDark(), true);
      return;
    }
    const app = state.apps[Number(event.key) - 1];
    if (app) location.href = app.url;
  });
}

function showDate() {
  $("today").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

showDate();
syncThemeToggle();
bindEvents();
load();
