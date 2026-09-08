import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchLunchFeed, extractPdfUrls, extractPlainText } from './rss.js';
import { parseMenuPdf } from './pdf.js';
import { buildEntriesFromPdf, buildEntryFromText } from './parse.js';
import { validateRecord } from './validator.js';
import { isCorrectionPost, applyCorrectionsFromPosts } from './corrections.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(__dirname, '../../data');

/**
 * 資料目錄：
 * - 沒設定 DATA_DIR → 預設使用專案 data/（本機開發行為不變）
 * - 有設定 DATA_DIR（如 Render Persistent Disk 掛載路徑）→ 使用該路徑
 */
export const DATA_DIR =
  process.env.DATA_DIR && process.env.DATA_DIR.trim()
    ? path.resolve(process.env.DATA_DIR.trim())
    : DEFAULT_DATA_DIR;

export const LUNCH_PATH = path.join(DATA_DIR, 'lunch.json');
export const META_PATH = path.join(DATA_DIR, 'official-sync.json');
const LOCK_PATH = path.join(DATA_DIR, 'lunch-sync.lock');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 LunchAngelBot/1.0';

const OFFICIAL_HOSTS = new Set([
  'www.mksh.phc.edu.tw',
  'mksh.phc.edu.tw',
]);
const FETCH_TIMEOUT_MS = 15_000;

// 選取「近期菜單公告」的天數窗：官方發布下一期菜單時，仍在服務中的
// 當期菜單通常落在這範圍內。範圍內、帶 PDF、且尚未處理的菜單都會被
// 納入同步候選，避免只同步最新一份而漏掉當期菜單。
const RECENT_MENU_WINDOW_DAYS = 45;

// 測試用 hooks（正常執行不會觸發）
const FORCE_PDF_FAIL = process.env.LUNCHANGEL_FORCE_PDF_FAIL === '1';
const FORCE_VALIDATE_FAIL = process.env.LUNCHANGEL_FORCE_VALIDATE_FAIL === '1';
const FORCE_RSS_FAIL = process.env.LUNCHANGEL_FORCE_RSS_FAIL === '1';

function log(...args) {
  console.log('[lunch]', ...args);
}

/** 今天（Asia/Taipei）的 YYYY-MM-DD，用於判斷「今天是否已同步」。 */
export function taipeiDateStr(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function isOfficialUrl(url) {
  try {
    return OFFICIAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/**
 * 安全寫入：先寫暫存檔，成功後再 rename 成正式檔。
 * 期間任何失敗都不會破壞現有數據。
 */
async function safeWriteJson(file, data) {
  const tmp = `${file}.tmp`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(tmp, payload, 'utf8');
  await rename(tmp, file);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ---- 同步鎖 ---------------------------------------------------------------

/**
 * 檢查 lock 所有人是否仍存在。
 * - 讀取失敗 / pid 不合法 → 視為 stale（可安全移除）
 * - process.kill(pid, 0) 拋 ESRCH → 程序已不存在 → stale
 * - 其他錯誤（Windows / 權限問題）→ 無法確認，採 fail-safe：視為仍在執行，不刪 lock
 */
async function lockOwnerAlive() {
  let lock;
  try {
    lock = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
  } catch {
    return false;
  }
  const pid = lock.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    return true;
  }
}

async function writeLock() {
  const payload = JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
  await writeFile(LOCK_PATH, payload, { encoding: 'utf8', flag: 'wx' });
}

/** 回傳 'acquired' 或 'busy'。 */
async function acquireLock() {
  try {
    await writeLock();
    return 'acquired';
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  log('lock 已存在，檢查是否為 stale lock...');
  const alive = await lockOwnerAlive();
  if (alive === false) {
    log('lock owner 已不存在，移除 stale lock');
    try {
      await unlink(LOCK_PATH);
    } catch (err2) {
      if (err2.code !== 'ENOENT') throw err2;
    }
    try {
      await writeLock();
      return 'acquired';
    } catch (err3) {
      if (err3.code === 'EEXIST') {
        log('sync already running, skip');
        return 'busy';
      }
      throw err3;
    }
  }
  log('sync already running, skip');
  return 'busy';
}

async function releaseLock() {
  try {
    await unlink(LOCK_PATH);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[lunch] 無法移除 lock：${err.message}`);
    }
  }
}

// ---- 抓取與解析 -----------------------------------------------------------

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: controller.signal,
      redirect: 'follow',
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadPdf(url) {
  if (!isOfficialUrl(url)) {
    throw new Error(`非官方網域的 PDF 已拒絕：${url}`);
  }
  const res = await fetchWithTimeout(url);
  if (res.status !== 200) {
    throw new Error(`PDF 下載失敗 (HTTP ${res.status})`);
  }
  const contentType = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  if (!/^application\/pdf|^application\/octet-stream/i.test(contentType)) {
    throw new Error(`Content-Type 非 PDF：${contentType}`);
  }
  if (buf.length < 5 || buf.toString('latin1', 0, 5) !== '%PDF-') {
    throw new Error(`內容不是 PDF（前 5 bytes: ${buf.toString('latin1', 0, 5) ?? ''}）`);
  }
  return buf;
}

function menuPdfUrl(post) {
  const pdfs = extractPdfUrls(post).filter(isOfficialUrl);
  return (
    pdfs.find((url) => {
      try {
        return decodeURIComponent(url).includes('菜單');
      } catch {
        return url.includes('菜單');
      }
    }) ?? null
  );
}

class ParserUnsupportedError extends Error {
  constructor(pdfUrl) {
    super('parser 無法從 PDF 解析出任何一天資料');
    this.pdfUrl = pdfUrl;
  }
}

function reportBlocker(err, post) {
  console.error('\n===== BLOCKER FOUND =====');
  console.error(`PDF：${err.pdfUrl ?? '(內文型)'}`);
  console.error(`公告：${post.title}`);
  console.error(`問題：${err.message}`);
  console.error('目前 parser：src/lunch/pdf.js + src/lunch/parse.js');
  console.error('建議：先抓取此 PDF 檢查新版格式，再擴充 parser，勿猜測。');
  console.error('=========================\n');
}

/**
 * 處理一份公告，回傳：
 * { records, sourceUrl, pdfUrl, pdfHash, fromPdf }
 */
async function processMenuPost(post, { mode }) {
  const pdfUrl = menuPdfUrl(post);
  if (pdfUrl) {
    if (FORCE_PDF_FAIL) {
      throw new Error('(測試) FORCE_PDF_FAIL 模擬下載/解析失敗');
    }
    log(`${mode} downloading PDF...`);
    const buf = await downloadPdf(pdfUrl);
    const pdfHash = sha256(buf);
    log(`${mode} parsing PDF...`);
    const pages = await parseMenuPdf(buf);
    const records = buildEntriesFromPdf(pages);
    if (!records.length) {
      throw new ParserUnsupportedError(pdfUrl);
    }
    return { records, sourceUrl: post.link, pdfUrl, pdfHash, fromPdf: true };
  }

  const plain = extractPlainText(post.content || post.description);
  const record = buildEntryFromText({ ...post, plain });
  const records = record ? [record] : [];
  return { records, sourceUrl: post.link, pdfUrl: null, pdfHash: null, fromPdf: false };
}

/**
 * 穩定文件識別：
 * pdfUrl → sourceUrl → title + publishedAt。
 */
function documentId(post) {
  const pdfUrl = menuPdfUrl(post);
  if (pdfUrl) return `pdf:${pdfUrl}`;
  if (post.link) return `url:${post.link}`;
  return `item:${post.title}|${post.pubDate}`;
}

/**
 * 資料完整性檢查（避免整份 PDF 結構明顯異常時 partial update）。
 * 不硬編碼特定 PDF 的天數，改用「日期範圍天數 vs 實際解析天數」的覆蓋率判斷。
 * PDF 只解析出 1 天 → 視為異常（官方菜單 PDF 都是多天格式）。
 */
function integrityCheck(records) {
  const dates = [...new Set(records.map((r) => r.date).filter(Boolean))];
  if (!dates.length) {
    return { ok: false, message: 'PDF 未解析出任何日期' };
  }
  if (dates.length === 1) {
    return {
      ok: false,
      message: `資料完整性異常：PDF 僅解析出 1 天（${dates[0]}），疑似格式或 parser 問題`,
    };
  }
  const ms = dates.map((d) => new Date(`${d}T00:00:00+08:00`).getTime());
  const span = Math.round((Math.max(...ms) - Math.min(...ms)) / 86_400_000) + 1;
  const coverage = dates.length / span;
  if (span >= 4 && coverage < 0.35) {
    return {
      ok: false,
      message: `資料完整性異常：日期範圍 ${span} 天但僅解析出 ${dates.length} 天（${(coverage * 100).toFixed(1)}%）`,
    };
  }
  return { ok: true };
}

/**
 * 選取要同步的候選菜單公告。
 *
 * 只挑「最新一份」是錯的：官方會在當期尚未結束前就發布下一期菜單
 * （例：8/31~9/11 還在服務中，9/14~9/25 已上架）。若只同步最新一份，
 * 正在服務期間的菜單在「全新環境（Render ephemeral storage 清空快取、
 * 首次部署）下永遠不會進入 cache → 今日/本週/指定日期全查無資料」。
 *
 * 通用規則：
 *  - 最新一份公告一定納入（即使沒有 PDF，可能是純文字菜單）。
 *  - 再納入所有「近期發布、帶 PDF、非異動公告」的菜單文件。
 *  - merge 只覆蓋解析出的日期、其他日期保留，因此同時納入
 *    「目前菜單 + 未來菜單」只會讓 cache 更完整，不會互相覆蓋。
 */
export async function pickTargets(menuItems, meta, force) {
  const seen = new Set();
  const targets = [];

  const addCandidate = (item) => {
    if (!item || seen.has(item.guid)) return;
    seen.add(item.guid);
    if (!force && meta.processed[item.guid]) return;
    targets.push(item);
  };

  addCandidate(menuItems[0]);

  const cutoff = new Date(Date.now() - RECENT_MENU_WINDOW_DAYS * 86_400_000);
  for (const item of menuItems) {
    if (menuPdfUrl(item) === null || isCorrectionPost(item)) continue;
    const pub = new Date(item.pubDate || '').getTime();
    if (pub && pub < cutoff.getTime()) continue;
    addCandidate(item);
  }

  return targets;
}

async function recordMeta(meta) {
  try {
    await safeWriteJson(META_PATH, meta);
  } catch (err) {
    // metadata 寫失敗不回頭動 lunch.json，只記錄 warning，下次同步再修正。
    console.error(`[lunch] metadata update failed: ${err.message}`);
  }
}

async function failSync(meta, reason, extra = {}) {
  meta.lastAttemptAt = new Date().toISOString();
  meta.status = 'failed';
  meta.lastError = { reason, ...extra };
  await recordMeta(meta);
  return { ok: false, reason, ...extra };
}

/** 核心同步流程（不含 lock）。任何失敗都不會覆寫 data/lunch.json。 */
async function doSync(force) {
  const meta = await readJson(META_PATH, {
    lastSync: null,
    processed: {},
    status: null,
  });

  log('checking official source...');
  let items;
  try {
    if (FORCE_RSS_FAIL) {
      throw new Error('(測試) FORCE_RSS_FAIL 模擬 RSS 抓取失敗');
    }
    items = await fetchLunchFeed();
  } catch (err) {
    console.error(`[lunch] RSS 抓取失敗：${err.message}`);
    console.error('[lunch] 已保留現有 data/lunch.json，不做任何覆寫。');
    return failSync(meta, 'rss-fetch-failed');
  }

  if (!Array.isArray(items) || items.length === 0) {
    console.error('[lunch] RSS 格式錯誤或內容為空，找不到任何午餐公告。');
    console.error('[lunch] 已保留現有 data/lunch.json。');
    return failSync(meta, 'rss-empty');
  }

  const menuItems = items.filter((item) => item.title.includes('菜單'));
  if (!menuItems.length) {
    console.error('[lunch] 官方分類中找不到任何「午餐菜單」公告。');
    console.error('[lunch] 已保留現有 data/lunch.json。');
    return failSync(meta, 'no-menu-doc');
  }

  const lunch = await readJson(LUNCH_PATH, {});
  const targets = await pickTargets(menuItems, meta, force);

  if (!targets.length) {
    log('no new lunch document, skip');
    meta.lastAttemptAt = new Date().toISOString();
    meta.status = 'skipped';
    meta.lastError = undefined;
    delete meta.lastError;
    await recordMeta(meta);
    return { ok: true, status: 'skipped', reason: 'no-new-doc' };
  }

  log(`latest lunch document found: ${targets.map((t) => t.title).join('; ')}`);

  const parsed = [];
  const invalid = [];
  const failures = [];
  const seenIds = new Set();
  let blocker = null;

  for (const post of targets) {
    const id = documentId(post);
    process.stdout.write(`[lunch] processing「${post.title}」... `);
    try {
      if (seenIds.has(id)) {
        process.stdout.write('SKIP (same document)\n');
        continue;
      }
      seenIds.add(id);
      if (!force && meta.lastDocumentId && id === meta.lastDocumentId) {
        process.stdout.write('SKIP (document unchanged)\n');
        log('document unchanged, skip');
        continue;
      }

      const { records, sourceUrl, pdfUrl, pdfHash, fromPdf } =
        await processMenuPost(post, { mode: '  ' });

      if (fromPdf && records.length) {
        const integrity = integrityCheck(records);
        if (!integrity.ok) {
          process.stdout.write('BLOCKER\n');
          blocker = { post, message: integrity.message };
          reportBlocker({ message: integrity.message, pdfUrl }, post);
          break;
        }
      }

      for (const r of records) {
        const validation = FORCE_VALIDATE_FAIL
          ? { ok: false, errors: ['FORCE_VALIDATE_FAIL'] }
          : validateRecord(r);
        if (validation.ok) {
          parsed.push({ ...r, source: sourceUrl, pdfUrl, pdfHash, fromPdf });
        } else {
          invalid.push({ date: r.date ?? '?', errors: validation.errors });
        }
      }
      process.stdout.write(`OK (${records.length} 天)\n`);
    } catch (err) {
      process.stdout.write('FAIL\n');
      if (err instanceof ParserUnsupportedError) {
        reportBlocker(err, post);
        blocker = { post, message: err.message };
        break;
      }
      failures.push({ post, message: err.message });
    }
  }

  if (blocker) {
    console.error(`[lunch] BLOCKER：${blocker.post.title}: ${blocker.message}`);
    console.error('[lunch] 保留全部舊資料，不做 partial update。');
    return failSync(meta, 'integrity-blocker', {
      blockerTitle: blocker.post.title,
    });
  }

  if (failures.length) {
    for (const f of failures) {
      console.error(`[lunch] 失敗 - ${f.post.title}: ${f.message}`);
    }
    console.error('[lunch] 有一或多個步驟失敗，data/lunch.json 未更新。');
    return failSync(meta, 'step-failed', { failures });
  }

  if (!parsed.length) {
    for (const fail of invalid) {
      console.error(`[lunch] 驗證失敗 ${fail.date}: ${fail.errors.join('、')}`);
    }
    console.error('[lunch] validation FAILED，data/lunch.json 未更新。');
    return failSync(meta, 'validation-failed', {
      validation: { ok: false, failures: invalid },
    });
  }

  if (invalid.length) {
    for (const fail of invalid) {
      console.error(`[lunch] 驗證失敗 ${fail.date}: ${fail.errors.join('、')}（保留原 cache）`);
    }
  }

  // ---- 異動／更正公告套用（套在正式 PDF 的 base records 上） ----
  const correctionPosts = items.filter(isCorrectionPost);
  if (correctionPosts.length) {
    try {
      const corrected = applyCorrectionsFromPosts(parsed, correctionPosts, {
        validate: (r) => validateRecord(r).ok,
      });
      for (const c of corrected.report.applied) {
        console.log(`[lunch] 異動套用 ${c.date} ${c.field}: ${c.from} → ${c.to}`);
      }
      for (const nr of corrected.report.needsReview) {
        console.warn(`[lunch] 異動待確認 ${nr.date ?? nr.dateRaw}: ${nr.text}`);
      }
      for (const note of corrected.report.notes) {
        console.log(`[lunch] 異動註記 ${note.date} ${note.dateRaw ?? ''}: ${note.text}`);
      }
      for (const rv of corrected.report.reverted) {
        console.warn(`[lunch] ${rv.date} ${rv.reason}`);
      }
      corrected.records.forEach((r, i) => {
        parsed[i] = r;
      });
      log(`corrections applied (${corrected.report.applied.length} 項；待確認 ${corrected.report.needsReview.length} 項)`);
    } catch (err) {
      console.error(`[lunch] 異動公告套用失敗：${err.message}`);
      console.error('[lunch] 已保留正式菜單原值，不覆寫。');
    }
  }

  log('validation passed');
  log('merging lunch data...');

  // merge：保留既有其他日期，只覆蓋本份文件解析出的日期。
  const next = { ...lunch };
  const updatedDates = [];
  for (const r of parsed) {
    if (r.date && r.entry) {
      next[r.date] = r.entry;
      updatedDates.push(r.date);
    }
  }
  const uniqueDates = [...new Set(updatedDates)];

  log('cache updated (atomic write)...');
  await safeWriteJson(LUNCH_PATH, next);

  // lunch.json 成功後才更新 metadata；失敗不回頭刪修 lunch.json。
  const firstPdf = parsed.find((r) => r.pdfUrl);
  meta.lastAttemptAt = new Date().toISOString();
  meta.lastSuccessAt = meta.lastAttemptAt;
  meta.lastSuccessDate = taipeiDateStr();
  meta.lastSourceUrl = targets[0].link ?? '';
  meta.lastPdfUrl = firstPdf?.pdfUrl ?? null;
  meta.lastDocumentId = documentId(targets[0]);
  if (firstPdf?.pdfHash) meta.lastDocumentHash = firstPdf.pdfHash;
  meta.lastError = undefined;
  delete meta.lastError;
  meta.status = 'success';
  meta.lastSync = meta.lastAttemptAt;
  for (const post of targets) {
    const count = parsed.filter((r) => r.source === post.link).length;
    meta.processed[post.guid] = {
      title: post.title,
      link: post.link,
      count,
      at: meta.lastAttemptAt,
    };
  }
  await recordMeta(meta);

  log(`cache updated (${uniqueDates.length} 天：${uniqueDates.join(', ')})`);
  return { ok: true, status: 'success', dates: uniqueDates };
}

/**
 * 同步 entry。先取得同步鎖（重複觸發 / stale lock 保護），
 * 再執行 doSync，最後釋放鎖。
 * - 鎖被占用 → { ok:true, status:'skipped', reason:'locked' }
 */
export async function sync(options = {}) {
  const force = Boolean(options.force);
  const lockState = await acquireLock();
  if (lockState === 'busy') {
    log('sync already running, skip');
    return { ok: true, status: 'skipped', reason: 'locked' };
  }
  try {
    return await doSync(force);
  } finally {
    await releaseLock();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const force = process.argv.includes('--force');
  sync({ force })
    .then((result) => {
      if (result.ok) {
        log('sync completed');
      } else {
        log(`sync failed; reason: ${result.reason}`);
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error(`[lunch] 同步失敗：${err.message}`);
      console.error('[lunch] data/lunch.json 未更新。');
      process.exitCode = 1;
    });
}