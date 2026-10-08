// Builds the installer for THIS computer and puts everything that has to be
// uploaded to a GitHub release into release/v<version>/.
//
// Windows: the -setup.exe. macOS: one .dmg for Intel and Apple Silicon
// (universal), plus the archive the app updates itself from. In both cases
// latest.json, the file the installed apps check for updates; when the other
// system's part is already published, its entries are kept (the file is read
// from the release first).
//
// Started by build-windows.cmd / build-mac.command; also directly:
//   node scripts/release.js [--key <file>] [--no-key] [--mac universal|intel|arm] [--skip-build]
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const root = path.join(__dirname, "..");
// BP_RELEASE_PLATFORM only lets the collection step be tried on another system.
const platform = process.env.BP_RELEASE_PLATFORM || process.platform;
const win = platform === "win32";
const mac = platform === "darwin";
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(name);

const say = (m = "") => console.log(m);
const fail = (m) => { console.error("\n✖ " + m + "\n"); process.exit(1); };
const ask = (q) => new Promise((res) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); res(a.trim()); });
});
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const CLI = path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const openFolder = (p) => spawnSync(win ? "explorer" : mac ? "open" : "xdg-open", [p], { stdio: "ignore" });

async function main() {
  if (win && process.arch !== "x64") fail("Этот компьютер на ARM: установщик для обычных Windows-ПК (x64) собирайте на компьютере с Intel или AMD.");
  if (!win && !mac) fail("Установщики собираются на Windows (.exe) и на Mac (.dmg). На Linux — только проверки: npm run check.");

  // ---- version: one number in package.json and Cargo.toml
  const pkgPath = path.join(root, "package.json");
  const pkg = readJson(pkgPath);
  const version = pkg.version;
  const cargoVersion = (fs.readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8").match(/^version\s*=\s*"([^"]+)"/m) || [])[1];
  if (cargoVersion !== version) {
    fail(`Версии не совпадают: package.json — ${version}, src-tauri/Cargo.toml — ${cargoVersion}.\nПоставьте одинаковый номер в обоих файлах и запустите снова.`);
  }
  const tag = "v" + version;
  say(`Bible Presenter ${version}`);

  // ---- tools (npm first: it also turns on the pre-push check for this clone)
  const cliWorks = () => spawnSync(process.execPath, [CLI, "--version"], { stdio: "ignore" }).status === 0;
  if (!cliWorks()) {
    const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit", shell: win });
    if (r.status !== 0 || !cliWorks()) fail("npm install не удался (нужен интернет). Если повторяется — удалите папку node_modules и запустите снова.");
  } else {
    spawnSync(process.execPath, [path.join(__dirname, "install-hooks.js")], { cwd: root, stdio: "inherit" });
  }
  const cargo = spawnSync("cargo", ["--version"], { encoding: "utf8", shell: win });
  if (cargo.status !== 0) {
    say("\nRust не установлен (нужен один раз).");
    say(win ? "Откроется https://rustup.rs — скачайте rustup-init.exe, запустите и соглашайтесь со всем (Enter).\nОн сам предложит поставить Visual Studio Build Tools — соглашайтесь."
            : "Запустите build-mac.command ещё раз: он установит Rust сам.");
    if (win) spawnSync("cmd", ["/c", "start", "https://rustup.rs"]);
    fail("После установки закройте это окно и запустите сборку снова.");
  }
  const macTarget = { universal: "universal-apple-darwin", intel: "x86_64-apple-darwin", arm: "aarch64-apple-darwin" }[opt("--mac") || "universal"];
  if (mac && !macTarget) fail("--mac может быть universal, intel или arm.");
  if (mac && !flag("--skip-build")) {
    const need = macTarget === "universal-apple-darwin" ? ["aarch64-apple-darwin", "x86_64-apple-darwin"] : [macTarget];
    const t = spawnSync("rustup", ["target", "add", ...need], { stdio: "inherit" });
    if (t.status !== 0) fail("Не удалось добавить в Rust поддержку " + need.join(" и ") + ".\nRust должен быть установлен через rustup (это делает build-mac.command); проверьте интернет.\nИли соберите только для своего Mac: --mac " + (process.arch === "arm64" ? "arm" : "intel") + ".");
  }

  // ---- where updates come from: this repository's releases
  let repo = repoFromPackage(pkg) || repoFromGit();
  if (!repo) {
    say("\nНе знаю, где лежит проект на GitHub.");
    repo = parseRepo(await ask("Вставьте адрес репозитория (например https://github.com/ivan/bible-presenter) и нажмите Enter: "));
    if (!repo) fail("Это не адрес репозитория GitHub.");
  }
  if (repoFromPackage(pkg) !== repo) {
    pkg.repository = `github:${repo}`;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }
  const confPath = path.join(root, "src-tauri", "tauri.conf.json");
  const conf = readJson(confPath);
  const feed = `https://github.com/${repo}/releases/latest/download/latest.json`;
  if (conf.plugins.updater.endpoints[0] !== feed) {
    conf.plugins.updater.endpoints = [feed];
    fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");
    say(`Адрес обновлений записан в src-tauri/tauri.conf.json (${repo}). Закоммитьте это изменение.`);
  }

  // ---- update signing key (never stored in the project)
  let key = process.env.TAURI_SIGNING_PRIVATE_KEY || "";
  if (!key && !flag("--no-key")) {
    let file = opt("--key") || findKeyFile();
    if (!file) {
      say("\nНужен файл ключа обновлений bible-presenter-updater.key.");
      say("Перетащите его мышкой в это окно и нажмите Enter.");
      say("(Просто Enter — собрать без автообновлений: программа будет работать, но сама обновляться не сможет.)");
      file = cleanDroppedPath(await ask("> "));
    }
    if (file) {
      if (!fs.existsSync(file)) fail("Файл не найден: " + file);
      key = fs.readFileSync(file, "utf8").trim();
      say("Ключ: " + file);
    }
  }
  if (key) checkKey(key);
  else say("Собираю БЕЗ автообновлений.");

  // ---- build
  const buildStart = Date.now();
  const bundleRoot = path.join(root, "src-tauri", "target", mac ? macTarget : "", "release", "bundle");
  if (!flag("--skip-build")) {
    say("\nСборка. Первый раз — 10–20 минут, потом быстрее. Окно не закрывайте.\n");
    const buildArgs = [CLI, "build"];
    if (mac) buildArgs.push("--target", macTarget);
    if (!key) buildArgs.push("--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
    const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" };
    if (!key) delete env.TAURI_SIGNING_PRIVATE_KEY;
    const r = spawnSync(process.execPath, buildArgs, { cwd: root, stdio: "inherit", env });
    if (r.status !== 0) {
      fail("Сборка не удалась. Самое частое:\n" +
        (win ? "  • «link.exe not found» — не установлены Visual Studio Build Tools (переустановите Rust с rustup.rs и согласитесь на них);\n"
             : "  • «xcrun: error» — не установлены инструменты Xcode: запустите build-mac.command ещё раз;\n" +
               "  • «Failed running AppleScript» / bundle_dmg — Терминалу запрещено управлять Finder: Системные настройки → Конфиденциальность и безопасность → Автоматизация → Терминал → включите Finder;\n") +
        "  • нет интернета при первой сборке (скачиваются библиотеки).\nПришлите последние 30 строк из этого окна — разберёмся.");
    }
  }

  // ---- collect
  const out = path.join(root, "release", tag);
  fs.mkdirSync(out, { recursive: true });
  const base = `https://github.com/${repo}/releases/download/${tag}/`;
  const platforms = {};
  const upload = [];
  const copy = (from, name) => { fs.copyFileSync(from, path.join(out, name)); upload.push(name); return name; };
  // A signature only counts if it was made for this very file (not left from an earlier build).
  const sig = (file) => {
    if (!key || !fs.existsSync(file + ".sig")) return null;
    if (fs.statSync(file + ".sig").mtimeMs + 2000 < fs.statSync(file).mtimeMs) return null;
    return fs.readFileSync(file + ".sig", "utf8").trim();
  };
  // Files of this build only: an earlier version's installer may still lie next to it.
  const fresh = (file) => {
    if (!flag("--skip-build") && fs.statSync(file).mtimeMs + 2000 < buildStart) fail("Сборка не обновила " + file + ". Запустите ещё раз.");
    return file;
  };
  const product = readJson(confPath).productName;

  if (win) {
    const dir = path.join(bundleRoot, "nsis");
    const exe = fresh(path.join(dir, `${product}_${version}_x64-setup.exe`));
    if (!fs.existsSync(exe)) fail("Не нашёл результат сборки: " + exe);
    const name = copy(exe, `Bible-Presenter_${version}_x64-setup.exe`);
    const s = sig(exe);
    if (key && !s) fail("Установщик не подписан этой сборкой (нет свежего .sig). Запустите сборку ещё раз, без --skip-build.");
    if (s) platforms["windows-x86_64"] = platforms["windows-x86_64-nsis"] = { signature: s, url: base + name };
    // Computers still on version 2 (Electron) update from latest.yml.
    fs.writeFileSync(path.join(out, "latest.yml"), electronYml(path.join(out, name), name, version));
    upload.push("latest.yml");
  }
  if (mac) {
    const arch = { "universal-apple-darwin": "universal", "x86_64-apple-darwin": "x64", "aarch64-apple-darwin": "arm64" }[macTarget];
    const dmgDir = path.join(bundleRoot, "dmg");
    const dmg = fresh(path.join(dmgDir, pick(dmgDir, new RegExp(`_${version.replace(/\./g, "\\.")}_[^_]+\\.dmg$`, "i"))));
    copy(dmg, `Bible-Presenter_${version}_${arch}.dmg`);
    const tgz = path.join(bundleRoot, "macos", `${product}.app.tar.gz`);
    const s = fs.existsSync(tgz) ? sig(fresh(tgz)) : null;
    if (key && !s) fail("Архив обновления не подписан этой сборкой (нет свежего .app.tar.gz.sig). Запустите сборку ещё раз, без --skip-build.");
    if (s) {
      const name = copy(tgz, `Bible-Presenter_${version}_${arch}.app.tar.gz`);
      const entry = { signature: s, url: base + name };
      if (arch !== "arm64") platforms["darwin-x86_64"] = entry;
      if (arch !== "x64") platforms["darwin-aarch64"] = entry;
    }
  }

  if (Object.keys(platforms).length) {
    const latest = await existingLatest(out, base + "latest.json", version);
    latest.version = version;
    latest.notes = latest.notes || `Bible Presenter ${version}`;
    latest.pub_date = new Date().toISOString();
    latest.platforms = { ...(latest.platforms || {}), ...platforms };
    fs.writeFileSync(path.join(out, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
    upload.push("latest.json");
    const keys = Object.keys(latest.platforms);
    say(`\nlatest.json: ${keys.join(", ")}`);
    if (mac && !keys.some((k) => k.startsWith("windows"))) {
      say("⚠ В релизе на GitHub не нашлось Windows-версии. Если она уже собрана — сначала опубликуйте релиз с ней, потом запустите эту сборку ещё раз (--skip-build), чтобы latest.json содержал обе системы.");
    }
  }

  say("\n✔ Готово. Папка: " + out);
  say(`\nЗагрузите в релиз ${tag} на GitHub (https://github.com/${repo}/releases):`);
  for (const f of upload) say("  • " + f);
  if (upload.includes("latest.json")) say("\nЕсли latest.json там уже есть — удалите старый и загрузите этот (в нём обе системы).");
  openFolder(out);
}

function pick(dir, rx) {
  const f = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => rx.test(x)).sort().pop() : null;
  if (!f) fail("Не нашёл результат сборки в " + dir);
  return f;
}

function parseRepo(s) {
  const t = String(s || "").trim();
  const m = t.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/i) || t.match(/^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}
function repoFromPackage(pkg) {
  const r = pkg.repository;
  return parseRepo(typeof r === "string" ? r : r && r.url);
}
function repoFromGit() {
  const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", shell: win });
  return r.status === 0 && /github\.com/i.test(r.stdout) ? parseRepo(r.stdout) : null;
}

function findKeyFile() {
  const name = "bible-presenter-updater.key";
  const home = os.homedir();
  const places = [path.join(root, ".."), home, path.join(home, "Desktop"), path.join(home, "Downloads"), path.join(home, "Documents"),
    path.join(home, "OneDrive", "Desktop"), path.join(home, "OneDrive", "Documents")];
  return places.map((p) => path.join(p, name)).find((p) => fs.existsSync(p));
}
// A file dropped into Terminal arrives as /path/with\ spaces or 'quoted'; into cmd as "C:\path".
function cleanDroppedPath(s) {
  s = s.trim();
  if (/^(['"]).*\1$/.test(s)) s = s.slice(1, -1);
  return win ? s : s.replace(/\\(.)/g, "$1");
}

// Signs a scratch file: a wrong or damaged key is caught now, not after 15 minutes of compiling.
function checkKey(key) {
  const tmp = path.join(os.tmpdir(), `bp-keycheck-${process.pid}.txt`);
  fs.writeFileSync(tmp, "check");
  const r = spawnSync(process.execPath, [CLI, "signer", "sign", tmp], {
    encoding: "utf8", env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" },
  });
  for (const f of [tmp, tmp + ".sig"]) try { fs.unlinkSync(f); } catch (e) {}
  if (r.status !== 0) {
    const why = String(r.stderr || "").trim().split("\n").slice(-3).join("\n");
    fail("Ключ не подходит (файл повреждён или это другой файл). Нужен bible-presenter-updater.key — тот, что без .pub." + (why ? "\n\nПодробности:\n" + why : ""));
  }
  // Same key pair? Both the public key and a minisign signature carry the key id (bytes 2..10).
  const conf = readJson(path.join(root, "src-tauri", "tauri.conf.json"));
  const keyIdOf = (b64) => {
    const line = Buffer.from(b64, "base64").toString().split("\n")[1] || "";
    return Buffer.from(line, "base64").subarray(2, 10).toString("hex");
  };
  const sigB64 = (r.stdout.match(/Public signature:\s*(\S+)/) || [])[1] || "";
  const pubId = keyIdOf(conf.plugins.updater.pubkey), sigId = sigB64 ? keyIdOf(sigB64) : "";
  if (pubId && sigId && pubId !== sigId) {
    fail("Этот ключ не от этой программы: установленные копии не примут такое обновление.\nНужен тот же bible-presenter-updater.key, чей .pub записан в src-tauri/tauri.conf.json.");
  }
}

async function existingLatest(out, url, version) {
  const local = path.join(out, "latest.json");
  let cur = null;
  try {
    const r = await fetch(url, { redirect: "follow" });
    if (r.ok) cur = await r.json();
  } catch (e) {}
  if (!cur && fs.existsSync(local)) cur = readJson(local);
  return cur && cur.version === version ? cur : {};
}

function electronYml(file, assetName, version) {
  const buf = fs.readFileSync(file);
  const sha512 = crypto.createHash("sha512").update(buf).digest("base64");
  return [
    `version: ${version}`, "files:", `  - url: ${assetName}`, `    sha512: ${sha512}`, `    size: ${buf.length}`,
    `path: ${assetName}`, `sha512: ${sha512}`, `releaseDate: '${new Date().toISOString()}'`, "",
  ].join("\n");
}

if (require.main === module) main().catch((e) => fail(e && e.stack || String(e)));
module.exports = { checkKey, parseRepo, cleanDroppedPath };
