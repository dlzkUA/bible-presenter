// Static check of the interface translations (no app start, under a second).
//  1. Every language has exactly the keys English has: a key missing in one
//     language shows English there, a stray key is a typo or a dead string.
//  2. Every literal passed to t("…") / tf("…") in the pages exists in English,
//     so no Ukrainian source text leaks to a user of another language.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(root, "app/renderer/control/i18n.js"), "utf8");
const sandbox = { window: {}, document: { addEventListener() {}, querySelectorAll: () => [] }, localStorage: { getItem() {}, setItem() {} }, MutationObserver: function () {} };
vm.runInNewContext(src, sandbox);
const { I18N, LANGS } = sandbox.window.i18n;

const problems = [];
const en = I18N.en;
const enKeys = new Set(Object.keys(en));

for (const { id } of LANGS) {
  if (id === "uk") continue; // the source language: keys are its own text
  const d = I18N[id];
  if (!d) { problems.push(`language "${id}" is listed but has no dictionary`); continue; }
  if (id === "en") continue;
  const missing = [...enKeys].filter((k) => !(k in d));
  const extra = Object.keys(d).filter((k) => !enKeys.has(k));
  if (missing.length) problems.push(`${id}: ${missing.length} key(s) missing, e.g. ${JSON.stringify(missing.slice(0, 3))}`);
  if (extra.length) problems.push(`${id}: ${extra.length} key(s) not in English, e.g. ${JSON.stringify(extra.slice(0, 3))}`);
  const empty = Object.keys(d).filter((k) => !String(d[k]).trim());
  if (empty.length) problems.push(`${id}: empty translation for ${JSON.stringify(empty.slice(0, 3))}`);
}

const pages = ["app/renderer/control/script.js", "app/renderer/control/ui.js"];
const rx = /\b(?:i18n\.t|tf|[^.\w]t)\(\s*"((?:[^"\\]|\\.)+)"/g;
for (const rel of pages) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  const seen = new Set();
  for (const m of text.matchAll(rx)) {
    const key = JSON.parse(`"${m[1]}"`);
    if (!/[а-яіїєґё]/i.test(key) || seen.has(key)) continue; // only Ukrainian source strings are keys
    seen.add(key);
    if (!enKeys.has(key)) problems.push(`${rel}: no translation for ${JSON.stringify(key)}`);
  }
}

// 3. The control window's markup: visible text, placeholders and tooltips are
//    translated by looking up exactly what the browser sees (entities decoded).
{
  let html = fs.readFileSync(path.join(root, "app/renderer/control/index.html"), "utf8");
  html = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, "");
  const decode = (s) => s.replace(/&#10;/g, "\n").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  const seen = new Set();
  const want = (k) => {
    if (!/[а-яіїєґё]/i.test(k) || seen.has(k)) return;
    seen.add(k);
    if (!enKeys.has(k)) problems.push(`index.html: no translation for ${JSON.stringify(k)}`);
  };
  for (const m of html.matchAll(/\s(?:placeholder|title)="([^"]*)"/g)) want(decode(m[1]));
  for (const m of html.matchAll(/>([^<]+)</g)) want(decode(m[1]).trim());
}

if (problems.length) {
  console.error("Translations: " + problems.length + " problem(s)");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(`Translations: ${LANGS.length} languages, ${enKeys.size} strings, all consistent.`);
