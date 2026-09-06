const SCRIPT = `(() => {
  "use strict";

  const PATHS = new Set(["/accelstretch", "/secure-checkout"]);
  if (!PATHS.has(location.pathname)) return;

  const ENDPOINT = "https://api.flexiblest.io/api/web-vitals";
  const LIBRARY = "https://unpkg.com/web-vitals@6.2.0/dist/web-vitals.iife.js";
  const SAMPLE_KEY = "fs_rum_sample_v2";
  const FORCE_KEY = "fs_rum_force_v2";
  const params = new URLSearchParams(location.search);

  let storedAttribution = {};
  try {
    storedAttribution = JSON.parse(localStorage.getItem("fs_attribution_data") || "{}") || {};
  } catch (_) {}

  const userAgent = navigator.userAgent || "";
  const sourceText = (
    params.get("utm_source") ||
    params.get("site_source_name") ||
    params.get("comet_source") ||
    storedAttribution.utm_source ||
    storedAttribution.site_source_name ||
    storedAttribution.comet_source ||
    document.referrer ||
    ""
  ).toLowerCase();

  const source = /instagram/.test(sourceText + " " + userAgent)
    ? "instagram"
    : /facebook|fbav|fban/.test(sourceText + " " + userAgent)
      ? "facebook"
      : /meta/.test(sourceText)
        ? "meta"
        : sourceText
          ? "other"
          : "direct";

  let forced = params.get("rum_test") === "1";
  try {
    if (forced) {
      sessionStorage.setItem(FORCE_KEY, "1");
    } else {
      forced = sessionStorage.getItem(FORCE_KEY) === "1";
    }
  } catch (_) {}

  const sampleRate = forced ? 1 : 0.25;

  let sampled = forced;
  if (!forced) {
    try {
      const existing = sessionStorage.getItem(SAMPLE_KEY);
      if (existing === "1" || existing === "0") {
        sampled = existing === "1";
      } else {
        sampled = Math.random() < sampleRate;
        sessionStorage.setItem(SAMPLE_KEY, sampled ? "1" : "0");
      }
    } catch (_) {
      sampled = Math.random() < sampleRate;
    }
  }

  if (!sampled) return;

  const device = innerWidth < 768 ? "mobile" : innerWidth < 992 ? "tablet" : "desktop";
  const navigation = performance.getEntriesByType("navigation")[0];
  const pending = new Map();
  let flushTimer = 0;

  function queueMetric(metric, value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return;
    pending.set(metric, number);
    scheduleFlush(700);
  }

  function payloadFromPending() {
    const events = Array.from(pending, ([metric, value]) => ({ metric, value }));
    if (!events.length) return null;
    pending.clear();

    return {
      path: location.pathname,
      device,
      source,
      inApp: /FBAN|FBAV|Instagram/i.test(userAgent),
      navigationType: navigation?.type || "",
      viewportWidth: innerWidth,
      sampleRate,
      events
    };
  }

  function sendBatch() {
    clearTimeout(flushTimer);
    flushTimer = 0;

    const payload = payloadFromPending();
    if (!payload) return;

    const body = JSON.stringify(payload);

    try {
      if (
        navigator.sendBeacon &&
        navigator.sendBeacon(
          ENDPOINT,
          new Blob([body], { type: "text/plain;charset=UTF-8" })
        )
      ) {
        return;
      }
    } catch (_) {}

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body,
      keepalive: true,
      credentials: "omit",
      mode: "cors"
    }).catch(() => {});
  }

  function scheduleFlush(delay) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(sendBatch, delay);
  }

  function hookCheckoutTimings() {
    if (location.pathname !== "/secure-checkout") return;

    const container = document.getElementById("fsu-checkout-container");
    if (!container) return;

    let initialReadySent = false;
    let bumpStartedAt = 0;

    function checkReady() {
      const frame = container.querySelector(".fsu-paypro-frame.is-ready");
      if (!frame) return;

      if (!initialReadySent) {
        initialReadySent = true;
        queueMetric("IFRAME", performance.now());
      }

      if (bumpStartedAt > 0) {
        queueMetric("BUMP", performance.now() - bumpStartedAt);
        bumpStartedAt = 0;
      }
    }

    const observer = new MutationObserver(checkReady);
    observer.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"]
    });

    function markBumpStart(event) {
      const topBar = event.target?.closest?.(".bump-top-bar");
      if (!topBar) return;

      if (
        event.type === "keydown" &&
        event.key !== "Enter" &&
        event.key !== " "
      ) {
        return;
      }

      bumpStartedAt = performance.now();
    }

    document.addEventListener("click", markBumpStart, true);
    document.addEventListener("keydown", markBumpStart, true);
    checkReady();
  }

  function loadVitals() {
    if (window.webVitals) {
      startVitals();
      return;
    }

    const script = document.createElement("script");
    script.src = LIBRARY;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = startVitals;
    script.onerror = () => {};
    document.head.appendChild(script);
  }

  let vitalsStarted = false;
  function startVitals() {
    if (vitalsStarted || !window.webVitals) return;
    vitalsStarted = true;

    const report = metric => queueMetric(metric.name, metric.value);

    webVitals.onCLS(report);
    webVitals.onINP(report);
    webVitals.onLCP(report);
    webVitals.onFCP(report);
    webVitals.onTTFB(report);
  }

  hookCheckoutTimings();

  if (document.readyState === "complete") {
    if ("requestIdleCallback" in window) {
      requestIdleCallback(loadVitals, { timeout: 1500 });
    } else {
      setTimeout(loadVitals, 0);
    }
  } else {
    addEventListener("load", () => {
      if ("requestIdleCallback" in window) {
        requestIdleCallback(loadVitals, { timeout: 1500 });
      } else {
        setTimeout(loadVitals, 0);
      }
    }, { once: true });
  }

  addEventListener("pagehide", sendBatch);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") sendBatch();
  });
})();`;

export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end();
  }

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(200).send(SCRIPT);
}
