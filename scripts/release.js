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
const { spawnSync, spawn } = require("child_process");
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

// Rust installs itself into ~/.cargo/bin; a program started from Explorer or Finder
// may not have that on PATH yet (it only sees it after logging out and in).
process.env.PATH = path.join(os.homedir(), ".cargo", "bin") + path.delimiter + process.env.PATH;

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
    const r = spawnSync("npm install --no-audit --no-fund", { cwd: root, stdio: "inherit", shell: true });
    if (r.status !== 0 || !cliWorks()) fail("npm install не удался (нужен интернет). Если повторяется — удалите папку node_modules и запустите снова.");
  } else {
    spawnSync(process.execPath, [path.join(__dirname, "install-hooks.js")], { cwd: root, stdio: "inherit" });
  }
  ensureRust();
  let macTarget = { universal: "universal-apple-darwin", intel: "x86_64-apple-darwin", arm: "aarch64-apple-darwin" }[opt("--mac") || "universal"];
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
  const LOG = path.join(root, "release", "build-log.txt");
  const bundleOf = (t) => path.join(root, "src-tauri", "target", mac ? t : "", "release", "bundle");
  let bundleRoot = bundleOf(macTarget);
  if (!flag("--skip-build")) {
    say("\nСборка. Первый раз — 10–20 минут, потом быстрее. Окно не закрывайте.\n");
    const env = privateBuildEnv({ ...process.env, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" });
    if (!key) delete env.TAURI_SIGNING_PRIVATE_KEY;
    const buildWith = (target) => {
      const buildArgs = [CLI, "build"];
      if (mac) buildArgs.push("--target", target);
      if (!key) buildArgs.push("--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
      return runLogged(process.execPath, buildArgs, { cwd: root, env }, LOG);
    };
    let status = await buildWith(macTarget);
    if (status !== 0) {
      explainFailure(LOG, win);
      // A universal build compiles the whole program twice (Intel and Apple Silicon); on an older
      // Mac the second architecture can fail even though the Mac's own one works.
      if (mac && macTarget === "universal-apple-darwin") {
        const own = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
        const label = process.arch === "arm64" ? "Apple Silicon" : "Intel";
        say("\nМожно собрать версию только для этого Mac (" + label + "). Она работает на таких же Mac;");
        say("на Mac с другим процессором она пойдёт через эмуляцию, но обновления для них придут позже.");
        const answer = await ask("Собрать только для этого Mac? Enter — да, n — нет: ");
        if (answer.toLowerCase() !== "n") {
          macTarget = own;
          bundleRoot = bundleOf(macTarget);
          say("\nСобираю только для " + label + "…\n");
          status = await buildWith(macTarget);
          if (status !== 0) explainFailure(LOG, win);
        }
      }
      if (status !== 0) fail("Сборка не удалась. Полный журнал сохранён в файле:\n  " + LOG + "\nПришлите этот файл или фразы с «error» из списка выше.");
    }
  }

  // ---- the program must not carry this computer's user name
  checkNoPersonalPaths(win
    ? [path.join(root, "src-tauri", "target", "release", "bible-presenter.exe")]
    : appBinaries(path.join(bundleRoot, "macos")));

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

// Finds out what is wrong with Rust and, where possible, fixes it: a half-finished
// install (the window was closed before "Rust is installed now") leaves cargo.exe
// without a toolchain, which looks exactly like "not installed".
// Compilers write the paths of the source files they compile into the program
// (for error messages). Rust libraries live in ~/.cargo, so the program would
// carry the builder's user name, e.g. C:\Users\Ivan Petrenko. For a release the
// libraries go to a separate folder with no name in its path, and the
// remaining paths are rewritten to neutral ones.
function privateBuildEnv(env) {
  // Code put into this folder would run inside the release build, so only
  // this account may write there. On Windows, folders at the root of the drive
  // are writable by every account until their permissions are narrowed.
  const shared = win ? path.join((process.env.SystemDrive || "C:") + "\\", "BiblePresenter-build") : "/Users/Shared/BiblePresenter-build";
  const cargoHome = path.join(shared, "cargo");
  fs.mkdirSync(cargoHome, { recursive: true });
  if (win) {
    const who = (process.env.USERDOMAIN ? process.env.USERDOMAIN + "\\" : "") + process.env.USERNAME;
    // SIDs, not names: "Administrators" is called differently in a Russian Windows.
    const r = spawnSync("icacls", [shared, "/inheritance:r", "/grant:r", `${who}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "/Q"], { encoding: "utf8" });
    if (r.status !== 0) {
      say("Не удалось закрыть папку " + shared + " от других пользователей; библиотеки останутся в обычной папке.");
      delete env.CARGO_HOME;
      env.CARGO_ENCODED_RUSTFLAGS = `--remap-path-prefix=${os.homedir()}=~\x1f--remap-path-prefix=${root}=/bible-presenter`;
      delete env.RUSTFLAGS;
      return env;
    }
  }
  if (!win) {
    // /Users/Shared is open to every account: use the folder only if it is ours
    // and nobody else can write into it.
    for (const d of [shared, cargoHome]) {
      const s = fs.statSync(d);
      if (s.uid !== process.getuid()) fail("Папка " + d + " создана другим пользователем Mac. Удалите её и запустите сборку ещё раз.");
      fs.chmodSync(d, 0o700);
    }
  }
  env.CARGO_HOME = cargoHome;
  // Cargo's own list format: one flag per item, so paths with spaces survive.
  env.CARGO_ENCODED_RUSTFLAGS = [
    `--remap-path-prefix=${os.homedir()}=~`,
    `--remap-path-prefix=${root}=/bible-presenter`,
    `--remap-path-prefix=${cargoHome}=/cargo`,
  ].join("\x1f");
  delete env.RUSTFLAGS;
  // C parts (the TLS library) built on a Mac: the same rewrite for clang.
  if (mac && !/\s/.test(os.homedir() + root)) {
    const map = `-ffile-prefix-map=${os.homedir()}=~ -ffile-prefix-map=${root}=/bible-presenter`;
    env.CFLAGS = ((env.CFLAGS || "") + " " + map).trim();
    env.CXXFLAGS = ((env.CXXFLAGS || "") + " " + map).trim();
  }
  return env;
}

function appBinaries(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const app of fs.readdirSync(dir).filter((n) => n.endsWith(".app"))) {
    const bin = path.join(dir, app, "Contents", "MacOS");
    if (fs.existsSync(bin)) for (const f of fs.readdirSync(bin)) out.push(path.join(bin, f));
  }
  return out;
}

// Looks inside the built program for this computer's home folder or user name in a
// path (also the short Windows form like C:\Users\IVANPE~1). Stops the release if found.
function checkNoPersonalPaths(files) {
  const user = os.userInfo().username;
  const needles = new Set([os.homedir(), os.homedir().replace(/\\/g, "/"), `Users\\${user}`, `Users/${user}`]);
  for (const n of [...needles]) if (n.length < 6) needles.delete(n);
  const short = /Users\\[A-Z0-9]{1,6}~\d/; // 8.3 short folder names
  let found = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const buf = fs.readFileSync(f);
    const asText = buf.toString("latin1");
    const asWide = buf.toString("utf16le");
    for (const n of needles) {
      if (asText.includes(n) || asWide.includes(n) || asText.toLowerCase().includes(n.toLowerCase())) found.push(n);
    }
    if (win && (short.test(asText) || short.test(asWide))) found.push("C:\\Users\\…~1");
  }
  found = [...new Set(found)];
  if (found.length) {
    fail("В собранной программе есть путь с именем пользователя этого компьютера (" + found.join(", ") + ").\n" +
      "Такие файлы загружать нельзя. Пришлите файл release/build-log.txt.");
  }
  say("Проверено: в программе нет имени пользователя этого компьютера.");
}

function ensureRust() {
  const exe = win ? "cargo.exe" : "cargo";
  const home = path.join(os.homedir(), ".cargo", "bin", exe);
  const probe = () => spawnSync(fs.existsSync(home) ? home : "cargo", ["--version"], { encoding: "utf8" });
  let r = probe();
  if (r.status === 0) return;
  if (fs.existsSync(home)) {
    say("\nRust установлен не до конца (нет набора инструментов). Достраиваю — нужен интернет, 1–3 минуты…\n");
    spawnSync(path.join(path.dirname(home), win ? "rustup.exe" : "rustup"), ["default", "stable"], { stdio: "inherit" });
    r = probe();
    if (r.status === 0) return;
    fail("Rust найден (" + home + "), но не запускается:\n" + String(r.stderr || r.error || "").trim() +
      "\n\nПришлите этот текст. Обычно помогает перезагрузка компьютера и повторный запуск.");
  }
  say("\nRust не найден: " + home + " нет.");
  say("Значит, установка не была завершена. В окне rustup нужно:");
  say("  1. нажать 1 и Enter (стандартная установка);");
  say("  2. дождаться надписи «Rust is installed now. Great!» и только потом закрывать окно.");
  say(win ? "Если окно уже закрыто — скачайте rustup-init.exe ещё раз (откроется страница)." : "");
  if (win) spawnSync("cmd", ["/c", "start", "", "https://rustup.rs"]);
  fail("Завершите установку Rust и запустите сборку снова.");
}

// Runs a command, shows its output live and keeps all of it in a log file.
function runLogged(cmd, args, opts, logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.createWriteStream(logFile);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["inherit", "pipe", "pipe"] });
    child.stdout.on("data", (d) => { process.stdout.write(d); log.write(d); });
    child.stderr.on("data", (d) => { process.stderr.write(d); log.write(d); });
    child.on("error", (e) => { log.write(String(e)); });
    child.on("close", (code) => log.end(() => resolve(code === null ? 1 : code)));
  });
}

// The cause of a failed build is a few lines in thousands; show those, not the compiler command lines.
function explainFailure(logFile, isWin) {
  let lines = [];
  try { lines = fs.readFileSync(logFile, "utf8").split(/\r?\n/); } catch (e) {}
  const hits = [];
  for (const l of lines) {
    const t = l.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!t || t.startsWith('"') || t.length > 400) continue;
    if (/\b(error|fatal|failed|undefined symbol|not found|No such file|cannot find)\b/i.test(t) && !hits.includes(t)) hits.push(t);
  }
  say("\n✖ Сборка не удалась. Главные строки с ошибками:");
  for (const h of hits.slice(0, 14)) say("  " + h.slice(0, 220));
  if (!hits.length) say("  (понятных строк не нашлось — смотрите журнал)");
  say("\nСамое частое:");
  if (isWin) say("  • «link.exe not found» — не установлены Visual Studio Build Tools (запустите rustup-init.exe ещё раз, выберите 1 и согласитесь на них);");
  else {
    say("  • «xcrun: error» или ошибки clang / «assembler» — устарели или не установлены инструменты Apple: Системные настройки → Основные → Обновление ПО,");
    say("    а если там пусто — в Терминале: sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install");
    say("  • «Failed running AppleScript» / bundle_dmg — Терминалу запрещено управлять Finder: Системные настройки → Конфиденциальность и безопасность → Автоматизация → Терминал → включите Finder;");
  }
  say("  • нет интернета при первой сборке (скачиваются библиотеки).");
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
  const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" });
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
module.exports = { checkKey, parseRepo, cleanDroppedPath, checkNoPersonalPaths };
