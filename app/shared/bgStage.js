// Shared background stage for the projector and the live-output page.
//
// Two stacked slots: a new background is loaded into the hidden slot while the
// current one keeps playing, and only once the new clip has actually painted a
// frame (or the image has decoded) does it fade in. Switching backgrounds used
// to drop the old one at once and start the new file from nothing, so the
// screen sat black or frozen while a large video opened and decoded.
//
// A background that stays the same across slides is never touched, so a loop
// keeps running smoothly; media slides only pause it underneath, so returning
// to the song resumes instantly instead of reloading the file.
(function () {
  function createBgStage(container) {
    container.innerHTML = "";
    const slots = [0, 1].map(() => {
      const slot = document.createElement("div");
      slot.style.cssText = "position:absolute;inset:0;opacity:0;background-position:center;background-repeat:no-repeat;background-size:cover;transition:opacity 400ms ease;will-change:opacity";
      const v = document.createElement("video");
      v.muted = true; v.loop = true; v.playsInline = true; v.preload = "auto";
      v.setAttribute("muted", ""); v.setAttribute("playsinline", "");
      v.disablePictureInPicture = true;
      v.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none";
      // Some encoders leave the loop flag unreliable; restart by hand.
      v.addEventListener("ended", () => { try { v.currentTime = 0; v.play(); } catch (e) {} });
      slot.appendChild(v);
      container.appendChild(slot);
      return { el: slot, v, key: null, tok: 0 };
    });
    let active = 0;           // slot currently shown (or last shown)
    let shownKey = null;      // what the active slot displays
    let pendingKey = null;    // what is loading in the other slot
    let token = 0;

    const play = (v) => { try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {} };
    function unload(s) {
      s.v.pause();
      if (s.v.getAttribute("src")) { s.v.removeAttribute("src"); s.v.load(); }
      s.v.style.display = "none";
      s.el.style.backgroundImage = "none";
      s.key = null;
    }
    function applyFit(s, fit) {
      const contain = fit === "contain";
      s.v.style.objectFit = contain ? "contain" : "cover";
      s.el.style.backgroundSize = contain ? "contain" : "cover";
      s.el.style.backgroundColor = contain ? "#000" : "transparent";
    }
    function setDur(ms) {
      const d = Math.max(0, Number(ms) || 0);
      slots.forEach(s => { s.el.style.transition = "opacity " + d + "ms ease"; });
      return d;
    }
    function reveal(s, key, dur) {
      const old = slots[active];
      s.el.style.opacity = "1";
      if (old !== s) {
        old.el.style.opacity = "0";
        const oldTok = old.tok;
        // Release the outgoing clip once it has faded out — unless the slot
        // was reused for a newer background in the meantime.
        setTimeout(() => { if (old.tok === oldTok && old.el.style.opacity === "0") unload(old); }, dur + 80);
      }
      active = slots.indexOf(s);
      shownKey = key;
      pendingKey = null;
    }

    // A newer choice supersedes a background still loading in the other slot.
    function cancelPending() {
      if (pendingKey === null) return;
      token++;
      pendingKey = null;
      unload(slots[1 - active]);
    }

    function set(url, type, fit, durMs) {
      const dur = setDur(durMs);
      if (!url) { clear(dur); return; }
      const key = url + "|" + (type || "") + "|" + (fit || "cover");
      const cur = slots[active];
      if (key === shownKey) {                 // same background: keep it running
        cancelPending();
        if (cur.el.style.opacity !== "1") cur.el.style.opacity = "1";
        if (type === "video" && cur.v.paused) play(cur.v);
        return;
      }
      if (key === pendingKey) return;         // already loading
      // Same file, only the fit changed: restyle in place, no reload.
      if (cur.key && cur.key.split("|")[0] === url && cur.key.split("|")[1] === (type || "")) {
        cancelPending();
        applyFit(cur, fit); cur.key = key; shownKey = key; pendingKey = null;
        cur.el.style.opacity = "1";
        if (type === "video" && cur.v.paused) play(cur.v);
        return;
      }
      const tok = ++token;
      const s = slots[1 - active];
      unload(s);
      s.tok = tok; s.key = key; pendingKey = key;
      applyFit(s, fit);
      s.el.style.opacity = "0";
      let done = false;
      const go = () => { if (done || tok !== token) return; done = true; reveal(s, key, dur); };
      if (type === "video") {
        s.v.style.display = "block";
        s.v.src = url;
        // Fade in on the first PAINTED frame, not on "can play": that is the
        // moment the clip is really on screen.
        const onFrame = () => {
          if (typeof s.v.requestVideoFrameCallback === "function") s.v.requestVideoFrameCallback(() => go());
          else go();
        };
        s.v.addEventListener("playing", onFrame, { once: true });
        s.v.addEventListener("error", go, { once: true });
        play(s.v);
        setTimeout(go, 5000);                // never wait forever on a bad file
      } else {
        const img = new Image();
        img.src = url;
        const show = () => { if (tok !== token) return; s.el.style.backgroundImage = 'url("' + url.replace(/"/g, '\\"') + '")'; go(); };
        if (img.decode) img.decode().then(show, show); else { img.onload = show; img.onerror = show; }
      }
    }

    // A media slide covers the screen: pause the background instead of
    // unloading it, so coming back to the song is instant.
    function pause() { slots.forEach(s => { if (!s.v.paused) s.v.pause(); }); }

    function clear(durMs) {
      const dur = durMs === undefined ? 0 : Math.max(0, Number(durMs) || 0);
      token++;
      pendingKey = null; shownKey = null;
      slots.forEach(s => {
        s.el.style.opacity = "0";
        const t = s.tok;
        if (dur) setTimeout(() => { if (s.tok === t && s.el.style.opacity === "0") unload(s); }, dur + 80);
        else unload(s);
      });
    }

    return { set, pause, clear };
  }
  window.createBgStage = createBgStage;
})();
