"use strict";

const $ = (id) => document.getElementById(id);
const STATE_LABEL = {
  connecting: "подключение…",
  authed: "вход выполнен",
  searching: "ищет собеседника…",
  chatting: "общается",
  left: "собеседник вышел",
  closed: "отключён",
};

let ws = null;
let audioOn = false; // включён ли аудиорежим в текущей сессии

// ---------- WebSocket с сервером ----------
function connectWS() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => sys("Соединение с сервером потеряно. Перезагрузи страницу.");
}

function sendWS(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------- Обработка сообщений сервера ----------
function handle(m) {
  switch (m.type) {
    case "message":
      addMessage(m.from, m.text, m.injected);
      break;
    case "status":
      setStatus(m.side, m.state);
      break;
    case "typing":
      setTyping(m.from, m.typing);
      break;
    case "system":
      sys(m.text);
      break;
    case "raw":
      // отладочный лог в консоль — помогает, если nekto поменяет протокол
      console.debug("[nekto raw]", m.side, m.notice, m.payload);
      break;
    case "signal":
      // аудио-сигналинг (SDP/ICE) для конкретной стороны → в WebRTC-слой
      if (audioOn) AudioBridge.onSignal(m.side, m.signal);
      break;
  }
}

// ---------- Рендер ----------
function nowHHMM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function addMessage(from, text, injected) {
  const el = document.createElement("div");
  el.className = `msg from-${from}` + (injected ? " injected" : "");
  const who = `Собеседник ${from}` + (injected ? `<span class="tag">вставлено</span>` : "");
  el.innerHTML =
    `<span class="avatar a${from}">${from}</span>` +
    `<div class="bubble">` +
      `<span class="who">${who}</span>` +
      `<span class="body">${escapeHtml(text)}</span>` +
      `<span class="time">${nowHHMM()}</span>` +
    `</div>`;
  appendToFeed(el);
}

function sys(text) {
  const el = document.createElement("div");
  el.className = "sys";
  el.textContent = text;
  appendToFeed(el);
}

// общий хвост: добавить в ленту и доскроллить контейнер вниз
function appendToFeed(el) {
  $("feed").appendChild(el);
  const log = $("log");
  log.scrollTop = log.scrollHeight;
}

function setStatus(side, state) {
  const el = $(`status-${side}`);
  if (!el) return;
  el.className = `badge s-${state}`;
  el.querySelector(".state").textContent = STATE_LABEL[state] || state;
}

const typingTimers = {};
function setTyping(side, typing) {
  const el = $(`status-${side}`);
  if (!el) return;
  el.classList.toggle("typing", !!typing);
  clearTimeout(typingTimers[side]);
  if (typing) {
    typingTimers[side] = setTimeout(() => el.classList.remove("typing"), 4000);
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// плавное переключение экранов (перезапуск анимации появления)
function showScreen(showId, hideId) {
  $(hideId).classList.add("hidden");
  const show = $(showId);
  show.classList.remove("hidden", "anim-in");
  void show.offsetWidth; // форсируем reflow, чтобы анимация проигралась заново
  show.classList.add("anim-in");
}

// открыть окно nekto.me рядом (для прогрева аккаунта и получения токена)
function openNekto(n) {
  const w = 480, h = 760;
  const left = Math.max(0, (window.screen.availWidth || 1280) / 2 + (n === 1 ? -w - 12 : 12));
  window.open(
    "https://nekto.me/chat",
    `nekto${n}`,
    `width=${w},height=${h},left=${Math.round(left)},top=60`
  );
}
$("open-nekto-1").onclick = () => openNekto(1);
$("open-nekto-2").onclick = () => openNekto(2);
$("open-nekto-w").onclick = () => openNekto(1);

// ---------- Сбор параметров ----------
function num(id) {
  const v = parseInt($(id).value, 10);
  return Number.isFinite(v) ? v : null;
}

function searchParams(p) {
  const out = {};
  const sex = $(`${p}-sex`).value;
  const wsex = $(`${p}-wsex`).value;
  const aMin = num(`${p}-age-min`), aMax = num(`${p}-age-max`);
  const wMin = num(`${p}-wage-min`), wMax = num(`${p}-wage-max`);
  if (sex) out.mySex = sex;
  if (wsex) out.wishSex = wsex;
  if (aMin && aMax) out.myAge = [aMin, aMax];
  if (wMin && wMax) out.wishAge = [[wMin, wMax]];
  return out;
}

// ---------- Кнопки ----------
$("connect").onclick = () => {
  const a = { token: $("a-token").value, ua: $("a-ua").value, search: searchParams("a") };
  const b = { token: $("b-token").value, ua: $("b-ua").value, search: searchParams("b") };
  if (!a.token.trim() || !b.token.trim()) {
    alert("Нужны оба токена.");
    return;
  }
  const relay = $("relay").checked;
  $("relay-toggle").checked = relay;
  audioOn = $("audio").checked;
  sendWS({ type: "connect", a, b, relay, audio: audioOn });

  // аудио-слой поднимаем в браузере: он шлёт сигналинг через наш WS
  $("audio-bar").classList.toggle("hidden", !audioOn);
  if (audioOn) {
    AudioBridge.start((side, signal) => sendWS({ type: "signal", side, signal }));
  }
  showScreen("work", "setup");
};

function doSend() {
  const text = $("text").value.trim();
  if (!text) return;
  sendWS({ type: "send", as: $("as").value, text });
  $("text").value = "";
  $("text").focus();
}

$("send").onclick = doSend;

// окрасить композер под выбранную сторону («пишу как…»)
function paintComposer() {
  $("composer").dataset.side = $("as").value;
}
$("as").onchange = paintComposer;
paintComposer();

$("text").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    doSend();
  } else if (e.key === "Tab") {
    // Tab прямо в поле ввода переключает сторону, от лица которой пишем
    e.preventDefault();
    $("as").value = $("as").value === "1" ? "2" : "1";
    paintComposer();
  }
});

// индикатор «печатает» партнёру, пока оператор набирает
let typingSent = false, typingOff = null;
$("text").addEventListener("input", () => {
  const as = $("as").value;
  if (!typingSent) {
    sendWS({ type: "typing", as, typing: true });
    typingSent = true;
  }
  clearTimeout(typingOff);
  typingOff = setTimeout(() => {
    sendWS({ type: "typing", as, typing: false });
    typingSent = false;
  }, 1500);
});

$("relay-toggle").onchange = (e) => sendWS({ type: "relay", enabled: e.target.checked });
$("skip").onclick = () => sendWS({ type: "skip" });
// персональный поиск нового собеседника для одной стороны
document.querySelectorAll(".badge-search").forEach((btn) => {
  btn.onclick = () => sendWS({ type: "search", side: btn.dataset.side });
});
$("stop").onclick = () => {
  sendWS({ type: "stop" });
  if (audioOn) AudioBridge.stop();
  audioOn = false;
  $("audio-bar").classList.add("hidden");
  showScreen("setup", "work");
};

// ---------- Микрофон (мой голос слышат оба собеседника) ----------
$("mic").onclick = async () => {
  const on = await AudioBridge.setMic(!AudioBridge.isMicOn());
  if (!on && !AudioBridge.isMicOn()) {
    // запрос мог быть отклонён — сообщаем оператору
    sys("Не удалось включить микрофон (нет доступа?).");
  }
  const btn = $("mic");
  btn.classList.toggle("mic-on", on);
  btn.classList.toggle("mic-off", !on);
  btn.textContent = on ? "🎙 Микрофон: вкл (слышат оба)" : "🎙 Микрофон: выкл";
};

// ---------- Старт ----------
$("a-ua").value = navigator.userAgent;
$("b-ua").value = navigator.userAgent;
connectWS();
