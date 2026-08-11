import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUNCH_DATA_PATH = path.resolve(__dirname, '../../data/lunch.json');

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

function addDays(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

export function getTomorrowString() {
  return addDays(getTodayString(), 1);
}

function getMondayOffset(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
  return weekday === 0 ? -6 : 1 - weekday;
}

export function getThisWeekDates() {
  const today = getTodayString();
  const monday = addDays(today, getMondayOffset(today));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

function safe(value) {
  return value === undefined || value === null ? '' : String(value);
}

async function readLunchData() {
  try {
    return JSON.parse(await readFile(LUNCH_DATA_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function parseDateInput(text) {
  const input = String(text).trim();
  let y;
  let mo;
  let d;

  const full = input.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (full) {
    y = Number(full[1]);
    mo = Number(full[2]);
    d = Number(full[3]);
  } else {
    const short = input.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (!short) return null;
    const [todayY] = getTodayString().split('-').map(Number);
    y = todayY;
    mo = Number(short[1]);
    d = Number(short[2]);
  }

  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
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
    `🍚 主食：${safe(lunch.staple)}`,
    `🍖 主菜：${safe(lunch.main)}`,
    `🥬 副菜1：${safe(lunch.side1)}`,
    `🥬 副菜2：${safe(lunch.side2)}`,
    `🥬 副菜3：${safe(lunch.side3)}`,
    `🍎 水果&點心：${safe(lunch.dessert)}`,
    '',
    `ℹ️${safe(lunch.info)}`,
    '👼 午餐小天使祝你用餐愉快！',
  ].join('\n');
}

export function formatEmptyDateMessage(date) {
  return [
    '📭 目前沒有這一天的官方午餐資料。',
    '',
    '請確認日期，或稍後再試。',
  ].join('\n');
}

export function formatEmptyTomorrowMessage(date) {
  return [
    '📭 目前沒有這一天的官方午餐資料。',
    '',
    '請稍後再試，或直接查詢其他日期。',
  ].join('\n');
}

export function formatWeekMessage(entries) {
  if (entries.length === 0) {
    return ['📭 目前沒有本週的官方午餐資料。', '', '👼 午餐小天使祝你用餐愉快！'].join('\n');
  }

  const lines = ['📆 本週午餐', ''];
  for (const { date, lunch } of entries) {
    const [, mo, d] = date.split('-');
    const weekday = getWeekdayText(date);
    lines.push(`📅 ${mo}/${d} ${weekday}`);
    lines.push(`🍚 主食：${safe(lunch.staple)}`);
    lines.push(`🍖 主菜：${safe(lunch.main)}`);
    lines.push('');
  }
  lines.push('👼 午餐小天使祝你用餐愉快！');
  return lines.join('\n');
}

export const INFO_REPLY = [
  'ℹ️ 午餐小天使',
  '',
  '提供馬公高中官方午餐資訊查詢。',
  '',
  '資料來源：',
  '馬公高中官方網站',
  '',
  '🍱 今日午餐',
  '📅 明日午餐',
  '📆 本週午餐',
  '🔎 指定日期查詢',
  '',
  '👼 午餐小天使祝你用餐愉快！',
].join('\n');

export const DATE_PROMPT_REPLY = [
  '📅 請輸入要查詢的日期。',
  '',
  '格式：',
  'YYYY/MM/DD',
  '',
  '例如：',
  '2026/08/15',
].join('\n');

export const DATE_FORMAT_ERROR_REPLY = [
  '⚠️ 日期格式不正確。',
  '',
  '請使用：',
  '',
  'YYYY/MM/DD',
  '',
  '例如：',
  '2026/08/15',
].join('\n');

export async function getLunchByDate(date) {
  const data = await readLunchData();
  return { date, lunch: data[date] ?? null };
}

export async function getTodayLunch() {
  return getLunchByDate(getTodayString());
}

export async function getTomorrowLunch() {
  const date = getTomorrowString();
  return getLunchByDate(date);
}

export async function getWeekLunch() {
  const data = await readLunchData();
  return getThisWeekDates()
    .filter((date) => data[date])
    .map((date) => ({ date, lunch: data[date] }));
}

export async function getLunchReplyFor(action) {
  switch (action) {
    case 'today': {
      const { date, lunch } = await getTodayLunch();
      return formatLunchMessage(date, lunch);
    }
    case 'tomorrow': {
      const { date, lunch } = await getTomorrowLunch();
      return lunch ? formatLunchMessage(date, lunch) : formatEmptyTomorrowMessage(date);
    }
    case 'week':
      return formatWeekMessage(await getWeekLunch());
    case 'date':
      return DATE_PROMPT_REPLY;
    case 'info':
      return INFO_REPLY;
    default:
      return DATE_FORMAT_ERROR_REPLY;
  }
}

export async function getLunchReply() {
  try {
    const { date, lunch } = await getTodayLunch();
    return formatLunchMessage(date, lunch);
  } catch (err) {
    console.error(`[lunch] 讀取午餐資料失敗：${err.message}`);
    return '🍱 今日午餐\n\n⚠️ 午餐資料讀取失敗，請稍後再試。';
  }
}