import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVeggieDish, isNoDessertContent, buildEntriesFromPdf } from '../src/lunch/parse.js';
import { parseMenuPdf } from '../src/lunch/pdf.js';

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