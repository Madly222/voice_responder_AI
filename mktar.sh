#!/usr/bin/env bash
# mktar.sh: build a clean project archive for code review and check it for secrets.
# Usage:    ./mktar.sh <project_path>   [archive_name]
# Example:  ./mktar.sh ~/avr-infra          avr-infra
set -euo pipefail

SRC="${1:?укажи путь к папке проекта: ./mktar.sh ~/avr-infra}"
SRC="$(cd "$SRC" && pwd)"
NAME="${2:-$(basename "$SRC")}"                 # archive name defaults to the folder name
PARENT="$(dirname "$SRC")"
BASE="$(basename "$SRC")"
IGNORE="$(dirname "$(readlink -f "$0")")/.tarignore"
OUT="$HOME/${NAME}.tar.gz"

[ -f "$IGNORE" ] || { echo "!! Не найден .tarignore рядом со скриптом: $IGNORE"; exit 1; }

echo ">> Собираю $OUT из $SRC"
tar czf "$OUT" --exclude-from="$IGNORE" -C "$PARENT" "$BASE"

echo ">> Проверяю содержимое архива на то, что не должно было попасть..."
LEAK=0
# any .env (other than .env.example) in the archive?
if tar tzf "$OUT" | grep -E '(^|/)\.env($|\.)' | grep -v '\.env\.example' | grep -q .; then
  echo "  !! В архиве есть .env-файл:"; tar tzf "$OUT" | grep -E '(^|/)\.env' | grep -v example | sed 's/^/     /'; LEAK=1
fi
# keys / certificates?
if tar tzf "$OUT" | grep -qiE '\.(pem|key|p12|pfx|ppk)$|id_rsa|id_ed25519'; then
  echo "  !! В архиве есть ключи/сертификаты:"; tar tzf "$OUT" | grep -iE '\.(pem|key|p12|pfx|ppk)$|id_rsa|id_ed25519' | sed 's/^/     /'; LEAK=1
fi
# unpack to a temp dir and grep for live secrets
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
tar xzf "$OUT" -C "$TMP"
HITS="$(grep -rniE '(sk-ant-api03-[a-zA-Z0-9_-]{20}|sk-[a-zA-Z0-9]{20}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|xoxb-[0-9]|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY)' "$TMP" 2>/dev/null | grep -vE 'example|placeholder|SUPERSECRET|sk-ant-\.\.\.|YOUR|test' | head -10 || true)"
if [ -n "$HITS" ]; then
  echo "  !! Похоже на живые секреты в коде (значения скрыты):"; echo "$HITS" | cut -d: -f1,2 | sed "s|$TMP/|     |"; LEAK=1
fi

SIZE="$(du -h "$OUT" | cut -f1)"
if [ "$LEAK" -eq 0 ]; then
  echo ">> Чисто. Архив готов: $OUT ($SIZE)"
else
  echo ">> !!! ВНИМАНИЕ: нашлись подозрительные файлы выше. Проверь перед отправкой. Архив: $OUT ($SIZE)"
fi
