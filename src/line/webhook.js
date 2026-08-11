import { LineBotClient, middleware } from '@line/bot-sdk';
import {
  getTodayString,
  getWeekdayText,
  getTodayLunch,
  getTomorrowLunch,
  getWeekLunch,
  getLunchByDate,
  getLunchReply,
  getLunchReplyFor,
  formatLunchMessage,
  formatEmptyDateMessage,
  parseDateInput,
  DATE_PROMPT_REPLY,
  DATE_FORMAT_ERROR_REPLY,
} from '../lunch/service.js';

const TEXT_REPLY = '👼 你好！我是午餐小天使～\n你可以直接輸入「今日午餐」查詢，也可以使用下面的按鈕快速查詢喔！';
const NON_TEXT_REPLY = '👼 午餐小天使目前主要提供午餐菜單查詢喔～🍱';
const LUNCH_ERROR_REPLY = '🍱 今日午餐\n\n⚠️ 午餐資料讀取失敗，請稍後再試。';
const LUNCH_KEYWORDS = new Set(['今日午餐', '今天午餐', '午餐']);

const QUICK_REPLY_ITEMS = [
  {
    type: 'action',
    action: { type: 'postback', label: '🍱 今日午餐', data: 'action=today', displayText: '今日午餐' },
  },
  {
    type: 'action',
    action: { type: 'postback', label: '📅 明日午餐', data: 'action=tomorrow', displayText: '明日午餐' },
  },
  {
    type: 'action',
    action: { type: 'postback', label: '📆 本週午餐', data: 'action=week', displayText: '本週午餐' },
  },
  {
    type: 'action',
    action: { type: 'postback', label: '🔎 查詢日期', data: 'action=date', displayText: '查詢日期' },
  },
  {
    type: 'action',
    action: { type: 'postback', label: 'ℹ️ 使用說明', data: 'action=info', displayText: '使用說明' },
  },
];

function buildQuickReply() {
  return { items: QUICK_REPLY_ITEMS };
}

let client = null;

function getClient() {
  if (!client && process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    client = LineBotClient.fromChannelAccessToken({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    });
  }
  return client;
}

function parsePostbackAction(data) {
  const match = String(data).match(/^action=(\w+)$/);
  return match ? match[1] : null;
}

function logLineReplyError(err) {
  console.error('[webhook] handle event error');

  if (err && typeof err.status === 'number') {
    console.error(`status: ${err.status}`);
    if (err.statusText) {
      console.error(`statusText: ${err.statusText}`);
    }
  }

  if (err && typeof err.body === 'string' && err.body.length > 0) {
    let parsed = null;
    try {
      parsed = JSON.parse(err.body);
    } catch {
      parsed = null;
    }

    if (parsed && typeof parsed.message === 'string') {
      console.error(`LINE error: ${parsed.message}`);
      if (Array.isArray(parsed.details) && parsed.details.length > 0) {
        console.error(`LINE detail: ${JSON.stringify(parsed.details[0])}`);
      }
    } else {
      console.error(`LINE response body: ${err.body.slice(0, 500)}`);
    }
  } else {
    console.error(`message: ${err ? err.message : String(err)}`);
  }
}

function buildReplyText(event) {
  if (event.type === 'postback') {
    const action = parsePostbackAction(event.postback?.data);
    if (!action) return `${TEXT_REPLY}\n\n⚠️ 無法辨識的操作。`;
    return getLunchReplyFor(action);
  }

  if (event.type !== 'message' || event.message.type !== 'text') {
    return NON_TEXT_REPLY;
  }

  const text = event.message.text.trim();

  if (LUNCH_KEYWORDS.has(text)) {
    return getLunchReply();
  }

  if (/^(\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}\/\d{1,2})$/.test(text)) {
    const parsedDate = parseDateInput(text);
    if (!parsedDate) return DATE_FORMAT_ERROR_REPLY;
    return getLunchByDate(parsedDate).then(({ date, lunch }) =>
      lunch ? formatLunchMessage(date, lunch) : formatEmptyDateMessage(date)
    );
  }

  if (text === '你好' || text === '哈囉' || text === '嗨' || text === '早安' || text === '謝謝') {
    return TEXT_REPLY;
  }

  return TEXT_REPLY;
}

async function handleEvent(event) {
  if (!event.replyToken) {
    return null;
  }

  const lineClient = getClient();
  if (!lineClient) {
    console.error('[webhook] LINE_CHANNEL_ACCESS_TOKEN 尚未設定，無法回覆');
    return null;
  }

  let replyText;
  try {
    replyText = await buildReplyText(event);
  } catch (err) {
    if (event.type === 'message' && event.message?.type === 'text') {
      const text = event.message.text.trim();
      if (LUNCH_KEYWORDS.has(text)) {
        replyText = LUNCH_ERROR_REPLY;
      } else {
        replyText = TEXT_REPLY;
      }
    } else {
      replyText = NON_TEXT_REPLY;
    }
  }

  const message = { type: 'text', text: replyText };
  message.quickReply = buildQuickReply();

  return lineClient.replyMessage({
    replyToken: event.replyToken,
    messages: [message],
  });
}

export function registerWebhook(app) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  const signatureValidator = secret ? middleware({ channelSecret: secret }) : null;

  const handlers = [];
  if (signatureValidator) {
    handlers.push(signatureValidator);
  }
  handlers.push(async (req, res) => {
    try {
      const events = req.body?.events;

      if (!Array.isArray(events) || events.length === 0) {
        return res.status(200).json({ status: 'ok' });
      }

      await Promise.all(
        events.map((event) =>
          handleEvent(event).catch((err) => {
            logLineReplyError(err);
          })
        )
      );

      return res.status(200).json({ status: 'ok' });
    } catch (err) {
      console.error(`[webhook] unexpected error: ${err.message}`);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  app.post('/webhook', handlers);
}

export { buildReplyText, getTodayString, getWeekdayText, getTodayLunch, getTomorrowLunch, getWeekLunch, getLunchReplyFor, formatLunchMessage, formatEmptyDateMessage, parseDateInput, DATE_PROMPT_REPLY, DATE_FORMAT_ERROR_REPLY };