"""
Клиент протокола nekto.me (анонимный чат) поверх Socket.IO.

Разобрано по рабочему проекту github.com/pashtetx/nekto.me-spion.
Все доменные события приходят одним socket.io-событием "notice"
с телом {"notice": "<имя>", "data": {...}}.
"""

import hashlib
import random
import time
from typing import Any, Awaitable, Callable, Optional

import socketio


def _webagent(token: str, user_id: Any, create_time: int) -> str:
    """Подпись web-agent, которую ждёт nekto.me после auth.successToken."""
    payload = token + "1AXYINmuWLLQk1iX" + "NAd0NHvxy" + str(user_id) + str(create_time)
    return hashlib.sha256(payload.encode()).hexdigest()


def _random_id() -> str:
    return str(time.time() * 1000) + str(random.random())


# Тип колбэка наружу: (имя_стороны, вид_события, **данные)
EventCallback = Callable[..., Awaitable[None]]


class NektoClient:
    URL = "wss://im.nekto.me"

    def __init__(
        self,
        name: str,
        token: str,
        ua: str,
        *,
        locale: str = "ru",
        tz: str = "Europe/Moscow",
        search_params: Optional[dict] = None,
        on_event: Optional[EventCallback] = None,
        debug: bool = False,
    ):
        self.name = name  # "1" или "2"
        self.token = token
        self.ua = ua
        self.locale = locale
        self.tz = tz
        self.search_params = search_params or {}
        self.on_event = on_event

        self.user_id: Any = None
        self.dialog_id: Any = None
        self.auto_search = True  # искать заново, когда собеседник ушёл

        self.sio = socketio.AsyncClient(
            logger=debug, engineio_logger=debug, reconnection=True
        )
        self.sio.on("connect", self._on_connect)
        self.sio.on("disconnect", self._on_disconnect)
        self.sio.on("notice", self._on_notice)

    # ---- наружу ----
    async def _notify(self, kind: str, **kw: Any) -> None:
        if self.on_event:
            await self.on_event(self.name, kind, **kw)

    async def _emit(self, payload: dict) -> None:
        await self.sio.emit("action", payload)

    # ---- подключение / авторизация ----
    async def connect(self) -> None:
        await self._notify("status", state="connecting")
        await self.sio.connect(
            self.URL, transports=["websocket"], headers={"User-Agent": self.ua}
        )

    async def _on_connect(self) -> None:
        await self._emit(
            {
                "token": self.token,
                "locale": self.locale,
                "t": round(time.time() * 1000),
                "timeZone": self.tz,
                "version": 12,
                "action": "auth.sendToken",
            }
        )

    async def _on_disconnect(self) -> None:
        self.dialog_id = None
        await self._notify("status", state="closed")

    async def _on_notice(self, data: Any = None) -> None:
        data = data or {}
        notice = data.get("notice")
        payload = data.get("data") or {}
        # сырой лог для отладки протокола на первом живом подключении
        await self._notify("raw", notice=notice, payload=payload)

        handler = {
            "auth.successToken": self._on_auth,
            "dialog.opened": self._on_dialog_opened,
            "dialog.closed": self._on_dialog_closed,
            "messages.new": self._on_message,
            "dialog.typing": self._on_typing,
            "error.code": self._on_error,
        }.get(notice)
        if handler:
            await handler(payload)

    async def _on_auth(self, data: dict) -> None:
        self.user_id = (
            data.get("id")
            or data.get("userId")
            or (data.get("user") or {}).get("id")
        )
        ts = round(time.time() * 1000)
        await self._emit(
            {"type": "web-agent", "data": _webagent(self.token, self.user_id, ts)}
        )
        await self._notify("status", state="authed")
        await self.search()

    # ---- поиск / диалог ----
    async def search(self) -> None:
        if self.dialog_id:
            await self.leave()
        payload = {"action": "search.run"}
        # добавляем только заданные параметры, чтобы не слать None
        payload.update({k: v for k, v in self.search_params.items() if v is not None})
        await self._emit(payload)
        await self._notify("status", state="searching")

    async def _on_dialog_opened(self, data: dict) -> None:
        self.dialog_id = data.get("id")
        await self._notify("status", state="chatting")

    async def _on_dialog_closed(self, data: dict) -> None:
        self.dialog_id = None
        await self._notify("partner_left")
        if self.auto_search:
            await self.search()

    async def _on_message(self, data: dict) -> None:
        sender = data.get("senderId")
        text = data.get("message")
        mid = data.get("id")
        if self.dialog_id and mid is not None:
            await self._emit(
                {
                    "action": "anon.readMessages",
                    "dialogId": self.dialog_id,
                    "lastMessageId": mid,
                }
            )
        # пропускаем эхо наших же отправленных сообщений
        if self.user_id is not None and sender == self.user_id:
            return
        await self._notify("message", text=text)

    async def _on_typing(self, data: dict) -> None:
        await self._notify(
            "typing", typing=bool(data.get("typing")), voice=bool(data.get("voice"))
        )

    async def _on_error(self, data: dict) -> None:
        await self._notify("error", data=data)

    # ---- действия ----
    async def send_message(self, text: str) -> bool:
        if not self.dialog_id:
            return False
        await self._emit(
            {
                "action": "anon.message",
                "dialogId": self.dialog_id,
                "randomId": _random_id(),
                "message": text,
                "fileId": None,
            }
        )
        return True

    async def set_typing(self, typing: bool, voice: bool = False) -> None:
        if not self.dialog_id:
            return
        await self._emit(
            {
                "action": "dialog.setTyping",
                "dialogId": self.dialog_id,
                "typing": typing,
                "voice": voice,
            }
        )

    async def leave(self) -> None:
        if not self.dialog_id:
            return
        await self._emit({"action": "anon.leaveDialog", "dialogId": self.dialog_id})
        self.dialog_id = None

    async def disconnect(self) -> None:
        try:
            await self.leave()
        except Exception:
            pass
        try:
            await self.sio.disconnect()
        except Exception:
            pass
