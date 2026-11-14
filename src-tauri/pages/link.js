// The live and stage pages' connection to Bible Presenter.
//
// A WebSocket, not an EventSource: vMix gives all its browser inputs one
// shared browser, and a browser keeps at most six connections open to one
// address. Every EventSource holds one of them for good, so the seventh input
// pointing at this computer used to stay blank until another was closed.
// WebSockets don't count against that limit.
//
// The page also heals itself: a dropped or silent connection is reopened (the
// server sends something at least every 20 s), so restarting Bible Presenter
// or switching the output off and on never needs a reload in vMix or OBS.
// If WebSockets can't be used at all, it falls back to the event stream.
(function () {
  "use strict";
  window.bpLink = function (role, handlers) {
    const q = role ? "?role=" + encodeURIComponent(role) : "";
    const SILENT_MS = 50000;
    let ws = null, es = null, lastMsg = Date.now(), wait = 1000, opened = false, failures = 0, timer = 0;

    function deliver(name, data) {
      const h = handlers[name];
      if (!h) return;
      try { h(data); } catch (e) { console.error(name, e); }
    }

    function later() {
      clearTimeout(timer);
      timer = setTimeout(connect, wait);
      wait = Math.min(wait * 2, 5000);
    }

    function useEventSource() {
      if (es) return;
      es = new EventSource("/events" + q);
      Object.keys(handlers).forEach((name) => es.addEventListener(name, (e) => {
        let d = {};
        try { d = JSON.parse(e.data); } catch (err) {}
        deliver(name, d);
      }));
      // EventSource reconnects by itself; nothing to do on errors.
      es.onerror = () => {};
    }

    function connect() {
      if (!("WebSocket" in window) || (failures >= 3 && !opened)) return useEventSource();
      let me;
      try {
        me = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws" + q);
      } catch (e) {
        failures++;
        return later();
      }
      ws = me;
      lastMsg = Date.now();
      me.onopen = () => { opened = true; failures = 0; wait = 1000; };
      me.onmessage = (ev) => {
        lastMsg = Date.now();
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m && m.e && m.e !== "ping") deliver(m.e, m.d || {});
      };
      me.onerror = () => { try { me.close(); } catch (e) {} };
      me.onclose = () => {
        if (ws !== me) return;
        ws = null;
        if (!opened) failures++;
        later();
      };
    }

    // A connection that went quiet (a sleeping network, a half-open socket)
    // is replaced rather than trusted.
    setInterval(() => {
      if (ws && Date.now() - lastMsg > SILENT_MS) {
        const old = ws;
        ws = null;
        try { old.close(); } catch (e) {}
        later();
      }
    }, 5000);

    connect();
  };
})();
