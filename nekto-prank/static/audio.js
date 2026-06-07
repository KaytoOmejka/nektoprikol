"use strict";

/**
 * Аудио-слой моста nekto.me (WebRTC целиком в браузере).
 *
 * Топология (как и в тексте, бот сидит между двумя незнакомцами):
 *
 *   Незнакомец A ──RTC──▶ pc[1] ─┐                       ┌─▶ pc[2] ──RTC──▶ Незнакомец B
 *                                 ├─ relay: голос A → B ──┤
 *   Незнакомец A ◀──RTC── pc[1] ◀┘   relay: голос B → A  └◀ pc[2] ◀──RTC── Незнакомец B
 *                                 + микрофон оператора (в выбранную сторону)
 *                                 + воспроизведение обоих голосов оператору
 *
 * Микширование исходящего звука для каждой стороны делается через Web Audio:
 * в destOut[s] (то, что уходит незнакомцу стороны s) сводятся
 *   – голос ДРУГОГО незнакомца (relay), и
 *   – микрофон оператора, если он «говорит как» партнёр стороны s.
 *
 * Сервер только ПЕРЕДАЁТ сигналинг (SDP/ICE) нужному pc — он не трогает звук.
 * Перевод формата сигналинга в/из протокола nekto живёт в nekto.py (адаптер).
 */

const AudioBridge = (() => {
  // ICE-серверы. TODO: nekto почти наверняка отдаёт собственные STUN/TURN
  // (часто прямо в notice при старте звонка) — их нужно подставлять сюда.
  // Публичный STUN ниже хватает только если оба пира не за «злым» NAT.
  const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

  const partner = (s) => (s === "1" ? "2" : "1");

  let ctx = null; // AudioContext
  let micStream = null; // MediaStream с микрофона (если разрешён)
  let micSrc = null; // его источник в графе
  let micGain = null; // одно усиление: микрофон уходит ОБОИМ собеседникам
  const destOut = {}; // destOut[s]: микс, уходящий незнакомцу стороны s
  const peers = {}; // peers[s]: { pc, makingOffer, polite, ignoreOffer }
  const players = {}; // players[s]: <audio> для голоса незнакомца стороны s

  let sendSignal = () => {}; // колбэк наружу: отправить сигналинг на сервер
  let micEnabled = false;
  let started = false;

  // --- построение аудио-графа -------------------------------------------------
  function ensureCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    // браузер часто стартует контекст в suspended до жеста пользователя
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function ensureDest(side) {
    if (!destOut[side]) destOut[side] = ensureCtx().createMediaStreamDestination();
    return destOut[side];
  }

  // включить/выключить микрофон сразу для обеих сторон
  function applyMicRouting() {
    if (micGain) micGain.gain.value = micEnabled ? 1 : 0;
  }

  // --- WebRTC peer на сторону --------------------------------------------------
  function makePeer(side) {
    const pc = new RTCPeerConnection(ICE);
    const o = { pc, makingOffer: false, polite: true, ignoreOffer: false };
    peers[side] = o;

    // Заранее кладём в pc исходящий микс-трек (поначалу тишина — наполнится,
    // когда придёт голос другого незнакомца и/или включат микрофон). Так трек
    // присутствует с самого начала переговоров и SDP не нужно пересогласовывать.
    const dest = ensureDest(side);
    pc.addTrack(dest.stream.getAudioTracks()[0], dest.stream);

    // Perfect negotiation — устойчиво к «glare» (одновременным офферам), т.к.
    // мы не знаем, кто у nekto инициатор звонка.
    pc.onnegotiationneeded = async () => {
      try {
        o.makingOffer = true;
        await pc.setLocalDescription();
        sendSignal(side, { description: pc.localDescription });
      } catch (e) {
        console.error("[audio] negotiation", side, e);
      } finally {
        o.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sendSignal(side, { candidate });
    };
    pc.ontrack = (ev) => {
      const remote = ev.streams[0] || new MediaStream([ev.track]);
      // 1) оператор слышит этого незнакомца
      playForOperator(side, remote);
      // 2) relay: его голос уходит другому незнакомцу
      const src = ensureCtx().createMediaStreamSource(remote);
      src.connect(ensureDest(partner(side)));
    };
    pc.onconnectionstatechange = () =>
      console.debug("[audio] pc", side, pc.connectionState);
    return o;
  }

  function playForOperator(side, stream) {
    let el = players[side];
    if (!el) {
      el = document.createElement("audio");
      el.autoplay = true;
      el.dataset.side = side;
      document.body.appendChild(el);
      players[side] = el;
    }
    el.srcObject = stream;
    el.play?.().catch(() => {}); // автоплей может потребовать жеста — не критично
  }

  // --- микрофон ----------------------------------------------------------------
  async function enableMic() {
    if (micStream) return true;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.error("[audio] mic denied", e);
      return false;
    }
    micSrc = ensureCtx().createMediaStreamSource(micStream);
    // Голос оператора уходит в ОБА исходящих микса — его слышат сразу оба
    // собеседника (поверх ретранслированного голоса другого собеседника).
    micGain = ctx.createGain();
    micGain.gain.value = 0;
    micSrc.connect(micGain);
    micGain.connect(ensureDest("1"));
    micGain.connect(ensureDest("2"));
    applyMicRouting();
    return true;
  }

  // --- публичный API -----------------------------------------------------------
  return {
    /** Инициализировать аудио для сторон "1" и "2". cb — отправка сигналинга. */
    start(cb) {
      if (started) return;
      started = true;
      sendSignal = cb || sendSignal;
      ensureCtx();
      makePeer("1");
      makePeer("2");
    },

    /** Входящий сигналинг с сервера для стороны side (perfect negotiation). */
    async onSignal(side, signal) {
      const o = peers[side];
      if (!o || !signal) return;
      const { pc } = o;
      try {
        if (signal.description) {
          const desc = signal.description;
          const collision =
            desc.type === "offer" && (o.makingOffer || pc.signalingState !== "stable");
          o.ignoreOffer = !o.polite && collision;
          if (o.ignoreOffer) return; // невежливый пир игнорит чужой оффер при glare
          await pc.setRemoteDescription(desc);
          if (desc.type === "offer") {
            await pc.setLocalDescription();
            sendSignal(side, { description: pc.localDescription });
          }
        } else if (signal.candidate) {
          try {
            await pc.addIceCandidate(signal.candidate);
          } catch (e) {
            if (!o.ignoreOffer) throw e;
          }
        }
      } catch (e) {
        console.error("[audio] onSignal", side, e);
      }
    },

    /** Включить/выключить микрофон. Возвращает фактическое состояние. */
    async setMic(on) {
      if (on && !(await enableMic())) return false; // нет доступа — остаёмся выкл
      micEnabled = !!on && !!micStream;
      applyMicRouting();
      return micEnabled;
    },

    isMicOn() {
      return micEnabled;
    },

    /** Полная остановка: закрыть pc, отпустить микрофон, убрать плееры. */
    stop() {
      for (const s of Object.keys(peers)) {
        try {
          peers[s].pc.close();
        } catch (_) {}
        delete peers[s];
      }
      for (const s of Object.keys(players)) {
        players[s].srcObject = null;
        players[s].remove();
        delete players[s];
      }
      if (micStream) {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
      }
      micSrc = null;
      micGain = null;
      for (const k of Object.keys(destOut)) delete destOut[k];
      if (ctx) {
        ctx.close().catch(() => {});
        ctx = null;
      }
      micEnabled = false;
      started = false;
    },
  };
})();
