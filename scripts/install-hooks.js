// Run by "npm install" (the "prepare" script) and by the release scripts:
// turns on the pre-push check in .githooks for this clone. Does nothing
// outside a git checkout. Works without git on PATH (GitHub Desktop keeps its
// own git): a small hook in .git/hooks hands over to .githooks/pre-push.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const gitDir = path.join(root, ".git");
if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) process.exit(0);

let on = false;
try {
  const hooks = path.join(gitDir, "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  const hook = path.join(hooks, "pre-push");
  const body = '#!/bin/sh\n# Installed by scripts/install-hooks.js: the project\'s checks before a push to master.\nexec sh .githooks/pre-push "$@"\n';
  if (!fs.existsSync(hook) || fs.readFileSync(hook, "utf8") !== body) fs.writeFileSync(hook, body);
  fs.chmodSync(hook, 0o755);
  fs.chmodSync(path.join(root, ".githooks", "pre-push"), 0o755);
  on = true;
} catch (e) {}
// Also through git itself when it is on PATH (covers a clone whose .git/hooks is replaced).
const r = spawnSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root, stdio: "ignore" });
if (on || r.status === 0) console.log("Git hook on: the checks run before every push to master.");
else console.warn("Could not turn on the git hook: pushes to master will not run the checks by themselves. Run \"npm run check\" before pushing.");
