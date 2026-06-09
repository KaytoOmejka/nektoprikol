#!/usr/bin/env bash
# Запуск моста nekto.me: создаёт venv, ставит зависимости, поднимает сервер.
set -e
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  echo "Создаю виртуальное окружение…"
  python3 -m venv .venv
fi
source .venv/bin/activate

echo "Проверяю зависимости…"
pip install -q --upgrade pip >/dev/null
pip install -q -r requirements.txt

URL="http://127.0.0.1:8765"
echo "Открываю $URL"
( sleep 1; command -v open >/dev/null && open "$URL" || true ) &

python server.py
