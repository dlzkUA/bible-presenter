// Small presentation helpers for the control window.
(function () {
  "use strict";
  // Sliders fill up to the thumb. The fill is a CSS variable, so it has to
  // follow the value however it changes: dragging, the keyboard, or code
  // that sets .value directly (loading a theme, resetting a panel).
  function paint(el) {
    const min = Number(el.min || 0), max = Number(el.max || 100), v = Number(el.value);
    const p = max > min ? ((v - min) / (max - min)) * 100 : 0;
    el.style.setProperty("--p", Math.max(0, Math.min(100, p)) + "%");
  }
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (desc && desc.set) {
    Object.defineProperty(HTMLInputElement.prototype, "value", {
      configurable: true, enumerable: desc.enumerable, get: desc.get,
      set(v) { desc.set.call(this, v); if (this.type === "range") paint(this); },
    });
  }
  document.addEventListener("input", (e) => { if (e.target && e.target.type === "range") paint(e.target); }, true);
  const all = () => document.querySelectorAll('input[type="range"]').forEach(paint);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", all); else all();
  window.addEventListener("load", all);
})();
