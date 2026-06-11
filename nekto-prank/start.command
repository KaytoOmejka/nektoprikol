#!/usr/bin/env bash
# Двойной клик в Finder запустит мост. Если macOS ругается на безопасность —
# правый клик по файлу → «Открыть».
cd "$(dirname "$0")"
exec ./start.sh
