const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(cors());
app.use(express.json());

app.use('/sounds', express.static(path.join(__dirname, 'public/sounds')));

// tools/faq.js loads and reloads the FAQ (on file change, P-03); only the count for /health is used here.
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
    // P-02: Ultravox call ID (automatic tool parameter) -> our call.
    // Without it (Asterisk, Test tool) the last open call is used, as before.
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

      // The request summary is mandatory. If the agent sent no request_summary, use the Ultravox summary
      // (ready a few seconds after the call ends); with no summary, use phrases from the transcript.
      const enrich = async () => {
        if (!snapshot) return cd;
        if (snapshot.uv_call_id) {
          for (let i = 0; i < 5; i++) {
            await new Promise((r) => setTimeout(r, 4000));
            const info = await transcript.getCallInfo(snapshot.uv_call_id);
            if (info && info.shortSummary) {
              console.log('[Server] Суть обращения — из сводки Ultravox');
              // The agent's note can be early and incomplete, so the Ultravox summary goes next to it.
              // Without a note, add the recognised speech too, so a human can check the agent's interpretation.
              const utt = snapshot.request_summary ? []
                : await transcript.getUserUtterances(cd.start_time, cd.end_time, snapshot.lang, snapshot.uv_call_id).catch(() => []);
              return Object.assign(cd, callLogger.rebuildChatbotData(snapshot, utt, info.shortSummary));
            }
          }
          console.warn('[Server] Сводки Ultravox нет за 20 с — беру фразы из стенограммы');
        }
        if (cd.user_request || snapshot.request_summary) return cd;
        for (const waitMs of [0, 4000]) {   // the transcript appears with a short delay
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
