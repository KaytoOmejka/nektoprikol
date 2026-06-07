/**
 * Рекордер аудио-протокола nekto.me (исходник кнопки-закладки из index.html).
 *
 * Это НЕ часть приложения — это диагностический сниппет, который пользователь
 * запускает В ВИДЕ ЗАКЛАДКИ на самом сайте nekto.me, чтобы один раз снять, как
 * официальный клиент устанавливает голосовой звонок. Полученный файл нужен,
 * чтобы заполнить плейсхолдеры протокола в nekto.py и ICE-серверы в audio.js.
 *
 * В index.html лежит минифицированная версия этого же кода в href="javascript:...".
 * Если правишь логику — правь здесь, потом переноси в закладку (минифицируй,
 * убери двойные кавычки — атрибут href в кавычках двойных).
 *
 * Что собирает:
 *  - socket.io кадры: исходящие ('send', через патч WebSocket.prototype.send —
 *    ловит даже уже открытый сокет) и входящие ('recv', для новых сокетов);
 *  - конфиг RTCPeerConnection (iceServers — STUN/TURN nekto);
 *  - SDP в обе стороны (setLocalDescription / setRemoteDescription).
 *
 * Использование: 1-й клик — включить запись; сделать звонок; 2-й клик — скачать
 * nekto-audio-log.json.
 */
(function () {
  var S = window.__nektoSniff;

  function push(o) {
    try { S.log.push(o); } catch (e) {}
  }

  // распарсить engine.io/socket.io кадр вида: 42["notice",{...}]
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
    window.__nektoSniff = null; // сброс, чтобы можно было записать заново
    alert("Готово! Файл nekto-audio-log.json лежит в папке Загрузки. Пришли его.");
    return;
  }

  // ---- 1-й клик: включить запись ----
  S = window.__nektoSniff = { log: [] };

  // Перехват WebSocket: новые сокеты логируем на приём; на отправку патчим
  // прототип (срабатывает и для уже открытого соединения socket.io).
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

  // Перехват WebRTC: ICE-серверы + SDP в обе стороны.
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
      return pc;
    };
    Q.prototype = OPC.prototype;
    for (var j in OPC) { try { Q[j] = OPC[j]; } catch (e) {} }
    window.RTCPeerConnection = Q;
  }

  alert(
    "Запись включена. Теперь начни голосовой чат, поговори 10 секунд, " +
    "включи и выключи микрофон, затем нажми эту кнопку ЕЩЁ РАЗ — скачается файл."
  );
})();
