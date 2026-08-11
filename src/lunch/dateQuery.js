import { getTodayString } from './service.js';

const PENDING_TIMEOUT_MS = Number(process.env.DATE_QUERY_TIMEOUT_MS) || 5 * 60 * 1000;
const NEXT_YEAR_WINDOW_DAYS = 30;

const pendingMap = new Map();

export const DATE_QUERY_CANCEL_WORDS = new Set(['取消', '取消查詢', '算了', '停止', '結束']);

export function isCancelText(text) {
  return DATE_QUERY_CANCEL_WORDS.has(String(text).trim());
}

function sourceKey(event) {
  const source = event?.source ?? {};
  const type = source.type ?? 'user';
  const id =
    type === 'group' ? source.groupId : type === 'room' ? source.roomId : source.userId;
  return `${type}:${id ?? 'unknown'}`;
}

function addDaysStr(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

export function resolveRelativeDate(text, today = getTodayString()) {
  const input = String(text).trim();
  if (input === '昨天') return addDaysStr(today, -1);
  if (input === '今天') return today;
  if (input === '明天') return addDaysStr(today, 1);
  return null;
}

function resolveYear(month, day, today) {
  const [ty, tm, td] = String(today).split('-').map(Number);

  if (month > tm || (month === tm && day >= td)) {
    return ty;
  }

  const nextYearDate = new Date(Date.UTC(ty + 1, month - 1, day));
  if (nextYearDate.getUTCMonth() !== month - 1 || nextYearDate.getUTCDate() !== day) {
    return null;
  }

  const todayMid = new Date(Date.UTC(ty, tm - 1, td, 12, 0, 0));
  const daysUntilNext = Math.round((nextYearDate.getTime() - todayMid.getTime()) / 86400000);
  if (daysUntilNext >= 0 && daysUntilNext <= NEXT_YEAR_WINDOW_DAYS) {
    return ty + 1;
  }

  return ty;
}

export function parseDateInputExtended(text, { today = getTodayString() } = {}) {
  const input = String(text).trim();
  if (!input) return null;

  const relative = resolveRelativeDate(input, today);
  if (relative) return relative;

  let y;
  let mo;
  let d;

  const full = input.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (full) {
    y = Number(full[1]);
    mo = Number(full[2]);
    d = Number(full[3]);
  } else {
    const slash = input.match(/^(\d{1,2})\/(\d{1,2})$/);
    const chinese = input.match(/^(\d{1,2})月(\d{1,2})日?$/);
    if (slash) {
      mo = Number(slash[1]);
      d = Number(slash[2]);
      y = resolveYear(mo, d, today);
    } else if (chinese) {
      mo = Number(chinese[1]);
      d = Number(chinese[2]);
      y = resolveYear(mo, d, today);
    } else {
      return null;
    }
    if (!y) return null;
  }

  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return t.toISOString().slice(0, 10);
}

export function setPendingDateQuery(event, { timeoutMs = PENDING_TIMEOUT_MS } = {}) {
  const key = sourceKey(event);
  pendingMap.set(key, { expiresAt: Date.now() + timeoutMs });
  return key;
}

export function clearPendingDateQuery(event) {
  pendingMap.delete(sourceKey(event));
}

export function isPendingDateQuery(event) {
  const key = sourceKey(event);
  const entry = pendingMap.get(key);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    pendingMap.delete(key);
    return false;
  }
  return true;
}

export function getPendingCount() {
  return pendingMap.size;
}

export { PENDING_TIMEOUT_MS, NEXT_YEAR_WINDOW_DAYS };