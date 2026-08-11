import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineBotClient } from '@line/bot-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RICH_MENU_IMAGE_PATH = path.resolve(__dirname, '../../assets/rich-menu.png');
const RICH_MENU_METADATA_PATH = path.resolve(__dirname, '../../data/rich-menu.json');

const RICH_MENU_NAME = 'lunch-angel-main';
const RICH_MENU_CHAT_BAR_TEXT = '🍱 午餐小天使';
const RICH_MENU_WIDTH = 2500;
const RICH_MENU_HEIGHT = 1686;

const RICH_MENU_AREAS = [
  { label: '今日午餐', action: 'today', x: 0, y: 0, width: 833, height: 843 },
  { label: '明日午餐', action: 'tomorrow', x: 833, y: 0, width: 834, height: 843 },
  { label: '本週午餐', action: 'week', x: 1667, y: 0, width: 833, height: 843 },
  { label: '查詢日期', action: 'date', x: 0, y: 843, width: 833, height: 843 },
  { label: '使用說明', action: 'info', x: 833, y: 843, width: 834, height: 843 },
  { label: '關於小天使', action: 'about', x: 1667, y: 843, width: 833, height: 843 },
];

let client = null;

function getClient() {
  if (!client && process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    client = LineBotClient.fromChannelAccessToken({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    });
  }
  return client;
}

function logRichMenuError(action, err) {
  console.error(`[rich-menu] ${action} failed`);
  if (err && typeof err.status === 'number') {
    console.error(`status: ${err.status}`);
    if (err.statusText) {
      console.error(`statusText: ${err.statusText}`);
    }
  }
  if (err && typeof err.body === 'string' && err.body.length > 0) {
    let parsed = null;
    try {
      parsed = JSON.parse(err.body);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed.message === 'string') {
      console.error(`LINE error: ${parsed.message}`);
    } else {
      console.error(`LINE response body: ${err.body.slice(0, 500)}`);
    }
  } else {
    console.error(`message: ${err ? err.message : String(err)}`);
  }
}

function buildRichMenuRequest() {
  return {
    size: { width: RICH_MENU_WIDTH, height: RICH_MENU_HEIGHT },
    selected: true,
    name: RICH_MENU_NAME,
    chatBarText: RICH_MENU_CHAT_BAR_TEXT,
    areas: RICH_MENU_AREAS.map(({ label, action, x, y, width, height }) => ({
      bounds: { x, y, width, height },
      action: { type: 'postback', label, data: `action=${action}`, displayText: label },
    })),
  };
}

export function getRichMenuImagePath() {
  return RICH_MENU_IMAGE_PATH;
}

export function getRichMenuMetadataPath() {
  return RICH_MENU_METADATA_PATH;
}

export async function readRichMenuMetadata() {
  try {
    return JSON.parse(await readFile(RICH_MENU_METADATA_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export async function getExistingRichMenu() {
  const lineClient = getClient();
  if (!lineClient) return null;

  const list = await lineClient.clients.messagingApi.getRichMenuList();
  const richMenus = list.richmenus ?? [];
  return richMenus.find((menu) => menu.name === RICH_MENU_NAME) ?? null;
}

export async function createRichMenu() {
  const lineClient = getClient();
  if (!lineClient) return null;

  const response = await lineClient.clients.messagingApi.createRichMenu(buildRichMenuRequest());
  return response?.richMenuId ?? null;
}

export async function uploadRichMenuImage(richMenuId) {
  const lineClient = getClient();
  if (!lineClient) return false;

  const buffer = await readFile(RICH_MENU_IMAGE_PATH);
  const blob = new Blob([buffer], { type: 'image/png' });
  await lineClient.clients.messagingApiBlob.setRichMenuImage(richMenuId, blob);
  return true;
}

export async function setDefaultRichMenu(richMenuId) {
  const lineClient = getClient();
  if (!lineClient) return false;

  await lineClient.clients.messagingApi.setDefaultRichMenu(richMenuId);
  return true;
}

export async function deleteRichMenu(richMenuId) {
  const lineClient = getClient();
  if (!lineClient) return false;

  await lineClient.clients.messagingApi.deleteRichMenu(richMenuId);
  return true;
}

async function writeRichMenuMetadata(richMenuId) {
  const now = new Date().toISOString();
  const existing = (await readRichMenuMetadata()) ?? {};
  const metadata = {
    richMenuId,
    name: RICH_MENU_NAME,
    createdAt: existing.createdAt ?? now,
    updatedAt: now,
    status: 'active',
  };
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(RICH_MENU_METADATA_PATH, JSON.stringify(metadata, null, 2))
  );
}

async function richMenuHasImage(richMenuId) {
  try {
    const stream = await getClient().clients.messagingApiBlob.getRichMenuImage(richMenuId);
    for await (const _ of stream) {
      break;
    }
    return true;
  } catch {
    return false;
  }
}

async function isDefaultRichMenu(richMenuId) {
  try {
    const current = await getClient().clients.messagingApi.getDefaultRichMenuId();
    return current?.richMenuId === richMenuId;
  } catch {
    return false;
  }
}

export async function ensureRichMenu({ logger = console } = {}) {
  const lineClient = getClient();
  if (!lineClient) {
    logger.error('[rich-menu] LINE_CHANNEL_ACCESS_TOKEN 尚未設定，無法建立 Rich Menu');
    return { ok: false, status: 'NO_TOKEN' };
  }

  const imageExists = await import('node:fs/promises')
    .then(({ access }) => access(RICH_MENU_IMAGE_PATH).then(() => true).catch(() => false));
  if (!imageExists) {
    logger.error(`[rich-menu] 找不到圖片：${RICH_MENU_IMAGE_PATH}`);
    return { ok: false, status: 'NO_IMAGE' };
  }

  const existing = await getExistingRichMenu();
  if (existing) {
    logger.log('[rich-menu] 已存在 lunch-angel-main，SKIP');

    const hasImage = await richMenuHasImage(existing.richMenuId);
    if (!hasImage) {
      logger.log('[rich-menu] 偵測到缺少圖片，補上傳圖片');
      await uploadRichMenuImage(existing.richMenuId);
    }

    const isDefault = await isDefaultRichMenu(existing.richMenuId);
    if (!isDefault) {
      logger.log('[rich-menu] 尚未設為 default，補設定');
      await setDefaultRichMenu(existing.richMenuId);
    }

    await writeRichMenuMetadata(existing.richMenuId);
    return { ok: true, status: 'SKIP', richMenuId: existing.richMenuId };
  }

  const richMenuId = await createRichMenu();
  if (!richMenuId) {
    logger.error('[rich-menu] 建立 Rich Menu 失敗');
    return { ok: false, status: 'CREATE_FAILED' };
  }

  await uploadRichMenuImage(richMenuId);
  await setDefaultRichMenu(richMenuId);
  await writeRichMenuMetadata(richMenuId);

  logger.log('[rich-menu] Rich Menu 建立完成並設為 default');
  return { ok: true, status: 'CREATED', richMenuId };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  ensureRichMenu()
    .then((result) => {
      if (!result.ok) {
        process.exit(1);
      }
    })
    .catch((err) => {
      logRichMenuError('run', err);
      process.exit(1);
    });
}

export { RICH_MENU_AREAS, RICH_MENU_NAME, buildRichMenuRequest };
