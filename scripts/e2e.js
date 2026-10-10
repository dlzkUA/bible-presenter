// Starts the real app (debug build) with a fresh, temporary data folder and
// runs tests/e2e/smoke.js inside its control window. The operator's own data
// and settings are never touched. On Linux without a screen it uses xvfb-run.
//
//   node scripts/e2e.js            build if needed, then run
//   node scripts/e2e.js --no-build use the existing debug build
const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
// Rust lives in ~/.cargo/bin; a window opened from GitHub Desktop or Explorer may not have it on PATH yet.
process.env.PATH = path.join(require("os").homedir(), ".cargo", "bin") + path.delimiter + process.env.PATH;

const root = path.join(__dirname, "..");
const win = process.platform === "win32";
const bin = path.join(root, "src-tauri", "target", "debug", win ? "bible-presenter.exe" : "bible-presenter");

if (!process.argv.includes("--no-build")) {
  const b = spawnSync("cargo", ["build", "--quiet"], { cwd: path.join(root, "src-tauri"), stdio: "inherit" });
  if (b.status !== 0) process.exit(b.status || 1);
}
if (!fs.existsSync(bin)) {
  console.error("No debug build at " + bin);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bp-e2e-"));
const fix = path.join(root, "tests", "fixtures") + path.sep;
const script = path.join(tmp, "smoke.js");
const out = path.join(tmp, "result.txt");
fs.writeFileSync(script, `const FIX = ${JSON.stringify(fix)};\n` + fs.readFileSync(path.join(root, "tests", "e2e", "smoke.js"), "utf8"));

const env = {
  ...process.env,
  BP_TEST: script,
  BP_TEST_OUT: out,
  BP_TEST_LANG: "en",
  BP_DATA_DIR: path.join(tmp, "data"),
  // A separate web view profile, so saved interface settings don't leak in.
  WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview"),
};
let cmd = bin, args = [];
if (process.platform === "linux") {
  Object.assign(env, {
    XDG_DATA_HOME: path.join(tmp, "xdg-data"), XDG_CACHE_HOME: path.join(tmp, "xdg-cache"), XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
    WEBKIT_DISABLE_COMPOSITING_MODE: "1", WEBKIT_DISABLE_DMABUF_RENDERER: "1",
  });
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    cmd = "xvfb-run";
    args = ["-a", "-s", "-screen 0 1920x1080x24", bin];
  }
}

const started = Date.now();
const child = spawn(cmd, args, { env, stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
child.stderr.on("data", (d) => { stderr += d; });
const timer = setTimeout(() => { console.error("The app did not finish within 3 minutes."); child.kill("SIGKILL"); }, 180000);

child.on("exit", () => {
  clearTimeout(timer);
  const text = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (const l of lines) console.log("  " + l);
  const passed = lines.some((l) => l === "TOTAL FAILS: 0") && !lines.some((l) => l.startsWith("FAIL"));
  if (!passed) {
    if (!lines.length) console.error("The test script produced no output. App log:\n" + stderr.slice(-3000));
    console.error(`End-to-end smoke test FAILED (${((Date.now() - started) / 1000).toFixed(0)} s). Data folder kept: ${tmp}`);
    process.exit(1);
  }
  console.log(`End-to-end smoke test passed (${((Date.now() - started) / 1000).toFixed(0)} s).`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
});
