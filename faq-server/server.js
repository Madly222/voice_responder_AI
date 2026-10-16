const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(cors());
app.use(express.json());

// Static files for sounds
app.use('/sounds', express.static(path.join(__dirname, 'public/sounds')));

// FAQ читает и перечитывает tools/faq.js (при изменении файла, P-03) — здесь только счётчик для /health.
const { faqCount } = require('./tools/faq');
const tools = require('./tools');
const telegram = require('./tools/telegram-webhook');
const transcript = require('./tools/ultravoxTranscript');
const callLogger = require('./tools/callLogger');
console.log(`[Server] Loaded ${Object.keys(tools).length} tools`);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    faq_count: faqCount(),
    tools: Object.keys(tools),
    telegram_configured: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
  });
});

app.post('/tool/:name', async (req, res) => {
  const { name } = req.params;
  if (!tools[name]) return res.status(404).json({ error: `Tool "${name}" not found` });
  try {
    // P-02: ID звонка Ultravox (автоматический параметр тулза) → наш звонок.
    // Без него (Asterisk, Test tool) всё как раньше — последний открытый звонок.
    const body = req.body || {};
    const uvCallId = String(body.uv_call_id || req.get('X-Uv-Call-Id') || '').trim() || null;
    delete body.uv_call_id;
    let result;
    if (uvCallId) {
      const ctx = { uvCallId, callId: await callLogger.bindUltravoxCall(uvCallId) };
      result = await callLogger.runInCall(ctx, () => tools[name].execute(body));
    } else {
      result = await tools[name].execute(body);
    }
    if (name === 'endCall' && result.data && result.data.chatbot_data) {
      console.log('[Server] endCall executed, sending to Telegram...');
      const cd = result.data.chatbot_data;
      const snapshot = cd._call;
      delete cd._call;

      // Суть обращения обязательна. Если агент не прислал request_summary — берём сводку Ultravox
      // (готова через несколько секунд после конца звонка); нет сводки — фразы из стенограммы.
      const enrich = async () => {
        if (!snapshot) return cd;
        if (snapshot.uv_call_id) {
          for (let i = 0; i < 5; i++) {
            await new Promise((r) => setTimeout(r, 4000));
            const info = await transcript.getCallInfo(snapshot.uv_call_id);
            if (info && info.shortSummary) {
              console.log('[Server] Суть обращения — из сводки Ultravox');
              // Заметка агента бывает ранней и неполной — сводка Ultravox идёт рядом с ней.
              // Без заметки — ещё и распознанная речь: по ней человек проверит толкование агента.
              const utt = snapshot.request_summary ? []
                : await transcript.getUserUtterances(cd.start_time, cd.end_time, snapshot.lang, snapshot.uv_call_id).catch(() => []);
              return Object.assign(cd, callLogger.rebuildChatbotData(snapshot, utt, info.shortSummary));
            }
          }
          console.warn('[Server] Сводки Ultravox нет за 20 с — беру фразы из стенограммы');
        }
        if (cd.user_request || snapshot.request_summary) return cd;
        for (const waitMs of [0, 4000]) {   // стенограмма появляется с небольшой задержкой
          if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
          const utt = await transcript.getUserUtterances(cd.start_time, cd.end_time, snapshot.lang, snapshot.uv_call_id);
          if (utt.length) {
            console.log(`[Server] Фразы клиента взяты из стенограммы Ultravox (${utt.length})`);
            return Object.assign(cd, callLogger.rebuildChatbotData(snapshot, utt));
          }
        }
        console.warn('[Server] Фразу клиента получить не удалось (ни searchFAQ, ни стенограмма)');
        return cd;
      };

      enrich().then((data) => telegram.sendToTelegram(data)).then(telegramResult => {
        if (!telegramResult.error) {
          console.log('[Server] Successfully sent to Telegram');
        }
      }).catch(err => {
        console.error('[Server] Telegram send error:', err.message);
      });
      if (cd.needs_callback) {
        telegram.sendCallbackAlert(cd).catch(err => console.error('[Server] Callback alert error:', err.message));
      }
    }
    res.json(result);
  } catch (err) {
    console.error('[Tool] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log('[Server] Telegram integration:', process.env.TELEGRAM_BOT_TOKEN ? 'ENABLED' : 'DISABLED');
});
