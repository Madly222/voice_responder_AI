# MIGRATION.md — перенос avr-infra на другой сервер и сборка с нуля

> Написано по итогам реальных переездов (192.0.2.12 → 192.0.2.11 → 192.0.2.10, сентябрь 2026).
> Каждая «ловушка» — то, на чём реально спотыкались, с симптомом и решением.
> Что за проект и как его эксплуатировать — `PROJECT.md`; настройка агента — `ULTRAVOX.md`.

---

## 0. Сценарии и места, которые придётся тронуть

| Сценарий | Когда | Разделы |
|---|---|---|
| **A. Перенос** | Старый сервер жив | 1 → 2 → 3 → 4 → 5A → 6–12 |
| **B. С нуля** | Старого сервера нет | 4 → 5B → 6–10 → 12 |

| Где | Что менять при смене IP/сервера |
|---|---|
| Новый сервер | `pjsip.conf` (`external_*`, `match=`), `.env`, nginx + сертификат, ufw |
| АТС Elastix/FreePBX | `host=` транка → новый IP |
| Биллинг WHMCS | `$allowed_ips` в PHP-коннекторе |
| Хост NetBox | ufw для нового адреса |
| Свитчи | vty ACL (если новый IP вне разрешённой подсети 192.0.2.0/24) |
| MikroTik | dst-nat 8443 → новый внутренний IP; маршрут к 10.99.0.0/24 |
| Technitium DNS | A-запись `avr.example.com` (если меняется внешний IP), TSIG/политика |
| Ultravox | ничего, если домен и ключ те же; при сборке с нуля — всё по `ULTRAVOX.md` |
| GitHub | deploy key нового сервера (`~/.ssh/avr-infra_deploy`), если пушить с него |

Согласование доступов (фаервол, ACL, NAT) может занять дни — **заявки первыми**.

---

## 1. Инвентаризация на старом сервере (A)

```bash
cd ~/avr-infra \
&& STAMP=$(date +%Y%m%d) \
&& { docker compose -f docker-compose-ultravox.yml -f docker-compose-admin-panel.yml ps; \
     docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}'; \
     ip -4 addr show scope global; crontab -l 2>/dev/null; sudo ufw status numbered; \
     docker --version; docker compose version; } > ~/avr-infra_state_$STAMP.txt \
&& cat ~/avr-infra_state_$STAMP.txt
```
Проверьте, что ещё живёт на машине (кроны, другие сервисы). Выпишите адреса из конфигов:
`grep -rnE '([0-9]{1,3}\.){3}[0-9]{1,3}' asterisk/conf/*.conf .env`.

Сохраните определения тулзов Ultravox: `python3 scripts/ultravox_export.py` (см. `ULTRAVOX.md` §7).

---

## 2. Архивация (A)

```bash
cd ~/avr-infra \
&& docker compose -f docker-compose-ultravox.yml -f docker-compose-admin-panel.yml down \
&& cd ~ \
&& tar czf ~/avr-infra_migration_v1.tar.gz --exclude='node_modules' --exclude='.venv' --exclude='__pycache__' avr-infra \
&& docker save $(docker images --format '{{.Repository}}:{{.Tag}}' | grep -v '<none>' \
     | grep -iE 'avr|agentvoiceresponse|faq|network-diag|admin') | gzip > ~/avr-infra_images_v1.tar.gz \
&& sudo tar czf ~/avr-infra_host_v1.tar.gz -C / etc/nginx/avr_tool_key etc/nginx/avr_tool_key.conf \
     etc/nginx/sites-available/avr-tools.conf root/.secrets/rfc2136.ini \
&& sudo chown $USER ~/avr-infra_host_v1.tar.gz \
&& ls -lh ~/avr-infra_*_v1.tar.gz && md5sum ~/avr-infra_*_v1.tar.gz
```
`avr-infra_host_v1.tar.gz` — секреты хоста (ключ тулзов, TSIG). Сертификат не переносим —
выпускаем заново на новом сервере (занимает 3 минуты).

**Ловушка 1. `.env` в архиве.** Штатный `.tarignore` исключает `.env`, для переезда он нужен.
Проверка: `tar tzf ~/avr-infra_migration_v1.tar.gz | grep -E '\.env$|calls\.txt|asterisk/conf/'`.

**Ловушка 2. Образы не тянуть заново.** Апстрим заморожен, `latest` со временем указывает на другое.
Только `docker save/load`.

**Ловушка 3. Путь журнала.** `faq-server/data/calls.txt`, не `data/calls.txt`.

---

## 3. Перенос архивов (A)

**Ловушка 4. Асимметричный фаервол между VLAN.** С одной стороны ssh проходит, с другой — timeout.
Толкайте `scp` оттуда, откуда соединение проходит. Через ПК — WinSCP в режиме **Binary**, сверить
MD5 и удалить копии с ПК (внутри ключи).

---

## 4. Подготовка сервера (A и B)

**Ловушка 5. `docker-compose-plugin` нет в репозиториях Ubuntu** — ставить из репозитория Docker:
```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl gnupg \
&& sudo install -m 0755 -d /etc/apt/keyrings \
&& curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null \
&& sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
&& sudo systemctl enable --now docker && sudo usermod -aG docker $USER
```
После `usermod` перезайти по ssh.

**Ловушка 6. Место на диске** — нужно ~7 ГБ. `df -Th /`; если LV занимает часть VG:
`sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv && sudo resize2fs /dev/ubuntu-vg/ubuntu-lv`.

Предпроверки: `ip route | grep 172.28.` (подсеть сети `avr` свободна),
`ss -tulpn | grep -E ':(5060|5038|8088|3000|5000|5001|80|8443)\b'`.

**ufw** (первым — 22, иначе оборвёте ssh):
```bash
sudo ufw allow 22/tcp && sudo ufw allow 5060 && sudo ufw allow 10000:10050/udp \
&& sudo ufw allow 80/tcp && sudo ufw allow 8443/tcp comment 'avr-infra nginx tools (Ultravox)' \
&& sudo ufw --force enable && sudo ufw status numbered
```

---

## 5A. Разворачивание из архива

```bash
cd ~ \
&& gunzip -c ~/avr-infra_images_v1.tar.gz | docker load \
&& tar xzf ~/avr-infra_migration_v1.tar.gz -C . \
&& sudo tar xzf ~/avr-infra_host_v1.tar.gz -C / \
&& chmod 600 ~/avr-infra/.env \
&& cd ~/avr-infra \
&& docker compose -f docker-compose-ultravox.yml -f docker-compose-admin-panel.yml up -d \
&& sleep 20 && curl -s localhost:3000/health && echo && curl -s localhost:5000/health
```
Первый запуск — **без `--build`**. Дальше — раздел 6.

## 5B. Сборка с нуля

> **Проще:** `git clone` → `sudo ./install.sh [--domain … --dns-mode …]` → панель → вкладка «Справка» (чек-лист).
> Ниже — то же самое вручную и детали для нашего сервера.

1. **Код** — `git clone git@github.com:<user>/<repo>.git ~/avr-infra` (или из резервной копии).
   В репозитории НЕТ: `.env`, `faq-server/data/calls.txt`, `asterisk/conf/pjsip.conf`,
   `manager.conf`, `ari.conf` — последние три восстанавливаются из `*.example`
   (пароли помечены `CHANGE_ME`):
   ```bash
   cd ~/avr-infra/asterisk/conf \
   && for f in pjsip manager ari; do [ -f $f.conf ] || cp $f.conf.example $f.conf; done \
   && grep -rn CHANGE_ME . || echo "пароли заполнены"
   ```
2. **`.env`** — `.env.example` апстримовый, кастомных переменных в нём нет. Полный список:
```ini
ULTRAVOX_AGENT_ID=
ULTRAVOX_API_KEY=
WHMCS_CUSTOM_API=            # URL PHP-коннектора (http, порт 80)
WHMCS_API_KEY=               # == $api_key в PHP
NETBOX_API_URL=http://192.0.2.40/
NETBOX_API_TOKEN=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
NETWORK_USER=api             # учётка RADIUS на свитчах
NETWORK_PASS=
NETWORK_ENABLE=
SWITCH_MGMT_NETS=10.99.0.0/24   # сети управления (через , или ;): faq-server ищет в них адрес свитча, network-diag пускает SSH только туда
TOOLS_PUBLIC_URL=https://avr.example.com:8443
TOOLS_API_KEY=               # = содержимое /etc/nginx/avr_tool_key
WHMCS_ADMIN_URL=http://192.0.2.30/admin   # для ссылки на клиента в Telegram
NETBOX_WEB_URL=              # если веб NetBox не совпадает с NETBOX_API_URL
PROJECT_DIR=/home/<user>/avr-infra
PANEL_BIND=0.0.0.0
PANEL_PORT=80
PANEL_USER=
PANEL_PASS=                  # обязателен
```
   `chmod 600 .env`. AMI-логин (`avr/avr`) задан в compose и `manager.conf` — сменить в обоих.
3. **Образы** — из бэкапа `docker load` (единственный способ получить те же апстримовые сборки).
   Если бэкапа нет: `docker compose -f docker-compose-ultravox.yml up -d --build` (риск ловушки 2),
   после первого успешного запуска — сразу `docker save` в бэкап.
4. **Ultravox** — агент и тулзы по `ULTRAVOX.md`.
5. **PHP-коннектор WHMCS** — из копии в вебрут биллинга; настроить `$allowed_ips`, `$api_key`,
   `$db_pass`, fieldid 15, groupid 1/2. Обязательно: `mysql_query("SET NAMES utf8", $conn);`
   сразу после `mysql_select_db` (иначе диакритика приходит как `?`), и в ответе должны быть
   `address`, `client_id`, `debt` — от них зависят адрес и ссылка на биллинг в Telegram.

---

## 6. Настройка под новый хост

### 6.1. `pjsip.conf`
- `external_media_address` / `external_signaling_address` (4 строки) → **собственный IP нового сервера**;
- `local_net` — должна покрывать LAN сервера (сейчас `192.0.2.0/24`);
- `match=` транка `PBX_TRUNK` → **все** адреса, с которых АТС может прислать INVITE.

**Ловушка 7.** `external_*` — это *наш* адрес (подставляется в SDP), не адрес АТС.

**Ловушка 8. АТС меняет адрес-источник, если сервер переехал в другую подсеть.** У АТС интерфейсы
в нескольких подсетях; она отправляет SIP с того, что в одной подсети с нашим сервером
(так .29.10 стал .22.42). Симптом: в `tcpdump port 5060` INVITE → `401 Unauthorized`, звонок не
доходит. Решение: добавить адрес в `match=`.

**Ловушка 9. `sed -i` и файлы, смонтированные в контейнер.** `sed -i` создаёт новый файл, контейнер
держит старый → `pjsip reload` читает старую версию. Править через панель/`nano`, или после
`sed -i` — `docker restart avr-asterisk`. Проверка:
`docker exec avr-asterisk grep -n match /etc/asterisk/my_pjsip.conf`.

### 6.2. `.env`
`PROJECT_DIR`, `PANEL_BIND`, при переезде сервисов — `WHMCS_CUSTOM_API`, `NETBOX_API_URL`.
Должны быть оба ID агентов: `ULTRAVOX_AGENT_ID` (RO) и `ULTRAVOX_AGENT_ID_RU` (RU) — без второго
`avr-sts-ultravox-ru` не создаёт звонки, и выбор «2» в меню даёт тишину.

**Ловушка 24. Меню языка не звучит.** Запись `asterisk/sounds/lang-menu.wav` лежит вне git (или
не перенесена) — без неё меню молча пропускается и все звонки идут к RO. Перенести файл вместе с
проектом; формат WAV 8 кГц, моно, 16 бит (`asterisk/sounds/README.md`).

**Ловушка 10.** `set -a; . ./.env` в сессии → переменные шелла перекрывают файл
(`cannot assign requested address`). Перезайти или использовать подоболочку `( … )`.

### 6.3. Панель
`docker compose -f docker-compose-ultravox.yml -f docker-compose-admin-panel.yml up -d admin-panel`.

---

## 7. Публичный вход: nginx + Let's Encrypt

Порты 80/443 внешнего IP заняты почтовым сервером → внешний порт **8443**, сертификат по **DNS-01**.

### 7.1. Technitium DNS (primary 203.0.113.53)
1. **Zones → example.com → Add Record:** `avr`, A, TTL 300, внешний IP (сейчас `203.0.113.10`).
2. **Settings → TSIG → Add:** `certbot-avr`, HMAC-SHA256, secret — сгенерировать.
3. **Zone Options → Dynamic Updates:** Specified IP Addresses → внутренний IP сервера и внешний IP
   MikroTik (запрос может прийти после NAT); **Update Security Policies:** ключ `certbot-avr`,
   домен `_acme-challenge.avr.example.com`, тип `TXT`.
4. На secondary (.138) — только Notify/Zone Transfer с primary.

Проверка: `dig +short @203.0.113.53 avr.example.com A ; dig +short @203.0.113.54 avr.example.com A`.

### 7.2. Секрет TSIG на сервере
```bash
read -rsp "TSIG secret: " S ; echo ; [ -n "$S" ] && sudo mkdir -p /root/.secrets \
&& printf 'dns_rfc2136_server = 203.0.113.53\ndns_rfc2136_port = 53\ndns_rfc2136_name = certbot-avr\ndns_rfc2136_secret = %s\ndns_rfc2136_algorithm = HMAC-SHA256\n' "$S" | sudo tee /root/.secrets/rfc2136.ini >/dev/null \
&& sudo chmod 600 /root/.secrets/rfc2136.ini ; unset S
```
**Ловушка 11. Потерянный `=` в конце secret.** base64 должен иметь длину, кратную 4 (обычно 44).
Симптом: `binascii.Error: Incorrect padding`. Лечение:
`sudo sed -i -E 's#^(dns_rfc2136_secret = [A-Za-z0-9+/]{43})$#\1=#' /root/.secrets/rfc2136.ini`.

### 7.3. Установка
```bash
cd ~/avr-infra \
&& sudo LE_EMAIL=admin@example.com ./deploy/nginx/install_nginx.sh avr.example.com rfc2136 8443 \
&& sudo certbot renew --dry-run
```
Скрипт: ставит nginx/certbot (nginx не стартует сам — **ловушка 12: порт 80 занят панелью**, дефолтный
сайт удаляется), выпускает сертификат (ждёт 120 с распространения TXT; `DNS_WAIT=300` если .138
не успевает), генерирует ключ `X-AVR-Key` (если его нет — при переносе из 5A он уже есть), пишет
конфиг, проверяет локально: с ключом 200, без — 403, `getCalls`/`/health` — 000.
`--dry-run` идёт 2–3 минуты без вывода — это нормально.

**Ловушка 23. Таймер продления не запущен.** После установки certbot `certbot.timer` бывает
`enabled`, но `inactive (dead)` до перезагрузки, а cron-задание certbot при systemd ничего не делает —
сертификат молча истечёт через 90 дней. Проверка: `systemctl list-timers certbot.timer` (в NEXT
должна быть дата). Лечение: `sudo systemctl enable --now certbot.timer`.

### 7.4. MikroTik
```
/ip service print where port=8443
/ip firewall nat add chain=dstnat dst-address=203.0.113.10 protocol=tcp dst-port=8443 action=dst-nat to-addresses=<IP_СЕРВЕРА> to-ports=8443 comment="avr-infra tools https"
/ip firewall filter add chain=forward dst-address=<IP_СЕРВЕРА> protocol=tcp dst-port=8443 connection-state=new connection-limit=20,32 action=drop comment="avr-infra: limit conn per src"
/ip firewall filter add chain=forward dst-address=<IP_СЕРВЕРА> protocol=tcp dst-port=8443 connection-nat-state=dstnat action=accept comment="avr-infra tools https"
```
Правила filter — выше общего drop в forward.

**Ловушка 13. ufw режет nginx.** nginx на хосте (не в Docker) → ufw его фильтрует. Симптом: в
`tcpdump port 8443` приходят SYN, ответов нет, снаружи «вечная загрузка». Решение: `ufw allow 8443/tcp`.

**Ловушка 14. Проверка изнутри сети бессмысленна** (нет hairpin NAT — висит). Проверять с телефона
через мобильный интернет или check-host.net (TCP `avr.example.com:8443`). Ожидаемо: замок без
предупреждения, `403` (GET без ключа).

---

## 8. Встречная АТС (Elastix / FreePBX)

**Ловушка 15. Правка `sip_additional.conf` бесполезна** — генерируется из MySQL. Через веб:
Trunks → транк → PEER Details `host=<новый-ip>` → Submit → **Apply Config**. Или:
`mysql asterisk -e "UPDATE sip SET data=REPLACE(data,'<старый>','<новый>') WHERE data LIKE '%<старый>%';" && fwconsole reload`.

**Ловушка 16. Звонок проходит, агент молчит** (`ECONNRESET` в `avr-core` через ~30 с) — RTP в одну
сторону. На пире: `directmedia=no`, `nat=force_rport,comedia`.

**Ловушка 17. Нет ни одного INVITE в tcpdump** — звонок не долетает (адрес/фаервол), pjsip не трогать.
Есть INVITE, но `401` — ловушка 8.

---

## 8а. Ultravox

**Ловушка 20. Inactivity Messages кладут трубку во время работы тулзов.** Симптом: клиент назвал
OSMP, агент молчит, через 15 с звучит «Pot sa va ajut cu ceva?» и звонок обрывается. Первое
сообщение должно быть не короче 45 с и **без Hang Up**; трубку кладёт только второе (120 с).

**Ловушка 21. Правка тулза ломается о привязку к агенту** («incompatible with how some agents use
the tool»). Отвязать тулз от агента, поправить, привязать обратно — или
`python3 scripts/ultravox_tool_params.py --apply <тулз>`, он делает это сам.

**Агентов два** (RO и RU, `ULTRAVOX.md` §1): при переносе в другой аккаунт Ultravox создать оба
(RU — `scripts/ultravox_agent_clone.py` копией RO) и записать оба ID в `.env`.

**Ловушка 22. Статические параметры не видны в интерфейсе.** После сохранения `X-AVR-Key` в списке
не появляется; это особенность дашборда. Проверять через Test tool (200 без Auth tokens) или
`scripts/ultravox_export.py`. **Auth tokens не использовать** — они передаются при создании звонка,
а `avr-sts-ultravox` их не шлёт.

---

## 9. Внешние интеграции

- **WHMCS:** новый IP в `$allowed_ips` (`sudo sed -i` по строке с массивом или `nano`), проверка:
  `( set -a; . ./.env; set +a; curl -s "$WHMCS_CUSTOM_API?api_key=$WHMCS_API_KEY&action=find_by_osmp&osmp_id=12345" )`
  → `OSMP ID trebuie…` = доступ есть.
- **NetBox:** `sudo ufw allow from <новый-ip> to any port 80 proto tcp` на хосте NetBox.
  **Ловушка 18.** NetBox и WHMCS — HTTP 80, не 443.
- **Свитчи:** маршрут к 10.99.0.0/24 через MikroTik; vty ACL; учётка `api` в RADIUS.
  `refused` на 22 **и** 23 = vty ACL (отказ до логина), `Authentication failed` = учётка,
  `timeout` = маршрут/фильтр. Проверка: `python3 scripts/diag_probe.py --ssh-limit 50 && python3 scripts/diag_report.py`.

---

## 10. Сеть и безопасность

**Ловушка 19. ufw не фильтрует порты, опубликованные Docker** (правила в цепочке `DOCKER`).
Служебные порты — только `127.0.0.1:` в compose; реальная фильтрация — `DOCKER-USER`.
nginx (на хосте) ufw фильтрует — см. ловушку 13.

---

## 11. Порядок переключения (A)

1. Новый сервер развёрнут, `/health` зелёные, панель открывается.
2. `pjsip.conf` поправлен (`external_*`, `match=`), `docker restart avr-asterisk`.
3. Доступы открыты и проверены curl: WHMCS, NetBox, свитчи, nginx локально (200/403).
4. Старый стек погашен; свежий `calls.txt` перенесён.
5. MikroTik: dst-nat 8443 → новый сервер. **Это момент переключения тулзов** (домен и ключ те же).
6. АТС: `host=` транка → новый сервер, Apply Config.
7. Тестовый звонок: агент отвечает, звук в обе стороны, OSMP находится, Telegram пришёл,
   в `/var/log/nginx/avr-tools.access.log` — `200`.
8. Старую VM не удалять 1–2 недели.

Откат до шага 5: вернуть dst-nat и `host=` на старый сервер, поднять там стек.

---

## 12. Финальный чек-лист

- `PROJECT.md` §8.2 — полная проверка без ошибок;
- снаружи `https://avr.example.com:8443/tool/searchFAQ` → замок + 403;
- Ultravox **Test tool** каждого тулза → 200 (`ULTRAVOX.md` §5);
- `sudo certbot renew --dry-run` → succeeded;
- `sudo reboot` → всё поднялось само (контейнеры, nginx);
- тестовый звонок через АТС: меню языка звучит, **1** → румынский агент, **2** → русский;
- `docker save` образов в бэкап (для сценария B — обязательно).

---

## 13. Сводка ловушек

| # | Симптом | Причина | Раздел |
|---|---|---|---|
| 1 | В архиве нет `.env` | `.tarignore` | 2 |
| 2 | Сервисы ведут себя иначе | Образы подтянуты заново | 2, 5B |
| 3 | Журнал не найден | `faq-server/data/calls.txt` | 2 |
| 4 | `scp` timeout в одну сторону | Stateful-фаервол между VLAN | 3 |
| 5 | Нет `docker-compose-plugin` | Нет в репозиториях Ubuntu | 4 |
| 6 | Нет места под образы | LV — часть VG | 4 |
| 7 | Тишина / односторонний звук | `external_*` с чужим адресом | 6.1 |
| 8 | INVITE → 401, звонок не доходит | АТС сменила адрес-источник, нет в `match=` | 6.1 |
| 9 | Правка pjsip не применяется | `sed -i` + bind-mount → `docker restart` | 6.1 |
| 10 | `cannot assign requested address` | `.env` экспортирован в шелл | 6.2 |
| 11 | `binascii.Error: Incorrect padding` | Потерян `=` в TSIG secret | 7.2 |
| 12 | nginx не ставится/не стартует | Порт 80 занят панелью | 7.3 |
| 13 | Снаружи 8443 висит, SYN без ответа | ufw режет nginx | 7.4 |
| 14 | Изнутри сети домен висит | Нет hairpin NAT — проверять снаружи | 7.4 |
| 15 | Правка конфига АТС не применяется | FreePBX генерирует из MySQL | 8 |
| 16 | Агент молчит, `ECONNRESET` 30 с | RTP в одну сторону | 8 |
| 17 | Нет INVITE | Звонок не долетает | 8 |
| 18 | Интеграция красная | Не тот порт / ufw на чужом хосте | 9 |
| 19 | ufw «разрешает», порт открыт всем | Docker обходит INPUT | 10 |
| 20 | Звонок обрывается, пока работают тулзы | Inactivity Message с Hang Up на 15 с | 8а |
| 21 | Тулз не сохраняется | Привязан к агенту | 8а |
| 22 | «Пропал» статический параметр | Интерфейс их не показывает | 8а |
| 23 | Сертификат не продлевается | `certbot.timer` не запущен | 7.3 |
| 24 | Меню языка не звучит, все звонки к RO | Нет `asterisk/sounds/lang-menu.wav` | 6.2 |
| + | Ultravox: 403 в access-логе, конфликт с агентом, «пропал» параметр | см. `ULTRAVOX.md` §8 | — |
