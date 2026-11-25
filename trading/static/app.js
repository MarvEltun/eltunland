"use strict";

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const signedUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", signDisplay: "always" });
const wholeNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const KEY_STORAGE = "trading-massive-key";

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function formatDay(value, options = { month: "short", day: "numeric", year: "numeric" }) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", { ...options, timeZone: "UTC" });
}

function show(text, kind = "") {
  $("message").className = `message ${kind}`;
  $("message").textContent = text;
}

function metric(label, value, extra = "") {
  return `<div class="metric"><span>${escapeHTML(label)}</span><strong>${value}</strong>${extra}</div>`;
}

function renderOverview(bar) {
  $("overview-title").textContent = `Daily overview · ${formatDay(bar.day)}`;
  const change = bar.close - bar.open;
  const percent = change / bar.open * 100;
  const direction = change >= 0 ? "up" : "down";
  $("metrics").innerHTML = `
    ${metric("Closing price", usd.format(bar.close))}
    ${metric("Open-to-close change", signedUsd.format(change), `<small class="${direction}">${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%</small>`)}
    ${metric("Trading volume", wholeNumber.format(bar.volume))}
    ${metric("Daily range", usd.format(bar.high - bar.low))}`;
  $("metrics-secondary").innerHTML = `
    ${metric("Open", usd.format(bar.open))}${metric("High", usd.format(bar.high))}${metric("Low", usd.format(bar.low))}`;
}

function svg(tag, attributes) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function renderChart(bars) {
  const chart = $("chart");
  chart.replaceChildren();
  $("chart-tip").hidden = true;
  if (bars.length < 2) return;
  const [width, height, left, right, top, bottom] = [800, 300, 58, 16, 16, 28];
  const closes = bars.map((bar) => bar.close);
  const low = Math.min(...closes);
  const high = Math.max(...closes);
  const pad = (high - low || 1) * 0.08;
  const [min, max] = [low - pad, high + pad];
  const x = (index) => left + index / (bars.length - 1) * (width - left - right);
  const y = (value) => top + (max - value) / (max - min) * (height - top - bottom);

  for (let step = 0; step <= 4; step++) {
    const value = min + (max - min) * step / 4;
    chart.append(svg("line", { class: "axis", x1: left, x2: width - right, y1: y(value), y2: y(value) }));
    const label = svg("text", { class: "axis-label", x: left - 8, y: y(value) + 4, "text-anchor": "end" });
    label.textContent = usd.format(value);
    chart.append(label);
  }
  [0, Math.floor((bars.length - 1) / 2), bars.length - 1].forEach((index, position) => {
    const label = svg("text", {
      class: "axis-label", x: x(index), y: height - 8,
      "text-anchor": position === 0 ? "start" : position === 2 ? "end" : "middle",
    });
    label.textContent = formatDay(bars[index].day, { month: "short", day: "numeric" });
    chart.append(label);
  });
  const points = bars.map((bar, index) => `${x(index).toFixed(1)},${y(bar.close).toFixed(1)}`);
  chart.append(
    svg("polygon", { class: "area", points: `${x(0)},${height - bottom} ${points.join(" ")} ${x(bars.length - 1)},${height - bottom}` }),
    svg("polyline", { class: "line", points: points.join(" ") }),
  );

  const guide = svg("line", { class: "hover-line", y1: top, y2: height - bottom });
  const dot = svg("circle", { class: "dot", r: 5 });
  guide.setAttribute("visibility", "hidden");
  dot.setAttribute("visibility", "hidden");
  const hit = svg("rect", { x: left, y: top, width: width - left - right, height: height - top - bottom, fill: "transparent" });
  chart.append(guide, dot, hit);
  hit.addEventListener("pointermove", (event) => {
    const box = chart.getBoundingClientRect();
    const position = (event.clientX - box.left) / box.width * width;
    const index = Math.max(0, Math.min(bars.length - 1, Math.round((position - left) / (width - left - right) * (bars.length - 1))));
    guide.setAttribute("x1", x(index));
    guide.setAttribute("x2", x(index));
    dot.setAttribute("cx", x(index));
    dot.setAttribute("cy", y(bars[index].close));
    guide.setAttribute("visibility", "visible");
    dot.setAttribute("visibility", "visible");
    const tip = $("chart-tip");
    tip.textContent = `${formatDay(bars[index].day)} · ${usd.format(bars[index].close)}`;
    tip.hidden = false;
    const wrap = chart.parentElement.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(x(index) / width * box.width - 60, 0), wrap.width - 170)}px`;
  });
  hit.addEventListener("pointerleave", () => {
    guide.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    $("chart-tip").hidden = true;
  });
}

function renderTable(bars) {
  $("table").querySelector("tbody").innerHTML = [...bars].reverse().map((bar) => `<tr>
    <td>${formatDay(bar.day)}</td><td>${usd.format(bar.open)}</td><td>${usd.format(bar.high)}</td>
    <td>${usd.format(bar.low)}</td><td>${usd.format(bar.close)}</td><td>${wholeNumber.format(bar.volume)}</td></tr>`).join("");
}

async function load(refresh = false) {
  const key = $("api-key").value.trim();
  const headers = key ? { "X-Massive-Key": key } : {};
  $("load").disabled = true;
  $("refresh").disabled = true;
  show("Loading PG's daily stats…");
  try {
    const response = await fetch(`api/pg?days=${$("period").value}${refresh ? "&refresh=1" : ""}`, { headers, cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    if (key) sessionStorage.setItem(KEY_STORAGE, key);
    $("results").hidden = false;
    renderOverview(data.previous);
    const bars = data.history;
    $("history-caption").textContent = bars.length
      ? `${formatDay(bars[0].day)} – ${formatDay(bars[bars.length - 1].day)} · ${bars.length} trading sessions · USD per share` : "";
    renderChart(bars);
    renderTable(bars);
    if (data.history_error) show(`Could not load the historical chart: ${data.history_error}`, "warning");
    else show("");
    $("refresh").disabled = false;
  } catch (error) {
    console.error("Trading data failed:", error);
    $("results").hidden = true;
    show(error instanceof TypeError ? "Cannot reach your local server. Check that it is still running." : error.message, "error");
  } finally {
    $("load").disabled = false;
  }
}

async function initialize() {
  $("api-key").value = sessionStorage.getItem(KEY_STORAGE) || "";
  $("controls").addEventListener("submit", (event) => { event.preventDefault(); load(); });
  $("refresh").addEventListener("click", () => load(true));
  $("period").addEventListener("change", () => { if (!$("results").hidden) load(); });
  try {
    const config = await (await fetch("api/config", { cache: "no-store" })).json();
    if (config.server_key) {
      $("api-key").placeholder = "Using the server's MASSIVE_API_KEY";
      load();
    } else if ($("api-key").value) {
      load();
    } else {
      show("Enter your Massive API key to load PG's stock data.", "warning");
    }
  } catch (error) {
    console.error("Config failed:", error);
    show("Cannot reach your local server. Check that it is still running.", "error");
  }
}

initialize();
