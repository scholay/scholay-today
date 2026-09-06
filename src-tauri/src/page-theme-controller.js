// Factory kept independent of the bundled engine for deterministic lifecycle tests.
(createEngine) => {
  let enabled = false;
  let engine = null;
  let running = false;
  let timer = null;
  let observer = null;
  let paintObserver = null;
  let paintReady = true;
  let paintTimeout = null;
  let lastStyleChange = 0;
  const requests = new Set();
  let fetchCount = 0;

  function finishPaint() {
    paintReady = true;
    if (paintTimeout !== null) clearTimeout(paintTimeout);
    paintTimeout = null;
    paintObserver?.disconnect();
    paintObserver = null;
  }

  function watchFirstPaint() {
    if (paintReady) return;
    lastStyleChange = Date.now();
    // Only the stylesheet container, only until the first adapted paint. Do
    // not rescan article content or wait for ads, images, or window.load.
    paintObserver = new MutationObserver(() => { lastStyleChange = Date.now(); });
    paintObserver.observe(document.head || document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
  }

  function stopWaiting() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    observer?.disconnect();
    observer = null;
    document.removeEventListener('DOMContentLoaded', schedule);
  }

  function nativeDark() {
    // Do not take over a website's own Dark Reader instance.
    if (document.querySelector('meta[name="darkreader"], style.darkreader')) return true;
    // Inspect the content surface first: a dark navbar alone is not dark mode.
    const content = document.querySelector('article, main, [role="main"]');
    for (const element of [content, document.body, document.documentElement]) {
      if (!element) continue;
      const match = getComputedStyle(element).backgroundColor.match(/^rgba?\(([^)]+)\)$/);
      if (!match) continue;
      const values = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if (values.length > 3 && values[3] < 0.8) continue;
      const [r, g, b] = values;
      if (![r, g, b].every(Number.isFinite)) continue;
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 95;
    }
    return false;
  }

  function apply() {
    timer = null;
    if (!enabled || running || !document.body) return;
    if (nativeDark()) {
      finishPaint();
      // A native-themed SPA can later switch its root theme. Observe only the
      // two theme roots, never scan the full document on every DOM mutation.
      if (!observer) {
        observer = new MutationObserver(schedule);
        for (const node of [document.documentElement, document.body]) {
          observer.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-mode', 'data-color-mode'] });
        }
      }
      return;
    }
    stopWaiting();
    try {
      watchFirstPaint();
      engine ??= createEngine();
      engine.setFetchMethod(async (raw) => {
        const url = new URL(raw, location.href);
        if (!enabled || ++fetchCount > 64 || !/^https?:$/.test(url.protocol) || url.username || url.password) {
          throw new Error('Web theme resource unavailable');
        }
        // Browser CORS stays intact. Never use a native proxy, send cookies,
        // fetch scripts, or contact a Dark Reader service/CDN.
        const controller = new AbortController();
        requests.add(controller);
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          return await fetch(url.href, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
        } finally {
          clearTimeout(timeout);
          requests.delete(controller);
        }
      });
      engine.enable({
        brightness: 100, contrast: 100, sepia: 0, grayscale: 0,
        darkSchemeBackgroundColor: '#1d1e1f', darkSchemeTextColor: '#e8e6e3',
        useFont: false,
        // Native view stays hidden during preparation (including Markdown
        // capture). Dark Reader must not wait for document.visibilityState.
        immediateModify: true,
      }, {
        invert: [], css: '', ignoreInlineStyle: [],
        // Keep photos, diagrams, videos and canvas content in original colours.
        ignoreImageAnalysis: ['*'], disableStyleSheetsProxy: true,
      });
      running = true;
    } catch (_) {
      // A styling failure must never break navigation or the original content.
      try { engine?.disable(); } catch (_) {}
      running = false;
      finishPaint();
    }
  }

  function schedule() {
    if (!enabled || running || timer !== null) return;
    timer = setTimeout(apply, 100);
  }

  return {
    isReadyToDisplay() {
      if (paintReady || !enabled) return true;
      // The pinned engine empties its fallback after the initial stylesheet
      // render. Also allow asynchronous CSS fetches and a quiet style interval
      // to finish. Timers work in hidden native views; rAF may be suspended.
      const fallback = document.querySelector('style.darkreader--fallback');
      if (running && !requests.size && fallback && !fallback.textContent.trim()
          && Date.now() - lastStyleChange >= 120) finishPaint();
      return paintReady;
    },
    setEnabled(value) {
      if (value === true && !enabled) {
        paintReady = false;
        paintTimeout = setTimeout(finishPaint, 8000);
      }
      enabled = value === true;
      if (!enabled) {
        finishPaint();
        stopWaiting();
        for (const request of requests) request.abort();
        requests.clear();
        if (running) {
          try { engine.disable(); } finally { running = false; }
        }
        return;
      }
      if (running) return;
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', schedule, { once: true });
      } else schedule();
    },
  };
}
