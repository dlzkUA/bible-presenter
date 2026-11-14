// Chosen fonts, loaded from their own files.
//
// A CSS family name leaves the matching to the web view, and on some
// computers that picks the wrong thing: a variable font drawn at its default
// Thin instance, a font installed while the app was open, a font the web view
// doesn't list, or vMix on a computer without the font. The core knows the
// files behind every family in the font list (src-tauri/src/fonts.rs); each
// page declares them as "BP <family>" and puts that first in the font stack,
// with the plain family name after it in case the files can't be loaded.
//
// window.bpFonts.use(source) — source(family) resolves to [{url, weight, style, stretch}]
// window.bpFonts.stack(family, fallback) — CSS font-family value
// window.bpFonts.ready(family, bold, text, ms) — resolves once the face is drawable (or after ms)
(function () {
  let source = null;
  const known = new Map();   // family → Promise<boolean>
  const alias = (f) => "BP " + f;
  const q = (f) => '"' + String(f).replace(/["\\]/g, "") + '"';

  function ensure(family) {
    if (!family || !source || !window.FontFace || !document.fonts) return Promise.resolve(false);
    if (known.has(family)) return known.get(family);
    const p = Promise.resolve()
      .then(() => source(family))
      .then((faces) => {
        if (!Array.isArray(faces) || !faces.length) return false;
        for (const f of faces) {
          try {
            const ff = new FontFace(alias(family).replace(/["\\]/g, ""), 'url("' + f.url + '")',
              { weight: String(f.weight || "400"), style: f.style || "normal", stretch: f.stretch || "100%", display: "block" });
            document.fonts.add(ff);
          } catch (e) { /* a face the engine refuses: the others still work */ }
        }
        return true;
      })
      .catch(() => false);
    known.set(family, p);
    return p;
  }

  window.bpFonts = {
    use(fn) { source = fn; },
    ensure,
    stack(family, fallback) {
      if (!family) return fallback;
      ensure(family);
      return q(alias(family)) + ", " + q(family) + (fallback ? ", " + fallback : "");
    },
    // Waits for the face a slide will use, so a slide never shows in a
    // stand-in font first. Never longer than `ms`.
    ready(family, bold, text, ms) {
      if (!family) return Promise.resolve();
      const done = ensure(family).then((ok) => {
        if (!ok) return;
        return document.fonts.load((bold ? "700 " : "400 ") + "40px " + q(alias(family)), text || "AaЯя").catch(() => {});
      });
      return Promise.race([done, new Promise((r) => setTimeout(r, ms || 1500))]);
    },
  };
})();
