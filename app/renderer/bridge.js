// Bridge between the pages and the Rust core.
//
// The pages talk to the core through the same small set of objects they always
// have (bibleApi, songsApi, outputApi, …). Each call goes to one Rust command,
// `api`, with a channel name such as "songs:list"; events from the core
// (slides for the projector, clicker presses, phone-remote commands) arrive as
// Tauri events addressed to this window.
(function () {
  "use strict";
  const T = window.__TAURI__;
  const core = T.core;
  const self = T.webviewWindow.getCurrentWebviewWindow();
  const LABEL = self.label;

  function toError(e) {
    if (e instanceof Error) return e;
    return new Error(typeof e === "string" ? e : (e && e.message) || String(e));
  }
  function call(ch, arg) {
    return core.invoke("api", { ch, arg: arg === undefined ? null : arg }).catch((e) => { throw toError(e); });
  }
  // Registering a listener is itself asynchronous; anything that must not
  // be missed (the first slide for a fresh projector window) waits for these.
  const listening = [];
  function on(event, cb) {
    const p = self.listen(event, (e) => { try { cb(e.payload); } catch (err) { console.error(err); } })
      .catch((e) => { console.error("listen " + event, e); });
    listening.push(p);
    return p;
  }
  // Messages whose order matters (slides, phone state) go through a command
  // the core handles one at a time, in the order they arrive.
  function send(ch, arg) {
    core.invoke("api_sync", { ch, arg: arg === undefined ? null : arg }).catch((e) => console.warn(ch, e));
  }
  let seq = 0;
  const numbered = (p) => Object.assign({}, p || {}, { __seq: ++seq });

  // ---- Sorting in the interface language ----
  // Lists are sorted here rather than in the core: the browser's collator
  // knows every language's alphabet (Ukrainian і/ї/є/ґ, Polish ł, …).
  function uiLocale() {
    try {
      const l = window.i18n && window.i18n.getLang ? window.i18n.getLang() : "en";
      return l === "nb" ? "nb-NO" : l;
    } catch (e) { return "en"; }
  }
  function sortBy(list, key) {
    if (!Array.isArray(list)) return list;
    const coll = new Intl.Collator(uiLocale());
    return list.slice().sort((a, b) => coll.compare(String((key ? a && a[key] : a) || ""), String((key ? b && b[key] : b) || "")));
  }
  const sorted = (ch, key) => (arg) => call(ch, arg).then((r) => sortBy(r, key));

  // ---- Local files ----
  // Media on disk is shown through Tauri's asset protocol. Single quotes are
  // encoded because these URLs are written into CSS url('…').
  function fileUrl(p) {
    if (!p) return null;
    return core.convertFileSrc(String(p)).replace(/'/g, "%27");
  }

  // Files dropped from Explorer/Finder carry no path in a web page, so their
  // contents are handed to the core in chunks and stored next to the data.
  const CHUNK = 4 << 20;
  async function upload(file) {
    const id = await call("upload:begin", { name: file.name || "file", size: file.size || 0 });
    try {
      for (let off = 0; off < file.size; off += CHUNK) {
        const buf = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
        await core.invoke("upload_chunk", buf, { headers: { "x-upload": id } });
      }
      return await call("upload:end", { id });
    } catch (e) {
      send("upload:cancel", { id });
      throw toError(e);
    }
  }
  async function materialize(list) {
    const out = [];
    for (const x of list || []) {
      if (typeof x === "string") out.push(x);
      else if (x && typeof x.arrayBuffer === "function") {
        try { out.push(await upload(x)); } catch (e) { console.warn("upload failed", e); }
      }
    }
    return out;
  }

  // ---- Presentations: PDF pages are drawn here with pdf.js ----
  let pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) {
      const base = new URL("../vendor/pdfjs/", location.href).href;
      pdfjsPromise = import(base + "pdf.min.mjs").then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.mjs";
        return { lib, base };
      });
    }
    return pdfjsPromise;
  }
  const TARGET_LONG_SIDE = 2560;
  function canvasToPng(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? b.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), reject) : reject(new Error("PDF_UNREADABLE: canvas"))), "image/png");
    });
  }
  async function renderPdfJob(job) {
    const { lib, base } = await loadPdfjs();
    const data = new Uint8Array(await core.invoke("job_pdf", { id: job.id }));
    let doc;
    try {
      doc = await lib.getDocument({
        data,
        standardFontDataUrl: base + "standard_fonts/",
        cMapUrl: base + "cmaps/",
        cMapPacked: true,
        isEvalSupported: false,
      }).promise;
    } catch (e) {
      if (e && e.name === "PasswordException") throw new Error("PDF_PASSWORD");
      throw new Error("PDF_UNREADABLE: " + ((e && e.message) || e));
    }
    if (!doc.numPages) throw new Error("PDF_EMPTY");
    const slides = [];
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const v1 = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: TARGET_LONG_SIDE / Math.max(v1.width, v1.height) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext("2d");
        // Paint white first: a transparent PDF page would otherwise turn into
        // black-on-black on the projector.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const name = `${job.baseName}-${job.stamp}-slide${i}.png`;
        await core.invoke("job_slide", await canvasToPng(canvas), { headers: { "x-job": job.id, "x-name": name } });
        slides.push({ image: name });
        canvas.width = 1; canvas.height = 1;
        page.cleanup();
      }
    } catch (e) {
      send("presentations:abort", { id: job.id, slides });
      throw toError(e);
    } finally {
      try { await doc.destroy(); } catch (e) {}
    }
    return slides;
  }

  window.bp = { call, fileUrl, label: LABEL };

  if (LABEL === "output") {
    window.systemApi = { listFonts: () => call("system:listFonts").then((l) => (Array.isArray(l) ? l.slice().sort((a, b) => a.localeCompare(b)) : l)) };
    window.slideApi = {
      onShowSlide: (cb) => on("output:showSlide", cb),
      onClear: (cb) => on("output:clear", () => cb()),
      onSetTheme: (cb) => on("output:setTheme", cb),
    };
    // Clicker and keyboard on the projector window drive the control window:
    // arrows / Page Up-Down / Space step, F5 shows, Esc hides, B W . blank.
    const NEXT = ["ArrowRight", "ArrowDown", "PageDown", " ", "Spacebar"];
    const PREV = ["ArrowLeft", "ArrowUp", "PageUp"];
    window.addEventListener("keydown", (e) => {
      let cmd = null;
      if (NEXT.includes(e.key)) cmd = "next";
      else if (PREV.includes(e.key)) cmd = "prev";
      else if (e.key === "F5") cmd = "show";
      else if (e.key === "Escape") cmd = "hide";
      else if (["b", "B", ".", "w", "W"].includes(e.key)) cmd = "toggle";
      if (!cmd) return;
      e.preventDefault();
      send("output:key", cmd);
    }, true);
    // Ask for the theme and whatever is on screen once the page can show it.
    window.addEventListener("DOMContentLoaded", () => {
      setTimeout(() => Promise.all(listening).then(() => send("output:ready"), () => send("output:ready")), 0);
    });
    return;
  }

  // ================= control window =================
  window.fileApi = { pathFor: (file) => file || null };

  window.bibleApi = {
    listTranslations: () => call("bible:listTranslations"),
    getBookList: (translationId, lang) => call("bible:getBookList", { translationId, lang }),
    getChapterVerseCount: (translationId, osis, chapter) => call("bible:getChapterVerseCount", { translationId, osis, chapter }),
    searchText: (translationId, query, lang, limit) => call("bible:searchText", { translationId, query, lang, limit }),
    getVerse: (translationId, osis, chapter, verse, lang) => call("bible:getVerse", { translationId, osis, chapter, verse, lang }),
    importXml: (lang) => call("bible:importXml", lang),
    catalog: () => call("bible:catalog"),
    refreshCatalog: () => call("bible:refreshCatalog"),
    download: (file, lang, catalogLang) => call("bible:download", { file, lang, catalogLang }),
  };

  window.songsApi = {
    list: sorted("songs:list", "title"),
    get: (id) => call("songs:get", id),
    save: (song) => call("songs:save", song),
    delete: (id) => call("songs:delete", id),
    importPro: () => call("songs:importPro"),
    importProLibrary: () => call("songs:importProLibrary"),
    listCollections: sorted("songCollections:list"),
    addCollection: sorted("songCollections:add"),
    exportFile: (id) => call("songs:exportFile", id),
    importFile: () => call("songs:importFile"),
  };

  window.themesApi = {
    list: sorted("themes:list", "name"),
    get: (id) => call("themes:get", id),
    save: (theme) => call("themes:save", theme),
    delete: (id) => call("themes:delete", id),
    importProTheme: () => call("themes:importProTheme"),
    exportFile: (id) => call("themes:exportFile", id),
    importFile: () => call("themes:importFile"),
  };

  window.presentationsApi = {
    list: sorted("presentations:list", "title"),
    get: (id) => call("presentations:get", id),
    delete: (id) => call("presentations:delete", id),
    setCollection: (id, collection) => call("presentations:setCollection", { id, collection }),
    // The core picks the file (and runs LibreOffice for .pptx); the pages are
    // drawn here and handed back one by one.
    importPptx: async (labels) => {
      const job = await call("presentations:prepare", labels || {});
      if (!job) return null;
      const slides = await renderPdfJob(job);
      return call("presentations:finish", { id: job.id, slides });
    },
  };

  window.systemApi = {
    checkLibreOffice: () => call("system:checkLibreOffice"),
    openExternal: (url) => call("system:openExternal", url),
    listFonts: () => call("system:listFonts").then((l) => (Array.isArray(l) ? l.slice().sort((a, b) => a.localeCompare(b)) : l)),
    appInfo: () => call("system:appInfo"),
    checkForUpdates: () => call("system:checkForUpdates"),
    setUiStrings: (lang, strings) => call("system:setUiStrings", { lang, strings }),
    importBackground: () => call("media:importBackground"),
    listBackgrounds: sorted("backgrounds:list", "file"),
    listBackgroundsAll: sorted("backgrounds:listAll", "file"),
    addBackgrounds: () => call("backgrounds:import"),
    addBackgroundPaths: async (paths) => call("backgrounds:importPaths", await materialize(paths)),
    deleteBackground: (file) => call("backgrounds:delete", file),
  };

  window.announcementsApi = {
    list: sorted("announcements:list", "title"),
    get: (id) => call("announcements:get", id),
    delete: (id) => call("announcements:delete", id),
    removeImage: (id, file) => call("announcements:removeImage", { id, file }),
    rename: (id, title) => call("announcements:rename", { id, title }),
    importImages: (existingId, defaultTitle) => call("announcements:importImages", { existingId, defaultTitle }),
    importPaths: async (paths, existingId, defaultTitle) =>
      call("announcements:importPaths", { paths: await materialize(paths), existingId, defaultTitle }),
  };

  window.outputApi = {
    showSlide: (payload) => send("output:showSlide", numbered(payload)),
    clear: () => send("output:clear", numbered()),
    setTheme: (theme) => send("output:setTheme", theme),
  };

  window.playlistsApi = {
    list: sorted("playlists:list", "name"),
    get: (id) => call("playlists:get", id),
    save: (playlist) => call("playlists:save", playlist),
    delete: (id) => call("playlists:delete", id),
    exportFile: (id) => call("playlists:exportFile", id),
    importFile: () => call("playlists:importFile"),
  };

  window.webcastApi = {
    status: () => call("webcast:status"),
    start: (port) => call("webcast:start", port),
    stop: () => call("webcast:stop"),
    setStyle: (style) => call("webcast:setStyle", style),
    clear: () => call("webcast:clear"),
    setBlackout: (on) => call("webcast:setBlackout", on),
    setStage: (cfg) => call("webcast:setStage", cfg),
    getStage: () => call("webcast:getStage"),
    resetStageTimer: () => call("webcast:resetStageTimer"),
    listThemes: sorted("streamThemes:list", "name"),
    getTheme: (id) => call("streamThemes:get", id),
    saveTheme: (theme) => call("streamThemes:save", theme),
    deleteTheme: (id) => call("streamThemes:delete", id),
    importThemeFile: () => call("streamThemes:importFile"),
    exportThemeFile: (theme) => call("streamThemes:exportFile", theme),
    getStyle: () => call("webcast:getStyle"),
  };

  window.clickerApi = { onNav: (cb) => on("clicker:nav", cb) };

  window.remoteApi = {
    status: () => call("remote:status"),
    start: (port) => call("remote:start", port),
    stop: () => call("remote:stop"),
    reset: () => call("remote:reset"),
    qr: (text) => call("remote:qr", text),
    pushState: (patch) => send("remote:state", patch),
    onCommand: (cb) => on("remote:cmd", cb),
  };

  // Closing the window: the page gets the chance to save the open song (or ask
  // about an untitled one) first; it answers with app:quit.
  window.appLifecycle = {
    onCloseRequested: (cb) => on("app:close-requested", cb),
    quit: () => call("app:quit"),
  };
})();
