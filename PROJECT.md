# PROJECT.md — avr-infra: голосовой AI-автоответчик техподдержки ExampleNet

> Общая документация: что это, из чего состоит, как ходят данные, как эксплуатировать,
> что живёт вне сервера, открытые задачи и журнал изменений.
>
> Документы проекта:
> - `PROJECT.md` — этот файл;
> - `MIGRATION.md` — перенос на другой сервер и сборка с нуля;
> - `ULTRAVOX.md` — настройка агента и тулзов в дашборде Ultravox;
> - `ultravox/prompts/{ro,ru}.md` — образцы системных промптов агентов (живые промпты — в Ultravox, правятся в панели);
> - `LICENSE.md` — лицензия MIT апстрима agentvoiceresponse (удалять нельзя).
>
> Вспомогательные скрипты: `deploy/nginx/` (nginx + сертификат), `scripts/` (проверка свитчей,
> экспорт настроек Ultravox).

Код: приватный репозиторий **github.com/<user>/<repo>** (push с сервера по deploy key,
ssh-алиас `github-avr`). Вне репозитория: `.env`, `calls.txt`, конфиги Asterisk с паролями
(в репо только `*.example`).

Актуально на: сентябрь 2026. Прод: **192.0.2.10** (`avr-server`, Ubuntu 22.04, пользователь
`avradmin`, проект в `~/avr-infra` — рабочая копия репозитория, ветка `main`). Построено на апстриме
[agentvoiceresponse/avr-infra](https://github.com/agentvoiceresponse/avr-infra) в режиме
Speech-to-Speech через Ultravox (`docker-compose-ultravox.yml`).

---

## 1. Назначение

Клиент звонит в техподдержку, выбирает в меню язык — отвечает голосовой AI-агент на румынском
или русском (два отдельных агента). Агент ищет ответ в FAQ, находит клиента в биллинге по OSMP ID, подтягивает сетевые данные
из NetBox и при необходимости диагностирует порт/MAC на коммутаторе по SSH. По завершении звонка
сводка уходит в Telegram.

---

## 2. Архитектура

```
 Клиент ──SIP──► Elastix/FreePBX ──SIP (транк PBX_TRUNK)──► avr-asterisk :5060   (192.0.2.10)
                 192.0.2.21 / 192.0.2.20               RTP 10000-10050/udp
                                                   меню языка на 5001: 1 / 2
                                                     ┌────────────┴────────────┐ AudioSocket
                                              avr-core :5001           avr-core-ru :5001
                                                     │ WebSocket               │
                                              avr-sts-ultravox        avr-sts-ultravox-ru
                                                     │                         │
                                         ☁ Ultravox Cloud: агент SupportBotRO · SupportBotRU (LLM)
                                                              │ HTTPS POST /tool/<name>
                                                              │ заголовок X-AVR-Key
                               https://avr.example.com:8443  ▼
                 MikroTik 203.0.113.10:8443 ──dst-nat──► nginx :8443 (192.0.2.10)
                                                   TLS · ключ · только /tool/* · лимиты
                                                              │ 127.0.0.1:3000
                                                          faq-server
                                           ┌────────┬────────┼──────────┬──────────┐
                                        faq.json  WHMCS    NetBox   network-diag  Telegram
                                                 .30      .40       SSH к свитчам
                                                                   198.51.100.0/24
```

Ultravox работает в облаке, поэтому тулзы должны быть доступны по публичному HTTPS-адресу.
Вход — nginx на самом сервере, опубликованный через MikroTik на внешнем порту 8443
(80/443 внешнего IP заняты другим сервисом).

---

## 3. Компоненты

### 3.1. Контейнеры (все с `restart: always`)

| Контейнер | Порт | Роль | Происхождение |
|---|---|---|---|
| `avr-asterisk` | 5060 SIP, 5038 AMI, 8088/8089 ARI, 10000-10050/udp | Телефония | апстрим |
| `avr-core` | 5001 | AudioSocket ↔ STS, румынский | апстрим |
| `avr-sts-ultravox` | 6031 (внутр.) | Мост к облаку Ultravox, создаёт звонки агента RO (`ULTRAVOX_AGENT_ID`) | апстрим |
| `avr-core-ru` | 5001 (внутр., наружу не публикуется) | AudioSocket ↔ STS, русский | апстрим, тот же образ |
| `avr-sts-ultravox-ru` | 6031 (внутр.) | То же для агента RU (`ULTRAVOX_AGENT_ID_RU`) | апстрим, тот же образ |
| `avr-ami` | 6006 | Мост событий AMI | апстрим |
| `faq-server` | 3000 | HTTP-тулзы агента | ExampleNet |
| `network-diag` | 5000 | SSH-диагностика коммутаторов | ExampleNet |
| `admin-panel` | 80 → 8090 | Веб-панель управления | ExampleNet |

Апстрим заморожен: базовые образы не обновлять без проверки. При переносе образы переносятся
`docker save/load` (см. `MIGRATION.md`).

### 3.2. Хост (вне Docker)

| Что | Где |
|---|---|
| nginx (публичный вход тулзов) | `/etc/nginx/sites-available/avr-tools.conf`, логи `/var/log/nginx/avr-tools.*.log` |
| Ключ тулзов `X-AVR-Key` | `/etc/nginx/avr_tool_key` (+ `avr_tool_key.conf`), root, 600 |
| Сертификат Let's Encrypt | `/etc/letsencrypt/live/avr.example.com/`, автопродление certbot.timer |
| Ключ TSIG для продления | `/root/.secrets/rfc2136.ini` |
| ufw | 22/tcp, 5060, 10000:10050/udp, 80/tcp, 8443/tcp |

### 3.3. Сеть и порты

Docker-сеть `avr` (172.28.0.0/24), контейнеры видят друг друга по именам (`network-diag:5000` и т.д.).
Наружу из контейнеров: 80 (панель), 5060, 5001, RTP. Служебные 3000, 5000, 5038, 6006, 8088, 8089 —
только на `127.0.0.1`. Порты, опубликованные Docker, ufw не фильтрует (фильтрация — `DOCKER-USER`),
а nginx работает на хосте — его ufw фильтрует (отсюда правило 8443/tcp).

---

## 4. Тулзы агента (faq-server)

Облако Ultravox вызывает их `POST https://avr.example.com:8443/tool/<name>` с заголовком
`X-AVR-Key`. Полные определения (описания, параметры, таймауты) — в `ULTRAVOX.md`.

| Тулз | Что делает | Зависит от | Подключён в Ultravox |
|---|---|---|---|
| `searchFAQ` | Поиск ответа в базе сценариев | `faq.json` | да |
| `findByOSMP` | Клиент по OSMP ID | WHMCS PHP-коннектор | да |
| `getNetworkData` | IP клиента → MAC, свитч, порт, POP | NetBox | да |
| `diagnoseClient` | Статус порта + поиск MAC на свитче | network-diag (SSH) | да |
| `updateCall` | Дозапись данных в карточку звонка, в т.ч. `request_summary` (суть обращения словами клиента) и `resolution` (что сказали клиенту) | память faq-server | да |
| `startCall` / `endCall` | Начало/конец звонка; `endCall` пишет `calls.txt` и шлёт Telegram | — | нет: диалплан Asterisk зовёт их изнутри (`curl http://faq-server:3000/tool/…`, `endCall` — из hangup-handler); **закрыты в nginx** |
| `getCalls` | Весь журнал звонков | `calls.txt` | нет; **закрыт в nginx** (ПД) |
| `checkRecentCall` | Был ли недавний звонок с номера | `calls.txt` | нет; **закрыт в nginx** |

- Журнал: `faq-server/data/calls.txt` (персональные данные, только на хосте).
- FAQ: `faq-server/data/faq.json`, 14 записей (добавлены `service_not_working` — «не открывается
  YouTube/сайт/приложение», `wifi_not_working`, `intermittent_internet`, `working_hours`). **Правки применяются к поиску только после
  рестарта faq-server** (P-03), счётчик в `/health` обновляется сразу.
- `findByOSMP`, `getNetworkData`, `diagnoseClient` сами дописывают результат в «последний открытый
  звонок» (P-02). Ошибки WHMCS и network-diag тоже пишутся — они попадают в блок SYSTEM ERRORS.
- Фраза клиента берётся из трёх источников по приоритету: `request_summary` от агента → запросы
  `searchFAQ` (с фильтром подтверждений и цифр) → стенограмма звонка из API Ultravox.

---

## 5. Интеграции

### 5.1. WHMCS (192.0.2.30)
- Наша сторона: `faq-server/tools/whmcs.js`, запрос
  `GET ${WHMCS_CUSTOM_API}?api_key=…&action=find_by_osmp&osmp_id=NNNNN`, таймаут 15 с.
- Сторона биллинга: `<billing-webroot>/api_client.php` (вне git, нужен доступ к БД WHMCS).
  - `$allowed_ips` — IP сервера проекта: сейчас `192.0.2.10` (старые `192.0.2.12`,
    `192.0.2.11` можно убрать);
  - `$api_key` == `WHMCS_API_KEY` в `.env`;
  - OSMP = custom field клиента (id поля и групп клиентов — из настроек своего WHMCS);
    OSMP — ровно 5 цифр;
  - `mysql_query("SET NAMES utf8")` обязателен, иначе диакритика приходит как `?`;
  - отдаёт также `address` (address1 + address2 + city), `client_id` (для ссылки в Telegram) и `debt`.
- Ответ: `{"error":false,"data":{"found":true,"client_name","osmp_id","client_type","client_ip","is_active","is_paid"}}`.
  `Access denied` = IP не в списке; `OSMP ID trebuie să conțină exact 5 cifre` = доступ есть.

### 5.2. NetBox (192.0.2.40, HTTP 80)
`getNetworkData` — 2 шага к NetBox (второй — 2 запроса параллельно), лимит `NETBOX_TIMEOUT_MS` = 5 с на запрос,
обычно ~0,4 с, худший случай ~10 с (< 15 с в Ultravox); если второй шаг не ответил — MAC/порт отдаются
с `can_diagnose: false`. Ищет IP клиента в `/api/ipam/ip-addresses/`: MAC — custom field `MAC`,
свитч/порт — `assigned_object`, адрес свитча — `primary_ip4` устройства.
**`primary_ip4` заполнен лишь у части устройств**, поэтому при пустом `primary_ip4` faq-server сам
ищет адрес устройства в сети управления (`SWITCH_MGMT_NETS`, по умолчанию 198.51.100.0/24) и
возвращает `can_diagnose: true/false`. Если адреса нет — диагностика не запускается.
`diagnoseClient` дополнительно проверяет `switch_ip` до вызова SSH: `null`, имя свитча или IP
клиента отбиваются с кодом `SWITCH_IP_UNKNOWN`.
`can_diagnose: false` также для оборудования, которое network-diag не умеет опрашивать: поддержаны
только производители Cisco и ZTE и модели Nexus (`N3K-…`, в NetBox записаны как «Generic»);
MikroTik, D-Link, Juniper и прочие — сразу callback. Если NetBox не вернул устройство — не блокируем.
Доступ ограничен ufw на хосте NetBox (подсеть 192.0.2.0/24 разрешена).

### 5.3. network-diag (SSH к оборудованию)
Flask: `/diagnose` (порт + MAC), `/check-mac`, `/check-port`, `/test-ssh`, `/health`.
- Учётка: `NETWORK_USER=api` (RADIUS), `NETWORK_PASS`, `NETWORK_ENABLE`.
- Сеть управления свитчей: **198.51.100.0/24**. vty ACL на свитчах разрешают подсеть 192.0.2.0/24.
- **v2:** одна SSH-сессия на диагностику, чтение до приглашения CLI вместо пауз, поиск конкретного
  MAC (`show mac address-table address <mac>`) с откатом на полную таблицу и старый синтаксис.
  Ожидаемо 4–8 с вместо ~25 с.
- Белый список сетей (`SWITCH_MGMT_NETS`) проверяется и здесь: SSH только к адресам свитчей.
- `NETWORK_ENABLE` используется, если приглашение `>`. Парсер MAC понимает IOS, старый IOS 2950,
  NX-OS и ZTE; сравнивает найденный порт с портом из NetBox (`port_match`). ZTE C320 на живом
  оборудовании не проверен.
- Проверка доступности всех свитчей: `scripts/diag_probe.py` + `scripts/diag_report.py` (§8.6).

### 5.4. Telegram
Бот `@example_avr_bot`: сводка по каждому звонку (`endCall`), отдельный алерт при
`needs_callback`, утреннее уведомление 08:00 (режим в панели).

Формат сводки (сверху вниз): номер звонка и время → телефон → CALLBACK (если нужен) →
**CLIENT SAID** (слова клиента) → **PROBLEM** (список проблем клиента) → **TOLD CLIENT**
(`resolution`) → **SYSTEM ERRORS** (сбои нашей стороны, только при наличии) → карточка клиента
(имя со ссылкой на биллинг, OSMP, статус, адрес, IP со ссылкой на NetBox, MAC, свитч/IP/порт) →
строка диагностики. Долг показывается как справка и в список проблем не входит.

### 5.5. Ultravox
Два агента: `SupportBotRO` `<RO_AGENT_ID>` (`ULTRAVOX_AGENT_ID`) и
`SupportBotRU` `<RU_AGENT_ID>` (`ULTRAVOX_AGENT_ID_RU`); тулзы общие. Промпты и
тулзы живут в дашборде — эталон настройки в `ULTRAVOX.md`, тексты промптов в `ultravox/prompts/ro.md` /
`ultravox/prompts/ru.md`, экспорт текущей конфигурации `scripts/ultravox_export.py`, правка через API —
`scripts/ultravox_tool_params.py`, `ultravox_prompt.py`, `ultravox_agent_clone.py` (`ULTRAVOX.md` §6).

**Inactivity Messages** (вкладка агента): первое сообщение — не меньше 45 с и **без Hang Up**,
иначе Ultravox кладёт трубку, пока агент ждёт ответа тулзов; второе (120 с, Interruptible Hang Up)
закрывает брошенные звонки.

### 5.6. Публичный вход (nginx + Let's Encrypt)
- Домен `avr.example.com` → A `203.0.113.10` (Technitium DNS 203.0.113.53 / .54).
- MikroTik: dst-nat `203.0.113.10:8443` → `192.0.2.10:8443` + filter (лимит соединений).
- nginx: TLS 1.2/1.3; пропускает **только** `POST /tool/(searchFAQ|findByOSMP|getNetworkData|diagnoseClient|updateCall)` (только то, что зовёт Ultravox)
  с правильным `X-AVR-Key` (иначе 403); всё остальное — закрыть соединение (444); 10 запр/с с IP.
- Сертификат: DNS-01 по RFC 2136 (TSIG-ключ `certbot-avr`, HMAC-SHA256) на Technitium;
  продление автоматическое, после продления nginx перезагружается хуком.
- Установка/переустановка: `deploy/nginx/install_nginx.sh avr.example.com rfc2136 8443`.

---

## 6. Admin-panel

Node.js + Express, 80 → 8090, basic-auth `PANEL_USER` / `PANEL_PASS` (пустой → FATAL).
Мониторинг контейнеров и интеграций, рестарт/пересборка, редактор FAQ, `.env` («Сохранить» +
«Применить» — пересоздаёт faq-server и network-diag), редактор конфигов Asterisk.
Подключается вторым compose-файлом: `-f docker-compose-admin-panel.yml`.
Монтирует `docker.sock` и видит все ключи → доступ к панели = доступ к хосту; работает по HTTP
внутри периметра, наружу не публиковать. Вход — basic-auth с блокировкой подбора (10 неверных за 15 мин → 15 мин),
все изменяющие действия — в `instance/audit.log` (вкладка «Мониторинг» → «Журнал действий»).

Проверка **«Публичный вход (nginx)»** шлёт реальный `POST /tool/searchFAQ` с ключом на
`TOOLS_PUBLIC_URL` (через внутренний адрес, с правильным SNI) и предупреждает, если сертификату
осталось меньше 20 дней. Нужны `TOOLS_PUBLIC_URL` и `TOOLS_API_KEY` в `.env`.

---

## 7. Asterisk (`asterisk/conf/`)

Монтируются в контейнер как `/etc/asterisk/my_*.conf`.

| Файл | Назначение |
|---|---|
| `extensions.conf` | Диалплан: вход `5001` → меню языка (`[avr-lang]`) → агент; `startCall` (с `lang`) / `endCall` |
| `pjsip.conf` | Транспорты, `external_*=192.0.2.10`, `local_net` (172.28.0.0/24, 172.17.0.0/16, 192.0.2.0/24), тестовый абонент 1000, транк `PBX_TRUNK` |
| `manager.conf`, `ari.conf`, `queues.conf`, `rtp.conf`, `musiconhold.conf` | AMI, ARI, очереди, RTP 10000-10050, MOH |

**Номера в контексте `demo`** (туда приходит транк и абонент 1000):

| Номер | Что |
|---|---|
| `5001` | меню языка: запись `custom/lang-menu`, **1** → RO (`avr-core`), **2** → RU (`avr-core-ru`); нет нажатия за 5 с или другая цифра → RO |
| `5003` | сразу RU, без меню (тест) |
| `5004` | сразу RO, без меню (тест) |
| `5002` | апстримовый пример (`host.docker.internal`) |

Запись меню — `asterisk/sounds/lang-menu.wav` (WAV 8 кГц, моно, 16 бит), папка смонтирована в
`/var/lib/asterisk/sounds/custom` (см. `asterisk/sounds/README.md`). **Пока файла
нет, меню пропускается** и звонок сразу идёт к RO. Замена файла подхватывается без перезапуска.
Выбранный язык уходит в `startCall` (`lang`) — в `calls.txt` и отчёт Telegram (🇷🇴 / 🇷🇺).

**Транк `PBX_TRUNK`** опознаётся по IP источника, без регистрации:
`match=192.0.2.21` и `match=192.0.2.20` (АТС шлёт звонки с того своего интерфейса, который в
одной подсети с нашим сервером). Статус endpoint `Unavailable` для такого транка нормален.
На АТС (Asterisk 11, chan_sip): `host=192.0.2.10`, `directmedia=no`, `nat=force_rport,comedia`.

**Правка конфигов:** через панель или `nano` + `pjsip reload` / `dialplan reload`.
После `sed -i` (создаёт новый файл) контейнер продолжает видеть старый → нужен
`docker restart avr-asterisk`.

---

## 8. Эксплуатация

Все команды — из `~/avr-infra`.
`DC="docker compose -f docker-compose-ultravox.yml -f docker-compose-admin-panel.yml"`

### 8.1. Запуск, рестарт, обновление
```bash
$DC up -d                                  # весь стек
$DC ps
$DC logs -f faq-server
$DC up -d --build faq-server               # после правки кода faq-server
$DC up -d --build network-diag             # после правки кода network-diag
$DC up -d faq-server network-diag          # после правки .env (или «Применить» в панели)
$DC restart faq-server                     # после правки faq.json (пока не исправлен P-03)
docker exec avr-asterisk asterisk -rx "pjsip reload"
docker exec avr-asterisk asterisk -rx "dialplan reload"
sudo systemctl reload nginx                # после правки конфига nginx
```
Не делать `--build`/`pull` для апстримовых сервисов. Не запускать `--remove-orphans`
(удалит панель). Не делать `set -a; . ./.env` в рабочей сессии — используйте подоболочку `( … )`.

### 8.2. Полная проверка
```bash
cd ~/avr-infra ; K=$(sudo cat /etc/nginx/avr_tool_key)
for c in $(docker ps -aq); do docker inspect -f '{{.Name}} {{.State.Status}} restart={{.HostConfig.RestartPolicy.Name}}' $c; done
curl -s localhost:3000/health ; echo ; curl -s localhost:5000/health ; echo
systemctl is-active nginx ; sudo openssl x509 -enddate -noout -in /etc/letsencrypt/live/avr.example.com/fullchain.pem
curl -s -o /dev/null -w 'nginx+ключ:%{http_code}\n' --resolve avr.example.com:8443:192.0.2.10 \
  -X POST https://avr.example.com:8443/tool/searchFAQ -H 'Content-Type: application/json' \
  -H "X-AVR-Key: $K" -d '{"query":"internet nu merge","lang":"ro"}' ; unset K
docker exec avr-asterisk asterisk -rx "pjsip show identifies" | grep Match
curl -s -m45 -X POST localhost:5000/test-ssh -H 'Content-Type: application/json' -d '{"host":"198.51.100.20"}'
```
Снаружи (телефон через мобильный интернет): `https://avr.example.com:8443/tool/searchFAQ` →
замок без предупреждения, `403 Forbidden` (GET без ключа — так и должно быть).

Тестовый звонок без АТС: софтфон `1000/1000` (TCP 5060): `600` — эхо, `5001` — агент.

### 8.3. Типовые сбои

| Симптом | Причина | Где смотреть |
|---|---|---|
| Звонок не доходит, в tcpdump на 5060 `INVITE` → `401 Unauthorized` | INVITE пришёл с IP, которого нет в `match=` транка | `tcpdump -nni ens18 port 5060`, `pjsip show identifies` |
| В tcpdump на 5060 при звонке пусто | АТС шлёт на другой адрес / фаервол | `sip show peers` на АТС |
| Агент говорит, но «ничего не находит» | Тулзы получают 403/таймаут | `sudo tail /var/log/nginx/avr-tools.access.log` |
| В access-логе `403` от Ultravox | Нет/неверный статический заголовок `X-AVR-Key` | `ULTRAVOX.md` §2 |
| Снаружи порт 8443 висит | ufw, проброс MikroTik, nginx | `tcpdump port 8443`, `ufw status`, `ss -ltnp` |
| `findByOSMP` — `Access denied` | IP сервера не в `$allowed_ips` | PHP-коннектор |
| Диагностика `timeout` / `refused` | Свитч недоступен / vty ACL | `scripts/diag_report.py` |
| Диагностика `Authentication failed` | Учётка `api` в RADIUS | `/test-ssh` |
| Правка `pjsip.conf` не применяется | Файл заменён `sed -i` | `docker restart avr-asterisk` |
| Агент молчит, `ECONNRESET` в `avr-core` через ~30 с | RTP в одну сторону | `directmedia=no`, `comedia` на АТС |

### 8.4. Смена ключа `X-AVR-Key`
```bash
sudo sh -c 'openssl rand -hex 32 > /etc/nginx/avr_tool_key && chmod 600 /etc/nginx/avr_tool_key' \
&& K=$(sudo cat /etc/nginx/avr_tool_key) \
&& printf 'map $http_x_avr_key $avr_key_ok {\n    default 0;\n    "%s" 1;\n}\n' "$K" | sudo tee /etc/nginx/avr_tool_key.conf >/dev/null \
&& sudo chmod 600 /etc/nginx/avr_tool_key.conf && sudo nginx -t && sudo systemctl reload nginx ; unset K
```
Сразу после — обновить значение статического параметра `X-AVR-Key` во **всех** тулзах Ultravox
(до этого тулзы получают 403).

### 8.5. Скрипты (`scripts/`)

| Скрипт | Что делает |
|---|---|
| `diag_probe.py` | берёт устройства из NetBox, проверяет порт 22 и вход (стоп после 2 отказов подряд) |
| `diag_report.py` | группирует недоступные устройства по причинам, пишет `~/avr-infra_diag_failed_<дата>.txt` |
| `faq_add_entries.py` | добавляет недостающие сценарии в `faq.json` (`--check` / `--apply`) |
| `ultravox_export.py` | выгружает настройку агента и тулзов в Markdown без секретов |
| `ultravox_tool_params.py` | проверяет и добавляет параметры тулза, меняет таймаут через API (сам отвязывает тулз от агента при конфликте) |
| `ultravox_prompt.py` | ищет и заменяет фразу в промпте агента через API (`--agent ru` — русский); перед заменой — копия агента, есть `--restore` |
| `ultravox_agent_clone.py` | создаёт нового агента копией RO с другим промптом, голосом, языком и фразами (так создан RU) |
| `mktar.sh` (в корне) | чистый архив проекта для анализа по списку `.tarignore` + проверка на секреты |

### 8.6. Доступность свитчей
```bash
python3 scripts/diag_probe.py --ssh-limit 50 > /dev/null && python3 scripts/diag_report.py
```
Стоп после 2 отказов подряд нужен, чтобы не заблокировать учётку `api`.

---

## 9. Что живёт вне сервера / вне репозитория

1. Промпт, тулзы и настройки агента — дашборд Ultravox (эталон: `ULTRAVOX.md`).
2. `.env` — все секреты (только на хосте).
3. `faq-server/data/calls.txt` — журнал звонков, ПД.
4. PHP-коннектор WHMCS — `<billing-webroot>/api_client.php` на биллинге.
5. Транк на АТС Elastix/FreePBX (веб + MySQL).
6. A-запись `avr.example.com`, TSIG-ключ и политика обновлений — Technitium DNS.
7. dst-nat и filter для 8443 — MikroTik.
8. Правила ufw на хосте NetBox; vty ACL и учётка `api` (RADIUS) на свитчах.
9. На хосте, но не в каталоге проекта: nginx, ключ `X-AVR-Key`, сертификат, `/root/.secrets/rfc2136.ini`,
   deploy key GitHub `~/.ssh/avr-infra_deploy` + алиас `github-avr` в `~/.ssh/config`.
10. Переменные `.env`, добавленные к апстримовым: `TOOLS_PUBLIC_URL`, `TOOLS_API_KEY`,
   `SWITCH_MGMT_NETS`, `WHMCS_ADMIN_URL`, `NETBOX_WEB_URL` (необязательна).

---

## 10. Текущее состояние и открытые задачи

**Работает:** приём звонков, агент, публичный вход через nginx + HTTPS, FAQ, поиск в WHMCS, MAC из
NetBox, SSH-диагностика на доступных Cisco, журнал звонков, Telegram, панель, автозапуск всех
сервисов, автопродление сертификата.

**Проблемы кода** (номера P-xx — из разбора кода тулзов, сентябрь 2026):

| # | Проблема | Статус |
|---|---|---|
| P-09 | `switch_ip: null` → LLM подставляла IP клиента | ✅ исправлено: поиск mgmt-адреса в NetBox + проверка `switch_ip` в faq-server и network-diag |
| P-13 | Диагностика ~25 с | ✅ исправлено в network-diag v2 (одна сессия), проверить время на живых свитчах |
| P-14 / P-07 | Ошибки диагностики и WHMCS не попадали в журнал | ✅ исправлено, видны в SYSTEM ERRORS |
| P-15 | `NETWORK_ENABLE` не использовался | ✅ исправлено |
| P-17 | Парсер MAC только для одного формата IOS | ✅ добавлены IOS 12.x, NX-OS, ZTE |
| P-22 / P-23 | Причина колбэка и экранирование HTML в Telegram | ✅ исправлено |
| P-02 | Автосохранение в «последний открытый звонок» смешивает параллельные звонки | ✅ 2026-09-30: тулзы шлют `uv_call_id`, проверено на живом звонке (звонок Ultravox → call 111) |
| P-25 | network-diag: Catalyst 4500/4948 — колонка `protocols` (ip,ipx,assigned,other) принималась за порт → «MAC на другом порту», агент говорил клиенту, что роутер подключён неправильно; у NX-OS портом считался «0» | ✅ 2026-09-30: порт — последний интерфейс строки; проверено на 3 живых свитчах (2×4948, 3750) |
| P-03 | Правки FAQ не доходили до поиска до рестарта faq-server | ✅ 2026-10-01: `tools/faq.js` перечитывает `faq.json`, если изменилось время файла (проверка перед каждым поиском; битый файл не применяется); `/health` берёт счётчик оттуда же. Проверено: запись из панели находится сразу и исчезает сразу |
| **P-21** | Звонки без `endCall` теряются; рестарт faq-server теряет открытые звонки | 🟠 открыто |
| P-16 | Нет telnet / SSH v1 (часть старых Dell / D-Link / Cisco) | 🟡 открыто |
| P-19 | ZTE C320: команды и парсер не проверены на живом OLT; 25.09 — вход по SSH отклонён (Authentication failed) | 🟡 открыто |
| P-24 | Время в отчётах Telegram и `calls.txt` было в UTC (на 2–3 ч меньше) | ✅ 2026-10-07: `formatDate` форматирует в `TIMEZONE` (новая настройка `.env`, по умолч. UTC; летнее/зимнее время учитывается) |
| P-26 | Без `request_summary` в Telegram шли сырые фразы распознавания («бред») | ✅ 2026-09-30: порядок — `request_summary` агента → сводка Ultravox (`shortSummary`, ждём до 20 с после звонка) → стенограмма с пометкой «may be inaccurate» |

**Позже, если понадобится (решено 2026-09-30):** перевод звонка на живого администратора (вариант «Б»): агент говорит «соединяю», клиент ждёт на линии с музыкой, у администратора звонит телефон; никто не ответил за N секунд → обратный звонок (как сейчас). Нужно: номера/внутренние линии администраторов и часы работы, очередь в Asterisk (`queues.conf`), тулз перевода в Ultravox (`coldTransfer`/`warmTransfer` в аккаунте есть). Сейчас — вариант «А»: агент честно говорит, что он ИИ и что обращение ушло администраторам уведомлением (⚠ CALLBACK в Telegram).

**Решено делать дальше:** один составной тулз (`checkConnection`: WHMCS → NetBox → SSH → вердикт
на сервере, LLM видит только итог); ID звонка вместо `latest`; горячая перезагрузка FAQ; проверка
`X-AVR-Key` внутри faq-server (timing-safe, сейчас только в nginx); отдельный лимит на
`findByOSMP`; при долгой проверке — фоновое выполнение с отправкой результата в Telegram.

**Следующая крупная задача — админка: полная настройка проекта** (решено 2026-09-30).
Цель: проект клонируется на сервер, запускается, а дальше всё настраивается через панель — без ручных
скриптов и правки файлов. Везде учитываются **два языка** (RO и RU): это два отдельных агента,
смешивать языки не нужно — у каждого свой промпт, голос, фразы и свой набор настроек в панели.

| Этап | Что делаем | Статус |
|---|---|---|
| A-1 | Опись: все настройки проекта и где они сейчас лежат (`.env`, код, Asterisk, Ultravox, nginx, Telegram, NetBox, WHMCS) | ✅ 2026-09-30 (ниже) |
| A-2 | Всё в `.env`: недостающие настройки (сейчас зашитые в код/конфиги) вынести в `.env`, обновить `.env.example` | 🟠 `.env.example` переписан под наш стек, рабочий `.env` приведён к нему (43 неиспользуемые записи апстрима убраны, копия — `~/avr-infra-old-backups-2026-09-25/.env.2026-09-30-before-cleanup`) (2026-09-30); таймауты, адрес API Ultravox, расписание и пояс проверки панели вынесены в `.env` (`*_TIMEOUT_MS`, `ULTRAVOX_API_URL`, `CRON_TZ`, `HEALTH_REPORT_CRON`), запасные адреса ExampleNet из панели убраны; `SSH_*`, `NETBOX_TIMEOUT_MS`, `TRANSCRIPT_MAX_UTTERANCES` теперь реально передаются в сервисы (раньше compose их не пробрасывал). Осталось в A-2b: шаблоны ссылок, номер клиента |
| A-2b | Переходники биллинга и сети (см. ниже): единый формат, выбор платформы в `.env`/панели, шаблоны ссылок | ✅ 2026-09-30: `faq-server/tools/providers.js`, выключатели `BILLING_PROVIDER` / `NETWORK_SOURCE`, шаблоны `BILLING_CLIENT_URL` / `NETWORK_IP_URL` / `NETWORK_DEVICE_URL`, номер клиента `CLIENT_ID_LABEL` / `CLIENT_ID_PATTERN`; в панели выключенное — серым. Промпты RO/RU (OSMP) — в A-4 |
| A-3 | Весь `.env` в панели: группы, описания, скрытие секретов, проверка значений | ✅ 2026-09-30: вкладка строится по `.env.example` (`admin-panel/envSchema.js`: группы, описания, «по умолч.», выбор `a \| b`, «(секрет)»), проверка значений на сервере, ошибки у поля; `NETWORK_ENABLE` больше не виден открытым; запись с кавычками, безопасными для `$` |
| A-4 | Ultravox в панели через API (правка, не только просмотр). Правки из панели — у каждой установки свои: живая конфигурация в Ultravox, копии — `instance/` (вне git); в git — только шаблоны. Шаги: **4.1** вкладка «Ultravox»: агенты RO/RU — промпт, голос (по языку, прослушивание), язык, приветствие, сообщения при молчании, длительность, модель, VAD, имя; проверка изменений, копия перед записью, откат ✅ 2026-09-30 (`admin-panel/ultravox.js`, история `instance/ultravox/history/<lang>/`, последние 50) · **4.2** тулзы ✅ 2026-09-30: шаблоны `ultravox/tools.json`, правки установки `instance/ultravox/tools.json`, сверка (адрес из `TOOLS_PUBLIC_URL`, ключ `TOOLS_API_KEY`, таймаут, описание, параметры, `uv_call_id`), синхронизация с копией (`instance/ultravox/history/tools/`) и возвратом при ошибке, подключение/отключение по `BILLING_PROVIDER`/`NETWORK_SOURCE`; в живой Ultravox залиты рекомендованные описания (старые «Takes 10-15 seconds» и т.п. ушли) · **4.3** промпты ✅ 2026-09-30 (решено без блоков-условий: каждая установка правит свой промпт в панели): образцы перенесены в `ultravox/prompts/{ro,ru}.md`; панель проверяет, что промпт соответствует включённым функциям (упоминает `findByOSMP` и номер `CLIENT_ID_LABEL` при биллинге, `getNetworkData`/`diagnoseClient` при учёте сети, и не упоминает выключенные) — во вкладке и перед отправкой · **4.4** «Применить» ✅ 2026-09-30 (`admin-panel/applyPlan.js`): панель сравнивает значения из `.env` с тем, с чем реально запущен каждый контейнер (`docker inspect`), показывает план и пересоздаёт только устаревшие сервисы (предупреждает, если это оборвёт звонки), синхронизирует тулзы Ultravox и предупреждает о расхождении промптов. Исправлено попутно: compose внутри панели брал значения из окружения панели, а не из `.env` (смена пароля панели не применялась), и панель не могла пересоздать себя (оставалась недосозданной) — теперь это делает вспомогательный контейнер. `COMPOSE_APPLY_SERVICES` больше не нужен | ✅ |
| A-5 | Инструменты для первого запуска (реально на новом сервере не запускаем): **вкладка «Справка»** ✅ 2026-09-30 — как устроен проект, где что взять и куда вписать, вкладки панели, «если горит красное» (текст — `admin-panel/guide.md`, правится без пересборки) + чек-лист первого запуска с живыми отметками (`admin-panel/guide.js`); **создание агента из образца** ✅ 2026-09-30 — кнопка на вкладке Ultravox, если `ULTRAVOX_AGENT_ID`/`_RU` пусты: агент в аккаунте ключа (промпт `ultravox/prompts/<lang>.md` с `{COMPANY_NAME}`, модель ultravox-v0.7, голос языка из включённых в оплату, приветствие с раскрытием ИИ, фразы при молчании), ID сразу в `.env`; проверено созданием и удалением тестовых агентов RO/RU. Ловушка: голоса `VOICE_BILLING_STYLE_EXTERNAL` требуют свой ключ провайдера — в списке помечены | ✅ |
| A-6 | Хост (root) — `install.sh` в корне ✅ 2026-09-30: проверки (Ubuntu, место), Docker из официального репозитория + группа docker, `.env` из образца (600, `PROJECT_DIR`, `PANEL_*`, случайный пароль панели), конфиги Asterisk из образцов со случайными паролями (AMI = `AMI_PASSWORD` в `.env`), `instance/` и `…-backups`, ufw (22 первым, SIP, RTP, панель, тулзы), запуск стека, опционально nginx + сертификат (`--domain --dns-mode`, вызывает `deploy/nginx/install_nginx.sh`, пишет `TOOLS_*` в `.env`). Повторный запуск безопасен, `--dry-run` ничего не меняет. Проверено: `--dry-run` на рабочем сервере, чистая установка и повтор в одноразовом контейнере Ubuntu 22.04. Расписание — в панели (node-cron), crontab не нужен | ✅ |
| A-7 | Безопасность панели ✅ 2026-10-01 (`admin-panel/security.js`): вход с защитой от подбора (10 неверных паролей с адреса за 15 мин → блокировка 15 мин; сравнение без утечки по времени), журнал действий `instance/audit.log` (кто, IP, что; без значений; вкладка «Мониторинг»), проверка «Безопасность панели» (слабый пароль — красное, напоминание не пробрасывать порт, неудачные входы за сутки); проверено: ни один из 9 секретов `.env` не выдаётся ни одной из 20 страниц API (кроме редактора конфигов Asterisk — по замыслу). Копии `.env` перед записью — `~/avr-infra-backups/` | ✅ |

**A-2b. Переходники биллинга и сети.** Биллинг (WHMCS) и учёт сети (NetBox) есть не у всех, поэтому
наша часть работает с единым форматом, а обращение к платформе — сменный модуль-переходник:
- **Клиент:** номер договора, имя, тип, IP, адрес, активен/оплачен, долг, ссылка в биллинг.
- **Сеть клиента:** MAC, свитч, IP свитча, порт, точка присутствия (`pop`), `can_diagnose`.
- Выбор в `.env` и панели: `BILLING_PROVIDER=whmcs|none`, `NETWORK_SOURCE=netbox|none` — **необязательные
  функции**. Выключено = агенту не подключают соответствующие тулзы (`findByOSMP`; `getNetworkData` +
  `diagnoseClient`) и берут промпт без этих шагов — это делает панель в A-4. Если тулз всё же вызван,
  faq-server отвечает `code: DISABLED` («не повторять, предложить callback»). Диагностика выключается вместе с учётом сети.
- Контракт переходника и порядок добавления новой платформы — в шапке `faq-server/tools/providers.js`.
  Сейчас: `whmcs.js`, `netbox.js` (+ серверный скрипт платформы, у WHMCS — `api_client.php`).
- **Ссылки** в Telegram/журнале — шаблоны в `.env`, настраиваются в панели; по умолчанию — от переходника.
  Сейчас в `callLogger.js` база из `.env`, а путь зашит: `{WHMCS_ADMIN_URL}/clientssummary.php?userid={client_id}`,
  `{NETBOX}/ipam/ip-addresses/{ip_id}/`, `{NETBOX}/dcim/devices/{device_id}/`.
- Тоже специфика ExampleNet, вынести в настройки: номер клиента «OSMP, 5 цифр» (код `whmcs.js` и промпты RO/RU),
  диагностика только Cisco (network-diag).

**A-1. Опись настроек (2026-09-30).**
- `.env`: 68 записей, ~половина — наследство апстрима, нашим стеком не используется (OpenAI, Gemini, Anthropic,
  ElevenLabs, Deepgram, OpenRouter, Kokoro, Rime, `DATABASE_*`, `AGENT_PROMPT`, `ADMIN_*` …); дубли `AMI_PORT`, `GEMINI_API_KEY`.
- `.env.example` устарел: нет ни одной нашей настройки (`TELEGRAM_*`, `WHMCS_*`, `NETBOX_*`, `NETWORK_*`, `PANEL_*`,
  `TOOLS_*`, `SWITCH_MGMT_NETS`, `ULTRAVOX_AGENT_ID_RU`).
- Код читает, но в `.env` нет (работают значения по умолчанию): `NETBOX_WEB_URL`, `NETBOX_TIMEOUT_MS`,
  `SSH_CONNECT_TIMEOUT`, `SSH_CMD_TIMEOUT`, `SSH_TOTAL_TIMEOUT`, `TRANSCRIPT_MAX_UTTERANCES`, `CRON_TZ`,
  `PANEL_ULTRAVOX_URL`, `NETWORK_DIAG_URL`, `FAQ_SERVER_URL`, `COMPOSE_FILES`, `COMPOSE_APPLY_SERVICES`, `TOOLS_CHECK_ADDR`.
- Зашито в код: таймауты WHMCS 15 с, Telegram 10 с, network-diag 12 с, Ultravox 8 с; адрес API Ultravox;
  запасные `avr.example.com:8443` и `192.0.2.10` в `admin-panel/healthChecks.js`; языки `ro`/`ru`; OSMP 5 цифр;
  пути ссылок WHMCS/NetBox (см. A-2b).
- Asterisk: IP сервера в `pjsip.conf` (`external_*`), транк `PBX_TRUNK` и адреса АТС (`match=`), номера `5001/5003/5004`
  в `extensions.conf` — генерировать из `.env`.
- Ultravox: в `.env` только ключ и ID агентов; промпты — `ultravox/prompts/{ro,ru}.md`; голос, модель, фразы, тулзы
  и их адреса — только в Ultravox (меняются `scripts/ultravox_*.py`).
- Хост (root): nginx по шаблону `deploy/nginx/` (домен, порт); сертификат только под DNS-01 на нашем Technitium;
  ufw не описан; crontab нет, продление — `certbot.timer`.

**Требует рассмотрения — покрытие диагностики.** Диагностика возможна только для клиентов, у которых
в NetBox IP привязан к порту свитча с адресом управления в `SWITCH_MGMT_NETS` и поддерживаемой
платформой (Cisco IOS / NX-OS). Что мешает: незаполненные привязки IP → порт в NetBox; свитчи без
адреса управления; неподдерживаемое оборудование (MikroTik, D-Link) — сразу callback
(`can_diagnose: false`); GPON OLT — только поиск MAC, статус ONU и оптические уровни не реализованы.

**Прочие хвосты:** сменить дефолтные и слабые пароли (enable на свитчах `NETWORK_ENABLE`, ключ WHMCS —
одновременно в `api_client.php` и `.env`, пароль транка `PBX_TRUNK`, апстримовые `1000/1000`,
AMI/ARI `avr/avr`); убрать старые IP из `$allowed_ips`; заполнить `primary_ip4` в NetBox (сейчас
обходится поиском mgmt-адреса); для ZTE OLT нужны отдельные учётные данные или `can_diagnose: false`;
ссылки `next` в API NetBox ведут на старый адрес `192.0.2.41` (поправить базовый URL в настройках
NetBox; нам не мешает).

---

## 11. Журнал изменений

### 2026-09-25 — Сверка документации с сервером
- Запущен `certbot.timer` (был `enabled`, но не активен — автопродление не работало); ловушка 23 в `MIGRATION.md`.
- nginx: наружу только 5 тулзов Ultravox; `startCall`/`endCall`/`checkRecentCall` закрыты.
- `SWITCH_MGMT_NETS` теперь передаётся и в faq-server (раньше он всегда брал значение по умолчанию);
  оба сервиса принимают список через `,` или `;`.
- `getNetworkData`: 4 последовательных запроса к NetBox → 2 шага (лишний запрос устройства по имени убран,
  адрес управления ищется параллельно), лимит 10 → 5 с; 0,85 → 0,42 с, худший случай 40 → ~10 с.
  Если `primary_ip4` вне сетей управления — берётся найденный mgmt-адрес.
- `getNetworkData`: `can_diagnose: false` для неподдерживаемого оборудования (MikroTik, D-Link и т.п.) —
  агент сразу предлагает callback вместо заведомо неудачной диагностики. Подсчёт покрытия — §10.
- `tarignore` → `.tarignore` (иначе `mktar.sh` не находил файл); `mktar.sh` сделан исполняемым.
- `.tarignore` теперь исключает `.env.bak*`, `.env.backup*`, `*.bak-*` — раньше бэкапы `.env` с ключами
  попадали в архив. `mktar.sh` больше не печатает значения найденных секретов (только файл:строка).
- `diagnoseClient`: замер на живых свитчах — Cisco (2950/2960/3750/4948/Nexus) 0,8–1,9 с,
  медиана 1,6 с; ZTE C320 — отказ авторизации SSH. network-diag: общий лимит `SSH_TOTAL_TIMEOUT` 10 с
  на всю диагностику (раньше худший случай ~55 с); faq-server ждёт network-diag 30 → 12 с;
  Ultravox: таймаут тулза 30 → 15 с, в промпте «până la treizeci de secunde» → «câteva secunde».
- Новый `scripts/ultravox_prompt.py` (правка промпта через API с копией и `--restore`);
  `ultravox_tool_params.py` умеет `--timeout`.

### 2026-09-25 — Уборка
- Удалены пустые файлы `node`, `faq-tools-server@1.0.0` и исторический `scripts/remove_ngrok.sh`;
  из compose панели убраны неиспользуемые `NGROK_API_URL`, `TUNNEL_PUBLIC_URL`, `extra_hosts`.
- 37 файлов и папок `*.bak*` (копии кода, compose, `pjsip.conf`, `.env`) перенесены из проекта в
  `~/avr-infra-old-backups-2026-09-25/` (700) с сохранением путей. `asterisk/conf/.backups/`
  (копии, которые делает панель) оставлены.

### 2026-09-25 — Два агента: румынский и русский
- В Ultravox создан `SupportBotRU` (копия RO: модель, тулзы, VAD; свой промпт `ultravox/prompts/ru.md`,
  голос Larisa, `languageHint: ru`, русские приветствие и сообщения при молчании). Из RO-промпта убраны
  русские фразы — агенты не переключают язык.
- Вторая пара контейнеров `avr-core-ru` + `avr-sts-ultravox-ru` (`ULTRAVOX_AGENT_ID_RU` в `.env`).
- Asterisk: на `5001` меню языка (1 — RO, 2 — RU, по умолчанию RO), тестовые `5003` / `5004`;
  запись меню `asterisk/sounds/lang-menu.wav` кладётся отдельно, без неё меню пропускается.
- faq-server: язык звонка в карточке, `calls.txt` и Telegram; стенограмма ищется у агента нужного
  языка. Исправлено: `GET /calls?agentId=` Ultravox игнорирует фильтр — теперь `/agents/{id}/calls`.
- Скрипты: `ultravox_agent_clone.py`; `ultravox_prompt.py --agent ru`; `ultravox_export.py`
  выгружает оба агента; `ultravox_tool_params.py` при конфликте отвязывает тулз от обоих агентов.
- Исправлены ссылки на разделы между документами, убран дубль в §8.5/§8.6.

### 2026-09 — Репозиторий, отчёт в Telegram, ускорение диагностики
- Проект добавлен в приватный GitHub (`<user>/<repo>`) с deploy key; `.env`, `calls.txt` и
  конфиги Asterisk с паролями в репозиторий не попадают (`*.example`).
- **network-diag v2:** одна SSH-сессия, чтение до приглашения CLI, поиск конкретного MAC,
  белый список сетей, enable, парсер для IOS 12.x / NX-OS / ZTE, сравнение портов.
- **faq-server:** поиск mgmt-адреса свитча в NetBox при пустом `primary_ip4` (`can_diagnose`),
  проверка `switch_ip` перед SSH, запись ошибок WHMCS и диагностики в карточку звонка.
- **Отчёт в Telegram переписан:** слова клиента, список проблем, «что сказали клиенту», отдельный
  блок ошибок системы, адрес, IP свитча, ссылки на биллинг и NetBox; долг вынесен из проблем.
- Источники фразы клиента: `request_summary` → `searchFAQ` → стенограмма Ultravox.
- Биллинг: `SET NAMES utf8` (диакритика), в ответ добавлены `address`, `client_id`, `debt`.
- FAQ: добавлены `service_not_working`, `wifi_not_working`, `intermittent_internet`, `working_hours`.
- Промпт агента переписан (`ultravox/prompts/ro.md`): обязательный `request_summary`, `resolution`,
  обработка `can_diagnose: false`, запрет выдумывать параметры диагностики, жалоба на неисправность
  ведёт в диагностику даже без совпадения в FAQ.
- Панель: проверка «туннель» заменена на «Публичный вход (nginx)» + контроль срока сертификата.

### 2026-09 — Публичный вход через nginx вместо стороннего туннеля
- nginx + Let's Encrypt на 192.0.2.10, внешний порт 8443 (MikroTik dst-nat), домен
  `avr.example.com`; сертификат по DNS-01 (RFC 2136, TSIG) на собственном Technitium.
- Тулзы защищены статическим заголовком `X-AVR-Key`; `getCalls` и служебные пути закрыты снаружи.
- ufw: открыт 8443/tcp. Старый туннель (ngrok) и его сервис удалены.
- Документация: добавлен `ULTRAVOX.md`, скрипт экспорта `scripts/ultravox_export.py`.

### 2026-09 — Смена IP сервера 192.0.2.11 → 192.0.2.10
- Сервер перенесён в 192.0.2.0/24 (эта подсеть разрешена в vty ACL свитчей).
- pjsip `external_*`, транк на АТС, `$allowed_ips` WHMCS обновлены; в транк добавлен
  `match=192.0.2.20` (новый адрес-источник АТС).

### 2026-09 — Диагностика свитчей
- Маршрут 192.0.2.x → 198.51.100.0/24 открыт на MikroTik; учётка `api` пересоздана в RADIUS,
  задан `NETWORK_ENABLE`; SSH + `/diagnose` работают на доступных Cisco.
- network-diag: `container_name: network-diag`, `restart: always`.
- Скрипты `scripts/diag_probe.py`, `scripts/diag_report.py`.

### 2026-09 — Переезд 192.0.2.12 → 192.0.2.11
- Стек перенесён `docker save/load`; служебные порты на 127.0.0.1; на АТС `directmedia=no`,
  `nat=force_rport,comedia`.

### 2026-09 — Реорганизация документации
- Документация сведена в `PROJECT.md` / `MIGRATION.md` (+ `ULTRAVOX.md`); удалены апстримовый
  `README.md`, `DEPLOYMENT.md`, `CHANGELOG.md`; `LICENSE.md` оставлен (условие MIT).

### Чистка кода и фиксы диагностики (до переезда)
- Удалены мёртвые файлы (`pyats.js`, бэкапы `*(old)`, дубли конфигов Asterisk, пустая `functions/`).
- `port_status` в `/diagnose` (up/down/null), эндпоинт `/check-port`; автосейв реального `port_status`.
- `requires_osmp: true` для `no_internet`, `slow_internet`; `searchFAQ` возвращает `requires_osmp`.
