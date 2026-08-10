import { readFile } from 'node:fs/promises';
import { sync as runSync, taipeiDateStr, META_PATH } from './sync.js';

const TAIPEI_TZ = 'Asia/Taipei';
const SYNC_HOUR = 5;
const SYNC_MINUTE = 0;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 3_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

let timer = null;
let running = false;
let stopping = false;
let activePromise = null;

function log(...args) {
  console.log('[lunch]', ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 計算到「下一個 Asia/Taipei SYNC_HOUR:SYNC_MINUTE」的延遲（毫秒）。
 * 使用 Intl + Date.UTC 換算成絕對時刻，不受 Server 本機時區影響。
 */
function nextRunDelayMs() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TAIPEI_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const value = (type) => Number(parts.find((p) => p.type === type).value);

  const next5 = new Date(
    Date.UTC(value('year'), value('month') - 1, value('day'), SYNC_HOUR, SYNC_MINUTE, 0)
  );
  if (next5.getTime() <= now.getTime()) {
    next5.setUTCDate(next5.getUTCDate() + 1);
  }
  return next5.getTime() - now.getTime();
}

function scheduleNext() {
  if (stopping) return;
  const delay = nextRunDelayMs();
  if (delay > MAX_TIMER_DELAY_MS) {
    timer = setTimeout(scheduleNext, MAX_TIMER_DELAY_MS);
    timer.unref?.();
    return;
  }
  const at = new Date(Date.now() + delay).toISOString();
  log(`next scheduled sync at ${at} (in ${Math.round(delay / 1000)}s)`);
  timer = setTimeout(() => {
    timer = null;
    fire();
  }, delay);
  timer.unref?.();
}

async function fire() {
  log('scheduled sync started');
  await runSyncOnce({ force: false });
  scheduleNext();
}

/**
 * 執行一次同步，失敗時最多重試 MAX_ATTEMPTS 次（含合理 backoff）。
 * 單次失敗不會停止 scheduler —— scheduleNext() 仍會安排下一天的執行。
 */
async function runSyncOnce({ force }) {
  if (running) {
    log('sync already running, skip');
    return null;
  }
  if (stopping) {
    log('scheduler stopping, skip new sync');
    return null;
  }
  running = true;
  let result = null;
  try {
    activePromise = (async () => {
      let last = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        if (stopping) {
          log('scheduler stopping, abort retry');
          break;
        }
        log(`sync attempt ${attempt}/${MAX_ATTEMPTS}`);
        try {
          last = await runSync({ force });
        } catch (err) {
          last = { ok: false, reason: 'unexpected-error', message: err.message };
        }
        if (last.ok) break;
        if (attempt < MAX_ATTEMPTS) {
          log(`sync attempt ${attempt} failed (${last.reason}), retrying in ${BACKOFF_MS}ms`);
          await sleep(BACKOFF_MS);
        }
      }
      return last;
    })();
    result = await activePromise;
  } catch (err) {
    console.error(`[lunch] sync run error: ${err.message}`);
  } finally {
    running = false;
    activePromise = null;
  }
  if (result && result.status === 'skipped') {
    log('scheduled sync: nothing to do (skipped)');
  }
  return result;
}

/**
 * 啟動每日自動同步 scheduler。
 * - 預設 05:00 Asia/Taipei 執行（原生 Node timer + 時區計算，非固定 24h setInterval）。
 * - idempotent：重複呼叫不會重複排程。
 * - runImmediately: true → 立即觸發一次同步（測試用，不混入 production path）。
 * - 正式啟動（伺服器）不做每次強制同步，但「今天尚未成功同步」時會先跑一次非強制同步。
 */
export function startLunchScheduler(options = {}) {
  if (timer) {
    log('scheduler already running, skip duplicate schedule');
    return { alreadyRunning: true };
  }
  const { runImmediately = false } = options;
  log('starting lunch scheduler (Asia/Taipei 05:00)');
  stopping = false;
  scheduleNext();
  if (runImmediately) {
    log('runImmediately: triggering sync now');
    runSyncOnce({ force: false }).catch((err) => {
      console.error(`[lunch] scheduler immediate sync error: ${err.message}`);
    });
  } else {
    runStartupIfTodayPending().catch((err) => {
      console.error(`[lunch] startup sync check error: ${err.message}`);
    });
  }
  return { alreadyRunning: false };
}

/**
 * 第一次啟動：今天尚未成功同步 → 執行一次非強制同步（避免每次 restart 都強制抓取）。
 */
async function runStartupIfTodayPending() {
  if (stopping) return;
  let meta = {};
  try {
    meta = JSON.parse(await readFile(META_PATH, 'utf8'));
  } catch {
    // 第一次執行沒有 metadata，視為「尚未同步」。
  }
  const today = taipeiDateStr();
  if (meta.lastSuccessDate === today) {
    log(`today (${today}) already synced, skip startup sync`);
    return;
  }
  log('today not synced yet, running sync on startup');
  await runSyncOnce({ force: false });
}

/**
 * 停止 scheduler：清除 pending timer、不再開始新的 sync；
 * 回傳一個 promise，該 promise 會等正在執行的 sync 完成（確保 lock 被釋放）。
 */
export function stopLunchScheduler() {
  if (!timer && !running) {
    log('scheduler already stopped');
    return Promise.resolve();
  }
  stopping = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  log('scheduler stopped, no new sync will start');
  return activePromise ?? Promise.resolve();
}