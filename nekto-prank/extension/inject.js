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

  // RTCSessionDescription / RTCIceCandidate НЕ переживают structured-clone в
  // postMessage → передаём их обычными JSON-объектами (их же принимают
  // setRemoteDescription/addIceCandidate на той стороне).
  const descJSON = (d) => (d ? { type: d.type, sdp: d.sdp } : null);
  const candJSON = (c) =>
    c ? {
      candidate: c.candidate,
      sdpMid: c.sdpMid,
      sdpMLineIndex: c.sdpMLineIndex,
      usernameFragment: c.usernameFragment,
    } : null;

  // ---- состояние ----
  let ctx = null;            // AudioContext
  let mixDest = null;        // исходящий микс (→ nekto sender), = микрофон + чужой голос
  let micGain = null;        // громкость микрофона (0/1)
  let micAnalyser = null;    // для живого индикатора уровня
  let micStream = null, micSrc = null;
  let nektoMicTrack = null;  // живой микрофон оператора, взятый из звонка nekto (без своего getUserMedia)
  let loopOutDest = null;    // что отправляем во вторую вкладку (= голос НАШЕГО собеседника)
  let loopOutSrc = null;     // источник из текущего remoteStream
  let incomingSrc = null;    // голос ДРУГОГО собеседника (из loopback)

  let nektoSender = null;    // аудио-отправитель звонка nekto (для replaceTrack)
  let nektoPC = null;        // сам звонок nekto (для повторной установки микса)
  let micOn = false;
  let micRequesting = false; // идёт getUserMedia — не запускать второй параллельно
  let applyMixTimer = null;  // ретрай установки микса, пока sender не готов

  let loopPC = null;         // loopback ко второй вкладке
  let loopRole = null;       // "offer" | "answer"
  let pendingSignals = [];   // сигналинг, пришедший раньше, чем создан loopPC
  let myIndex = null;        // номер вкладки в паре (0/1) — для подписи на панели
  let callActive = false;    // перехвачен звонок nekto (есть исходящий микс)
  let bridgeUp = false;      // loopback реально доставляет звук второй вкладки

  // ---- изменитель голоса (эффекты на микрофон оператора) ----
  let fxIn = null, fxOut = null;   // вход/выход цепочки эффектов (между micGain и mixDest)
  let pitchFx = null;              // питч-шифтер (Jungle)
  let robotGain = null, robotOsc = null; // кольцевая модуляция («робот»)
  let currentFx = "none";          // активный пресет

  // пресеты: kind=dry|pitch|robot. amount — сдвиг в октавах (±), freq — частота кольц. мод.
  const FX_PRESETS = {
    none:  { kind: "dry",   icon: "🙂", label: "Обычный" },
    high:  { kind: "pitch", amount: 0.35,  icon: "🧒", label: "Выше" },
    squir: { kind: "pitch", amount: 0.6,   icon: "🐿", label: "Бурундук" },
    deep:  { kind: "pitch", amount: -0.35, icon: "🧔", label: "Ниже" },
    demon: { kind: "pitch", amount: -0.6,  icon: "👹", label: "Демон" },
    robot: { kind: "robot", freq: 50,      icon: "🤖", label: "Робот" },
  };

  // ---- аудио-граф ----
  function buildGraph() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    micGain = ctx.createGain();
    micGain.gain.value = 0;
    mixDest = ctx.createMediaStreamDestination();
    micAnalyser = ctx.createAnalyser();    // ветка только для индикатора уровня (по сухому сигналу)
    micAnalyser.fftSize = 256;
    micGain.connect(micAnalyser);
    buildFxGraph();                        // микрофон идёт в микс через цепочку эффектов
    loopOutDest = ctx.createMediaStreamDestination();
    // любой клик/нажатие по странице «разбудит» аудио (Firefox стартует ctx suspended)
    resume();
  }

  function resume() {
    if (ctx && ctx.state === "suspended") {
      ctx.resume().then(() => log("AudioContext →", ctx.state)).catch(() => {});
    }
  }
  // любой ввод на странице «будит» звук (Firefox стартует ctx в suspended)
  ["click", "keydown", "pointerdown", "touchstart"].forEach((ev) =>
    document.addEventListener(ev, resume, true)
  );

  // ---- изменитель голоса ----------------------------------------------------
  // Граф: micGain → fxIn → (сухой | питч | робот) → fxOut → mixDest.
  // Выходы всех эффектов всегда подключены к fxOut; переключаем только то, что
  // подаётся на их вход (fxIn.disconnect() + новое соединение) — без щелчков графа.
  function buildFxGraph() {
    fxIn = ctx.createGain();
    fxOut = ctx.createGain();
    fxOut.connect(mixDest);
    micGain.connect(fxIn);

    pitchFx = new Jungle(ctx);            // питч-шифтер на задержках (чистый WebAudio)
    pitchFx.output.connect(fxOut);

    robotGain = ctx.createGain();         // кольцевая модуляция: сигнал × осциллятор
    robotGain.gain.value = 0;             // базис 0, осц. качает усиление в ±1
    robotOsc = ctx.createOscillator();
    robotOsc.type = "sine";
    robotOsc.frequency.value = 50;
    robotOsc.connect(robotGain.gain);
    robotOsc.start();
    robotGain.connect(fxOut);

    currentFx = loadUI().fx || "none";    // восстанавливаем выбранный ранее голос
    applyFx(currentFx);
  }

  function applyFx(name) {
    if (!FX_PRESETS[name]) name = "none";
    currentFx = name;
    if (!fxIn) { paintFx(); return; }
    try { fxIn.disconnect(); } catch (_) {}
    const p = FX_PRESETS[name];
    if (p.kind === "pitch") {
      pitchFx.setPitchOffset(p.amount);
      fxIn.connect(pitchFx.input);
    } else if (p.kind === "robot") {
      robotOsc.frequency.setTargetAtTime(p.freq, ctx.currentTime, 0.01);
      fxIn.connect(robotGain);
    } else {
      fxIn.connect(fxOut);               // сухой звук
    }
    resume();
    paintFx();
  }

  // вызывается из сообщения «fx» (приходит в ОБЕ вкладки) + сохраняет выбор
  function setFxRemote(preset) {
    buildGraph();
    applyFx(preset);
    saveUI({ fx: currentFx });
  }

  // --- Jungle: питч-шифтер на двух модулируемых линиях задержки с кроссфейдом.
  //     Классическая реализация Chris Wilson (webaudiodemos), без AudioWorklet. ---
  function Jungle(context) {
    const delayTime = 0.100, fadeTime = 0.050, bufferTime = 0.100;
    this.context = context;
    const input = context.createGain();
    const output = context.createGain();
    this.input = input;
    this.output = output;

    const mod1 = context.createBufferSource();
    const mod2 = context.createBufferSource();
    const mod3 = context.createBufferSource();
    const mod4 = context.createBufferSource();
    const shiftDownBuffer = createDelayTimeBuffer(context, bufferTime, fadeTime, false);
    const shiftUpBuffer = createDelayTimeBuffer(context, bufferTime, fadeTime, true);
    mod1.buffer = shiftDownBuffer; mod2.buffer = shiftDownBuffer;
    mod3.buffer = shiftUpBuffer;   mod4.buffer = shiftUpBuffer;
    mod1.loop = mod2.loop = mod3.loop = mod4.loop = true;

    const mod1Gain = context.createGain();
    const mod2Gain = context.createGain();
    const mod3Gain = context.createGain(); mod3Gain.gain.value = 0;
    const mod4Gain = context.createGain(); mod4Gain.gain.value = 0;
    mod1.connect(mod1Gain); mod2.connect(mod2Gain);
    mod3.connect(mod3Gain); mod4.connect(mod4Gain);

    const modGain1 = context.createGain();
    const modGain2 = context.createGain();
    const delay1 = context.createDelay();
    const delay2 = context.createDelay();
    mod1Gain.connect(modGain1); mod2Gain.connect(modGain2);
    mod3Gain.connect(modGain1); mod4Gain.connect(modGain2);
    modGain1.connect(delay1.delayTime);
    modGain2.connect(delay2.delayTime);

    const fade1 = context.createBufferSource();
    const fade2 = context.createBufferSource();
    const fadeBuffer = createFadeBuffer(context, bufferTime, fadeTime);
    fade1.buffer = fadeBuffer; fade2.buffer = fadeBuffer;
    fade1.loop = fade2.loop = true;

    const mix1 = context.createGain(); mix1.gain.value = 0;
    const mix2 = context.createGain(); mix2.gain.value = 0;
    fade1.connect(mix1.gain); fade2.connect(mix2.gain);

    input.connect(delay1); input.connect(delay2);
    delay1.connect(mix1);   delay2.connect(mix2);
    mix1.connect(output);   mix2.connect(output);

    const t = context.currentTime + 0.050;
    const t2 = t + bufferTime - fadeTime;
    mod1.start(t); mod2.start(t2); mod3.start(t); mod4.start(t2);
    fade1.start(t); fade2.start(t2);

    this.delayTime = delayTime;
    this.mod1Gain = mod1Gain; this.mod2Gain = mod2Gain;
    this.mod3Gain = mod3Gain; this.mod4Gain = mod4Gain;
    this.modGain1 = modGain1; this.modGain2 = modGain2;
  }
  Jungle.prototype.setDelay = function (d) {
    this.modGain1.gain.setTargetAtTime(0.5 * d, this.context.currentTime, 0.01);
    this.modGain2.gain.setTargetAtTime(0.5 * d, this.context.currentTime, 0.01);
  };
  Jungle.prototype.setPitchOffset = function (mult) {
    const up = mult > 0;
    this.mod1Gain.gain.value = up ? 0 : 1;
    this.mod2Gain.gain.value = up ? 0 : 1;
    this.mod3Gain.gain.value = up ? 1 : 0;
    this.mod4Gain.gain.value = up ? 1 : 0;
    this.setDelay(this.delayTime * Math.abs(mult));
  };

  function createFadeBuffer(context, activeTime, fadeTime) {
    const length1 = activeTime * context.sampleRate;
    const length2 = (activeTime - 2 * fadeTime) * context.sampleRate;
    const length = length1 + length2;
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const p = buffer.getChannelData(0);
    const fadeLength = fadeTime * context.sampleRate;
    const fadeIndex1 = fadeLength;
    const fadeIndex2 = length1 - fadeLength;
    for (let i = 0; i < length1; ++i) {
      if (i < fadeIndex1)       p[i] = Math.sqrt(i / fadeLength);
      else if (i >= fadeIndex2) p[i] = Math.sqrt(1 - (i - fadeIndex2) / fadeLength);
      else                      p[i] = 1;
    }
    for (let i = length1; i < length; ++i) p[i] = 0;
    return buffer;
  }
  function createDelayTimeBuffer(context, activeTime, fadeTime, shiftUp) {
    const length1 = activeTime * context.sampleRate;
    const length2 = (activeTime - 2 * fadeTime) * context.sampleRate;
    const length = length1 + length2;
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const p = buffer.getChannelData(0);
    for (let i = 0; i < length1; ++i) p[i] = shiftUp ? (length1 - i) / length : i / length1;
    for (let i = length1; i < length; ++i) p[i] = 0;
    return buffer;
  }
  // ---------------------------------------------------------------------------

  async function ensureMic() {
    if (micSrc) return true;               // микрофон уже подключён (в т.ч. из звонка nekto)
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

  // Берём живой микрофон оператора прямо из звонка nekto: до подмены трека на
  // микс текущий трек исходящего sender'а — это и есть микрофон (nekto его уже
  // захватил). Так мы НЕ вызываем свой getUserMedia и не конкурируем за
  // устройство — это и чинит «кнопка не работает, когда оба звонка активны».
  function adoptMicTrack(track) {
    if (!ctx || !micGain || !track || track.kind !== "audio") return;
    if (micStream) return;                 // у нас уже есть собственный getUserMedia — не трогаем
    if (micSrc && nektoMicTrack === track && track.readyState !== "ended") return;
    try { if (micSrc) micSrc.disconnect(); } catch (_) {}
    nektoMicTrack = track;
    micSrc = ctx.createMediaStreamSource(new MediaStream([track]));
    micSrc.connect(micGain);
    micGain.gain.value = micOn ? 1 : 0;    // если оператор уже нажал «вкл» — сразу звук
    log("микрофон взят из звонка nekto (без getUserMedia)");
  }

  // Кнопка реагирует мгновенно: сразу выставляем состояние и перерисовываем
  // панель, а захват микрофона делаем асинхронно — UI не ждёт getUserMedia.
  function setMic(on) {
    buildGraph();
    micOn = on;
    resume();
    paintPanel();

    if (!on) {
      micGain.gain.value = 0;
      return;
    }

    // микрофон уже подключён (взят из звонка nekto или ранее по getUserMedia) —
    // просто открываем громкость. Это мгновенно и не зависит от устройства.
    if (micSrc) { micGain.gain.value = 1; return; }
    // захват уже идёт — не плодим второй getUserMedia, он сам сверится с micOn
    if (micRequesting) return;

    micRequesting = true;
    ensureMic()
      .then((ok) => {
        if (!ok) {
          if (micOn) { micOn = false; setStatus("микрофон недоступен"); paintPanel(); }
          return;
        }
        // пока шёл захват, пользователь мог уже выключить — сверяемся с micOn
        micGain.gain.value = micOn ? 1 : 0;
        resume();
      })
      .finally(() => { micRequesting = false; });
  }

  // ---- loopback между вкладками (несёт звук в обе стороны одной парой PC) ----
  function teardownLoopback() {
    if (loopPC) { try { loopPC.close(); } catch (_) {} loopPC = null; }
    if (incomingSrc) { try { incomingSrc.disconnect(); } catch (_) {} incomingSrc = null; }
    pendingSignals = []; // старый сигналинг не должен попасть в новый loopPC
    bridgeUp = false;
  }

  async function setupLoopback(role) {
    buildGraph();
    const queued = pendingSignals; // снимок ДО teardown (он очистит очередь)
    teardownLoopback();
    loopRole = role;
    // STUN на случай, если host/mDNS-кандидаты между вкладками не сходятся
    loopPC = new NativePC({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });

    loopPC.onicecandidate = (e) => {
      if (e.candidate) send({ type: "loop-signal", data: { cand: candJSON(e.candidate) } });
    };
    loopPC.ontrack = (e) => {
      // звук ДРУГОГО собеседника → в наш исходящий микс
      const stream = e.streams[0] || new MediaStream([e.track]);
      if (incomingSrc) try { incomingSrc.disconnect(); } catch (_) {}
      incomingSrc = ctx.createMediaStreamSource(stream);
      incomingSrc.connect(mixDest);
      resume();
      bridgeUp = true;
      renderStatus();
      log("loopback: получаю звук второй вкладки");
    };
    loopPC.oniceconnectionstatechange = () => {
      log("loopback ICE:", loopPC.iceConnectionState);
      if (loopPC.iceConnectionState === "failed") setStatus("мост не соединился (ICE failed)");
    };
    loopPC.onconnectionstatechange = () => log("loopback:", loopPC.connectionState);

    // отправляем во вторую вкладку голос НАШЕГО собеседника (через loopOutDest)
    loopPC.addTrack(loopOutDest.stream.getAudioTracks()[0], loopOutDest.stream);

    if (role === "offer") {
      const offer = await loopPC.createOffer();
      await loopPC.setLocalDescription(offer);
      send({ type: "loop-signal", data: { desc: descJSON(loopPC.localDescription) } });
    }
    renderStatus();

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
          send({ type: "loop-signal", data: { desc: descJSON(loopPC.localDescription) } });
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

  // все аудио-отправители звонка (транссиверы дают sender даже без трека)
  function audioSendersOf(pc) {
    const senders = new Set();
    for (const t of pc.getTransceivers()) {
      const isAudio =
        (t.sender && t.sender.track && t.sender.track.kind === "audio") ||
        (t.receiver && t.receiver.track && t.receiver.track.kind === "audio");
      if (isAudio && t.sender) senders.add(t.sender);
    }
    for (const s of pc.getSenders()) {
      if (!s.track || (s.track && s.track.kind === "audio")) senders.add(s);
    }
    return [...senders];
  }

  // Ставит наш микс на ВСЕ аудио-отправители звонка. Идемпотентно: трек, уже
  // равный миксу, пропускаем. Возвращает true, если микс стоит хотя бы на одном.
  function applyMix(pc) {
    const mixTrack = mixDest && mixDest.stream.getAudioTracks()[0];
    if (!pc || !mixTrack) return false;
    const senders = audioSendersOf(pc);
    let any = false;
    for (const s of senders) {
      if (s.track === mixTrack) { any = true; continue; }
      // текущий трек sender'а — это живой микрофон оператора: берём его себе,
      // ПОТОМ подменяем исходящий на наш микс
      if (s.track && s.track.kind === "audio") adoptMicTrack(s.track);
      nektoSender = s;
      s.replaceTrack(mixTrack).then(
        () => log("исходящий звук подменён на микс"),
        (err) => log("replaceTrack не удался", err)
      );
      any = true;
    }
    return any;
  }

  // Ретрай на случай, если sender появляется чуть позже трека/ренеготиации.
  function scheduleApplyMix(pc, tries = 12) {
    if (applyMixTimer) { clearTimeout(applyMixTimer); applyMixTimer = null; }
    const attempt = (left) => {
      if (applyMix(pc) || left <= 0) return;
      applyMixTimer = setTimeout(() => attempt(left - 1), 250);
    };
    attempt(tries);
  }

  function setNektoCall(pc, remoteStream) {
    buildGraph();
    log("перехвачен звонок nekto, ставлю мост");

    // 1) подменяем исходящий звук на наш микс (чужой голос + микрофон).
    //    Повторяем при ренеготиации nekto (часто — когда второй собеседник
    //    подключается позже) и ретраим, если sender ещё не готов.
    if (pc !== nektoPC) {
      nektoPC = pc;
      pc.addEventListener("negotiationneeded", () => scheduleApplyMix(pc));
      pc.addEventListener("signalingstatechange", () => {
        if (pc.signalingState === "stable") scheduleApplyMix(pc);
      });
    }
    scheduleApplyMix(pc);

    // 2) голос НАШЕГО собеседника гоним во вторую вкладку
    if (loopOutSrc) try { loopOutSrc.disconnect(); } catch (_) {}
    loopOutSrc = ctx.createMediaStreamSource(remoteStream);
    loopOutSrc.connect(loopOutDest);

    resume();
    callActive = true;
    renderStatus();
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
      case "fx":       setFxRemote(msg.preset); break;
    }
  });

  // ---- плавающая панель (в Shadow DOM, чтобы стили nekto её не ломали) ----
  let host = null, root = null;
  let statusDot = null, statusText = null, tabChip = null;
  let micBtn = null, micFill = null, panelBody = null, collapseBtn = null, card = null;
  let collapsed = false;

  // промо-слот для публичного релиза: впиши свою ссылку (канал/Boosty/спонсор).
  // url пустой → блок скрыт.
  const PROMO = { text: "▶ ещё пранки — подпишись", url: "" };

  const PANEL_HTML = `
<style>
  *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .card{width:266px;color:#e7e9f0;border:1px solid #2b3242;border-radius:16px;
    background:linear-gradient(180deg,#1c2130,#13151c);
    box-shadow:0 18px 50px rgba(0,0,0,.6);overflow:hidden}
  .card.min{width:auto}
  .head{display:flex;align-items:center;gap:8px;padding:11px 13px;cursor:grab;user-select:none;
    background:linear-gradient(180deg,rgba(123,162,255,.10),rgba(123,162,255,0));
    border-bottom:1px solid #262d3d}
  .head:active{cursor:grabbing}
  .card.min .head{border-bottom:none}
  .title{font-weight:800;font-size:13px;flex:1;white-space:nowrap;letter-spacing:.2px;
    background:linear-gradient(90deg,#7aa2ff,#9b6bff,#7aa2ff);background-size:200% 100%;
    -webkit-background-clip:text;background-clip:text;color:transparent;
    animation:shine 5s linear infinite}
  @keyframes shine{to{background-position:200% 0}}
  .dot{width:9px;height:9px;border-radius:50%;background:#f0c419;flex:0 0 auto;
    box-shadow:0 0 8px currentColor;transition:background .3s}
  .tab{font-size:11px;background:#222838;border:1px solid #2a3040;border-radius:20px;
    padding:2px 8px;color:#9aa3b8}
  .collapse{width:23px;height:23px;border:none;border-radius:7px;background:#262d3d;color:#cfd4df;
    cursor:pointer;font-size:13px;line-height:1;padding:0}
  .collapse:hover{background:#39415a}
  .body{padding:13px}
  .statusrow{display:flex;align-items:center;gap:8px;margin-bottom:12px}
  .pill{display:flex;align-items:center;gap:8px;flex:1;font-size:12px;color:#aab2c5;
    background:rgba(13,15,21,.5);border:1px solid #262d3d;border-radius:20px;padding:6px 11px}
  .status{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mic{width:100%;border:1px solid #2a3040;border-radius:12px;padding:12px;background:#1c2230;
    color:#e7e9f0;cursor:pointer;text-align:left;display:flex;align-items:center;gap:11px;
    transition:background .18s,border-color .18s,box-shadow .18s}
  .mic:hover{border-color:#4f8cff}
  .mic .ic{font-size:21px}
  .mic .txt{flex:1}
  .mic .label{font-weight:700;font-size:13px;display:block}
  .mic .sub{font-size:11px;color:#8b93a7}
  .mic.on{background:linear-gradient(180deg,#c14a41,#a93a32);border-color:#c14a41;color:#fff;
    box-shadow:0 0 0 3px rgba(193,74,65,.25)}
  .mic.on .sub{color:#ffd9d5}
  .mic.on .ic{animation:pulse 1.3s ease-in-out infinite}
  @keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.18)}}
  .meter{height:5px;border-radius:3px;background:#0d0f15;margin-top:10px;overflow:hidden}
  .meter>i{display:block;height:100%;width:100%;transform-origin:left;transform:scaleX(0);
    background:linear-gradient(90deg,#6fdc8c,#f0c419,#ff7a6b);transition:transform .06s linear}
  .fx{margin-top:14px}
  .seclbl{font-size:10px;color:#7e879c;margin-bottom:8px;letter-spacing:.6px;text-transform:uppercase}
  .fx-row{display:flex;flex-wrap:wrap;gap:6px}
  .chip{display:flex;align-items:center;gap:5px;border:1px solid #2a3040;background:#191e2c;
    color:#cfd4df;border-radius:9px;padding:7px 9px;font-size:11px;font-weight:600;cursor:pointer;
    transition:border-color .15s,background .15s,color .15s,box-shadow .15s}
  .chip .ci{font-size:14px;line-height:1}
  .chip:hover{border-color:#4f8cff;color:#fff}
  .chip.active{background:linear-gradient(180deg,#3b6cff,#2f54e0);border-color:#3b6cff;color:#fff;
    box-shadow:0 0 0 3px rgba(59,108,255,.22)}
  .promo{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:13px;
    text-decoration:none;font-size:11px;font-weight:700;color:#ffd9a8;
    background:linear-gradient(180deg,#2a2330,#211b27);border:1px solid #4a3a2e;
    border-radius:10px;padding:9px;transition:filter .15s}
  .promo:hover{filter:brightness(1.18)}
  .hint{font-size:10px;color:#69728a;margin-top:11px;line-height:1.4}
</style>
<div class="card">
  <div class="head">
    <span class="title">🎙 Голосовой мост</span>
    <span class="tab" style="display:none"></span>
    <button class="collapse" title="Свернуть / развернуть">—</button>
  </div>
  <div class="body">
    <div class="statusrow"><span class="pill"><span class="dot"></span><span class="status">запуск…</span></span></div>
    <button class="mic">
      <span class="ic">🎙</span>
      <span class="txt"><span class="label">Включить микрофон</span><span class="sub">нажми, чтобы говорить обоим</span></span>
    </button>
    <div class="meter"><i></i></div>
    <div class="fx">
      <div class="seclbl">🎚 Голос оператора</div>
      <div class="fx-row"></div>
    </div>
    <a class="promo" target="_blank" rel="noopener"><span class="pt"></span></a>
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

    // чипы изменителя голоса — генерим из FX_PRESETS; клик уходит в ОБЕ вкладки
    const fxRow = root.querySelector(".fx-row");
    for (const [key, p] of Object.entries(FX_PRESETS)) {
      const b = document.createElement("button");
      b.className = "chip";
      b.dataset.fx = key;
      const ci = document.createElement("span"); ci.className = "ci"; ci.textContent = p.icon;
      const cl = document.createElement("span"); cl.textContent = p.label;
      b.append(ci, cl);
      b.addEventListener("click", () => send({ type: "fx", preset: key }));
      fxRow.appendChild(b);
    }

    // промо-слот (для публичного релиза). Пусто → скрыт.
    const promo = root.querySelector(".promo");
    if (PROMO.url) {
      promo.href = PROMO.url;
      promo.querySelector(".pt").textContent = PROMO.text;
    } else {
      promo.style.display = "none";
    }

    collapsed = !!saved.collapsed;
    applyCollapsed();
    paintPanel();
    paintFx();
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

  // комбинированный статус: видно отдельно «мост» (loopback) и «звонок» (nekto)
  function renderStatus() {
    buildPanel();
    const text = (bridgeUp ? "мост ✓" : "мост …") + " · " + (callActive ? "звонок ✓" : "звонок …");
    statusText.textContent = text;
    statusDot.style.background =
      bridgeUp && callActive ? "#6fdc8c" : bridgeUp || callActive ? "#f0c419" : "#ff9f6f";
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

  // подсветка активного голосового эффекта
  function paintFx() {
    if (!root) return;
    root.querySelectorAll(".chip").forEach((c) =>
      c.classList.toggle("active", c.dataset.fx === currentFx));
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
    buildGraph();  // создаём AudioContext СРАЗУ — тогда клики на странице (поиск
                   // собеседника и т.п.) его разбудят ещё до начала звонка
    buildPanel();
    setStatus("подключаюсь…");
    send({ type: "register" });
  }
  if (document.body) start();
  else window.addEventListener("DOMContentLoaded", start);
})();
