// End-to-end smoke test: the real app, its real windows, a fresh data folder.
// Only the paths an operator cannot live without on a Sunday morning:
//   start -> verse on screen -> pasted song on screen, Next -> PDF on screen
//   -> phone pairs and presses Next.
// Runs inside the control window (scripts/e2e.js starts the app with BP_TEST
// pointing here and puts `const FIX = "<fixtures folder>/";` in front).
const log = (m) => bp.call("test:log", String(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shown = () => bp.call("test:shown");
const last = async () => { const s = await shown(); return s[s.length - 1] || ""; };
const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(150); } return false; };
const click = (id) => document.getElementById(id).click();
const errors = [];
window.addEventListener("error", (e) => errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason && e.reason.message || e.reason)));
let fails = 0;
const check = async (cond, what) => { if (!cond) fails++; await log((cond ? "PASS " : "FAIL ") + what); };
const step = async (name, fn) => { try { await fn(); } catch (e) { fails++; await log("FAIL " + name + ": " + (e && e.stack || e)); } };
const closeDialog = async () => { await until(() => document.getElementById("dlgOverlay").style.display === "flex", 3000); click("dlgOk"); await sleep(200); };

await step("start", async () => {
  const out = await bp.call("test:outputState");
  await check(out.exists && out.visible, "projector window is open");
});

await step("bible", async () => {
  await bp.call("test:answer", [FIX + "bible-zefania.xml"]);
  click("btnImportBibleXml");
  await closeDialog(); // "Imported translation …"
  const input = document.getElementById("refSearch");
  input.value = "John 3:16";
  click("btnRefGo");
  await until(() => document.querySelector("#verseList .verseRow.active[data-v='16']"));
  document.querySelector("#verseList .verseRow.active").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await until(async () => /@John 3:16$/.test(await last()));
  const s = await last();
  await check(/so loved the world/.test(s) && /@John 3:16$/.test(s), "typed reference puts the verse on screen: " + s);
});

await step("song", async () => {
  document.querySelector('.nav-tab[data-view="songsView"]').click();
  click("btnPasteSong");
  document.getElementById("pasteSongText").value = "Verse 1\nAmazing grace how sweet the sound\nThat saved a wretch like me\n\nChorus\nMy chains are gone\nI've been set free";
  click("btnApplyPasteSong");
  const first = await until(() => document.querySelector("#sectionsContainer .slideCard"));
  await check(first, "pasted lyrics split into slides");
  document.querySelector("#sectionsContainer .slideCard").click();
  await until(async () => /Amazing grace/.test(await last()));
  await check(/Amazing grace/.test(await last()), "clicked slide is on screen");
  document.activeElement && document.activeElement.blur();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await until(async () => /My chains/.test(await last()));
  await check(/My chains/.test(await last()), "Next (clicker / arrow key) goes to the chorus");
});

await step("presentation", async () => {
  document.querySelector('.nav-tab[data-view="presView"]').click();
  await bp.call("test:answer", [FIX + "handout.pdf"]);
  click("btnImportPptx");
  const ok = await until(() => document.querySelectorAll("#presSlideGrid .slideCard").length === 2, 30000);
  await check(ok, "PDF imported as 2 slides");
  const before = (await shown()).length;
  document.querySelector("#presSlideGrid .slideCard").click();
  await until(async () => (await shown()).length > before);
  await check((await last()) === "IMAGE", "PDF slide is on screen as a picture");
});

await step("phone remote", async () => {
  const PORT = 7791, base = "http://127.0.0.1:" + PORT;
  const r = await window.remoteApi.start(PORT);
  await check(r && r.ok !== false, "remote server starts");
  const st = await window.remoteApi.status();
  const pair = await bp.call("test:http", { method: "POST", url: base + "/api/pair", body: { pin: st.pin } });
  const key = pair.status === 200 ? JSON.parse(pair.text).key : "";
  await check(!!key, "phone pairs with the PIN");
  const before = (await shown()).length;
  const res = await bp.call("test:http", { method: "POST", url: base + "/api/cmd", body: { cmd: "next" }, headers: { "X-Key": key } });
  await until(async () => (await shown()).length > before);
  await check(res.status === 200 && (await shown()).length === before + 1, "Next on the phone moves the projector on");
  await window.remoteApi.stop();
});

await check(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
await log("TOTAL FAILS: " + fails);
await bp.call("test:exit");
