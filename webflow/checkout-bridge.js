/* FLEXIBLEST ATTRIBUTION BRIDGE v2: separate ad and visitor identifiers */
(function () {
  "use strict";

  if (window.__flexiblestAttributionBridgeInstalled) {
    return;
  }

  window.__flexiblestAttributionBridgeInstalled = true;

  var STORAGE_KEY = "fs_attribution_data";
  var FUNNEL_SESSION_URL =
    "https://api.flexiblest.io/api/paypro-funnel-session";
  var PAYPRO_HOST = "store.payproglobal.com";
  var DATA_KEYS = [
    "comet_token",
    "comet_fingerprint",
    "comet_source",
    "comet_ad_id",
    "comet_placement",
    "site_source_name",
    "ad_id",
    "placement",
    "cometly_click_id",
    "fbclid",
    "fbc",
    "fbp",
    "gclid",
    "gbraid",
    "wbraid",
    "ttclid",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "campaign_id",
    "adset_id"
  ];

  function clean(value) {
    return String(value || "").trim().slice(0, 2000);
  }

  function readStored() {
    try {
      var value = JSON.parse(
        window.localStorage.getItem(STORAGE_KEY) || "{}"
      );

      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
    } catch (error) {
      return {};
    }
  }

  function writeStored(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch (error) {}
  }

  function pageUrl() {
    return window.location.origin + window.location.pathname;
  }

  function param(params, names) {
    for (var i = 0; i < names.length; i += 1) {
      var value = clean(params.get(names[i]));

      if (value) {
        return value;
      }
    }

    return "";
  }

  function resolveFacebookClick(urlClick, storedClick, cookieFbc, storedFbc) {
    function click(value) {
      return typeof value === "string" && /^[A-Za-z0-9_.~-]{1,2000}$/.test(value)
        ? value : "";
    }
    function parse(value) {
      var match = typeof value === "string" && value.match(/^fb\.[0-9]+\.([0-9]+)\.(.+)$/);
      return match && Number(match[1]) > 0 && click(match[2])
        ? { value: value, click: match[2], time: Number(match[1]) } : null;
    }
    var cookie = parse(cookieFbc), stored = parse(storedFbc);
    var candidates = [cookie, stored].filter(Boolean);
    var currentClick = click(urlClick), previousClick = click(storedClick);
    var id = currentClick || previousClick;
    // With no current URL click, do not overwrite a newer coherent cookie
    // with an older coherent stored pair. An inconsistent stored pair may
    // be a landing click awaiting reconciliation from the previous code.
    if (!currentClick && cookie && (!previousClick || (stored && stored.click === previousClick)) &&
        (!stored || cookie.time > stored.time)) id = cookie.click;
    if (!id && candidates.length) id = candidates[0].click;
    if (!id) return { fbclid: "", fbc: "" };
    var existing = candidates.filter(function (candidate) { return candidate.click === id; })[0];
    // Keep a stable timestamp even when browser storage/cookies are blocked.
    var cached = resolveFacebookClick.last;
    var result = { fbclid: id, fbc: existing ? existing.value :
      cached && cached.fbclid === id ? cached.fbc : "fb.1." + Date.now() + "." + id };
    resolveFacebookClick.last = result;
    return result;
  }

  function captureAttribution() {
    var stored = readStored();
    var params = new URLSearchParams(window.location.search);
    var next = Object.assign({}, stored);
    var aliases = {
      comet_token: ["comet_token", "cometly_token"],
      comet_fingerprint: ["comet_fingerprint", "cometly_fingerprint", "fingerprint"],
      comet_source: ["comet_source", "site_source_name", "utm_source"],
      comet_ad_id: ["comet_ad_id", "ad_id"],
      comet_placement: ["comet_placement", "placement"],
      site_source_name: ["site_source_name"],
      ad_id: ["ad_id", "comet_ad_id"],
      placement: ["placement", "comet_placement"],
      cometly_click_id: ["cometly_click_id", "cometly_id"]
    };

    DATA_KEYS.forEach(function (key) {
      var value = aliases[key]
        ? param(params, aliases[key])
        : clean(params.get(key));

      if (value) {
        next[key] = value;
      }
    });

    // Keep the click and its fbc consistent before any session/iframe capture.
    // Only read existing cookies here; cookie writing remains in checkout.
    var cookieFbc = "";
    try {
      var match = String(document.cookie || "").match(/(?:^|;\s*)_fbc=([^;]*)/);
      if (match) cookieFbc = decodeURIComponent(match[1]);
    } catch (error) {}
    var facebookClick = resolveFacebookClick(params.get("fbclid"), stored.fbclid, cookieFbc, stored.fbc);
    next.fbclid = facebookClick.fbclid;
    next.fbc = facebookClick.fbc;

    // Read identifiers only from the installed pixel; never synthesize them.
    try {
      if (typeof window.cometToken === "function") {
        var token = window.cometToken();
        if (typeof token === "string" && clean(token)) next.comet_token = clean(token);
      }
    } catch (error) {}
    if (pixelFingerprint) next.comet_fingerprint = pixelFingerprint;
    if (/^(fb|ig|facebook|instagram|meta|an|audience_network|messenger)$/i.test(next.comet_source || next.utm_source || "")) {
      next.comet_ad_id = [next.comet_ad_id, next.ad_id].filter(function(value) {
        return /^[0-9]+$/.test(value || "");
      })[0] || "";
    }

    if (!next.landing_page_url) {
      next.landing_page_url = pageUrl();
    }

    next.latest_page_url = pageUrl();
    next.latest_referrer = clean(document.referrer);
    next.first_referrer =
      clean(stored.first_referrer) || clean(document.referrer);
    next.updated_at = new Date().toISOString();

    writeStored(next);
    return next;
  }

  var pixelFingerprint = "";
  var fingerprintPending = false;
  var attribution = captureAttribution();
  var lastSavedAttribution = "";
  var savePending = false;
  var retryAfter = 0;
  var completedSession = "";

  function refreshPixelIdentity() {
    attribution = captureAttribution();
    if (!pixelFingerprint && !fingerprintPending && typeof window.cometFingerprint === "function") {
      fingerprintPending = true;
      Promise.resolve().then(function () { return window.cometFingerprint(); }).then(function(value) {
        if (typeof value === "string" && clean(value)) pixelFingerprint = clean(value);
      }).catch(function () {}).finally(function () { fingerprintPending = false; });
    }
    // Late pixel readiness must not reload a payment form already in use.
    // Save to the same authenticated session that all purchase/upsell IPNs use.
    if (window.location.pathname !== "/secure-checkout" || savePending || Date.now() < retryAfter) return;
    if (!attribution.comet_token && !attribution.comet_fingerprint) return;
    try {
      var sessionId = window.sessionStorage.getItem("fs_session_id");
      var intentId = window.sessionStorage.getItem("fs_checkout_intent_id");
      var accessToken = window.sessionStorage.getItem("fs_funnel_access_token");
      if (!sessionId || !intentId || !accessToken || sessionId === completedSession) return;
      var identity = {};
      DATA_KEYS.forEach(function(key) { if (attribution[key]) identity[key] = attribution[key]; });
      var signature = sessionId + JSON.stringify(identity);
      if (signature === lastSavedAttribution || typeof nativeFetch !== "function") return;
      savePending = true;
      nativeFetch.call(window, FUNNEL_SESSION_URL, {
        method: "POST", mode: "cors", credentials: "omit", cache: "no-store", keepalive: true,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
        body: JSON.stringify({ action: "save_attribution", fs_session_id: sessionId,
          fs_checkout_intent_id: intentId, attribution: identity })
      }).then(function(response) {
        if (response.ok) lastSavedAttribution = signature;
        if (response.status === 409) completedSession = sessionId;
      }).catch(function () {}).finally(function () {
        savePending = false;
        retryAfter = Date.now() + 5000;
      });
    } catch (error) { savePending = false; }
  }

  function injectAttribution(body) {
    if (!body || typeof body !== "object") {
      return body;
    }

    attribution = captureAttribution();
    var next = Object.assign({}, body);
    next.attribution = Object.assign(
      {},
      body.attribution || body.attribution_data || {},
      attribution
    );
    next.page_url = next.page_url || window.location.href;
    next.referrer_url = next.referrer_url || document.referrer;
    return next;
  }

  var nativeFetch = window.fetch;

  if (typeof nativeFetch === "function") {
    window.fetch = function (input, init) {
      var requestUrl =
        typeof input === "string"
          ? input
          : input && input.url
            ? input.url
            : "";

      if (
        requestUrl === FUNNEL_SESSION_URL &&
        init &&
        typeof init.body === "string"
      ) {
        try {
          var body = JSON.parse(init.body);

          if (
            body.action === "create" ||
            body.action === "save_checkout_email"
          ) {
            init = Object.assign({}, init, {
              body: JSON.stringify(injectAttribution(body))
            });
          }
        } catch (error) {}
      }

      return nativeFetch.call(this, input, init);
    };
  }

  function addPayProAttribution(node) {
    if (!node || node.nodeType !== 1 || node.tagName !== "IFRAME") {
      return;
    }

    if (node.isConnected) return;
    attribution = captureAttribution();
    var source = node.getAttribute("src") || "";

    if (!source) {
      return;
    }

    try {
      var url = new URL(source, window.location.href);

      if (url.hostname !== PAYPRO_HOST || url.pathname !== "/checkout") {
        return;
      }

      [
        ["x-comet_token", attribution.comet_token],
        ["x-comet_fingerprint", attribution.comet_fingerprint],
        ["x-comet_source", attribution.comet_source],
        ["x-comet_ad_id", attribution.comet_ad_id],
        ["x-comet_placement", attribution.comet_placement],
        ["x-site_source_name", attribution.site_source_name],
        ["x-ad_id", attribution.ad_id],
        ["x-placement", attribution.placement]
      ].forEach(function (entry) {
        if (entry[1] && !url.searchParams.get(entry[0])) {
          url.searchParams.set(entry[0], clean(entry[1]));
        }
      });

      var nextSource = url.toString();

      if (nextSource !== source) {
        node.setAttribute("src", nextSource);
      }
    } catch (error) {}
  }

  var nativeAppendChild = Node.prototype.appendChild;

  Node.prototype.appendChild = function (child) {
    addPayProAttribution(child);
    return nativeAppendChild.call(this, child);
  };

  if (typeof MutationObserver === "function") {
    new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        if (mutation.type === "attributes") {
          addPayProAttribution(mutation.target);
        }

        (mutation.addedNodes || []).forEach(function (node) {
          addPayProAttribution(node);
        });
      });
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src"]
    });
  }

  function wrapCometly() {
    if (
      typeof window.comet !== "function" ||
      window.comet.__flexiblestAttributionBridge
    ) {
      return;
    }

    var nativeComet = window.comet;
    var wrappedComet = function (eventName, payload) {
      attribution = captureAttribution();
      var nextPayload =
        payload && typeof payload === "object"
          ? Object.assign({}, payload, attribution)
          : payload;

      return nativeComet.call(this, eventName, nextPayload);
    };

    wrappedComet.__flexiblestAttributionBridge = true;
    window.comet = wrappedComet;
  }

  wrapCometly();
  refreshPixelIdentity();
  window.setInterval(function () { wrapCometly(); refreshPixelIdentity(); }, 1000);
})();