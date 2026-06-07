"""
Локальный сервер «моста» для пранков на nekto.me.

- Отдаёт статичный интерфейс (static/).
- Держит websocket с браузером (/ws) — свой простой JSON-протокол.
- Управляет двумя NektoClient (стороны "1" и "2"), пересылает сообщения
  между двумя собеседниками и позволяет писать «от лица» любого из них.
"""

import asyncio
import json
import pathlib

from aiohttp import web

from nekto import NektoClient

STATIC = pathlib.Path(__file__).parent / "static"
HOST = "127.0.0.1"
PORT = 8765


class Session:
    """Одна операторская сессия: два клиента nekto + связь с браузером."""

    def __init__(self):
        self.clients: dict[str, NektoClient] = {}
        self.ws: web.WebSocketResponse | None = None
        self.relay = True

    @staticmethod
    def partner(name: str) -> str:
        return "2" if name == "1" else "1"

    async def send_browser(self, obj: dict) -> None:
        if self.ws is not None and not self.ws.closed:
            await self.ws.send_str(json.dumps(obj, ensure_ascii=False))

    # ---- события от клиентов nekto ----
    async def on_event(self, name: str, kind: str, **kw) -> None:
        if kind == "message":
            text = kw.get("text")
            await self.send_browser(
                {"type": "message", "from": name, "text": text, "injected": False}
            )
            if self.relay:
                p = self.clients.get(self.partner(name))
                if p:
                    await p.send_message(text)

        elif kind == "typing":
            await self.send_browser(
                {"type": "typing", "from": name, "typing": kw.get("typing")}
            )
            if self.relay:
                p = self.clients.get(self.partner(name))
                if p:
                    await p.set_typing(bool(kw.get("typing")), bool(kw.get("voice")))

        elif kind == "status":
            await self.send_browser(
                {"type": "status", "side": name, "state": kw.get("state")}
            )

        elif kind == "partner_left":
            await self.send_browser(
                {"type": "system", "text": f"Собеседник {name} вышел."}
            )

        elif kind == "error":
            await self.send_browser(
                {"type": "system", "text": f"Ошибка (сторона {name}): {kw.get('data')}"}
            )

        elif kind == "raw":
            await self.send_browser(
                {
                    "type": "raw",
                    "side": name,
                    "notice": kw.get("notice"),
                    "payload": kw.get("payload"),
                }
            )

    # ---- команды от браузера ----
    async def start(self, a: dict, b: dict) -> None:
        await self.stop()
        self.clients["1"] = NektoClient(
            "1", a.get("token", "").strip(), a.get("ua", ""),
            search_params=a.get("search"), on_event=self.on_event,
        )
        self.clients["2"] = NektoClient(
            "2", b.get("token", "").strip(), b.get("ua", ""),
            search_params=b.get("search"), on_event=self.on_event,
        )
        results = await asyncio.gather(
            self.clients["1"].connect(),
            self.clients["2"].connect(),
            return_exceptions=True,
        )
        for side, res in zip(("1", "2"), results):
            if isinstance(res, Exception):
                await self.send_browser(
                    {"type": "system", "text": f"Не удалось подключить сторону {side}: {res}"}
                )

    async def send_as(self, as_side: str, text: str) -> None:
        """Написать «от лица» собеседника as_side → доставить его партнёру."""
        target = self.clients.get(self.partner(as_side))
        if target:
            await target.send_message(text)
        await self.send_browser(
            {"type": "message", "from": as_side, "text": text, "injected": True}
        )

    async def typing_as(self, as_side: str, typing: bool) -> None:
        target = self.clients.get(self.partner(as_side))
        if target:
            await target.set_typing(typing)

    async def skip(self) -> None:
        for c in self.clients.values():
            await c.search()

    async def search_side(self, side: str) -> None:
        """Искать нового собеседника только для одной стороны ("1" или "2")."""
        c = self.clients.get(side)
        if c:
            await c.search()

    async def set_relay(self, enabled: bool) -> None:
        self.relay = enabled
        await self.send_browser(
            {"type": "system", "text": f"Автопересылка: {'включена' if enabled else 'выключена'}"}
        )

    async def stop(self) -> None:
        for c in list(self.clients.values()):
            await c.disconnect()
        self.clients.clear()


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    # Своя сессия на каждое подключение (вкладку): два независимых окна
    # не делят клиентов nekto и не «перехватывают» диалог друг у друга.
    session = Session()
    ws = web.WebSocketResponse(heartbeat=25)
    await ws.prepare(request)
    session.ws = ws
    await session.send_browser({"type": "system", "text": "Подключено к серверу."})

    try:
        async for msg in ws:
            if msg.type != web.WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except json.JSONDecodeError:
                continue

            t = data.get("type")
            try:
                if t == "connect":
                    session.relay = bool(data.get("relay", True))
                    await session.start(data.get("a", {}), data.get("b", {}))
                elif t == "send":
                    text = (data.get("text") or "").strip()
                    if text:
                        await session.send_as(data.get("as", "1"), text)
                elif t == "typing":
                    await session.typing_as(data.get("as", "1"), bool(data.get("typing")))
                elif t == "relay":
                    await session.set_relay(bool(data.get("enabled")))
                elif t == "skip":
                    await session.skip()
                elif t == "search":
                    await session.search_side(data.get("side", "1"))
                elif t == "stop":
                    await session.stop()
                    await session.send_browser({"type": "system", "text": "Отключено."})
            except Exception as e:  # noqa: BLE001 — не роняем сокет на ошибке команды
                await session.send_browser({"type": "system", "text": f"Ошибка команды: {e}"})
    finally:
        # вкладку закрыли/перезагрузили — отпускаем оба клиента nekto
        await session.stop()

    return ws


async def index(_request: web.Request) -> web.FileResponse:
    return web.FileResponse(STATIC / "index.html")


def build_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/app.js", lambda r: web.FileResponse(STATIC / "app.js"))
    app.router.add_get("/style.css", lambda r: web.FileResponse(STATIC / "style.css"))
    return app


if __name__ == "__main__":
    print(f"Открой в браузере:  http://{HOST}:{PORT}")
    web.run_app(build_app(), host=HOST, port=PORT, print=None)
