# admin-panel — ops-панель avr-infra

Редактор `.env` и конфигов Asterisk + мониторинг интеграций с уведомлениями в Telegram.

## Что делает
- **Мониторинг:** статус каждой интеграции (Ultravox, WHMCS, NetBox, Telegram, network-diag, faq-server, ngrok-туннель). Рядом с каждой — 🟢/🔴 и текст ошибки, если отвалилось.
- **Кнопка «Проверить сейчас»** — прогон всех проверок вручную + отчёт в Telegram.
- **Крон 08:00** (Europe/Chisinau) — ежедневный отчёт в Telegram, с пометкой если что-то упало.
- **Редактор `.env`** — группы и описания из `.env.example` (`envSchema.js`), проверка значений перед записью, секреты замаскированы (`••••last4`), сохраняются только изменённые поля; копия перед записью — `~/avr-infra-backups/` на хосте (последние 30).
- **Редактор Asterisk** — `pjsip.conf`, `extensions.conf` и др. (whitelist), бэкап в `.backups/`, кнопка перезапуска Asterisk.

## Безопасность (обязательно к прочтению)
Панель правит живые секреты, конфиг Asterisk и перезапускает контейнеры. Поэтому:
- Порт **привязан к `127.0.0.1`** — наружу НЕ публикуется. Доступ только с хоста или через SSH-туннель/VPN.
- Обязательная HTTP Basic-аутентификация. `PANEL_PASS` без значения = панель не стартует.
- Секреты в UI замаскированы; поле с `••••` при сохранении не перезаписывает реальное значение.
- Для рестарта контейнеров монтируется `docker.sock`. Это мощный доступ (фактически root на хосте),
  поэтому localhost-only + пароль — не опция, а требование. Если рестарт не нужен — убери
  монтирование сокета и роут `/api/restart`.

## Установка

1. Положи папку `admin-panel/` в корень проекта (рядом с `faq-server/`, `network-diag/`).

2. Добавь в `.env` две строки:
```
PANEL_USER=admin
PANEL_PASS=<длинный-случайный-пароль>
```

3. Добавь сервис в `docker-compose-ultravox.yml`:
```yaml
  admin-panel:
    build: ./admin-panel
    container_name: admin-panel
    restart: always
    environment:
      - PANEL_USER=${PANEL_USER}
      - PANEL_PASS=${PANEL_PASS}
      - ENV_PATH=/data/.env
      - ASTERISK_DIR=/data/asterisk/conf
      - FAQ_SERVER_URL=http://faq-server:3000
      - NETWORK_DIAG_URL=http://network-diag:5000
      - CRON_TZ=Europe/Chisinau
    ports:
      - "127.0.0.1:8090:8090"        # ТОЛЬКО localhost — не менять на 0.0.0.0
    volumes:
      - ./.env:/data/.env                        # редактирование переменных
      - ./asterisk/conf:/data/asterisk/conf       # редактирование конфигов Asterisk
      - /var/run/docker.sock:/var/run/docker.sock # рестарт контейнеров
    networks:
      - avr
```

4. Подними:
```bash
docker compose -f docker-compose-ultravox.yml up -d --build admin-panel
```

5. Открой с хоста: `http://127.0.0.1:8090` (логин/пароль из `PANEL_USER`/`PANEL_PASS`).
   Удалённо — через SSH-туннель: `ssh -L 8090:127.0.0.1:8090 user@host`, затем локально тот же адрес.

## Заметки
- **После правки `.env`** переменные подхватятся только после рестарта затронутых сервисов
  (кнопки рестарта — на вкладке Asterisk для Asterisk; для faq-server/network-diag можно
  добавить кнопки или рестартить вручную).
- **Часовой пояс крона** — `CRON_TZ` (по умолчанию Europe/Chisinau).
