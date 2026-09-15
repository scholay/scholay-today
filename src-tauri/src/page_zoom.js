() => {
  const MIN = 0.3;
  const MAX = 3;
  const STEP = 0.1;
  const SLACK = 8;
  let factor = 1;
  let mode = "fit";
  let fitTimer = 0;

  function root() {
    return document.documentElement;
  }

  function clamp(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    return Math.min(MAX, Math.max(MIN, Math.round(n * 100) / 100));
  }

  function snapshot() {
    return { factor, mode };
  }

  function apply() {
    const next = String(factor);
    if (root().style.zoom !== next) root().style.zoom = next;
    return snapshot();
  }

  function measure() {
    const node = root();
    const previous = node.style.zoom;
    node.style.zoom = "1";
    const width = Math.max(node.scrollWidth || 0, document.body ? document.body.scrollWidth || 0 : 0);
    node.style.zoom = previous;
    return width;
  }

  function ensureViewport() {
    if (!document.head || document.querySelector('meta[name="viewport"]')) return;
    const meta = document.createElement("meta");
    meta.setAttribute("name", "viewport");
    meta.setAttribute("content", "width=device-width, initial-scale=1");
    document.head.appendChild(meta);
  }

  function fit() {
    const view = window.innerWidth || 0;
    const content = measure();
    factor = content > view + SLACK && view > 0 ? clamp(view / content) : 1;
    mode = "fit";
    return apply();
  }

  function set(next) {
    factor = clamp(next);
    mode = "manual";
    return apply();
  }

  function adjust(delta) {
    return set(factor + (Number.isFinite(delta) ? delta : 0));
  }

  function reset() {
    return set(1);
  }

  function read() {
    return snapshot();
  }

  function scheduleFit() {
    if (mode !== "fit") return;
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      fitTimer = 0;
      if (mode === "fit") fit();
    }, 60);
  }

  ensureViewport();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureViewport, { once: true });
  }

  window.addEventListener("resize", scheduleFit);
  if (typeof ResizeObserver === "function" && document.documentElement) {
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(document.documentElement);
  }

  window.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.isComposing) return;
    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      adjust(-STEP);
    } else if (event.key === "=" || event.key === "+") {
      event.preventDefault();
      adjust(STEP);
    } else if (event.key === "0") {
      event.preventDefault();
      reset();
    }
  }, true);

  window.addEventListener("wheel", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    adjust(event.deltaY < 0 ? STEP : -STEP);
  }, { passive: false, capture: true });

  return { fit, set, adjust, reset, read };
}
