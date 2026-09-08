import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ── 情境：cache 同時包含 當期菜單 A（8/31~9/11）與 未來菜單 B（9/14~9/25）─────
// A 涵蓋工作日：8/31~9/4、9/14…（此檔刻意把 B 的 9/14 以後日期也放進來，
// 驗證「未來菜單存在時不會覆蓋/擠掉當期菜單」的合併行為）。
const WEEK_A = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
  '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];
const WEEK_B = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18',
  '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'];

function entry(main) {
  return {
    school: '馬公高中',
    staple: '白米飯 糙米飯 (擇一)',
    main,
    side1: '測試副菜1',
    side2: '測試副菜2',
    side3: '測試副菜3',
    side4: '季時蔬菜',
    dessert: '',
    info: '來源：馬公高中官網公告',
  };
}

function buildCache() {
  const cache = {};
  for (const d of WEEK_A) cache[d] = entry(`A-主菜-${d}`);
  for (const d of WEEK_B) cache[d] = entry(`B-主菜-${d}`);
  return cache;
}

let tempDir;
let service;

before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'lunch-angel-overlap-'));
  await writeFile(path.join(tempDir, 'lunch.json'), JSON.stringify(buildCache(), null, 2), 'utf8');
  // service.js 在 import 時即由 DATA_DIR 決定 cache 路徑，故先設環境變數再動態 import。
  process.env.DATA_DIR = tempDir;
  service = await import(new URL('../src/lunch/service.js', import.meta.url));
});

after(async () => {
  delete process.env.DATA_DIR;
  await rm(tempDir, { recursive: true, force: true });
});

test('今日 2026-09-08：當期菜單 A 存在，不因 B 存在而不見', async () => {
  const { date, lunch } = await service.getLunchByDate('2026-09-08');
  assert.equal(date, '2026-09-08');
  assert.ok(lunch, '09/08 應存在（當期菜單）');
  assert.equal(lunch.main, 'A-主菜-2026-09-08');
});

test('明日 2026-09-09：當期菜單 A 存在', async () => {
  const { lunch } = await service.getLunchByDate('2026-09-09');
  assert.ok(lunch, '09/09 應存在');
});

test('指定日期 2026-09-08：查得到當期菜單', async () => {
  const { lunch } = await service.getLunchByDate('2026-09-08');
  assert.ok(lunch, '指定日期查詢 09/08 必須命中');
});

test('本週（09/07~09/13，today=2026-09-08）：回傳 09/07~09/11 五天', async () => {
  const weekDates = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10',
    '2026-09-11', '2026-09-12', '2026-09-13'];
  const entries = await service.getWeekLunch(weekDates);
  const dates = entries.map((e) => e.date);
  assert.deepEqual(dates, ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']);

  const text = service.formatWeekMessage(entries, weekDates);
  assert.ok(text.includes('📅 09/07'), '週一 09/07 應顯示');
  assert.ok(text.includes('📅 09/08'), '今日 09/08 應顯示');
  assert.ok(text.includes('📅 09/09'));
  assert.ok(text.includes('📅 09/10'));
  assert.ok(text.includes('📅 09/11'));
  assert.ok(!text.includes('尚無官方資料'), '五個工作日都應有資料');
});

test('跨菜單：today=2026/09/13 仍屬當期 A 的週，不誤用未來 B', async () => {
  const weekDates = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10',
    '2026-09-11', '2026-09-12', '2026-09-13'];
  const entries = await service.getWeekLunch(weekDates);
  assert.deepEqual(
    entries.map((e) => e.date),
    ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'],
    '9/13 仍是 A 週尾聲，應回傳 A 的 09/07~09/11'
  );
  assert.equal(entries[0].lunch.main, 'A-主菜-2026-09-07');
});

test('跨菜單：today=2026/09/14 起開始使用 B', async () => {
  const weekDates = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17',
    '2026-09-18', '2026-09-19', '2026-09-20'];
  const entries = await service.getWeekLunch(weekDates);
  const dates = entries.map((e) => e.date);
  assert.deepEqual(dates, ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']);
  assert.equal(entries[0].lunch.main, 'B-主菜-2026-09-14', '9/14 應使用 B 菜單');
});

test('B 的 9/14 存在且 A 的當期日期不受影響（相依性：可同時查詢）', async () => {
  const a = await service.getLunchByDate('2026-09-08');
  const b = await service.getLunchByDate('2026-09-14');
  assert.equal(a.lunch.main, 'A-主菜-2026-09-08');
  assert.equal(b.lunch.main, 'B-主菜-2026-09-14');
});