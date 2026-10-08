// Runs before "npm start" / "npm run build": version 3 is compiled from Rust,
// so say clearly what is missing instead of a cryptic "cargo not found".
const { spawnSync } = require("child_process");

const r = spawnSync("cargo", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
if (r.status === 0) process.exit(0);

const lines = [
  "",
  "Rust is not installed, and Bible Presenter 3 is built from Rust.",
  "Rust не установлен, а Bible Presenter 3 собирается из Rust.",
  "",
  "To build a release installer, double-click build-windows.cmd (Windows)",
  "or run build-mac.command (Mac): they install what is missing. See docs/RELEASE.md.",
  "Для установщика релиза: build-windows.cmd (Windows) или build-mac.command (Mac),",
  "они сами поставят недостающее. Подробно: docs/RELEASE.md.",
  "",
  "To build on this computer / Чтобы собирать на этом компьютере:",
  "  1. https://rustup.rs -> rustup-init.exe (Windows: agree to install Visual Studio Build Tools)",
  "  2. Close and reopen the terminal / закрой и снова открой терминал",
  "  3. npm run build",
  "",
];
console.error(lines.join("\n"));
process.exit(1);
