/**
 * Рекордер аудио-протокола nekto.me (исходник кнопки-закладки из index.html).
 *
 * Это НЕ часть приложения — диагностический сниппет, который пользователь
 * запускает В ВИДЕ ЗАКЛАДКИ на сайте nekto.me, чтобы один раз снять, как
 * официальный клиент устанавливает голосовой звонок. Полученный файл нужен,
 * чтобы заполнить плейсхолдеры протокола в nekto.py и ICE-серверы в audio.js.
 *
 * В index.html лежит минифицированная версия этого же кода в href="javascript:...".
 * Правишь логику здесь → переноси в закладку (минифицируй, без двойных кавычек:
 * атрибут href в двойных кавычках).
 *
 * ВАЖНО про захват: на приём ('recv') ловятся только сокеты, созданные ПОСЛЕ
 * клика. Поэтому пользователю говорим: нажать закладку на ГЛАВНОЙ nekto.me, и уже
 * потом (в той же вкладке, SPA не перезагружается) заходить в голосовой чат — так
 * новый сокет звонка и RTCPeerConnection попадут в запись целиком. Отправку
 * ('send') ловим патчем WebSocket.prototype.send — она работает и для уже
 * открытого сокета.
 *
 * Использование: 1-й клик — включить запись; сделать НАСТОЯЩИЙ звонок ~15 сек;
 * 2-й клик — скачать nekto-audio-log.json (в alert покажет число записей).
 */
(function () {
  var S = window.__nektoSniff;

  function push(o) {
    try { S.log.push(o); } catch (e) {}
  }

  // распарсить engine.io/socket.io кадр вида: 42["event",{...}]
  function rec(dir, data) {
    if (typeof data !== "string") return; // бинарь (медиа) пропускаем
    var m = data.match(/^\d+(\[.*)$/);
    if (!m) return;
    var p;
    try { p = JSON.parse(m[1]); } catch (e) { return; }
    push({ t: dir, event: p[0], data: p[1] });
  }

  // ---- 2-й клик: выгрузить собранное в файл ----
  if (S) {
    var blob = new Blob([JSON.stringify(S.log, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "nekto-audio-log.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    var n = S.log.length;
    window.__nektoSniff = null; // сброс, чтобы можно было записать заново
    alert("Готово! Собрано записей: " + n + ". Файл nekto-audio-log.json в Загрузках — пришли его.");
    return;
  }

  // ---- 1-й клик: включить запись ----
  S = window.__nektoSniff = { log: [] };

  // Перехват WebSocket: новые сокеты — на приём; отправку — патчем прототипа
  // (срабатывает и для уже открытого соединения socket.io).
  var OWS = window.WebSocket;
  var W = function () {
    var ws = new (Function.prototype.bind.apply(OWS, [null].concat([].slice.call(arguments))));
    push({ t: "open", url: arguments[0] });
    try {
      ws.addEventListener("message", function (e) { rec("recv", e.data); });
    } catch (e) {}
    return ws;
  };
  W.prototype = OWS.prototype;
  for (var k in OWS) { try { W[k] = OWS[k]; } catch (e) {} }
  window.WebSocket = W;
  try {
    var origSend = OWS.prototype.send;
    OWS.prototype.send = function (d) { rec("send", d); return origSend.apply(this, arguments); };
  } catch (e) {}

  // Перехват WebRTC: ICE-серверы, SDP в обе стороны, ICE-кандидаты, треки.
  var OPC = window.RTCPeerConnection;
  if (OPC) {
    var Q = function () {
      var cfg = arguments[0];
      push({ t: "pc-config", iceServers: cfg && cfg.iceServers });
      var pc = new (Function.prototype.bind.apply(OPC, [null].concat([].slice.call(arguments))));
      ["setLocalDescription", "setRemoteDescription"].forEach(function (fn) {
        var orig = pc[fn].bind(pc);
        pc[fn] = function (x) {
          push({ t: fn, sdpType: x && x.type, sdp: x && x.sdp });
          return orig(x);
        };
      });
      var ai = pc.addIceCandidate.bind(pc);
      pc.addIceCandidate = function (x) {
        push({ t: "addIceCandidate", candidate: x && (x.candidate || x) });
        return ai(x);
      };
      pc.addEventListener("icecandidate", function (e) {
        if (e.candidate) push({ t: "localIce", candidate: e.candidate.candidate });
      });
      pc.addEventListener("track", function () { push({ t: "ontrack" }); });
      return pc;
    };
    Q.prototype = OPC.prototype;
    for (var j in OPC) { try { Q[j] = OPC[j]; } catch (e) {} }
    window.RTCPeerConnection = Q;
  }

  alert(
    "Запись включена. Теперь найди голосового собеседника, ПОГОВОРИ ~15 секунд, " +
    "включи и выключи микрофон, затем нажми эту кнопку ещё раз — скачается файл."
  );
})();
