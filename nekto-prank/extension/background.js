"use strict";

/**
 * background.js — координатор двух вкладок nekto.
 *
 * Сам звук между вкладками не трогает (он идёт по локальному WebRTC-loopback
 * напрямую между страницами). Задача фона — свести две вкладки в пару и
 * передавать между ними служебные сообщения:
 *   - register   : вкладка сообщает «я голосовой чат nekto»;
 *   - paired/waiting/peer-gone/too-many : статус пары (фон → вкладкам);
 *   - loop-signal: SDP/ICE для loopback (фон пересылает второй вкладке);
 *   - mic        : включить/выключить микрофон СРАЗУ В ОБЕИХ вкладках.
 *   - fx         : выбрать голосовой эффект оператора СРАЗУ В ОБЕИХ вкладках.
 *
 * Поддерживается ровно одна пара (две вкладки). Третья — игнорируется.
 */

const api = globalThis.browser || globalThis.chrome;

let pair = []; // [tabIdA, tabIdB] — порядок регистрации (0 = offerer)

function send(tabId, msg) {
  try {
    api.tabs.sendMessage(tabId, msg);
  } catch (_) {}
}

function peerOf(tabId) {
  const i = pair.indexOf(tabId);
  if (i < 0) return null;
  return pair[1 - i] ?? null;
}

function announcePair() {
  if (pair.length === 2) {
    // фиксированные роли убирают «glare» при установке loopback; index — для подписи
    send(pair[0], { type: "paired", role: "offer", index: 0 });
    send(pair[1], { type: "paired", role: "answer", index: 1 });
  } else if (pair.length === 1) {
    send(pair[0], { type: "waiting" });
  }
}

api.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null || !msg || !msg.type) return;

  switch (msg.type) {
    case "register": {
      if (!pair.includes(tabId)) {
        if (pair.length >= 2) {
          send(tabId, { type: "too-many" });
          return;
        }
        pair.push(tabId);
      }
      // даже если вкладка уже была (перезагрузка) — пересобираем пару заново
      announcePair();
      break;
    }

    case "loop-signal": {
      const other = peerOf(tabId);
      if (other != null) send(other, { type: "loop-signal", data: msg.data });
      break;
    }

    case "mic": {
      // синхронно обеим вкладкам, чтобы оператора слышали оба собеседника
      pair.forEach((id) => send(id, { type: "mic", on: !!msg.on }));
      break;
    }

    case "fx": {
      // голосовой эффект оператора — одинаковый в обеих вкладках
      pair.forEach((id) => send(id, { type: "fx", preset: msg.preset }));
      break;
    }
  }
});

// вкладку закрыли — распускаем пару и сообщаем оставшейся
api.tabs.onRemoved.addListener((tabId) => {
  const i = pair.indexOf(tabId);
  if (i < 0) return;
  pair.splice(i, 1);
  pair.forEach((id) => send(id, { type: "peer-gone" }));
});
