// Every check the project has, in one command. There is no CI: this runs on
// your computer before each push to master (the .githooks/pre-push hook),
// and by hand with "npm run check". "npm run check -- --fast" skips the
// end-to-end run when you only want the quick part.
//
//   1. translations   — every language has every string        (< 1 s)
//   2. JS syntax      — the pages and scripts parse             (< 1 s)
//   3. backend tests  — cargo test: imports, servers over HTTP  (~ 5 s warm)
//   4. end-to-end     — the real app on a fresh data folder     (~ 30 s warm)
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
// Rust lives in ~/.cargo/bin; a window opened from GitHub Desktop or Explorer may not have it on PATH yet.
process.env.PATH = path.join(require("os").homedir(), ".cargo", "bin") + path.delimiter + process.env.PATH;

const root = path.join(__dirname, "..");
const win = process.platform === "win32";
const fast = process.argv.includes("--fast");

function jsFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "vendor" && e.name !== "node_modules") jsFiles(p, out); }
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const steps = [
  ["translations", () => spawnSync(process.execPath, [path.join(__dirname, "check-i18n.js")], { stdio: "inherit" }).status === 0],
  ["JS syntax", () => {
    const files = [...jsFiles(path.join(root, "app")), ...jsFiles(__dirname)];
    const bad = files.filter((f) => spawnSync(process.execPath, ["--check", f], { stdio: "inherit" }).status !== 0);
    if (!bad.length) console.log(`JS syntax: ${files.length} files parse.`);
    return bad.length === 0;
  }],
  ["backend tests", () => spawnSync("cargo", ["test", "--quiet"], { cwd: path.join(root, "src-tauri"), stdio: "inherit" }).status === 0],
  ...(fast ? [] : [["end-to-end", () => spawnSync(process.execPath, [path.join(__dirname, "e2e.js")], { stdio: "inherit" }).status === 0]]),
];

const t0 = Date.now();
for (const [name, run] of steps) {
  console.log(`\n── ${name}`);
  const t = Date.now();
  if (!run()) {
    console.error(`\n✖ ${name} failed. Nothing else was run.`);
    process.exit(1);
  }
  console.log(`   ok (${((Date.now() - t) / 1000).toFixed(1)} s)`);
}
console.log(`\n✔ All checks passed in ${((Date.now() - t0) / 1000).toFixed(0)} s${fast ? " (end-to-end skipped)" : ""}.`);
