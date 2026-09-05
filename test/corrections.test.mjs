import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toPlainLines,
  parseCorrectionLines,
  applyCorrections,
  applyCorrectionsFromPosts,
  extractCorrectionRules,
  isCorrectionPost,
  postOverlapsDates,
} from '../src/lunch/corrections.js';
import { parseMenuPdf } from '../src/lunch/pdf.js';
import { buildEntriesFromPdf } from '../src/lunch/parse.js';
import { validateRecord } from '../src/lunch/validator.js';

// ── 真實 8/31~9/11 異動公告內容（2026-08-31 自官網 RSS 抓取）────────────────────
const ERRATA = `
8/31~9/4菜單異動如下：
8/31黑椒雞丁改為冬瓜排骨，本日主菜僅一種，沒有2選1
9/1滷骨腿改為香滷肉燥
9/2披薩為起司四重奏蜂蜜、義式肉丸起司(僅能選擇1種口味，每人一片)
※披薩餅皮是做美式薄脆口味，不是厚實鬆軟喔！！
9/2披薩、飯2擇1
9/2新增鮮肉包
9/3花生燒雞改為滷雞腿
9/4梅干雞丁改為炸雞翅
9/7糖醋排骨、滷雞腿取消，新增花生燒雞，本日主菜僅一種，沒有2選1
9/7青江菜改冬瓜
9/8小白菜改大白菜
9/9空心菜改豆芽菜
9/9炸雞翅改為梅干雞丁
9/10A菜改高麗菜
9/11莧菜改白蘿蔔
9/11香滷肉改為滷骨腿`;

// 歷史異動公告片段（6/8~6/29，格式與當期不同：更改為/更改/增加/取消/雙拼）
const JUNE_BLOCK = `6/15新增紅燒鱸魚，主菜雙拼(3選2)
6/15新增保久乳
6/26滷甜不辣改水煮蛋、咖哩鵪鶉蛋取消
6/17火腿蛋炒飯更改為香濃起司雞肉披薩(不另外供應飯)
6/8榨菜炒蛋更改蝦仁炒蛋
6/9新增紅燒鱸魚，主菜雙拼(3選2)
6/10貢丸改香酥肉排
6/4滷豆干改滷豆腐
6/5增加CAS鮪魚鬆(或CAS豬肉鬆)
6/5增加小魚干貝醬`;

// 5/29~6/5（供水異常更動；含整列菜單行與「增加」語法）
const MAY_BLOCK = `因應學校供水異常，明日起(5/29)午餐菜單更改如下(原菜單作廢)
5/29蔥爆雞丁、浦燒鰻魚、滷鵪鶉蛋、鮪魚鬆、蔥燒豆腐、季時蔬菜、醇濃燕麥
6/1咖哩排骨、咖哩雞丁(2選1)、甜不辣、滷蛋、季時蔬菜
6/2豬肉燴飯、貢丸、鮪魚鬆、季時蔬菜、加改豆奶
6/4滷豆干改滷豆腐
6/5增加CAS鮪魚鬆(或CAS豬肉鬆)
6/5增加小魚干貝醬`;

const ERRATA_HTML = `<![CDATA[<p>8/31黑椒雞丁改為冬瓜排骨，本日主菜僅一種，沒有2選1</p><p>9/1滷骨腿改為香滷肉燥</p><br/>9/7糖醋排骨、滷雞腿取消，新增花生燒雞<br/>]]>`;

// ── 對應真實 8/31~9/11 正式菜單的合成 base（精簡欄位）────────────────────────
function entry(main, overrides = {}) {
  return {
    school: '馬公高中',
    staple: '白米飯 糙米飯 (擇一)',
    main,
    side1: '',
    side2: '',
    side3: '',
    side4: '季時蔬菜',
    dessert: '',
    info: '來源：馬公高中官網公告',
    ...overrides,
  };
}

function syntheticBase() {
  return [
    { date: '2026-08-31', entry: entry('冬瓜排骨 / 黑椒雞丁 (擇一)') },
    { date: '2026-09-01', entry: entry('滷骨腿') },
    {
      date: '2026-09-02',
      entry: entry('披薩', {
        side1: '中式香腸',
        side2: '水煮蛋',
        side3: '肉鬆',
      }),
    },
    { date: '2026-09-03', entry: entry('醬汁里肌肉片 / 花生燒雞 (擇一)') },
    { date: '2026-09-04', entry: entry('洋蔥肉絲 / 梅干雞丁 (擇一)') },
    { date: '2026-09-07', entry: entry('糖醋排骨 / 滷雞腿 (擇一)') },
    { date: '2026-09-08', entry: entry('三色炒麵 / 黑椒肉片燴飯 (擇一)') },
    { date: '2026-09-09', entry: entry('炸雞翅 / 紅燒鱸魚 (擇一)') },
    { date: '2026-09-10', entry: entry('雞肉蛋炒飯 / 肉絲湯麵 (擇一)') },
    { date: '2026-09-11', entry: entry('香滷肉燥') },
  ];
}

function byDate(records, date) {
  return records.find((r) => r.date === date)?.entry;
}

function countByType(rules) {
  const counts = {};
  for (const r of rules) counts[r.type] = (counts[r.type] ?? 0) + 1;
  return counts;
}

function errataPost() {
  return { title: '行政8/31~9/11菜單異動', content: ERRATA, description: '' };
}

// ── toPlainLines：feed 的 content 是包在 CDATA 的 <p>/<br> 單行 HTML ───────────
test('toPlainLines 把 CDATA/HTML/Br 內容轉成行', () => {
  const lines = toPlainLines(ERRATA_HTML);
  assert.deepEqual(lines, [
    '8/31黑椒雞丁改為冬瓜排骨，本日主菜僅一種，沒有2選1',
    '9/1滷骨腿改為香滷肉燥',
    '9/7糖醋排骨、滷雞腿取消，新增花生燒雞',
  ]);
});

// ── 真實公告全文解析（Case B）─────────────────────────────────────────────────
test('Case B 真實 8/31~9/11 異動公告：21 條規則，全部被分類', () => {
  const rules = parseCorrectionLines(ERRATA);
  assert.equal(rules.length, 21);
  assert.deepEqual(countByType(rules), {
    replace: 11,
    cancel: 1,
    add: 2,
    'single-main': 4,
    note: 3,
  });

  const drop = rules.find((r) => r.dateRaw === '9/7' && r.type === 'cancel');
  assert.deepEqual(drop.names, ['糖醋排骨', '滷雞腿']);
  assert.ok(rules.some((r) => r.dateRaw === '9/2' && r.type === 'add' && r.name === '鮮肉包'));
  assert.ok(
    rules.some((r) => r.dateRaw === '9/1' && r.type === 'replace' && r.from === '滷骨腿' && r.to === '香滷肉燥')
  );
  // 「※」開頭行與網址不應產生規則
  assert.ok(!rules.some((r) => r.text?.includes('披薩餅皮')));
});

// ── 逐項替換（Case C）、主菜僅一種（Case E）────────────────────────────────────
test('Case C 真實異動套用至合成 base：逐項替換 → 主菜正確', () => {
  const rules = parseCorrectionLines(ERRATA);
  const { records } = applyCorrections(syntheticBase(), rules);
  assert.equal(byDate(records, '2026-08-31').main, '冬瓜排骨');
  assert.equal(byDate(records, '2026-09-01').main, '香滷肉燥');
  assert.equal(byDate(records, '2026-09-03').main, '醬汁里肌肉片 / 滷雞腿 (擇一)');
  assert.equal(byDate(records, '2026-09-04').main, '洋蔥肉絲 / 炸雞翅 (擇一)');
  assert.equal(byDate(records, '2026-09-09').main, '梅干雞丁 / 紅燒鱸魚 (擇一)');
  assert.equal(byDate(records, '2026-09-11').main, '滷骨腿');
});

test('Case E 主菜僅一種：8/31 與 9/7 收斂為單一主菜', () => {
  const rules = parseCorrectionLines(ERRATA);
  const { records } = applyCorrections(syntheticBase(), rules);
  assert.equal(byDate(records, '2026-08-31').main, '冬瓜排骨');
  assert.equal(byDate(records, '2026-09-07').main, '花生燒雞');
  assert.ok(!byDate(records, '2026-08-31').main.includes('(擇一)'));
  assert.ok(!byDate(records, '2026-09-07').main.includes('(擇一)'));
});

test('Case D 9/7 取消雙主菜並新增花生燒雞', () => {
  const rules = parseCorrectionLines(ERRATA);
  const { records } = applyCorrections(syntheticBase(), rules);
  const main = byDate(records, '2026-09-07').main;
  assert.equal(main, '花生燒雞');
  assert.ok(!main.includes('糖醋排骨'));
  assert.ok(!main.includes('滷雞腿'));
});

// ── 9/2 複合異動：只記錄備註，鮮肉包無法安全歸屬 → needsReview（Case F）────────
test('Case F 9/2 披薩口味為備註；新增鮮肉包需人工確認', () => {
  const rules = parseCorrectionLines(ERRATA);
  const { records, needsReview, notes } = applyCorrections(syntheticBase(), rules);
  // main 不應被備註改動
  assert.equal(byDate(records, '2026-09-02').main, '披薩');
  // 鮮肉包：兩個副菜欄位皆已填 → 無法決定歸屬 → needsReview
  assert.ok(
    needsReview.some(
      (n) => n.date === '2026-09-02' && n.text.includes('鮮肉包')
    )
  );
  // 披薩、飯2擇1 是資訊性備註
  assert.ok(notes.some((n) => n.date === '2026-09-02' && n.text.includes('2擇1')));
});

// ── 蔬菜替換不在正式菜單欄位內 → 如實 needsReview，不猜測 ───────────────────────
test('找不到的蔬菜替換：保留正式菜單並回報 needsReview', () => {
  const rules = parseCorrectionLines(ERRATA);
  const { records, needsReview } = applyCorrections(syntheticBase(), rules);
  assert.equal(byDate(records, '2026-09-07').side4, '季時蔬菜');
  assert.equal(byDate(records, '2026-09-08').side4, '季時蔬菜');
  for (const dish of ['青江菜', '小白菜', '空心菜', 'A菜', '莧菜']) {
    assert.ok(
      needsReview.some((n) => n.text.includes(`找不到「${dish}」`)),
      `${dish} 應列入 needsReview`
    );
  }
});

// ── idempotent / deterministic：相同 base + 相同規則 → 相同輸出 ─────────────────
test('applyCorrections 對相同輸入重複執行結果一致（idempotent）', () => {
  const rules = parseCorrectionLines(ERRATA);
  const a = applyCorrections(syntheticBase(), rules);
  const b = applyCorrections(syntheticBase(), rules);
  assert.equal(
    JSON.stringify(a.records.map((r) => r.entry)),
    JSON.stringify(b.records.map((r) => r.entry))
  );
  assert.deepEqual(a.applied, b.applied);
  assert.deepEqual(a.needsReview, b.needsReview);
});

test('重複出現的規則（同一公告內文在 feed 重複）會被去重', () => {
  const rules = extractCorrectionRules(
    [{ title: '行政6/8~6/29午餐加菜、變更公告', content: `${JUNE_BLOCK}\n${JUNE_BLOCK}\n${JUNE_BLOCK}` }],
    [{ date: '2026-06-04', entry: entry('滷豆干') }]
  );
  assert.equal(rules.length, 13);
  assert.equal(rules.filter((r) => r.type === 'replace').length, 5);
  assert.equal(rules.filter((r) => r.type === 'add').length, 5);
});

// ── 歷史公告不污染當期菜單（postOverlapsDates / extractCorrectionRules）────────
test('June 異動公告與 8/31~9/11 正式菜單無交集 → 不套用', () => {
  const junePost = {
    title: '行政6/8~6/29午餐加菜、變更公告',
    content: JUNE_BLOCK,
  };
  const septDates = syntheticBase().map((r) => r.date);
  const juneDates = ['2026-06-04', '2026-06-05', '2026-06-09'];
  assert.equal(postOverlapsDates(junePost, septDates), false);
  assert.equal(postOverlapsDates(errataPost(), septDates), true);
  assert.equal(postOverlapsDates(junePost, juneDates), true);

  const rules = extractCorrectionRules(
    [junePost, errataPost(), { title: '115學年度第1學期菜單公告', content: '這是菜單不是異動' }],
    syntheticBase()
  );
  // 只解析出 8/31~9/11 異動；June 公告與正式菜單（菜單公告）皆被排除。
  // 21 條規則中「本日主菜僅一種」「沒有2選1」同為 single-main，去重後為 19 條。
  assert.equal(rules.length, 19);
  assert.ok(!rules.some((r) => /^\d{1,2}\/6\//.test(r.dateRaw)));
});

// ── Case G 歷史公告（5/29~6/5、6/8~6/29）可延伸解析，不崩潰 ────────────────────
test('Case G 歷史 6/8~6/29：增/刪/改/雙拼語法皆可解析', () => {
  const rules = parseCorrectionLines(JUNE_BLOCK);
  assert.equal(rules.length, 13);

  const r1 = rules.find((r) => r.dateRaw === '6/4' && r.type === 'replace');
  assert.deepEqual([r1.from, r1.to], ['滷豆干', '滷豆腐']);

  // 混合句：「6/26滷甜不辣改水煮蛋、咖哩鵪鶉蛋取消」應拆成 replace + cancel
  const r2 = rules.find((r) => r.dateRaw === '6/26' && r.type === 'replace');
  assert.deepEqual([r2.from, r2.to], ['滷甜不辣', '水煮蛋']);
  const r2b = rules.find((r) => r.dateRaw === '6/26' && r.type === 'cancel');
  assert.deepEqual(r2b.names, ['咖哩鵪鶉蛋']);

  const r3 = rules.find((r) => r.dateRaw === '6/17' && r.type === 'replace');
  assert.equal(r3.from, '火腿蛋炒飯');
  assert.ok(r3.to.includes('香濃起司雞肉披薩'));

  const r4 = rules.find((r) => r.dateRaw === '6/8' && r.type === 'replace');
  assert.equal(r4.from, '榨菜炒蛋');
  assert.equal(r4.to, '蝦仁炒蛋');

  assert.ok(rules.filter((r) => r.type === 'add' && r.name === '紅燒鱸魚').length === 2);
});

test('Case G 歷史 5/29~6/5：整列菜單記為 note，「增加」可解析、不崩潰', () => {
  const rules = parseCorrectionLines(MAY_BLOCK);
  const add1 = rules.find((r) => r.type === 'add' && r.name?.includes('CAS鮪魚鬆'));
  const add2 = rules.find((r) => r.type === 'add' && r.name?.includes('小魚干貝醬'));
  assert.ok(add1, '增加CAS鮪魚鬆 → add');
  assert.ok(add2, '增加小魚干貝醬 → add');
  const fullLine = rules.find((r) => r.dateRaw === '5/29');
  assert.equal(fullLine.type, 'note'); // 整列菜單資訊性保留
});

// ── 端到端：applyCorrectionsFromPosts（真實 base + 異動公告）───────────────────
test('applyCorrectionsFromPosts 端到端：異動公告套在正式 PDF 菜單上', async () => {
  const buf = Buffer.from(
    await fetch(
      'https://www.mksh.phc.edu.tw/wp-content/uploads/sites/99/2026/08/11508310904-%E8%8F%9C%E5%96%AE%E5%85%AC%E5%91%8A.pdf',
      { headers: { 'user-agent': 'Mozilla/5.0 LunchAngelTest/1.0' } }
    ).then((r) => r.arrayBuffer())
  );
  const base = buildEntriesFromPdf(await parseMenuPdf(buf));

  const { records, report } = applyCorrectionsFromPosts(base, [errataPost()], {
    validate: validateRecord,
  });

  assert.equal(byDate(records, '2026-08-31').main, '冬瓜排骨');
  assert.equal(byDate(records, '2026-09-01').main, '香滷肉燥');
  assert.equal(byDate(records, '2026-09-03').main, '醬汁里肌肉片 / 滷雞腿 (擇一)');
  assert.equal(byDate(records, '2026-09-04').main, '洋蔥肉絲 / 炸雞翅 (擇一)');
  assert.equal(byDate(records, '2026-09-07').main, '花生燒雞');
  assert.equal(byDate(records, '2026-09-09').main, '梅干雞丁 / 紅燒鱸魚 (擇一)');
  assert.equal(byDate(records, '2026-09-11').main, '滷骨腿');
  // 未受影響的日期保持原樣
  assert.equal(byDate(records, '2026-09-08').main, '三色炒麵 / 黑椒肉片燴飯 (擇一)');
  assert.equal(byDate(records, '2026-09-10').main, '雞肉蛋炒飯 / 肉絲湯麵 (擇一)');

  assert.equal(report.applied.length, 11);
  assert.equal(report.needsReview.length, 6);
  assert.equal(report.notes.length, 3);
  assert.deepEqual(report.reverted, []);

  for (const r of records) {
    assert.ok(validateRecord(r).ok, `${r.date} 套用異動後驗證失敗：${validateRecord(r).errors}`);
  }
});

// ── 驗證失敗回退：不覆蓋正確資料 ────────────────────────────────────────────────
test('applyCorrectionsFromPosts 某日驗證失敗 → 回退正式菜單並記錄', () => {
  const { records, report } = applyCorrectionsFromPosts(syntheticBase(), [errataPost()], {
    validate: (r) => !(r.date === '2026-09-07'),
  });
  // 9/7 回退為 base 原值
  assert.equal(byDate(records, '2026-09-07').main, '糖醋排骨 / 滷雞腿 (擇一)');
  // 其他日期仍套用
  assert.equal(byDate(records, '2026-09-01').main, '香滷肉燥');
  assert.ok(report.reverted.some((r) => r.date === '2026-09-07'));
});

// ── isCorrectionPost 識別 ──────────────────────────────────────────────────────
test('isCorrectionPost 只把「異動公告」當異動', () => {
  assert.equal(isCorrectionPost(errataPost()), true);
  assert.equal(
    isCorrectionPost({ title: '行政6/8~6/29午餐加菜、變更公告', content: JUNE_BLOCK }),
    true
  );
  assert.equal(
    isCorrectionPost({ title: '115學年度第1學期菜單公告', content: '正式菜單沒有異動字眼' }),
    false
  );
});