// Resolves the colour tokens in public/theme.css for both themes and fails unless every
// text/background pair the interface uses meets WCAG AA.
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../public/theme.css", import.meta.url), "utf8");

const BODY = 4.5;
const UI = 3; // large text, borders of controls, focus rings, chart marks

// [foreground, background, minimum ratio, where it is used]
const PAIRS = [
  ...["bg", "surface", "surface-2", "banner"].flatMap((bg) => [
    ["text", bg, BODY, "body text"],
    ["text-2", bg, BODY, "secondary text"],
  ]),
  ...["bg", "surface", "surface-2"].flatMap((bg) => [
    ["link", bg, BODY, "links"],
    ["ok", bg, BODY, "ok and enabled labels, the switch when on"],
    ["danger", bg, BODY, "error labels"],
    ["accent", bg, BODY, "changed labels, active nav text, focus ring"],
  ]),
  ["danger", "banner", BODY, "banner heading"],
  ["link", "banner", BODY, "banner links"],
  ["on-accent", "accent", BODY, "primary buttons, active nav"],
  ["on-accent", "accent-hover", BODY, "primary buttons on hover"],
  ["surface", "text", BODY, "tooltips"],
  ["line-strong", "surface", UI, "input and switch borders"],
  ["line-strong", "bg", UI, "input and switch borders"],
  ["chart-1", "surface", UI, "chart: calls"],
  ["chart-2", "surface", UI, "chart: errors"],
  ["on-accent", "text", BODY, "the chosen segment of a segmented control"],
  ["text", "surface", UI, "chart: the picked day"],
  ["chart-1", "surface-2", UI, "bar lists: the bar on its track"],
  ["chart-2", "surface-2", UI, "bar lists: the failed end on its track"],
  ["ok", "surface", BODY, "provider status: Ready"],
  ["danger", "surface", BODY, "provider status: Needs attention"],
  ["text-2", "surface", BODY, "provider status: No key"],
  ["text-2", "tile", BODY, "provider monogram"],
];

function block(selector) {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]));
}

const NAMED = { white: [255, 255, 255] };

function resolve(tokens, value) {
  value = value.trim();
  if (NAMED[value]) return NAMED[value];
  if (/^#[0-9a-f]{6}$/i.test(value))
    return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
  const ref = value.match(/^var\(--([\w-]+)\)$/);
  if (ref) return resolve(tokens, tokens[ref[1]]);
  const mix = value.match(/^color-mix\(in srgb,\s*(.+?)(?:\s+(\d+)%)?,\s*(.+?)(?:\s+(\d+)%)?\)$/);
  if (!mix) throw new Error(`Cannot resolve "${value}"`);
  const p = mix[2] ? mix[2] / 100 : mix[4] ? 1 - mix[4] / 100 : 0.5;
  const a = resolve(tokens, mix[1]);
  const b = resolve(tokens, mix[3]);
  return a.map((c, i) => Math.round(c * p + b[i] * (1 - p)));
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const hex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;

const light = block(":root");
const themes = { light, dark: { ...light, ...block(':root[data-theme="dark"]') } };
let failures = 0;

for (const [theme, tokens] of Object.entries(themes)) {
  console.log(`${theme}: navy ${tokens.navy}, teal ${tokens.teal}, pink ${tokens.pink}`);
  for (const [fg, bg, min, use] of PAIRS) {
    const f = resolve(tokens, tokens[fg]);
    const b = resolve(tokens, tokens[bg]);
    const [hi, lo] = [luminance(f), luminance(b)].sort((x, y) => y - x);
    const ratio = (hi + 0.05) / (lo + 0.05);
    const ok = ratio >= min;
    if (!ok) failures++;
    console.log(
      `  ${ok ? "pass" : "FAIL"} ${ratio.toFixed(2).padStart(5)} >= ${min}  ` +
        `${fg} ${hex(f)} on ${bg} ${hex(b)}  (${use})`,
    );
  }
}

if (failures) {
  console.error(`${failures} pair(s) below WCAG AA.`);
  process.exit(1);
}
console.log("All pairs meet WCAG AA in both themes.");
