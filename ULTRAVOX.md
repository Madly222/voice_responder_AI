# ULTRAVOX.md — настройка агента и тулзов в Ultravox

> Эталон конфигурации агента в дашборде Ultravox (app.ultravox.ai): какие тулзы, с какими
> описаниями, параметрами, адресами и таймаутами. По этому файлу агента можно настроить с нуля.
> Сверить с тем, что реально настроено: `python3 scripts/ultravox_export.py` (§7).
>
> **Тулзы теперь ведутся панелью** (вкладка «Ultravox (агенты)» → блок «Тулзы»): шаблоны — `ultravox/tools.json`
> (описания, параметры, таймауты; `{COMPANY_NAME}`, `{CLIENT_ID_LABEL}`, `{CLIENT_ID_FORMAT}` из `.env`), правки
> установки — `instance/ultravox/tools.json`. Панель сама ставит адрес (`TOOLS_PUBLIC_URL`), ключ (`TOOLS_API_KEY`),
> `uv_call_id` (ID звонка) и подключает к агентам только включённые функции. Таблицы §3 ниже — справочные.
> Ловушка API: тулз меняется только `PUT` (не `PATCH`), в определении обязателен `modelToolName`; при подключении
> к агенту Ultravox копирует в агента имя и описание тулза — после смены описания тулз надо переподключить
> (панель делает это сама).

---

## 1. Агенты

Два агента с одинаковой логикой, тулзами и настройками — различаются только языком, промптом,
голосом и фразами. Язык выбирает клиент в меню Asterisk (`PROJECT.md` §7); на другой язык
агенты не переходят.

| Поле | SupportBotRO | SupportBotRU |
|---|---|---|
| Agent ID | `<RO_AGENT_ID>` (`ULTRAVOX_AGENT_ID`) | `<RU_AGENT_ID>` (`ULTRAVOX_AGENT_ID_RU`) |
| Кто создаёт звонки | `avr-sts-ultravox` | `avr-sts-ultravox-ru` |
| Промпт | `ultravox/prompts/ro.md` | `ultravox/prompts/ru.md` |
| languageHint | `ro` | `ru` |
| Голос | Corina - Romanian (Eleven Labs) | Larisa (Eleven Labs), выбран временно |
| Приветствие (First speaker, uninterruptible) | «Bună ziua, vă salută asistentul virtual ExampleNet, un sistem de inteligență artificială. Cu ce vă pot ajuta?» | «Здравствуйте, вас приветствует виртуальный помощник ExampleNet — это система искусственного интеллекта. Чем могу помочь?» |
| Модель | `ultravox-v0.7` | то же |
| Max duration | 300 s | то же |
| Подключённые тулзы | `searchFAQ`, `findByOSMP`, `getNetworkData`, `diagnoseClient`, `updateCall` (+ встроенные, §4) | те же самые тулзы |

RU-агент создан копией RO скриптом `scripts/ultravox_agent_clone.py` (§6): модель, тулзы, VAD и
длительность скопированы как есть. Правки общих настроек (VAD, тулзы, модель) делать в **обоих** агентах.

### 1.1. Системный промпт

Живой промпт каждого агента хранится в Ultravox и правится в панели (вкладка «Ultravox (агенты)»,
история и откат — `instance/ultravox/history/`). Файлы **`ultravox/prompts/ro.md`** и **`ultravox/prompts/ru.md`**
в репозитории — **образцы** (для новой установки; дашборд Ultravox при вставке убирает разметку Markdown —
это нормально). Промпт должен соответствовать включённым функциям: если включён биллинг — описывать
`findByOSMP` (OSMP), если учёт сети — `getNetworkData` и `diagnoseClient`; панель предупреждает о расхождении.
Логику менять синхронно в обоих агентах: RU —
перевод RO один в один, без упоминаний румынского (кроме значений `client_type` из WHMCS —
`"Persoane Juridice"` / `"Persoane Fizice"`, их агент не произносит).

**Промпт 2.0 (2026-09-30):** ~65 строк вместо ~400 — принципы вместо дословных сценариев: агент думает сам (понимает кривое распознавание, уточняет конкретно, не обобщает «не открываются Одноклассники» до «нет интернета», помогает по устройству), факты о компании — только из FAQ, агент сообщает, что он ИИ, и при эскалации говорит, что обращение ушло администраторам уведомлением. Инструкции на английском (модель понимает их надёжнее, RO и RU почти одинаковы), говорит агент только на своём языке. Прежние версии — в истории панели и в git.

Ключевые правила прежней версии: только румынский, на другой язык агент не переходит (русский — отдельный агент,
см. `ultravox/prompts/ru.md`), обязательный `updateCall(request_summary=…)` сразу после понимания проблемы, `resolution`
при каждой рекомендации, жалоба на неисправность ведёт в диагностику даже без совпадения в FAQ,
параметры диагностики копируются из `getNetworkData` без выдумывания.

### 1.2. Inactivity Messages

| # | Duration | End Behavior | RO | RU |
|---|---|---|---|---|
| 1 | 45 с | **без Hang Up** (Unspecified) | «Pot sa va ajut cu ceva?» | «Могу чем-то помочь?» |
| 2 | 120 с | Interruptible Hang Up | «Se pare că nu vă mai aud. Vă mulțumesc pentru apel. O zi bună!» | «Похоже, вас не слышно. Спасибо за звонок. Хорошего дня!» |

Первое сообщение с Hang Up на 15 с обрывает звонок, пока агент ждёт ответа тулзов.

---

## 2. Общие правила для всех наших тулзов

| Поле | Значение |
|---|---|
| Tool Type | HTTP |
| URL | `https://avr.example.com:8443/tool/<имя тулза>` |
| Type (метод) | POST |
| Ключ | **Static parameter**: name `X-AVR-Key`, location **Header**, value = `sudo cat /etc/nginx/avr_tool_key` |
| Auth tokens | **не использовать** (см. §8) |
| Параметры | Dynamic, location **Body**, если не указано иное |

Сервер nginx пропускает только `POST /tool/<имя>` из списка тулзов и только с правильным
`X-AVR-Key`; без ключа — `403`.

---

## 3. Наши тулзы

### 3.1. searchFAQ

| Поле | Значение |
|---|---|
| URL | `https://avr.example.com:8443/tool/searchFAQ` |
| Timeout | 5 s |
| Precomputable | Yes (только читает) |

**Description:**
```text
Search the ExampleNet support FAQ. Call it for any caller question or problem before answering yourself.
query: the caller's question in their own words. lang: "ro" or "ru" (the caller's language).
Result: if data.found, say data.answer naturally in the caller's language, without adding details.
If data.requires_osmp, ask for the 5-digit OSMP code from the invoice, then call findByOSMP.
If not found or error, do not guess: offer a callback from a specialist.
```

| Тип | Name | Location | Type | Required | Description |
|---|---|---|---|---|---|
| Dynamic | `query` | Body | string | yes | The user's question in natural language |
| Dynamic | `lang` | Body | string | yes | Language code: 'ro' for Romanian or 'ru' for Russian |
| Static | `X-AVR-Key` | Header | — | — | ключ с сервера |

Ответ: `{"error":false,"data":{"found":true,"id":"no_internet","answer":"…","score":57,"tool":null,"requires_osmp":true}}`
или `{"found":false,"answer":null,"best_score":N}`.

### 3.2. findByOSMP

| Поле | Значение |
|---|---|
| URL | `https://avr.example.com:8443/tool/findByOSMP` |
| Timeout | 15 s (WHMCS отвечает до 15 с) |
| Precomputable | No (пишет в карточку звонка) |

**Description:**
```text
Find the caller in the billing system by OSMP code. Call it after the caller gives their OSMP code (exactly 5 digits, from the invoice).
Returns client_name, client_type, client_ip, is_active (service active), is_paid (no unpaid invoices).
If data.found is false or the code is invalid, ask the caller to repeat the code once; if still not found, offer a callback.
If is_active is false or is_paid is false, tell the caller politely (contract inactive / unpaid invoice) before any technical check.
If client_ip is empty, do not call getNetworkData; offer a callback from a technician.
```

| Тип | Name | Location | Type | Required | Description |
|---|---|---|---|---|---|
| Dynamic | `osmp_id` | Body | string | yes | Client OSMP code, exactly 5 digits |
| Static | `X-AVR-Key` | Header | — | — | ключ с сервера |

### 3.3. getNetworkData

| Поле | Значение |
|---|---|
| URL | `https://avr.example.com:8443/tool/getNetworkData` |
| Timeout | **15 s** (обычно ~0,4 с; 2 шага по ≤5 с к NetBox → худший случай ~10 с) |
| Precomputable | No |

**Description:**
```text
Get the client's network data from NetBox by the client IP returned by findByOSMP.
Returns mac_address, switch_name, switch_ip, port, pop.
Call diagnoseClient only if switch_ip AND mac_address are present. Never use the client IP as switch_ip.
If switch_ip or mac_address is empty, do not run diagnostics: tell the caller a technician will check the line and offer a callback.
```

| Тип | Name | Location | Type | Required | Description |
|---|---|---|---|---|---|
| Dynamic | `client_ip` | Body | string | yes | Client IP address from findByOSMP |
| Static | `X-AVR-Key` | Header | — | — | ключ с сервера |

### 3.4. diagnoseClient

| Поле | Значение |
|---|---|
| URL | `https://avr.example.com:8443/tool/diagnoseClient` |
| Timeout | **15 s** (замер 25.09.2026: 0,8–1,9 с на 13 Cisco; faq-server ждёт network-diag ≤12 с, SSH-лимит 10 с) |
| Precomputable | No |

**Description:**
```text
Check the client's connection on the network switch: port state and whether the client's device (MAC) is visible.
Use switch_ip, mac_address, switch_name and port exactly as returned by getNetworkData. Never pass the client IP as switch_ip.
The check takes a few seconds: tell the caller you are checking the line before calling.
Result: data.port_status "down" -> the line/port is down, a technician must check; data.mac_found false -> the client's router seems off or disconnected, ask the caller to check power and restart it;
mac_found true and port up -> the connection is OK on our side.
If the tool returns an error (including code SWITCH_IP_UNKNOWN), do not retry: offer a callback from a technician.
```

| Тип | Name | Location | Type | Required | Description |
|---|---|---|---|---|---|
| Dynamic | `switch_ip` | Body | string | yes | Switch management IP from getNetworkData |
| Dynamic | `mac_address` | Body | string | yes | Client MAC from getNetworkData |
| Dynamic | `switch_name` | Body | string | no | Switch name from getNetworkData |
| Dynamic | `port` | Body | string | no | Switch port from getNetworkData |
| Static | `X-AVR-Key` | Header | — | — | ключ с сервера |

### 3.5. updateCall

| Поле | Значение |
|---|---|
| URL | `https://avr.example.com:8443/tool/updateCall` |
| Timeout | 5 s |
| Precomputable | No |

**Description:**
```text
Save information gathered during the conversation to the current call record (sent to Telegram when the call ends).
Use call_id "latest". Send only the fields you learned.
request_summary: one sentence in the caller's own words describing the reason for the call - send it as soon as you understand the problem, never the FAQ answer.
resolution: what you told or recommended to the caller, or how the case ended.
Set needs_callback true (with callback_reason) whenever you promise the caller a callback.
```

Все параметры — Dynamic, Body, необязательные:

| Name | Type | Смысл |
|---|---|---|
| `request_summary` | string | **суть обращения словами клиента — отправлять всегда** |
| `resolution` | string | что сказали/порекомендовали клиенту |
| `call_id` | string | `latest` (текущий звонок) |
| `phone` | string | номер звонящего |
| `osmp_id` | string | OSMP клиента |
| `client_ip` | string | IP клиента |
| `is_active` | boolean | услуга активна |
| `is_paid` | boolean | нет долга |
| `mac_address` | string | MAC |
| `switch_name` | string | свитч |
| `switch_ip` | string | адрес свитча |
| `port` | string | порт |
| `pop` | string | точка присутствия |
| `port_status` | string | up / down |
| `mac_found` | boolean | MAC виден на свитче |
| `diagnosis` | string | вывод диагностики |
| `has_power` | boolean | у клиента есть питание на роутере |
| `router_rebooted` | boolean | клиент перезагрузил роутер |
| `possible_issue` | string | предполагаемая причина |
| `needs_callback` | boolean | нужен обратный звонок |
| `callback_reason` | string | причина обратного звонка |

+ Static `X-AVR-Key` (Header).

> Типы параметров сверить с экспортом (§7): в работающем агенте они могут быть заданы иначе.

### 3.6. Не подключаются к агенту

`startCall`, `endCall` (вызываются из диалплана Asterisk изнутри сервера), `getCalls` (ПД),
`checkRecentCall` (не используется). Все четыре закрыты в nginx — снаружи недоступны.

---

## 4. Встроенные тулзы Ultravox (в аккаунте)

`coldTransfer`, `coldTransferTo`, `warmTransfer`, `warmTransferTo` (перевод на оператора — содержат
SIP-логин/пароль в статических параметрах), `hangUp`, `leaveVoicemail`, `playDtmfSounds`,
`queryCorpus`. Какие из них подключены к агенту — _заполнить по дашборду_ (Agents → Tools).
Эти тулзы ходят на `api.ultravox.ai`, к нашему серверу отношения не имеют.

---

## 5. Проверка

**Test tool** в дашборде (вызов идёт из облака по реальному пути). Auth tokens не заполнять.

| Тулз | Тестовые параметры | Ожидаем |
|---|---|---|
| searchFAQ | `query`=`nu am internet`, `lang`=`ro` | 200, `"id":"no_internet"` |
| findByOSMP | `osmp_id`=`25883` | 200, `"found":true` |
| getNetworkData | `client_ip`=`198.51.100.25` | 200, данные NetBox |
| diagnoseClient | `switch_ip`=`10.99.0.20`, `mac_address`=`00:11:22:33:44:55`, `port`=`Fa0/1` | 200, `"port_status":"up"` (~2 с) |
| updateCall | `call_id`=`latest` | 200 (`No active calls` без звонка — нормально) |

`403` → нет или неверный `X-AVR-Key`. На сервере: `sudo tail /var/log/nginx/avr-tools.access.log`.

---

## 6. Изменение через API

**Агенты (промпт, голос, приветствие, сообщения при молчании, модель, VAD) — в панели, вкладка «Ultravox (агенты)»:**
показывает изменения до отправки, сохраняет копию агента в `instance/ultravox/history/<ro|ru>/` и умеет откатывать.
Скрипты ниже — для тулзов и для работы без панели.


```bash
python3 scripts/ultravox_tool_params.py --check updateCall     # что есть сейчас
python3 scripts/ultravox_tool_params.py --apply updateCall     # добавить request_summary + resolution
python3 scripts/ultravox_tool_params.py --apply <тулз> --param 'name:string:описание'
python3 scripts/ultravox_tool_params.py --apply <тулз> --timeout 15s   # только таймаут
```
Скрипт сам отвязывает тулз от агента при конфликте, правит и привязывает обратно; копия списка
тулзов агента остаётся в `/tmp/ultravox_agent_tools_backup.json`.

Промпт агента (`callTemplate.systemPrompt`):
```bash
python3 scripts/ultravox_prompt.py --check 'фраза'                    # где встречается
python3 scripts/ultravox_prompt.py --replace 'старое' 'новое'          # показать замену
python3 scripts/ultravox_prompt.py --replace 'старое' 'новое' --apply  # заменить
python3 scripts/ultravox_prompt.py --restore ~/ultravox_agent_backup_<дата>.json --apply
python3 scripts/ultravox_prompt.py --agent ru --check 'фраза'         # то же для RU-агента
```
Перед заменой сохраняется полная копия агента `~/ultravox_agent_backup_<дата>.json` (права 600).
Если меняется логика, которая нужна и новым установкам, — обновить образцы `ultravox/prompts/{ro,ru}.md`.

Тулзы общие для обоих агентов: правка тулза (`ultravox_tool_params.py`) сразу действует на RO и RU.

Новый агент копией RO (так создан `SupportBotRU`; без `--apply` только показывает):
```bash
python3 scripts/ultravox_agent_clone.py --name <Имя> --prompt-file <файл.md> --voice <voiceId> \
    --language-hint <ru> --greeting '<приветствие>' \
    --inactivity '45s=<текст>' --inactivity '120s=<текст>' [--apply]
```
Печатает ID нового агента — его записать в `.env` и подключить в compose (`PROJECT.md` §3.1).

## 7. Экспорт текущей конфигурации

```bash
cd ~/avr-infra && python3 scripts/ultravox_export.py
```
Пишет `~/ultravox_export_<дата>.md`: агент, подключённые тулзы, для каждого тулза — URL, таймаут,
описание, dynamic-параметры со схемами, **имена** статических параметров (значения не выводятся),
наличие Auth tokens. Файл безопасно пересылать. С `--raw` дополнительно сохраняется полный JSON
(`~/ultravox_tools_raw_<дата>.json`) — **в нём есть секреты** (ключ, SIP-пароли), хранить только
на сервере.

---

## 8. Ловушки интерфейса Ultravox

| Проблема | Причина | Что делать |
|---|---|---|
| «The attempted update is incompatible with how some agents use the tool» | Тулз подключён к агенту | Agents → агент → Tools → убрать тулз → Save → править тулз → вернуть тулз агенту → Save |
| Статический параметр «пропал» после сохранения | Интерфейс не показывает static-параметры | Проверить Test tool (200 без Auth tokens) или экспортом (§7); повторно не добавлять («duplicate») |
| Добавили **Auth token** | Auth tokens передаются при создании звонка, `avr-sts-ultravox` их не шлёт → в живом звонке не работает; в поле Header name не вписывать секрет | Удалить Auth token, ключ — только Static/Header |
| Удалили тулз — пропало описание | Описание хранится только в тулзе | Перед удалением — экспорт (§7); описания-эталоны — этот файл |
| Тулз обрывается | Timeout меньше времени ответа сервера | Таймауты — §3 |
| После смены ключа всё 403 | Ключ в тулзах старый | Обновить Static `X-AVR-Key` во всех 5 тулзах (`PROJECT.md` §8.4) |
