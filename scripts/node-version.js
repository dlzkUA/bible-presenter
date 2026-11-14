// Node.js runs the build and release scripts, and the release script fetches
// latest.json from GitHub with it. The installed app itself has no Node in
// it (Rust + the system web view), so this only matters on the computer that
// builds. Lines below are the first patched versions of each supported line
// after the October 2026 security release (zlib/Brotli, TLS, http, dns).
const MIN = { 22: [22, 23, 4], 24: [24, 22, 1], 26: [26, 12, 1] };

function parse(v) { return String(v).replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0); }
function older(a, b) { for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; } return false; }

// null when fine, otherwise the reason in plain words (Russian, like the
// other messages the owner sees while building).
function nodeProblem(version = process.version) {
  const v = parse(version);
  const min = MIN[v[0]];
  if (!min) {
    return `Node.js ${version} не получает исправлений безопасности. Установите версию LTS с nodejs.org (22.${MIN[22][1]}.${MIN[22][2]}, 24.${MIN[24][1]}.${MIN[24][2]} или новее) и запустите снова.`;
  }
  if (older(v, min)) {
    return `Node.js ${version} содержит уязвимости, закрытые в ${min.join(".")}. Обновите Node.js с nodejs.org (версия LTS) и запустите снова.`;
  }
  return null;
}

module.exports = { nodeProblem, MIN };
