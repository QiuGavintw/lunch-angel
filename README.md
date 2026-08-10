# 午餐小天使👼

高中生查詢校園午餐的 LINE 聊天機器人 Backend。

目前為第一階段：LINE Bot Backend 基礎系統（Webhook + 基本文字回覆）。

## 專案用途

- 接收 LINE Messaging API Webhook 事件
- 驗證 LINE 簽名（x-line-signature）
- 回覆基本文字訊息

## 系統需求

- Node.js
- npm
- 一個 LINE Official Account（提供 Channel Secret 與 Access Token）

## Node.js 版本

建議 Node.js v18 以上（本專案開發環境為 v24.18.0）。

## 安裝套件

```bash
npm install
```

## 建立 .env

複製 `.env.example` 為 `.env`，並填入自己的 LINE Channel 設定：

```bash
cp .env.example .env
```

`.env` 內容：

```
LINE_CHANNEL_SECRET=你的 Channel Secret
LINE_CHANNEL_ACCESS_TOKEN=你的 Channel Access Token
PORT=3000
```

Secret 與 Token 請至 LINE Developers Console 取得，請勿上傳 `.env` 到公開場所。

## 如何啟動

```bash
npm run dev    # 開發模式（node --watch，隨時存檔自動重啟）
npm start      # 正式啟動
```

啟動後會監聽 `http://localhost:3000`。

## 如何測試 GET /

```bash
curl http://localhost:3000/
```

## 如何測試 GET /health

```bash
curl http://localhost:3000/health
```

## Webhook endpoint

```
POST /webhook
```

## 資料目錄（DATA_DIR）

同步系統（`src/lunch/sync.js`）與 scheduler 的資料目錄可以透過環境變數 `DATA_DIR` 指定：

```
DATA_DIR=/mnt/data
```

- 未設定 `DATA_DIR` → 預設使用專案內的 `data/`（本機開發行為不變）。
- `DATA_DIR` 只影響 `data/lunch.json`、`data/official-sync.json` 與同步 lock 的存放位置。

## Render 部署需求（Web Service）

- **Service Type**：Web Service
- **Build Command**：`npm install`
- **Start Command**：`npm start`
- **Environment Variables**：
  - `LINE_CHANNEL_SECRET`
  - `LINE_CHANNEL_ACCESS_TOKEN`
  - `PORT`（Render 自動注入）
  - `DATA_DIR`（指向 Persistent Disk 掛載路徑）
- **Health Check**：`/health`
- **Instance**：單一 instance，勿開啟水平擴充
- **Persistent Disk**：需要。因為雲端平台的重建 / redeploy / spin-down 會清除暫時檔案系統，`data/lunch.json` 與 `data/official-sync.json` 必須存放在 Persistent Disk，否則午餐 Cache 會遺失。
- 每日自動同步（05:00 Asia/Taipei）由 Node 原生 timer 驅動，instance 必須保持常駐（不要使用會 scale-to-zero 的方案）。

## 目前尚未設定公開 HTTPS Webhook

LINE 官方要求 Webhook URL 必須是公開的 HTTPS 網址（例如使用 ngrok、Cloudflare Tunnel 或部署至雲端）。目前尚未設定，因此 LINE 尚無法實際推播訊息進來。

## 目前回覆邏輯

- 收到任何文字訊息 → `👼 嗨！我是午餐小天使！請使用下方選單查詢午餐喔～🍱`
- 收到非文字訊息（圖片、影片等） → `👼 午餐小天使目前主要提供午餐菜單查詢喔～🍱`

## 專案結構

```
lunch-angel/
├── src/
│   ├── line/
│   │   └── webhook.js
│   └── server.js
├── .env.example
├── .gitignore
├── package.json
└── README.md
```