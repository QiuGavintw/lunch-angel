import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickTargets } from '../src/lunch/sync.js';

// 與官方格式一致的 PDF 連結（mksh.phc.edu.tw、檔名含「菜單」）
const PDF = (file) =>
  `https://www.mksh.phc.edu.tw/wp-content/uploads/sites/99/2026/${file}`;
const A_PDF = PDF('08/11508310904-%E8%8F%9C%E5%96%AE%E5%85%AC%E5%91%8A.pdf');
const B_PDF = PDF('09/11509140925-%E8%8F%9C%E5%96%AE%E5%85%AC%E5%91%8A.pdf');
const OLD_PDF = PDF('06/115%E5%B9%B46%E6%9C%8815%E6%97%A529%E6%97%A5%E5%8D%88%E9%A4%90%E8%8F%9C%E5%96%AE-%E5%85%AC%E5%91%8A.pdf');

function daysAgo(n, hours = 12) {
  const d = new Date(Date.now() - n * 86_400_000);
  d.setUTCHours(hours, 0, 0, 0);
  return d.toUTCString();
}

function menuItem({ guid, title, pdfUrl = null, pubDate, nDaysAgo = null, plain = false }) {
  return {
    guid,
    title,
    link: `https://www.mksh.phc.edu.tw/?p=${guid}`,
    pubDate: pubDate ?? daysAgo(nDaysAgo),
    description: plain
      ? '<p>內文</p>'
      : `<p><a href="${pdfUrl}">菜單PDF</a></p>`,
    content: '',
  };
}

function corrItem({ guid, title, pubDate, lines }) {
  return {
    guid,
    title,
    link: `https://www.mksh.phc.edu.tw/?p=${guid}`,
    pubDate,
    description: `<p>${lines.join('<br/>')}</p>`,
    content: '',
  };
}

const B = menuItem({
  guid: 'b-future',
  title: '行政 1150914~0925-菜單公告',
  pdfUrl: B_PDF,
  nDaysAgo: 2,
});
const CORR = corrItem({
  guid: 'corr-a',
  title: '行政 8/31~9/11菜單異動',
  pubDate: daysAgo(3),
  lines: ['9/7糖醋排骨、滷雞腿取消，新增花生燒雞'],
});
const A = menuItem({
  guid: 'a-current',
  title: '行政 1150831~0904菜單',
  pdfUrl: A_PDF,
  nDaysAgo: 20,
});
const OLD = menuItem({
  guid: 'a-old',
  title: '行政 115年6月15日29日午餐菜單-公告',
  pdfUrl: OLD_PDF,
  nDaysAgo: 60,
});

// 官方 feed 順序（最新→最舊）：未來菜單、異動公告、當期菜單、舊菜單
const FEED = [B, CORR, A, OLD];

test('pickTargets：同時選取「當期菜單 + 未來菜單」兩份 PDF', async () => {
  const targets = await pickTargets(FEED, { processed: {} }, false);
  const guids = targets.map((t) => t.guid);
  assert.ok(guids.includes(B.guid), '未來菜單（最新一份）應被選取');
  assert.ok(guids.includes(A.guid), '當期菜單（可涵蓋今天）應被選取');
});

test('pickTargets：排除異動更正公告與超過窗口的舊菜單', async () => {
  const targets = await pickTargets(FEED, { processed: {} }, false);
  const guids = targets.map((t) => t.guid);
  assert.ok(!guids.includes(CORR.guid), '異動公告不得當成菜單文件');
  assert.ok(!guids.includes(OLD.guid), '超過 RECENT_MENU_WINDOW_DAYS 的舊菜單不應被選取');
});

test('pickTargets：meta.processed 過濾後，當期菜單仍有機會被同步', async () => {
  // 情境：未來菜單已同步過（meta.processed），當期菜單尚未同步。
  const targets = await pickTargets(FEED, { processed: { [B.guid]: {} } }, false);
  const guids = targets.map((t) => t.guid);
  assert.ok(!guids.includes(B.guid), '已處理的未來菜單不重複下載');
  assert.ok(guids.includes(A.guid), '未處理的當期菜單仍要被選取');
});

test('pickTargets：force 時無視 meta.processed', async () => {
  const targets = await pickTargets(FEED, { processed: { [B.guid]: {} } }, true);
  const guids = targets.map((t) => t.guid);
  assert.ok(guids.includes(B.guid), 'force 應重新處理已處理過的未來菜單');
  assert.ok(guids.includes(A.guid));
});

test('pickTargets：最新公告即使無 PDF（純文字）也納入候選', async () => {
  const TEXT = menuItem({ guid: 'text-news', title: '行政 1150914~0925-菜單公告', nDaysAgo: 1, plain: true });
  const targets = await pickTargets([TEXT, A], { processed: {} }, false);
  const guids = targets.map((t) => t.guid);
  assert.ok(guids.includes(TEXT.guid), '最新一份公告必須納入（含純文字）');
  assert.ok(guids.includes(A.guid), '近期的 PDF 菜單仍應納入');
});