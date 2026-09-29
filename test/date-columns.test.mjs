import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDateColumns,
  countWeekdayMarks,
  parseMenuPdf,
} from '../src/lunch/pdf.js';
import { buildEntriesFromPdf } from '../src/lunch/parse.js';
import { validateRecord } from '../src/lunch/validator.js';

// ── 官方 PDF 的日期欄（1150929~1008 公告）實際字元切法 ───────────────────────────
// 每一列的 token 皆照 pdfjs-dist getTextContent() 的原始輸出，不做任何加工。
const MENU_0929_1008_PDF =
  'https://www.mksh.phc.edu.tw/wp-content/uploads/sites/99/2026/09/11509291008-%E8%8F%9C%E5%96%AE%E5%85%AC%E5%91%8A.pdf';

let cachedBuf = null;
async function downloadMenu0929() {
  if (cachedBuf) return cachedBuf;
  const res = await fetch(MENU_0929_1008_PDF, {
    headers: { 'user-agent': 'Mozilla/5.0 LunchAngelTest/1.0' },
  });
  cachedBuf = Buffer.from(await res.arrayBuffer());
  return cachedBuf;
}

/** pdf.js 會 detach 傳入的 buffer，所以每次解析都要給一份新的複本。 */
async function parseMenu0929() {
  const buf = await downloadMenu0929();
  return parseMenuPdf(Buffer.from(buf));
}

async function menu0929Records() {
  return buildEntriesFromPdf(await parseMenu0929());
}

/** 依實際 PDF 的 x 座標順序建立日期列 token（x 由 40 起每個 token 累加）。 */
function dateLineOf(strings, step = 20) {
  let x = 40;
  return {
    items: strings.map((s) => {
      const item = { s, x, y: 516.94 };
      x += step;
      return item;
    }),
  };
}

function md(columns) {
  return columns.map((c) => `${c.month}/${c.day}`);
}

// ── token 層：涵蓋官方實際出現過的每一種切法 ────────────────────────────────────

test('日期欄切法「9/2」+「8」（月/首碼 + 末碼）→ 9/28', () => {
  const cols = parseDateColumns(dateLineOf(['日期', '9/2', '8', '(', '一', ')']));
  assert.deepEqual(md(cols), ['9/28']);
});

test('日期欄切法「9/」+「30」（月/ + 完整日碼）→ 9/30', () => {
  const cols = parseDateColumns(dateLineOf(['日期', '9/', '30', '(', '三', ')']));
  assert.deepEqual(md(cols), ['9/30']);
});

test('日期欄切法「10」+「/」+「1」→ 10/1', () => {
  const cols = parseDateColumns(dateLineOf(['日期', '10', '/', '1', '(', '四', ')']));
  assert.deepEqual(md(cols), ['10/1']);
});

test('日期欄切法「10」+「/2(」（日碼與星期左括號黏在一起）→ 10/2', () => {
  const cols = parseDateColumns(dateLineOf(['日期', '10', '/2(', '五', ')']));
  assert.deepEqual(md(cols), ['10/2'], '10/2 曾因 "/2(" 不符舊 regex 而整欄遺失');
});

test('日期欄切法「9」+「/」+「1」+「5」（日碼拆成兩個 glyph run）→ 9/15', () => {
  const cols = parseDateColumns(dateLineOf(['日期', '9', '/', '1', '5', '(', '二', ')']));
  assert.deepEqual(md(cols), ['9/15']);
});

test('日期欄切法「8」+「/」+「31」→ 8/31（回歸：先前的 8/31 修復不可退步）', () => {
  const cols = parseDateColumns(dateLineOf(['日期', '8', '/', '31', '(', '一', ')']));
  assert.deepEqual(md(cols), ['8/31']);
});

test('日期欄切法「6」+「/2」+「9」→ 6/29，不可誤判成 6/2', () => {
  const cols = parseDateColumns(dateLineOf(['日期', '6', '/2', '9', '(', '一', ')']));
  assert.deepEqual(md(cols), ['6/29']);
});

test('整列日期一覽（官方 9/28~10/2 實際 token）→ 5 欄皆解析', () => {
  const cols = parseDateColumns(
    dateLineOf([
      '日期', '9/2', '8', '(', '一', ')',
      '9/2', '9', '(', '二', ')',
      '9/', '30', '(', '三', ')',
      '10', '/', '1', '(', '四', ')',
      '10', '/2(', '五', ')',
    ])
  );
  assert.deepEqual(md(cols), ['9/28', '9/29', '9/30', '10/1', '10/2']);
});

test('整列日期一覽（官方 10/5~10/9 實際 token）→ 5 欄皆解析', () => {
  const cols = parseDateColumns(
    dateLineOf([
      '日期',
      '10', '/', '5', '(', '一', ')',
      '10', '/', '6', '(', '二', ')',
      '10', '/', '7', '(', '三', ')',
      '10', '/', '8', '(', '四', ')',
      '10', '/', '9', '(', '五', ')',
    ])
  );
  assert.deepEqual(md(cols), ['10/5', '10/6', '10/7', '10/8', '10/9']);
});

test('無法判讀的欄位不會誤抓後續欄位的數字', () => {
  const cols = parseDateColumns(
    dateLineOf(['日期', '(', '一', ')', '10', '/', '2', '(', '五', ')'])
  );
  assert.deepEqual(md(cols), ['10/2'], '沒有月碼的欄位不可從後面借數字');
});

test('月份超出範圍不產生欄位', () => {
  const cols = parseDateColumns(dateLineOf(['日期', '13', '/', '5', '(', '一', ')']));
  assert.deepEqual(md(cols), []);
});

test('非法日期（0 日、32 日）不產生欄位', () => {
  assert.deepEqual(md(parseDateColumns(dateLineOf(['日期', '10', '/', '0', '(']))), []);
  assert.deepEqual(md(parseDateColumns(dateLineOf(['日期', '10', '/', '32', '(']))), []);
});

// ── 完整性防護：星期欄位數 > 解析出的日期欄數 → 同步必須失敗而非寫入不完整 cache ──

test('官方每一列的星期標記數都等於解析出的日期欄數（否則同步會擋下）', () => {
  const realLines = [
    ['日期', '9/2', '8', '(', '一', ')', '9/2', '9', '(', '二', ')', '9/', '30', '(', '三', ')',
      '10', '/', '1', '(', '四', ')', '10', '/2(', '五', ')'],
    ['日期', '10', '/', '5', '(', '一', ')', '10', '/', '6', '(', '二', ')', '10', '/', '7',
      '(', '三', ')', '10', '/', '8', '(', '四', ')', '10', '/', '9', '(', '五', ')'],
    ['日期', '8', '/', '31', '(', '一', ')', '9', '/', '1', '(', '二', ')', '9', '/', '2',
      '(', '三', ')', '9', '/', '3', '(', '四', ')', '9', '/', '4', '(', '五', ')'],
    ['日期', '6', '/', '15', '(', '一', ')', '6', '/', '16', '(', '二', ')', '6', '/', '17',
      '(', '三', ')', '6', '/', '18', '(', '四', ')', '6', '/2', '9', '(', '一', ')'],
  ];
  for (const line of realLines) {
    const items = dateLineOf(line).items;
    assert.equal(
      countWeekdayMarks(items),
      parseDateColumns({ items }).length,
      `token：${line.join('|')}`
    );
  }
});

test('少一欄時星期標記數 > 日期欄數（同步會記錄原因並保留舊 cache）', () => {
  const items = dateLineOf([
    '日期', '9/', '29', '(', '二', ')', '10', '/2(', '五', ')',
  ]).items;
  assert.equal(countWeekdayMarks(items), 2);
  assert.equal(parseDateColumns({ items }).length, 2);
  const broken = dateLineOf(['日期', '9/', '29', '(', '二', ')', '10', '?', '(', '五', ')']).items;
  assert.ok(
    countWeekdayMarks(broken) > parseDateColumns({ items: broken }).length,
    '有星期標記卻讀不到日碼 → 該欄會整欄遺失，必須被擋下而不是寫入 cache'
  );
});

// ── PDF 層：官方 1150929~1008 公告 ───────────────────────────────────────────────

test('官方 0929~1008 PDF：2026-10-02 record 存在且有完整菜色', async () => {
  const entry = (await menu0929Records()).find((r) => r.date === '2026-10-02')?.entry;
  assert.ok(entry, '10/02 必須被解析出來');
  assert.equal(entry.school, '馬公高中');
  assert.equal(entry.staple, '白米飯 糙米飯 (擇一)');
  assert.equal(entry.main, '紅燒旗魚 / 洋蔥雞丁 (擇一)');
  assert.equal(entry.side1, '滷花生');
  assert.equal(entry.side2, '炒木須肉');
  assert.equal(entry.side3, '三色豆腐');
  assert.equal(entry.side4, '季時蔬菜');
  assert.ok(validateRecord({ date: '2026-10-02', entry }).ok, '10/02 必須通過驗證');
});

test('官方 0929~1008 PDF：09/29~10/09 每一天都有對應日期欄', async () => {
  const dates = (await menu0929Records()).map((r) => r.date);
  assert.deepEqual(dates, [
    '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02',
    '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09',
  ]);
});

test('官方 0929~1008 PDF：09/29~10/08 的供餐日皆通過驗證（週末本來就沒有資料）', async () => {
  const records = await menu0929Records();
  const served = records.filter((r) => !['2026-09-28', '2026-10-09'].includes(r.date));
  assert.deepEqual(
    served.map((r) => r.date),
    ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05',
      '2026-10-06', '2026-10-07', '2026-10-08']
  );
  for (const r of served) {
    assert.ok(validateRecord(r).ok, `${r.date} 驗證失敗：${validateRecord(r).errors}`);
  }
});

test('官方 0929~1008 PDF：兩頁日期欄各 5 欄（原本第二頁缺 10/2）', async () => {
  const pages = await parseMenu0929();
  const menuPages = pages.filter((p) => p.columns.length);
  assert.equal(menuPages.length, 2);
  assert.deepEqual(menuPages[0].columns.map((c) => `${c.date.month}/${c.date.day}`),
    ['9/28', '9/29', '9/30', '10/1', '10/2']);
  assert.deepEqual(menuPages[1].columns.map((c) => `${c.date.month}/${c.date.day}`),
    ['10/5', '10/6', '10/7', '10/8', '10/9']);
});
