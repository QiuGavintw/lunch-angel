/**
 * 菜單「異動／校正」公告解析與套用。
 *
 * 背景：
 *   官方除了發布正式菜單 PDF（base records）之外，還可能發布「菜單異動」
 *   公告（例如「行政8/31~9/11菜單異動」），內容為一行一天、以「M/D」開頭、
 *   描述當日菜色的增／刪／替換／選擇規則。
 *
 * 設計原則：
 *   1. 校正一律「套在正式 PDF 解析出的 base records 上」，不對已寫入 cache
 *      的資料重複套用（在 sync 內於寫入前 in-memory 套用）。
 *   2. 只做「有證據」的修改；找不到對應菜色欄位時不猜測，回報 needsReview。
 *   3. idempotent：對同一份 base records 重複套用同一組規則，結果不變。
 *   4. parser 失敗／找不到可套用項目時，保留正式菜單原樣，不破壞。
 */

const REPLACE_PATTERNS = [
  /^(.+?)更改為(.+)$/,
  /^(.+?)更改(.+)$/,
  /^(.+?)改為(.+)$/,
  /^(.+?)改成(.+)$/,
  /^(.+?)改(.+)$/,
];

const CANCEL_KEYWORDS = /取消$/;
const ADD_KEYWORDS = /^(?:新增|增加)(.+)$/;
const SINGLE_MAIN_PATTERNS = [/本日主菜僅一種|主菜僅一種|沒有2選1|沒有二選一|僅一種/];

// 分隔一整個欄位中的多道菜；「/」與「、」「，」「 」（空白）都可能是分隔。
const FIELD_SEPARATOR = /[/、，,]/;

/** 去除非必要的選擇註記尾巴，例如「(擇一)」「(2選1)」「(二選一)」等。 */
function stripChoiceSuffix(token) {
  return String(token)
    .replace(/[(（][^)）]*(?:擇一|選一|2選1|二選一|一種)[^)）]*[)）]\s*$/, '')
    .trim();
}

function hasChoiceSuffix(token) {
  return /[(（][^)）]*(?:擇一|選一|2選1|二選一)[^)）]*[)）]\s*$/.test(String(token));
}

/**
 * 把單一欄位拆成「菜色 token 陣列」。
 * 保留每個 token 是否帶選擇註記，供回組時還原。
 */
export function splitFieldTokens(field) {
  const raw = String(field ?? '');
  if (!raw) return [];
  return raw
    .split(FIELD_SEPARATOR)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({
      name: stripChoiceSuffix(t),
      choice: hasChoiceSuffix(t),
    }));
}

/** 把 token 陣列回組成欄位字串（附帶選擇註記）。 */
export function joinFieldTokens(tokens) {
  const seen = [];
  for (const t of tokens) {
    const name = t.name.trim();
    if (!name) continue;
    // 重複的菜名視為重組／替換造成的贅餘，去重（例如「A / A」→「A」）
    if (seen.some((s) => s === name)) continue;
    seen.push(name);
  }
  const joined = seen.join(' / ');
  if (!joined) return '';
  const hasChoice = seen.length > 1 && tokens.some((t) => t.choice);
  return hasChoice ? `${joined} (擇一)` : joined;
}

/**
 * 把 RSS content 的 HTML／CDATA 內容轉成純文字行陣列。
 * （官方 feed 的 content 可能是 <p>…<br>… 包在 CDATA 內，沒有實體換行）
 */
export function toPlainLines(html) {
  return String(html ?? '')
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d|ul)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * 解析異動公告全文（一行一天，M/D 開頭），回傳規則陣列。
 * 每則規則：{ dateRaw:'8/31', type, ... }；無法判讀的記為 { type:'unparsed' }。
 * 不含日期開頭的行（引言、補充註記、網址等）直接忽略。
 */
export function parseCorrectionLines(text) {
  const rules = [];
  const lines = toPlainLines(text);

  for (const line of lines) {
    // 跳過「M/D~M/D」日期範圍標題（例如「8/31~9/4菜單異動如下：」）
    if (/如下|異動如下/.test(line)) continue;

    const m = line.match(/^(\d{1,2})\/(\d{1,2})\s*(.*)$/);
    if (!m) continue; // 非「M/D」開頭 → 忽略

    const dateRaw = `${m[1]}/${m[2]}`;
    const rest = (m[3] || '').trim();

    // 以「，／，」切分小句，逐句分類（一句可能含多個規則）
    const clauses = rest
      .split(/[，,]/)
      .map((c) => c.trim())
      .filter(Boolean);

    for (const clause of clauses) {
      pushClauseRule(rules, dateRaw, clause);
    }
  }

  return rules;
}

function pushClauseRule(rules, dateRaw, clause) {
  // 取消：A取消 / A、B取消（放在新增/替換之前，因「新增並取消」不會同時出現）
  if (/取消$/.test(clause)) {
    const names = clause
      .replace(/取消$/, '')
      .split(/[、]/)
      .map((s) => s.trim())
      .filter(Boolean);
    // 混合句：「X改為Y、Z取消」→ 「、」左右各是不同運算，逐段重新分類
    if (names.some((n) => /改/.test(n))) {
      for (const part of clause.split(/[、]/)) {
        const p = part.trim();
        if (p) pushClauseRule(rules, dateRaw, p);
      }
      return;
    }
    if (names.length) {
      rules.push({ dateRaw, type: 'cancel', names });
      return;
    }
  }

  // 新增 / 增加
  const addM = clause.match(ADD_KEYWORDS);
  if (addM) {
    rules.push({ dateRaw, type: 'add', name: addM[1].trim().replace(/[。!！]$/, '') });
    return;
  }

  // 替換：X改為Y / X改Y / X更改為Y / X更改Y
  for (const re of REPLACE_PATTERNS) {
    const rm = clause.match(re);
    if (rm) {
      rules.push({
        dateRaw,
        type: 'replace',
        from: rm[1].trim(),
        to: rm[2].trim(),
      });
      return;
    }
  }

  // 主菜僅一種／無2選1（單主菜）
  if (SINGLE_MAIN_PATTERNS.some((p) => p.test(clause))) {
    rules.push({ dateRaw, type: 'single-main' });
    return;
  }

  // 選擇／口味等補充說明 → 記為 note，不改欄位
  rules.push({ dateRaw, type: 'note', text: clause });
}

/** 把「M/D」依已知的日期集合解析成完整 YYYY-MM-DD。找不到則回傳 null。 */
export function resolveDate(dateRaw, availableDates) {
  const [mm, dd] = dateRaw.split('/').map(Number);
  const found = availableDates.find((d) => {
    const [y, m, day] = d.split('-').map(Number);
    return m === mm && day === dd;
  });
  return found ?? null;
}

/**
 * 在一筆 entry 的所有菜色欄位中，找出「名稱包含 dish」的欄位與 token 索引。
 * 回傳 { field, index, token } 或 null。
 */
function locateDish(entry, dish) {
  const order = ['staple', 'main', 'side1', 'side2', 'side3', 'side4', 'dessert'];
  for (const field of order) {
    const tokens = splitFieldTokens(entry[field]);
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].name && tokens[i].name.includes(dish)) {
        return { field, index: i, token: tokens[i] };
      }
    }
  }
  return null;
}

/** 深拷貝 entry，避免汙染 base records。 */
function cloneEntry(entry) {
  return { ...entry };
}

/** 更新 entry 某欄位的列表內容（依 field 位置回組）。 */
function setFieldTokens(entry, field, tokens) {
  entry[field] = joinFieldTokens(tokens);
}

/** 讓 main 欄位只剩「一種」主菜（去重、去選擇註記）。 */
function collapseMainToSingle(entry) {
  const tokens = splitFieldTokens(entry.main).filter((t) => t.name);
  const seen = [];
  for (const t of tokens) {
    if (!seen.some((s) => s.name === t.name)) seen.push(t);
  }
  if (seen.length > 1) return; // 若非皆屬同一菜色，不擅自縮減
  if (seen.length === 1) {
    entry.main = seen[0].name;
  }
}

/**
 * 套用一組規則到 base records（深度拷貝後修改）。
 *
 * 回傳：
 * {
 *   records: 修正後的 records（未套用到的日期保持原樣）,
 *   applied: [{date, field, from, to}...],
 *   needsReview: [{date, text}...],   // 有規則但無法安全判斷，未修改
 *   notes: [{date, text}...],         // 純資訊性註記，不改欄位
 *   unparsed: [{dateRaw, text}...],
 *   failed: 0
 * }
 */
export function applyCorrections(records, rules) {
  const byDate = new Map();
  for (const r of records) byDate.set(r.date, r);

  const applied = [];
  const needsReview = [];
  const notes = [];
  const unparsed = [];

  // 依日期分組規則，保留原始順序
  const grouped = new Map();
  for (const rule of rules) {
    if (rule.type === 'unparsed') {
      unparsed.push({ dateRaw: rule.dateRaw, text: rule.text });
      continue;
    }
    if (!grouped.has(rule.dateRaw)) grouped.set(rule.dateRaw, []);
    grouped.get(rule.dateRaw).push(rule);
  }

  for (const [dateRaw, dateRules] of grouped) {
    const availableDates = [...byDate.keys()];
    const date = resolveDate(dateRaw, availableDates);
    if (!date) {
      // 公告日期不在目前結果集內 → 沒東西可套，記 needsReview（不猜測）
      needsReview.push({ dateRaw, text: dateRules.map((r) => r.text ?? r.type).join(' / ') });
      continue;
    }

    const base = byDate.get(date);
    if (!base || !base.entry) {
      needsReview.push({ date, text: '日期存在但無 entry（跳過）' });
      continue;
    }

    const entry = cloneEntry(base.entry);

    for (const rule of dateRules) {
      if (rule.type === 'replace') {
        const loc = locateDish(entry, rule.from);
        if (!loc) {
          needsReview.push({ date, text: `找不到「${rule.from}」可替換（欄位中無此菜色）` });
          continue;
        }
        const tokens = splitFieldTokens(entry[loc.field]);
        tokens[loc.index] = { name: rule.to, choice: tokens[loc.index].choice };
        setFieldTokens(entry, loc.field, tokens);
        applied.push({ date, field: loc.field, from: rule.from, to: rule.to });
      } else if (rule.type === 'cancel') {
        for (const name of rule.names) {
          const loc = locateDish(entry, name);
          if (!loc) {
            needsReview.push({ date, text: `找不到「${name}」可取消` });
            continue;
          }
          const tokens = splitFieldTokens(entry[loc.field]);
          tokens.splice(loc.index, 1);
          setFieldTokens(entry, loc.field, tokens);
          applied.push({ date, field: loc.field, from: name, to: '' });
        }
      } else if (rule.type === 'add') {
        const place = placeAdd(entry);
        if (!place) {
          needsReview.push({ date, text: `無法決定「${rule.name}」的欄位歸屬（所有欄位皆有資料）` });
          continue;
        }
        const tokens = splitFieldTokens(entry[place]);
        if (tokens.some((t) => t.name === rule.name)) {
          // 已存在 → idempotent no-op
          continue;
        }
        tokens.push({ name: rule.name, choice: false });
        setFieldTokens(entry, place, tokens);
        applied.push({ date, field: place, from: '', to: rule.name });
      } else if (rule.type === 'single-main') {
        collapseMainToSingle(entry);
        applied.push({ date, field: 'main', from: '多主菜', to: '單主菜' });
      } else if (rule.type === 'note') {
        notes.push({ date, text: rule.text });
      }
    }

    // 回寫（僅在有變更的日期）
    byDate.set(date, { ...base, entry });
  }

  const resultRecords = [...byDate.values()];
  return { records: resultRecords, applied, needsReview, notes, unparsed, failed: 0 };
}

/** 決定「新增菜色」要放哪個欄位；找不到可安全放置處回傳 null。 */
function placeAdd(entry) {
  if (!splitFieldTokens(entry.main).some((t) => t.name)) return 'main';
  for (const f of ['side1', 'side2', 'side3', 'side4']) {
    if (!splitFieldTokens(entry[f]).some((t) => t.name)) return f;
  }
  return null;
}

/**
 * 判斷一方是否為「異動／更正公告」（有分離日期、且語意為增刪改）。
 * 供 sync 在 feed 中分辨正式菜單與異動公告。
 */
export function isCorrectionPost(post) {
  const title = String(post.title ?? '');
  if (!/異動|更改|更換|加菜|變更|更正/.test(title)) return false;
  const content = `${post.content ?? ''}${post.description ?? ''}`;
  // 至少要有「M/D」開頭行，且語意為增/刪/改之一
  const lines = toPlainLines(content);
  return lines.some((l) => {
    const m = l.match(/^\d{1,2}\/\d{1,2}\s*(.+)$/);
    if (!m) return false;
    return /改|新增|增加|取消|擇一|選一|雙拼|2選|1選/.test(m[1]);
  });
}

function ruleSignature(rule) {
  return JSON.stringify(
    rule.type === 'cancel'
      ? [rule.dateRaw, rule.type, rule.names]
      : [rule.dateRaw, rule.type, rule.name ?? rule.from ?? rule.text ?? '']
  );
}

/** 依日期與內容去重，排除 feed 中同一公告重複出現造成的膨脹。 */
function dedupeRules(rules) {
  const seen = new Set();
  const out = [];
  for (const rule of rules) {
    const sig = ruleSignature(rule);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(rule);
  }
  return out;
}

/**
 * 判斷公告是否與 base 菜單日期重疊（日期範圍有交集）。
 * 異動公告只在「日期落在正式菜單期間」時才有意義；
 * 例如 8/31~9/11 正式菜單 + 8/31~9/11 異動 → 套用；
 * 六月舊異動（6/8~6/29）對九月初菜單 → 無交集，不套用。
 */
export function postOverlapsDates(post, baseDates) {
  const basePairs = new Set(
    baseDates.map((d) => {
      const [, m, day] = d.split('-').map(Number);
      return `${m}/${day}`;
    })
  );
  const content = `${post.content ?? ''}${post.description ?? ''}`;
  const lines = toPlainLines(content);
  for (const line of lines) {
    const m = line.match(/^(\d{1,2})\/(\d{1,2})/);
    if (m) {
      if (basePairs.has(`${Number(m[1])}/${Number(m[2])}`)) return true;
    }
  }
  return false;
}

/**
 * 把 feed 中所有「異動公告」的內文解析成規則並套用到 baseRecords。
 *
 * 規則：
 *   - 只採用與 base 日期範圍重疊的公告（防止歷史異動污染當期菜單）。
 *   - 重複出現的規則會去重（feed 中同一公告內文可能重複很多次）。
 *   - 套用後逐日重新驗證；某天驗證失敗時，該天「回退為正式菜單原值」
 *     （不猜測、不覆蓋正確資料），並記入 reverted。
 *   - 公告日期若不在 baseRecords 日期內 → 自然落為 needsReview，不改動。
 *
 * 回傳 { records, report }，其中 report 含 applied/needsReview/notes/reverted。
 */
export function extractCorrectionRules(posts, baseRecords) {
  const rules = [];
  const baseDates = baseRecords.map((r) => r.date).filter(Boolean);
  for (const post of posts) {
    if (!postOverlapsDates(post, baseDates)) continue;
    const text = `${post.content ?? ''}\n${post.description ?? ''}`;
    try {
      rules.push(...parseCorrectionLines(text));
    } catch {
      // 單一公告解析失敗不影響整體（記錄由呼叫端負責）
    }
  }
  return dedupeRules(rules);
}

export function applyCorrectionsFromPosts(baseRecords, posts, { validate } = {}) {
  const rules = extractCorrectionRules(posts, baseRecords);
  const baseByDate = new Map(baseRecords.map((r) => [r.date, r]));
  const { records, applied, needsReview, notes, unparsed } = applyCorrections(
    baseRecords,
    rules
  );

  const reverted = [];
  const finalRecords = records.map((r) => {
    if (validate && !validate(r)) {
      const orig = baseByDate.get(r.date);
      if (orig) {
        reverted.push({ date: r.date, reason: '套用異動後驗證失敗，回退正式菜單' });
        return orig;
      }
    }
    return r;
  });

  return {
    records: finalRecords,
    report: { applied, needsReview, notes, unparsed, reverted },
  };
}
