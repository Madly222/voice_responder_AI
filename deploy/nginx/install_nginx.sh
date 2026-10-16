#!/usr/bin/env bash
# install_nginx.sh — nginx + Let's Encrypt (DNS-проверка) для тулзов avr-infra на 192.0.2.10
#
#   sudo ./deploy/nginx/install_nginx.sh <домен> <режим> [порт]
#     режим: rfc2136    — автопродление через свой DNS (BIND и др., TSIG), нужен /root/.secrets/rfc2136.ini
#            cloudflare — автопродление через API Cloudflare (нужен /root/.secrets/cloudflare.ini)
#            manual     — TXT-запись вручную (продлевать руками раз в 90 дней!)
#     порт:  по умолчанию 8443
set -euo pipefail

DOMAIN="${1:?Укажите домен, например avr.example.com}"
MODE="${2:?Укажите режим: rfc2136 | cloudflare | manual}"
PORT="${3:-8443}"
EMAIL="${LE_EMAIL:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
KEYFILE=/etc/nginx/avr_tool_key
MAPFILE=/etc/nginx/avr_tool_key.conf
SITE=/etc/nginx/sites-available/avr-tools.conf

[ "$(id -u)" -eq 0 ] || { echo "Запускайте через sudo"; exit 1; }
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "Порт должен быть числом"; exit 1; }
ss -ltnH "sport = :$PORT" | grep -q . && { echo "Порт $PORT уже занят:"; ss -ltnp "sport = :$PORT"; exit 1; }

echo "=== 1. Пакеты (nginx не стартует сам: порт 80 занят панелью) ==="
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d
trap 'rm -f /usr/sbin/policy-rc.d' EXIT
apt-get update -q
PKGS="nginx certbot"
[ "$MODE" = cloudflare ] && PKGS="$PKGS python3-certbot-dns-cloudflare"
[ "$MODE" = rfc2136 ] && PKGS="$PKGS python3-certbot-dns-rfc2136"
DEBIAN_FRONTEND=noninteractive apt-get install -y -q $PKGS
rm -f /usr/sbin/policy-rc.d; trap - EXIT
rm -f /etc/nginx/sites-enabled/default

echo "=== 2. Сертификат для $DOMAIN (DNS-01) ==="
EMAIL_ARGS=(--register-unsafely-without-email)
[ -n "$EMAIL" ] && EMAIL_ARGS=(-m "$EMAIL")
if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  echo "Сертификат уже есть — пропускаю выпуск"
elif [ "$MODE" = rfc2136 ]; then
  RF=/root/.secrets/rfc2136.ini
  [ -f "$RF" ] || { echo "Нет $RF (см. инструкцию: server, name, secret, algorithm)"; exit 1; }
  chmod 600 "$RF"
  certbot certonly --non-interactive --agree-tos "${EMAIL_ARGS[@]}" \
    --dns-rfc2136 --dns-rfc2136-credentials "$RF" --dns-rfc2136-propagation-seconds "${DNS_WAIT:-120}" \
    -d "$DOMAIN"
elif [ "$MODE" = cloudflare ]; then
  CF=/root/.secrets/cloudflare.ini
  [ -f "$CF" ] || { echo "Нет $CF (строка: dns_cloudflare_api_token = <токен с правом Zone.DNS:Edit>)"; exit 1; }
  chmod 600 "$CF"
  certbot certonly --non-interactive --agree-tos "${EMAIL_ARGS[@]}" \
    --dns-cloudflare --dns-cloudflare-credentials "$CF" --dns-cloudflare-propagation-seconds "${DNS_WAIT:-30}" \
    -d "$DOMAIN"
elif [ "$MODE" = manual ]; then
  echo "certbot покажет TXT-запись _acme-challenge.$DOMAIN — создайте её у DNS-провайдера, подождите 1-2 мин и нажмите Enter"
  certbot certonly --manual --preferred-challenges dns --agree-tos "${EMAIL_ARGS[@]}" -d "$DOMAIN"
  echo "ВНИМАНИЕ: режим manual не продлевается сам. Повторите выпуск до: $(date -d '+80 days' +%F)"
else
  echo "Неизвестный режим: $MODE"; exit 1
fi

echo "=== 3. Секретный ключ заголовка X-AVR-Key ==="
if [ ! -s "$KEYFILE" ]; then
  openssl rand -hex 32 > "$KEYFILE"
  NEWKEY=1
fi
chmod 600 "$KEYFILE"
KEY="$(tr -d '\n' < "$KEYFILE")"
cat > "$MAPFILE" <<MAP
map \$http_x_avr_key \$avr_key_ok {
    default 0;
    "$KEY" 1;
}
MAP
chmod 600 "$MAPFILE"

echo "=== 4. Конфиг nginx ==="
sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$PORT/g" "$HERE/avr-tools.conf.template" > "$SITE"
ln -sf "$SITE" /etc/nginx/sites-enabled/avr-tools.conf
nginx -t
systemctl enable --now nginx
systemctl reload nginx

echo "=== 5. Хук продления: перезагрузка nginx ==="
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

echo "=== 6. Проверка локально ==="
U="https://$DOMAIN:$PORT"
R=(--resolve "$DOMAIN:$PORT:127.0.0.1" -s -m 10 -o /dev/null -w '%{http_code}')
echo "с ключом (ждём 200):   $(curl "${R[@]}" -X POST "$U/tool/searchFAQ" -H 'Content-Type: application/json' -H "X-AVR-Key: $KEY" -d '{"query":"internet nu merge","lang":"ro"}')"
echo "без ключа (ждём 403):  $(curl "${R[@]}" -X POST "$U/tool/searchFAQ" -H 'Content-Type: application/json' -d '{"query":"test"}')"
echo "getCalls (ждём 000):   $(curl "${R[@]}" -X POST "$U/tool/getCalls" -H "X-AVR-Key: $KEY" || true)"
echo "endCall (ждём 000):    $(curl "${R[@]}" -X POST "$U/tool/endCall" -H "X-AVR-Key: $KEY" || true)"
echo "/health (ждём 000):    $(curl "${R[@]}" "$U/health" || true)"

echo
echo "Готово. Базовый URL для Ultravox: $U/tool/<имя>"
if [ "${NEWKEY:-0}" = 1 ]; then
  echo "Ключ для заголовка X-AVR-Key (показан один раз, лежит в $KEYFILE):"
  echo "  $KEY"
else
  echo "Ключ не менялся. Посмотреть: sudo cat $KEYFILE"
fi
