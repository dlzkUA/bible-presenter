// Projector window: renders slides with a crossfade over a shared background.
    const layers = [document.getElementById("layerA"), document.getElementById("layerB")];
    // Double-buffered background (see app/shared/bgStage.js).
    const bg = window.createBgStage(document.getElementById("bgStage"));
    let active = 0; // index of the currently visible layer

    const THEME_VARS = ["--theme-bg","--theme-color","--theme-font","--theme-size","--theme-align","--theme-valign","--theme-transform","--theme-spacing","--theme-line","--theme-weight","--theme-shadow","--theme-linegap"];

    // ── Last-resort font safety net (see output_preload.js) ──
    // The control window already resolves fonts before sending a payload, but
    // this window can outlive that guarantee (a stale in-memory theme, a
    // hand-edited JSON, a file imported from a different PC). Re-check here
    // too, so the projector never silently substitutes a different typeface.
    let __installedFonts = [];
    try {
      window.systemApi.listFonts().then(list => { __installedFonts = list || []; });
    } catch (e) {}
    const __fontCanvas = document.createElement("canvas").getContext("2d");
    function __fontAvailable(name) {
      if (!name || !__fontCanvas) return false;
      const probe = "mmmmmmmmmmlli";
      __fontCanvas.font = "72px monospace";
      const base = __fontCanvas.measureText(probe).width;
      __fontCanvas.font = `72px "${name}", monospace`;
      return __fontCanvas.measureText(probe).width !== base;
    }
    function resolveOutputFont(name) {
      if (!name) return name;
      name = String(name).split(",")[0].trim().replace(/^["']+|["']+$/g, "").trim();
      if (__fontAvailable(name)) return name;
      if (!__installedFonts.length) return name; // list not loaded yet — trust the payload
      const squash = v => String(v).toLowerCase().replace(/[^a-z0-9]/g, "");
      const wanted = squash(name);
      const exact = __installedFonts.find(f => squash(f) === wanted);
      if (exact) return exact;
      const STYLE_TAIL = /^(regular|bold|semibold|demibold|extrabold|ultrabold|light|extralight|ultralight|thin|medium|black|heavy|italic|oblique|book|roman|normal)+$/;
      const prefix = __installedFonts
        .filter(f => { const sf = squash(f); return sf.length >= 4 && wanted.startsWith(sf) && STYLE_TAIL.test(wanted.slice(sf.length)); })
        .sort((a, b) => squash(b).length - squash(a).length)[0];
      return prefix || name;
    }


    function applyThemeTo(layer, theme) {
      if (!theme) {
        THEME_VARS.forEach(v => layer.style.removeProperty(v));
        return;
      }
      layer.style.setProperty("--theme-bg", theme.background || "#000");
      layer.style.setProperty("--theme-color", theme.color || "#fff");
      layer.style.setProperty("--theme-font", theme.fontFamily ? `"${resolveOutputFont(theme.fontFamily)}", "Segoe UI", sans-serif` : "Georgia, serif");
      const sizeVh = theme.fontSize ? (theme.fontSize / 1080) * 100 : 5.2;
      layer.style.setProperty("--theme-size", sizeVh + "vh");
      layer.style.setProperty("--theme-align", theme.align || "center");
      layer.style.setProperty("--theme-valign", theme.valign || "center");
      layer.style.setProperty("--theme-transform", theme.uppercase ? "uppercase" : "none");
      layer.style.setProperty("--theme-spacing", (theme.letterSpacing ?? 0) + "em");
      layer.style.setProperty("--theme-line", String(theme.lineHeight ?? 1.3));
      layer.style.setProperty("--theme-linegap", (theme.lineGap ?? 0) + "em");
      layer.style.setProperty("--theme-weight", theme.bold ? "700" : "400");
      layer.style.setProperty("--theme-shadow", theme.shadow !== false ? "0 2px 12px rgba(0,0,0,0.6)" : "none");
    }

    function renderInto(layer, payload) {
      const textEl = layer.querySelector(".verseText");
      const refEl = layer.querySelector(".verseRef");
      if (payload.theme !== undefined) applyThemeTo(layer, payload.theme);
      textEl.textContent = "";
      const linesArr = String(payload.text || "").split("\n");
      linesArr.forEach((ln, i) => {
        const d = document.createElement("div");
        d.textContent = ln;
        if (i > 0) d.style.marginTop = "var(--theme-linegap, 0em)";
        textEl.appendChild(d);
      });
      textEl.style.display = payload.text ? "block" : "none";
      if (payload.reference) {
        refEl.textContent = payload.reference;
        refEl.style.display = "block";
      } else {
        refEl.style.display = "none";
      }
      const fullVid = layer.querySelector(".fullVideo");
      // Stop the full-frame video on EVERY layer, not just the incoming one.
      // The crossfade alternates layers, so clearing only this one left the
      // previous layer's clip playing — two soundtracks at once.
      layers.forEach(l => {
        const v = l.querySelector(".fullVideo");
        if (!v) return;
        v.style.display = "none";
        if (v.src) { v.pause(); v.removeAttribute("src"); v.load(); }
      });

      // ── Shared background stage ──
      // Applied once, outside the crossfading layers, so a looping clip keeps
      // running across slide changes. It is only touched when the requested
      // background actually differs from what is already playing.
      const isMediaSlide = !!(payload.video || payload.image);
      const t = payload.theme;
      const wantUrl = (!isMediaSlide && t && t.bgUrl) ? t.bgUrl : null;
      const wantType = wantUrl ? ((t.bgType === "video" || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(wantUrl)) ? "video" : "image") : null;
      const wantFit = (t && t.bgFit === "contain") ? "contain" : "cover";

      if (isMediaSlide) bg.pause();            // covered by the media; resume instantly later
      else bg.set(wantUrl, wantType, wantFit, Math.max(250, Number(payload.transitionMs ?? 300)));

      // Inline size/position may linger from a previous theme background on
      // this layer and would override the .imageSlide class rules.
      const resetBgFit = () => {
        layer.style.backgroundSize = ""; layer.style.backgroundRepeat = ""; layer.style.backgroundPosition = "";
      };
      if (payload.video) {
        // Announcement video: plays full frame, with sound, on top.
        fullVid.src = payload.video;
        fullVid.style.display = "block";
        fullVid.currentTime = 0;
        const p2=fullVid.play(); if(p2&&p2.catch) p2.catch(()=>{});
        layer.style.backgroundImage = "none";
        resetBgFit();
        layer.classList.add("imageSlide");
      } else if (payload.image) {
        layer.style.backgroundImage = `url("${payload.image.replace(/"/g, '\\"')}")`;
        resetBgFit();
        layer.classList.add("imageSlide");
      } else {
        // Text slide: the background is handled by the shared stage above, so
        // the layer itself stays transparent and lets it show through.
        layer.style.backgroundImage = "none";
        resetBgFit();
        layer.classList.remove("imageSlide");
      }
    }

    window.slideApi.onShowSlide((payload) => {
      const dur = Math.max(0, Number(payload.transitionMs ?? 300));
      layers.forEach(l => l.style.setProperty("--trans", dur + "ms"));
      const next = layers[1 - active];
      renderInto(next, payload);
      // Crossfade: the new layer fades in on top while the old fades out.
      next.classList.add("visible");
      layers[active].classList.remove("visible");
      active = 1 - active;
    });

    window.slideApi.onClear(() => {
      // The shared background stage is outside the layers, so clear it too —
      // otherwise a muted loop would keep running behind a blanked screen.
      bg.clear();

      layers.forEach(l => {
        l.classList.remove("visible");
        // Hiding a layer only fades its opacity — an unstopped <video> keeps
        // playing (and its audio keeps sounding) behind the scenes.
        [l.querySelector(".fullVideo")].forEach(v => {
          if (!v) return;
          v.pause();
          if (v.src) { v.removeAttribute("src"); v.load(); }
        });
      });
    });

    window.slideApi.onSetTheme((theme) => {
      // Applied on window (re)creation: style both layers.
      layers.forEach(l => applyThemeTo(l, theme));
    });
