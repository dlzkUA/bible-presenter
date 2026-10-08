// Phone remote — runs in the phone's browser. Talks only to the Bible
// Presenter computer that served it: commands go out as small POSTs, the
// live state comes back over one Server-Sent Events stream.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const boot = window.__BP || {};
  let UI = boot.ui || {};
  // Keys are the app's own (Ukrainian) source strings; the app sends the
  // translations for its current interface language.
  const t = (k) => UI[k] || k;

  // ---- the pairing key ----
  // From the QR code (#k=…) or from an earlier visit. Kept in the address as
  // well, so a home-screen shortcut made from this page opens already paired.
  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function keyFromHash() {
    const m = /(?:^|[#&])k=([A-Za-z0-9_-]{16,})/.exec(location.hash || "");
    return m ? m[1] : null;
  }
  let key = keyFromHash() || load("bpRemoteKey") || "";
  function rememberKey(k) {
    key = k; store("bpRemoteKey", k);
    try { history.replaceState(null, "", "/#k=" + k); } catch (e) {}
  }
  if (key) rememberKey(key);

  // ---- state ----
  let S = {};
  const TABS = ["slides", "service", "pres"];
  let tab = TABS.includes(load("bpRemoteTab")) ? load("bpRemoteTab") : "slides";
  let lastListSig = "", lastIndexShown = null, touchedListAt = 0, presQuery = "";

  function applyStrings() {
    document.documentElement.lang = S.lang || boot.lang || "uk";
    $("tabSlides").textContent = t("Слайди");
    $("tabService").textContent = t("Служіння");
    $("tabPres").textContent = t("Презентації");
    $("bText").textContent = t("Прибрати текст");
    $("bPrev").textContent = "◀  " + t("Назад");
    $("bNext").textContent = t("Далі") + "  ▶";
    $("nextLbl").textContent = t("Наступний:");
    $("capNext").textContent = t("Наступний:").replace(/[:：]\s*$/, "");
    $("pinHint").textContent = t("Введіть PIN-код, показаний у програмі");
    $("pinBtn").textContent = t("Увійти");
    $("conn").textContent = t("Немає зв'язку з програмою. Перепідключення…");
  }

  // ---- talking to the app ----
  async function send(cmd) {
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
    try {
      const r = await fetch("/api/cmd", {
        method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json", "X-Key": key },
        body: JSON.stringify(cmd),
      });
      if (r.status === 401) { showPin(); }
    } catch (e) { setConn(false); }
  }

  let es = null, helloTimer = null;
  function setConn(ok) {
    $("dot").classList.toggle("on", !!ok);
    $("conn").hidden = !!ok || !$("pin").hidden;
  }
  async function hello() {
    clearTimeout(helloTimer);
    if (!key) { showPin(); return; }
    let r;
    try { r = await fetch("/api/hello", { headers: { "X-Key": key }, cache: "no-store" }); }
    catch (e) { setConn(false); helloTimer = setTimeout(hello, 2500); return; }
    if (r.status === 401) { showPin(); return; }
    if (!r.ok) { setConn(false); helloTimer = setTimeout(hello, 2500); return; }
    connect();
  }
  function connect() {
    if (es) { try { es.close(); } catch (e) {} }
    $("pin").hidden = true;
    es = new EventSource("/events?k=" + encodeURIComponent(key));
    es.addEventListener("open", () => setConn(true));
    es.addEventListener("state", (e) => {
      setConn(true);
      let patch; try { patch = JSON.parse(e.data); } catch (err) { return; }
      S = Object.assign({}, S, patch);
      if (patch.ui) { UI = patch.ui; applyStrings(); }
      render();
    });
    es.onerror = () => {
      setConn(false);
      // A closed stream (the app was turned off, or access was reset) does not
      // reconnect by itself; ask again whether the key is still good.
      if (es && es.readyState === 2) { es = null; helloTimer = setTimeout(hello, 2500); }
    };
  }

  // ---- PIN pairing ----
  function showPin(msg) {
    if (es) { try { es.close(); } catch (e) {} es = null; }
    $("pin").hidden = false;
    $("conn").hidden = true;
    $("pinErr").textContent = msg || "";
    setTimeout(() => { try { $("pinInput").focus(); } catch (e) {} }, 50);
  }
  async function pair() {
    if ($("pinBtn").disabled) return;          // already checking this PIN
    const pin = $("pinInput").value.replace(/\D/g, "");
    if (pin.length !== 6) { $("pinErr").textContent = t("Невірний PIN-код"); return; }
    $("pinBtn").disabled = true;
    try {
      const r = await fetch("/api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.key) { rememberKey(j.key); $("pinInput").value = ""; $("pinErr").textContent = ""; hello(); }
      else $("pinErr").textContent = r.status === 429 ? t("Забагато спроб. Зачекайте хвилину.") : t("Невірний PIN-код");
    } catch (e) {
      $("pinErr").textContent = t("Немає зв'язку з програмою. Перепідключення…");
    } finally { $("pinBtn").disabled = false; }
  }
  $("pinBtn").addEventListener("click", pair);
  $("pinInput").addEventListener("keydown", (e) => { if (e.key === "Enter") pair(); });
  $("pinInput").addEventListener("input", () => {
    const v = $("pinInput").value.replace(/\D/g, "").slice(0, 6);
    if (v !== $("pinInput").value) $("pinInput").value = v;
    if (v.length === 6) pair();
  });

  // ---- rendering ----
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TYPE_ICON = {
    bible: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 0 5 20.5V4.5Z"/><path d="M5 17.5h13"/></svg>',
    song: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/></svg>',
    presentation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v4M8.5 20h7"/></svg>',
    announcement: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M4.5 16.5 9 12.5l3.5 3 3-2.5 4 4"/></svg>',
  };

  const k = () => encodeURIComponent(key);
  const thumbUrl = (i, big) => `/thumb/${i}?k=${k()}&s=${encodeURIComponent(S.slidesSig || "")}${big ? "&w=720" : ""}`;
  const isPicList = () => (S.slides || []).some((s) => s.th);

  // Which slide of the list is on the projector, and which one Next brings.
  function positions() {
    const q = S.queue, n = (S.slides || []).length;
    if (!q || !n) return { now: -1, next: -1, n };
    const armed = !!(q.armed || q.index < 0);
    const now = armed ? -1 : q.index;
    const next = armed ? Math.max(0, q.index) : q.index + 1;
    return { now, next: next < n ? next : -1, n };
  }

  function setPic(el, i, big, empty) {
    const s = (S.slides || [])[i];
    if (s && s.th) {
      el.classList.remove("blank");
      el.style.backgroundImage = `url("${thumbUrl(i, big)}")`;
    } else {
      el.classList.add("blank");
      el.style.backgroundImage = "";
      el.dataset.empty = s ? (s.t || (s.v ? t("Відео на екрані") : "")) : empty;
    }
  }

  function renderLive() {
    const on = !!S.screen;
    const live = S.live || null;
    const q = S.queue;
    const pos = positions();
    $("liveCard").classList.toggle("off", !on);
    $("liveLbl").classList.toggle("off", !on);
    $("liveLbl").textContent = on ? t("На екрані") : t("Екран вимкнено");
    $("pos").hidden = !(pos.n > 1 && pos.now >= 0);
    $("pos").textContent = pos.now >= 0 ? `${pos.now + 1} / ${pos.n}` : "";

    // Picture slides: show the slide itself (and the next one) instead of
    // the words "image on screen".
    const nowIsPic = pos.now >= 0 && !!(S.slides[pos.now] || {}).th && !!(live && live.media === "image");
    const pics = isPicList();
    $("pics").hidden = !pics;
    const lt = $("liveText");
    if (pics) {
      lt.hidden = true;
      if (nowIsPic) setPic($("picNow"), pos.now, true, "");
      else {
        const el = $("picNow");
        el.classList.add("blank"); el.style.backgroundImage = "";
        // Something else is still up (the song before, say): name it.
        el.dataset.empty = live && live.text ? live.text
          : live && live.media ? (live.media === "video" ? t("Відео на екрані") : t("Зображення на екрані")) : t("(порожній екран)");
      }
      // Past the last slide Next moves to the next service item: name it.
      setPic($("picNext"), pos.next, false, S.next || "—");
    } else {
      lt.hidden = false;
      if (live && live.media) {
        lt.classList.add("media");
        lt.textContent = live.media === "video" ? t("Відео на екрані") : t("Зображення на екрані");
      } else if (live && live.text) {
        lt.classList.remove("media");
        lt.textContent = live.text;
      } else {
        // Only the background (or nothing) is up: say so instead of a blank card.
        lt.classList.add("media");
        lt.textContent = t("(порожній екран)");
      }
    }
    $("liveRef").textContent = (live && live.ref) || "";
    $("liveRef").hidden = !(live && live.ref);
    const armed = !!(q && (q.armed || q.index < 0));
    $("armed").hidden = !armed;
    $("armed").textContent = armed ? t("Наготові — натисніть «Далі»") + (q.title ? " · " + q.title : "") : "";
    $("nextText").textContent = S.next || "";
    $("nextRow").hidden = pics || !S.next;
    $("bScreen").textContent = on ? t("Сховати екран") : t("Показати екран");
    $("bScreen").classList.toggle("warn", on);
    $("bScreen").classList.toggle("primary", !on && !!S.canShow);
    $("bScreen").disabled = !on && !S.canShow;
  }

  function renderPlaylists() {
    const sel = $("plSel");
    const list = S.playlists || [];
    const cur = S.playlist && S.playlist.id;
    const sig = JSON.stringify([list, cur, UI["— оберіть служіння —"]]);
    if (sel.dataset.sig === sig) return;
    sel.dataset.sig = sig;
    sel.innerHTML = (cur ? "" : `<option value="">${esc(t("— оберіть служіння —"))}</option>`) +
      list.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
    sel.value = cur || "";
  }

  const VIDEO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9.5 5 2.5-5 2.5z"/></svg>';
  function slidesHtml() {
    const q = S.queue;
    const slides = S.slides || [];
    if (!q || !slides.length) return `<div class="empty">${esc(t("Нічого не вибрано. Оберіть пункт служіння або слайд у програмі."))}</div>`;
    const head = q.title ? `<div id="listTitle">${esc(q.title)}</div>` : "";
    if (isPicList()) {
      return head + '<div class="grid">' + slides.map((s, i) => {
        const im = s.th
          ? `<span class="im" style="background-image:url(&quot;${esc(thumbUrl(i))}&quot;)"></span>`
          : `<span class="im none">${s.v ? VIDEO_ICON : esc(s.t || "")}</span>`;
        return `<button class="tile" data-i="${i}" aria-label="${i + 1}">${im}<span class="num">${i + 1}</span></button>`;
      }).join("") + "</div>";
    }
    return head + slides.map((s, i) => {
      const num = s.n != null ? s.n : i + 1;
      const text = s.t ? `<div class="t">${esc(s.t)}</div>` : `<div class="t dim">${esc(s.v ? t("Відео на екрані") : t("(порожній екран)"))}</div>`;
      return `<button class="row" data-i="${i}"><span class="n">${esc(num)}</span><span class="b">${s.sec ? `<div class="sec">${esc(s.sec)}</div>` : ""}${text}</span></button>`;
    }).join("");
  }
  function serviceHtml() {
    const pl = S.playlist;
    if (!pl || !pl.items || !pl.items.length) return `<div class="empty">${esc(t("Служіння порожнє"))}</div>`;
    return pl.items.map((it, i) =>
      `<button class="row" data-p="${i}"><span class="n">${i + 1}</span><span class="ty">${TYPE_ICON[it.type] || ""}</span><span class="b"><div class="t">${esc(it.label)}</div></span></button>`
    ).join("");
  }

  const SLIDES_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v4M8.5 20h7"/></svg>';
  const fold = (x) => String(x || "").toLocaleLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  function presBodyHtml() {
    const all = S.pres || [];
    if (!all.length) return `<div class="empty">${esc(t("Презентацій поки немає. Імпортуйте їх у програмі на комп'ютері."))}</div>`;
    const qy = fold(presQuery.trim());
    const list = qy ? all.filter((p) => fold(p.title).includes(qy) || fold(p.col).includes(qy)) : all;
    if (!list.length) return `<div class="empty">${esc(t("Нічого не знайдено"))}</div>`;
    const groups = new Map();
    list.forEach((p) => { const c = (p.col || "").trim(); if (!groups.has(c)) groups.set(c, []); groups.get(c).push(p); });
    const order = [...groups.keys()].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b, S.lang || undefined));
    const many = order.length > 1 || order[0] !== "";
    return order.map((c) => (many ? `<div class="grp">${esc(c || t("Без збірки"))}</div>` : "") + groups.get(c).map((p) =>
      `<button class="row pres" data-pres="${esc(p.id)}"><span class="cv" style="background-image:url(&quot;/cover/${encodeURIComponent(p.id)}?k=${k()}&quot;)"></span>` +
      `<span class="b"><div class="t">${esc(p.title)}</div></span><span class="cnt">${SLIDES_ICON}${esc(p.n)}</span></button>`
    ).join("")).join("");
  }
  function renderPresBody() {
    const body = $("presBody");
    if (body) body.innerHTML = presBodyHtml();
    markList();
  }

  function markList() {
    const list = $("list");
    const q = S.queue;
    if (tab === "slides") {
      const idx = q ? q.index : -1;
      const armedAt = q && (q.armed || q.index < 0) ? Math.max(0, q.index) : -1;
      list.querySelectorAll("[data-i]").forEach((el) => {
        const i = Number(el.dataset.i);
        el.classList.toggle("live", i === idx && !(q && q.armed));
        el.classList.toggle("armed", i === armedAt);
      });
      // Keep the live slide in view — unless the operator is scrolling the list.
      if (idx !== lastIndexShown && Date.now() - touchedListAt > 4000) {
        const el = list.querySelector(`[data-i="${Math.max(0, idx)}"]`);
        if (el && idx >= 0) el.scrollIntoView({ block: "center", behavior: lastIndexShown == null ? "auto" : "smooth" });
      }
      lastIndexShown = idx;
    } else if (tab === "service") {
      const live = S.playlist ? S.playlist.live : -1;
      list.querySelectorAll(".row[data-p]").forEach((el) => el.classList.toggle("live", Number(el.dataset.p) === live));
    } else {
      list.querySelectorAll(".row[data-pres]").forEach((el) => el.classList.toggle("open", el.dataset.pres === S.presOpen));
    }
  }

  function renderList() {
    const sig = tab === "slides"
      ? "s|" + (S.slidesSig || "") + "|" + (S.queue ? S.queue.title : "") + "|" + (S.slides ? S.slides.length : 0) + "|" + key
      : tab === "service" ? "p|" + JSON.stringify(S.playlist ? S.playlist.items : null)
      : "r|" + (S.presSig || "") + "|" + key;
    if (sig !== lastListSig) {
      const list = $("list");
      const keepScroll = tab === "pres" && lastListSig.startsWith("r|") ? list.scrollTop : 0;
      lastListSig = sig;
      if (tab === "pres") {
        const many = (S.pres || []).length > 6;
        list.innerHTML = (many ? `<input id="presSearch" type="search" enterkeyhint="search" autocomplete="off" placeholder="${esc(t("Пошук презентації…"))}">` : "") + '<div id="presBody"></div>';
        if (many) {
          $("presSearch").value = presQuery;
          $("presSearch").addEventListener("input", (e) => { presQuery = e.target.value; renderPresBody(); });
        } else presQuery = "";
        $("presBody").innerHTML = presBodyHtml();
      } else {
        list.innerHTML = tab === "slides" ? slidesHtml() : serviceHtml();
      }
      list.scrollTop = keepScroll;
      lastIndexShown = null;
    }
    markList();
  }

  function render() {
    renderLive();
    renderPlaylists();
    renderList();
  }

  function setTab(name) {
    tab = name; store("bpRemoteTab", name);
    $("tabSlides").classList.toggle("on", name === "slides");
    $("tabService").classList.toggle("on", name === "service");
    $("tabPres").classList.toggle("on", name === "pres");
    lastListSig = "";
    renderList();
  }

  // ---- controls ----
  $("tabSlides").addEventListener("click", () => setTab("slides"));
  $("tabService").addEventListener("click", () => setTab("service"));
  $("tabPres").addEventListener("click", () => setTab("pres"));
  $("bNext").addEventListener("click", () => send({ cmd: "next" }));
  $("bPrev").addEventListener("click", () => send({ cmd: "prev" }));
  $("bText").addEventListener("click", () => send({ cmd: "clearText" }));
  $("bScreen").addEventListener("click", () => send({ cmd: "screen" }));
  $("plSel").addEventListener("change", (e) => { if (e.target.value) send({ cmd: "playlist", id: e.target.value }); });
  $("list").addEventListener("click", (e) => {
    const row = e.target.closest("[data-i],[data-p],[data-pres]");
    if (!row) return;
    if (row.dataset.i != null) send({ cmd: "slide", idx: Number(row.dataset.i), sig: S.slidesSig || "" });
    else if (row.dataset.p != null) { send({ cmd: "item", idx: Number(row.dataset.p) }); setTab("slides"); }
    else if (row.dataset.pres != null) { send({ cmd: "pres", id: row.dataset.pres }); setTab("slides"); }
  });
  ["touchstart", "wheel"].forEach((ev) => $("list").addEventListener(ev, () => { touchedListAt = Date.now(); }, { passive: true }));

  // Volume keys can't be read by a web page, but a Bluetooth presenter or
  // keyboard paired to a tablet can drive the remote too.
  document.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT")) return;
    if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(e.key)) { e.preventDefault(); send({ cmd: "next" }); }
    else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) { e.preventDefault(); send({ cmd: "prev" }); }
  });

  // A phone that slept for a while has a dead stream; check right away when
  // the page comes back instead of waiting for the browser's own retry.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (!es || es.readyState !== 1) && $("pin").hidden) hello();
  });

  applyStrings();
  setTab(tab);
  renderLive();
  hello();
})();
