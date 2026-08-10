import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineBotClient, middleware } from '@line/bot-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUNCH_DATA_PATH = path.resolve(__dirname, '../../data/lunch.json');

const TEXT_REPLY = '👼 嗨！我是午餐小天使！\n請輸入「今日午餐」查詢今天的午餐喔～🍱';
const NON_TEXT_REPLY = '👼 午餐小天使目前主要提供午餐菜單查詢喔～🍱';
const LUNCH_ERROR_REPLY = '🍱 今日午餐\n\n⚠️ 午餐資料讀取失敗，請稍後再試。';
const LUNCH_KEYWORDS = new Set(['今日午餐', '今天午餐', '午餐']);

let client = null;

function getClient() {
  if (!client && process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    client = LineBotClient.fromChannelAccessToken({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    });
  }
  return client;
}

export function getTodayString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function getWeekdayText(dateString) {
  const [y, m, d] = String(dateString).split('-').map(Number);
  const noonTaipeiUTC = Date.UTC(y, m - 1, d, 4, 0, 0);
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    weekday: 'long',
  }).format(new Date(noonTaipeiUTC));
}

export async function getTodayLunch() {
  const date = getTodayString();
  const raw = await readFile(LUNCH_DATA_PATH, 'utf8');
  const data = JSON.parse(raw);
  return { date, lunch: data[date] ?? null };
}

export function formatLunchMessage(date, lunch) {
  const [y, m, d] = String(date).split('-');
  const displayDate = `${y}/${m}/${d}`;
  const weekday = getWeekdayText(date);

  if (!lunch) {
    return [
      '🍱 今日午餐',
      '',
      `📅 ${displayDate} ${weekday}`,
      '',
      '😢 目前還沒有今天的午餐資料。',
      '',
      '請稍後再試一次！',
      '',
      '👼 午餐小天使',
    ].join('\n');
  }

  return [
    `📅 ${displayDate} ${weekday}`,
    '',
    `🍚 主食：${lunch.staple}`,
    `🍖 主菜：${lunch.main}`,
    `🥬 副菜1：${lunch.side1}`,
    `🥬 副菜2：${lunch.side2}`,
    `🥬 副菜3：${lunch.side3}`,
    `🍎 水果&點心：${lunch.dessert}`,
    '',
    `ℹ️${lunch.info}`,
    '👼 午餐小天使祝你用餐愉快！',
  ].join('\n');
}

export async function getLunchReply() {
  try {
    const { date, lunch } = await getTodayLunch();
    return formatLunchMessage(date, lunch);
  } catch (err) {
    console.error(`[webhook] 讀取午餐資料失敗：${err.message}`);
    return LUNCH_ERROR_REPLY;
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

async function handleEvent(event) {
  if (event.type !== 'message' || !event.replyToken) {
    return null;
  }

  const lineClient = getClient();
  if (!lineClient) {
    console.error('[webhook] LINE_CHANNEL_ACCESS_TOKEN 尚未設定，無法回覆');
    return null;
  }

  let replyText;
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    replyText = LUNCH_KEYWORDS.has(text) ? await getLunchReply() : TEXT_REPLY;
  } else {
    replyText = NON_TEXT_REPLY;
  }

  return lineClient.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text: replyText }],
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