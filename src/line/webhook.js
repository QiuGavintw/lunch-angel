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
  DATE_PROMPT_REPLY,
  DATE_FORMAT_ERROR_REPLY,
} from '../lunch/service.js';
import {
  parseDateInputExtended,
  resolveRelativeDate,
  setPendingDateQuery,
  clearPendingDateQuery,
  isPendingDateQuery,
  isCancelText,
} from '../lunch/dateQuery.js';

const TEXT_REPLY = '👼 你好！我是午餐小天使～\n你可以直接輸入「今日午餐」查詢，也可以使用下面的按鈕快速查詢喔！';
const NON_TEXT_REPLY = '👼 午餐小天使目前主要提供午餐菜單查詢喔～🍱';
const LUNCH_ERROR_REPLY = '🍱 今日午餐\n\n⚠️ 午餐資料讀取失敗，請稍後再試。';
const DATE_QUERY_CANCEL_REPLY = '✅ 已取消日期查詢。\n\n需要時再輸入日期，或使用下方按鈕快速查詢！';
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
    action: { type: 'postback', label: '🔎 查詢指定日期', data: 'action=date', displayText: '查詢指定日期' },
  },
  {
    type: 'action',
    action: { type: 'message', label: '🙋我要申訴', text: '我要申訴' },
  },
  {
    type: 'action',
    action: { type: 'postback', label: 'ℹ️ 使用說明', data: 'action=info', displayText: '使用說明' },
  },
  {
    type: 'action',
    action: { type: 'postback', label: '📅 昨天', data: 'action=query&date=yesterday', displayText: '昨天' },
  },
  {
    type: 'action',
    action: { type: 'postback', label: '📅 今天', data: 'action=query&date=today', displayText: '今天' },
  },
  {
    type: 'action',
    action: { type: 'postback', label: '📅 明天', data: 'action=query&date=tomorrow', displayText: '明天' },
  },
];

function isAppealMessage(event) {
  return (
    event?.type === 'message' &&
    event?.message?.type === 'text' &&
    typeof event.message.text === 'string' &&
    event.message.text.trim() === '我要申訴'
  );
}

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

function logEventArrival(events) {
  const summary = (Array.isArray(events) ? events : [])
    .map((event) => {
      const type = event && typeof event.type === 'string' ? event.type : 'unknown';
      let detail = '';
      if (event && typeof event.postback?.data === 'string') {
        detail = `:${event.postback.data}`;
      }
      return `${type}${detail}`;
    })
    .join(',');
  console.log(`[webhook] events=${Array.isArray(events) ? events.length : 0} types=${summary}`);
}

function logReplyOutcome(event, error) {
  const type = event && typeof event.type === 'string' ? event.type : 'unknown';
  const data = typeof event?.postback?.data === 'string' ? event.postback.data : '';
  const dataPart = data ? ` data=${data}` : '';
  if (error) {
    const status = typeof error.status === 'number' ? error.status : null;
    const statusPart = status !== null ? ` status=${status}` : '';
    console.error(`[webhook] reply failed type=${type}${dataPart}${statusPart}`);
  } else {
    console.log(`[webhook] reply success type=${type}${dataPart}`);
  }
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

async function buildReplyText(event) {
  if (event.type === 'postback') {
    const data = event.postback?.data;
    const action = parsePostbackAction(data);

    const quickDate = data ? String(data).match(/^action=query&date=(yesterday|today|tomorrow)$/) : null;
    if (quickDate) {
      const relativeText = quickDate[1] === 'yesterday' ? '昨天' : quickDate[1] === 'today' ? '今天' : '明天';
      const date = resolveRelativeDate(relativeText);
      clearPendingDateQuery(event);
      const { date: resolvedDate, lunch } = await getLunchByDate(date);
      return lunch ? formatLunchMessage(resolvedDate, lunch) : formatEmptyDateMessage(resolvedDate);
    }

    if (!action) {
      return `${TEXT_REPLY}\n\n⚠️ 無法辨識的操作。`;
    }
    if (action === 'date') {
      setPendingDateQuery(event);
      return DATE_PROMPT_REPLY;
    }
    clearPendingDateQuery(event);
    return getLunchReplyFor(action);
  }

  if (event.type !== 'message' || event.message.type !== 'text') {
    if (isPendingDateQuery(event)) {
      return `${NON_TEXT_REPLY}\n\n📅 ${DATE_PROMPT_REPLY}`;
    }
    return NON_TEXT_REPLY;
  }

  const text = event.message.text.trim();

  if (isPendingDateQuery(event)) {
    if (isCancelText(text)) {
      clearPendingDateQuery(event);
      return DATE_QUERY_CANCEL_REPLY;
    }
    const parsedDate = parseDateInputExtended(text);
    if (!parsedDate) {
      return DATE_FORMAT_ERROR_REPLY;
    }
    clearPendingDateQuery(event);
    const { date, lunch } = await getLunchByDate(parsedDate);
    return lunch ? formatLunchMessage(date, lunch) : formatEmptyDateMessage(date);
  }

  if (LUNCH_KEYWORDS.has(text)) {
    return getLunchReply();
  }

  const parsedDate = parseDateInputExtended(text);
  if (parsedDate) {
    const { date, lunch } = await getLunchByDate(parsedDate);
    return lunch ? formatLunchMessage(date, lunch) : formatEmptyDateMessage(date);
  }

  if (text === '你好' || text === '哈囉' || text === '嗨' || text === '早安' || text === '謝謝') {
    return TEXT_REPLY;
  }

  return TEXT_REPLY;
}

async function handleEvent(event) {
  const eventType = event && typeof event.type === 'string' ? event.type : 'unknown';
  const postbackData = typeof event?.postback?.data === 'string' ? event.postback.data : '';

  if (!event.replyToken) {
    console.log(`[webhook] missing replyToken type=${eventType}${postbackData ? ` data=${postbackData}` : ''}`);
    return null;
  }

  if (isAppealMessage(event)) {
    console.log('[webhook] 收到「我要申訴」，不主動回覆（由 LINE 官方帳號 Auto Reply 處理）');
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
    clearPendingDateQuery(event);
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

  try {
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [message],
    });
    logReplyOutcome(event, null);
    return true;
  } catch (err) {
    logReplyOutcome(event, err);
    logLineReplyError(err);
    throw err;
  }
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

      logEventArrival(events);

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

export { buildReplyText, buildQuickReply, isAppealMessage, handleEvent, getTodayString, getWeekdayText, getTodayLunch, getTomorrowLunch, getWeekLunch, getLunchReplyFor, formatLunchMessage, formatEmptyDateMessage, DATE_PROMPT_REPLY, DATE_FORMAT_ERROR_REPLY };