// ═══════════════════════════════════════════════════════════
//  Bible Presenter — Control Window Script
// ═══════════════════════════════════════════════════════════

// ── Utils ──────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function toFileUrl(p) {
  // Files on disk are shown through the app's asset protocol (see bridge.js).
  return window.bp.fileUrl(p);
}

// In-app dialogs (Electron disables native window.prompt/confirm).
//
// Native alert() is not used anywhere: on Windows it leaves the window looking
// active while keystrokes no longer reach the page — the song title field
// "stopped working" until the operator clicked another window and back.
// Dialogs are queued so two never fight over the same overlay, and focus goes
// back to where it was (or to a field the caller names) when one closes.
let dlgChain = Promise.resolve();
function runDialog(open) {
  const p = dlgChain.then(() => new Promise((resolve) => {
    const prev = document.activeElement;
    open((value) => {
      resolve(value);
      setTimeout(() => {
        const target = (runDialog.focusNext && document.body.contains(runDialog.focusNext)) ? runDialog.focusNext : prev;
        runDialog.focusNext = null;
        if (target && target !== document.body && typeof target.focus === "function") { try { target.focus(); } catch (e) {} }
      }, 0);
    });
  }));
  dlgChain = p.catch(() => {});
  return p;
}
function appAlert(message, focusAfter) {
  if (focusAfter) runDialog.focusNext = focusAfter;
  return runDialog((resolve) => {
    const ov = document.getElementById("dlgOverlay");
    document.getElementById("dlgInput").style.display = "none";
    document.getElementById("dlgSelect").style.display = "none";
    document.getElementById("dlgMsg").textContent = message;
    const ok = document.getElementById("dlgOk");
    const cancel = document.getElementById("dlgCancel");
    cancel.style.display = "none";
    ov.style.display = "flex";
    ok.focus();
    const cleanup = () => { ov.style.display = "none"; cancel.style.display = ""; ok.onclick = null; cancel.onclick = null; };
    ok.onclick = () => { cleanup(); resolve(true); };
    cancel.onclick = () => { cleanup(); resolve(true); };
  });
}
function appPrompt(message, defaultValue = "") {
  return runDialog((resolve) => {
    const ov = document.getElementById("dlgOverlay");
    const input = document.getElementById("dlgInput");
    document.getElementById("dlgSelect").style.display = "none";
    document.getElementById("dlgMsg").textContent = message;
    document.getElementById("dlgCancel").style.display = "";
    input.style.display = "block";
    input.value = defaultValue;
    ov.style.display = "flex";
    input.focus();
    input.select();
    const ok = document.getElementById("dlgOk");
    const cancel = document.getElementById("dlgCancel");
    const cleanup = () => { ov.style.display = "none"; ok.onclick = null; cancel.onclick = null; input.onkeydown = null; };
    ok.onclick = () => { const v = input.value; cleanup(); resolve(v); };
    cancel.onclick = () => { cleanup(); resolve(null); };
    input.onkeydown = (e) => { if (e.key === "Enter") ok.onclick(); if (e.key === "Escape") cancel.onclick(); };
  });
}

// Pick one of the existing collections, "no collection", or type a new one —
// retyping a name by hand to reuse it invited typos that silently split one
// collection into two ("Worship" vs "Worship ").
const NEW_COLLECTION = "\uE000__new__";
function appChooseCollection(message, existing, current) {
  return runDialog((resolve) => {
    const ov = document.getElementById("dlgOverlay");
    const sel = document.getElementById("dlgSelect");
    const input = document.getElementById("dlgInput");
    document.getElementById("dlgMsg").textContent = message;
    document.getElementById("dlgCancel").style.display = "";
    sel.innerHTML =
      `<option value="">${esc(window.i18n.t("— Без збірки —"))}</option>` +
      existing.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("") +
      `<option value="${NEW_COLLECTION}">${esc(window.i18n.t("+ Нова збірка…"))}</option>`;
    sel.value = existing.includes(current) ? current : "";
    sel.style.display = "block";
    input.style.display = "none";
    input.value = "";
    input.placeholder = window.i18n.t("Назва нової збірки:");
    // "New" reveals the text field in the same dialog instead of a second popup.
    sel.onchange = () => {
      const isNew = sel.value === NEW_COLLECTION;
      input.style.display = isNew ? "block" : "none";
      if (isNew) input.focus();
    };
    ov.style.display = "flex";
    sel.focus();
    const ok = document.getElementById("dlgOk");
    const cancel = document.getElementById("dlgCancel");
    const cleanup = () => {
      ov.style.display = "none"; sel.style.display = "none"; input.style.display = "none";
      input.placeholder = ""; ok.onclick = null; cancel.onclick = null; sel.onchange = null; input.onkeydown = null;
    };
    ok.onclick = () => {
      let v = sel.value;
      if (v === NEW_COLLECTION) {
        v = input.value.trim();
        if (!v) { input.focus(); return; }          // empty new name: stay open
      }
      cleanup(); resolve(v);
    };
    cancel.onclick = () => { cleanup(); resolve(null); };
    input.onkeydown = (e) => { if (e.key === "Enter") ok.onclick(); if (e.key === "Escape") cancel.onclick(); };
  });
}

function appConfirm(message) {
  return runDialog((resolve) => {
    const ov = document.getElementById("dlgOverlay");
    document.getElementById("dlgInput").style.display = "none";
    document.getElementById("dlgSelect").style.display = "none";
    document.getElementById("dlgMsg").textContent = message;
    document.getElementById("dlgCancel").style.display = "";
    ov.style.display = "flex";
    const ok = document.getElementById("dlgOk");
    const cancel = document.getElementById("dlgCancel");
    const cleanup = () => { ov.style.display = "none"; ok.onclick = null; cancel.onclick = null; };
    ok.onclick = () => { cleanup(); resolve(true); };
    cancel.onclick = () => { cleanup(); resolve(false); };
  });
}

// ── Tab switching ───────────────────────────────────────────
const SIDEBARS = { bibleView: "bibleSidebar", songsView: "songsSidebar", presView: "presSidebar", annView: "annSidebar" };
const SIDEBAR_ACTIONS = { bibleView: "bibleSidebarActions", songsView: "songsSidebarActions", presView: "presSidebarActions", annView: "annSidebarActions" };

function switchTab(viewId) {
  document.querySelectorAll(".nav-tab").forEach(t => t.classList.toggle("active", t.dataset.view === viewId));
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  Object.values(SIDEBARS).forEach(id => { const el = document.getElementById(id); if (el) el.style.display = "none"; });
  Object.values(SIDEBAR_ACTIONS).forEach(id => { const el = document.getElementById(id); if (el) el.style.display = "none"; });
  const view = document.getElementById(viewId);
  if (view) view.classList.add("active");
  // Bible browses in its own pane; collapse the (now empty) sidebar column.
  document.body.classList.toggle("bibleTab", viewId === "bibleView");
  const sb = document.getElementById(SIDEBARS[viewId]);
  if (sb) sb.style.display = "";
  const sa = document.getElementById(SIDEBAR_ACTIONS[viewId]);
  if (sa) sa.style.display = "";
}

document.querySelectorAll(".nav-tab").forEach(tab => {
  tab.addEventListener("click", () => switchTab(tab.dataset.view));
});

// The Bible tab is active from markup, so switchTab() never runs at startup —
// apply its sidebar state directly or the empty column shows on first launch.
document.body.classList.add("bibleTab");

// ── Global clear ────────────────────────────────────────────
// ── Output show/hide state (for presenter-remote show/blank buttons) ──
// The R400-style pult sends F5 (show) / Esc (hide) from its slideshow button
// and "b" / "." from its blank-screen button. We track the last shown slide
// so "show" can bring it right back after a hide.
let lastShownPayload = null;
let screenVisible = false;

function getTransitionMs() {
  // "No transition" wins outright — checked separately from the slider so
  // switching it off restores whatever speed was set before, instead of
  // losing it.
  if (localStorage.getItem("transitionMsNone") === "1") return 0;
  const raw = localStorage.getItem("transitionMs");
  if (raw === null) return 400; // default: Number(null) is 0, which killed transitions
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : 400;
}

// A background chosen from the strip overrides whatever the active theme
// carries, for text slides only. Announcement photos/videos are the slide
// itself, so they are never covered by it.
let liveBackground = null; // { file, type, path } or null

function applyLiveBackground(payload) {
  if (!liveBackground) return payload;
  if (payload.image || payload.video) return payload; // media slide: leave alone
  payload.theme = {
    ...(payload.theme || {}),
    bgUrl: toFileUrl(liveBackground.path),
    bgType: liveBackground.type,
    bgFit: (payload.theme && payload.theme.bgFit) || "cover",
  };
  return payload;
}

// When the stream is "held clear", new slides must NOT sneak back onto the
// broadcast — the operator blanked it deliberately and it stays blank until
// they press the button again.
let streamBlackout = false;

// Strings with names or numbers inside can't be dictionary keys as-is — the
// key is the template, the values are substituted after translation.
function tf(key, vars) {
  let out = window.i18n.t(key);
  for (const [k, v] of Object.entries(vars || {})) out = out.split("{" + k + "}").join(String(v));
  return out;
}

// Looks one step ahead in whatever is currently armed — song slides, verses or
// presentation slides — without moving the playback position.
function peekNextSlideText() {
  try {
    if (!playbackQueue) return "";
    if (playbackQueue.type === "song" || playbackQueue.type === "pres") {
      const n = playbackQueue.slides && playbackQueue.slides[playbackIndex + 1];
      if (!n) return playbackQueue.fromPlaylist ? nextPlaylistLabel() : "";
      return typeof n === "string" ? n : (n.text || "");
    }
    if (playbackQueue.type === "plMedia") return nextPlaylistLabel();
    if (playbackQueue.type === "bible" && currentBook) {
      const nextV = currentVerse + 1;
      if (nextV > (playbackQueue.count || 0)) return "";
      const row = verseList.querySelector(`.verseRow[data-v="${nextV}"] .vt`);
      return row ? row.textContent : "";
    }
  } catch (e) {}
  return "";
}

// At the end of a playlist entry the stage display shows what comes next in
// the service ("→ It Is Well") instead of going blank.
function nextPlaylistLabel() {
  try {
    if (!currentPlaylist || livePlIdx < 0) return "";
    const it = currentPlaylist.items[livePlIdx + 1];
    if (!it) return "";
    const label = playlistItemLabel(it);
    return label ? "→ " + label : "";
  } catch (e) { return ""; }
}
function playlistItemLabel(item) {
  if (!item) return "";
  if (item.type === "bible") return `${item.bookName} ${item.chapter}:${item.verse}`;
  if (item.type === "announcement") return item.title || (item.text || "").slice(0, 40) || window.i18n.t("Об'ява");
  return item.title || "";
}

function showOnOutput(payload) {
  // Tag the slide kind so the stream can apply its own look per content type.
  if (!payload.kind) {
    payload.kind = payload.reference ? "bible" : (payload.image || payload.video) ? "media" : "song";
  }
  payload = applyLiveBackground(payload);
  // The stage monitor needs to know what is coming, not just what is up.
  payload.nextText = peekNextSlideText();
  payload.transitionMs = getTransitionMs();
  lastShownPayload = payload;
  screenVisible = true;
  window.outputApi.showSlide(payload);
  remoteSync();
}

function toggleScreen(mode) {
  // mode: "show" | "hide" | "toggle"
  const wantHide = mode === "hide" || (mode === "toggle" && screenVisible);
  if (wantHide) {
    window.outputApi.clear();
    screenVisible = false;
  } else if (lastShownPayload) {
    window.outputApi.showSlide(lastShownPayload);
    screenVisible = true;
  }
  remoteSync();
}

function clearScreen() {
  window.outputApi.clear();
  screenVisible = false;
  // Reset the clicker queue: after clearing, arrows must not resurrect the
  // previous song/presentation until the operator explicitly shows something.
  playbackQueue = null;
  playbackIndex = -1;
  remoteSync();
}
document.getElementById("globalClear").addEventListener("click", clearScreen);

// Clear the WORDS but keep the background running. Between songs the room
// should not drop to black — the loop keeps going, the text simply goes away.
function clearText() {
  const base = lastShownPayload && !lastShownPayload.image && !lastShownPayload.video
    ? { ...lastShownPayload } : {};
  showOnOutput({ ...base, text: "", reference: undefined });
}
document.getElementById("btnClearText").addEventListener("click", clearText);
document.getElementById("btnClear").addEventListener("click", clearScreen);

// ════════════════════════════════════════════════════════════
//  BIBLE
// ════════════════════════════════════════════════════════════
let translations = [], currentTranslationId = null, books = [], currentBook = null;
let currentChapter = 1, currentVerse = 1, currentVerseCount = 0;
const translationSelect = document.getElementById("translationSelect");
const bookSearch = document.getElementById("bookSearch2");
const bookListEl = document.getElementById("bookList");
const chapterList = document.getElementById("chapterList");
const verseList = document.getElementById("verseList");
const previewText = document.getElementById("previewText");

// ---- Language ----
const langSelect = document.getElementById("langSelect");
function initLang() {
  const saved = localStorage.getItem("uiLang") || "en";   // English by default
  window.i18n.setLang(saved);
  langSelect.innerHTML = window.i18n.LANGS.map(l => `<option value="${esc(l.id)}">${l.label}</option>`).join("");
  langSelect.value = window.i18n.getLang();
  window.i18n.applyI18n();
  window.i18n.observeI18n();
}
// Settings popover: keeps language and transition speed out of the top bar.
{
  const pop = document.getElementById("settingsPop");
  const btn = document.getElementById("btnSettings");
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    pop.classList.toggle("open");
    if (pop.classList.contains("open")) {
      // Shown on open so "did the update install?" is answerable at a glance.
      try {
        const i = await window.systemApi.appInfo();
        document.getElementById("appInfo").innerHTML =
          `<b>Bible Presenter ${esc(i.version)}</b>` +
          (i.buildDate ? ` · ${esc(i.buildDate)}` : "") +
          `<br>${esc(window.i18n.t("Програма:"))} ${esc(i.exeDir || "—")}` +
          `<br>${esc(window.i18n.t("Дані:"))} ${esc(i.dataDir || "—")}`;
      } catch (e2) {}
    }
  });
  document.addEventListener("click", (e) => {
    if (!pop.contains(e.target) && e.target !== btn) pop.classList.remove("open");
  });

  document.getElementById("btnCheckUpdates").addEventListener("click", async () => {
    const out = document.getElementById("updateStatus");
    out.textContent = window.i18n.t("Перевіряю…");
    try {
      const r = await window.systemApi.checkForUpdates();
      if (r.status === "available") {
        out.textContent = window.i18n.t("Доступна версія") + " " + r.version + " — " + window.i18n.t("завантажується у фоні");
      } else if (r.status === "current") {
        out.textContent = window.i18n.t("У вас найновіша версія");
      } else if (r.status === "unavailable") {
        // Dev build, or the app was not installed from a release.
        out.textContent = window.i18n.t("Оновлення доступні лише у встановленій версії");
      } else {
        out.textContent = window.i18n.t("Не вдалося перевірити оновлення");
      }
    } catch (e) {
      out.textContent = window.i18n.t("Не вдалося перевірити оновлення");
    }
  });
}

langSelect.addEventListener("change", async () => {
  // The reload below would drop an untitled song's text: ask first, as when
  // switching songs. A titled song is simply saved.
  if (!(await confirmDiscardSongChanges())) { langSelect.value = window.i18n.getLang(); return; }
  localStorage.setItem("uiLang", langSelect.value);
  location.reload();   // simplest reliable way to re-render every dynamic list
});
initLang();

// Native dialogs are drawn by the main process, which has no dictionary of
// its own: hand it the strings it shows, already in the active language.
const MAIN_PROCESS_STRINGS = [
  "Імпорт перекладу Біблії (XML)", "Експортувати пісню", "Імпортувати пісню (JSON)", "Експортувати плейлист",
  "Імпортувати плейлист (JSON)", "Експортувати тему", "Імпортувати тему (JSON)", "Додати фони (картинки та відео)",
  "Оберіть фон (картинка або відео)", "Імпорт теми трансляції (JSON)", "Експортувати тему трансляції",
  "Імпорт медіа (об'яви) — картинки та відео", "Імпорт теми ProPresenter (.proTheme)",
  "Імпорт пісні з ProPresenter (.pro)", "Оберіть теку бібліотеки ProPresenter", "Картинки та відео", "Картинки",
  "Відео", "Презентації", "Імпорт презентації (.pptx, .pdf)", "Об'яви", "Порт {port} вже зайнятий іншою програмою.",
  "Перезапустити зараз", "Пізніше", "Оновлення готове", "Bible Presenter {version} завантажено.",
  "Оновлення встановиться автоматично, коли ви закриєте програму. Можна також перезапустити зараз.",
  "Продовжити без збереження", "Залишитися", "У пісні є незбережені зміни.", "Якщо продовжити, ці зміни буде втрачено.",
  "Правка", "Вікно",
];
try {
  const strings = {};
  for (const k of MAIN_PROCESS_STRINGS) strings[k] = window.i18n.t(k);
  window.systemApi.setUiStrings?.(window.i18n.getLang(), strings);
} catch (e) {}
// Placeholder headings live inside data-no-i18n elements, so fill them in the
// active language once the dictionary is ready.
setTimeout(() => { try { paintPlaceholderTitles(); } catch (e) {} }, 0);

async function initBible() {
  // The select holds translation names (data-no-i18n), so its tooltip is set here.
  translationSelect.title = window.i18n.t("Переклад Біблії");
  translations = await window.bibleApi.listTranslations();
  translationSelect.innerHTML = translations.length
    ? translations.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")
    : `<option value="">${esc(window.i18n.t("⬇ Імпорт перекладу (XML)"))}</option>`;
  // Filaret is the default; a previously chosen translation is remembered.
  const remembered = localStorage.getItem("translationId");
  const pick = translations.find(x => x.id === remembered) || translations[0];
  if (!pick) { currentTranslationId = null; bookListEl.innerHTML = ""; return; }
  currentTranslationId = pick.id;
  translationSelect.value = currentTranslationId;
  await loadBooks();
}
translationSelect.addEventListener("change", () => localStorage.setItem("translationId", translationSelect.value));


// ---- Online Bible catalogue: browse and download translations ----
{
  const overlay = document.getElementById("bibleStoreOverlay");
  const listEl = document.getElementById("bibleStoreList");
  const searchEl = document.getElementById("bibleStoreSearch");
  const countEl = document.getElementById("bibleStoreCount");
  let catalog = { items: [] };

  function render() {
    const q = searchEl.value.trim().toLowerCase();
    const items = catalog.items.filter(i =>
      !q || i.lang.toLowerCase().includes(q) || i.name.toLowerCase().includes(q));
    const langs = [...new Set(items.map(i => i.lang))].sort((a, b) => a.localeCompare(b));
    countEl.textContent = `${items.length} / ${catalog.items.length} · ${langs.length} ${window.i18n.t("мов")}`;
    if (!items.length) {
      listEl.innerHTML = `<p class="emptyNote">${esc(window.i18n.t("Нічого не знайдено."))}</p>`;
      return;
    }
    listEl.innerHTML = langs.map(lang => {
      const group = items.filter(i => i.lang === lang);
      return `<div class="collectionGroup">
        <div class="collectionHeader">${esc(lang)} <span style="color:var(--overlay0);font-weight:500">${group.length}</span></div>
        ${group.map(i => `<div class="libItem">
          <svg viewBox="0 0 24 24" class="ic ic-sm"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17"/></svg>
          <span class="libItemTitle">${esc(i.name)}</span>
          ${i.installed
            ? `<span class="badgeOk" title="${esc(window.i18n.t("Встановлено"))}"><svg viewBox="0 0 24 24" class="ic" style="width:12px;height:12px;stroke-width:2.2"><path d="M5 12.5 10 17.5 19 7"/></svg></span>`
            : `<button class="libItemMove" data-dl="${esc(i.file)}" data-lang="${esc(i.lang)}" title="${esc(window.i18n.t("Завантажити"))}"><svg viewBox="0 0 24 24" class="ic ic-sm"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/></svg></button>`}
        </div>`).join("")}
      </div>`;
    }).join("");
    listEl.querySelectorAll("[data-dl]").forEach(btn => btn.addEventListener("click", async () => {
      const orig = btn.innerHTML;
      btn.textContent = "…"; btn.disabled = true;
      try {
        const info = await window.bibleApi.download(btn.dataset.dl, window.i18n.getLang(), btn.dataset.lang);
        // Refresh the translation list and switch to what was just downloaded.
        translations = await window.bibleApi.listTranslations();
        translationSelect.innerHTML = translations.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("");
        translationSelect.value = info.id;
        currentTranslationId = info.id;
        localStorage.setItem("translationId", info.id);
        await loadBooks();
        catalog = await window.bibleApi.catalog();
        render();
      } catch (e) {
        appAlert(window.i18n.t("Не вдалося завантажити переклад:") + "\n" + describeError(e));
        btn.innerHTML = orig; btn.disabled = false;
      }
    }));
  }

  document.getElementById("btnOpenBibleStore").addEventListener("click", async () => {
    overlay.style.display = "flex";
    listEl.innerHTML = `<p class="emptyNote">…</p>`;
    catalog = await window.bibleApi.catalog();
    render();
    window.i18n.applyI18n(overlay);
    setTimeout(() => searchEl.focus(), 0);
  });
  document.getElementById("btnCloseBibleStore").addEventListener("click", () => { overlay.style.display = "none"; });
  searchEl.addEventListener("input", render);
  document.getElementById("btnRefreshCatalog").addEventListener("click", async () => {
    const b = document.getElementById("btnRefreshCatalog");
    b.textContent = "…"; b.disabled = true;
    try {
      await window.bibleApi.refreshCatalog();
      catalog = await window.bibleApi.catalog();
      render();
    } catch (e) {
      appAlert(window.i18n.t("Не вдалося оновити каталог:") + "\n" + describeError(e));
    } finally { b.textContent = "⟳"; b.disabled = false; }
  });
}

document.getElementById("btnImportBibleXml").addEventListener("click", async () => {
  const btn = document.getElementById("btnImportBibleXml");
  const orig = btn.innerHTML;
  btn.textContent = window.i18n.t("Імпорт…"); btn.disabled = true;
  try {
    const info = await window.bibleApi.importXml(window.i18n.getLang());
    if (!info) return;
    translations = await window.bibleApi.listTranslations();
    translationSelect.innerHTML = translations.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
    translationSelect.value = info.id;
    currentTranslationId = info.id;
    localStorage.setItem("translationId", info.id);
    await loadBooks();
    appAlert(tf("Імпортовано переклад «{name}» ({books} книг).", { name: info.name, books: info.books }));
  } catch (e) {
    appAlert(window.i18n.t("Не вдалося імпортувати XML:")+"\n" + describeError(e));
  } finally {
    btn.innerHTML = orig; btn.disabled = false;
  }
});

async function loadBooks() {
  books = await window.bibleApi.getBookList(currentTranslationId, window.i18n.getLang());
  if (!books || !books.length) {
    // No books at all: reset the view rather than keep a stale selection.
    books = [];
    currentBook = null;
    renderBookList();
    chapterList.innerHTML = "";
    verseList.innerHTML = "";
    previewText.textContent = "";
    return;
  }
  renderBookList();
  const target = currentBook ? (books.find(b => b.osis === currentBook.osis) || books[42] || books[0]) : (books[42] || books[0]);
  selectBook(target, !currentBook);
}

function renderBookList(filter = "") {
  const f = filter.trim().toLowerCase();
  const filtered = f ? books.filter(b => b.name.toLowerCase().includes(f)) : books;
  bookListEl.innerHTML = filtered.map(b => `<div class="bookItem ${currentBook && b.osis === currentBook.osis ? "active" : ""}" data-osis="${esc(b.osis)}">${esc(b.name)}</div>`).join("");
  bookListEl.querySelectorAll(".bookItem").forEach(el => {
    el.addEventListener("click", () => selectBook(books.find(b => b.osis === el.dataset.osis)));
  });
}

function selectBook(book, reset = true) {
  if (!book) return;
  currentBook = book;
  if (reset) { currentChapter = 1; currentVerse = 1; }
  renderBookList(bookSearch.value);
  renderChapters();
}

function renderChapters() {
  if (!currentBook) { chapterList.innerHTML = ""; verseList.innerHTML = ""; return; }
  chapterList.innerHTML = Array.from({ length: currentBook.chapterCount }, (_, i) =>
    `<div class="chapItem ${i + 1 === currentChapter ? "active" : ""}" data-c="${i + 1}">${i + 1}</div>`).join("");
  chapterList.querySelectorAll(".chapItem").forEach(el => el.addEventListener("click", async () => {
    currentChapter = Number(el.dataset.c);
    currentVerse = 1;
    chapterList.querySelectorAll(".chapItem").forEach(e => e.classList.toggle("active", e === el));
    await renderVerses();
  }));
  // Guarded: scrollIntoView is missing in some embedding contexts, and a
  // cosmetic scroll must never break rendering.
  const act = chapterList.querySelector(".chapItem.active");
  if (act && act.scrollIntoView) { try { act.scrollIntoView({ block: "nearest" }); } catch (e) {} }
  renderVerses();
}

// Every call gets a ticket; a call that finishes after a newer one started is
// stale and must not touch state (it would clamp the verse against the wrong
// chapter's length).
let renderVersesTicket = 0;
async function renderVerses() {
  if (!currentBook) { verseList.innerHTML = ""; return; }
  const ticket = ++renderVersesTicket;
  const count = await window.bibleApi.getChapterVerseCount(currentTranslationId, currentBook.osis, currentChapter);
  if (ticket !== renderVersesTicket) return;
  currentVerseCount = count;
  if (currentVerse > currentVerseCount) currentVerse = 1;

  // Show the verse TEXT next to each number: picking a reference by reading it
  // is far faster than clicking numbers blind and checking the preview.
  const lang = window.i18n.getLang();
  const verses = await Promise.all(
    Array.from({ length: currentVerseCount }, (_, i) =>
      window.bibleApi.getVerse(currentTranslationId, currentBook.osis, currentChapter, i + 1, lang))
  );
  if (ticket !== renderVersesTicket) return;   // a newer render owns the list now
  verseList.innerHTML = verses.map((v, i) => `
    <div class="verseRow ${i + 1 === currentVerse ? "active" : ""}" data-v="${i + 1}">
      <span class="vn">${i + 1}</span><span class="vt">${esc(v ? v.text : "")}</span>
    </div>`).join("");

  verseList.querySelectorAll(".verseRow").forEach(el => {
    el.addEventListener("click", async () => {
      currentVerse = Number(el.dataset.v);
      verseList.querySelectorAll(".verseRow").forEach(e => e.classList.toggle("active", e === el));
      await updatePreview();
    });
    // Double-click sends it straight to the screen — the common case.
    el.addEventListener("dblclick", async () => {
      currentVerse = Number(el.dataset.v);
      await showCurrentVerse();
    });
  });
  const act = verseList.querySelector(".verseRow.active");
  if (act && act.scrollIntoView) { try { act.scrollIntoView({ block: "nearest" }); } catch (e) {} }
  remoteSync();   // the phone's verse list needs the texts just loaded
  await updatePreview();
}

async function updatePreview() {
  // With no translation installed (or before a book is chosen) there is
  // nothing to look up — bail out instead of dereferencing a null book,
  // which used to crash the whole control window.
  if (!currentTranslationId || !currentBook || !currentBook.osis) {
    previewText.textContent = "";
    return null;
  }
  const v = await window.bibleApi.getVerse(currentTranslationId, currentBook.osis, currentChapter, currentVerse, window.i18n.getLang());
  if (!v) return null;
  previewText.textContent = v.text;
  return v;
}

function buildVerseRef(v) {
  // The verse reference "Книга глава:вірш" is always shown.
  if (!v) return undefined;
  return `${v.bookName} ${v.chapter}:${v.verse}`;
}

async function showCurrentVerse() {
  const v = await updatePreview();
  if (!v) return;
  playbackQueue = { type: "bible", count: currentVerseCount };
  playbackIndex = currentVerse - 1;
  showOnOutput({ text: v.text, reference: buildVerseRef(v), theme: bibleTheme });
}

bookSearch.addEventListener("input", () => renderBookList(bookSearch.value));

// ---- Quick reference jump: "Івана 3:16", "John 3 16", "Ps 23" ----
// Typing a reference is the fastest way to reach a verse mid-service; hunting
// through three lists is the slow path, kept for browsing.
// ---- Full-text verse search ----
let searchMode = false;
const SEARCH_LIMIT = 200;

function exitSearchMode() {
  if (!searchMode) return;
  searchMode = false;
  renderVerses();
}

async function runTextSearch(q) {
  if (!currentTranslationId) return;
  const input = document.getElementById("refSearch");
  verseList.innerHTML = `<div class="emptyNote">${esc(window.i18n.t("Шукаю…"))}</div>`;
  let hits = [];
  try {
    hits = await window.bibleApi.searchText(currentTranslationId, q, window.i18n.getLang(), SEARCH_LIMIT + 1);
  } catch (e) { hits = []; }

  searchMode = true;
  if (!hits.length) {
    input.style.borderColor = "var(--red)";
    setTimeout(() => { input.style.borderColor = ""; }, 1200);
    verseList.innerHTML = `<div class="emptyNote">${esc(window.i18n.t("Нічого не знайдено"))}</div>`;
    return;
  }
  input.style.borderColor = "";
  // One extra hit was requested only to learn whether there are more.
  const truncated = hits.length > SEARCH_LIMIT;
  if (truncated) hits = hits.slice(0, SEARCH_LIMIT);

  // Highlight the match so the eye lands on it without re-reading the verse.
  const rx = new RegExp("(" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
  verseList.innerHTML =
    `<div class="searchHead">
       ${truncated
          ? esc(tf("Показано перші {n} збігів — уточніть запит", { n: SEARCH_LIMIT }))
          : esc(window.i18n.t("Знайдено")) + ": " + hits.length}
     </div>` +
    hits.map((h, i) => `
      <div class="verseRow searchRow" data-i="${i}" data-osis="${esc(h.osis)}" data-c="${h.chapter}" data-v="${h.verse}">
        <span class="vn" style="flex:0 0 auto;min-width:96px;text-align:left;opacity:.8">${esc(h.bookName)} ${h.chapter}:${h.verse}</span>
        <span class="vt">${esc(h.text).replace(rx, "<mark>$1</mark>")}</span>
      </div>`).join("");

  verseList.querySelectorAll(".searchRow").forEach(el => {
    const jump = async () => {
      const book = books.find(b => b.osis === el.dataset.osis);
      if (!book) return;
      selectBook(book, false);
      currentChapter = Number(el.dataset.c);
      currentVerse = Number(el.dataset.v);
      searchMode = false;
      renderChapters();
    };
    el.addEventListener("click", jump);
    el.addEventListener("dblclick", async () => { await jump(); await showCurrentVerse(); });
  });
}

// Standard abbreviations operators actually type, in Russian, Ukrainian and
// English. Checked BEFORE any fuzzy matching: "Ин" is John, but a substring
// search found "Иисус Навин" (Joshua) first and put the wrong verse on screen.
const BOOK_ABBR = (() => {
  const t = {
    Gen: "быт бут gen ge", Exod: "исх вих ex exo exod", Lev: "лев lev lv", Num: "чис числ num nu",
    Deut: "втор повт deut dt", Josh: "нав иснав існав josh jos", Judg: "суд judg jdg", Ruth: "руф рут ruth ru",
    "1Chr": "1пар 1хр 1хрон 1chr 1ch", "2Chr": "2пар 2хр 2хрон 2chr 2ch", Ezra: "езд ездр ezra ezr", Neh: "неем neh",
    Esth: "есф ест esth est", Job: "иов йов job jb", Ps: "пс псал псалом ps psa psalm", Prov: "притч прип prov pr",
    Eccl: "еккл екк eccl ecc", Song: "песн пісн song sos", Isa: "ис іс isa is", Jer: "иер єр jer",
    Lam: "плач lam", Ezek: "иез єз ezek eze", Dan: "дан dan dn", Hos: "ос hos", Joel: "иоил йоіл joel",
    Amos: "ам amos am", Obad: "авд овд obad ob", Jonah: "ион йона jonah jon", Mic: "мих mic", Nah: "наум nah",
    Hab: "авв ав hab", Zeph: "соф zeph", Hag: "агг ог hag", Zech: "зах zech", Mal: "мал mal",
    Matt: "мф мт матф матв matt mt", Mark: "мк мар mark mk", Luke: "лк лук luke lk", John: "ин иоан ів ін iв john jn jhn",
    Acts: "деян дії дiї acts ac", Rom: "рим rom ro", "1Cor": "1кор 1cor 1co", "2Cor": "2кор 2cor 2co",
    Gal: "гал gal ga", Eph: "еф eph", Phil: "флп фил phil php", Col: "кол col", "1Thess": "1фес 1сол 1thess 1th",
    "2Thess": "2фес 2сол 2thess 2th", "1Tim": "1тим 1tim 1ti", "2Tim": "2тим 2tim 2ti", Titus: "тит titus tit",
    Phlm: "флм phlm phm", Heb: "евр євр heb", Jas: "иак як jas jam", "1Pet": "1пет 1пт 1pet 1pe", "2Pet": "2пет 2пт 2pet 2pe",
    "1John": "1ин 1ів 1ін 1john 1jn", "2John": "2ин 2ів 2ін 2john 2jn", "3John": "3ин 3ів 3ін 3john 3jn",
    Jude: "иуд юд jude jud", Rev: "откр об одкр rev re apoc",
    "1Sam": "1sam 1sa 1сам", "2Sam": "2sam 2sa 2сам", "1Kgs": "1kgs 1ki", "2Kgs": "2kgs 2ki",
  };
  const map = {};
  for (const [osis, list] of Object.entries(t)) for (const a of list.split(" ")) map[a] = osis;
  return map;
})();

// "1 Цар" means 1 Samuel in the Russian Synodal numbering (1–4 Царств) but
// 1 Kings in Ukrainian translations (1–2 Царів). Decide from the translation.
function kingsAbbr(key) {
  const m = key.match(/^([1-4])цар/);
  if (!m) return null;
  const n = Number(m[1]);
  // Four books named "…Царств" — by digit ("4 Царств") or by word
  // ("Четверта книга Царств", Filaret) — means Synodal-style numbering.
  const fourKingdoms = books.some(b => /(^4|четверт|четвёрт).*цар/i.test(String(b.name).replace(/\s/g, "").toLowerCase()));
  if (fourKingdoms) return ["1Sam", "2Sam", "1Kgs", "2Kgs"][n - 1];
  return n <= 2 ? ["1Kgs", "2Kgs"][n - 1] : null;
}

async function gotoReference(raw) {
  const q = String(raw || "").trim();
  if (!q || !books.length) return false;

  // Split into "name part" and "numbers part" — the numbers are always last.
  const m = q.match(/^(.+?)[\s.]*(\d+)(?:\s*[:.\s]\s*(\d+))?\s*$/);
  const namePart = (m ? m[1] : q).trim().toLowerCase();
  if (!namePart) return false;

  const norm = (x) => String(x || "").toLowerCase().replace(/[.\s\-]/g, "").replace(/^([1-4])(я|е|а)/, "$1");
  const key = norm(namePart);

  // Known abbreviations first, then names that start with what was typed.
  // Without chapter numbers the input is just as likely a word to search for
  // ("the", "job", "love"): only an abbreviation or the start of a full book
  // name counts as a reference then. Partial and fuzzy matches need a number.
  const hasNumbers = !!(m && m[2]);
  const abbrOsis = BOOK_ABBR[key] || kingsAbbr(key);
  let hit = (abbrOsis && books.find(b => b.osis === abbrOsis))
         || (key.length >= 3 || hasNumbers ? books.find(b => norm(b.name).startsWith(key)) : null)
         || (hasNumbers ? books.find(b => norm(b.osis).startsWith(key)) : null)
         || (hasNumbers ? books.find(b => String(b.name).toLowerCase().split(/[\s.]+/).some(w => norm(w).startsWith(key))) : null);
  // Substring matches only for longer input: two letters appear inside far too
  // many names to mean anything.
  if (!hit && hasNumbers && key.length >= 3) {
    hit = books.find(b => norm(b.name).includes(key)) || books.find(b => norm(b.osis).includes(key));
  }

  // Spelling varies between translations ("Івана" vs "Іоана", "Матвія" vs
  // "Матфея"), and operators type from memory. Fall back to the closest word
  // within a small edit distance rather than refusing the jump.
  if (!hit && hasNumbers && key.length >= 3) {
    // Edit distance where swapping two neighbouring letters ("Jhon") counts as
    // one mistake, not two — it is the most common typo.
    const dist = (a, b) => {
      const m = a.length, n = b.length;
      let prev2 = null, prev = Array.from({ length: n + 1 }, (_, j) => j);
      for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
          cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
          if (prev2 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
        }
        prev2 = prev; prev = cur;
      }
      return prev[n];
    };
    const tolerance = key.length <= 4 ? 1 : 2;
    let best = null, bestScore = Infinity;
    for (const b of books) {
      // Compare against each word of the title and against its start.
      for (const word of [norm(b.name).slice(0, key.length), ...String(b.name).toLowerCase().split(/[\s.]+/).map(norm)]) {
        if (!word) continue;
        const d = dist(key, word);
        if (d < bestScore) { bestScore = d; best = b; }
      }
    }
    if (best && bestScore <= tolerance) hit = best;
  }
  if (!hit) return false;

  // Set book, chapter and verse FIRST, then render once. Rendering in
  // between (selectBook) started a verse load for the previous book's chapter
  // number — which may not exist in the new book — and that stale load later
  // reset the verse to 1: "John 3:16" typed while in Psalm 23 opened John 3:1.
  currentBook = hit;
  if (m && m[2]) {
    currentChapter = Math.max(1, Math.min(hit.chapterCount, Number(m[2])));
    currentVerse = m[3] ? Math.max(1, Number(m[3])) : 1;
  } else {
    currentChapter = 1; currentVerse = 1;
  }
  renderBookList(bookSearch.value);
  renderChapters();
  return true;
}

{
  const input = document.getElementById("refSearch");
  const go = async () => {
    const q = input.value.trim();
    if (!q) return;
    // A reference wins when it parses — that is the precise intent. Anything
    // else is treated as a phrase to find, which is how operators actually
    // remember verses.
    if (await gotoReference(q)) {
      input.style.borderColor = "";
      exitSearchMode();
      return;
    }
    await runTextSearch(q);
  };
  document.getElementById("btnRefGo").addEventListener("click", go);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
}
translationSelect.addEventListener("change", async () => { currentTranslationId = translationSelect.value; await loadBooks(); });
document.getElementById("btnShow")?.addEventListener("click", showCurrentVerse);
document.getElementById("btnShowBig").addEventListener("click", showCurrentVerse);

initBible();

// ════════════════════════════════════════════════════════════
//  SONGS
// ════════════════════════════════════════════════════════════
let songs = [], currentSong = null, liveSongKey = null;
const songsListItems = document.getElementById("songsListItems");
const sectionsContainer = document.getElementById("sectionsContainer");

// Each kind of part has its own colour, the same in every song: all verses
// blue, every chorus violet, and so on. Red is left out on purpose — it means
// "on screen" everywhere in the program.
const SECTION_KIND_COLORS = {
  "Куплет": "#89b4fa", "Предприспів": "#94e2d5", "Приспів": "#cba6f7", "Брідж": "#fab387",
  "Тег": "#f5c2e7", "Інтро": "#f9e2af", "Програш": "#a6e3a1", "Аутро": "#f9e2af",
};
const SECTION_OTHER_COLOR = "#9399b2";
function sectionColor(name) {
  const canon = matchSectionHeading(String(name || "").trim()) || String(name || "").trim();
  const base = canon.replace(/\s+\d+$/, "");
  return SECTION_KIND_COLORS[base] || SECTION_OTHER_COLOR;
}
function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

const NO_COLLECTION_KEY = "Без збірки";
function collectionLabel(key) {
  return key === NO_COLLECTION_KEY ? window.i18n.t(NO_COLLECTION_KEY) : key;
}

function groupByCollection(items) {
  const groups = new Map();
  items.forEach(item => {
    // Trimmed, so a stray trailing space doesn't split one collection into two.
    const key = String(item.collection || "").trim() || "Без збірки";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  return [...groups.entries()].sort((a, b) => {
    if (a[0] === "Без збірки") return 1;
    if (b[0] === "Без збірки") return -1;
    return a[0].localeCompare(b[0], "uk");
  });
}

// ── Multi-select in the song library ──
const pickedSongIds = new Set();
let lastPickedId = null;

function updateBulkBar() {
  const bar = document.getElementById("songBulkBar");
  const cnt = document.getElementById("pickedCount");
  if (!bar || !cnt) return;
  cnt.textContent = String(pickedSongIds.size);
  bar.classList.toggle("show", pickedSongIds.size > 0);
}

function togglePicked(el) {
  const id = el.dataset.id;
  if (pickedSongIds.has(id)) { pickedSongIds.delete(id); el.classList.remove("picked"); }
  else { pickedSongIds.add(id); el.classList.add("picked"); }
  updateBulkBar();
}

function clearPicked() {
  pickedSongIds.clear();
  songsListItems.querySelectorAll(".songItem.picked").forEach(x => x.classList.remove("picked"));
  updateBulkBar();
}

async function refreshSongsList() {
  songs = await window.songsApi.list();
  const groups = groupByCollection(songs);
  songsListItems.innerHTML = groups.map(([col, items]) => `
    <div class="collectionGroup">
      <div class="collectionHeader">${esc(collectionLabel(col))}</div>
      ${items.map(s => `<div class="songItem ${currentSong && currentSong.id === s.id ? "active" : ""}" data-id="${esc(s.id)}" title="${esc(window.i18n.t("ПКМ — видалити"))}">${esc(s.title)}</div>`).join("")}
    </div>`).join("");
  // Restore the visual state of a multi-selection across re-renders.
  songsListItems.querySelectorAll(".songItem").forEach(el => {
    if (pickedSongIds.has(el.dataset.id)) el.classList.add("picked");
  });
  updateBulkBar();

  songsListItems.querySelectorAll(".songItem").forEach(el => {
    el.addEventListener("click", (e) => {
      // Ctrl/Cmd = toggle one, Shift = range. Building a service means adding
      // six or eight songs at once; one-at-a-time was the slow path.
      if (e.ctrlKey || e.metaKey) {
        togglePicked(el);
        lastPickedId = el.dataset.id;
        return;
      }
      if (e.shiftKey && lastPickedId) {
        const all = [...songsListItems.querySelectorAll(".songItem")];
        const from = all.findIndex(x => x.dataset.id === lastPickedId);
        const to = all.indexOf(el);
        if (from >= 0 && to >= 0) {
          const [a, b] = from < to ? [from, to] : [to, from];
          for (let i = a; i <= b; i++) {
            pickedSongIds.add(all[i].dataset.id);
            all[i].classList.add("picked");
          }
          updateBulkBar();
          return;
        }
      }
      clearPicked();
      lastPickedId = el.dataset.id;
      loadSong(el.dataset.id);
    });
    el.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      const s = songs.find(x => x.id === el.dataset.id);
      if (!s) return;
      if (!(await appConfirm(tf("Видалити пісню «{name}»?", { name: s.title })))) return;
      await window.songsApi.delete(s.id);
      if (currentSong?.id === s.id) {
        currentSong = null;
        document.getElementById("songTitleInput").value = "";
        refreshSongCollectionOptions("");
        sectionsContainer.innerHTML = "";
      }
      await refreshSongsList();
    });
  });
}

// ── Song collection picker: dropdown of existing collections + "create new" ──
const songCollectionSelect = document.getElementById("songCollectionSelect");
// A Private Use Area character, not a NUL byte — NUL inside an HTML form
// value/attribute can get silently truncated during attribute serialization,
// which would make this sentinel unreliable.
const NEW_COLLECTION_VALUE = "\uE000__new__";
async function refreshSongCollectionOptions(selectValue) {
  const names = await window.songsApi.listCollections();
  const cur = selectValue !== undefined ? selectValue : songCollectionSelect.value;
  songCollectionSelect.innerHTML =
    `<option value="">${esc(window.i18n.t("— Без збірки —"))}</option>` +
    names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("") +
    `<option value="${NEW_COLLECTION_VALUE}">${esc(window.i18n.t("+ Нова збірка…"))}</option>`;
  songCollectionSelect.value = names.includes(cur) ? cur : "";
}
songCollectionSelect.addEventListener("change", async () => {
  if (songCollectionSelect.value !== NEW_COLLECTION_VALUE) return;
  const name = await appPrompt(window.i18n.t("Назва нової збірки:"), "");
  if (name === null || !name.trim()) { await refreshSongCollectionOptions(""); return; }
  await window.songsApi.addCollection(name.trim());
  await refreshSongCollectionOptions(name.trim());
  scheduleSongAutosave();
});
refreshSongCollectionOptions("");

// ── Unsaved edits ──
// Clicking another song, "New song" or a playlist entry used to throw away
// whatever had been typed into the open song, silently. The editor now
// remembers what was last loaded or saved and asks before discarding.
let savedSongSnapshot = null;
function songSnapshotOf(title, collection, sections) {
  return JSON.stringify({ t: String(title || "").trim(), c: String(collection || ""), s: sections });
}
function currentSongSnapshot() {
  if (!currentSong) return null;
  const c = songCollectionSelect.value === NEW_COLLECTION_VALUE ? "" : songCollectionSelect.value;
  return songSnapshotOf(document.getElementById("songTitleInput").value, c, collectFromDom());
}
function markSongSaved(title, collection) {
  savedSongSnapshot = currentSong ? songSnapshotOf(title, collection, collectFromDom()) : null;
}
function songHasUnsavedChanges() {
  return !!currentSong && savedSongSnapshot !== null && currentSongSnapshot() !== savedSongSnapshot;
}
async function confirmDiscardSongChanges() {
  await flushSongAutosave();                 // edits to a titled song are simply saved
  if (!songHasUnsavedChanges()) return true;
  const name = document.getElementById("songTitleInput").value.trim() || window.i18n.t("Нова пісня");
  return appConfirm(tf("У пісні «{name}» є незбережені зміни. Відкинути їх?", { name }));
}
// Closing the app: the open song's last edits are saved first; an untitled
// song with text can't be saved, so the operator is asked before it is lost.
window.appLifecycle?.onCloseRequested(async () => {
  let ok = true;
  try { ok = await confirmDiscardSongChanges(); } catch (e) { ok = true; }
  if (ok) window.appLifecycle.quit();
});

// ── Autosave ──
// Edits are written about a second after the operator stops typing. Only the
// file is written; the editor is not re-rendered, so the cursor stays put.
let songAutosaveTimer = null;
let songSaveChain = Promise.resolve();
const SONG_AUTOSAVE_MS = 900;

function setSongSaveStatus(key, kind) {
  const el = document.getElementById("songSaveStatus");
  if (!el) return;
  el.textContent = key ? window.i18n.t(key) : "";
  el.dataset.kind = kind || "";
}

function scheduleSongAutosave() {
  if (!currentSong) return;
  clearTimeout(songAutosaveTimer);
  songAutosaveTimer = setTimeout(() => { songAutosaveTimer = null; saveCurrentSong(false); }, SONG_AUTOSAVE_MS);
}

async function flushSongAutosave() {
  if (songAutosaveTimer) { clearTimeout(songAutosaveTimer); songAutosaveTimer = null; await saveCurrentSong(false); }
  await songSaveChain;
}

// Saves are chained: two overlapping saves of a NEW song would otherwise
// create two files.
function saveCurrentSong(manual) {
  const run = songSaveChain.then(() => doSaveCurrentSong(manual));
  songSaveChain = run.catch(() => {});
  return run;
}

async function doSaveCurrentSong(manual) {
  const song = currentSong;
  if (!song) return false;
  const titleEl = document.getElementById("songTitleInput");
  const title = titleEl.value.trim();
  if (!manual && !songHasUnsavedChanges()) return true;
  if (!title) {
    if (manual) appAlert(window.i18n.t("Введіть назву пісні"), titleEl);
    else setSongSaveStatus("Введіть назву, щоб пісня збереглася", "warn");
    return false;
  }
  const collection = songCollectionSelect.value === NEW_COLLECTION_VALUE ? "" : songCollectionSelect.value;
  const sections = collectFromDom();
  // Remember exactly what is being written: anything typed while the write is
  // in flight stays "unsaved" and goes out with the next autosave.
  const snapshot = songSnapshotOf(title, collection, sections);
  const isNew = !song.id;
  const listChanged = isNew || song.title !== title || (song.collection || "") !== collection;
  setSongSaveStatus("Зберігаю…", "busy");
  try {
    const saved = await window.songsApi.save({ id: song.id, title, sections, collection });
    if (currentSong !== song) return true;     // operator moved on meanwhile
    song.id = saved.id; song.title = saved.title; song.collection = saved.collection; song.sections = saved.sections;
    savedSongSnapshot = snapshot;
    setSongSaveStatus(songHasUnsavedChanges() ? "" : "Збережено", "ok");
    if (listChanged) {
      await refreshSongsList();
      if (document.activeElement !== songCollectionSelect) await refreshSongCollectionOptions(collection);
    }
    return true;
  } catch (e) {
    setSongSaveStatus("Не вдалося зберегти", "error");
    if (manual) appAlert(window.i18n.t("Не вдалося зберегти") + "\n" + describeError(e));
    return false;
  }
}

// Returns true when the song is open, false when it no longer exists, and
// "cancel" when the operator chose to keep editing the current one.
async function loadSong(id) {
  if (!(await confirmDiscardSongChanges())) return "cancel";
  const song = await window.songsApi.get(id);
  if (!song) return false;
  currentSong = { id, ...song };
  document.getElementById("songTitleInput").value = currentSong.title;
  await refreshSongCollectionOptions(currentSong.collection || "");
  liveSongKey = null;
  renderSections();
  markSongSaved(currentSong.title, currentSong.collection || "");
  setSongSaveStatus("");
  refreshSongsList();
  return true;
}

function newSong() {
  // Section names are stored canonically (translated only for display), so a
  // new song starts with "Куплет 1", not with the translated word.
  currentSong = { id: null, title: "", sections: [{ name: "Куплет 1", slides: [] }] };
  document.getElementById("songTitleInput").value = "";
  refreshSongCollectionOptions("");
  liveSongKey = null;
  renderSections();
  markSongSaved("", "");
  setSongSaveStatus("");
  refreshSongsList();
  // Put the cursor straight into the title so the operator can type the name.
  const t = document.getElementById("songTitleInput");
  setTimeout(() => { t.focus(); t.select(); }, 0);
}

function flattenSong() {
  const flat = [];
  (currentSong?.sections || []).forEach((sec, si) => {
    const ta = document.querySelectorAll(`.secLines[data-si="${si}"]`)[0];
    let slides = ta ? parseSlides(ta.value) : sec.slides;
    if (!slides.length) slides = [""];
    slides.forEach((text, li) => flat.push({ text, sectionName: sec.name, sectionIdx: si, lineIdx: li, key: `${si}:${li}` }));
  });
  return flat;
}

function collectFromDom() {
  const sections = [];
  sectionsContainer.querySelectorAll(".sectionBlock").forEach((block, si) => {
    const name = block.querySelector(".secNameInput").value || `${window.i18n.t("Секція")} ${si+1}`;
    const parsed = parseSlides(block.querySelector(".secLines").value);
    sections.push({ name, slides: parsed.length ? parsed : [""] });
  });
  return sections;
}

// Slides in the editor are separated by a BLANK LINE; a slide itself can hold
// several lines (as in ProPresenter). parseSlides/joinSlides convert between
// the textarea text and the slides array.
function parseSlides(text) {
  const parts = String(text || "")
    .split(/\n\s*\n/)
    .map(s => s.split("\n").map(l => l.trim()).filter(Boolean).join("\n"))
    .filter(Boolean);
  // An empty section is deliberate — it is how an operator blanks the screen
  // during an instrumental. Without this it collapsed to zero slides and the
  // blank card silently vanished on the next edit or save.
  return parts.length ? parts : [""];
}
function joinSlides(slides) {
  return (slides || []).join("\n\n");
}

// The standard song section types, offered as a dropdown so an operator picks
// rather than types (and so section colours stay consistent across songs).
const SECTION_TYPES = [
  "Куплет 1", "Куплет 2", "Куплет 3", "Куплет 4",
  "Предприспів", "Приспів", "Брідж", "Тег",
  "Інтро", "Програш", "Аутро",
];

// Section names are stored in a canonical form ("Куплет 6", "Приспів") so
// songs stay portable between UI languages; they are translated only when
// shown. Names from imports ("Припев", "Verse 7") are recognised through the
// same parser the paste dialog uses. A label the user typed themselves
// ("Интермедия") is theirs and is shown unchanged.
function displaySectionName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  const canon = matchSectionHeading(raw) || raw;
  const m = canon.match(/^(.*?)\s+(\d+)$/);
  const base = m ? m[1] : canon;
  const dict = window.i18n.I18N[window.i18n.getLang()] || {};
  const known = window.i18n.getLang() === "uk" ? SECTION_BASES.includes(base) : (base in dict);
  if (!known) return raw;
  return window.i18n.t(base) + (m ? " " + m[2] : "");
}
const SECTION_BASES = ["Куплет", "Предприспів", "Приспів", "Брідж", "Тег", "Інтро", "Програш", "Аутро"];

function sectionSelectHtml(current) {
  const cur = String(current || "");
  // Verse numbers are open-ended: a song with seven verses needs "Куплет 7" as
  // a real, translated option, not as an untranslated leftover.
  const types = [...SECTION_TYPES];
  const vm = cur.match(/^Куплет (\d+)$/);
  if (vm && !types.includes(cur)) {
    const n = Number(vm[1]);
    for (let i = 5; i <= n; i++) if (!types.includes("Куплет " + i)) types.splice(i - 1, 0, "Куплет " + i);
  }
  // A name from elsewhere that isn't in the list is kept as its own option so
  // editing a section never silently renames it.
  const known = types.includes(cur);
  const opts = types.map(nameKey =>
    `<option value="${esc(nameKey)}"${nameKey === cur ? " selected" : ""}>${esc(displaySectionName(nameKey))}</option>`).join("");
  const custom = (!known && cur)
    ? `<option value="${esc(cur)}" selected>${esc(displaySectionName(cur))}</option>` : "";
  return `<select class="secNameInput" title="${esc(window.i18n.t("Тип частини"))}">${custom}${opts}</select>`;
}

// Pick a sensible default for a newly added section: the next unused verse
// number, falling back to Приспів once the verses are covered.
function nextSectionName(sections) {
  const used = new Set((sections || []).map(x => x.name));
  for (const n of ["Куплет 1", "Куплет 2", "Куплет 3", "Куплет 4"]) if (!used.has(n)) return n;
  if (!used.has("Приспів")) return "Приспів";
  if (!used.has("Брідж")) return "Брідж";
  // Long hymns: keep numbering verses instead of repeating "Брідж".
  for (let i = 5; i < 100; i++) if (!used.has("Куплет " + i)) return "Куплет " + i;
  return "Куплет";
}

function renderSections() {
  sectionsContainer.innerHTML = "";
  if (typeof syncLinesPerSlideControl === "function") { try { syncLinesPerSlideControl(); } catch (e) {} }
  // A new, empty song opens with its text field ready to type into, instead of
  // a collapsed one that had to be found and opened with the ✎ button.
  const songIsEmpty = !(currentSong?.sections || []).some(sec => (sec.slides || []).some(x => String(x).trim()));
  (currentSong?.sections || []).forEach((sec, si) => {
    const color = sectionColor(sec.name);
    const block = document.createElement("div");
    block.className = "sectionBlock";
    block.style.setProperty("--sec-color", color);
    block.style.setProperty("--sec-rgb", hexRgb(color));
    block.innerHTML = `
      <div class="secHeader">
        ${sectionSelectHtml(sec.name)}
        <span class="secCount">${sec.slides.length} ${window.i18n.t("сл.")}</span>
        <button class="secToggle" title="${esc(window.i18n.t("Редагувати текст"))}"><svg viewBox="0 0 24 24" class="ic"><path d="M15.5 4.5 19.5 8.5 8 20H4v-4z"/><path d="M13.5 6.5 17.5 10.5"/></svg></button>
        <button class="secDel" title="${esc(window.i18n.t("Видалити частину"))}"><svg viewBox="0 0 24 24" class="ic"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button>
      </div>
      <textarea class="secLines${songIsEmpty ? "" : " collapsed"}" data-si="${si}" rows="6" placeholder="${esc(window.i18n.t("Текст. Порожній рядок = новий слайд."))}">${esc(joinSlides(sec.slides))}</textarea>
      <div class="slideGrid secGrid" data-si="${si}"></div>`;
    sectionsContainer.appendChild(block);
    const ta = block.querySelector(".secLines");
    const grid = block.querySelector(".secGrid");

    // Pasting a whole song into ONE section's textarea used to dump every line
    // into that single section, leaving "[Verse 1]" / "[Chorus]" sitting inside
    // the lyrics. Route such a paste through the same smart parser the
    // "Paste lyrics" dialog uses: it understands headings in every supported
    // language, infers sections when there are none, and wraps long lines.
    ta.addEventListener("paste", (e) => {
      const text = (e.clipboardData || window.clipboardData)?.getData("text") || "";
      if (!text.trim()) return;

      const lines = text.replace(/\r/g, "").split("\n");
      const headingCount = lines.filter(l => detectHeading(l.trim())).length;
      const blockCount = text.split(/\n\s*\n/).filter(b => b.trim()).length;
      const looksLikeWholeSong = headingCount >= 1 || (!ta.value.trim() && blockCount >= 2);
      if (!looksLikeWholeSong) return; // ordinary small edit — leave it alone

      e.preventDefault();
      const lps = Number(document.getElementById("songLinesPerSlide")?.value) || Number(document.getElementById("pasteLinesPerSlide")?.value) || 2;
      const parsed = parseSongText(text, lps);
      if (!parsed.length) return;

      currentSong.sections = collectFromDom();
      // Replace this section with the parsed ones, keeping the rest of the song.
      currentSong.sections.splice(si, 1, ...parsed);
      renderSections();
    });
    const countEl = block.querySelector(".secCount");
    function rebuildGrid() {
      const parsed = parseSlides(ta.value);
      const slides = parsed.length ? parsed : [""]; // empty section = one blank slide (гасить текст на програші)
      countEl.textContent = `${slides.length} ${window.i18n.t("сл.")}`;
      grid.innerHTML = slides.map((l, li) => {
        const key = `${si}:${li}`;
        return `<div class="slideCard ${key === liveSongKey ? "live" : ""}" data-si="${si}" data-li="${li}" data-key="${esc(key)}">
          <div class="slideCardThumb"><span class="slideCardText${l ? "" : " blank"}">${l ? esc(l) : esc(window.i18n.t("(порожній екран)"))}</span></div>
          <div class="slideCardFooter"><span class="num">${li+1}</span><span class="lbl">${esc(displaySectionName(sec.name))}</span></div>
        </div>`;
      }).join("");
      grid.querySelectorAll(".slideCard").forEach(card => {
        card.addEventListener("click", () => {
          selectedSlideKey = card.dataset.key;     // Ctrl+C works on this one
          // Picking a slide means the operator has finished typing; drop focus
          // so Ctrl+C/Ctrl+V act on the slide rather than on a text field.
          const focused = document.activeElement;
          if (focused && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA")) focused.blur();
          const flat = flattenSong();
          const fi = flat.findIndex(f => f.key === card.dataset.key);
          // Still the playlist's current song? Then Next at its end moves on.
          const plItem = currentPlaylist && livePlIdx >= 0 ? currentPlaylist.items[livePlIdx] : null;
          playbackQueue = { type: "song", slides: flat, fromPlaylist: !!(plItem && plItem.type === "song" && plItem.songId === currentSong?.id) };
          playbackIndex = fi >= 0 ? fi : 0;
          liveSongKey = card.dataset.key;
          sectionsContainer.querySelectorAll(".slideCard").forEach(c => c.classList.toggle("live", c.dataset.key === liveSongKey));
          showOnOutput({ text: flat[fi >= 0 ? fi : 0].text, theme: songTheme });
        });
      });
    }
    ta.addEventListener("input", rebuildGrid);
    block.querySelector(".secToggle").addEventListener("click", () => ta.classList.toggle("collapsed"));
    // Rebuilt from what is on screen, not from the copy in memory: that copy
    // could be a few keystrokes behind, and those keystrokes were lost.
    block.querySelector(".secDel").addEventListener("click", async () => {
      const sections = collectFromDom();
      const hasText = (sections[si]?.slides || []).some(x => String(x).trim());
      if (hasText && !(await appConfirm(tf("Видалити частину «{name}» разом із текстом?", { name: displaySectionName(sections[si].name) })))) return;
      sections.splice(si, 1);
      currentSong.sections = sections;
      renderSections();
    });
    // Renaming a part (Verse → Chorus) relabels its slide cards at once.
    block.querySelector(".secNameInput").addEventListener("change", (e) => { sec.name = e.target.value; rebuildGrid(); });
    rebuildGrid();
  });
}

// Every edit in the song editor — typing, renaming a part, changing the
// collection — and every re-render after paste, re-split, add or delete
// schedules an autosave. A save that finds nothing changed does nothing.
{
  const editor = document.querySelector("#songsView .editorMain");
  ["input", "change"].forEach(ev => editor.addEventListener(ev, (e) => {
    if (e.target && e.target.id === "songLinesPerSlide") return;   // a setting, not an edit
    if (e.target === songCollectionSelect && songCollectionSelect.value === NEW_COLLECTION_VALUE) return;
    scheduleSongAutosave();
  }));
  const plainRender = renderSections;
  renderSections = function () { plainRender.apply(this, arguments); scheduleSongAutosave(); };
}

// ── Copy / paste a slide (Ctrl+C, Ctrl+V) ──
// Duplicating a slide is a constant need — a chorus slide repeated after each
// verse, a line shown twice. Retyping it is wasted time.
let selectedSlideKey = null;
let copiedSlideText = null;

document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = String(e.key).toLowerCase();
  if (k !== "c" && k !== "v") return;

  // Never hijack copy/paste while the operator is editing text.
  const el = document.activeElement;
  const tag = el && el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || (el && el.isContentEditable)) return;
  if (!currentSong || !selectedSlideKey) return;
  if (document.getElementById("songsView") && !document.getElementById("songsView").classList.contains("active")) return;

  const [si, li] = selectedSlideKey.split(":").map(Number);
  const sections = collectFromDom();
  const sec = sections[si];
  if (!sec) return;

  if (k === "c") {
    copiedSlideText = sec.slides[li] ?? "";
    e.preventDefault();
    return;
  }

  // Paste: insert a copy right after the selected slide.
  if (copiedSlideText === null) return;
  e.preventDefault();
  sec.slides.splice(li + 1, 0, copiedSlideText);
  currentSong.sections = sections;
  selectedSlideKey = `${si}:${li + 1}`;   // keep the new copy selected
  renderSections();
});

// ---- Re-split an existing song into N lines per slide ----
// The paste dialog asks for this once, at creation. Songs imported from
// ProPresenter or typed in by hand need the same control afterwards.
function currentLinesPerSlide(sections) {
  // Show the layout the song actually has: the most common non-empty slide size.
  const counts = {};
  for (const sec of sections || []) for (const sl of sec.slides || []) {
    const n = String(sl).split("\n").filter(l => l.trim()).length;
    if (n) counts[n] = (counts[n] || 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? Math.min(6, Math.max(1, Number(best[0]))) : 2;
}

function reflowSections(sections, lps) {
  return sections.map(sec => {
    const lines = [];
    for (const sl of sec.slides || []) {
      for (const l of cleanSlideLines(String(sl).split("\n"))) lines.push(...wrapLine(l));
    }
    // An empty section is a deliberate blank slide (instrumental) — keep it.
    if (!lines.length) return { ...sec, slides: [""] };
    const slides = [];
    for (let i = 0; i < lines.length; i += lps) slides.push(lines.slice(i, i + lps).join("\n"));
    return { ...sec, slides };
  });
}

function syncLinesPerSlideControl() {
  const sel = document.getElementById("songLinesPerSlide");
  if (sel && currentSong) sel.value = String(currentLinesPerSlide(currentSong.sections));
}

document.getElementById("btnReflowSong").addEventListener("click", () => {
  if (!currentSong) return;
  const lps = Number(document.getElementById("songLinesPerSlide").value) || 2;
  currentSong.sections = reflowSections(collectFromDom(), lps);
  renderSections();
  syncLinesPerSlideControl();
});

document.getElementById("btnNewSong").addEventListener("click", async () => {
  if (await confirmDiscardSongChanges()) newSong();
});

// ---- Paste full song text → auto-split into sections and slides ----
// ── Song text parsing ────────────────────────────────────────────────────
// Handles the formats people actually paste: bare headings ("Приспів:"),
// bracketed ones ("[Chorus]", "(Verse 2)"), numbered either way round
// ("2 куплет", "Verse 2"), in any of the app's languages — and songs with no
// headings at all, where the repeated block is inferred to be the chorus.

// Every spelling that means the same section, mapped to our canonical name.
const SECTION_WORDS = [
  { name: "Приспів",     words: ["приспів","приспiв","пріспів","приспив","припев","припiв","прип","прыпеў","chorus","chor","refrain","refrão","refrao","refran","refrán","estribillo","kehrvers","ritornello","refren"] },
  { name: "Предприспів", words: ["предприспів","передприспів","предприпев","предприпів","pre-chorus","prechorus","pre chorus","prechor","pré-refrão","pre-refrao","pre-estribillo","pre refren"] },
  { name: "Куплет",      words: ["куплет","куплеты","куплети","верс","строфа","вірш","verse","vs","strophe","estrofe","estrofa","couplet","vers","zwrotka","strofa"] },
  { name: "Брідж",       words: ["брідж","бридж","брiдж","міст","мост","bridge","brücke","brucke","puente","ponte","pont"] },
  { name: "Тег",         words: ["тег","теґ","tag","coda","vamp"] },
  { name: "Інтро",       words: ["інтро","интро","вступ","вступление","вступління","intro","introduction","introdução","introducción"] },
  { name: "Програш",     words: ["програш","програші","проґраш","проигрыш","проигрышь","проиграш","проігриш","проигрыши","інструментал","инструментал","інструментальна частина","инструментальная часть","instrumental","interlude","solo","соло","musical","пауза","музыкальная пауза","музична пауза","pause","break","zwischenspiel"] },
  { name: "Аутро",       words: ["аутро","закінчення","окончание","кінцівка","концовка","outro","ending","final","schluss"] },
];

// Longest first so "pre-chorus" is never matched as "chorus".
const SECTION_LOOKUP = SECTION_WORDS
  .flatMap(g => g.words.map(w => ({ w: w.toLowerCase(), name: g.name })))
  .sort((a, b) => b.w.length - a.w.length);

// Words that are unmistakably an instrumental break. A short line containing
// one is a "Програш" heading whatever else it says: "Проигрыш (гитара)",
// "Музыкальный проигрыш — 8 тактов", "--- програш ---".
const INSTRUMENTAL_STRONG = ["програш","програші","проґраш","проигрыш","проигрышь","проиграш","проігриш","проигрыши",
  "інструментал","инструментал","інструментальний","инструментальный","instrumental","interlude","zwischenspiel"];

// Words that may sit next to a section name without making it a lyric:
// "Последний припев", "Final chorus", "Припев тихо", "Chorus (all)".
const HEADING_MODIFIERS = new Set([
  "последний","последняя","последнее","финальный","заключительный","первый","второй","третий","новый","тихий","тихо","громко","медленно","все","вместе","хор","модуляция",
  "останній","остання","фінальний","перший","другий","третій","новий","тихо","голосно","повільно","всі","усі","разом","модуляція",
  "final","last","first","second","third","new","quiet","soft","loud","big","all","together","full","half","modulation","slow","and","и","і","та","с","з",
]);

// Repeat markers songbooks use: "2х", "х2", "x2", "×3", "2 раза", "2р.", "двічі", "twice"…
// Cyrillic "х" is used as often as Latin "x", so both are accepted.
const LB = "(?<![\\p{L}\\p{N}])", RB = "(?![\\p{L}\\p{N}])";
const REPEAT_CORE = "(?:[xх×]\\s*(\\d{1,2})|(\\d{1,2})\\s*(?:[xх×]|р\\.?|раз(?:а|и|ів|ов)?|times?|veces|vezes|fois|mal|razy|krát)" +
  "|(дважды|двічі|двiчi|twice|dos veces|duas vezes|deux fois|zweimal|dwa razy)|(трижды|тричі|thrice))";
const REPEAT_END = new RegExp("[\\s(\\[{/|:,–—-]*" + LB + REPEAT_CORE + RB + "[\\s)\\]}/|:.,–—-]*$", "iu");
const REPEAT_START = new RegExp("^[\\s(\\[{/|:–—-]*" + LB + REPEAT_CORE + RB + "[\\s)\\]}/|:.,–—-]*", "iu");
// "Повтор", "Repeat", "ещё раз" — a repeat request without a number (= twice).
const REPEAT_VERB = /(?<![\p{L}])(?:повтор\p{L}*|повтори\p{L}*|repeat\p{L}*|rpt|ещё раз|еще раз|ще раз|щe раз|da capo)(?![\p{L}])/giu;

function repeatTimes(m) {
  if (!m) return 1;
  if (m[1] || m[2]) return Math.max(1, Math.min(10, Number(m[1] || m[2])));
  if (m[3]) return 2;
  if (m[4]) return 3;
  return 1;
}

// Take a repeat marker off the start or end of a string: "Аллилуйя (2х)" →
// { text: "Аллилуйя", times: 2 }. Returns times = 1 when there is none.
function splitRepeat(s) {
  let text = String(s || "");
  let times = 1;
  for (let guard = 0; guard < 2; guard++) {
    const e = text.match(REPEAT_END);
    if (e) {
      times = Math.max(times, repeatTimes(e)); text = text.slice(0, e.index); continue;
    }
    const b = text.match(REPEAT_START);
    if (b && b[0].trim()) { times = Math.max(times, repeatTimes(b)); text = text.slice(b[0].length); continue; }
    break;
  }
  return { text: text.trim(), times };
}

// A line that is nothing but a repeat instruction: "(2х)", "x2", "Повтор", "2 раза".
function standaloneRepeat(line) {
  const t = String(line || "").trim();
  if (!t) return 0;
  const r = splitRepeat(t);
  const rest = r.text.replace(REPEAT_VERB, "").replace(/[\s()\[\]{}\/|:.,*_~#–—-]+/g, "");
  if (rest) return 0;
  if (r.times > 1) return r.times;
  REPEAT_VERB.lastIndex = 0;
  return REPEAT_VERB.test(t) ? 2 : 0;
}

function stripHeadingDeco(t) {
  return String(t || "")
    .replace(/^[\s\[\(\{<*_~#=|\/.–—-]+/, "")
    .replace(/[\s\]\)\}>*_~#=|\/:.–—-]+$/, "")
    .trim();
}

// Parse a heading into { name, times, known }. Understands every form people
// paste: "Припев:", "[Chorus]", "2 куплет", "Припев 2х", "2х припев",
// "Припев (2 раза)", "Проигрыш (гитара)", "Последний припев", "Повтор припева".
function parseHeading(rawLine) {
  let t = String(rawLine || "").trim();
  if (!t || t.length > 60) return null;
  t = stripHeadingDeco(t);
  let times = 1;
  const r = splitRepeat(t);
  if (r.times > 1) { times = r.times; t = stripHeadingDeco(r.text); }
  REPEAT_VERB.lastIndex = 0;
  if (REPEAT_VERB.test(t)) { times = Math.max(times, 2); t = stripHeadingDeco(t.replace(REPEAT_VERB, " ")); }
  REPEAT_VERB.lastIndex = 0;
  // Descriptions in brackets are about the performance, not the section: drop them.
  const noParen = stripHeadingDeco(t.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, " "));
  if (noParen) t = noParen;
  if (!t || t.length > 40 || /[!?;]/.test(t)) return null;

  const low = t.toLowerCase().replace(/[:.,–—]/g, " ");
  const numMatch = low.match(/(\d+)/);
  const num = numMatch ? numMatch[1] : "";
  const wordPart = low.replace(/\d+/g, " ").replace(/\s+/g, " ").trim();
  if (!wordPart) return null;
  const numbered = (name) => (name === "Куплет" && num) ? name + " " + num : name;

  for (const { w, name } of SECTION_LOOKUP) {
    if (wordPart === w || wordPart === w + "s") return { name: numbered(name), times, known: true };
  }
  const tokens = wordPart.split(" ");
  if (tokens.length > 5) return null;
  if (tokens.some(tok => INSTRUMENTAL_STRONG.includes(tok))) return { name: "Програш", times, known: true };
  // "Последний припев", "Final chorus": a section word plus harmless modifiers.
  // Genitive/other case endings are accepted by prefix ("повтор припева").
  for (const { w, name } of SECTION_LOOKUP) {
    if (w.length < 4) continue;
    const re = new RegExp("(?:^|\\s)" + w.replace(/[-]/g, "[- ]?") + "\\p{L}{0,2}(?=\\s|$)", "u");
    const m = wordPart.match(re);
    if (!m) continue;
    const rest = (wordPart.slice(0, m.index) + " " + wordPart.slice(m.index + m[0].length)).split(" ").filter(Boolean);
    if (rest.every(x => HEADING_MODIFIERS.has(x))) return { name: numbered(name), times, known: true };
  }
  return null;
}

function matchSectionHeading(rawLine) {
  const h = parseHeading(rawLine);
  return h ? h.name : null;
}

// A heading can also be recognised STRUCTURALLY, not just by keyword: songs
// carry labels we will never have in a dictionary ("Интермедия", "Post-Chorus",
// "Ad lib"). Losing them means losing a whole section, so anything that
// clearly *looks* like a label is kept under the writer's own wording.
function detectHeading(rawLine) {
  const known = parseHeading(rawLine);
  if (known) return known;

  const t = String(rawLine || "").trim();
  if (!t || standaloneRepeat(t)) return null;

  // Strong signal: the entire line is wrapped in brackets — [Интермедия], (Vamp).
  const wrapped = t.match(/^[\[\(\{<]\s*([^\]\)\}>]{1,40})\s*[\]\)\}>]$/);
  if (wrapped) {
    const r = splitRepeat(wrapped[1]);
    const label = r.text.replace(/[:.–—]+$/, "").trim();
    // Reject something that is plainly a lyric in brackets rather than a label:
    // punctuation, or nothing but short interjections like "(oh oh)" / "(la la)".
    const parts = label.split(/\s+/);
    const allTinyWords = parts.every(p => p.replace(/[^\p{L}\p{N}]/gu, "").length <= 3);
    const repeatsAWord = new Set(parts.map(p => p.toLowerCase())).size < parts.length;
    const allLowercase = label === label.toLowerCase();
    const looksLikeInterjection = allTinyWords && (repeatsAWord || allLowercase);
    // "(Аллилуйя 2х)" is a repeated lyric, not a label.
    if (label && r.times === 1 && parts.length <= 4 && !/[.!?,;]/.test(label) && !looksLikeInterjection) {
      return { name: titleCaseLabel(label), times: 1, known: false };
    }
  }

  // Weaker signal: a short standalone line ending in a colon — "ПРОСЛАВЛЕНИЕ:".
  const colon = t.match(/^(.{1,32}?)\s*:$/);
  if (colon) {
    const r = splitRepeat(colon[1]);
    const label = r.text;
    if (label && label.split(/\s+/).length <= 4 && !/[.!?,;]/.test(label)) {
      return { name: titleCaseLabel(label), times: r.times, known: false };
    }
  }
  return null;
}

// Keep the writer's wording but normalise SHOUTED labels so the section header
// doesn't scream, while leaving mixed-case labels exactly as written.
function titleCaseLabel(label) {
  const s = String(label).trim();
  if (s !== s.toUpperCase()) return s;           // already mixed case — leave it
  return s.charAt(0) + s.slice(1).toLowerCase();
}

// Split one long line into readable chunks so a slide is never overfull.
const MAX_CHARS_PER_LINE = 45;
function wrapLine(line, maxChars = MAX_CHARS_PER_LINE) {
  const words = String(line).trim().split(/\s+/);
  const out = [];
  let cur = "";
  for (const word of words) {
    if (!cur) { cur = word; continue; }
    if ((cur + " " + word).length <= maxChars) { cur += " " + word; }
    else { out.push(cur); cur = word; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

// With no headings at all, the block that repeats verbatim is the chorus and
// the rest are verses in order — the same assumption a musician would make.
function inferSections(blocks) {
  const keyOf = (b) => b.join("\n").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
  const seen = new Map();
  blocks.forEach(b => seen.set(keyOf(b), (seen.get(keyOf(b)) || 0) + 1));
  let verseNo = 0;
  return blocks.map(b => {
    if (seen.get(keyOf(b)) > 1) return { name: "Приспів", lines: b };
    verseNo += 1;
    return { name: "Куплет " + verseNo, lines: b };
  });
}

// Turn pasted text into a clean list of lines: headings on their own line,
// repeat markers expanded ("Аллилуйя (2х)" → the line twice, a lone "(2х)"
// → the block above twice), "||: … :||" and "/ … / 2р" repeat brackets
// honoured, and hymnal verse numbers ("1. Amazing grace") turned into headings.
const END_MARKERS = new Set(["кінець","конец","конец песни","кінець пісні","the end","end","fine","fim","fin","ende","koniec"]);
function isEndMarker(t) {
  return END_MARKERS.has(stripHeadingDeco(t).toLowerCase());
}

function normalizeSongLines(raw) {
  const src = String(raw || "").replace(/\r/g, "").replace(/ /g, " ").split("\n");
  const out = [];
  let blockStart = 0;          // index in `out` where the current block began
  let prevBlock = null;        // [start, end) of the block before the last blank
  let slashOpen = -1;          // index in `out` of a line opened with "/" or "||:"
  const isBlank = (i) => !String(out[i] ?? "").trim();

  const endBlock = () => {
    if (out.length > blockStart) prevBlock = [blockStart, out.length];
    blockStart = out.length + 1;
  };

  for (let line of src) {
    let t = line.trim();
    if (!t) { endBlock(); out.push(""); slashOpen = -1; continue; }
    if (isEndMarker(t)) continue;               // "Кінець", "Конец", "The End"

    // Heading + lyric on one line: "[Verse 1] You call me…", "Припев: Слава Тебе".
    let m = t.match(/^([\[\(\{][^\]\)\}]{1,40}[\]\)\}])\s*(.+)$/);
    if (m && detectHeading(m[1]) && !standaloneRepeat(m[1])) { out.push(m[1]); blockStart = out.length; t = m[2].trim(); }
    else {
      m = t.match(/^([^:]{1,40}):\s*(\S.*)$/);
      if (m && parseHeading(m[1])) { out.push(m[1] + ":"); blockStart = out.length; t = m[2].trim(); }
      else {
        // "1 куплет. Как прекрасен…", "Припев. Слава…" — only verse/chorus
        // labels, so a lyric like "Мост. Он…" is never cut.
        m = t.match(/^([^.:]{1,25})\.\s+(\S.*)$/);
        const h = m && parseHeading(m[1]);
        if (h && (/^Куплет/.test(h.name) || h.name === "Приспів")) { out.push(m[1]); blockStart = out.length; t = m[2].trim(); }
      }
    }

    // Hymnal numbering at the start of a block: "1. Amazing grace…" / "2) …".
    const num = t.match(/^(\d{1,2})\s*[.)]\s+(\S.*)$/);
    if (num && (out.length === blockStart || isBlank(out.length - 1))) {
      out.push("Куплет " + num[1]); blockStart = out.length; t = num[2];
    }

    if (detectHeading(t)) { if (out.length > blockStart) prevBlock = [blockStart, out.length]; out.push(t); blockStart = out.length; slashOpen = -1; continue; }

    // A lone repeat marker repeats the block above it (or, after a blank
    // line, the previous block).
    const lone = standaloneRepeat(t);
    if (lone) {
      let range = out.length > blockStart ? [blockStart, out.length] : prevBlock;
      if (slashOpen >= 0) range = [slashOpen, out.length];
      if (range && range[1] > range[0]) {
        const copy = out.slice(range[0], range[1]);
        const fromBlank = out.length === blockStart;
        for (let k = 1; k < lone; k++) out.push(...copy);
        if (fromBlank) prevBlock = [range[0], out.length];
      }
      slashOpen = -1;
      continue;
    }

    // "||: line :||" — musical repeat signs.
    const bars = t.match(/^\|\|?:\s*(.*?)\s*:\|\|?\s*(.*)$/);
    let times = 1;
    if (bars) { t = bars[1] + (bars[2] ? " " + bars[2] : ""); times = 2; }
    const r = splitRepeat(t);
    let closedByMarker = false;
    if (r.times > 1 && r.text) {
      closedByMarker = /\/|:\|/.test(t.slice(t.indexOf(r.text) + r.text.length));
      t = r.text;
      if (/^[(\[{]/.test(t) && !/[)\]}]$/.test(t)) t = t.slice(1).trim();   // "(Аллилуйя 2х)"
      times = Math.max(times, r.times);
    }

    // Multi-line repeat bracket: "/ first line" … "last line / 2р".
    const opens = /^(?:\/{1,2}|\|\|?:)\s*\S/.test(t) && !/\S\s*(?:\/{1,2}|:\|\|?)$/.test(t);
    const closes = (closedByMarker || /\S\s*(?:\/{1,2}|:\|\|?)$/.test(t)) && !/^(?:\/{1,2}|\|\|?:)/.test(t);
    t = t.replace(/^(?:\/{1,2}|\|\|?:)\s*/, "").replace(/\s*(?:\/{1,2}|:\|\|?)$/, "").trim();
    if (!t) continue;

    if (opens) slashOpen = out.length;
    if (closes && slashOpen >= 0) {
      out.push(t);
      times = Math.max(2, times);
      const copy = out.slice(slashOpen);
      for (let k = 1; k < times; k++) out.push(...copy);
      slashOpen = -1;
      continue;
    }
    for (let k = 0; k < times; k++) out.push(t);
  }
  return out;
}

function parseSongText(raw, linesPerSlide) {
  const lines = normalizeSongLines(raw);

  // Pass 1: split on explicit headings, if the song has any.
  const sections = [];
  let cur = null;
  let sawHeading = false;
  const blocks = [];          // for the heading-less fallback
  let block = [];

  for (const line of lines) {
    const t = line.trim();
    const h = t ? detectHeading(t) : null;
    if (h) {
      sawHeading = true;
      cur = { name: h.name, lines: [], times: h.times || 1 };
      sections.push(cur);
      if (block.length) { blocks.push(block); block = []; }
      continue;
    }
    if (!t) {
      if (block.length) { blocks.push(block); block = []; }
      continue;
    }
    if (!cur) { cur = { name: null, lines: [], times: 1 }; sections.push(cur); }
    cur.lines.push(t);
    block.push(t);
  }
  if (block.length) blocks.push(block);

  // Lyrics before the first heading are the first verse.
  // A single line there is usually the song's title — leave it out.
  if (sections[0] && sections[0].name === null) {
    if (sawHeading && sections[0].lines.length > 1) sections[0].name = "Куплет"; else sections.shift();
  }

  // Number bare "Куплет" headings in order, so "Verse / Verse / Verse"
  // becomes Куплет 1 / 2 / 3 rather than three identical names. A bare
  // "Куплет" with no lyrics is a reference, not a new verse.
  let autoVerse = 0;
  for (const sec of sections) {
    if (sec.name === "Куплет") {
      if (!sec.lines.length && autoVerse) { sec.name = "Куплет " + autoVerse; continue; }
      autoVerse += 1; sec.name = "Куплет " + autoVerse;
    }
    else if (/^Куплет \d+$/.test(sec.name)) { autoVerse = Math.max(autoVerse, Number(sec.name.split(" ")[1]) || 0); }
  }

  // A heading with no lyrics under it ("Припев", "Припев 2х" after the second
  // verse) means "sing that part again": reuse the text it had last time.
  // Only a part that never had text stays empty — e.g. "Програш", which then
  // becomes a blank slide.
  const keyName = (n) => String(n || "").toLowerCase();
  sections.forEach((sec, i) => {
    if (sec.lines.length) return;
    for (let j = i - 1; j >= 0; j--) {
      if (keyName(sections[j].name) === keyName(sec.name) && sections[j].lines.length) { sec.lines = sections[j].lines.slice(); break; }
    }
  });

  const chosen = sawHeading ? sections : inferSections(blocks).map(s => ({ ...s, times: 1 }));
  if (!chosen.length) return [];

  return chosen.map(sec => {
    // Wrap over-long lines first, then group into slides.
    const wrapped = [];
    for (const l of sec.lines) wrapped.push(...wrapLine(l));
    let slides = [];
    for (let i = 0; i < wrapped.length; i += linesPerSlide) {
      slides.push(wrapped.slice(i, i + linesPerSlide).join("\n"));
    }
    // An empty section (e.g. "Програш:") becomes one blank slide — clicking it
    // clears the text on screen during the instrumental.
    if (!slides.length) slides.push("");
    // "Припев 2х": the whole part is sung again, so its slides follow twice
    // and the clicker simply keeps going.
    if (sec.times > 1 && slides.some(s => s)) {
      const once = slides;
      slides = [];
      for (let k = 0; k < sec.times; k++) slides.push(...once);
    }
    return { name: sec.name, slides };
  });
}

// Clean up lyrics already stored in a song: drop section labels and repeat
// instructions that ended up on slides as text, expanding the repeats.
function cleanSlideLines(lines) {
  const out = [];
  for (const l of lines) {
    const t = String(l).trim();
    if (!t) continue;
    if (parseHeading(t) || isEndMarker(t)) continue;
    const lone = standaloneRepeat(t);
    if (lone) {
      // Without block structure here, a lone marker repeats the previous line.
      if (out.length) for (let k = 1; k < lone; k++) out.push(out[out.length - 1]);
      continue;
    }
    const r = splitRepeat(t);
    const text = r.text.replace(/^(?:\/{1,2}|\|\|?:)\s*/, "").replace(/\s*(?:\/{1,2}|:\|\|?)$/, "").trim();
    if (!text) continue;
    for (let k = 0; k < (r.text ? r.times : 1); k++) out.push(text);
  }
  return out;
}

document.getElementById("btnPasteSong").addEventListener("click", () => {
  document.getElementById("pasteSongText").value = "";
  document.getElementById("pasteSongOverlay").style.display = "flex";
  setTimeout(() => document.getElementById("pasteSongText").focus(), 0);
});
document.getElementById("btnClosePasteSong").addEventListener("click", () => {
  document.getElementById("pasteSongOverlay").style.display = "none";
});
document.getElementById("btnApplyPasteSong").addEventListener("click", () => {
  const raw = document.getElementById("pasteSongText").value;
  if (!raw.trim()) return;
  const lps = Number(document.getElementById("pasteLinesPerSlide").value) || 2;
  const sections = parseSongText(raw, lps);
  if (!sections.length) { appAlert(window.i18n.t("Не вдалося розпізнати текст.")); return; }
  if (!currentSong) newSong();

  // Pasting into a song that already has content must ADD to it, not wipe it.
  // Losing an hour of typed lyrics to one paste is unforgivable mid-preparation.
  const existing = currentSong.id || currentSong.sections ? collectFromDom() : [];
  const hasContent = existing.some(sec => (sec.slides || []).some(sl => String(sl).trim()));
  currentSong.sections = hasContent ? existing.concat(sections) : sections;

  renderSections();
  document.getElementById("pasteSongOverlay").style.display = "none";
});
document.getElementById("btnAddSection").addEventListener("click", () => {
  if (!currentSong) newSong();
  currentSong.sections = collectFromDom();
  currentSong.sections.push({ name: nextSectionName(currentSong.sections), slides: [] });
  renderSections();
});
document.getElementById("btnSaveSong").addEventListener("click", async () => {
  if (!currentSong) newSong();
  clearTimeout(songAutosaveTimer); songAutosaveTimer = null;
  await saveCurrentSong(true);
});
document.getElementById("btnDeleteSong").addEventListener("click", async () => {
  if (!currentSong?.id) return;
  if (!(await appConfirm(tf("Видалити «{name}»?", { name: currentSong.title })))) return;
  clearTimeout(songAutosaveTimer); songAutosaveTimer = null;
  await songSaveChain;
  await window.songsApi.delete(currentSong.id);
  setSongSaveStatus("");
  currentSong = null;
  document.getElementById("songTitleInput").value = "";
  sectionsContainer.innerHTML = "";
  await refreshSongsList();
});
document.getElementById("btnImportPro").addEventListener("click", async () => {
  try {
    const result = await window.songsApi.importPro();
    if (!result) return;
    await refreshSongsList();
    if (result.batch) {
      const notes = [`${window.i18n.t("Імпортовано пісень:")} ${result.count}`];
      if (result.skipped) notes.push(tf("Уже є в бібліотеці: {n}", { n: result.skipped }));
      if (result.failed) notes.push(tf("(не вдалося: {n})", { n: result.failed }));
      appAlert(notes.join("\n"));
      if (result.first) loadSong(result.first.id);
    } else {
      loadSong(result.id);
    }
  } catch (e) {
    appAlert(window.i18n.t("Не вдалося імпортувати .pro:")+"\n" + describeError(e));
  }
});

document.getElementById("btnImportProLibrary").addEventListener("click", async () => {
  const btn = document.getElementById("btnImportProLibrary");
  const orig = btn.innerHTML;
  btn.textContent = window.i18n.t("Імпорт бібліотеки…"); btn.disabled = true;
  try {
    const res = await window.songsApi.importProLibrary();
    if (!res) return;
    await refreshSongsList();
    const failedNote = res.failed ? " " + tf("(не вдалося: {n})", { n: res.failed }) : "";
    const skippedNote = res.skipped ? "\n" + tf("Уже є в бібліотеці: {n}", { n: res.skipped }) : "";
    appAlert(tf("Імпортовано {count} з {total} пісень", { count: res.count, total: res.total }) + failedNote + "." + skippedNote + "\n" + window.i18n.t("Пісні згруповані за теками бібліотеки."));
  } catch (e) {
    appAlert(window.i18n.t("Не вдалося імпортувати бібліотеку:")+"\n" + describeError(e));
  } finally {
    btn.innerHTML = orig; btn.disabled = false;
  }
});

refreshSongsList();

// ════════════════════════════════════════════════════════════
//  PRESENTATIONS
// ════════════════════════════════════════════════════════════
let presentations = [], currentPresentation = null;
const presListItems = document.getElementById("presListItems");

async function refreshPresList(selectId) {
  presentations = await window.presentationsApi.list();
  const groups = groupByCollection(presentations);
  presListItems.innerHTML = groups.map(([col, items]) => `
    <div class="collectionGroup">
      <div class="collectionHeader">${esc(collectionLabel(col))}</div>
      ${items.map(p => `<div class="libItem ${currentPresentation?.id === p.id ? "active" : ""}" data-id="${esc(p.id)}" title="${esc(window.i18n.t("ПКМ — видалити"))}">
        <svg viewBox="0 0 24 24" class="ic ic-sm"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v4M8.5 20h7"/><path d="M7.5 12V9M12 12V7.5M16.5 12v-2"/></svg><span class="libItemTitle">${esc(p.title)}</span>
        <span class="libItemBadge">${p.slideCount}</span>
        <button class="libItemMove" data-move="${esc(p.id)}" data-cur="${esc(p.collection||"")}" title="${esc(window.i18n.t("Змінити збірку"))}"><svg viewBox="0 0 24 24" class="ic ic-sm"><path d="M4 6.5h6l2 2h8v9.5H4z"/></svg></button>
        <button class="libItemMove" data-del="${esc(p.id)}" data-name="${esc(p.title)}" title="${esc(window.i18n.t("Видалити презентацію"))}"><svg viewBox="0 0 24 24" class="ic ic-sm"><path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5 7.5 20h9l1-13.5M10.5 10v6M13.5 10v6"/></svg></button>
      </div>`).join("")}
    </div>`).join("");
  presListItems.querySelectorAll(".libItem").forEach(el => {
    el.addEventListener("click", e => { if (e.target.closest(".libItemMove")) return; loadPresentation(el.dataset.id); });
    el.addEventListener("contextmenu", async e => {
      e.preventDefault();
      const p = presentations.find(x => x.id === el.dataset.id);
      if (p) await deletePresentation(p.id, p.title);
    });
  });
  presListItems.querySelectorAll("[data-move]").forEach(btn => btn.addEventListener("click", async e => {
    e.stopPropagation();
    // Existing collections come from the presentations themselves; names are
    // compared trimmed so near-duplicates don't show up as separate choices.
    const existing = [...new Set(presentations.map(p => (p.collection || "").trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    const newCol = await appChooseCollection(window.i18n.t("Змінити збірку"), existing, (btn.dataset.cur || "").trim());
    if (newCol === null) return;
    await window.presentationsApi.setCollection(btn.dataset.move, newCol.trim());
    refreshPresList();
  }));
  presListItems.querySelectorAll("[data-del]").forEach(btn => btn.addEventListener("click", async e => {
    e.stopPropagation();
    await deletePresentation(btn.dataset.del, btn.dataset.name);
  }));
  if (selectId) loadPresentation(selectId);
  remoteSync();
}

async function deletePresentation(id, title) {
  if (!(await appConfirm(tf("Видалити презентацію «{name}»?", { name: title })))) return;
  await window.presentationsApi.delete(id);
  if (currentPresentation?.id === id) {
    currentPresentation = null;
    document.getElementById("presTitle").textContent = window.i18n.t("Оберіть презентацію зліва");
    document.getElementById("presSlideGrid").innerHTML = "";
  }
  refreshPresList();
}

async function loadPresentation(id) {
  const p = await window.presentationsApi.get(id);
  if (!p) return;
  currentPresentation = { id, ...p };
  document.getElementById("presTitle").textContent = p.title;
  const grid = document.getElementById("presSlideGrid");

  if ((!p.slides || !p.slides.length) && (p.pdfFile || p.pdfPath)) {
    // Imported by an older app version that stored only a PDF: no PNG slides.
    grid.innerHTML = `<p class="emptyNote">${esc(window.i18n.t("Ця презентація збережена старою версією програми. Видаліть її та імпортуйте .pptx ще раз."))}</p>`;
    refreshPresList();
    return;
  }

  grid.innerHTML = (p.slides || []).map((s, i) => {
    const url = s.imagePath ? toFileUrl(s.imagePath) : null;
    const bg = url ? `style="background-image:url('${url}');background-size:contain;background-position:center;background-repeat:no-repeat;background-color:#000"` : "";
    return `<div class="slideCard" data-idx="${i}">
      <div class="slideCardThumb" ${bg}>${!url && s.text ? `<span class="slideCardText">${esc(s.text)}</span>` : ""}</div>
      <div class="slideCardFooter"><span class="num">${i+1}</span><span class="lbl">${esc(p.title)}</span></div>
    </div>`;
  }).join("");
  grid.querySelectorAll(".slideCard").forEach(el => el.addEventListener("click", () => {
    const idx = Number(el.dataset.idx);
    const slide = currentPresentation.slides[idx];
    grid.querySelectorAll(".slideCard").forEach(c => c.classList.toggle("live", c === el));
    // Take over the clicker queue: arrows/remote now step through THESE slides.
    const plItem = currentPlaylist && livePlIdx >= 0 ? currentPlaylist.items[livePlIdx] : null;
    playbackQueue = { type: "pres", slides: currentPresentation.slides, fromPlaylist: !!(plItem && plItem.type === "presentation" && plItem.presId === currentPresentation.id) };
    playbackIndex = idx;
    showOnOutput({ text: slide.text || "", image: slide.imagePath ? toFileUrl(slide.imagePath) : null });
  }));
  refreshPresList();
}

// Errors crossing IPC arrive as "Error invoking remote method '…': Error: X".
// Strip that plumbing, and map the importer's error codes to readable text in
// the user's language — the main process doesn't know which language is on.
function describeError(e) {
  const raw = String((e && e.message) || e || "")
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^(?:\w*Error:\s*)+/, "");
  if (/WRONG_FILE_KIND/.test(raw)) return window.i18n.t("Цей файл іншого типу. Оберіть файл, експортований з цього розділу програми.");
  if (/XML_UNRECOGNISED/.test(raw)) return window.i18n.t("Формат XML не розпізнано. Підтримуються Zefania XML, OSIS та <bible>/<book number>.");
  if (/PROTHEME_INVALID/.test(raw)) return window.i18n.t("Файл теми пошкоджений або не містить слайдів.");
  if (/PPTX_EMPTY/.test(raw)) return window.i18n.t("У презентації немає слайдів.");
  if (/LIBREOFFICE_MISSING/.test(raw)) return window.i18n.t("LibreOffice не знайдено. Встановіть LibreOffice, щоб імпортувати .pptx, або збережіть презентацію як PDF.");
  if (/LIBREOFFICE_TIMEOUT/.test(raw)) return window.i18n.t("LibreOffice не встиг перетворити файл. Спробуйте ще раз або збережіть презентацію як PDF.");
  if (/BAD_ID|FILE_TOO_LARGE|TOO_MANY_PAGES/.test(raw)) return window.i18n.t("Файл пошкоджений або має невідомий формат.");
  if (/LIBREOFFICE_NO_PDF/.test(raw)) return window.i18n.t("LibreOffice не зміг перетворити файл.");
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout|HTTP \d+|net::ERR/i.test(raw)) return window.i18n.t("Немає зʼєднання з інтернетом або сервер не відповідає.");
  if (/Unexpected token|Unexpected end of JSON|is not valid JSON|JSON\.parse/i.test(raw)) return window.i18n.t("Файл пошкоджений або має невідомий формат.");
  if (/PDF_PASSWORD/.test(raw)) return window.i18n.t("PDF захищений паролем. Зніміть пароль і імпортуйте знову.");
  if (/PDF_EMPTY/.test(raw)) return window.i18n.t("У PDF немає сторінок.");
  if (/PDF_UNREADABLE/.test(raw)) return window.i18n.t("Файл пошкоджений або це не PDF.");
  if (/CANVAS_MISSING/.test(raw)) return window.i18n.t("Ця збірка програми неповна: бракує модуля показу слайдів. Встановіть найновішу версію.");
  return raw;
}

document.getElementById("btnImportPptx").addEventListener("click", async () => {
  const btn = document.getElementById("btnImportPptx");
  const orig = btn.innerHTML;
  btn.textContent = window.i18n.t("Імпорт…"); btn.disabled = true;
  try {
    const p = await window.presentationsApi.importPptx({
      title: window.i18n.t("Імпорт презентації (.pptx, .pdf)"),
      all: window.i18n.t("Презентації"),
    });
    if (p) await refreshPresList(p.id);
  } catch (e) {
    if (/LIBREOFFICE_MISSING/.test(String(e && (e.message || e)))) {
      // A .pptx without LibreOffice: say what is missing and offer the download.
      const go = await appConfirm(describeError(e) + "\n\n" + window.i18n.t("Відкрити сторінку завантаження LibreOffice?"));
      if (go) openLibreOfficeDownload();
      checkLibreOfficeStatus();
    } else {
      appAlert(window.i18n.t("Не вдалося імпортувати презентацію:") + "\n" + describeError(e));
    }
  } finally {
    btn.innerHTML = orig; btn.disabled = false;
  }
});

// LibreOffice status. Nothing is shown while it is installed; without it a
// reminder stays above the presentations, with the download link, and checks
// again by itself when the operator comes back from installing it.
async function checkLibreOfficeStatus() {
  const el = document.getElementById("loStatus");
  let s;
  try { s = await window.systemApi.checkLibreOffice(); } catch (e) { return; }
  if (s.found) { el.style.display = "none"; el.innerHTML = ""; el.className = ""; return; }
  el.style.display = "";
  el.className = "warn";
  el.innerHTML = `<svg viewBox="0 0 24 24" class="ic ic-sm"><path d="M12 4 21 19.5H3z"/><path d="M12 10v4.2M12 17v.1"/></svg>` +
    `<span class="loText">${esc(window.i18n.t("LibreOffice не знайдено — без нього презентації .pptx показати неможливо."))} ${esc(window.i18n.t("PDF працюють і без нього."))}</span>` +
    `<a href="#" id="loLink" class="btn sm">${esc(window.i18n.t("Встановити LibreOffice (безкоштовно)"))}</a>` +
    `<button class="btn sm ghost" id="loRecheck">${esc(window.i18n.t("Перевірити ще раз"))}</button>`;
  document.getElementById("loLink").addEventListener("click", (e) => { e.preventDefault(); openLibreOfficeDownload(); });
  document.getElementById("loRecheck").addEventListener("click", async (e) => {
    e.currentTarget.textContent = window.i18n.t("Перевіряю…");
    await checkLibreOfficeStatus();
  });
}
function openLibreOfficeDownload() {
  window.systemApi.openExternal("https://www.libreoffice.org/download/download-libreoffice/");
}
checkLibreOfficeStatus();
window.addEventListener("focus", () => {
  if (document.getElementById("loStatus").classList.contains("warn")) checkLibreOfficeStatus();
});

refreshPresList();

// ════════════════════════════════════════════════════════════
//  ANNOUNCEMENTS — flat gallery, no mandatory grouping
// ════════════════════════════════════════════════════════════
// All imported images are stored in MEDIA_DIR individually.
// The "announcements" API groups them in named sets for re-use,
// but the primary flow is: import → gallery → click to show.

let annImages = [];
// flat list of { file, path, label } currently shown in the gallery
let annSelectedIdx = -1;   // card currently chosen in the Media grid
const annListItems = document.getElementById("annListItems");

// These two headings hold a USER title once something is opened, so their
// elements are data-no-i18n. The initial placeholder is our own text though,
// so it must be translated explicitly here and on every language change.
function paintPlaceholderTitles() {
  const pt = document.getElementById("presTitle");
  const at = document.getElementById("annTitle");
  if (pt && !currentPresentation) pt.textContent = window.i18n.t("Оберіть презентацію зліва");
  if (at && !annCurrentSetId) at.textContent = window.i18n.t("Оберіть набір зліва");
  const pv = document.getElementById("previewText");
  if (pv && pv.textContent.trim() === "Оберіть вірш…") pv.textContent = window.i18n.t("Оберіть вірш…");
}

// The main process can't know the UI language, so the title for a new media
// set is built here and passed along — otherwise every set is named in
// Ukrainian regardless of the chosen language.
function defaultMediaSetTitle() {
  const localeMap = { uk: "uk-UA", ru: "ru-RU", en: "en-GB", es: "es-ES", pt: "pt-BR", fr: "fr-FR", de: "de-DE" };
  const lang = window.i18n.getLang ? window.i18n.getLang() : "uk";
  const locale = localeMap[lang] || lang;   // every UI language is a valid locale tag
  return window.i18n.t("Об'яви") + " " + new Date().toLocaleDateString(locale);
}

async function refreshAnnGallery() {
  // Load all announcement sets and flatten into a single image gallery
  const sets = await window.announcementsApi.list();
  if (sets.length === 0) {
    annListItems.innerHTML = `<p class="emptyNote">${esc(window.i18n.t("Натисніть «Додати картинки» щоб завантажити зображення."))}</p>`;
    annImages = [];
    renderAnnGrid();
    return;
  }

  // Sidebar: list of named sets, click loads that set into the grid
  annListItems.innerHTML = sets.map(s => `
    <div class="libItem" data-id="${esc(s.id)}">
      <svg viewBox="0 0 24 24" class="ic ic-sm"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M4.5 16.5 9 12.5l3.5 3 3-2.5 4 4"/></svg>
      <span class="libItemTitle">${esc(s.title)}</span>
      <span class="libItemBadge">${s.imageCount}</span>
      <button class="libItemMove" data-ren="${esc(s.id)}" data-title="${esc(s.title)}" title="${esc(window.i18n.t("Перейменувати набір"))}"><svg viewBox="0 0 24 24" class="ic ic-sm"><path d="M15.5 4.5 19.5 8.5 8 20H4v-4z"/><path d="M13.5 6.5 17.5 10.5"/></svg></button>
      <button class="libItemMove" data-id="${esc(s.id)}" title="${esc(window.i18n.t("Видалити набір"))}"><svg viewBox="0 0 24 24" class="ic ic-sm"><path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5 7.5 20h9l1-13.5M10.5 10v6M13.5 10v6"/></svg></button>
    </div>`).join("");

  annListItems.querySelectorAll("[data-ren]").forEach(btn => btn.addEventListener("click", async e => {
    e.stopPropagation();
    const name = await appPrompt(window.i18n.t("Назва набору:"), btn.dataset.title);
    if (name === null || !name.trim()) return;
    await window.announcementsApi.rename(btn.dataset.ren, name.trim());
    refreshAnnGallery();
  }));

  annListItems.querySelectorAll(".libItem").forEach(el => {
    el.addEventListener("click", async e => {
      if (e.target.closest(".libItemMove")) return;
      const set = await window.announcementsApi.get(el.dataset.id);
      if (!set) return;
      annCurrentSetId = el.dataset.id;
      annImages = set.images.map(img => ({ file: img.file, path: img.path, label: set.title }));
      annListItems.querySelectorAll(".libItem").forEach(i => i.classList.remove("active"));
      el.classList.add("active");
      document.getElementById("annTitle").textContent = set.title;
      renderAnnGrid();
    });
  });
  annListItems.querySelectorAll("[data-id].libItemMove").forEach(btn => btn.addEventListener("click", async e => {
    e.stopPropagation();
    if (!(await appConfirm(window.i18n.t("Видалити цей набір?")))) return;
    await window.announcementsApi.delete(btn.dataset.id);
    if (annCurrentSetId === btn.dataset.id) annCurrentSetId = null;
    annImages = [];
    renderAnnGrid();
    refreshAnnGallery();
  }));

  // Auto-load the first set on first visit if grid is empty
  if (annImages.length === 0 && sets.length > 0) {
    const first = await window.announcementsApi.get(sets[0].id);
    if (first) {
      annCurrentSetId = sets[0].id;
      annImages = first.images.map(img => ({ file: img.file, path: img.path, label: first.title }));
      document.getElementById("annTitle").textContent = first.title;
      annListItems.querySelector(".libItem")?.classList.add("active");
      renderAnnGrid();
    }
  }
}

function isVideoFile(name) { return /\.(mp4|webm|mov|m4v)$/i.test(String(name || "")); }

// Drop media files onto the Media grid to add them to the current set.
let annDropWired = false;
function wireAnnDropZone() {
  if (annDropWired) return;
  const grid = document.getElementById("annSlideGrid");
  if (!grid || !window.__wireDropZone) return;
  annDropWired = true;
  window.__wireDropZone(grid, async (paths) => {
    // Append to the open set when there is one, otherwise start a new set.
    const a = await window.announcementsApi.importPaths(paths, annCurrentSetId || null, defaultMediaSetTitle());
    if (a) { annCurrentSetId = a.id; await refreshAnnGallery(); }
  });
}

function renderAnnGrid() {
  wireAnnDropZone();
  const grid = document.getElementById("annSlideGrid");
  if (annImages.length === 0) {
    grid.innerHTML = `<p class="emptyNote">${esc(window.i18n.t("Оберіть набір зліва або натисніть «Додати картинки»."))}</p>`;
    return;
  }
  grid.innerHTML = annImages.map((img, i) => `
    <div class="slideCard" data-idx="${i}">
      <button class="annImgDel tileBtn del" data-file="${esc(img.file)}" title="${esc(window.i18n.t("Видалити цю картинку"))}"><svg viewBox="0 0 24 24" class="ic"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button>
      <button class="annImgAdd tileBtn add" data-idx="${i}" title="${esc(window.i18n.t("Додати у плейлист служіння"))}"><svg viewBox="0 0 24 24" class="ic"><path d="M12 5.5v13M5.5 12h13"/></svg></button>
      ${isVideoFile(img.file)
        ? `<div class="slideCardThumb mediaThumb">
             <video src="${esc(toFileUrl(img.path))}" muted playsinline preload="metadata"></video>
             <span class="tag bl">${esc(window.i18n.t("ВІДЕО"))}</span>
           </div>`
        : `<div class="slideCardThumb mediaThumb" style="background-image:url('${toFileUrl(img.path)}')"></div>`}
      <div class="slideCardFooter"><span class="num">${i+1}</span><span class="lbl">${esc(img.label || window.i18n.t("Об'ява"))}</span></div>
    </div>`).join("");
  // Announcement slides belong in the running order just like songs and
  // verses — without this they had to be found by hand mid-service.
  grid.querySelectorAll(".annImgAdd").forEach(btn => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const img = annImages[Number(btn.dataset.idx)];
    if (!img) return;
    ensurePlaylist();
    currentPlaylist.items.push({
      type: "announcement",
      text: "",
      imagePath: img.path,
      // Every image in a set shares the set's title, so append the position —
      // otherwise six announcement slides look identical in the running order.
      title: `${img.label || img.file} · ${Number(btn.dataset.idx) + 1}`,
    });
    renderPlaylistStrip();
    savePlaylistNow();
  }));

  grid.querySelectorAll(".slideCard").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".annImgDel") || e.target.closest(".annImgAdd")) return;
      const idx = Number(el.dataset.idx);
      annSelectedIdx = idx;
      grid.querySelectorAll(".slideCard").forEach(c => c.classList.toggle("live", c === el));
      const img = annImages[idx];
      el.parentElement.querySelectorAll(".slideCard").forEach(c => c.classList.toggle("live", c === el));
      // Take over the clicker queue: arrows/remote step through the gallery.
      playbackQueue = { type: "ann" };
      playbackIndex = idx;
      showOnOutput(isVideoFile(img.file)
        ? { text: "", video: toFileUrl(img.path) }
        : { text: "", image: toFileUrl(img.path) });
    });
  });
  grid.querySelectorAll(".annImgDel").forEach(btn => btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!annCurrentSetId) return;
    if (!(await appConfirm(window.i18n.t("Видалити цю картинку?")))) return;
    const res = await window.announcementsApi.removeImage(annCurrentSetId, btn.dataset.file);
    if (res && res.deleted) {
      // The set became empty and was removed.
      annCurrentSetId = null;
      annImages = [];
    } else if (res) {
      annImages = (res.images || []).map(f => ({ file: f, path: null, label: res.title }));
      // re-fetch to get resolved paths
      const full = await window.announcementsApi.get(annCurrentSetId);
      if (full) annImages = full.images.map(im => ({ file: im.file, path: im.path, label: full.title }));
    }
    renderAnnGrid();
    refreshAnnGallery();
  }));
}

let annCurrentSetId = null; // id of the set currently open in the grid

document.getElementById("btnImportImages").addEventListener("click", async () => {
  try {
    const a = await window.announcementsApi.importImages(null, defaultMediaSetTitle()); // no id = new set
    if (!a) return;
    annCurrentSetId = a.id;
    const full = await window.announcementsApi.get(a.id);
    if (full) {
      annImages = full.images.map(img => ({ file: img.file, path: img.path, label: full.title }));
      document.getElementById("annTitle").textContent = full.title;
      renderAnnGrid();
    }
    refreshAnnGallery();
  } catch (e) {
    appAlert(window.i18n.t("Не вдалося імпортувати картинки:")+"\n" + describeError(e));
  }
});

document.getElementById("btnAddToSet").addEventListener("click", async () => {
  if (!annCurrentSetId) {
    appAlert(window.i18n.t("Спочатку оберіть або створіть набір зліва."));
    return;
  }
  try {
    const a = await window.announcementsApi.importImages(annCurrentSetId, defaultMediaSetTitle()); // append
    if (!a) return;
    const full = await window.announcementsApi.get(a.id);
    if (full) {
      annImages = full.images.map(img => ({ file: img.file, path: img.path, label: full.title }));
      document.getElementById("annTitle").textContent = full.title;
      renderAnnGrid();
    }
    refreshAnnGallery();
  } catch (e) {
    appAlert(window.i18n.t("Не вдалося додати картинки:")+"\n" + describeError(e));
  }
});

refreshAnnGallery();

// ════════════════════════════════════════════════════════════
//  THEMES — separate Bible and Song themes
// ════════════════════════════════════════════════════════════
const bibleThemeSelect = document.getElementById("bibleThemeSelect");
const songThemeSelect = document.getElementById("songThemeSelect");
let bibleTheme = null, songTheme = null;   // full theme objects (or null = default)
let systemFonts = [];
// Safe built-ins offered at the top of every font picker.
const BASE_FONTS = ["Georgia", "Arial", "Times New Roman", "Verdana", "Tahoma", "Segoe UI", "Calibri"];
function allFonts() { return [...new Set([...BASE_FONTS, ...systemFonts])]; }

async function loadSystemFonts() {
  try {
    systemFonts = await window.systemApi.listFonts();
  } catch (e) { systemFonts = []; }
  const all = allFonts();
  const fontSel = document.getElementById("te_font");
  fontSel.innerHTML = all.map(f => `<option value="${esc(f)}" style="font-family:'${esc(f)}'">${esc(f)}</option>`).join("");
}

async function refreshThemes(selectBibleId, selectSongId) {
  const themes = await window.themesApi.list();
  const opts = `<option value="">${esc(window.i18n.t("Без теми"))}</option>` + themes.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
  const prevB = bibleThemeSelect.value, prevS = songThemeSelect.value;
  bibleThemeSelect.innerHTML = opts;
  songThemeSelect.innerHTML = opts;
  bibleThemeSelect.value = selectBibleId !== undefined ? (selectBibleId || "") : prevB;
  songThemeSelect.value = selectSongId !== undefined ? (selectSongId || "") : prevS;

  // Render the deletable theme list in the manager panel.
  const listEl = document.getElementById("themesList");
  if (listEl) {
    if (!themes.length) {
      listEl.innerHTML = `<p class="emptyNote">${esc(window.i18n.t("Ще немає тем. Створіть або імпортуйте."))}</p>`;
    } else {
      listEl.innerHTML = themes.map(t => `
        <div class="libItem" data-id="${esc(t.id)}">
          <svg viewBox="0 0 24 24" class="ic ic-sm"><path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.9 1.4-1.9-.5-1.2.4-2.4 1.7-2.4h1.6A3.8 3.8 0 0 0 20.5 12 8.5 8.5 0 0 0 12 3.5Z"/><circle cx="8" cy="10" r="1.1"/><circle cx="12" cy="8" r="1.1"/></svg>
          <span class="libItemTitle">${esc(t.name)}</span>
          <button class="libItemMove" data-edit="${esc(t.id)}" title="${esc(window.i18n.t("Редагувати тему (шрифт, фон, розмір)"))}"><svg viewBox="0 0 24 24" class="ic ic-sm"><path d="M15.5 4.5 19.5 8.5 8 20H4v-4z"/><path d="M13.5 6.5 17.5 10.5"/></svg></button>
          <button class="libItemMove" data-exp="${esc(t.id)}" title="${esc(window.i18n.t("Експортувати тему у файл"))}"><svg viewBox="0 0 24 24" class="ic ic-sm"><path d="M12 20V9M7.5 13.5 12 9l4.5 4.5M5 4.5h14"/></svg></button>
          <button class="libItemMove" data-del="${esc(t.id)}" data-name="${esc(t.name)}" title="${esc(window.i18n.t("Видалити тему"))}"><svg viewBox="0 0 24 24" class="ic ic-sm"><path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5 7.5 20h9l1-13.5M10.5 10v6M13.5 10v6"/></svg></button>
        </div>`).join("");
      listEl.querySelectorAll("[data-edit]").forEach(btn => btn.addEventListener("click", () => openThemeForEdit(btn.dataset.edit)));
      listEl.querySelectorAll("[data-exp]").forEach(btn => btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try { await window.themesApi.exportFile(btn.dataset.exp); }
        catch (err) { appAlert(window.i18n.t("Не вдалося експортувати тему:") + "\n" + describeError(err)); }
      }));
      listEl.querySelectorAll("[data-del]").forEach(btn => btn.addEventListener("click", async () => {
        if (!(await appConfirm(tf("Видалити тему «{name}»?", { name: btn.dataset.name })))) return;
        await window.themesApi.delete(btn.dataset.del);
        const nb = bibleThemeSelect.value === btn.dataset.del ? "" : bibleThemeSelect.value;
        const ns = songThemeSelect.value === btn.dataset.del ? "" : songThemeSelect.value;
        await refreshThemes(nb, ns);
      }));
    }
  }

  await applyBibleTheme();
  await applySongTheme();
}

// ---- Themes manager open/close ----
document.getElementById("btnOpenThemes").addEventListener("click", () => {
  document.getElementById("themesManagerOverlay").style.display = "flex";
  window.i18n.applyI18n(document.getElementById("themesManagerOverlay"));
});
document.getElementById("btnCloseThemes").addEventListener("click", () => {
  document.getElementById("themesManagerOverlay").style.display = "none";
});

// Transition speed slider (crossfade duration for the projector), plus a
// dedicated "instant, no fade" checkbox that overrides it without erasing
// the chosen speed underneath.
{
  const slider = document.getElementById("transMsSlider");
  const label = document.getElementById("transMsVal");
  const none = document.getElementById("transMsNone");
  const savedRaw = localStorage.getItem("transitionMs");
  slider.value = (savedRaw === null) ? 400 : Math.max(0, Number(savedRaw) || 0);
  label.textContent = slider.value;
  none.checked = localStorage.getItem("transitionMsNone") === "1";
  slider.disabled = none.checked;
  slider.addEventListener("input", () => {
    label.textContent = slider.value;
    localStorage.setItem("transitionMs", slider.value);
  });
  none.addEventListener("change", () => {
    localStorage.setItem("transitionMsNone", none.checked ? "1" : "0");
    slider.disabled = none.checked;
  });
}

// ── Font resolution ────────────────────────────────────────
// Imported .proTheme files often store PostScript-style names like
// "Montserrat-SemiBold" that CSS can't resolve (the browser silently falls
// back to the default serif). Detect availability via canvas measurement and
// try normalized candidates: raw → weight suffix stripped → CamelCase spaced.
const _fontCanvas = (() => { try { return document.createElement("canvas").getContext("2d"); } catch (e) { return null; } })();
function fontAvailable(name) {
  // No 2D context (very old engine / headless): assume the font is fine rather
  // than crashing the theme editor.
  if (!name || !_fontCanvas) return false;
  const probe = "мИWQйg1lІї";
  _fontCanvas.font = "72px monospace";
  const base = _fontCanvas.measureText(probe).width;
  _fontCanvas.font = `72px "${name.replace(/"/g, '')}", monospace`;
  return _fontCanvas.measureText(probe).width !== base;
}
function resolveFontFamily(name) {
  if (!name) return name;
  // MIGRATION: themes saved by earlier versions stored a full CSS list like
  // '"Montserrat", Georgia, serif'. Unwrap to the first bare family name.
  name = String(name).split(",")[0].trim().replace(/^["']+|["']+$/g, "").trim();
  const candidates = [name];
  const stripped = name.replace(/[-_ ]?(regular|bold|semibold|demibold|extrabold|ultrabold|light|extralight|ultralight|thin|medium|black|heavy|italic|oblique|book)+$/i, "").replace(/[-_]+$/, "");
  if (stripped && stripped !== name) candidates.push(stripped);
  // Several spacing guesses, narrowest first. Splitting EVERY CamelCase hump
  // breaks multi-hump names ("DejaVuSans" → "Deja Vu Sans"), so also try
  // splitting only before the final word ("DejaVu Sans").
  const push = (v) => { const t = String(v || "").replace(/\s+/g, " ").trim(); if (t && !candidates.includes(t)) candidates.push(t); };
  push(stripped.replace(/[-_]+/g, " "));
  push(stripped.replace(/([a-zа-я0-9])([A-ZА-Я][a-zа-я]+)$/, "$1 $2").replace(/[-_]+/g, " "));
  push(stripped.replace(/([a-zа-я0-9])([A-ZА-Я])/g, "$1 $2").replace(/[-_]+/g, " "));
  // Renderability decides, not string similarity: a name may exist in the OS
  // font list ("Montserrat SemiBold") yet not be usable as a CSS family, in
  // which case the browser silently falls back to another face. So test each
  // candidate with the canvas probe first, and only then consult the list.
  for (const c of candidates) if (fontAvailable(c)) return c;

  const squash = (v) => String(v).toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = squash(stripped || name);
  try {
    // Exact squashed match, then a prefix match so "MontserratSemiBold"
    // still finds the installed "Montserrat".
    const list = allFonts();
    const exact = list.find((f) => squash(f) === wanted);
    if (exact && fontAvailable(exact)) return exact;
    // A prefix match is only ever allowed to strip a WEIGHT/STYLE suffix —
    // never to jump to a different family. "DIN Alternate" must not resolve to
    // some other installed font just because a few letters line up.
    const STYLE_TAIL = /^(regular|bold|semibold|demibold|extrabold|ultrabold|light|extralight|ultralight|thin|medium|black|heavy|italic|oblique|book|roman|normal)+$/;
    const prefix = list
      .filter((f) => {
        const sf = squash(f);
        if (sf.length < 4 || !wanted.startsWith(sf)) return false;
        return STYLE_TAIL.test(wanted.slice(sf.length));
      })
      .sort((a, b) => squash(b).length - squash(a).length)[0];
    if (prefix && fontAvailable(prefix)) return prefix;
    if (exact) return exact;
  } catch (e) { /* font list not loaded yet */ }
  return name; // nothing resolved — keep as-is
}
function normalizeThemeFont(theme) {
  if (theme && theme.fontFamily) theme.fontFamily = resolveFontFamily(theme.fontFamily);
  // The output window needs a URL it can load for the background media.
  if (theme && theme.bgPath) theme.bgUrl = toFileUrl(theme.bgPath);
  return theme;
}

async function applyBibleTheme() {
  const id = bibleThemeSelect.value;
  bibleTheme = id ? normalizeThemeFont(await window.themesApi.get(id)) : null;
  updatePreviewStyle(); // refresh the in-app Bible preview to match
}
async function applySongTheme() {
  const id = songThemeSelect.value;
  songTheme = id ? normalizeThemeFont(await window.themesApi.get(id)) : null;
  refreshSongCardBackground();
}

// Song slide cards show what the projector will put behind the words: the
// background picked in the strip, else the song theme's picture or video,
// else its colour (black without a theme). A video appears as one still
// frame, grabbed once — a playing copy in every card would cost the
// projector its frame rate.
// `var`: refreshPreviewBackground() can run while this file is still loading.
var stillFrames = new Map();
function stillFrame(src, type) {
  if (!stillFrames) stillFrames = new Map();
  if (stillFrames.has(src)) return stillFrames.get(src);
  const job = new Promise((resolve, reject) => {
    const isVideo = type === "video" || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(src);
    const el = document.createElement(isVideo ? "video" : "img");
    el.crossOrigin = "anonymous";
    const timer = setTimeout(() => reject(new Error("timeout")), 10000);
    const grab = () => {
      try {
        const w0 = isVideo ? el.videoWidth : el.naturalWidth, h0 = isVideo ? el.videoHeight : el.naturalHeight;
        if (!w0 || !h0) throw new Error("no size");
        const w = Math.min(640, w0), h = Math.round(h0 * w / w0);
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        c.getContext("2d").drawImage(el, 0, 0, w, h);
        clearTimeout(timer);
        resolve(c.toDataURL("image/jpeg", 0.85));
      } catch (e) { clearTimeout(timer); reject(e); }
      if (isVideo) { el.removeAttribute("src"); el.load(); }
    };
    el.onerror = () => { clearTimeout(timer); reject(new Error("load")); };
    if (isVideo) {
      el.muted = true; el.playsInline = true; el.preload = "auto";
      el.addEventListener("loadeddata", () => { el.currentTime = Math.min(1, (el.duration || 2) / 4); }, { once: true });
      el.addEventListener("seeked", grab, { once: true });
    } else el.onload = grab;
    el.src = src;
  });
  job.catch(() => stillFrames.delete(src));
  stillFrames.set(src, job);
  return job;
}
var songCardBgKey = null;
async function refreshSongCardBackground() {
  const box = document.getElementById("sectionsContainer");
  if (!box) return;
  let src = null, type = null, fit = (songTheme && songTheme.bgFit) || "cover";
  if (liveBackground && liveBackground.path) { src = toFileUrl(liveBackground.path); type = liveBackground.type; }
  else if (songTheme && songTheme.bgUrl) { src = songTheme.bgUrl; type = songTheme.bgType; }
  box.style.setProperty("--song-bg", (songTheme && songTheme.background) || "#000");
  box.style.setProperty("--song-fit", fit === "contain" ? "contain" : "cover");
  const key = src || "";
  if (key === songCardBgKey) return;
  songCardBgKey = key;
  if (!src) { box.style.setProperty("--song-img", "none"); box.classList.remove("hasBg"); return; }
  try {
    const url = await stillFrame(src, type);
    if (songCardBgKey !== key) return;
    box.style.setProperty("--song-img", `url("${url}")`);
    box.classList.add("hasBg");
  } catch (e) {
    if (songCardBgKey !== key) return;
    // A picture can still be shown straight from the file; a video that
    // would not give up a frame leaves the plain background.
    const img = type !== "video" && !/\.(mp4|webm|mov|m4v)(\?|$)/i.test(src);
    box.style.setProperty("--song-img", img ? `url("${src}")` : "none");
    box.classList.toggle("hasBg", img);
  }
}

// Map a theme object to the preview-pane CSS variables so the control-window
// Bible preview looks exactly like the projector output.
function updatePreviewStyle() {
  const cv = document.getElementById("bibleCanvas");
  const t = bibleTheme;
  refreshPreviewBackground();
  if (!t) {
    ["--pv-bg","--pv-color","--pv-font","--pv-size","--pv-align","--pv-valign","--pv-transform","--pv-spacing","--pv-line","--pv-weight"].forEach(v => cv.style.removeProperty(v));
    return;
  }
  cv.style.setProperty("--pv-bg", t.background || "#000");
  cv.style.setProperty("--pv-color", t.color || "#fff");
  cv.style.setProperty("--pv-font", t.fontFamily ? `"${t.fontFamily}", "Segoe UI", sans-serif` : "Georgia, serif");
  // Match the output exactly: output font = fontSize/1080 of screen height.
  // Scale the same ratio against the preview canvas's real pixel height.
  const canvasH = cv.clientHeight || 400;
  const px = ((t.fontSize || 80) / 1080) * canvasH;
  cv.style.setProperty("--pv-size", Math.max(11, px) + "px");
  cv.style.setProperty("--pv-align", t.align || "center");
  cv.style.setProperty("--pv-valign", t.valign === "flex-start" ? "flex-start" : t.valign === "flex-end" ? "flex-end" : "center");
  cv.style.setProperty("--pv-transform", t.uppercase ? "uppercase" : "none");
  cv.style.setProperty("--pv-spacing", (t.letterSpacing ?? 0) + "em");
  cv.style.setProperty("--pv-line", String(t.lineHeight ?? 1.3));
  cv.style.setProperty("--pv-weight", t.bold ? "700" : "400");
}

// The preview must show the same background the projector will: a background
// picked in the strip wins (it overrides the theme on the output too), then the
// theme's own image/video. Colour alone made the preview misleading — text that
// read fine on black could be illegible over a bright photo.
function refreshPreviewBackground() {
  refreshSongCardBackground();
  const layer = document.getElementById("pvBg");
  if (!layer) return;
  let url = null, type = null, fit = "cover";
  if (liveBackground && liveBackground.path) {
    url = toFileUrl(liveBackground.path);
    type = liveBackground.type;
    fit = (bibleTheme && bibleTheme.bgFit) || "cover";
  } else if (bibleTheme && bibleTheme.bgUrl) {
    url = bibleTheme.bgUrl;
    type = bibleTheme.bgType;
    fit = bibleTheme.bgFit || "cover";
  }
  if (!url) {
    if (layer.dataset.src) { layer.innerHTML = ""; delete layer.dataset.src; }
    return;
  }
  const objFit = fit === "contain" ? "contain" : "cover";
  // Same clip → leave it alone, so a looping video isn't restarted on every verse.
  if (layer.dataset.src === url) {
    const el = layer.firstElementChild;
    if (el) el.style.objectFit = objFit;
    return;
  }
  layer.dataset.src = url;
  layer.innerHTML = "";
  const isVideo = type === "video" || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url);
  const el = document.createElement(isVideo ? "video" : "img");
  el.src = url;
  el.style.objectFit = objFit;
  if (isVideo) {
    // A still frame, not a second playback: decoding the same (often 4K) clip
    // here as well as on the projector halved the frame rate on both.
    el.muted = true; el.playsInline = true; el.preload = "auto";
    el.setAttribute("muted", ""); el.setAttribute("playsinline", "");
    el.addEventListener("loadeddata", () => {
      try { el.currentTime = Math.min(1, (el.duration || 2) / 4); } catch (e) {}
      el.pause();
    }, { once: true });
  } else {
    el.alt = "";
  }
  layer.appendChild(el);
}

// Re-scale the preview when the window resizes (canvas height changes).
window.addEventListener("resize", () => { if (bibleTheme) updatePreviewStyle(); });

bibleThemeSelect.addEventListener("change", () => { localStorage.setItem("bibleThemeId", bibleThemeSelect.value); applyBibleTheme(); });
songThemeSelect.addEventListener("change", () => { localStorage.setItem("songThemeId", songThemeSelect.value); applySongTheme(); });

document.getElementById("btnImportTheme").addEventListener("click", async () => {
  try {
    const t = await window.themesApi.importProTheme();
    if (t) await refreshThemes(t.id, songThemeSelect.value);
  } catch (e) {
    appAlert(window.i18n.t("Не вдалося імпортувати тему:")+"\n" + describeError(e));
  }
});

document.getElementById("btnImportThemeFile").addEventListener("click", async () => {
  try {
    const t = await window.themesApi.importFile();
    if (t) await refreshThemes(t.id, songThemeSelect.value);
  } catch (e) {
    appAlert(window.i18n.t("Не вдалося імпортувати тему:")+"\n" + describeError(e));
  }
});

// ---- Theme editor with live preview ----
const teEls = {};
["te_name","te_target","te_font","te_size","te_size_val","te_spacing","te_spacing_val","te_line","te_line_val","te_linegap","te_linegap_val","te_bgFit","te_bgName","te_color","te_bg","te_align","te_upper","te_bold","te_shadow","te_preview","te_preview_text"].forEach(id => teEls[id] = document.getElementById(id));

let teBg = { file: null, type: null, path: null }; // theme background media being edited
let editingThemeId = null;                        // null = creating a new theme

function readThemeEditor() {
  return {
    id: editingThemeId || undefined,   // keep editing the same theme instead of duplicating
    bgFile: teBg.file || null,
    bgType: teBg.type || null,
    bgFit: teEls.te_bgFit.value,
    name: teEls.te_name.value.trim(),
    target: teEls.te_target.value,
    // Resolve to a matchable family at save time (e.g. "Stem-Bold" → "Stem"),
    // so the stored theme works identically in preview and on the projector.
    fontFamily: resolveFontFamily(teEls.te_font.value),
    fontSize: Number(teEls.te_size.value) || 80,
    color: teEls.te_color.value,
    background: teEls.te_bg.value,
    align: teEls.te_align.value,
    valign: "center",
    uppercase: teEls.te_upper.checked,
    bold: teEls.te_bold.checked,
    shadow: teEls.te_shadow.checked,
    letterSpacing: Number(teEls.te_spacing.value) / 100,  // slider -5..30 -> -0.05..0.3em
    lineHeight: Number(teEls.te_line.value) / 100,         // slider 80..250 -> 0.8..2.5
    lineGap: Number(teEls.te_linegap.value) / 100,         // slider 0..150 -> 0..1.5em between sentences/lines
  };
}

function updateThemeEditorPreview() {
  const t = readThemeEditor();
  teEls.te_size_val.textContent = t.fontSize;
  teEls.te_spacing_val.textContent = t.letterSpacing.toFixed(2);
  teEls.te_line_val.textContent = t.lineHeight.toFixed(2);
  teEls.te_linegap_val.textContent = t.lineGap.toFixed(2);
  const p = teEls.te_preview;
  p.style.background = t.background;
  // Show the chosen background (video shows its poster-ish first frame via <video>).
  const oldVid = p.querySelector("video.tePreviewVid");
  if (oldVid) oldVid.remove();
  p.style.backgroundImage = "none";
  if (teBg.path) {
    if (teBg.type === "video") {
      const v = document.createElement("video");
      v.className = "tePreviewVid";
      v.src = toFileUrl(teBg.path);
      v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
      v.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:" + (t.bgFit === "contain" ? "contain" : "cover") + ";z-index:0";
      p.style.position = "relative";
      p.insertBefore(v, p.firstChild);
      const pr=v.play(); if(pr&&pr.catch) pr.catch(()=>{});
    } else {
      p.style.backgroundImage = `url("${toFileUrl(teBg.path)}")`;
      p.style.backgroundSize = t.bgFit === "contain" ? "contain" : "cover";
      p.style.backgroundPosition = "center";
      p.style.backgroundRepeat = "no-repeat";
    }
  }
  const txtEl = teEls.te_preview_text;
  if (txtEl) { txtEl.style.position = "relative"; txtEl.style.zIndex = "1"; }
  const txt = teEls.te_preview_text;
  txt.style.color = t.color;
  txt.style.fontFamily = `"${resolveFontFamily(t.fontFamily)}", "Segoe UI", sans-serif`;
  // Same proportion as the projector (size is in 1080-line units), so the
  // preview shows real line breaks rather than a rough impression.
  const ph = p.clientHeight;
  if (!ph) requestAnimationFrame(() => { if (teEls.te_preview.clientHeight) updateThemeEditorPreview(); });
  txt.style.fontSize = Math.max(7, (t.fontSize / 1080) * (ph || 194)) + "px";
  txt.style.textTransform = t.uppercase ? "uppercase" : "none";
  txt.style.fontWeight = t.bold ? "700" : "400";
  txt.style.letterSpacing = t.letterSpacing + "em";
  txt.style.lineHeight = String(t.lineHeight);
  txt.style.textShadow = t.shadow ? "0 2px 12px rgba(0,0,0,0.6)" : "none";
  p.style.textAlign = t.align;
  // Two-line sample so «відступ між реченнями» is visible live.
  txt.textContent = "";
  [window.i18n.t("На початку було Слово,"), window.i18n.t("і Слово було у Бога.")].forEach((ln, i) => {
    const d = document.createElement("div");
    d.textContent = ln;
    if (i > 0) d.style.marginTop = t.lineGap + "em";
    txt.appendChild(d);
  });
}

// ---- Background library: import once, then pick from thumbnails ----
{
  const overlay = document.getElementById("bgPickerOverlay");
  const grid = document.getElementById("bgPickerGrid");

  async function renderBgGrid() {
    // Theme editor: offer Media files too — reusing an existing image here is useful.
    const items = await window.systemApi.listBackgroundsAll();
    if (!items.length) {
      grid.innerHTML = `<p class="emptyNote" style="grid-column:1/-1">${esc(window.i18n.t("Ще немає фонів. Натисніть «＋ Додати фони»."))}</p>`;
      return;
    }
    grid.innerHTML = items.map(i => `
      <div class="bgItem${teBg.file === i.file ? " picked" : ""}" data-file="${esc(i.file)}" data-type="${esc(i.type)}" data-path="${esc(i.path)}">
        ${i.type === "video"
          ? `<video src="${esc(toFileUrl(i.path))}" muted playsinline preload="metadata"></video>
             <span class="tag tl">${esc(window.i18n.t("ВІДЕО"))}</span>`
          : `<div class="bgFill" style="background-image:url('${toFileUrl(i.path)}')"></div>`}
        ${i.source === "media"
          ? `<span class="tag accent" style="right:34px;top:7px" title="${esc(window.i18n.t("З вкладки Медіа"))}">${esc(window.i18n.t("Медіа"))}</span>`
          : ""}
        <button class="bgDel tileBtn del" data-del="${esc(i.file)}" data-source="${esc(i.source || "library")}" title="${esc(window.i18n.t("Видалити фон"))}"><svg viewBox="0 0 24 24" class="ic"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button>
        <div class="bgName">${esc(i.file)}</div>
      </div>`).join("");

    grid.querySelectorAll(".bgItem").forEach(el => el.addEventListener("click", (e) => {
      if (e.target.closest(".bgDel")) return;
      teBg = { file: el.dataset.file, type: el.dataset.type, path: el.dataset.path };
      teEls.te_bgName.textContent = (teBg.type === "video" ? " " : " ") + teBg.file;
      updateThemeEditorPreview();
      overlay.style.display = "none";
    }));
    grid.querySelectorAll("[data-del]").forEach(btn => btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (btn.dataset.source === "media") {
        appAlert(window.i18n.t("Цей файл додано через вкладку «Медіа» — видаліть його там."));
        return;
      }
      if (!(await appConfirm(window.i18n.t("Видалити цей фон?")))) return;
      await window.systemApi.deleteBackground(btn.dataset.del);
      if (teBg.file === btn.dataset.del) {
        teBg = { file: null, type: null, path: null };
        teEls.te_bgName.textContent = window.i18n.t("Без фону");
        updateThemeEditorPreview();
      }
      renderBgGrid();
    }));
  }

  document.getElementById("te_bgPick").addEventListener("click", async () => {
    overlay.style.display = "flex";
    grid.innerHTML = "…";
    await renderBgGrid();
    window.i18n.applyI18n(overlay);
  });
  document.getElementById("btnCloseBgPicker").addEventListener("click", () => { overlay.style.display = "none"; });
  document.getElementById("btnAddBackgrounds").addEventListener("click", async () => {
    try {
      const added = await window.systemApi.addBackgrounds();
      await renderBgGrid();
      if (added && added.length === 1) {
        // A single new file is almost certainly the one to use — select it.
        teBg = added[0];
        teEls.te_bgName.textContent = (teBg.type === "video" ? " " : " ") + teBg.file;
        updateThemeEditorPreview();
      }
    } catch (e) { appAlert(window.i18n.t("Не вдалося додати фон:") + "\n" + describeError(e)); }
  });
}

document.getElementById("te_bgClear").addEventListener("click", () => {
  teBg = { file: null, type: null, path: null };
  teEls.te_bgName.textContent = window.i18n.t("Без фону");
  updateThemeEditorPreview();
});

["te_font","te_size","te_spacing","te_line","te_linegap","te_bgFit","te_color","te_bg","te_align","te_upper","te_bold","te_shadow"].forEach(id => {
  const el = teEls[id];
  el.addEventListener("input", updateThemeEditorPreview);
  el.addEventListener("change", updateThemeEditorPreview);
});

document.getElementById("btnNewTheme").addEventListener("click", async () => {
  await loadSystemFonts();
  editingThemeId = null;
  document.getElementById("themeDlgTitle").textContent = window.i18n.t("Нова тема");
  teEls.te_name.value = "";
  teEls.te_size.value = 80;
  teEls.te_spacing.value = 0;
  teEls.te_line.value = 130;
  teEls.te_linegap.value = 0;
  teBg = { file: null, type: null, path: null };
  teEls.te_bgName.textContent = window.i18n.t("Без фону");
  teEls.te_bgFit.value = "cover";
  teEls.te_color.value = "#ffffff";
  teEls.te_bg.value = "#000000";
  teEls.te_align.value = "center";
  teEls.te_upper.checked = false;
  teEls.te_bold.checked = false;
  teEls.te_shadow.checked = true;
  teEls.te_target.value = "both";
  updateThemeEditorPreview();
  document.getElementById("themeOverlay").style.display = "flex";
  teEls.te_name.focus();
});
// Colour pickers only take #rrggbb. Themes imported from ProPresenter by older
// versions stored "rgba(…)", which the picker silently turned into black.
function cssToHex(value, fallback) {
  const v = String(value || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return "#" + v.slice(1).split("").map(c => c + c).join("").toLowerCase();
  const m = v.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)$/i);
  if (m) {
    if (m[4] !== undefined && Number(m[4]) === 0) return "#000000";
    return "#" + [m[1], m[2], m[3]].map(n => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, "0")).join("");
  }
  return fallback;
}

async function openThemeForEdit(id) {
  const t = await window.themesApi.get(id);
  if (!t) return;
  await loadSystemFonts();
  editingThemeId = id;
  document.getElementById("themeDlgTitle").textContent = window.i18n.t("Редагування теми");
  teEls.te_name.value = t.name || "";
  teEls.te_target.value = t.target || "both";
  if ([...teEls.te_font.options].some(o => o.value === t.fontFamily)) teEls.te_font.value = t.fontFamily;
  teEls.te_size.value = t.fontSize ?? 80;
  teEls.te_spacing.value = Math.round((t.letterSpacing ?? 0) * 100);
  teEls.te_line.value = Math.round((t.lineHeight ?? 1.3) * 100);
  teEls.te_linegap.value = Math.round((t.lineGap ?? 0) * 100);
  teEls.te_color.value = cssToHex(t.color, "#ffffff");
  teEls.te_bg.value = cssToHex(t.background, "#000000");
  teEls.te_align.value = t.align || "center";
  teEls.te_upper.checked = !!t.uppercase;
  teEls.te_bold.checked = !!t.bold;
  teEls.te_shadow.checked = t.shadow !== false;
  teEls.te_bgFit.value = t.bgFit || "cover";
  teBg = t.bgFile ? { file: t.bgFile, type: t.bgType, path: t.bgPath } : { file: null, type: null, path: null };
  teEls.te_bgName.textContent = t.bgFile ? ((t.bgType === "video" ? " " : " ") + t.bgFile) : window.i18n.t("Без фону");
  updateThemeEditorPreview();
  document.getElementById("themeOverlay").style.display = "flex";
}

document.getElementById("btnCancelTheme").addEventListener("click", () => { document.getElementById("themeOverlay").style.display = "none"; });

document.getElementById("btnSaveTheme").addEventListener("click", async () => {
  const t = readThemeEditor();
  if (!t.name) { teEls.te_name.style.borderColor = "var(--red)"; teEls.te_name.focus(); return; }
  teEls.te_name.style.borderColor = "";
  const saved = await window.themesApi.save(t);
  document.getElementById("themeOverlay").style.display = "none";
  // Auto-assign the new theme to the chosen target(s)
  const b = (t.target === "both" || t.target === "bible") ? saved.id : bibleThemeSelect.value;
  const s = (t.target === "both" || t.target === "song") ? saved.id : songThemeSelect.value;
  await refreshThemes(b, s);
});

loadSystemFonts();
refreshThemes(localStorage.getItem("bibleThemeId") || "", localStorage.getItem("songThemeId") || "");

// ════════════════════════════════════════════════════════════
//  PLAYLIST (bottom strip)
// ════════════════════════════════════════════════════════════
let playlists = [], currentPlaylist = null, livePlIdx = -1;
const playlistSelect = document.getElementById("playlistSelect");
const playlistItemsEl = document.getElementById("playlistItems");

async function refreshPlaylistSelect(selectId) {
  playlists = await window.playlistsApi.list();
  remoteSync();
  playlistSelect.innerHTML = `<option value="">${esc(window.i18n.t("— оберіть або створіть —"))}</option>` + playlists.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  if (selectId) { playlistSelect.value = selectId; loadPlaylist(selectId); }
  else if (currentPlaylist?.id) playlistSelect.value = currentPlaylist.id;
}

async function loadPlaylist(id) {
  const pl = await window.playlistsApi.get(id);
  if (!pl) return;
  currentPlaylist = { id, ...pl };
  localStorage.setItem("lastPlaylistId", id);
  livePlIdx = -1;
  renderPlaylistStrip();
}

function renderPlaylistStrip() {
  if (!currentPlaylist) { playlistItemsEl.innerHTML = ""; remoteSync(); return; }
  const ICONS = {
    bible: '<svg viewBox="0 0 24 24" class="ic ic-sm"><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 0 5 20.5V4.5Z"/><path d="M5 17.5h13"/></svg>',
    song: '<svg viewBox="0 0 24 24" class="ic ic-sm"><path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/></svg>',
    presentation: '<svg viewBox="0 0 24 24" class="ic ic-sm"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v4M8.5 20h7"/></svg>',
    announcement: '<svg viewBox="0 0 24 24" class="ic ic-sm"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M4.5 16.5 9 12.5l3.5 3 3-2.5 4 4"/></svg>',
  };
  const TYPE_LABEL = { bible: "Біблія", song: "Пісня", presentation: "Презентація", announcement: "Медіа" };
  remoteSync();
  playlistItemsEl.innerHTML = currentPlaylist.items.map((item, i) => {
    const label = playlistItemLabel(item);
    return `<div class="plItem ${i === livePlIdx ? "live" : ""}" data-idx="${i}" draggable="true" title="${esc(window.i18n.t("ПКМ: видалити"))}">
      <span class="plItemType">${ICONS[item.type] || ""} ${esc(window.i18n.t(TYPE_LABEL[item.type] || ""))}</span>
      <span class="plItemTitle">${esc(label)}</span>
    </div>`;
  }).join("");
  // Add button at end
  playlistItemsEl.innerHTML += `<div class="plItemAdd">
    <button id="btnPlAddBible">${window.i18n.t("+ Вірш")}</button>
    <button id="btnPlAddSong">${window.i18n.t("+ Пісня")}</button>
    <button id="btnPlAddPres">${window.i18n.t("+ Презентація")}</button>
  </div>`;

  // ── Reordering by drag & drop ──
  // The running order changes constantly right before a service, so dragging a
  // song into place must be possible without deleting and re-adding it.
  let dragFrom = null;
  const clearDropMarks = () => playlistItemsEl.querySelectorAll(".plItem")
    .forEach(x => x.classList.remove("dropBefore", "dropAfter", "dragging"));

  playlistItemsEl.querySelectorAll(".plItem").forEach(el => {
    el.addEventListener("click", () => {
      if (dragFrom !== null) return;      // ignore the click that ends a drag
      playPlaylistItem(Number(el.dataset.idx));
    });
    el.addEventListener("contextmenu", e => {
      e.preventDefault();
      const idx = Number(el.dataset.idx);
      currentPlaylist.items.splice(idx, 1);
      // Keep the "live" highlight on the same entry (or drop it if removed).
      if (livePlIdx === idx) livePlIdx = -1;
      else if (livePlIdx > idx) livePlIdx -= 1;
      renderPlaylistStrip(); savePlaylistNow();
    });

    el.addEventListener("dragstart", (e) => {
      dragFrom = Number(el.dataset.idx);
      el.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      // Firefox refuses to start a drag without data on the transfer.
      try { e.dataTransfer.setData("text/plain", String(dragFrom)); } catch (err) {}
    });
    el.addEventListener("dragend", () => { dragFrom = null; clearDropMarks(); });

    el.addEventListener("dragover", (e) => {
      if (dragFrom === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = el.getBoundingClientRect();
      const after = (e.clientX - r.left) > r.width / 2;
      el.classList.toggle("dropAfter", after);
      el.classList.toggle("dropBefore", !after);
    });
    el.addEventListener("dragleave", () => el.classList.remove("dropBefore", "dropAfter"));

    el.addEventListener("drop", (e) => {
      if (dragFrom === null) return;
      e.preventDefault();
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      const after = (e.clientX - r.left) > r.width / 2;
      let to = Number(el.dataset.idx) + (after ? 1 : 0);
      const from = dragFrom;
      dragFrom = null;
      clearDropMarks();
      if (from === to || from + 1 === to) return;   // dropped where it already was
      const items = currentPlaylist.items;
      const [moved] = items.splice(from, 1);
      if (from < to) to -= 1;                        // indices shift after removal
      items.splice(to, 0, moved);
      // Keep the "currently live" highlight pointing at the same ITEM.
      if (livePlIdx === from) livePlIdx = to;
      else if (livePlIdx > from && livePlIdx <= to) livePlIdx -= 1;
      else if (livePlIdx < from && livePlIdx >= to) livePlIdx += 1;
      renderPlaylistStrip();
      savePlaylistNow();
    });
  });
  document.getElementById("btnPlAddBible")?.addEventListener("click", addCurrentVerseToPlaylist);
  document.getElementById("btnPlAddSong")?.addEventListener("click", addCurrentSongToPlaylist);
  document.getElementById("btnPlAddPres")?.addEventListener("click", addCurrentPresentationToPlaylist);
}

async function playPlaylistItem(idx) {
  try { await playPlaylistItemInner(idx); } finally { remoteSync(); }
}
async function playPlaylistItemInner(idx) {
  const item = currentPlaylist.items[idx];
  if (!item) return;
  livePlIdx = idx;
  renderPlaylistStrip();
  if (item.type === "bible") {
    switchTab("bibleView");
    const prevTranslation = currentTranslationId;
    currentTranslationId = item.translationId;
    translationSelect.value = currentTranslationId;
    try {
      await loadBooks();
    } catch (e) {
      // Translation missing on this PC (e.g. playlist made elsewhere) —
      // restore the previous one instead of leaving the tab broken.
      currentTranslationId = prevTranslation;
      translationSelect.value = prevTranslation || "";
      if (prevTranslation) { try { await loadBooks(); } catch (e2) {} }
      appAlert(window.i18n.t("Переклад для цього пункту не встановлено. Завантажте його через «Завантажити переклад»."));
      return;
    }
    const book = books.find(b => b.osis === item.osis);
    if (book) {
      selectBook(book, false);
      currentChapter = item.chapter;
      await renderChapters();
      currentVerse = item.verse;
      await renderVerses(); // refreshes verse grid + highlights current verse
      // Armed, like every other playlist entry: the verse is in the preview and
      // the first Next puts it on screen. Reading on continues from there.
      playbackQueue = { type: "bible", count: currentVerseCount, armed: true, fromPlaylist: true };
      playbackIndex = currentVerse - 1;
    }
  } else if (item.type === "song") {
    switchTab("songsView");
    const opened = await loadSong(item.songId); // opens the song in the editor
    if (opened === "cancel") return;           // operator kept editing the open song
    if (!currentSong || currentSong.id !== item.songId) {
      // The song was deleted from the library — do NOT arm the queue with
      // whatever song happens to be open in the editor.
      playbackQueue = null; playbackIndex = -1;
      appAlert(window.i18n.t("Цю пісню видалено з бібліотеки."));
      return;
    }
    // Arm the clicker queue but do NOT show anything yet — the operator
    // presses Next (or clicks a slide) when ready.
    const flat = [];
    (currentSong.sections || []).forEach((sec, si) => sec.slides.forEach((text, li) => flat.push({ text, sectionName: sec.name, sectionIdx: si, lineIdx: li, key: `${si}:${li}` })));
    if (flat.length) {
      playbackQueue = { type: "song", slides: flat, fromPlaylist: true };
      playbackIndex = -1; // first "next" lands on slide 0
      liveSongKey = null;
      sectionsContainer.querySelectorAll(".slideCard").forEach(c => c.classList.remove("live"));
    }
  } else if (item.type === "presentation") {
    switchTab("presView");
    await loadPresentation(item.presId);
    if (!currentPresentation || currentPresentation.id !== item.presId) {
      // The presentation was deleted from the library — same guard as for a
      // deleted song, so the remote doesn't end up driving stale content.
      playbackQueue = null; playbackIndex = -1;
      appAlert(window.i18n.t("Цю презентацію видалено з бібліотеки."));
      return;
    }
    if (currentPresentation.slides && currentPresentation.slides.length) {
      playbackQueue = { type: "pres", slides: currentPresentation.slides, fromPlaylist: true };
      playbackIndex = -1; // first "next" lands on slide 0, same convention as songs
      document.getElementById("presSlideGrid").querySelectorAll(".slideCard").forEach(c => c.classList.remove("live"));
    }
  } else if (item.type === "announcement") {
    // Armed like the rest; the first Next shows it, the second moves on.
    playbackQueue = { type: "plMedia", item, fromPlaylist: true };
    playbackIndex = -1;
  }
}

// Media sets hold videos as well as pictures; a video must play, not be
// handed to the output as a (blank) image.
function showPlaylistMedia(item) {
  if (item.imagePath && isVideoFile(item.imagePath)) showOnOutput({ text: "", video: toFileUrl(item.imagePath) });
  else showOnOutput({ text: item.text || "", image: item.imagePath ? toFileUrl(item.imagePath) : null });
}

// Next past the end of a playlist entry opens the following entry and shows
// its first slide, so a whole service runs from the remote alone.
let advancingPlaylist = false;
async function advancePlaylist() {
  if (advancingPlaylist || !currentPlaylist || livePlIdx < 0) return;
  const n = livePlIdx + 1;
  if (n >= currentPlaylist.items.length) return;
  advancingPlaylist = true;
  try {
    await playPlaylistItem(n);
    if (playbackQueue && livePlIdx === n) await clickerStep("next");
  } finally { advancingPlaylist = false; }
}

function ensurePlaylist() {
  if (!currentPlaylist) currentPlaylist = { id: null, name: window.i18n.t("Нове служіння"), items: [] };
}

async function addCurrentVerseToPlaylist() {
  ensurePlaylist();
  const v = await window.bibleApi.getVerse(currentTranslationId, currentBook?.osis, currentChapter, currentVerse, window.i18n.getLang());
  if (!v) return;
  if (!currentBook) return;
  currentPlaylist.items.push({ type: "bible", translationId: currentTranslationId, translationName: v.translationName, osis: currentBook.osis, bookName: v.bookName, chapter: currentChapter, verse: currentVerse });
  renderPlaylistStrip();
  savePlaylistNow();
}

async function addCurrentSongToPlaylist() {
  ensurePlaylist();
  if (!currentSong?.id) { appAlert(window.i18n.t("Спочатку відкрийте або збережіть пісню")); return; }
  currentPlaylist.items.push({ type: "song", songId: currentSong.id, title: currentSong.title });
  renderPlaylistStrip();
  savePlaylistNow();
}

async function addCurrentPresentationToPlaylist() {
  ensurePlaylist();
  if (!currentPresentation?.id) { appAlert(window.i18n.t("Спочатку відкрийте презентацію")); return; }
  currentPlaylist.items.push({ type: "presentation", presId: currentPresentation.id, title: currentPresentation.title });
  renderPlaylistStrip();
  savePlaylistNow();
}

document.getElementById("btnAddBibleToPlaylist")?.addEventListener("click", addCurrentVerseToPlaylist);
document.getElementById("btnAddBibleToPlaylist2").addEventListener("click", addCurrentVerseToPlaylist);
document.getElementById("btnAddSongToPlaylist").addEventListener("click", addCurrentSongToPlaylist);
document.getElementById("btnAddPresToPlaylist").addEventListener("click", addCurrentPresentationToPlaylist);

// ── Bulk add: every picked song, in the order they appear in the library ──
document.getElementById("btnAddPickedSongs").addEventListener("click", () => {
  if (!pickedSongIds.size) return;
  ensurePlaylist();
  // Library order, not click order — that is what the operator sees.
  [...songsListItems.querySelectorAll(".songItem")]
    .filter(el => pickedSongIds.has(el.dataset.id))
    .forEach(el => {
      const s = songs.find(x => x.id === el.dataset.id);
      if (s) currentPlaylist.items.push({ type: "song", songId: s.id, title: s.title });
    });
  clearPicked();
  renderPlaylistStrip();
  savePlaylistNow();
});
document.getElementById("btnClearPicked").addEventListener("click", clearPicked);

// ── Media: add the image/video currently open in the grid ──
document.getElementById("btnAddAnnToPlaylist").addEventListener("click", () => {
  const img = annImages[annSelectedIdx];
  if (!img) { appAlert(window.i18n.t("Спочатку оберіть картинку")); return; }
  ensurePlaylist();
  currentPlaylist.items.push({
    type: "announcement",
    text: "",
    imagePath: img.path,
    title: img.label || img.file,
  });
  renderPlaylistStrip();
  savePlaylistNow();
});

document.getElementById("btnExportSongFile").addEventListener("click", async () => {
  if (!currentSong?.id) { appAlert(window.i18n.t("Спочатку відкрийте або збережіть пісню")); return; }
  try { await window.songsApi.exportFile(currentSong.id); }
  catch (e) { appAlert(window.i18n.t("Не вдалося експортувати пісню:") + "\n" + describeError(e)); }
});
document.getElementById("btnImportSongFile").addEventListener("click", async () => {
  try {
    const res = await window.songsApi.importFile();
    const imported = Array.isArray(res) ? res : (res && res.songs) || [];
    const failed = (res && res.failed) || [];
    if (imported.length) {
      await refreshSongsList();
      await loadSong(imported[imported.length - 1].id);   // open what was just imported
    }
    const notes = [];
    if (imported.length > 1) notes.push(`${window.i18n.t("Імпортовано пісень:")} ${imported.length}`);
    if (failed.length) notes.push(window.i18n.t("Ці файли не є піснями Bible Presenter:") + "\n• " + failed.join("\n• "));
    if (notes.length) appAlert(notes.join("\n\n"));
  } catch (e) { appAlert(window.i18n.t("Не вдалося імпортувати пісню:") + "\n" + describeError(e)); }
});

// Playlist "⋯" overflow menu — export/import folded away so the row of
// header buttons doesn't keep growing every time a new capability is added.
{
  const pop = document.getElementById("playlistMorePop");
  const btn = document.getElementById("btnPlaylistMore");
  btn.addEventListener("click", (e) => { e.stopPropagation(); pop.style.display = pop.style.display === "block" ? "none" : "block"; });
  document.addEventListener("click", (e) => { if (!pop.contains(e.target) && e.target !== btn) pop.style.display = "none"; });
}
document.getElementById("btnExportPlaylistFile").addEventListener("click", async () => {
  if (!currentPlaylist?.id) { appAlert(window.i18n.t("Спочатку збережіть плейлист")); return; }
  document.getElementById("playlistMorePop").style.display = "none";
  try { await window.playlistsApi.exportFile(currentPlaylist.id); }
  catch (e) { appAlert(window.i18n.t("Не вдалося експортувати плейлист:") + "\n" + describeError(e)); }
});
document.getElementById("btnImportPlaylistFile").addEventListener("click", async () => {
  document.getElementById("playlistMorePop").style.display = "none";
  try {
    const p = await window.playlistsApi.importFile();
    if (p) {
      const { addedSongs = 0, missing = [], ...pl } = p;
      currentPlaylist = pl; await refreshPlaylistSelect(pl.id); renderPlaylistStrip();
      if (addedSongs) await refreshSongsList();
      const notes = [];
      if (addedSongs) notes.push(tf("Додано пісень у бібліотеку: {n}", { n: addedSongs }));
      if (missing.length) notes.push(window.i18n.t("Цих пунктів немає на цьому компʼютері:") + "\n• " + missing.join("\n• "));
      if (notes.length) appAlert(notes.join("\n\n"));
    }
  } catch (e) { appAlert(window.i18n.t("Не вдалося імпортувати плейлист:") + "\n" + describeError(e)); }
});

// ---- Show / hide the playlist strip (state remembered) ----
{
  const strip = document.getElementById("playlistStrip");
  const btn = document.getElementById("btnTogglePlaylist");
  function paint() {
    const hidden = strip.classList.contains("collapsed");
    btn.classList.toggle("flipped", hidden);
  }
  if (localStorage.getItem("playlistHidden") === "1") strip.classList.add("collapsed");
  paint();
  btn.addEventListener("click", () => {
    strip.classList.toggle("collapsed");
    localStorage.setItem("playlistHidden", strip.classList.contains("collapsed") ? "1" : "0");
    paint();
  });
}

// ---- Drag & drop for backgrounds and media ----
// Electron exposes real paths on dropped files, so we can copy them straight
// in without a file dialog. A page-wide guard stops a stray drop from
// navigating the window away, which would blank the control UI entirely.
{
  const droppedPaths = (e) => {
    const out = [];
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files) return out;
    for (const f of files) {
      // webUtils is the current API; f.path is the older one. Support both.
      const p = (window.fileApi && window.fileApi.pathFor) ? window.fileApi.pathFor(f) : f.path;
      if (p) out.push(p);
    }
    return out;
  };

  window.addEventListener("dragover", (e) => { e.preventDefault(); }, false);
  window.addEventListener("drop", (e) => { e.preventDefault(); }, false);

  function wireDropZone(el, onPaths) {
    if (!el) return;
    el.addEventListener("dragover", (e) => {
      e.preventDefault(); e.stopPropagation();
      el.classList.add("dropActive");
    });
    el.addEventListener("dragleave", (e) => {
      if (el.contains(e.relatedTarget)) return; // moving between children
      el.classList.remove("dropActive");
    });
    el.addEventListener("drop", async (e) => {
      e.preventDefault(); e.stopPropagation();
      el.classList.remove("dropActive");
      const paths = droppedPaths(e);
      if (paths.length) await onPaths(paths);
    });
  }

  window.__wireDropZone = wireDropZone; // reused by the strip and media view
}

// ---- Live-output indicator ----
// Green + pulsing while slides actually reach the broadcast; red when the
// server is off or the operator has blacked it out.
async function refreshStreamDot() {
  const dot = document.getElementById("streamDot");
  if (!dot) return;
  let running = false;
  try { running = !!(await window.webcastApi.status()).running; } catch (e) {}
  const live = running && !streamBlackout;
  dot.classList.toggle("live", live);
  const btn = document.getElementById("btnClearWebcast");
  if (btn) btn.classList.toggle("active", streamBlackout);
  dot.title = live ? window.i18n.t("Трансляція в ефірі")
                   : window.i18n.t("Трансляція не йде");
}
refreshStreamDot();
setInterval(refreshStreamDot, 4000);

// ---- Slide card size slider ----
{
  const sl = document.getElementById("slideSizeSlider");
  const apply = (v) => document.documentElement.style.setProperty("--slide-w", v + "px");
  const saved = Number(localStorage.getItem("slideWidth"));
  if (Number.isFinite(saved) && saved >= 120) sl.value = saved;
  apply(sl.value);
  sl.addEventListener("input", () => {
    apply(sl.value);
    localStorage.setItem("slideWidth", sl.value);
  });
}

// ---- Resizable bottom strip (drag its top edge) ----
{
  const strip = document.getElementById("playlistStrip");
  const handle = document.getElementById("stripResizer");
  const MIN = 90;
  const maxH = () => Math.round(window.innerHeight * 0.7);

  const saved = Number(localStorage.getItem("stripHeight"));
  if (Number.isFinite(saved) && saved >= MIN) {
    strip.style.height = Math.min(saved, maxH()) + "px";
  }

  // Prefer the measured height, but fall back to the inline/CSS value: a
  // zero measurement (hidden ancestor, no layout yet) would otherwise snap the
  // strip to its minimum on the very first drag.
  function currentHeight() {
    const measured = strip.getBoundingClientRect().height;
    if (measured > 0) return measured;
    const inline = parseFloat(strip.style.height);
    if (Number.isFinite(inline) && inline > 0) return inline;
    return 160;
  }

  let startY = 0, startH = 0, dragging = false;
  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    startY = e.clientY;
    startH = currentHeight();
    document.body.classList.add("resizingStrip");
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    // Dragging UP grows the strip, so the delta is inverted.
    const next = Math.max(MIN, Math.min(maxH(), startH + (startY - e.clientY)));
    strip.style.height = next + "px";
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizingStrip");
    localStorage.setItem("stripHeight", String(Math.round(currentHeight())));
  });
  // Keep a previously saved height legal if the window gets much shorter.
  window.addEventListener("resize", () => {
    if (strip.classList.contains("collapsed")) return;
    if (currentHeight() > maxH()) strip.style.height = maxH() + "px";
  });
}

// ---- Backgrounds strip: pick a live background during the service ----
// Mirrors ProPresenter's workflow: one click swaps the background under the
// text that is already on screen, without editing any theme.
{
  const strip = document.getElementById("playlistStrip");
  const tabPl = document.getElementById("stripTabPlaylist");
  const tabBg = document.getElementById("stripTabBackgrounds");
  const itemsEl = document.getElementById("playlistItems");
  const bgEl = document.getElementById("backgroundsStrip");
  const plControls = document.getElementById("playlistHeaderBtns");
  const plSelect = document.getElementById("playlistSelect");
  const toggleBtn = document.getElementById("btnTogglePlaylist");

  function setMode(mode) {
    const bg = mode === "backgrounds";
    tabPl.classList.toggle("active", !bg);
    tabBg.classList.toggle("active", bg);
    itemsEl.style.display = bg ? "none" : "";
    bgEl.style.display = bg ? "" : "none";
    // Playlist-only controls make no sense in background mode; the collapse
    // button stays because it applies to the whole strip.
    plSelect.style.display = bg ? "none" : "";
    [...plControls.children].forEach(el => {
      if (el !== toggleBtn) el.style.display = bg ? "none" : "";
    });
    if (bg) {
      strip.classList.remove("collapsed");
      localStorage.setItem("playlistHidden", "0");
      toggleBtn.classList.remove("flipped");
      renderBackgroundsStrip();
    }
    localStorage.setItem("stripMode", mode);
  }

  async function renderBackgroundsStrip() {
    // Every change of the live background ends up here — keep the preview in step.
    refreshPreviewBackground();
    let items = [];
    try { items = await window.systemApi.listBackgrounds(); } catch (e) { items = []; }
    const noneCard = `<div class="bgStripNone" id="bgStripClear">${esc(window.i18n.t("Без фону"))}</div>`;
    const addCard = `<div class="bgStripNone" id="bgStripAdd"><svg viewBox="0 0 24 24" class="ic ic-sm"><path d="M12 5.5v13M5.5 12h13"/></svg> ${esc(window.i18n.t("Додати"))}</div>`;
    bgEl.innerHTML = noneCard + items.map(i => `
      <div class="bgStripItem${liveBackground && liveBackground.file === i.file ? " active" : ""}"
           data-file="${esc(i.file)}" data-type="${esc(i.type)}" data-path="${esc(i.path)}" title="${esc(i.file)}">
        ${i.type === "video"
          ? `<video src="${esc(toFileUrl(i.path))}" muted playsinline preload="metadata" style="width:100%;height:100%;object-fit:cover"></video>
             <span class="bgStripTag"><svg viewBox="0 0 24 24" class="ic" style="width:10px;height:10px"><path d="M7 5.5 18.5 12 7 18.5z" fill="currentColor"/></svg></span>`
          : `<div style="width:100%;height:100%;background:url('${toFileUrl(i.path)}') center/cover no-repeat"></div>`}
        <button class="bgStripDel" data-del="${esc(i.file)}" title="${esc(window.i18n.t("Видалити фон"))}"><svg viewBox="0 0 24 24" class="ic"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button>
        <div class="bgStripLabel">${esc(i.file)}</div>
      </div>`).join("") + addCard;

    bgEl.querySelectorAll("[data-del]").forEach(btn => btn.addEventListener("click", async (e) => {
      e.stopPropagation(); // must not also select the background being deleted
      const file = btn.dataset.del;
      if (!(await appConfirm(window.i18n.t("Видалити цей фон?")))) return;
      await window.systemApi.deleteBackground(file);
      if (liveBackground && liveBackground.file === file) {
        // The deleted file is on screen right now — drop the override so the
        // projector doesn't keep pointing at a file that no longer exists.
        liveBackground = null;
        refreshPreviewBackground();
        if (lastShownPayload && screenVisible) {
          const p = { ...lastShownPayload };
          if (p.theme) { p.theme = { ...p.theme }; delete p.theme.bgUrl; delete p.theme.bgType; }
          showOnOutput(p);
        }
      }
      renderBackgroundsStrip();
    }));

    // Picking a background only moves the highlight. Rebuilding the strip
    // re-created every video thumbnail, and that disk and decode burst landed
    // exactly when the projector was starting the new clip.
    const markActive = () => bgEl.querySelectorAll(".bgStripItem").forEach(x =>
      x.classList.toggle("active", !!liveBackground && liveBackground.file === x.dataset.file));
    bgEl.querySelectorAll(".bgStripItem").forEach(el => el.addEventListener("click", (e) => {
      if (e.target.closest(".bgStripDel")) return;
      if (liveBackground && liveBackground.file === el.dataset.file) return;   // already on
      liveBackground = { file: el.dataset.file, type: el.dataset.type, path: el.dataset.path };
      markActive();
      refreshPreviewBackground();
      // Re-send the slide that is already up so the change is instant.
      if (lastShownPayload && screenVisible) showOnOutput({ ...lastShownPayload });
    }));
    document.getElementById("bgStripClear").addEventListener("click", () => {
      liveBackground = null;
      markActive();
      refreshPreviewBackground();
      if (lastShownPayload && screenVisible) {
        // Strip the override off the payload so the theme's own look returns.
        const p = { ...lastShownPayload };
        if (p.theme) { p.theme = { ...p.theme }; delete p.theme.bgUrl; delete p.theme.bgType; }
        showOnOutput(p);
      }
    });
    document.getElementById("bgStripAdd").addEventListener("click", async () => {
      try {
        const added = await window.systemApi.addBackgrounds();
        if (added && added.length) liveBackground = added[added.length - 1];
        refreshPreviewBackground();
        renderBackgroundsStrip();
        if (liveBackground && lastShownPayload && screenVisible) showOnOutput({ ...lastShownPayload });
      } catch (e) { appAlert(window.i18n.t("Не вдалося додати фон:") + "\n" + describeError(e)); }
    });
  }

  // Drop files straight onto the strip to add backgrounds.
  window.__wireDropZone(bgEl, async (paths) => {
    const added = await window.systemApi.addBackgroundPaths(paths);
    if (added && added.length) liveBackground = added[added.length - 1];
    refreshPreviewBackground();
    renderBackgroundsStrip();
    if (liveBackground && lastShownPayload && screenVisible) showOnOutput({ ...lastShownPayload });
  });

  tabPl.addEventListener("click", () => setMode("playlist"));
  tabBg.addEventListener("click", () => setMode("backgrounds"));
  setMode(localStorage.getItem("stripMode") === "backgrounds" ? "backgrounds" : "playlist");
}

document.getElementById("btnNewPlaylist").addEventListener("click", async () => {
  const name = await appPrompt(window.i18n.t("Назва плейлиста:"), `${window.i18n.t("Служіння")} ${new Date().toLocaleDateString()}`);
  if (!name) return;
  currentPlaylist = { id: null, name, items: [] };
  livePlIdx = -1;
  renderPlaylistStrip();
  savePlaylistNow();
});

// Auto-save: the playlist persists on every change (create/add/remove) so an
// operator never loses a service plan by forgetting to press «Зберегти».
async function savePlaylistNow() {
  if (!currentPlaylist || !currentPlaylist.name) return;
  try {
    const saved = await window.playlistsApi.save({ id: currentPlaylist.id, name: currentPlaylist.name, items: currentPlaylist.items });
    currentPlaylist.id = saved.id;
    localStorage.setItem("lastPlaylistId", saved.id);
    // Only refresh the dropdown. Passing the id would reload the playlist from
    // disk and reset the live entry every time an item is added or moved.
    await refreshPlaylistSelect();
  } catch (e) { console.warn("playlist autosave failed:", e); }
}

// Every change is saved on the spot, so there is no Save button; renaming and
// deleting sit in the "⋯" menu, out of the way of a live service.
document.getElementById("btnRenamePlaylist").addEventListener("click", async () => {
  document.getElementById("playlistMorePop").style.display = "none";
  if (!currentPlaylist) return;
  const name = await appPrompt(window.i18n.t("Назва плейлиста:"), currentPlaylist.name || "");
  if (name === null || !name.trim()) return;
  currentPlaylist.name = name.trim();
  await savePlaylistNow();
});

document.getElementById("btnDeletePlaylist").addEventListener("click", async () => {
  document.getElementById("playlistMorePop").style.display = "none";
  if (!currentPlaylist?.id) return;
  if (!(await appConfirm(tf("Видалити «{name}»?", { name: currentPlaylist.name })))) return;
  await window.playlistsApi.delete(currentPlaylist.id);
  if (localStorage.getItem("lastPlaylistId") === currentPlaylist.id) localStorage.removeItem("lastPlaylistId");
  currentPlaylist = null;
  await refreshPlaylistSelect();
  renderPlaylistStrip();
});

playlistSelect.addEventListener("change", () => { if (playlistSelect.value) loadPlaylist(playlistSelect.value); });

(async () => {
  await refreshPlaylistSelect();
  // Session restore: reopen the playlist that was active last time.
  const last = localStorage.getItem("lastPlaylistId");
  if (last && [...playlistSelect.options].some(o => o.value === last)) {
    playlistSelect.value = last;
    loadPlaylist(last);
  }
})();

// ---- Webcast (vMix / OBS) ----
{
  const overlay = document.getElementById("webcastOverlay");
  const portEl = document.getElementById("webcastPort");
  const toggleBtn = document.getElementById("btnToggleWebcast");
  const info = document.getElementById("webcastInfo");
  const urlsEl = document.getElementById("webcastUrls");
  const clientsEl = document.getElementById("webcastClients");
  const topBtn = document.getElementById("btnOpenWebcast");

  portEl.value = localStorage.getItem("webcastPort") || 7777;

  function paint(st) {
    const on = st && st.running;
    toggleBtn.textContent = window.i18n.t(on ? "Вимкнути" : "Увімкнути");
    toggleBtn.classList.toggle("primary", !on);
    toggleBtn.classList.toggle("danger", !!on);
    topBtn.style.color = on ? "var(--green)" : "";
    // .textContent would also wipe the button's SVG icon — reuse the text
    // node the button already has (applyI18n() translates it once at
    // startup) rather than creating a second one that duplicates the label.
    // A separate dot element carries the "live" state instead of folding a
    // decoration into the translatable string.
    let topTextNode = [...topBtn.childNodes].find(n => n.nodeType === 3 && n.nodeValue.trim());
    if (!topTextNode) {
      topTextNode = document.createTextNode("");
      topBtn.appendChild(topTextNode);
    }
    topTextNode.nodeValue = " " + window.i18n.t("Трансляція");
    let topDot = topBtn.querySelector(".topBtnDot");
    if (!topDot) {
      topDot = document.createElement("span");
      topDot.className = "topBtnDot";
      topBtn.appendChild(topDot);
    }
    topDot.style.display = on ? "inline-block" : "none";
    info.style.display = on ? "block" : "none";
    if (!on) {
      const stageBox = document.getElementById("stageUrlBox");
      if (stageBox) stageBox.textContent = window.i18n.t("Увімкніть трансляцію, щоб отримати адресу");
    }
    if (on) {
      const list = (st.ips.length ? st.ips : ["localhost"]).map(ip => `http://${ip}:${st.port}/`);
      urlsEl.innerHTML = list.map(u => esc(u)).join("<br>");
      // Same server, second page — nothing extra to install on stage.
      const stageBox = document.getElementById("stageUrlBox");
      if (stageBox) {
        stageBox.innerHTML = list.map(u => esc(u + "stage")).join("<br>");
      }
      clientsEl.textContent = (st.clients ? `${window.i18n.t("Підключено джерел:")} ${st.clients}` : window.i18n.t("Очікую підключення vMix…"))
        + (st.stageClients ? ` · ${window.i18n.t("Сценічних екранів:")} ${st.stageClients}` : "");
    }
  }

  async function refresh() { paint(await window.webcastApi.status()); }

  // ---- Stream themes: separate looks for songs and Bible verses ----
  const S = (id) => document.getElementById(id);
  const styleIds = ["wcOwn","wcFont","wcSize","wcSpacing","wcLine","wcColor","wcBold","wcUpper","wcShadow",
                    "wcScale","wcShadowStrength","wcOutlineWidth","wcOutlineColor","wcBars","wcBarMode","wcBarFull","wcAlign","wcBarColor","wcBarOpacity","wcBarPadding",
                    "wcPosition","wcPageBg","wcOffsetY","wcOffsetX","wcJoin","wcShowRef","wcRefSeparate","wcRefBg","wcRefColor","wcRefAlign","wcRefBold","wcRefPosition","wcRefSize","wcBarRadius","wcBarInset"];
  const DEF_SONG = { useOwnTheme:true, fontFamily:"Segoe UI", fontSize:46, color:"#ffffff", bold:true, uppercase:true,
    shadow:false, shadowStrength:55, outlineWidth:0, outlineColor:"#000000", letterSpacing:0, lineHeight:1.25, scale:45, align:"center", position:"bottom", joinLines:false,
    showRef:true, bars:true, barMode:"perline", barFullWidth:false, barColor:"#000000", barOpacity:0.8, barPadding:0.35,
    refSeparate:false, refBgColor:"#ffffff", refColor:"#000000", refAlign:"right", refBold:true, refPosition:"below", refSize:0.62, barRadius:0, barInset:0, offsetY:0, offsetX:0,
    pageBg:"transparent", pageBgColor:"#000000" };
  const DEF_BIBLE = { ...DEF_SONG, fontSize:34, bold:false, uppercase:false, lineHeight:1.35, align:"left",
    joinLines:true, barMode:"block", barFullWidth:true, barOpacity:0.8, barPadding:0.5, refSeparate:true };
  let styles = { song: { ...DEF_SONG }, bible: { ...DEF_BIBLE } };
  let target = "song";

  function readEditor() {
    return {
      useOwnTheme: S("wcOwn").checked,
      fontFamily: resolveFontFamily(S("wcFont").value) || "Segoe UI",
      fontSize: Number(S("wcSize").value) || 46,
      letterSpacing: Number(S("wcSpacing").value) / 100,
      lineHeight: Number(S("wcLine").value) / 100,
      color: S("wcColor").value,
      bold: S("wcBold").checked,
      uppercase: S("wcUpper").checked,
      shadow: S("wcShadow").checked,
      shadowStrength: Number(S("wcShadowStrength").value),
      outlineWidth: Number(S("wcOutlineWidth").value),
      outlineColor: S("wcOutlineColor").value,
      scale: Number(S("wcScale").value) || 45,
      align: S("wcAlign").value,
      bars: S("wcBars").checked,
      barMode: S("wcBarMode").value,
      barFullWidth: S("wcBarFull").checked,
      barColor: S("wcBarColor").value,
      barOpacity: Number(S("wcBarOpacity").value) / 100,
      barPadding: Number(S("wcBarPadding").value) / 100,
      position: S("wcPosition").value,
      pageBg: S("wcPageBg").value,
      offsetY: Number(S("wcOffsetY").value),
      offsetX: Number(S("wcOffsetX").value),
      pageBgColor: styles[target].pageBgColor || "#000000",
      joinLines: S("wcJoin").checked,
      showRef: S("wcShowRef").checked,
      refSeparate: S("wcRefSeparate").checked,
      refBgColor: S("wcRefBg").value,
      refColor: S("wcRefColor").value,
      refAlign: S("wcRefAlign").value,
      refBold: S("wcRefBold").checked,
      refPosition: S("wcRefPosition").value,
      refSize: Number(S("wcRefSize").value)/100,
      barRadius: Number(S("wcBarRadius").value),
      barInset: Number(S("wcBarInset").value),
    };
  }

  function writeEditor(st) {
    S("wcOwn").checked = !!st.useOwnTheme;
    if ([...S("wcFont").options].some(o => o.value === st.fontFamily)) S("wcFont").value = st.fontFamily;
    S("wcSize").value = st.fontSize; S("wcSpacing").value = Math.round((st.letterSpacing || 0) * 100);
    S("wcLine").value = Math.round((st.lineHeight || 1.25) * 100);
    S("wcColor").value = st.color; S("wcBold").checked = !!st.bold; S("wcUpper").checked = !!st.uppercase;
    S("wcShadow").checked = !!st.shadow;
    S("wcShadowStrength").value = st.shadowStrength ?? 55;
    S("wcOutlineWidth").value = st.outlineWidth ?? 0;
    S("wcOutlineColor").value = st.outlineColor || "#000000"; S("wcScale").value = st.scale; S("wcAlign").value = st.align || "center";
    S("wcBars").checked = !!st.bars; S("wcBarMode").value = st.barMode || "perline";
    S("wcBarFull").checked = !!st.barFullWidth;
    S("wcBarColor").value = st.barColor; S("wcBarOpacity").value = Math.round((st.barOpacity || 0) * 100);
    S("wcBarPadding").value = Math.round((st.barPadding || 0) * 100);
    S("wcPosition").value = st.position; S("wcPageBg").value = st.pageBg;
    S("wcOffsetY").value = st.offsetY ?? 0; S("wcOffsetX").value = st.offsetX ?? 0;
    S("wcJoin").checked = !!st.joinLines; S("wcShowRef").checked = st.showRef !== false;
    S("wcRefSeparate").checked = !!st.refSeparate; S("wcRefBg").value = st.refBgColor || "#e9e9e9";
    S("wcRefColor").value = st.refColor || "#111111"; S("wcRefAlign").value = st.refAlign || "right";
    S("wcRefBold").checked = st.refBold !== false;
    S("wcRefPosition").value = st.refPosition || "below";
    S("wcRefSize").value = Math.round((st.refSize ?? 0.62)*100);
    S("wcBarRadius").value = st.barRadius ?? 0;
    S("wcBarInset").value = st.barInset ?? 0;
  }

  function paintPreview(st) {
    S("wcSizeVal").textContent = st.fontSize;
    S("wcSpacingVal").textContent = st.letterSpacing.toFixed(2);
    S("wcLineVal").textContent = st.lineHeight.toFixed(2);
    S("wcScaleVal").textContent = st.scale;
    S("wcBarOpVal").textContent = st.barOpacity.toFixed(2);
    S("wcBarPadVal").textContent = st.barPadding.toFixed(2);
    S("wcRefSizeVal").textContent = (st.refSize ?? 0.62).toFixed(2);
    S("wcBarRadiusVal").textContent = st.barRadius ?? 0;
    S("wcBarInsetVal").textContent = st.barInset ?? 0;
    S("wcOffsetYVal").textContent = st.offsetY ?? 0;
    S("wcOffsetXVal").textContent = st.offsetX ?? 0;
    S("wcOwnBlock").style.display = st.useOwnTheme ? "" : "none";
    S("wcScaleBlock").style.display = st.useOwnTheme ? "none" : "";
    S("wcShadowVal").textContent = st.shadowStrength ?? 55;
    S("wcOutlineVal").textContent = st.outlineWidth ?? 0;
    S("wcShadowBlock").style.display = st.shadow ? "" : "none";
    S("wcBarsBlock").style.display = st.bars ? "flex" : "none";
    S("wcBarsBlock2").style.display = st.bars ? "flex" : "none";
    S("wcRefBlock").style.display = st.refSeparate ? "flex" : "none";
    S("wcTargetSong").classList.toggle("primary", target === "song");
    S("wcTargetBible").classList.toggle("primary", target === "bible");

    const box = S("wcPreview");
    box.style.justifyContent = st.position === "bottom" ? "flex-end" : st.position === "top" ? "flex-start" : "center";
    const host = S("wcPreviewText");
    host.style.transform = `translate(${(st.offsetX||0)*0.35}px, ${(st.offsetY||0)*0.6}px)`;
    host.innerHTML = "";
    host.style.textAlign = st.align || "center";
    host.style.width = "100%";
    const hex = String(st.barColor).replace("#", "");
    const n = parseInt(hex.length === 3 ? hex.split("").map(c=>c+c).join("") : hex, 16);
    const rgba = `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${st.barOpacity})`;
    const isBible = target === "bible";
    const lines = isBible
      ? (st.joinLines ? [window.i18n.t("Усяке тіло — трава, і вся його чарівність, як квітка польова.")]
                      : [window.i18n.t("Усяке тіло — трава,"), window.i18n.t("і вся його чарівність.")])
      : (st.joinLines ? [window.i18n.t("Влади не має смерть, наш Бог Ісус воскрес.")]
                      : [window.i18n.t("Влади не має смерть,"), window.i18n.t("наш Бог Ісус воскрес.")]);
    const fs = Math.max(9, (st.useOwnTheme ? st.fontSize : 46) * 0.22);
    const styleLine = (el) => {
      el.style.fontFamily = `"${st.useOwnTheme ? st.fontFamily : "Segoe UI"}", sans-serif`;
      el.style.fontSize = fs + "px";
      el.style.color = st.color;
      el.style.fontWeight = st.bold ? "700" : "400";
      el.style.textTransform = st.uppercase ? "uppercase" : "none";
      el.style.letterSpacing = st.letterSpacing + "em";
      el.style.lineHeight = String(st.lineHeight);
      const ss = Math.max(0, Math.min(100, Number(st.shadowStrength ?? 55)));
      const bl = ss*0.30*0.28, of = ss*0.06*0.28, op = (0.25+ss*0.0070).toFixed(2);
      el.style.textShadow = st.shadow
        ? `0 ${of.toFixed(1)}px ${(bl*0.45).toFixed(1)}px rgba(0,0,0,${op}), 0 0 ${bl.toFixed(1)}px rgba(0,0,0,${op})`
        : "none";
      if (st.outlineWidth) {
        el.style.webkitTextStroke = (st.outlineWidth*0.28).toFixed(2) + "px " + (st.outlineColor||"#000");
        el.style.paintOrder = "stroke fill";
      } else el.style.webkitTextStroke = "";
    };
    if (st.bars && st.barMode === "block") {
      const block = document.createElement("div");
      block.style.display = st.barFullWidth ? "block" : "inline-block";
      if (st.barFullWidth) { block.style.width = "100%"; block.style.boxSizing = "border-box"; }
      block.style.background = rgba;
      block.style.padding = st.barPadding + "em " + (st.barPadding*1.6) + "em";
      block.style.borderRadius = (st.barRadius||0)*0.28 + "px";
      block.style.textAlign = st.align || "center";
      lines.forEach(ln => { const d = document.createElement("div"); d.textContent = ln; styleLine(d); block.appendChild(d); });
      host.appendChild(block);
    } else {
      lines.forEach((ln, i) => {
        const wrap = document.createElement("div");
        const span = document.createElement("span");
        span.textContent = ln; span.style.display = "inline-block"; styleLine(span);
        if (st.bars) { span.style.background = rgba; span.style.padding = st.barPadding + "em " + (st.barPadding*1.6) + "em"; span.style.borderRadius = (st.barRadius||0)*0.28 + "px"; }
        if (i > 0) wrap.style.marginTop = (st.bars ? 0.18 : 0) + "em";
        wrap.appendChild(span); host.appendChild(wrap);
      });
    }
    if (isBible && st.showRef !== false) {
      const refWrap = document.createElement("div");
      refWrap.style.textAlign = st.refSeparate ? (st.refAlign || "right") : (st.align || "center");
      refWrap.style.marginTop = "4px";
      const r = document.createElement("span");
      r.textContent = window.i18n.t("Ісаї 40:6-8");
      r.style.display = "inline-block";
      r.style.fontSize = (fs * (st.refSize ?? 0.62)) + "px";
      r.style.fontFamily = `"${st.useOwnTheme ? st.fontFamily : "Segoe UI"}", sans-serif`;
      if (st.refSeparate) {
        r.style.background = st.refBgColor; r.style.color = st.refColor;
        r.style.fontWeight = st.refBold ? "700" : "400";
        r.style.padding = st.barPadding + "em " + (st.barPadding*1.8) + "em";
        r.style.borderRadius = (st.barRadius||0)*0.28 + "px";
      } else { r.style.background = st.bars ? rgba : "none"; r.style.color = st.color; }
      refWrap.appendChild(r);
      if (st.refPosition === "above") host.insertBefore(refWrap, host.firstChild); else host.appendChild(refWrap);
    }
  }

  async function pushStyle() {
    styles[target] = readEditor();
    // Settings survive an uninstall, so a font name saved by an older build can
    // still be sitting here. Resolve both targets on every push, not just the
    // one being edited — otherwise the stream keeps rendering the wrong face.
    for (const k of ["song", "bible"]) {
      if (styles[k] && styles[k].fontFamily) styles[k].fontFamily = resolveFontFamily(styles[k].fontFamily);
    }
    // Say it plainly when the chosen font cannot actually be drawn — silently
    // rendering a different typeface is worse than an honest warning.
    const warn = S("wcFontWarn");
    // Judge by the list scanned from the actual font FILES on this machine —
    // that is authoritative, unlike the canvas probe which can misreport.
    const installed = (() => { try { return allFonts(); } catch (e) { return []; } })();
    if (warn && installed.length) {
      const f = styles[target].fontFamily;
      const squash = (v) => String(v).toLowerCase().replace(/[^a-z0-9]/g, "");
      const ok = !f || installed.some((x) => squash(x) === squash(f));
      warn.style.display = ok ? "none" : "block";
      if (!ok) warn.textContent = "⚠ " + window.i18n.t("Шрифт не встановлено на цьому компʼютері — трансляція покаже запасний:") + " " + f;
    }
    paintPreview(styles[target]);
    localStorage.setItem("webcastStyles", JSON.stringify(styles));
    await window.webcastApi.setStyle(styles); // live — connected vMix updates at once
  }

  function switchTarget(t) {
    styles[target] = readEditor();   // keep edits of the current target
    target = t;
    writeEditor(styles[target]);
    paintPreview(styles[target]);
    refreshThemeList();
  }
  S("wcTargetSong").addEventListener("click", () => switchTarget("song"));
  S("wcTargetBible").addEventListener("click", () => switchTarget("bible"));

  async function loadStyle() {
    const sel = S("wcFont");
    if (!sel.options.length) {
      await loadSystemFonts();
      sel.innerHTML = allFonts().map(f => `<option value="${esc(f)}" style="font-family:'${esc(f)}'">${esc(f)}</option>`).join("");
    }
    try {
      const saved = JSON.parse(localStorage.getItem("webcastStyles") || "null");
      if (saved && saved.song && saved.bible) {
        styles = { song: { ...DEF_SONG, ...saved.song }, bible: { ...DEF_BIBLE, ...saved.bible } };
        for (const k of ["song", "bible"]) {
          if (styles[k].fontFamily) styles[k].fontFamily = resolveFontFamily(styles[k].fontFamily);
        }
      }
    } catch (e) {}
    writeEditor(styles[target]);
    paintPreview(styles[target]);
    await window.webcastApi.setStyle(styles);
  }


  // ---- Saved theme library for the live output (import/export + presets) ----
  const themeSel = S("wcThemeSelect");
  function selKey() { return "streamThemeSel:" + target; }

  async function refreshThemeList(selectId) {
    const all = await window.webcastApi.listThemes();
    const forTarget = all.filter(t => t.target === target);
    themeSel.innerHTML = `<option value="">${esc(window.i18n.t("— без збереженої теми —"))}</option>` +
      forTarget.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
    // Restore the previously chosen theme so the panel reopens where it was.
    const want = selectId || localStorage.getItem(selKey()) || "";
    if (want && forTarget.some(t => t.id === want)) themeSel.value = want;
    if (selectId) localStorage.setItem(selKey(), selectId);
  }
  async function applyLoadedTheme(data) {
    if (!data) return;
    styles[target] = { ...styles[target], ...data };
    if (styles[target].fontFamily) styles[target].fontFamily = resolveFontFamily(styles[target].fontFamily);
    delete styles[target].id; delete styles[target].name; delete styles[target].target;
    writeEditor(styles[target]);
    await pushStyle();
  }
  themeSel.addEventListener("change", async () => {
    localStorage.setItem(selKey(), themeSel.value || "");
    if (!themeSel.value) return;
    const data = await window.webcastApi.getTheme(themeSel.value);
    await applyLoadedTheme(data);
  });
  S("wcThemeSave").addEventListener("click", async () => {
    const current = themeSel.value ? await window.webcastApi.getTheme(themeSel.value) : null;
    const name = await appPrompt(window.i18n.t("Назва теми:"), (current && current.name) || "");
    if (name === null || !name.trim()) return;
    const payload = { ...readEditor(), id: current && current.name === name.trim() ? current.id : undefined,
      name: name.trim(), target };
    const saved = await window.webcastApi.saveTheme(payload);
    await refreshThemeList(saved.id);
    localStorage.setItem(selKey(), saved.id);
  });
  S("wcThemeDelete").addEventListener("click", async () => {
    if (!themeSel.value) {
      appAlert(window.i18n.t("Спочатку оберіть збережену тему у списку."));
      return;
    }
    const label = themeSel.options[themeSel.selectedIndex].textContent;
    if (!(await appConfirm(window.i18n.t("Видалити тему") + ` "${label}"?`))) return;
    await window.webcastApi.deleteTheme(themeSel.value);
    localStorage.removeItem(selKey());
    await refreshThemeList();
  });
  S("wcThemeReset").addEventListener("click", async () => {
    // Back to the built-in black & white look for the current target.
    styles[target] = { ...(target === "bible" ? DEF_BIBLE : DEF_SONG) };
    writeEditor(styles[target]);
    themeSel.value = "";
    await pushStyle();
  });

  S("wcThemeImport").addEventListener("click", async () => {
    try {
      const data = await window.webcastApi.importThemeFile();
      if (!data) return;
      if (data.target && data.target !== target) {
        // The imported file targets the other type — switch to it so the
        // operator immediately sees where it landed. switchTarget kicks off its
        // own list refresh, so await ours afterwards to keep the selection.
        switchTarget(data.target);
        await new Promise(r => setTimeout(r, 0));
      }
      await refreshThemeList(data.id);
      await applyLoadedTheme(data);
    } catch (e) {
      appAlert(window.i18n.t("Не вдалося імпортувати тему:") + "\n" + describeError(e));
    }
  });
  S("wcThemeExport").addEventListener("click", async () => {
    // Ask for a real name instead of baking in a placeholder — a generic name
    // made every re-imported theme look identical.
    const current = themeSel.value ? themeSel.options[themeSel.selectedIndex].textContent : "";
    const name = await appPrompt(window.i18n.t("Назва теми:"), current);
    if (name === null || !name.trim()) return;
    const payload = { ...readEditor(), name: name.trim(), target };
    try { await window.webcastApi.exportThemeFile(payload); }
    catch (e) { appAlert(window.i18n.t("Не вдалося експортувати тему:") + "\n" + describeError(e)); }
  });

  styleIds.forEach(id => {
    const el = S(id);
    el.addEventListener("input", pushStyle);
    el.addEventListener("change", pushStyle);
  });
  loadStyle();
  refreshThemeList();

  topBtn.addEventListener("click", async () => {
    await refresh();
    await refreshThemeList();      // pick up themes imported since last open
    overlay.style.display = "flex";
  });
  document.getElementById("btnCloseWebcast").addEventListener("click", () => { overlay.style.display = "none"; });

  // A ProPresenter theme describes TEXT styling, which is exactly what the
  // lower-third needs too — so the same file can dress the broadcast, not just
  // the projector. Fields the stream has no equivalent for are ignored.
  document.getElementById("wcThemeImportPro").addEventListener("click", async () => {
    try {
      const t = await window.themesApi.importProTheme();
      if (!t) return;
      const cur = styles[target] || {};
      styles[target] = {
        ...cur,
        fontFamily: resolveFontFamily(t.fontFamily) || cur.fontFamily,
        fontSize: t.fontSize || cur.fontSize,
        color: t.color || cur.color,
        uppercase: !!t.uppercase,
        bold: !!t.bold,
        italic: !!t.italic,
        letterSpacing: t.letterSpacing ?? cur.letterSpacing,
        lineHeight: t.lineHeight ?? cur.lineHeight,
        shadow: t.shadow !== false,
        outline: !!t.outline,
        outlineColor: t.outlineColor || cur.outlineColor,
        outlineWidth: t.outlineWidth ?? cur.outlineWidth,
        align: t.align || cur.align,
      };
      writeEditor(styles[target]);
      await pushStyle();
    } catch (e) {
      appAlert(window.i18n.t("Не вдалося імпортувати тему:") + "\n" + describeError(e));
    }
  });

  // ---- Stage display settings ----
  {
    const push = async () => {
      const cfg = {
        layout: S("stageLayout").value,
        clock: S("stageClock").checked,
        timer: S("stageTimer").checked,
        ampm: S("stageAmPm").checked,
        scale: Number(S("stageScale").value) / 100,
      };
      S("stageScaleVal").textContent = S("stageScale").value;
      localStorage.setItem("stageCfg", JSON.stringify(cfg));
      try { await window.webcastApi.setStage(cfg); } catch (e) {}
    };
    try {
      const saved = JSON.parse(localStorage.getItem("stageCfg") || "null");
      if (saved) {
        S("stageLayout").value = saved.layout || "current-next";
        S("stageClock").checked = saved.clock !== false;
        S("stageTimer").checked = saved.timer !== false;
        S("stageAmPm").checked = !!saved.ampm;
        S("stageScale").value = Math.round((saved.scale || 1) * 100);
        S("stageScaleVal").textContent = S("stageScale").value;
      }
    } catch (e) {}
    ["stageLayout", "stageClock", "stageTimer", "stageAmPm", "stageScale"].forEach(id =>
      S(id).addEventListener("input", push));
    S("btnStageTimerReset")?.addEventListener("click", (e) => {
      e.preventDefault();            // the button sits inside the checkbox label
      window.webcastApi.resetStageTimer();
    });
    push();
  }

  document.getElementById("btnClearWebcast").addEventListener("click", async () => {
    const btn = document.getElementById("btnClearWebcast");
    streamBlackout = !streamBlackout;
    btn.classList.toggle("active", streamBlackout);
    btn.title = window.i18n.t(streamBlackout
      ? "Трансляція очищена — натисніть, щоб повернути"
      : "Очистити тільки трансляцію, не чіпаючи проектор");
    // The main process holds the latch, so slides advanced while blacked out
    // never leak into the broadcast.
    await window.webcastApi.setBlackout(streamBlackout);
    refreshStreamDot();
  });

  toggleBtn.addEventListener("click", async () => {
    const st = await window.webcastApi.status();
    if (st.running) {
      await window.webcastApi.stop();
      localStorage.setItem("webcastOn", "0");
    } else {
      const port = Number(portEl.value) || 7777;
      const r = await window.webcastApi.start(port);
      if (!r.ok) { appAlert(window.i18n.t("Не вдалося запустити трансляцію:")+"\n" + r.error); return; }
      localStorage.setItem("webcastPort", String(port));
      localStorage.setItem("webcastOn", "1");
      await pushStyle(); // apply the saved stream look to the fresh server
    }
    await refresh();
  });

  // Keep the connected-source counter fresh while the panel is open.
  setInterval(() => { if (overlay.style.display === "flex") refresh(); }, 2000);

  // Auto-start if it was on last session (service continuity).
  (async () => {
    if (localStorage.getItem("webcastOn") === "1") {
      await window.webcastApi.start(Number(portEl.value) || 7777);
      await pushStyle();
    }
    refresh();
  })();
}

// ════════════════════════════════════════════════════════════
//  CLICKER / playback navigation
// ════════════════════════════════════════════════════════════
let playbackQueue = null, playbackIndex = -1;

// Moves the live Bible position to the neighbouring chapter (crossing into the
// next or previous book when needed). Returns false at the very start of
// Genesis or the very end of Revelation.
async function stepBibleChapter(delta) {
  let book = currentBook, chapter = currentChapter + delta;
  const bi = books.findIndex(b => b.osis === currentBook.osis);
  if (chapter < 1) {
    if (bi <= 0) return false;
    book = books[bi - 1]; chapter = book.chapterCount;
  } else if (chapter > currentBook.chapterCount) {
    if (bi < 0 || bi >= books.length - 1) return false;
    book = books[bi + 1]; chapter = 1;
  }
  const count = await window.bibleApi.getChapterVerseCount(currentTranslationId, book.osis, chapter);
  if (!count) return false;
  currentBook = book;
  currentChapter = chapter;
  currentVerse = delta > 0 ? 1 : count;
  playbackQueue = { type: "bible", count };
  playbackIndex = currentVerse - 1;
  renderBookList(bookSearch.value);
  renderChapters();
  return true;
}

async function clickerStep(dir) {
  if (!playbackQueue) return;
  // A queue armed from the playlist starts at -1 ("first Next shows slide 0").
  // The old guard rejected that state, so the remote appeared dead until the
  // operator clicked a slide card manually.
  if (playbackIndex < 0 && dir !== "next") return;
  if (playbackQueue.armed && dir !== "next") return;
  const delta = dir === "next" ? 1 : -1;
  if (playbackQueue.type === "plMedia") {
    if (dir !== "next") return;
    if (playbackIndex < 0) { playbackIndex = 0; showPlaylistMedia(playbackQueue.item); }
    else await advancePlaylist();
    return;
  }
  if (playbackQueue.type === "bible" && playbackQueue.armed) {
    // First Next after picking a verse entry in the playlist: show that verse.
    playbackQueue.armed = false;
    if (!currentBook || !currentTranslationId) return;
    const v = await window.bibleApi.getVerse(currentTranslationId, currentBook.osis, currentChapter, currentVerse, window.i18n.getLang());
    if (v) { previewText.textContent = v.text; showOnOutput({ text: v.text, reference: buildVerseRef(v), theme: bibleTheme }); }
    return;
  }
  if (playbackQueue.type === "bible") {
    // The active translation can be deleted while a verse is live; without
    // this the remote would crash the control window mid-service.
    if (!currentBook || !currentTranslationId) return;
    const ni = playbackIndex + delta;
    if (ni < 0 || ni >= playbackQueue.count) {
      // Reading on: past the last verse go to the next chapter (or book),
      // before the first verse go back to the end of the previous one.
      const moved = await stepBibleChapter(delta);
      if (!moved) return;
    } else {
      playbackIndex = ni;
      currentVerse = ni + 1;
    }
    verseList.querySelectorAll(".verseRow").forEach(e => e.classList.toggle("active", Number(e.dataset.v) === currentVerse));
    const v = await window.bibleApi.getVerse(currentTranslationId, currentBook.osis, currentChapter, currentVerse, window.i18n.getLang());
    if (v) { previewText.textContent = v.text; showOnOutput({ text: v.text, reference: buildVerseRef(v), theme: bibleTheme }); }
  } else if (playbackQueue.type === "song") {
    const ni = playbackIndex + delta;
    if (ni >= playbackQueue.slides.length && playbackQueue.fromPlaylist) { await advancePlaylist(); return; }
    if (ni < 0 || ni >= playbackQueue.slides.length) return;
    playbackIndex = ni;
    const item = playbackQueue.slides[ni];
    liveSongKey = item.key;
    sectionsContainer.querySelectorAll(".slideCard").forEach(c => c.classList.toggle("live", c.dataset.key === liveSongKey));
    showOnOutput({ text: item.text, theme: songTheme });
  } else if (playbackQueue.type === "pres") {
    const ni = playbackIndex + delta;
    if (ni >= playbackQueue.slides.length && playbackQueue.fromPlaylist) { await advancePlaylist(); return; }
    if (ni < 0 || ni >= playbackQueue.slides.length) return;
    playbackIndex = ni;
    const slide = playbackQueue.slides[ni];
    const grid = document.getElementById("presSlideGrid");
    grid.querySelectorAll(".slideCard").forEach(c => c.classList.toggle("live", Number(c.dataset.idx) === ni));
    showOnOutput({ text: slide.text || "", image: slide.imagePath ? toFileUrl(slide.imagePath) : null });
  } else if (playbackQueue.type === "ann") {
    const ni = playbackIndex + delta;
    if (ni < 0 || ni >= annImages.length) return;
    playbackIndex = ni;
    const grid = document.getElementById("annSlideGrid");
    grid.querySelectorAll(".slideCard").forEach(c => c.classList.toggle("live", Number(c.dataset.idx) === ni));
    const it = annImages[ni];
    showOnOutput(isVideoFile(it.file) ? { text: "", video: toFileUrl(it.path) } : { text: "", image: toFileUrl(it.path) });
  }
}

window.clickerApi.onNav(dir => {
  if (dir === "next" || dir === "prev") clickerStep(dir);
  else toggleScreen(dir); // "show" | "hide" | "toggle"
});

// Topmost first: a question can sit over the theme editor, the background
// picker over the theme editor, and so on.
const OVERLAY_CLOSERS = [
  ["dlgOverlay", "dlgCancel"], ["bgPickerOverlay", "btnCloseBgPicker"], ["themeOverlay", "btnCancelTheme"],
  ["remoteOverlay", "btnCloseRemote"],
  ["themesManagerOverlay", "btnCloseThemes"], ["pasteSongOverlay", "btnClosePasteSong"],
  ["bibleStoreOverlay", "btnCloseBibleStore"], ["webcastOverlay", "btnCloseWebcast"],
];

// Robust in-window navigation: arrows / PageUp-Down / Space advance slides,
// F5 = show, Esc = hide, "b" / "." = blank toggle (R400-style presenter pult),
// EXCEPT while typing in an input/textarea/select (so editing still works).
document.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
  const typing = tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable;
  if (typing) return;
  // A dialog is open: Esc closes IT (and Enter confirms a question). It must
  // never blank the projector or step slides hidden behind the dialog.
  const open = OVERLAY_CLOSERS.find(([ov]) => {
    const el = document.getElementById(ov);
    return el && el.style.display && el.style.display !== "none";
  });
  if (open) {
    if (e.key === "Escape") { e.preventDefault(); document.getElementById(open[1])?.click(); }
    else if (e.key === "Enter" && open[0] === "dlgOverlay") { e.preventDefault(); document.getElementById("dlgOk")?.click(); }
    return;
  }
  const pop = document.getElementById("settingsPop");
  if (e.key === "Escape" && pop && pop.classList.contains("open")) { pop.classList.remove("open"); e.preventDefault(); return; }
  if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(e.key)) {
    e.preventDefault();
    clickerStep("next");
  } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) {
    e.preventDefault();
    clickerStep("prev");
  } else if (e.key === "F5") {
    e.preventDefault();
    toggleScreen("show");
  } else if (e.key === "Escape") {
    e.preventDefault();
    toggleScreen("hide");
  } else if (["b", "B", ".", "w", "W"].includes(e.key)) {
    e.preventDefault();
    toggleScreen("toggle");
  }
});

// ════════════════════════════════════════════════════════════
//  PHONE REMOTE
//  The phone page (served by the main process) sends commands that land here,
//  where the playback state lives, and gets back what it should show: what is
//  on screen, what comes next, the slides of the current item and the service
//  plan. Only changes are sent; the slide list only when it actually changes.
// ════════════════════════════════════════════════════════════
const REMOTE_UI_KEYS = [
  "Пульт", "Слайди", "Служіння", "Прибрати текст", "Назад", "Далі", "Наступний:",
  "Введіть PIN-код, показаний у програмі", "Увійти", "Немає зв'язку з програмою. Перепідключення…",
  "Невірний PIN-код", "Забагато спроб. Зачекайте хвилину.", "На екрані", "Екран вимкнено",
  "Відео на екрані", "Зображення на екрані", "Наготові — натисніть «Далі»", "Сховати екран", "Показати екран",
  "— оберіть служіння —", "Нічого не вибрано. Оберіть пункт служіння або слайд у програмі.",
  "(порожній екран)", "Служіння порожнє", "Презентації", "Пошук презентації…",
  "Презентацій поки немає. Імпортуйте їх у програмі на комп'ютері.", "Без збірки", "Нічого не знайдено",
];
// `var`: remoteSync() can be reached while this file is still loading.
var remoteSyncPending = false, remoteSentSig = null, remoteUiSent = false, remotePresSig = null;

function remoteHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// What the phone lists under "Slides" for whatever the clicker is driving.
function remoteQueueInfo() {
  const q = playbackQueue;
  if (!q) return { queue: null, slides: [], sig: "none" };
  let slides = [], title = "", id = "";
  if (q.type === "song") {
    let prevSec = null;
    slides = (q.slides || []).map((s) => {
      const sec = s.sectionIdx !== prevSec ? displaySectionName(s.sectionName || "") : "";
      prevSec = s.sectionIdx;
      return { t: s.text || "", sec };
    });
    title = (currentSong && currentSong.title) || "";
    id = (currentSong && currentSong.id) || "";
  } else if (q.type === "pres") {
    slides = (q.slides || []).map((s) => ({ t: s.text || "", img: s.imagePath || null }));
    title = (currentPresentation && currentPresentation.title) || "";
    id = (currentPresentation && currentPresentation.id) || "";
  } else if (q.type === "ann") {
    slides = annImages.map((it) => ({ t: "", img: it.path || null, v: isVideoFile(it.file) }));
    title = (annImages[0] && annImages[0].label) || "";
  } else if (q.type === "plMedia") {
    const it = q.item || {};
    slides = [{ t: it.imagePath ? "" : (it.text || ""), img: it.imagePath || null, v: isVideoFile(it.imagePath) }];
    title = playlistItemLabel(it);
  } else if (q.type === "bible") {
    const texts = {};
    verseList.querySelectorAll(".verseRow").forEach((r) => { texts[r.dataset.v] = (r.querySelector(".vt") || {}).textContent || ""; });
    const count = q.count || 0;
    slides = Array.from({ length: count }, (_, i) => ({ n: i + 1, t: texts[i + 1] || "" }));
    title = currentBook ? `${currentBook.name} ${currentChapter}` : "";
    id = `${currentTranslationId}|${currentBook && currentBook.osis}|${currentChapter}`;
  }
  const sig = q.type + ":" + id + ":" + slides.length + ":" +
    remoteHash(slides.map((s) => (s.sec || "") + "\u0001" + s.t + "\u0001" + (s.img || "")).join("\u0002"));
  const armed = !!q.armed || playbackIndex < 0;
  return { queue: { type: q.type, index: playbackIndex, armed, title }, slides, sig };
}

function remoteNextText() {
  // An armed verse is shown as it is by the first Next, not the one after it.
  if (playbackQueue && playbackQueue.type === "bible" && playbackQueue.armed) {
    const row = verseList.querySelector(`.verseRow[data-v="${currentVerse}"] .vt`);
    return row ? row.textContent : "";
  }
  return peekNextSlideText();
}

function remoteSync() {
  if (!window.remoteApi || remoteSyncPending) return;
  remoteSyncPending = true;
  // A microtask, not a timer: timers are slowed down in a minimised window,
  // and the phone must keep up even when the control window is out of sight.
  queueMicrotask(() => {
    remoteSyncPending = false;
    try { pushRemoteState(); } catch (e) { console.warn("remote sync:", e); }
  });
}

function pushRemoteState() {
  const info = remoteQueueInfo();
  const live = lastShownPayload;
  const liveText = live ? String(live.text || "") : "";
  const patch = {
    screen: !!screenVisible,
    canShow: !!lastShownPayload,
    live: live ? {
      text: liveText,
      ref: live.reference || "",
      media: !liveText.trim() && (live.video || live.image) ? (live.video ? "video" : "image") : null,
    } : null,
    next: remoteNextText(),
    queue: info.queue,
    playlist: currentPlaylist ? {
      id: currentPlaylist.id || null,
      name: currentPlaylist.name || "",
      live: livePlIdx,
      items: (currentPlaylist.items || []).map((it) => ({ type: it.type, label: playlistItemLabel(it) })),
    } : null,
    playlists: (playlists || []).map((p) => ({ id: p.id, name: p.name })),
    presOpen: playbackQueue && playbackQueue.type === "pres" && currentPresentation ? currentPresentation.id : null,
  };
  // The presentation library, for the phone's Presentations tab.
  const pres = (presentations || []).map((p) => ({ id: p.id, title: p.title || "", n: p.slideCount || 0, col: p.collection || "" }));
  const presSig = remoteHash(JSON.stringify(pres));
  if (presSig !== remotePresSig) {
    patch.pres = pres;
    patch.presSig = presSig;
    remotePresSig = presSig;
  }
  if (info.sig !== remoteSentSig) {
    patch.slides = info.slides;
    patch.slidesSig = info.sig;
    remoteSentSig = info.sig;
  }
  if (!remoteUiSent) {
    const ui = {};
    REMOTE_UI_KEYS.forEach((k) => { ui[k] = window.i18n.t(k); });
    patch.ui = ui;
    patch.lang = window.i18n.getLang();
    remoteUiSent = true;
  }
  window.remoteApi.pushState(patch);
}

// A tap on a slide in the phone's list. The list carries a signature of what
// it was built from; a tap on a list that is already out of date (the item
// changed a moment ago) is ignored rather than showing the wrong slide.
async function remoteGoSlide(idx, sig) {
  const q = playbackQueue;
  if (!q) return;
  const info = remoteQueueInfo();
  if (sig && sig !== info.sig) return;
  if (!(idx >= 0 && idx < info.slides.length)) return;
  if (q.type === "plMedia") { playbackIndex = 0; showPlaylistMedia(q.item); return; }
  if (q.type === "bible") {
    if (!currentBook || !currentTranslationId) return;
    q.armed = false;
    currentVerse = idx + 1;
    playbackIndex = idx;
    verseList.querySelectorAll(".verseRow").forEach((e) => e.classList.toggle("active", Number(e.dataset.v) === currentVerse));
    const v = await window.bibleApi.getVerse(currentTranslationId, currentBook.osis, currentChapter, currentVerse, window.i18n.getLang());
    if (v) { previewText.textContent = v.text; showOnOutput({ text: v.text, reference: buildVerseRef(v), theme: bibleTheme }); }
    return;
  }
  q.armed = false;
  playbackIndex = idx - 1;     // the step below lands exactly on idx
  await clickerStep("next");
}

// A presentation picked on the phone opens here and is armed: the first Next
// shows slide 1, a tap on a slide shows that one. The one already running is
// left where it is.
async function remoteOpenPresentation(id) {
  if (playbackQueue && playbackQueue.type === "pres" && currentPresentation && currentPresentation.id === id) return;
  switchTab("presView");
  await loadPresentation(id);
  if (!currentPresentation || currentPresentation.id !== id || !(currentPresentation.slides || []).length) return;
  const plItem = currentPlaylist && livePlIdx >= 0 ? currentPlaylist.items[livePlIdx] : null;
  playbackQueue = { type: "pres", slides: currentPresentation.slides, fromPlaylist: !!(plItem && plItem.type === "presentation" && plItem.presId === id) };
  playbackIndex = -1;
  document.getElementById("presSlideGrid").querySelectorAll(".slideCard").forEach((c) => c.classList.remove("live"));
}

let remoteBusy = Promise.resolve();
window.remoteApi?.onCommand((c) => {
  // One at a time and in order: two quick taps on Next are two slides, and a
  // slow step (opening a song) must not be overtaken by the next command.
  remoteBusy = remoteBusy.then(async () => {
    try {
      if (c.cmd === "next" || c.cmd === "prev") await clickerStep(c.cmd);
      else if (c.cmd === "screen") toggleScreen("toggle");
      else if (c.cmd === "clearText") { if (lastShownPayload) clearText(); }
      else if (c.cmd === "slide") await remoteGoSlide(c.idx, c.sig);
      else if (c.cmd === "item") { if (currentPlaylist && currentPlaylist.items[c.idx]) await playPlaylistItem(c.idx); }
      else if (c.cmd === "pres") { if ((presentations || []).some((p) => p.id === c.id)) await remoteOpenPresentation(c.id); }
      else if (c.cmd === "playlist") {
        if ((playlists || []).some((p) => p.id === c.id)) { playlistSelect.value = c.id; await loadPlaylist(c.id); }
      }
    } catch (e) { console.warn("remote command failed:", e); }
    remoteSync();
  });
});

// ---- Remote panel ----
{
  const ov = document.getElementById("remoteOverlay");
  const R = (id) => document.getElementById(id);
  let qrFor = "", lastPhones = -1;

  async function paintRemote() {
    let st;
    try { st = await window.remoteApi.status(); } catch (e) { return; }
    const on = !!st.running;
    const btn = R("btnToggleRemote");
    btn.textContent = window.i18n.t(on ? "Вимкнути" : "Увімкнути");
    btn.classList.toggle("primary", !on);
    btn.classList.toggle("danger", on);
    R("remoteDot").style.display = on ? "inline-block" : "none";
    R("btnOpenRemote").style.color = on ? "var(--green)" : "";
    const err = !on && st.error ? window.i18n.t("Не вдалося запустити пульт:") + "\n" + st.error : "";
    R("remoteError").textContent = err;
    R("remoteError").style.display = err ? "block" : "none";
    R("remoteInfo").style.display = on ? "block" : "none";
    if (document.activeElement !== R("remotePort")) R("remotePort").value = st.port;
    if (!on) { qrFor = ""; return; }

    const ips = st.ips && st.ips.length ? st.ips : ["localhost"];
    const sel = R("remoteIpSel");
    const ipSig = ips.join(",");
    if (sel.dataset.sig !== ipSig) {
      const saved = localStorage.getItem("remoteIp");
      sel.innerHTML = ips.map((ip) => `<option value="${esc(ip)}">${esc(ip)}</option>`).join("");
      sel.dataset.sig = ipSig;
      sel.value = ips.includes(saved) ? saved : ips[0];
    }
    R("remoteIpRow").style.display = ips.length > 1 ? "flex" : "none";
    const base = `http://${sel.value || ips[0]}:${st.port}`;
    R("remoteUrl").textContent = base;
    R("remotePin").textContent = String(st.pin || "").replace(/^(\d{3})(\d{3})$/, "$1 $2");
    const qrText = `${base}/#k=${st.key}`;
    if (qrText !== qrFor) {
      qrFor = qrText;
      try { R("remoteQr").innerHTML = await window.remoteApi.qr(qrText); } catch (e) { R("remoteQr").innerHTML = ""; }
    }
    if (st.phones !== lastPhones) {
      lastPhones = st.phones;
      R("remotePhones").textContent = st.phones
        ? `${window.i18n.t("Підключено телефонів:")} ${st.phones}`
        : window.i18n.t("Очікую підключення телефона…");
    }
  }

  R("btnOpenRemote").addEventListener("click", () => { ov.style.display = "flex"; lastPhones = -1; paintRemote(); });
  R("btnCloseRemote").addEventListener("click", () => { ov.style.display = "none"; });
  R("remoteIpSel").addEventListener("change", () => {
    localStorage.setItem("remoteIp", R("remoteIpSel").value);
    paintRemote();
  });
  R("btnToggleRemote").addEventListener("click", async () => {
    const btn = R("btnToggleRemote");
    btn.disabled = true;
    try {
      const st = await window.remoteApi.status();
      if (st.running) await window.remoteApi.stop();
      else {
        const port = Math.floor(Number(R("remotePort").value)) || 7780;
        const r = await window.remoteApi.start(port);
        if (r && r.ok) { remoteSentSig = null; remoteUiSent = false; remotePresSig = null; remoteSync(); }
      }
    } finally { btn.disabled = false; }
    lastPhones = -1;
    await paintRemote();
  });
  R("btnRemoteReset").addEventListener("click", async () => {
    if (!(await appConfirm(window.i18n.t("Усі підключені телефони буде відключено, і PIN-код зміниться.")))) return;
    await window.remoteApi.reset();
    lastPhones = -1;
    await paintRemote();
  });

  // Live phone count while the panel is open; the top-bar dot at startup
  // (the remote may come back on by itself a moment after launch).
  setInterval(() => { if (ov.style.display === "flex") paintRemote(); }, 2000);
  paintRemote();
  setTimeout(paintRemote, 2500);
  remoteSync();
}
