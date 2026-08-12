import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatLunchMessage,
  formatWeekMessage,
  safeDish,
  getThisWeekDates,
  getWeekdayText,
  isWeekendDate,
} from '../src/lunch/service.js';
import { readFile } from 'node:fs/promises';

const LUNCH = JSON.parse(await readFile(new URL('../data/lunch.json', import.meta.url), 'utf8'));

test('safeDish：undefined/null/empty/無/- 全部轉為 -', () => {
  assert.equal(safeDish(undefined), '-');
  assert.equal(safeDish(null), '-');
  assert.equal(safeDish(''), '-');
  assert.equal(safeDish('無'), '-');
  assert.equal(safeDish('-----'), '-');
  assert.equal(safeDish('滷油豆腐'), '滷油豆腐');
});

test('2026-06-22 輸出：副菜4 + 點心空值 -，絕不出現 水果&點心：菜', () => {
  const text = formatLunchMessage('2026-06-22', LUNCH['2026-06-22']);
  assert.ok(text.includes('🥬 副菜4：季時蔬菜'), '副菜4 應為季時蔬菜');
  assert.ok(text.includes('🍎 水果&點心：-'), '水果&點心 應為 -');
  assert.ok(!text.includes('水果&點心：菜'), '不得出現 水果&點心：菜');
  assert.ok(text.includes('🥬 副菜1：滷油豆腐'));
  assert.ok(text.includes('🥬 副菜2：牛奶蒸蛋'));
  assert.ok(text.includes('🥬 副菜3：洋蔥炒海鮮'));
});

test('06/16 dessert 真的有資料，不得被 - 覆蓋', () => {
  const text = formatLunchMessage('2026-06-16', LUNCH['2026-06-16']);
  assert.ok(text.includes('🍎 水果&點心：100%果汁'), 'dessert 不得變 -');
});

test('06/11（08/11）dessert 香蕉保留', () => {
  const text = formatLunchMessage('2026-08-11', LUNCH['2026-08-11']);
  assert.ok(text.includes('🍎 水果&點心：香蕉'));
});

test('3 道副菜舊資料：side4 顯示 -', () => {
  const three = {
    school: '馬公高中',
    staple: '白米飯',
    main: '滷骨腿',
    side1: '紅蘿蔔炒蛋',
    side2: '匏瓜炒肉絲',
    side3: '季時蔬菜',
    dessert: '100%果汁',
    info: '來源：馬公高中官網公告',
  };
  const text = formatLunchMessage('2026-06-16', three);
  assert.ok(text.includes('🥬 副菜4：-'), '無 side4 舊資料應顯示 -');
  assert.ok(text.includes('🍎 水果&點心：100%果汁'));
});

test('完全沒有 side4 欄位的舊紀錄不得 crash，顯示 -', () => {
  const old = {
    school: '馬公高中',
    staple: '',
    main: '肉絲蛋炒飯',
    side1: '炸甜不辣',
    side2: '茶葉蛋',
    side3: '炒青菜',
    dessert: '',
    info: '來源：馬公高中官網公告（文字公告）',
  };
  const text = formatLunchMessage('2026-08-10', old);
  assert.ok(text.includes('🥬 副菜4：-'));
  assert.ok(!/undefined|null|\[object Object\]/.test(text));
});

test('空值輸出不得包含 undefined/null/[object Object]', () => {
  const text = formatLunchMessage('2026-06-17', {
    school: '馬公高中',
    staple: '',
    main: '火腿蛋炒飯',
    side1: null,
    side2: undefined,
    side3: '',
    dessert: '-----',
    info: '',
  });
  assert.ok(!/undefined|null|\[object Object\]/.test(text));
  assert.ok(text.includes('🥬 副菜1：-'));
  assert.ok(text.includes('🥬 副菜2：-'));
  assert.ok(text.includes('🥬 副菜4：-'));
  assert.ok(text.includes('🍎 水果&點心：-'));
});

test('完全無資料：維持 📭 專用訊息', () => {
  const text = formatLunchMessage('2026-06-20', null);
  assert.ok(text.includes('📭 目前沒有這一天的官方午餐資料。'));
});

test('formatWeekMessage 支援 side4 且用 safeDish', () => {
  const weekDates = getThisWeekDates();
  const entries = weekDates
    .filter((d) => LUNCH[d])
    .map((d) => ({ date: d, lunch: LUNCH[d] }));
  const text = formatWeekMessage(entries, weekDates);
  assert.ok(text.includes('📆 本週午餐'));
  assert.ok(!/undefined|null|\[object Object\]/.test(text));
});

test('週末（無特殊供餐）不顯示', () => {
  const weekDates = getThisWeekDates();
  const weekend = weekDates.find((d) => isWeekendDate(d));
  const text = formatWeekMessage([], [...weekDates.filter((d) => !isWeekendDate(d)), weekend]);
  assert.ok(!text.includes(getWeekdayText(weekend).replace('星期', '星期')), '無資料週末不應顯示');
});

test('週末（有特殊供餐）正常顯示', () => {
  const weekend = getThisWeekDates().find((d) => isWeekendDate(d));
  const special = {
    school: '馬公高中',
    staple: '白米飯',
    main: '補課便當',
    side1: '',
    side2: '',
    side3: '',
    side4: '',
    dessert: '',
    info: '學校補課供餐',
  };
  const text = formatWeekMessage([{ date: weekend, lunch: special }], [weekend]);
  assert.ok(text.includes(getWeekdayText(weekend)), '有補課供餐的週末應顯示');
});