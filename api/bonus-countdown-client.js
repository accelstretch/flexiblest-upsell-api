function bonusCountdownClient() {
  "use strict";

  const VERSION = "2.0.0";
  const ENDPOINT = "https://api.flexiblest.io/api/bonus-reservation";
  const STORAGE_KEY = "fs_bonus_reservation_v2";
  const LEGACY_STORAGE_KEY = "fs_bonus_reservation_expires_at";
  const RENEW_LOCK_KEY = "fs_bonus_reservation_renew_lock_v2";
  const PERIOD_MS = 24 * 60 * 60 * 1000;
  const LOCK_MS = 15000;
  const TAB_ID =
    Date.now().toString(36) + Math.random().toString(36).slice(2);

  let state = null;
  let intervalId = null;
  let syncPromise = null;
  let renewalInProgress = false;
  let lastStatusRequestAt = 0;

  function clean(value) {
    return String(value || "").trim();
  }

  function pad(value) {
    return String(Math.max(0, value)).padStart(2, "0");
  }

  function validReservationId(value) {
    return /^br_[a-f0-9]{32}$/.test(clean(value));
  }

  function validAccessToken(value) {
    return /^[A-Za-z0-9_-]{20,512}$/.test(clean(value));
  }

  function normalizeState(value) {
    if (!value || typeof value !== "object") {
      return null;
    }

    const expiresAtMs = Number(value.expires_at_ms || 0);

    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) {
      return null;
    }

    const reservationId = clean(value.reservation_id);
    const accessToken = clean(value.access_token);
    const hasServerIdentity =
      validReservationId(reservationId) && validAccessToken(accessToken);

    return {
      version: 2,
      source: hasServerIdentity ? "server" : "local",
      reservation_id: hasServerIdentity ? reservationId : "",
      access_token: hasServerIdentity ? accessToken : "",
      expires_at_ms: expiresAtMs,
      server_offset_ms: Number.isFinite(Number(value.server_offset_ms))
        ? Number(value.server_offset_ms)
        : 0,
      cycle_number: Math.max(1, Number(value.cycle_number || 1)),
      updated_at_ms: Number(value.updated_at_ms || Date.now())
    };
  }

  function readState() {
    try {
      return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY)));
    } catch (error) {
      return null;
    }
  }

  function writeState(nextState) {
    const normalized = normalizeState(nextState);

    if (!normalized) {
      return null;
    }

    normalized.updated_at_ms = Date.now();
    state = normalized;

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch (error) {}

    return normalized;
  }

  function serverNow(nextState) {
    return Date.now() + Number((nextState && nextState.server_offset_ms) || 0);
  }

  function remainingMilliseconds(nextState) {
    if (!nextState) {
      return 0;
    }

    return Math.max(0, nextState.expires_at_ms - serverNow(nextState));
  }

  function addStyles() {
    if (document.getElementById("fs-countdown-styles-v2")) {
      return;
    }

    const style = document.createElement("style");
    style.id = "fs-countdown-styles-v2";
    style.textContent = `
      @import url("https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@400;500;600&display=swap");

      [data-fs-countdown]:not([data-fs-theme="checkout"]) {
        --fs-label-color: #ffffff;
        --fs-tile-border: #e1e1e1;
        display: flex;
        justify-content: center;
        width: 100%;
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }

      [data-fs-countdown][data-fs-theme="light"] {
        --fs-label-color: #111111;
        --fs-tile-border: #b8b8b8;
      }

      [data-fs-countdown]:not([data-fs-theme="checkout"]) .fs-countdown {
        display: flex;
        align-items: flex-start;
        justify-content: center;
        gap: 6px;
        margin: 0;
        padding: 0;
        line-height: normal;
      }

      [data-fs-countdown]:not([data-fs-theme="checkout"]) .fs-countdown__unit {
        width: 54px;
        min-width: 54px;
        margin: 0;
        padding: 0;
        text-align: center;
      }

      [data-fs-countdown]:not([data-fs-theme="checkout"]) .fs-countdown__tile {
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        width: 54px;
        height: 44px;
        margin: 0;
        padding: 0;
        overflow: hidden;
        box-sizing: border-box;
        background: #ffffff;
        border: 1px solid var(--fs-tile-border);
        border-radius: 7px;
      }

      [data-fs-countdown]:not([data-fs-theme="checkout"]) .fs-countdown__number {
        display: block;
        position: relative;
        top: 1px;
        margin: 0;
        padding: 0;
        border: 0;
        color: #ff5a12;
        font-family: Arial, Helvetica, sans-serif;
        font-size: 30px;
        font-weight: 500;
        font-style: normal;
        font-variant-numeric: tabular-nums;
        font-feature-settings: "tnum" 1;
        letter-spacing: 0;
        line-height: 1;
        white-space: nowrap;
      }

      [data-fs-countdown]:not([data-fs-theme="checkout"]) .fs-countdown__label {
        display: block;
        margin: 4px 0 0;
        padding: 0;
        color: var(--fs-label-color);
        font-family: Montserrat, Arial, sans-serif;
        font-size: 9px;
        font-weight: 500;
        line-height: 1;
        text-align: center;
        text-transform: uppercase;
        white-space: nowrap;
      }

      [data-fs-countdown]:not([data-fs-theme="checkout"]) .fs-countdown__colon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 5px;
        height: 44px;
        margin: 0;
        padding: 0;
        color: #c4c4c4;
        font-family: Arial, Helvetica, sans-serif;
        font-size: 22px;
        font-weight: 400;
        line-height: 1;
      }

      [data-fs-countdown][data-fs-theme="checkout"] {
        display: block;
        width: max-content;
        max-width: 100%;
        margin: 0 auto;
        padding: 0;
        font-family: "Nunito Sans", Arial, sans-serif;
        font-synthesis: none;
      }

      [data-fs-countdown][data-fs-theme="checkout"] .fs-countdown-row {
        display: grid;
        grid-template-columns: 54px 8px 54px 8px 54px;
        align-items: start;
        justify-content: center;
        column-gap: 5px;
        width: max-content;
        margin: 0 auto;
        padding: 0;
      }

      [data-fs-countdown][data-fs-theme="checkout"] .fs-countdown-unit {
        display: grid;
        grid-template-rows: 44px 11px;
        row-gap: 4px;
        width: 54px;
        margin: 0;
        padding: 0;
      }

      [data-fs-countdown][data-fs-theme="checkout"] .fs-countdown-tile {
        box-sizing: border-box;
        display: grid;
        place-items: center;
        width: 54px;
        min-width: 54px;
        max-width: 54px;
        height: 44px;
        min-height: 44px;
        max-height: 44px;
        margin: 0;
        padding: 0 !important;
        overflow: hidden;
        background: #ffffff;
        border: 1px solid #ffd9c2;
        border-radius: 8px;
      }

      [data-fs-countdown][data-fs-theme="checkout"] .fs-countdown-value {
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        margin: 0;
        padding: 0 !important;
        color: #17191c;
        font-family: "Nunito Sans", Arial, sans-serif;
        font-size: 30px;
        font-weight: 400;
        font-style: normal;
        font-variant-numeric: tabular-nums;
        line-height: 1;
        letter-spacing: 0;
        text-align: center;
        white-space: nowrap;
        transform: translateY(1px);
      }

      [data-fs-countdown][data-fs-theme="checkout"] .fs-countdown-separator {
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 8px;
        height: 44px;
        margin: 0;
        padding: 0;
        color: #c8a892;
        font-family: "Nunito Sans", Arial, sans-serif;
        font-size: 20px;
        font-weight: 400;
        line-height: 1;
        text-align: center;
      }

      [data-fs-countdown][data-fs-theme="checkout"] .fs-countdown-label {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 54px;
        height: 11px;
        margin: 0;
        padding: 0;
        color: #17191c;
        font-family: "Nunito Sans", Arial, sans-serif;
        font-size: 9px;
        font-weight: 500;
        line-height: 11px;
        letter-spacing: 0;
        text-align: center;
        text-transform: uppercase;
        white-space: nowrap;
      }
    `;

    document.head.appendChild(style);
  }

  function salesMarkup() {
    return `
      <div class="fs-countdown" role="timer" aria-live="off">
        <div class="fs-countdown__unit">
          <div class="fs-countdown__tile">
            <span class="fs-countdown__number" data-fs-hours>24</span>
          </div>
          <span class="fs-countdown__label">Hours</span>
        </div>
        <span class="fs-countdown__colon" aria-hidden="true">:</span>
        <div class="fs-countdown__unit">
          <div class="fs-countdown__tile">
            <span class="fs-countdown__number" data-fs-minutes>00</span>
          </div>
          <span class="fs-countdown__label">Minutes</span>
        </div>
        <span class="fs-countdown__colon" aria-hidden="true">:</span>
        <div class="fs-countdown__unit">
          <div class="fs-countdown__tile">
            <span class="fs-countdown__number" data-fs-seconds>00</span>
          </div>
          <span class="fs-countdown__label">Seconds</span>
        </div>
      </div>
    `;
  }

  function checkoutMarkup() {
    return `
      <div class="fs-countdown-row" role="timer" aria-live="off">
        <div class="fs-countdown-unit">
          <div class="fs-countdown-tile">
            <span class="fs-countdown-value" data-fs-hours>24</span>
          </div>
          <span class="fs-countdown-label">Hours</span>
        </div>
        <span class="fs-countdown-separator" aria-hidden="true">:</span>
        <div class="fs-countdown-unit">
          <div class="fs-countdown-tile">
            <span class="fs-countdown-value" data-fs-minutes>00</span>
          </div>
          <span class="fs-countdown-label">Minutes</span>
        </div>
        <span class="fs-countdown-separator" aria-hidden="true">:</span>
        <div class="fs-countdown-unit">
          <div class="fs-countdown-tile">
            <span class="fs-countdown-value" data-fs-seconds>00</span>
          </div>
          <span class="fs-countdown-label">Seconds</span>
        </div>
      </div>
    `;
  }

  function mount() {
    addStyles();

    document.querySelectorAll("[data-fs-countdown]").forEach(function (root) {
      if (root.dataset.fsTimerVersion === VERSION) {
        return;
      }

      root.innerHTML =
        root.dataset.fsTheme === "checkout"
          ? checkoutMarkup()
          : salesMarkup();
      root.dataset.fsTimerVersion = VERSION;
    });

    render();
  }

  function render() {
    const remaining = remainingMilliseconds(state);
    const totalSeconds = Math.floor(remaining / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    document.querySelectorAll("[data-fs-countdown]").forEach(function (root) {
      const hoursNode = root.querySelector("[data-fs-hours]");
      const minutesNode = root.querySelector("[data-fs-minutes]");
      const secondsNode = root.querySelector("[data-fs-seconds]");

      if (hoursNode) hoursNode.textContent = pad(hours);
      if (minutesNode) minutesNode.textContent = pad(minutes);
      if (secondsNode) secondsNode.textContent = pad(seconds);
    });
  }

  function stateFromPayload(payload, previousState) {
    if (!payload || payload.ok !== true) {
      throw new Error("The timer endpoint returned an invalid response.");
    }

    const previous = previousState || {};
    const reservationId = clean(
      payload.reservation_id || previous.reservation_id
    );
    const accessToken = clean(payload.access_token || previous.access_token);
    const serverTimeMs = Date.parse(payload.server_time || "");
    const serverOffsetMs = Number.isFinite(serverTimeMs)
      ? serverTimeMs - Date.now()
      : Number(previous.server_offset_ms || 0);
    let expiresAtMs = Date.parse(payload.deadline_at || "");

    if (!Number.isFinite(expiresAtMs)) {
      const remainingSeconds = Number(payload.remaining_seconds || 0);
      expiresAtMs =
        Date.now() + serverOffsetMs + Math.max(0, remainingSeconds) * 1000;
    }

    return normalizeState({
      version: 2,
      source: "server",
      reservation_id: reservationId,
      access_token: accessToken,
      expires_at_ms: expiresAtMs,
      server_offset_ms: serverOffsetMs,
      cycle_number: Number(payload.cycle_number || previous.cycle_number || 1),
      updated_at_ms: Date.now()
    });
  }

  async function request(action, currentState) {
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json"
    };
    const body = { action: action };

    if (action !== "create") {
      if (
        !currentState ||
        !validReservationId(currentState.reservation_id) ||
        !validAccessToken(currentState.access_token)
      ) {
        const identityError = new Error("No valid timer reservation exists.");
        identityError.status = 401;
        throw identityError;
      }

      body.reservation_id = currentState.reservation_id;
      headers.Authorization = "Bearer " + currentState.access_token;
    }

    const response = await fetch(ENDPOINT, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers: headers,
      body: JSON.stringify(body)
    });

    const payload = await response.json().catch(function () {
      return {};
    });

    if (!response.ok) {
      const requestError = new Error(
        clean(payload.error) || "Timer endpoint returned " + response.status + "."
      );
      requestError.status = response.status;
      throw requestError;
    }

    return stateFromPayload(payload, currentState);
  }

  function fallbackState() {
    const latest = readState();

    if (latest && remainingMilliseconds(latest) > 0) {
      return latest;
    }

    return normalizeState({
      version: 2,
      source: "local",
      expires_at_ms: Date.now() + PERIOD_MS,
      server_offset_ms: 0,
      cycle_number: Math.max(1, Number((latest && latest.cycle_number) || 0) + 1),
      updated_at_ms: Date.now()
    });
  }

  async function synchronize(forceRenew) {
    if (syncPromise) {
      return syncPromise;
    }

    syncPromise = (async function () {
      let current = readState() || state;
      let nextState;

      try {
        if (
          current &&
          current.source === "server" &&
          validReservationId(current.reservation_id) &&
          validAccessToken(current.access_token)
        ) {
          nextState = await request(forceRenew ? "renew" : "status", current);

          if (!forceRenew && remainingMilliseconds(nextState) <= 0) {
            nextState = await request("renew", nextState);
          }
        } else if (current && remainingMilliseconds(current) > 0) {
          nextState = current;
        } else {
          nextState = await request("create", null);
        }
      } catch (error) {
        if (
          current &&
          current.source === "server" &&
          (error.status === 401 || error.status === 404)
        ) {
          try {
            nextState = await request("create", null);
          } catch (createError) {
            nextState = fallbackState();
          }
        } else if (current && remainingMilliseconds(current) > 0) {
          nextState = current;
        } else {
          nextState = fallbackState();
        }
      }

      writeState(nextState);
      render();
      lastStatusRequestAt = Date.now();
      return state;
    })();

    try {
      return await syncPromise;
    } finally {
      syncPromise = null;
    }
  }

  function acquireRenewLock() {
    try {
      const now = Date.now();
      const existing = JSON.parse(localStorage.getItem(RENEW_LOCK_KEY) || "null");

      if (
        existing &&
        existing.owner !== TAB_ID &&
        Number(existing.expires_at_ms || 0) > now
      ) {
        return false;
      }

      const candidate = {
        owner: TAB_ID,
        expires_at_ms: now + LOCK_MS
      };
      localStorage.setItem(RENEW_LOCK_KEY, JSON.stringify(candidate));

      const confirmed = JSON.parse(
        localStorage.getItem(RENEW_LOCK_KEY) || "null"
      );
      return Boolean(confirmed && confirmed.owner === TAB_ID);
    } catch (error) {
      return true;
    }
  }

  function releaseRenewLock() {
    try {
      const current = JSON.parse(localStorage.getItem(RENEW_LOCK_KEY) || "null");
      if (current && current.owner === TAB_ID) {
        localStorage.removeItem(RENEW_LOCK_KEY);
      }
    } catch (error) {}
  }

  async function renewAtZero() {
    if (renewalInProgress) {
      return;
    }

    renewalInProgress = true;

    if (!acquireRenewLock()) {
      renewalInProgress = false;
      window.setTimeout(function () {
        const latest = readState();
        if (latest) {
          state = latest;
          render();
        }
        if (!state || remainingMilliseconds(state) <= 0) {
          renewAtZero();
        }
      }, 750);
      return;
    }

    try {
      const latest = readState();

      if (latest && remainingMilliseconds(latest) > 0) {
        state = latest;
        render();
        return;
      }

      state = latest || state;
      await synchronize(true);
    } finally {
      releaseRenewLock();
      renewalInProgress = false;
    }
  }

  function tick() {
    render();

    if (!state || remainingMilliseconds(state) <= 0) {
      renewAtZero();
    }
  }

  function refreshAfterReturn() {
    const latest = readState();

    if (latest) {
      state = latest;
      render();
    }

    if (!state || remainingMilliseconds(state) <= 0) {
      renewAtZero();
      return;
    }

    if (state.source === "server" && Date.now() - lastStatusRequestAt > 30000) {
      synchronize(false);
    }
  }

  async function initialize() {
    mount();
    state = readState();
    render();

    if (intervalId) {
      window.clearInterval(intervalId);
    }
    intervalId = window.setInterval(tick, 250);

    if (!state || remainingMilliseconds(state) <= 0) {
      await renewAtZero();
    } else if (state.source === "server") {
      await synchronize(false);
    }
  }

  window.addEventListener("storage", function (event) {
    if (event.key !== STORAGE_KEY) {
      return;
    }

    const latest = readState();
    if (latest) {
      state = latest;
      render();
    }
  });

  window.addEventListener("focus", refreshAfterReturn);
  window.addEventListener("pageshow", refreshAfterReturn);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      refreshAfterReturn();
    }
  });

  window.FlexiblestBonusCountdown = {
    version: VERSION,
    mount: mount,
    refresh: function () {
      return synchronize(false);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
  } else {
    initialize();
  }
}

export default function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end("Method not allowed");
    return;
  }

  const source = "(" + bonusCountdownClient.toString() + ")();";

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800"
  );
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  res.end(source);
}
