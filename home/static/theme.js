// Runs before the page paints so the chosen theme never flashes the wrong colours.
(() => {
  let stored = null;
  try { stored = localStorage.getItem("hub-theme"); } catch { /* storage blocked: follow the system */ }
  const dark = stored ? stored === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
