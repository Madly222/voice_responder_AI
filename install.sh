#!/usr/bin/env bash
# install.sh — подготовка сервера для avr-infra (один раз, с правами администратора).
# Делает только то, что требует root. Всё остальное настраивается в панели (вкладка «Справка»).
#
#   sudo ./install.sh                         # Docker, файлы настроек, firewall, запуск сервисов
#   sudo ./install.sh --domain avr.example.com --dns-mode cloudflare [--port 8443]
#                                             # + публичный вход для тулзов (nginx + сертификат)
#   ./install.sh --dry-run [...]              # только показать, что будет сделано (без sudo, ничего не меняет)
#
# Повторный запуск безопасен: сделанные шаги пропускаются, существующие файлы и пароли не трогаются.
# Ключи --no-firewall, --no-start — пропустить firewall / запуск сервисов.
set -euo pipefail

DRY=0; DOMAIN=""; DNS_MODE=""; TOOLS_PORT=8443; FIREWALL=1; START=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --domain) DOMAIN="${2:?}"; shift ;;
    --dns-mode) DNS_MODE="${2:?}"; shift ;;
    --port) TOOLS_PORT="${2:?}"; shift ;;
    --no-firewall) FIREWALL=0 ;;
    --no-start) START=0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Неизвестный параметр: $1 (см. --help)"; exit 1 ;;
  esac
  shift
done

PROJECT="$(cd "$(dirname "$0")" && pwd)"
OWNER="${SUDO_USER:-$(id -un)}"
OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6)"
ENV="$PROJECT/.env"
COMPOSE=(docker compose -f docker-compose-ultravox.yml -f docker-compose-admin-panel.yml)

step() { echo; echo "=== $* ==="; }
ok()   { echo "  ✓ $*"; }
todo() { echo "  → $*"; }
run()  { if [ "$DRY" = 1 ]; then echo "  [dry-run] $*"; else eval "$@"; fi; }
# Случайный пароль из 16 букв и цифр. /dev/urandom есть везде (openssl — не на каждой минимальной
# системе); обрезка подстрокой, а не head — иначе SIGPIPE ломает set -o pipefail.
randpw() { local p; p="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"; echo "${p:0:16}"; }
env_get() { grep -E "^$1=" "$ENV" 2>/dev/null | head -1 | cut -d= -f2- | sed -e "s/^'//" -e "s/'$//" -e 's/^"//' -e 's/"$//'; }
# Записать значение в .env (только если ключ пуст или отсутствует — чужие значения не трогаем).
env_set_if_empty() {
  local k="$1" v="$2"
  if [ -n "$(env_get "$k")" ]; then ok "$k уже задан — не трогаю"; return; fi
  if [ "$DRY" = 1 ]; then echo "  [dry-run] $k=<значение> в .env"; return; fi
  if grep -qE "^$k=" "$ENV"; then
    # значение через окружение — awk не трогает обратные косые; cat > сохраняет права и владельца файла
    ( umask 077
      K="$k" V="$v" awk '!done && index($0, ENVIRON["K"] "=") == 1 { print ENVIRON["K"] "=" ENVIRON["V"]; done = 1; next } { print }' \
        "$ENV" > "$ENV.tmp" && cat "$ENV.tmp" > "$ENV" && rm -f "$ENV.tmp" )
  else echo "$k=$v" >> "$ENV"; fi
  ok "$k записан в .env"
}

step "1. Проверки"
[ "$DRY" = 1 ] || [ "$(id -u)" -eq 0 ] || { echo "Запускайте через sudo (или --dry-run для просмотра)"; exit 1; }
[ -f "$PROJECT/docker-compose-ultravox.yml" ] || { echo "Скрипт должен лежать в папке проекта"; exit 1; }
. /etc/os-release 2>/dev/null || true
[ "${ID:-}" = ubuntu ] && ok "ОС: $PRETTY_NAME" || echo "  ! Проверено на Ubuntu 22.04; у вас ${PRETTY_NAME:-неизвестно} — дальше на свой страх"
ok "проект: $PROJECT, владелец: $OWNER"
FREE_GB=$(df -BG --output=avail "$PROJECT" | tail -1 | tr -dc 0-9)
[ "${FREE_GB:-0}" -ge 7 ] && ok "свободно ${FREE_GB} ГБ" || echo "  ! свободно ${FREE_GB} ГБ — нужно около 7 ГБ"
if [ -n "$DOMAIN" ]; then
  case "$DNS_MODE" in rfc2136|cloudflare|manual) ;; *) echo "Для --domain нужен --dns-mode rfc2136 | cloudflare | manual"; exit 1 ;; esac
fi

step "2. Docker"
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  ok "$(docker --version | cut -d, -f1), $(docker compose version --short 2>/dev/null | sed 's/^/compose /')"
else
  todo "ставлю Docker из официального репозитория (в репозитории Ubuntu нет docker-compose-plugin)"
  run "apt-get update -q && apt-get install -y -q ca-certificates curl gnupg"
  run "install -m 0755 -d /etc/apt/keyrings"
  run "curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg"
  run "echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \$(. /etc/os-release && echo \$VERSION_CODENAME) stable\" > /etc/apt/sources.list.d/docker.list"
  run "apt-get update -q && apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
  run "systemctl enable --now docker"
fi
if id -nG "$OWNER" | grep -qw docker; then ok "$OWNER в группе docker"
else todo "добавляю $OWNER в группу docker (подействует после перевхода по ssh)"; run "usermod -aG docker '$OWNER'"; fi

step "3. Файлы настроек"
if [ -f "$ENV" ]; then ok ".env уже есть — не трогаю"
else todo "создаю .env из .env.example"; run "cp '$PROJECT/.env.example' '$ENV'"; fi
run "chmod 600 '$ENV' && chown '$OWNER': '$ENV'"
if [ -f "$ENV" ] || [ "$DRY" = 1 ]; then
  env_set_if_empty PROJECT_DIR "$PROJECT"
  env_set_if_empty PANEL_BIND "0.0.0.0"
  env_set_if_empty PANEL_PORT "80"
  if [ -z "$(env_get PANEL_PASS)" ]; then
    NEW_PANEL_PASS="$(randpw)"
    env_set_if_empty PANEL_USER "admin"
    env_set_if_empty PANEL_PASS "$NEW_PANEL_PASS"
  else ok "пароль панели уже задан — не трогаю"; fi
fi
# Конфиги Asterisk с паролями — из образцов, CHANGE_ME заменяется случайным паролем.
# Пароль AMI (manager.conf) должен совпадать с AMI_PASSWORD в .env: берём из .env или создаём и пишем туда.
for f in pjsip manager ari; do
  c="$PROJECT/asterisk/conf/$f.conf"
  if [ -f "$c" ]; then ok "asterisk/conf/$f.conf есть"; continue; fi
  todo "создаю asterisk/conf/$f.conf из образца (со случайным паролем)"
  pw="$(randpw)"
  if [ "$f" = manager ]; then
    [ -n "$(env_get AMI_PASSWORD)" ] && pw="$(env_get AMI_PASSWORD)"
    env_set_if_empty AMI_USERNAME "avr"
    env_set_if_empty AMI_PASSWORD "$pw"
  fi
  if [ "$DRY" = 1 ]; then echo "  [dry-run] cp $f.conf.example → $f.conf, CHANGE_ME → пароль, права 600"
  else
    ( umask 077; PW="$pw" awk '{ gsub(/CHANGE_ME/, ENVIRON["PW"]); print }' "$c.example" > "$c" )
    chmod 600 "$c"; chown "$OWNER": "$c"
  fi
done
for d in "$PROJECT/instance" "$PROJECT-backups"; do
  if [ -d "$d" ]; then ok "папка $d есть"
  else todo "создаю папку $d"; run "install -d -m 700 -o '$OWNER' -g '$(id -gn "$OWNER")' '$d'"; fi
done

step "4. Firewall (ufw)"
PANEL_PORT_V="$(env_get PANEL_PORT)"; PANEL_PORT_V="${PANEL_PORT_V:-80}"
if [ "$FIREWALL" = 0 ]; then ok "пропущено (--no-firewall)"
elif ! command -v ufw >/dev/null; then echo "  ! ufw не установлен — пропускаю (настройте фильтрацию сами)"
else
  todo "разрешаю: 22/tcp (ssh — первым), 5060 (SIP), 10000-10050/udp (голос), ${PANEL_PORT_V}/tcp (панель), ${TOOLS_PORT}/tcp (тулзы)"
  run "ufw allow 22/tcp >/dev/null"
  run "ufw allow 5060 >/dev/null && ufw allow 10000:10050/udp >/dev/null"
  run "ufw allow ${PANEL_PORT_V}/tcp comment 'avr-infra panel' >/dev/null"
  run "ufw allow ${TOOLS_PORT}/tcp comment 'avr-infra tools (Ultravox)' >/dev/null"
  run "ufw --force enable >/dev/null"
  echo "  ! Панель — только для внутренней сети: не пробрасывайте ${PANEL_PORT_V} наружу."
  echo "  ! Порты Docker ufw не фильтрует — служебные порты в compose открыты только на 127.0.0.1."
fi

step "5. Запуск сервисов"
if [ "$START" = 0 ]; then ok "пропущено (--no-start)"
else
  todo "сборка и запуск (первый раз — несколько минут)"
  run "cd '$PROJECT' && ${COMPOSE[*]} up -d --build"
  [ "$DRY" = 1 ] || { sleep 15; (cd "$PROJECT" && "${COMPOSE[@]}" ps --format '  {{.Name}}: {{.Status}}'); }
fi

step "6. Публичный вход для тулзов"
if [ -z "$DOMAIN" ]; then
  ok "пропущено (нет --domain). Позже: sudo ./install.sh --domain <домен> --dns-mode <режим>"
else
  todo "nginx + сертификат для $DOMAIN:$TOOLS_PORT (режим $DNS_MODE)"
  run "'$PROJECT/deploy/nginx/install_nginx.sh' '$DOMAIN' '$DNS_MODE' '$TOOLS_PORT'"
  env_set_if_empty TOOLS_PUBLIC_URL "https://$DOMAIN:$TOOLS_PORT"
  if [ "$DRY" = 1 ]; then echo "  [dry-run] TOOLS_API_KEY=<ключ из /etc/nginx/avr_tool_key> в .env"
  elif [ -s /etc/nginx/avr_tool_key ]; then env_set_if_empty TOOLS_API_KEY "$(tr -d '\n' < /etc/nginx/avr_tool_key)"; fi
  run "systemctl enable --now certbot.timer >/dev/null 2>&1 || true"
fi

step "Готово"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "  Панель: http://${IP:-<IP сервера>}$( [ "$PANEL_PORT_V" = 80 ] || echo ":$PANEL_PORT_V" )"
if [ -n "${NEW_PANEL_PASS:-}" ] && [ "$DRY" = 0 ]; then
  echo "  Логин: admin   Пароль: $NEW_PANEL_PASS   (показан один раз; поменять — в панели)"
else
  echo "  Логин и пароль: grep -E '^PANEL_(USER|PASS)=' '$ENV'"
fi
echo "  Дальше — в панели, вкладка «Справка»: чек-лист первого запуска."
[ "$DRY" = 1 ] && echo "  (это был --dry-run: ничего не изменено)"
exit 0
