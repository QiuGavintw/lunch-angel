import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVeggieDish, isNoDessertContent, buildEntriesFromPdf } from '../src/lunch/parse.js';
import { parseMenuPdf } from '../src/lunch/pdf.js';
import { validateRecord } from '../src/lunch/validator.js';

async function parseJunePdf() {
  const buf = Buffer.from(
    await fetch(
      'https://www.mksh.phc.edu.tw/wp-content/uploads/sites/99/2026/06/115%E5%B9%B46%E6%9C%8815%E6%97%A529%E6%97%A5%E5%8D%88%E9%A4%90%E8%8F%9C%E5%96%AE-%E5%85%AC%E5%91%8A.pdf',
      { headers: { 'user-agent': 'Mozilla/5.0 LunchAngelTest/1.0' } }
    ).then((r) => r.arrayBuffer())
  );
  const pages = await parseMenuPdf(buf);
  return buildEntriesFromPdf(pages);
}

async function parseNewPdf() {
  const buf = Buffer.from(
    await fetch(
      'https://www.mksh.phc.edu.tw/wp-content/uploads/sites/99/2026/08/11508310904-%E8%8F%9C%E5%96%AE%E5%85%AC%E5%91%8A.pdf',
      { headers: { 'user-agent': 'Mozilla/5.0 LunchAngelTest/1.0' } }
    ).then((r) => r.arrayBuffer())
  );
  const pages = await parseMenuPdf(buf);
  return buildEntriesFromPdf(pages);
}

function byDate(records, date) {
  return records.find((r) => r.date === date)?.entry;
}

test('isVeggieDish 辨識蔬菜/時蔬/青菜類', () => {
  assert.equal(isVeggieDish('季時蔬菜'), true);
  assert.equal(isVeggieDish('季節時蔬'), true);
  assert.equal(isVeggieDish('時蔬'), true);
  assert.equal(isVeggieDish('青菜'), true);
  assert.equal(isVeggieDish('滷油豆腐'), false);
  assert.equal(isVeggieDish('香蕉'), false);
  assert.equal(isVeggieDish('100%果汁'), false);
});

test('isNoDessertContent 排除 無/-/空', () => {
  assert.equal(isNoDessertContent(''), true);
  assert.equal(isNoDessertContent('無'), true);
  assert.equal(isNoDessertContent('-'), true);
  assert.equal(isNoDessertContent('-----'), true);
  assert.equal(isNoDessertContent('100%果汁'), false);
});

test('2026-06-22：四道副菜正確，dessert 為空', async () => {
  const entry = byDate(await parseJunePdf(), '2026-06-22');
  assert.ok(entry, '06/22 應被解析');
  assert.equal(entry.side1, '滷油豆腐');
  assert.equal(entry.side2, '牛奶蒸蛋');
  assert.equal(entry.side3, '洋蔥炒海鮮');
  assert.equal(entry.side4, '季時蔬菜');
  assert.equal(entry.dessert, '');
});

test('2026-06-16：dessert 真的有資料（100%果汁），不可誤刪', async () => {
  const entry = byDate(await parseJunePdf(), '2026-06-16');
  assert.ok(entry, '06/16 應被解析');
  assert.equal(entry.dessert, '100%果汁');
  assert.equal(entry.side3, '季時蔬菜');
});

test('2026-06-23：dessert 保久乳保留（3 道副菜）', async () => {
  const entry = byDate(await parseJunePdf(), '2026-06-23');
  assert.ok(entry, '06/23 應被解析');
  assert.equal(entry.dessert, '保久乳');
  assert.equal(entry.side3, '季時蔬菜');
  assert.equal(entry.side4, '');
});

test('2026-06-17：無副菜、無 dessert，欄位皆空', async () => {
  const entry = byDate(await parseJunePdf(), '2026-06-17');
  assert.ok(entry, '06/17 應被解析');
  assert.equal(entry.side1, '');
  assert.equal(entry.side4, '');
  assert.equal(entry.dessert, '');
});

test('四道副菜日期 side1~side4 全部保留（06/15）', async () => {
  const entry = byDate(await parseJunePdf(), '2026-06-15');
  assert.ok(entry, '06/15 應被解析');
  assert.equal(entry.side1, '炸麥克雞塊');
  assert.equal(entry.side2, '豆干炒絞肉');
  assert.equal(entry.side3, '炒合菜');
  assert.equal(entry.side4, '季時蔬菜');
});

test('Case A 舊格式 115年6月15日~29日：解析 10 天', async () => {
  const records = await parseJunePdf();
  assert.equal(records.length, 10);
  const dates = records.map((r) => r.date).sort();
  assert.deepEqual(dates, [
    '2026-06-15',
    '2026-06-16',
    '2026-06-17',
    '2026-06-18',
    '2026-06-22',
    '2026-06-23',
    '2026-06-24',
    '2026-06-25',
    '2026-06-26',
    '2026-06-29',
  ]);
  for (const r of records) {
    assert.ok(validateRecord(r).ok, `${r.date} 驗證失敗：${validateRecord(r).errors}`);
  }
});

test('Case B 新格式 1150831~0904：解析 10 天，含 8/31~9/4', async () => {
  const records = await parseNewPdf();
  assert.equal(records.length, 10);
  const dates = records.map((r) => r.date).sort();
  assert.deepEqual(dates, [
    '2026-08-31',
    '2026-09-01',
    '2026-09-02',
    '2026-09-03',
    '2026-09-04',
    '2026-09-07',
    '2026-09-08',
    '2026-09-09',
    '2026-09-10',
    '2026-09-11',
  ]);
});

test('Case B 新格式 8/31：首欄日期被正確解析且有完整午餐資料', async () => {
  const entry = byDate(await parseNewPdf(), '2026-08-31');
  assert.ok(entry, '08/31 應被解析');
  assert.equal(entry.school, '馬公高中');
  assert.equal(entry.staple, '白米飯 糙米飯 (擇一)');
  assert.equal(entry.main, '冬瓜排骨 / 黑椒雞丁 (擇一)');
  assert.equal(entry.side1, '炸麥克雞塊');
  assert.equal(entry.side2, '豆干炒絞肉');
  assert.equal(entry.side3, '炒合菜');
  assert.equal(entry.side4, '季時蔬菜');
});

test('Case B 新格式 9/1：dessert 100%果汁 保留', async () => {
  const entry = byDate(await parseNewPdf(), '2026-09-01');
  assert.ok(entry, '09/01 應被解析');
  assert.equal(entry.main, '滷骨腿');
  assert.equal(entry.dessert, '100%果汁');
});

test('Case B 新格式：每日都通過 validateRecord', async () => {
  for (const r of await parseNewPdf()) {
    assert.ok(validateRecord(r).ok, `${r.date} 驗證失敗：${validateRecord(r).errors}`);
  }
});