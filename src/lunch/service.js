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

function getSpecialDayLabel(lunch) {
  if (!lunch) return null;
  const text = ['info', 'main', 'staple', 'side1', 'side2', 'side3', 'dessert']
    .map((k) => safe(lunch[k]))
    .join(' ');
  const rules = [
    { pattern: /週末|星期六|星期日|六日|休息日/, label: '🌴 週末' },
    { pattern: /補課/, label: '🏫 補課日' },
    { pattern: /補假/, label: '🎉 補假日' },
    { pattern: /國定假日/, label: '🎉 國定假日' },
    { pattern: /校慶/, label: '🎉 校慶日' },
    { pattern: /放假|無供餐|停餐|不供餐/, label: '🏫 今日無午餐供餐' },
  ];
  for (const rule of rules) {
    if (rule.pattern.test(text)) return rule.label;
  }
  return null;
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
  const special = getSpecialDayLabel(lunch);

  if (!lunch) {
    return [
      `📅 ${displayDate} ${weekday}`,
      '',
      '📭 目前沒有這一天的官方午餐資料。',
      '',
      '你可以：',
      '🍱 查看今日午餐',
      '📅 查詢其他日期',
      '📆 查看本週午餐',
      '',
      '👼 午餐小天使提醒你，官方菜單會依學校公告更新。',
    ].join('\n');
  }

  if (special) {
    return [
      `📅 ${displayDate} ${weekday}`,
      '',
      special,
      '',
      `🍚 主食：${safe(lunch.staple)}`,
      `🍖 主菜：${safe(lunch.main)}`,
      `🥬 副菜1：${safe(lunch.side1)}`,
      `🥬 副菜2：${safe(lunch.side2)}`,
      `🥬 副菜3：${safe(lunch.side3)}`,
      `🍎 水果&點心：${safe(lunch.dessert)}`,
      '',
      `ℹ️ ${safe(lunch.info)}`,
      '👼 午餐小天使祝你用餐愉快！',
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
    `ℹ️ ${safe(lunch.info)}`,
    '👼 午餐小天使祝你用餐愉快！',
  ].join('\n');
}

export function formatEmptyDateMessage(date) {
  const [y, m, d] = String(date).split('-');
  const displayDate = `${y}/${m}/${d}`;
  const weekday = getWeekdayText(date);
  return [
    `📅 ${displayDate} ${weekday}`,
    '',
    '📭 目前沒有這一天的官方午餐資料。',
    '',
    '你可以：',
    '🍱 查看今日午餐',
    '📅 查詢其他日期',
    '📆 查看本週午餐',
    '',
    '👼 午餐小天使提醒你，官方菜單會依學校公告更新。',
  ].join('\n');
}

export function formatEmptyTomorrowMessage(date) {
  const [y, m, d] = String(date).split('-');
  const displayDate = `${y}/${m}/${d}`;
  const weekday = getWeekdayText(date);
  return [
    `📅 ${displayDate} ${weekday}`,
    '',
    '📭 目前沒有這一天的官方午餐資料。',
    '',
    '你可以：',
    '🍱 查看今日午餐',
    '📅 查詢其他日期',
    '📆 查看本週午餐',
    '',
    '👼 午餐小天使提醒你，官方菜單會依學校公告更新。',
  ].join('\n');
}

export function formatWeekMessage(entries, weekDates = getThisWeekDates()) {
  const SEP = '━━━━━━━━━━━━';
  const lines = ['📆 本週午餐', ''];

  const byDate = new Map((entries || []).map((e) => [e.date, e.lunch]));

  for (const date of weekDates) {
    const [, mo, d] = date.split('-');
    const weekday = getWeekdayText(date);
    const lunch = byDate.get(date);

    lines.push(SEP);
    if (!lunch) {
      lines.push(`📅 ${mo}/${d} ${weekday}`);
      lines.push('📭 尚無官方資料');
      continue;
    }

    const special = getSpecialDayLabel(lunch);
    lines.push(`📅 ${mo}/${d} ${weekday}`);
    if (special) {
      lines.push(special);
      continue;
    }
    lines.push(`🍚 主食：${safe(lunch.staple)}`);
    lines.push(`🍖 主菜：${safe(lunch.main)}`);
  }

  lines.push(SEP);
  lines.push('');
  lines.push('ℹ️ 詳細資訊請上馬公高中官網查詢');
  lines.push('👼 午餐小天使祝你用餐愉快！');
  return lines.join('\n');
}

export const INFO_REPLY = [
  '🍱 午餐小天使使用說明',
  '',
  '你可以：',
  '🍱 今日午餐',
  '📅 明日午餐',
  '📆 本週午餐',
  '🔎 查詢指定日期',
  '',
  '日期可以輸入：',
  '8/12',
  '8月12日',
  '2026/8/12',
  '2026-08-12',
  '',
  '也可以直接選擇：',
  '昨天／今天／明天',
  '',
  '👼 午餐資料以馬公高中官方公告為準。',
].join('\n');

export const ABOUT_REPLY = [
  '👼 午餐小天使',
  '',
  '我是專為澎湖馬公高中同學',
  '打造的午餐查詢小助手！',
  '',
  '只要輸入日期，',
  '就能快速查詢當天官方午餐菜單，',
  '不用再翻公告或問同學～',
  '',
  '🍱 資料來源：',
  '馬公高中官方公告',
  '',
  '📊 所有資訊以官方資料為準，',
  '小天使不亂加料！',
  '',
  '🛟 在澎湖這座小島，',
  '每天都有美味午餐等你開飯！',
  '👼 祝你每天都有好胃口！🍚',
].join('\n');

export const DATE_PROMPT_REPLY = [
  '📅 請選擇或輸入日期',
  '',
  '可以直接輸入：',
  '8/12',
  '8月12日',
  '2026/8/12',
  '2026-08-12',
  '',
  '也可以輸入：',
  '昨天／今天／明天',
  '',
  '輸入「取消」可以離開查詢模式。',
].join('\n');

export const DATE_FORMAT_ERROR_REPLY = [
  '⚠️ 日期格式不正確。',
  '',
  '請使用：',
  '8/12',
  '8月12日',
  'YYYY/MM/DD',
  'YYYY-MM-DD',
  '',
  '或輸入：',
  '昨天／今天／明天',
  '',
  '例如：',
  '8/12 或 2026/08/15',
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
    case 'about':
      return ABOUT_REPLY;
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