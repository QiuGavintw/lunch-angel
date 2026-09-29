const LINE_Y_EPSILON = 2.2;
const COL_TOLLERANCE = 55;
const MERGE_GAP = 70;

function toUint8(buf) {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function clusterLines(items) {
  const lines = [];
  let current = [];
  for (const it of items) {
    const last = current[current.length - 1];
    if (last && Math.abs(last.y - it.y) > LINE_Y_EPSILON) {
      lines.push(current);
      current = [];
    }
    current.push(it);
  }
  if (current.length) lines.push(current);
  return lines.map((line) => ({
    y: line[0].y,
    text: line
      .map((i) => i.s)
      .join('')
      .trim(),
    items: line,
  }));
}

function findDateLine(lines) {
  return lines.find((line) => /^\s*日期\s*\d|^\s*\d{1,2}\s*\/\s*\d{1,2}/.test(line.text));
}

function findAllergenY(lines, dateY) {
  const found = lines.filter(
    (line) => line.y < dateY && /過敏原|不適合/.test(line.text)
  );
  return found.length ? Math.min(...found.map((l) => l.y)) : null;
}

function extractAdYear(lines, dateY) {
  for (const line of lines) {
    if (line.y <= dateY) continue;
    const m = line.text.match(/(\d{1,3})\s*年/);
    if (m) {
      const n = Number(m[1]);
      return n < 1000 ? n + 1911 : n;
    }
  }
  return null;
}

// 月與斜線在同一個 token：「9/」「9/2」「10/2(」「9/29(一)」
const MONTH_SLASH_TOKEN = /^\s*(\d{1,2})\s*[/／]/;
// 純月份 token：「8」「9」「10」
const MONTH_ONLY_TOKEN = /^\s*(\d{1,2})\s*$/;
// 以斜線開頭的續段 token：「/」「/15」「/2(」
const SLASH_LEADING_TOKEN = /^\s*\/+\s*/;

/**
 * 取出 token 開頭的日期數字。
 *
 * 官方 PDF 的星期標記可能被併進同一個 token（實測「10/2(五)」會被拆成
 * 「10」「/2(」「五」「)」，其中日碼與左括號黏在同一個 token），
 * 因此允許數字後面接著星期括號；其他內容（例如「2選1」）一律不視為日期。
 */
function leadingDateDigits(token) {
  const str = String(token ?? '');
  const m = /^\s*(\d{1,2})/.exec(str);
  if (!m) return '';
  const rest = str.slice(m[0].length);
  if (rest !== '' && !/^\s*[（(]/.test(rest)) return '';
  return m[1];
}

/**
 * 解析「日期」那一列，回傳每個日期欄的 { month, day, center }。
 *
 * 官方日期欄的字元切法每份 PDF 都不同，實測觀察到：
 *   「9/2」+「8」        （月/首碼 + 末碼）
 *   「9/」+「30」       （月/ + 完整日碼）
 *   「10」+「/」+「1」  （月 + / + 日碼）
 *   「9」+「/」+「1」+「5」（月 + / + 日碼拆成兩個 glyph run）
 *   「10」+「/2(」      （月 + 日碼與星期左括號黏在一起，10/2 曾因此整欄遺失）
 * 因此改以「取出 token 開頭的日碼」統一處理，而不是比對整個 token 的形狀。
 */
export function parseDateColumns(dateLine) {
  const items = dateLine.items;
  const columns = [];
  for (let i = 0; i < items.length; i += 1) {
    const s = items[i].s;
    let month = null;
    let dayStr = '';
    let nextIdx = i + 1;

    const withSlash = MONTH_SLASH_TOKEN.exec(s);
    if (withSlash) {
      // 完整「9/2」「9/」之類：月與斜線在同一個 token
      month = Number(withSlash[1]);
      dayStr = leadingDateDigits(s.slice(withSlash[0].length));
    } else {
      // 純月份「8」「9」「10」，下一個 token 必須以斜線開頭
      const monthMatch = MONTH_ONLY_TOKEN.exec(s);
      if (!monthMatch) continue;
      const slashToken = String(items[nextIdx]?.s ?? '');
      const slash = SLASH_LEADING_TOKEN.exec(slashToken);
      if (!slash) continue;
      month = Number(monthMatch[1]);
      dayStr = leadingDateDigits(slashToken.slice(slash[0].length));
      nextIdx += 1;
    }
    if (month < 1 || month > 12) continue;

    // 從後續 token 補齊不足的 day 位數（「9」+「/」+「1」+「5」→ 9/15）
    let k = nextIdx;
    while (dayStr.length < 2) {
      const digits = leadingDateDigits(items[k]?.s);
      if (!digits) break;
      dayStr += digits;
      k += 1;
    }
    if (!dayStr.length) continue;
    const day = Number(dayStr);
    if (day < 1 || day > 31) continue;
    columns.push({ month, day, center: items[i].x + 8 });
    i = k - 1;
  }
  return columns;
}

/** 官方日期欄每一欄都帶一個星期括號，例如「10/2(五)」。 */
export function countWeekdayMarks(items) {
  let count = 0;
  for (const it of items) {
    count += (String(it.s).match(/[（(]/g) ?? []).length;
  }
  return count;
}

/**
 * 日期欄少於星期標記數 → 有整欄沒被辨識出來。
 * 該欄的日期與菜色都會遺失，若靜默寫入 cache 就會出現「官方有、系統查不到」。
 * 因此寧可讓本次同步失敗（保留舊 cache 並記錄原因），也不寫入不完整資料。
 */
export class DateColumnMismatchError extends Error {
  constructor(details) {
    super(
      `日期欄解析不完整：偵測到 ${details.marks} 個星期欄位，只解析出 ${details.columns} 個日期欄（${details.found.join(', ') || '無'}）`
    );
    this.name = 'DateColumnMismatchError';
    this.marks = details.marks;
    this.columnCount = details.columns;
    this.found = details.found;
  }
}

function assertDateColumnsComplete(items, columns) {
  const marks = countWeekdayMarks(items);
  if (marks <= columns.length) return;
  throw new DateColumnMismatchError({
    marks,
    columns: columns.length,
    found: columns.map((c) => `${c.month}/${c.day}`),
  });
}

function assignColumn(it, centers) {
  if (it.x < 70) return -1;
  let best = -1;
  let bestDelta = Infinity;
  for (let c = 0; c < centers.length; c += 1) {
    const delta = Math.abs(it.x - centers[c]);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = c;
    }
  }
  return bestDelta <= COL_TOLLERANCE ? best : -1;
}

function buildColumnTokens(lines, dateY, centers) {
  const tokens = centers.map(() => []);
  for (const line of lines) {
    if (line.y >= dateY) continue;
    const seq = [];
    for (const it of line.items) {
      const col = assignColumn(it, centers);
      if (col < 0) continue;
      seq.push({ col, x: it.x, s: it.s });
    }
    for (let c = 0; c < centers.length; c += 1) {
      const row = seq.filter((it) => it.col === c);
      let start = null;
      for (const it of row) {
        if (start === null) {
          start = { x: it.x, text: it.s };
        } else if (it.x - start.x < MERGE_GAP) {
          start.text += it.s;
          start.x = it.x;
        } else {
          tokens[c].push({ s: start.text, y: line.y });
          start = { x: it.x, text: it.s };
        }
      }
      if (start !== null) {
        tokens[c].push({ s: start.text, y: line.y });
      }
    }
  }
  return tokens;
}

export async function parseMenuPdf(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: toUint8(buffer) }).promise;
  const pages = [];
  try {
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const items = [];
      for (const it of tc.items) {
        const s = typeof it.str === 'string' ? it.str : '';
        if (!s.trim()) continue;
        const t = it.transform;
        items.push({ s, x: t[4], y: t[5], w: it.width || 0 });
      }
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      const lines = clusterLines(items);
      const dateLine = findDateLine(lines);
      if (!dateLine) continue;
      const columns = parseDateColumns(dateLine);
      if (!columns.length) continue;
      assertDateColumnsComplete(dateLine.items, columns);
      const year = extractAdYear(lines, dateLine.y);
      const allergenY = findAllergenY(lines, dateLine.y);
      const centers = columns.map((c) => c.center);
      const tokens = buildColumnTokens(lines, dateLine.y, centers);
      pages.push({
        year,
        allergenY,
        columns: columns.map((c, i) => ({
          date: c,
          tokens: tokens[i],
        })),
      });
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}