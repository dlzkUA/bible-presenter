#!/usr/bin/env node
/**
 * Publishes the Bible Presenter manual to Notion.
 *
 * Creates one page "Bible Presenter — User Guide" under the
 * page you choose, and every article as a sub-page of it, using the Notion
 * API's markdown endpoints (Notion-Version 2026-03-11).
 *
 * Screenshots are referenced by URL. By default they are taken from this
 * repository on GitHub (docs/manual/images), so push the repository first.
 *
 * Usage (Node 18 or newer, no npm install needed):
 *
 *   NOTION_TOKEN=secret_xxx NOTION_PARENT=<page link or id> node docs/manual/publish-to-notion.js
 *
 * Optional:
 *   IMAGE_BASE_URL=https://...    where the PNG files are publicly reachable
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const API = "https://api.notion.com/v1";
const VERSION = "2026-03-11";
const DIR = path.join(__dirname, "notion");

function fail(msg) { console.error("\n✖ " + msg + "\n"); process.exit(1); }

const token = process.env.NOTION_TOKEN;
if (!token) fail("Set NOTION_TOKEN to your integration secret (notion.so/profile/integrations).");
const parentRaw = process.env.NOTION_PARENT || "";
const parentId = (parentRaw.replace(/-/g, "").match(/[0-9a-f]{32}/i) || [])[0];
if (!parentId) fail("Set NOTION_PARENT to the link of the Notion page the guide should go under.");

function guessImageBase() {
  if (process.env.IMAGE_BASE_URL) return process.env.IMAGE_BASE_URL.replace(/\/+$/, "");
  let remote = "";
  try { remote = execSync("git remote get-url origin", { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch (_) {}
  const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!m) fail("Could not work out the GitHub repository. Run this from the project folder, or set IMAGE_BASE_URL.");
  let branch = "main";
  try { branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "main"; } catch (_) {}
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${branch}/docs/manual/images`;
}

async function notion(method, url, body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(API + url, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Notion-Version": VERSION,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {            // rate limited: wait as told, then retry
      const wait = Number(res.headers.get("retry-after") || 1) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const hint = res.status === 404
        ? " — give your integration access to the page: page menu ••• → Connections → add it."
        : "";
      fail(`Notion API ${res.status}: ${data.message || res.statusText}${hint}`);
    }
    return data;
  }
  fail("Notion kept rate-limiting the requests. Try again in a minute.");
}

(async () => {
  const base = guessImageBase();
  const order = JSON.parse(fs.readFileSync(path.join(DIR, "order.json"), "utf8"));

  // Catch the most common mistake before creating anything: images not online yet.
  const probe = await fetch(`${base}/01-main-window.png`, { method: "HEAD" }).catch(() => null);
  if (!probe || !probe.ok) {
    fail(`Screenshots are not reachable at\n  ${base}/01-main-window.png\nPush the project to GitHub first (the repository must be public), or set IMAGE_BASE_URL.`);
  }
  console.log("Images:", base);

  const load = (file) => fs.readFileSync(path.join(DIR, file), "utf8").split("{{IMG}}").join(base);

  const [home, ...articles] = order;
  const root = await notion("POST", "/pages", {
    parent: { page_id: parentId },
    icon: { type: "emoji", emoji: home.icon },
    markdown: load(home.file),
  });
  console.log("✓", home.title);

  for (const a of articles) {
    await notion("POST", "/pages", {
      parent: { page_id: root.id },
      icon: { type: "emoji", emoji: a.icon },
      markdown: load(a.file),
    });
    console.log("✓", a.title);
    await new Promise((r) => setTimeout(r, 400));   // stay under ~3 requests/second
  }
  console.log(`\nDone: ${order.length} pages.\n${root.url || ""}`);
})();
