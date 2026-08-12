import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTodayString,
  getWeekdayText,
  formatLunchMessage,
  formatEmptyDateMessage,
  INFO_REPLY,
  ABOUT_REPLY,
  DATE_PROMPT_REPLY,
} from '../src/lunch/service.js';
import {
  parseDateInputExtended,
  resolveRelativeDate,
  isCancelText,
} from '../src/lunch/dateQuery.js';
import { buildReplyText } from '../src/line/webhook.js';
import { readFile } from 'node:fs/promises';

const LUNCH = JSON.parse(await readFile(new URL('../data/lunch.json', import.meta.url), 'utf8'));

test('Asia/Taipei 日期與星期', () => {
  const today = getTodayString();
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(getWeekdayText('2026-06-22'), '星期一');
});

test('keywords：你好/今日午餐/今天午餐/午餐', async () => {
  assert.ok((await buildReplyText({ type: 'message', message: { type: 'text', text: '你好' } })).includes('午餐小天使'));
  assert.ok((await buildReplyText({ type: 'message', message: { type: 'text', text: '今日午餐' } })).includes('📅'));
  assert.ok((await buildReplyText({ type: 'message', message: { type: 'text', text: '今天午餐' } })).includes('📅'));
  assert.ok((await buildReplyText({ type: 'message', message: { type: 'text', text: '午餐' } })).includes('📅'));
});

test('postback：today/tomorrow/week/date/info/about', async () => {
  assert.ok((await buildReplyText({ type: 'postback', postback: { data: 'action=today' } })).includes('📅'));
  assert.ok((await buildReplyText({ type: 'postback', postback: { data: 'action=tomorrow' } })).includes('📅'));
  assert.ok((await buildReplyText({ type: 'postback', postback: { data: 'action=week' } })).includes('📆 本週午餐'));
  assert.equal(await buildReplyText({ type: 'postback', postback: { data: 'action=date' } }), DATE_PROMPT_REPLY);
  assert.equal(await buildReplyText({ type: 'postback', postback: { data: 'action=info' } }), INFO_REPLY);
  assert.equal(await buildReplyText({ type: 'postback', postback: { data: 'action=about' } }), ABOUT_REPLY);
});

test('date query：昨天/今天/明天/取消', async () => {
  assert.equal(resolveRelativeDate('昨天', '2026-08-12'), '2026-08-11');
  assert.equal(resolveRelativeDate('今天', '2026-08-12'), '2026-08-12');
  assert.equal(resolveRelativeDate('明天', '2026-08-12'), '2026-08-13');
  assert.equal(parseDateInputExtended('8/12', { today: '2026-08-12' }), '2026-08-12');
  assert.equal(parseDateInputExtended('8月12日', { today: '2026-08-12' }), '2026-08-12');
  assert.equal(parseDateInputExtended('2026/8/12', { today: '2026-08-12' }), '2026-08-12');
  assert.equal(parseDateInputExtended('2026-08-12', { today: '2026-08-12' }), '2026-08-12');
  assert.equal(isCancelText('取消'), true);
});

test('postback quick date 昨天 → 08/11 有資料', async () => {
  const reply = await buildReplyText({ type: 'postback', postback: { data: 'action=query&date=yesterday' } });
  assert.ok(reply.includes('📅'), '昨天查詢應回日期格式');
});

test('未知 postback → 日期格式錯誤提示（既有行為）', async () => {
  assert.ok((await buildReplyText({ type: 'postback', postback: { data: 'action=xxxx' } })).includes('日期格式'));
});

test('formatLunchMessage 對有資料日期輸出正常', () => {
  const text = formatLunchMessage('2026-08-11', LUNCH['2026-08-11']);
  assert.ok(text.includes('📅 2026/08/11'));
  assert.ok(text.includes('🍎 水果&點心：香蕉'));
});

test('formatEmptyDateMessage 維持 📭', () => {
  assert.ok(formatEmptyDateMessage('2026-06-20').includes('📭 目前沒有這一天的官方午餐資料。'));
});