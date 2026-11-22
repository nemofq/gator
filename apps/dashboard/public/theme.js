// Blocking, in <head>: sets data-theme before first paint. The stored choice wins; without one
// the system setting is followed live. The dashboard dispatches "gator-theme" after a change.
(() => {
  const system = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    let stored = null;
    try {
      stored = localStorage.getItem("gator-theme");
    } catch {}
    const theme =
      stored === "light" || stored === "dark" ? stored : system.matches ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
  };
  apply();
  system.addEventListener("change", apply);
  addEventListener("gator-theme", apply);
  addEventListener("storage", apply);
})();
