# AI-автоответчик техподдержки интернет-провайдера

Голосовой ИИ-агент, который принимает звонки на линию техподдержки, отвечает на частые вопросы,
находит абонента в биллинге и сам диагностирует его подключение на коммутаторе — на румынском и русском.

Построен на открытом проекте [Agent Voice Response — avr-infra](https://github.com/agentvoiceresponse/avr-infra)
(MIT, © Agent Voice Response). Из апстрима взяты Asterisk и ядро AVR (Docker-образы); всё остальное
в этом репозитории — моя доработка под реальную эксплуатацию.

> Все имена, домены, IP-адреса, номера и идентификаторы заменены на примеры
> (`example.com`, `192.0.2.0/24`, `203.0.113.0/24` и т.п.).

![Панель управления — мониторинг](images/screenshots/01-monitoring.png)

## Скриншоты

Панель управления на демо-данных: FAQ, промпты и тулзы — из этого репозитория, статусы и журнал вымышленные.

| | |
|---|---|
| ![FAQ](images/screenshots/02-faq.png) | ![Агент Ultravox](images/screenshots/04-ultravox-agent.png) |
| FAQ: ключевые слова и ответы на RO и RU | Агент Ultravox: голос, приветствие, промпт |
| ![Тулзы](images/screenshots/05-ultravox-tools.png) | ![Переменные .env](images/screenshots/03-env.png) |
| Тулзы и история изменений агента | Переменные `.env` с описаниями |

<p align="center">
  <img src="images/screenshots/09-telegram.png" alt="Telegram: отчёт о звонке и плановая проверка" width="55%">
</p>
<p align="center"><b>Telegram-бот:</b> отчёт о каждом звонке и результат плановой проверки сервисов
(текст сформирован кодом <code>faq-server/tools/callLogger.js</code> и <code>admin-panel/server.js</code>)</p>

<details>
<summary>Ещё скриншоты</summary>

| | |
|---|---|
| ![Asterisk](images/screenshots/06-asterisk.png) | ![Справка](images/screenshots/07-guide.png) |
| Конфиги Asterisk | Справка и проверка первого запуска |
| ![Светлая тема](images/screenshots/08-monitoring-light.png) | |
| Светлая тема | |

</details>

## Что сделано поверх AVR

- **Два агента Ultravox (RO / RU)** и голосовое меню выбора языка в Asterisk; промпты — `ultravox/prompts/`.
- **faq-server** (Node.js) — HTTP-тулзы агента: поиск по FAQ, поиск клиента в биллинге (WHMCS),
  данные о подключении из NetBox, запуск диагностики, журнал звонков и отчёт о каждом звонке в Telegram.
- **network-diag** (Python/Flask) — SSH-диагностика коммутаторов абонента: статус порта, MAC-адреса,
  ошибки; доступ только в разрешённые сети управления.
- **admin-panel** (Node.js) — веб-панель: настройки `.env`, FAQ, агенты Ultravox, Asterisk,
  мониторинг здоровья сервисов, ежедневный отчёт, защита от подбора пароля и журнал действий.
- **Публикация тулзов** — nginx + Let's Encrypt (DNS-01), наружу только нужные эндпоинты с ключом.
- **install.sh** — установка на чистый сервер: Docker, настройки со случайными паролями, ufw, запуск.

## Архитектура

```
Звонящий ─► АТС (FreePBX) ─SIP─► avr-asterisk ─► avr-core ─► avr-sts-ultravox ─► Ultravox Cloud (LLM + голос)
                                                                                     │ вызовы тулзов
                                     https://avr.example.com:8443/tool/* (nginx) ◄───┘
                                                     │
                                faq-server ─► биллинг (WHMCS), NetBox, network-diag ─► коммутаторы
                                     └─► Telegram (отчёт о звонке)
```

## Документация

- [PROJECT.md](PROJECT.md) — архитектура, эксплуатация, история изменений
- [ULTRAVOX.md](ULTRAVOX.md) — настройка агентов и тулзов
- [MIGRATION.md](MIGRATION.md) — перенос на другой сервер и найденные «ловушки»
- [PBX_IVR.md](PBX_IVR.md) — голосовое меню выбора языка на АТС

## Запуск

```bash
cp .env.example .env   # заполнить ключи
./install.sh --dry-run # посмотреть, что будет сделано
./install.sh
```

## Лицензия

MIT — см. [LICENSE.md](LICENSE.md). Исходный проект: © Agent Voice Response.
