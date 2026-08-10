export const REQUIRED_FIELDS = [
  'school',
  'staple',
  'main',
  'side1',
  'side2',
  'side3',
  'dessert',
];

function isValidDate(date) {
  return (
    typeof date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    !Number.isNaN(new Date(`${date}T00:00:00+08:00`).getTime())
  );
}

function isBadValue(value) {
  return (
    value === undefined ||
    value === null ||
    typeof value !== 'string' ||
    value === '[object Object]'
  );
}

function isEmptyDay(entry) {
  return (
    entry.staple === '' &&
    entry.main === '' &&
    entry.side1 === '' &&
    entry.side2 === '' &&
    entry.side3 === ''
  );
}

/**
 * 驗證一筆「每日午餐」紀錄。
 * 回傳 { ok, errors: [] }。任何一個必要欄位為
 * undefined / null / [object Object] 即失敗；
 * 空字串視為官方欄位確實無資料（例如當日無水果點心），予以保留。
 */
export function validateRecord(record) {
  const errors = [];

  if (!record || typeof record !== 'object') {
    return { ok: false, errors: ['紀錄不存在'] };
  }

  const entry = record.entry;
  if (!entry || typeof entry !== 'object') {
    return { ok: false, errors: ['entry 不存在'] };
  }

  if (!isValidDate(record.date)) {
    errors.push(`date 不合法：${record.date ?? 'undefined'}`);
  }

  if (typeof entry.school !== 'string' || entry.school !== '馬公高中') {
    errors.push(`school 不合法：${entry.school ?? 'undefined'}`);
  }

  for (const field of REQUIRED_FIELDS.slice(1)) {
    const value = entry[field];
    if (isBadValue(value)) {
      errors.push(`${field} 為 undefined / null / [object Object]`);
    }
  }

  if (isEmptyDay(entry)) {
    errors.push('整天空資料（主食/主菜/副菜皆為空）');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 驗證一份即將寫入 cache 的一或多筆紀錄。
 * 任一筆失敗即整體失敗，避免部分資料寫入。
 */
export function validateRecords(records) {
  const failures = [];
  for (const record of records) {
    const result = validateRecord(record);
    if (!result.ok) {
      failures.push({
        date: record?.date ?? '?',
        errors: result.errors,
      });
    }
  }
  return { ok: failures.length === 0, failures };
}