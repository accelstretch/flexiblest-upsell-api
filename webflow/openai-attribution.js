/* OpenAI attribution only. No events, SDK, polling, or payment navigation. */
(function () {
  "use strict";
  var KEY = "fs_openai_attribution_v1", MAX_AGE = 30 * 86400000;
  var memory = null, landing = true;
  function opaque(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(value) ? value : "";
  }
  function cookie(name) {
    try {
      var part = document.cookie.split(";").map(function (v) { return v.trim(); }).filter(function (v) { return v.indexOf(name + "=") === 0; })[0];
      return part ? decodeURIComponent(part.slice(name.length + 1)) : "";
    } catch (_) { return ""; }
  }
  function denied() {
    try { if (window.localStorage.getItem("oaiq_consent") === "false") return true; } catch (_) {}
    if (cookie("__oaiq_consent") === "false") return true;
    // Also respect consent commands queued before the installed SDK is ready.
    var q = window.oaiq && window.oaiq.q, latest;
    if (Array.isArray(q)) q.forEach(function (a) { if(a[0] === "consent") latest = a[1]; });
    return latest === false || window.fsOpenAIMeasurementAllowed === false;
  }
  window.fsGetOpenAIAttribution = function () {
    if (denied()) {
      memory = null;
      try { window.localStorage.removeItem(KEY); } catch (_) {}
      return { allowed: false };
    }
    var now = Date.now(), stored = memory;
    if (!stored) { try { stored = JSON.parse(window.localStorage.getItem(KEY)); } catch (_) {} }
    if (!stored || !opaque(stored.oppref) || !(stored.captured_at >= now - MAX_AGE && stored.captured_at <= now)) stored = {};
    var current = landing ? opaque(new URLSearchParams(window.location.search).get("oppref")) : "";
    landing = false;
    var fromCookie = opaque(cookie("__oppref"));
    // A URL click wins over an older cookie while SDK initialization catches up.
    if (current) stored = {oppref: current, captured_at: now};
    else if (!stored.oppref && fromCookie) stored = {oppref: fromCookie, captured_at: now};
    var next = {allowed:true};
    if (stored.oppref) { next.oppref = stored.oppref; next.captured_at = stored.captured_at; }
    var obref = opaque(cookie("__obref"));
    if (obref) next.obref = obref;
    memory = stored;
    var serialized = JSON.stringify(stored);
    try { if (window.localStorage.getItem(KEY) !== serialized) window.localStorage.setItem(KEY, serialized); } catch (_) {}
    return next;
  };
  window.fsGetOpenAIAttribution();
  // First-party navigation fallback when local storage is unavailable.
  if (typeof document.addEventListener === "function") document.addEventListener("click", function (event) {
    var anchor = event.target && event.target.closest && event.target.closest("a[href]");
    if (!anchor) return;
    try {
      var url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || !/^\/secure-checkout\/?$/.test(url.pathname)) return;
      var attribution = window.fsGetOpenAIAttribution();
      if (attribution.allowed && attribution.oppref) {
        url.searchParams.set("oppref", attribution.oppref);
        anchor.href = url.toString();
      }
    } catch (_) {}
  }, true);
})();
