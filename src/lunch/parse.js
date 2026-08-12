const SCHOOL = '馬公高中';
const INFO_SOURCE = '來源：馬公高中官網公告';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function kcalOf(token) {
  const m = token.s?.match(/[（(]\s*(\d{2,4})\s*[)）]$/);
  return m ? Number(m[1]) : null;
}

function clearKcal(name) {
  return name.replace(/[（(]\s*\d{2,4}\s*[)）]\s*$/, '').trim();
}

function cleanDessert(name) {
  return name
    .replace(/[（(].*[）)]$/g, '')
    .replace(/\s*\d+$/, '')
    .replace(/-+$/, '')
    .trim();
}

/**
 * 內容優先的蔬菜／青菜辨識。
 * 屬於「蔬菜/時蔬/青菜」的內容不得被誤判為 dessert，
 * 且應優先視為副菜。
 */
const VEGGIE_PATTERNS = [/蔬菜/, /時蔬/, /青菜/];
export function isVeggieDish(name) {
  return VEGGIE_PATTERNS.some((re) => re.test(String(name ?? '')));
}

/** 判斷 dessert 候選是否為「無資料」表示（無 / - / 空）。 */
export function isNoDessertContent(name) {
  const cleaned = cleanDessert(String(name ?? ''));
  return cleaned === '' || cleaned === '無' || /^-+$/.test(cleaned);
}

function pickSides(sideTokens) {
  const uniq = [...new Set(sideTokens)];
  const veggie = uniq.find((s) => isVeggieDish(s));
  const others = uniq.filter((s) => s !== veggie);
  const chosen = [];
  for (const s of others) {
    if (chosen.length === 3) break;
    chosen.push(s);
  }
  if (veggie && chosen.length < 4) chosen.push(veggie);
  return chosen;
}

function buildEntryFromColumn(column, year) {
  const tokens = column.tokens.filter((t) => t.s && !/^-+$/.test(t.s) && !t.s.includes('數量單位'));
  const dishes = tokens.map((t) => ({ s: t.s, y: t.y, kcal: kcalOf(t) }));

  // dessert 以「結構（Y 滑窗）+ 內容」判斷。
  // 只有位於過敏原線上方 50pt 內、且內容真正像點心/水果的 token 才接受；
  // 「無」「-」「空」「過敏原文字」「蔬菜/時蔬/青菜」「多行排版殘尾」一律排除。
  const dessertWindow = column.allergenY !== null ? column.allergenY + 50 : null;
  const inDessertBand = (t) =>
    dessertWindow !== null && t.y > column.allergenY && t.y <= dessertWindow;

  const dessertBandTokens = dishes.filter(
    (t) =>
      inDessertBand(t) &&
      !/全部商品含|本產品含有|過敏原|不適合/.test(t.s)
  );

  // dessert 行 = 最靠近過敏原線的那一行「水果&點心」。
  // 由下往上掃描，排除：無資料（無/-/空）、過敏原文字、
  // 蔬菜/時蔬/青菜、以及多行排版殘尾（單一字元殘尾）。
  let dessert = '';
  const closestFirst = [...dessertBandTokens].sort((a, b) => a.y - b.y);
  for (const candidate of closestFirst) {
    const raw = candidate.s.trim();
    if (isNoDessertContent(raw)) continue;
    if (isVeggieDish(raw)) continue;
    if (raw.length <= 1) continue;
    dessert = cleanDessert(raw);
    break;
  }

  const staples = dishes
    .filter((t) => /米飯/.test(t.s))
    .map((t) => clearKcal(t.s));
  const mains = dishes
    .filter((t) => t.kcal !== null && t.kcal >= 200 && !/米飯/.test(t.s))
    .map((t) => clearKcal(t.s));
  const sides = dishes
    .filter(
      (t) =>
        t.kcal !== null &&
        t.kcal < 200 &&
        !/米飯/.test(t.s) &&
        !inDessertBand(t)
    )
    .map((t) => clearKcal(t.s));

  const dateStr = `${year}-${pad2(column.date.month)}-${pad2(column.date.day)}`;
  const pickedSides = pickSides(sides);
  return {
    date: dateStr,
    entry: {
      school: SCHOOL,
      staple: staples.length ? `${[...new Set(staples)].join(' ')} (擇一)` : '',
      main: mains.length ? `${[...new Set(mains)].join(' / ')}${mains.length > 1 ? ' (擇一)' : ''}` : '',
      side1: pickedSides[0] ?? '',
      side2: pickedSides[1] ?? '',
      side3: pickedSides[2] ?? '',
      side4: pickedSides[3] ?? '',
      dessert,
      info: INFO_SOURCE,
    },
  };
}

export function buildEntriesFromPdf(pages) {
  const records = [];
  const fallbackYear = new Date().getFullYear();
  for (const page of pages) {
    const year = page.year || fallbackYear;
    for (const column of page.columns) {
      const record = buildEntryFromColumn({ ...column, allergenY: page.allergenY }, year);
      records.push(record);
    }
  }
  return records;
}

function nearestYear(month, day, refDate) {
  const baseYear = refDate.getFullYear();
  const candidates = [baseYear - 1, baseYear, baseYear + 1];
  let best = baseYear;
  let bestDelta = Infinity;
  for (const y of candidates) {
    const delta = Math.abs(new Date(y, month - 1, day) - refDate);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = y;
    }
  }
  return best;
}

export function buildEntryFromText(post) {
  const text = post.plain;
  if (!text) return null;

  const titleDate = post.title.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!titleDate) return null;

  const pubDate = new Date(post.pubDate);
  const refDate = Number.isNaN(pubDate.getTime()) ? new Date() : pubDate;
  const year = nearestYear(Number(titleDate[1]), Number(titleDate[2]), refDate);

  const mealLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.includes('、') && !l.includes('如下'));

  if (!mealLine) return null;

  const tokens = mealLine
    .split(/、|，|,/)
    .map((t) => t.trim())
    .filter((t) => t && !/如下|菜單/.test(t));

  if (!tokens.length) return null;

  const entry = {
    school: SCHOOL,
    staple: '',
    main: tokens[0],
    side1: tokens[1] ?? '',
    side2: tokens[2] ?? '',
    side3: tokens[3] ?? '',
    side4: tokens[4] ?? '',
    dessert: '',
    info: `${INFO_SOURCE}（文字公告）`,
  };

  return {
    date: `${year}-${pad2(Number(titleDate[1]))}-${pad2(Number(titleDate[2]))}`,
    entry,
  };
}