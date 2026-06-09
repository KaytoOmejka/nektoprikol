"use strict";

/**
 * content.js — изолированный мир расширения.
 *
 * Делает две вещи:
 *  1. Вставляет inject.js в МИР СТРАНИЦЫ. Это обязательно: объекты
 *     RTCPeerConnection живут в контексте страницы nekto, а из изолированного
 *     мира content-скрипта до них не дотянуться.
 *  2. Работает «мостом» сообщений: страница (window.postMessage) ↔ фон
 *     (browser.runtime). Сам по себе inject.js не имеет доступа к runtime, а
 *     content.js — имеет.
 */

const api = globalThis.browser || globalThis.chrome;

// --- 1) инъекция мозга в страницу ---
const s = document.createElement("script");
s.src = api.runtime.getURL("inject.js");
s.onload = () => s.remove();
(document.head || document.documentElement).appendChild(s);

// --- 2a) страница → фон ---
window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const m = e.data;
  if (!m || m.__nektoBridge !== "page") return;
  // payload уезжает в background.js (там известно, от какой вкладки)
  try {
    api.runtime.sendMessage(m.payload);
  } catch (_) {}
});

// --- 2b) фон → страница ---
api.runtime.onMessage.addListener((msg) => {
  window.postMessage({ __nektoBridge: "ext", payload: msg }, "*");
});
