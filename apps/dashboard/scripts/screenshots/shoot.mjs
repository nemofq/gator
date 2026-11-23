// The README screenshots: the dashboard from Vite, its API answered from fixtures.ts, taken in
// headless Chrome over the DevTools protocol, so nothing needs installing. From the repository root:
//   node apps/dashboard/scripts/screenshots/shoot.mjs
// It writes .github/screenshots/<page>-<theme>.webp. Set CHROME if Chrome is not where it usually is.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const CHROME =
  process.env.CHROME ??
  {
    darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    win32: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  }[process.platform] ??
  "google-chrome";
const WIDTH = 1280;
/** Each page, what shows it has loaded, and where the picture ends: a margin below the last of
    `end`. Overview stops before its recent calls. */
const PAGES = [
  { name: "overview", path: "/", ready: ".recent tbody tr", end: ".breakdowns" },
  { name: "providers", path: "/providers", ready: ".cards .card", end: ".cards" },
  { name: "agents", path: "/agents", ready: ".agents tbody tr", end: "main .panel" },
];
const MARGIN = 32;
const THEMES = ["light", "dark"];

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const out = at("../../../../.github/screenshots/");
const temp = mkdtempSync(join(tmpdir(), "gator-screenshots-"));
let chrome;
let vite;

try {
  vite = await createServer({
    root: at("../.."),
    cacheDir: join(temp, "vite"),
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "fixtures",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const path = new URL(req.url, "http://x").pathname;
            const icon = /^\/icons\/([a-z0-9-]+\.png)$/.exec(path);
            if (icon) {
              res.setHeader("Content-Type", "image/png");
              return res.end(readFileSync(at(`../../../../catalog/icons/${icon[1]}`)));
            }
            if (!path.startsWith("/api/")) return next();
            const { routes } = await server.ssrLoadModule("/scripts/screenshots/fixtures.ts");
            res.statusCode = routes[path] ? 200 : 404;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(routes[path] ?? { error: "Not in the fixtures." }));
          });
        },
      },
    ],
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const { NOW } = await vite.ssrLoadModule("/scripts/screenshots/fixtures.ts");

  chrome = spawn(
    CHROME,
    [
      "--headless",
      "--remote-debugging-port=0",
      `--user-data-dir=${join(temp, "chrome")}`,
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = await new Promise((resolve, reject) => {
    let said = "";
    chrome.on("error", reject);
    chrome.on("exit", () => reject(new Error(`Chrome stopped:\n${said}`)));
    chrome.stderr.on("data", (chunk) => {
      said += chunk;
      const url = /DevTools listening on (ws:\S+)/.exec(said)?.[1];
      if (url) resolve(url);
    });
  });
  const send = await devtools(endpoint);

  mkdirSync(out, { recursive: true });
  for (const page of PAGES)
    for (const theme of THEMES) {
      const file = `${page.name}-${theme}.webp`;
      const shot = await take(send, `${origin}${page.path}`, page, theme, NOW);
      writeFileSync(join(out, file), shot);
      console.log(`${file}: ${Math.round(shot.length / 1024)} KB`);
    }
} finally {
  chrome?.kill();
  await vite?.close();
  rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
}

/** One DevTools connection; `send` runs a command, in a page when given its session. */
async function devtools(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const waiting = new Map();
  let last = 0;
  socket.onmessage = ({ data }) => {
    const { id, result, error } = JSON.parse(data);
    waiting.get(id)?.[error ? 1 : 0](error ? new Error(error.message) : result);
    waiting.delete(id);
  };
  return (method, params = {}, sessionId = undefined) =>
    new Promise((resolve, reject) => {
      waiting.set(++last, [resolve, reject]);
      socket.send(JSON.stringify({ id: last, method, params, sessionId }));
    });
}

/** A fresh tab at the fixtures' moment, in the theme; the page from its top to below `end`. */
async function take(send, url, page, theme, now) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const tab = (method, params) => send(method, params, sessionId);
  const size = (height) =>
    tab("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height,
      deviceScaleFactor: 2,
      mobile: false,
    });
  const evaluate = async (expression) =>
    (await tab("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result
      .value;
  await tab("Page.enable");
  await size(900);
  await tab("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: theme }],
  });
  await tab("Emulation.setLocaleOverride", { locale: "en-US" });
  await tab("Emulation.setTimezoneOverride", { timezoneId: "America/Los_Angeles" });
  // The clock stands still at `now`, so "ago" and today's date read as the fixtures mean.
  await tab("Page.addScriptToEvaluateOnNewDocument", {
    source: `{
      const Real = Date;
      function Fixed(...args) {
        return new.target ? new Real(...(args.length ? args : [${now}])) : new Real(${now}).toString();
      }
      Fixed.prototype = Real.prototype;
      Fixed.now = () => ${now};
      Fixed.parse = Real.parse;
      Fixed.UTC = Real.UTC;
      globalThis.Date = Fixed;
    }`,
  });
  await tab("Page.navigate", { url });
  const ready = `location.href === ${JSON.stringify(url)} && document.readyState === "complete" &&
    !!document.querySelector(${JSON.stringify(page.ready)}) &&
    [...document.images].every((i) => i.complete) && document.fonts.status === "loaded"`;
  for (let tries = 0; !(await evaluate(ready).catch(() => false)); tries++) {
    if (tries > 100) throw new Error(`${url} did not load.`);
    await new Promise((r) => setTimeout(r, 100));
  }
  if ((await evaluate("Date.now()")) !== now) throw new Error("The page's clock is not set.");
  // What follows the end is hidden, so the margin below it is empty.
  const height = await evaluate(`{
    const end = [...document.querySelectorAll(${JSON.stringify(page.end)})].at(-1);
    for (let next = end.nextElementSibling; next; next = next.nextElementSibling)
      next.style.visibility = "hidden";
    Math.ceil(end.getBoundingClientRect().bottom) + ${MARGIN};
  }`);
  await size(height);
  // Two frames, so the new size is painted.
  await evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  const { data } = await tab("Page.captureScreenshot", { format: "webp", quality: 90 });
  await send("Target.closeTarget", { targetId });
  return Buffer.from(data, "base64");
}
