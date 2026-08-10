import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

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

function parseDateColumns(dateLine) {
  const items = dateLine.items;
  const columns = [];
  for (let i = 0; i < items.length; i += 1) {
    const monthMatch = /^(\d{1,2})$/.exec(items[i].s);
    if (!monthMatch) continue;
    const j = i + 1;
    const slashMatch = /^\/+/.exec(items[j]?.s || '');
    if (!slashMatch) continue;
    const rest = items[j].s.slice(slashMatch[0].length);
    let dayStr = rest.match(/^\d{1,2}/)?.[0] ?? '';
    let k = j + 1;
    while (dayStr.length < 2 && /^\d{1,2}$/.test(items[k]?.s ?? '')) {
      dayStr += items[k].s;
      k += 1;
    }
    if (!dayStr.length) continue;
    columns.push({
      month: Number(monthMatch[1]),
      day: Number(dayStr),
      center: items[i].x + 8,
    });
    i = k - 1;
  }
  return columns;
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