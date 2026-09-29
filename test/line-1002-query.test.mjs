import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseMenuPdf } from '../src/lunch/pdf.js';
import { buildEntriesFromPdf } from '../src/lunch/parse.js';
import { validateRecord } from '../src/lunch/validator.js';

// 2026/10/02 查無資料事故：用官方 1150929~1008 公告的 PDF 走完整流程
// （PDF → parse → validation → cache），再用真正的 temp DATA_DIR 驗證
// service 與 LINE 回覆。
const MENU_PDF =
  'https://www.mksh.phc.edu.tw/wp-content/uploads/sites/99/2026/09/11509291008-%E8%8F%9C%E5%96%AE%E5%85%AC%E5%91%8A.pdf';

let tempDir;
let service;
let webhook;
let dateQuery;

before(async () => {
  const buf = Buffer.from(
    await fetch(MENU_PDF, { headers: { 'user-agent': 'Mozilla/5.0 LunchAngelTest/1.0' } }).then((r) =>
      r.arrayBuffer()
    )
  );
  const records = buildEntriesFromPdf(await parseMenuPdf(buf)).filter((r) => validateRecord(r).ok);

  const cache = {};
  for (const r of records) cache[r.date] = r.entry;

  tempDir = await mkdtemp(path.join(tmpdir(), 'lunch-angel-1002-'));
  await writeFile(path.join(tempDir, 'lunch.json'), JSON.stringify(cache, null, 2), 'utf8');

  // service.js / webhook.js 在 import 時即由 DATA_DIR 決定 cache 路徑。
  process.env.DATA_DIR = tempDir;
  service = await import('../src/lunch/service.js');
  dateQuery = await import('../src/lunch/dateQuery.js');
  webhook = await import('../src/line/webhook.js');
});

after(async () => {
  delete process.env.DATA_DIR;
  await rm(tempDir, { recursive: true, force: true });
});

function say(text) {
  return webhook.buildReplyText({ type: 'message', message: { type: 'text', text } });
}

test('service：2026-10-02 查得到完整午餐資料', async () => {
  const { date, lunch } = await service.getLunchByDate('2026-10-02');
  assert.equal(date, '2026-10-02');
  assert.ok(lunch, '10/02 必須有資料');
  assert.equal(lunch.main, '紅燒旗魚 / 洋蔥雞丁 (擇一)');
  assert.equal(lunch.side1, '滷花生');
});

test('日期輸入：10/2 解析為 2026-10-02（不需兩位數月份或日期）', () => {
  assert.equal(dateQuery.parseDateInputExtended('10/2', { today: '2026-09-30' }), '2026-10-02');
  assert.equal(dateQuery.parseDateInputExtended('10/2', { today: '2026-09-29' }), '2026-10-02');
  assert.equal(dateQuery.parseDateInputExtended('10月2日', { today: '2026-09-30' }), '2026-10-02');
});

test('LINE 輸入 10/2：顯示 2026/10/02 星期五與菜色，不是「查無資料」', async () => {
  const short = dateQuery.parseDateInputExtended('10/2', { today: service.getTodayString() });
  const text = short === '2026-10-02' ? await say('10/2') : await say('2026/10/2');

  assert.ok(text.includes('📅 2026/10/02 星期五'), '應顯示日期與星期五');
  assert.ok(text.includes('🍚 主食：白米飯 糙米飯 (擇一)'));
  assert.ok(text.includes('🍖 主菜：紅燒旗魚 / 洋蔥雞丁 (擇一)'));
  assert.ok(text.includes('🥬 副菜1：滷花生'));
  assert.ok(text.includes('🥬 副菜2：炒木須肉'));
  assert.ok(text.includes('🥬 副菜3：三色豆腐'));
  assert.ok(!text.includes('目前沒有這一天的官方午餐資料'), '不得顯示查無資料');
});

test('LINE 附近日期：09/29、09/30、10/1、10/5、10/8 都查得到', async () => {
  for (const [input, date] of [
    ['2026/9/29', '2026/09/29 星期二'],
    ['2026/9/30', '2026/09/30 星期三'],
    ['2026/10/1', '2026/10/01 星期四'],
    ['2026/10/5', '2026/10/05 星期一'],
    ['2026/10/8', '2026/10/08 星期四'],
  ]) {
    const text = await say(input);
    assert.ok(text.includes(`📅 ${date}`), `${input} 應顯示 ${date}`);
    assert.ok(!text.includes('目前沒有這一天的官方午餐資料'), `${input} 不應顯示查無資料`);
  }
});

test('LINE 週末（10/3、10/4 官方無供餐）：維持「查無資料」，不是 parser 壞掉', async () => {
  for (const input of ['2026/10/3', '2026/10/4']) {
    assert.ok((await say(input)).includes('目前沒有這一天的官方午餐資料'));
  }
});

test('LINE 空白日期 2026-10-09：官方該欄無菜色，仍是查無資料', async () => {
  const cache = JSON.parse(await readFile(path.join(tempDir, 'lunch.json'), 'utf8'));
  assert.equal(cache['2026-10-09'], undefined, '空欄不應寫入 cache');
  assert.ok((await say('2026/10/9')).includes('目前沒有這一天的官方午餐資料'));
});
