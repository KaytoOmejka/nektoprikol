"use strict";

/**
 * inject.js — «мозг» голосового моста, работает В МИРЕ СТРАНИЦЫ nekto.
 *
 * Идея (обход шифрования сигналинга): сам сайт nekto проводит звонок как обычно
 * — со всем своим шифрованием. Мы НЕ трогаем переговоры. Мы перехватываем уже
 * готовый звук на уровне WebRTC:
 *   - входящий голос собеседника берём из ontrack;
 *   - исходящий (наш «микрофон») подменяем через RTCRtpSender.replaceTrack()
 *     на наш микс.
 *
 * Микс для ЭТОЙ вкладки (уходит нашему собеседнику) = голос ДРУГОГО собеседника
 * (приходит из второй вкладки по локальному loopback) + микрофон оператора.
 * Оператор слышит обоих «бесплатно» — каждая вкладка сама проигрывает своего
 * собеседника.
 *
 * Связь со второй вкладкой и фоном — через window.postMessage (его подхватывает
 * content.js и гоняет в background.js).
 */

(() => {
  if (window.__nektoBridgeInjected) return; // защита от двойной инъекции
  window.__nektoBridgeInjected = true;

  // нативный конструктор сохраняем ДО обёртки — им создаём свой loopback,
  // чтобы наша же обёртка его не перехватывала как звонок nekto.
  const NativePC = window.RTCPeerConnection;
  if (!NativePC) return;

  const log = (...a) => console.log("%c[мост]", "color:#4f8cff;font-weight:bold", ...a);
  const send = (payload) => window.postMessage({ __nektoBridge: "page", payload }, "*");

  // ---- состояние ----
  let ctx = null;            // AudioContext
  let mixDest = null;        // исходящий микс (→ nekto sender), = микрофон + чужой голос
  let micGain = null;        // громкость микрофона (0/1)
  let micAnalyser = null;    // для живого индикатора уровня
  let micStream = null, micSrc = null;
  let loopOutDest = null;    // что отправляем во вторую вкладку (= голос НАШЕГО собеседника)
  let loopOutSrc = null;     // источник из текущего remoteStream
  let incomingSrc = null;    // голос ДРУГОГО собеседника (из loopback)

  let nektoSender = null;    // аудио-отправитель звонка nekto (для replaceTrack)
  let micOn = false;

  let loopPC = null;         // loopback ко второй вкладке
  let loopRole = null;       // "offer" | "answer"
  let pendingSignals = [];   // сигналинг, пришедший раньше, чем создан loopPC
  let myIndex = null;        // номер вкладки в паре (0/1) — для подписи на панели

  // ---- аудио-граф ----
  function buildGraph() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    micGain = ctx.createGain();
    micGain.gain.value = 0;
    mixDest = ctx.createMediaStreamDestination();
    micGain.connect(mixDest);              // микрофон всегда в миксе (пока gain=0 — тишина)
    micAnalyser = ctx.createAnalyser();    // ветка только для индикатора уровня
    micAnalyser.fftSize = 256;
    micGain.connect(micAnalyser);
    loopOutDest = ctx.createMediaStreamDestination();
    // любой клик/нажатие по странице «разбудит» аудио (Firefox стартует ctx suspended)
    resume();
  }

  function resume() {
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  }
  document.addEventListener("click", resume, true);
  document.addEventListener("keydown", resume, true);

  async function ensureMic() {
    if (micStream) return true;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      log("микрофон недоступен", e);
      return false;
    }
    micSrc = ctx.createMediaStreamSource(micStream);
    micSrc.connect(micGain);
    return true;
  }

  async function setMic(on) {
    buildGraph();
    if (on && !(await ensureMic())) on = false;
    micOn = on;
    micGain.gain.value = on ? 1 : 0;
    resume();
    paintPanel();
  }

  // ---- loopback между вкладками (несёт звук в обе стороны одной парой PC) ----
  function teardownLoopback() {
    if (loopPC) { try { loopPC.close(); } catch (_) {} loopPC = null; }
    if (incomingSrc) { try { incomingSrc.disconnect(); } catch (_) {} incomingSrc = null; }
    pendingSignals = []; // старый сигналинг не должен попасть в новый loopPC
  }

  async function setupLoopback(role) {
    buildGraph();
    const queued = pendingSignals; // снимок ДО teardown (он очистит очередь)
    teardownLoopback();
    loopRole = role;
    loopPC = new NativePC({ iceServers: [] }); // обе вкладки на одной машине — host-кандидаты

    loopPC.onicecandidate = (e) => {
      if (e.candidate) send({ type: "loop-signal", data: { cand: e.candidate } });
    };
    loopPC.ontrack = (e) => {
      // звук ДРУГОГО собеседника → в наш исходящий микс
      const stream = e.streams[0] || new MediaStream([e.track]);
      if (incomingSrc) try { incomingSrc.disconnect(); } catch (_) {}
      incomingSrc = ctx.createMediaStreamSource(stream);
      incomingSrc.connect(mixDest);
      resume();
      setStatus("связано ✓");
      log("loopback: получаю звук второй вкладки");
    };
    loopPC.onconnectionstatechange = () => log("loopback:", loopPC.connectionState);

    // отправляем во вторую вкладку голос НАШЕГО собеседника (через loopOutDest)
    loopPC.addTrack(loopOutDest.stream.getAudioTracks()[0], loopOutDest.stream);

    if (role === "offer") {
      const offer = await loopPC.createOffer();
      await loopPC.setLocalDescription(offer);
      send({ type: "loop-signal", data: { desc: loopPC.localDescription } });
    }
    setStatus("связываюсь со второй вкладкой…");

    // применяем сигналинг, который мог прийти до создания loopPC
    for (const d of queued) onLoopSignal(d);
  }

  async function onLoopSignal(data) {
    if (!loopPC) { pendingSignals.push(data); return; } // придёт раньше setup — придержим
    try {
      if (data.desc) {
        await loopPC.setRemoteDescription(data.desc);
        if (data.desc.type === "offer") {
          const answer = await loopPC.createAnswer();
          await loopPC.setLocalDescription(answer);
          send({ type: "loop-signal", data: { desc: loopPC.localDescription } });
        }
      } else if (data.cand) {
        await loopPC.addIceCandidate(data.cand);
      }
    } catch (e) {
      log("ошибка loop-signal", e);
    }
  }

  // ---- перехват звонка nekto ----
  window.RTCPeerConnection = function (...args) {
    const pc = new NativePC(...args);
    try { hookNektoPC(pc); } catch (e) { log("hook error", e); }
    return pc;
  };
  window.RTCPeerConnection.prototype = NativePC.prototype;
  // переносим статические члены (в т.ч. неперечислимые, напр. generateCertificate),
  // чтобы обёртка вела себя как настоящий конструктор
  for (const k of Object.getOwnPropertyNames(NativePC)) {
    if (["length", "name", "prototype"].includes(k)) continue;
    try {
      Object.defineProperty(
        window.RTCPeerConnection, k, Object.getOwnPropertyDescriptor(NativePC, k)
      );
    } catch (_) {}
  }

  function hookNektoPC(pc) {
    pc.addEventListener("track", (e) => {
      if (e.track.kind !== "audio") return;
      const remote = e.streams[0] || new MediaStream([e.track]);
      setNektoCall(pc, remote);
    });
  }

  function audioSenderOf(pc) {
    const tx = pc.getTransceivers().find(
      (t) => (t.sender && t.sender.track && t.sender.track.kind === "audio") ||
             (t.receiver && t.receiver.track && t.receiver.track.kind === "audio")
    );
    if (tx) return tx.sender;
    return pc.getSenders().find((s) => !s.track || (s.track && s.track.kind === "audio")) || null;
  }

  function setNektoCall(pc, remoteStream) {
    buildGraph();
    log("перехвачен звонок nekto, ставлю мост");

    // 1) подменяем исходящий звук на наш микс (чужой голос + микрофон)
    nektoSender = audioSenderOf(pc);
    const mixTrack = mixDest.stream.getAudioTracks()[0];
    if (nektoSender && mixTrack) {
      nektoSender.replaceTrack(mixTrack).then(
        () => log("исходящий звук подменён на микс"),
        (err) => log("replaceTrack не удался", err)
      );
    } else {
      log("не нашёл аудио-отправитель — повторю при следующем треке");
    }

    // 2) голос НАШЕГО собеседника гоним во вторую вкладку
    if (loopOutSrc) try { loopOutSrc.disconnect(); } catch (_) {}
    loopOutSrc = ctx.createMediaStreamSource(remoteStream);
    loopOutSrc.connect(loopOutDest);

    resume();
    setStatus("звонок активен ✓");
  }

  // ---- сообщения от фона ----
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || m.__nektoBridge !== "ext") return;
    const msg = m.payload || {};
    switch (msg.type) {
      case "paired":
        if (typeof msg.index === "number") myIndex = msg.index;
        paintPanel();
        setupLoopback(msg.role);
        break;
      case "waiting":  setStatus("жду вторую вкладку nekto…"); break;
      case "peer-gone":teardownLoopback(); setStatus("вторая вкладка закрыта"); break;
      case "too-many": setStatus("уже есть пара вкладок — закрой лишнюю"); break;
      case "loop-signal": onLoopSignal(msg.data); break;
      case "mic":      setMic(msg.on); break;
    }
  });

  // ---- плавающая панель (в Shadow DOM, чтобы стили nekto её не ломали) ----
  let host = null, root = null;
  let statusDot = null, statusText = null, tabChip = null;
  let micBtn = null, micFill = null, panelBody = null, collapseBtn = null, card = null;
  let collapsed = false;

  const PANEL_HTML = `
<style>
  *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .card{width:250px;background:linear-gradient(180deg,#1b1f29,#15181f);color:#e6e8ee;
    border:1px solid #2a3040;border-radius:14px;box-shadow:0 14px 44px rgba(0,0,0,.55);
    overflow:hidden}
  .card.min{width:auto}
  .head{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:grab;user-select:none;
    background:rgba(255,255,255,.03);border-bottom:1px solid #2a3040}
  .head:active{cursor:grabbing}
  .card.min .head{border-bottom:none}
  .title{font-weight:700;font-size:13px;flex:1;white-space:nowrap}
  .dot{width:9px;height:9px;border-radius:50%;background:#f0c419;flex:0 0 auto;
    box-shadow:0 0 8px currentColor;transition:background .3s}
  .tab{font-size:11px;background:#222838;border:1px solid #2a3040;border-radius:20px;
    padding:2px 8px;color:#8b93a7}
  .collapse{width:22px;height:22px;border:none;border-radius:6px;background:#2a3040;color:#cfd4df;
    cursor:pointer;font-size:13px;line-height:1;padding:0}
  .collapse:hover{background:#39415a}
  .body{padding:12px}
  .statusrow{display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:12px;color:#aab2c5}
  .status{flex:1}
  .mic{width:100%;border:1px solid #2a3040;border-radius:10px;padding:12px;background:#1f2430;
    color:#e6e8ee;cursor:pointer;text-align:left;display:flex;align-items:center;gap:10px;
    transition:background .18s,border-color .18s,box-shadow .18s}
  .mic:hover{border-color:#4f8cff}
  .mic .ic{font-size:20px}
  .mic .txt{flex:1}
  .mic .label{font-weight:600;font-size:13px;display:block}
  .mic .sub{font-size:11px;color:#8b93a7}
  .mic.on{background:#b3433b;border-color:#b3433b;color:#fff;box-shadow:0 0 0 3px rgba(179,67,59,.25)}
  .mic.on .sub{color:#ffd9d5}
  .mic.on .ic{animation:pulse 1.3s ease-in-out infinite}
  @keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.18)}}
  .meter{height:5px;border-radius:3px;background:#0d0f15;margin-top:10px;overflow:hidden}
  .meter>i{display:block;height:100%;width:100%;transform-origin:left;transform:scaleX(0);
    background:linear-gradient(90deg,#6fdc8c,#f0c419,#ff7a6b);transition:transform .06s linear}
  .hint{font-size:10px;color:#69728a;margin-top:8px;line-height:1.4}
</style>
<div class="card">
  <div class="head">
    <span class="dot"></span>
    <span class="title">🎙 Голосовой мост</span>
    <span class="tab" style="display:none"></span>
    <button class="collapse" title="Свернуть / развернуть">—</button>
  </div>
  <div class="body">
    <div class="statusrow"><span class="status">запуск…</span></div>
    <button class="mic">
      <span class="ic">🎙</span>
      <span class="txt"><span class="label">Включить микрофон</span><span class="sub">нажми, чтобы говорить обоим</span></span>
    </button>
    <div class="meter"><i></i></div>
    <div class="hint">🎧 надень наушники, чтобы не было эха</div>
  </div>
</div>`;

  function loadUI() {
    try { return JSON.parse(localStorage.getItem("nektoBridgeUI")) || {}; } catch (_) { return {}; }
  }
  function saveUI(patch) {
    try { localStorage.setItem("nektoBridgeUI", JSON.stringify({ ...loadUI(), ...patch })); } catch (_) {}
  }

  function buildPanel() {
    if (host) return;
    host = document.createElement("div");
    host.style.cssText = "position:fixed;z-index:2147483647;margin:0;padding:0;";
    const saved = loadUI();
    if (saved.left != null && saved.top != null) {
      host.style.left = saved.left + "px";
      host.style.top = saved.top + "px";
    } else {
      host.style.right = "18px";
      host.style.bottom = "18px";
    }
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = PANEL_HTML;
    document.body.appendChild(host);

    card = root.querySelector(".card");
    statusDot = root.querySelector(".dot");
    statusText = root.querySelector(".status");
    tabChip = root.querySelector(".tab");
    micBtn = root.querySelector(".mic");
    micFill = root.querySelector(".meter > i");
    panelBody = root.querySelector(".body");
    collapseBtn = root.querySelector(".collapse");

    micBtn.addEventListener("click", () => send({ type: "mic", on: !micOn })); // фон включит в ОБЕИХ
    collapseBtn.addEventListener("click", () => setCollapsed(!collapsed));
    enableDrag(root.querySelector(".head"));

    collapsed = !!saved.collapsed;
    applyCollapsed();
    paintPanel();
    startMeter();
  }

  function setCollapsed(v) { collapsed = v; applyCollapsed(); saveUI({ collapsed: v }); }
  function applyCollapsed() {
    if (!panelBody) return;
    panelBody.style.display = collapsed ? "none" : "";
    collapseBtn.textContent = collapsed ? "▢" : "—";
    card.classList.toggle("min", collapsed);
  }

  function enableDrag(handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".collapse")) return;
      dragging = true;
      const r = host.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      host.style.right = "auto"; host.style.bottom = "auto";
      host.style.left = ox + "px"; host.style.top = oy + "px";
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      let nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
      nx = Math.max(0, Math.min(window.innerWidth - 60, nx));
      ny = Math.max(0, Math.min(window.innerHeight - 30, ny));
      host.style.left = nx + "px"; host.style.top = ny + "px";
    });
    handle.addEventListener("pointerup", () => {
      if (!dragging) return;
      dragging = false;
      const r = host.getBoundingClientRect();
      saveUI({ left: Math.round(r.left), top: Math.round(r.top) });
    });
  }

  function dotColorFor(t) {
    if (t.includes("✓")) return "#6fdc8c";                                   // зелёный — ок
    if (t.includes("жду") || t.includes("закрыт") || t.includes("лишн")) return "#ff9f6f"; // оранжевый
    return "#f0c419";                                                        // жёлтый — в процессе
  }

  function setStatus(text) {
    buildPanel();
    if (statusText) statusText.textContent = text;
    if (statusDot) statusDot.style.background = dotColorFor(text);
  }

  function paintPanel() {
    if (!micBtn) return;
    micBtn.classList.toggle("on", micOn);
    micBtn.querySelector(".label").textContent = micOn ? "Микрофон включён" : "Включить микрофон";
    micBtn.querySelector(".sub").textContent = micOn ? "тебя слышат оба" : "нажми, чтобы говорить обоим";
    if (tabChip) {
      if (myIndex == null) tabChip.style.display = "none";
      else { tabChip.style.display = ""; tabChip.textContent = "вкладка " + (myIndex + 1); }
    }
  }

  // живой индикатор громкости микрофона
  function startMeter() {
    const buf = new Uint8Array(128);
    const tick = () => {
      requestAnimationFrame(tick);
      if (!micFill || collapsed) { if (micFill) micFill.style.transform = "scaleX(0)"; return; }
      let level = 0;
      if (micOn && micAnalyser) {
        micAnalyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        level = Math.min(1, Math.sqrt(sum / buf.length) * 3);
      }
      micFill.style.transform = "scaleX(" + level.toFixed(3) + ")";
    };
    tick();
  }

  // ---- старт ----
  function start() {
    buildPanel();
    setStatus("подключаюсь…");
    send({ type: "register" });
  }
  if (document.body) start();
  else window.addEventListener("DOMContentLoaded", start);
})();
