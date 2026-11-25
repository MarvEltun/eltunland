"use strict";

const $ = (id) => document.getElementById(id);
const state = { users: [], user: null, pin: "", first: "", step: "enter", busy: false };

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

// Only same-site paths, so a crafted link cannot send you elsewhere after signing in.
function destination() {
  const next = new URLSearchParams(location.search).get("next") || "/";
  return next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") && next !== "/login" ? next : "/";
}

function showError(message) {
  $("login-error").textContent = message;
  $("login-error").hidden = !message;
}

function renderProfiles() {
  $("profiles").innerHTML = state.users.map((user) => `
    <button class="profile" data-user="${escapeHTML(user.username)}">
      <span class="avatar big" aria-hidden="true">${escapeHTML(user.initial)}</span>
      <strong>${escapeHTML(user.name)}</strong>
      <small>${user.has_pin ? "Enter your PIN" : "Create a PIN"}</small>
    </button>`).join("");
}

function renderDots() {
  [...$("dots").children].forEach((dot, index) => dot.classList.toggle("filled", index < state.pin.length));
}

function setStep(step, message = "") {
  state.step = step;
  state.pin = "";
  renderDots();
  const name = state.user.name;
  $("login-eyebrow").textContent = state.user.has_pin ? "Welcome back" : "First time here";
  $("login-title").textContent = state.user.has_pin ? `Hi, ${name}.` : `Hi, ${name}!`;
  $("login-lede").textContent = step === "enter" ? "Enter your 4-digit PIN."
    : step === "create" ? "Choose a 4-digit PIN. You'll use it every time you sign in."
      : "Type the same PIN again to confirm.";
  $("pin-message").textContent = message;
}

function chooseUser(username) {
  state.user = state.users.find((user) => user.username === username);
  showError("");
  $("profiles").hidden = true;
  $("pin-panel").hidden = false;
  setStep(state.user.has_pin ? "enter" : "create");
}

function backToProfiles() {
  state.user = null;
  state.pin = "";
  showError("");
  $("pin-panel").hidden = true;
  $("profiles").hidden = false;
  $("login-eyebrow").textContent = "Welcome";
  $("login-title").textContent = "Who's using Hub?";
  $("login-lede").textContent = "Pick your profile to continue.";
}

function shake(message) {
  $("pin-message").textContent = message;
  $("dots").classList.add("shake");
  setTimeout(() => $("dots").classList.remove("shake"), 450);
}

async function submit() {
  state.busy = true;
  const pin = state.pin;
  try {
    if (state.step === "create") {
      state.first = pin;
      setStep("confirm");
      return;
    }
    if (state.step === "confirm" && pin !== state.first) {
      setStep("create");
      shake("Those didn't match. Choose your PIN again.");
      return;
    }
    const creating = state.step === "confirm";
    const response = await fetch(creating ? "/api/pin" : "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: state.user.username, pin }),
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok) { location.href = destination(); return; }
    state.pin = "";
    renderDots();
    shake(result.attempts_left !== undefined
      ? `${result.error} ${result.attempts_left} ${result.attempts_left === 1 ? "try" : "tries"} left.` : result.error || "Something went wrong.");
  } catch (error) {
    console.error("Sign-in failed:", error);
    state.pin = "";
    renderDots();
    shake("Cannot reach the server. Check that it is still running.");
  } finally {
    state.busy = false;
  }
}

function press(digit) {
  if (state.busy || state.pin.length >= 4) return;
  state.pin += digit;
  renderDots();
  if (state.pin.length === 4) setTimeout(submit, 120);
}

function erase() {
  if (state.busy) return;
  state.pin = state.pin.slice(0, -1);
  renderDots();
}

function bindEvents() {
  $("profiles").addEventListener("click", (event) => {
    const button = event.target.closest("[data-user]");
    if (button) chooseUser(button.dataset.user);
  });
  $("keypad").addEventListener("click", (event) => {
    const key = event.target.closest("button");
    if (!key) return;
    if (key.id === "erase") erase();
    else press(key.dataset.digit);
  });
  $("back").addEventListener("click", backToProfiles);
  document.addEventListener("keydown", (event) => {
    if (!state.user || event.metaKey || event.ctrlKey || event.altKey) return;
    if (/^[0-9]$/.test(event.key)) press(event.key);
    else if (event.key === "Backspace") erase();
    else if (event.key === "Escape") backToProfiles();
  });
}

async function initialize() {
  try {
    const response = await fetch("/api/users", { cache: "no-store" });
    if (!response.ok) throw new Error(`The server returned ${response.status}.`);
    state.users = (await response.json()).users;
    renderProfiles();
    bindEvents();
  } catch (error) {
    console.error("Could not load profiles:", error);
    showError("Can't reach the server. Check that it is still running, then reload.");
  }
}

initialize();
