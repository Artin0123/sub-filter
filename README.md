# sub-filter

Cloudflare Workers 上的「訂閱合併與分塊服務」。將多個來源訂閱（vmess/vless/trojan/ss）抓取、解析、去重，產生分塊輸出，並提供 ETag/304 與邊緣快取；含簡易的管理面板與權限控制。

> 適用情境：多個節點來源整合為一個穩定的訂閱端點，並以最小 KV 寫入與快取減少成本/延遲。

## 功能特點

- 分塊輸出端點：`/sub_1.txt`、`/sub_2.txt`…（每塊固定筆數；預設 400）
- 來源管理：管理面板 `/` 可登入、列出/新增/移除來源與設定 `chunk_size`
- 更新 API：`POST /refresh` 立刻抓取來源 → 解析 → 去重 → 寫回 KV（支援 Cookie 或 Bearer 密碼）
- 快取與省流量：分塊端點支援 ETag/If-None-Match 與 `caches.default`（5 分鐘 TTL）
- 最小持久化：僅在內容改變時更新 KV；同時維護 per-chunk ETag、完整輸出 ETag 與最後更新時間
- CI：已提供 GitHub Actions workflow 觸發更新（不使用 Cloudflare Cron）
- 測試齊全：涵蓋解析、去重、雜湊、認證、ETag/304、分塊與端對端流程（vitest + Miniflare）

## 架構與模組

- 平台：Cloudflare Workers（Wrangler 開發/部署）
- 儲存：Workers KV（綁定名 `KV_NAMESPACE`）
- 主要模組（位於 `src/`）：
  - `index.ts`：路由、管理面板、ETag/快取與 `/refresh`
  - `update.ts`：更新管線（抓取 → 解析 → 去重 → 編碼 → 分塊 → 最小寫入）
  - `subscription.ts`：協議 URI 解析/編碼、Base64 訂閱檢測與解碼
  - `dedup.ts`：依唯一鍵去重（`server:port:servername:(password|uuid)`）
  - `fetchers.ts`：逾時 + 輕量重試的抓取器，控制併發
  - `hash.ts`：SHA-256 → hex（作為 ETag）
  - `cache.ts`：包裝 `caches.default` 與 Cache-Control
  - `auth.ts`：HMAC Cookie 簽名/驗證與 Bearer 驗證
  - `kv.ts`：KV key 常數與小工具

### KV keys

- `sources`: JSON 陣列（string[]，各來源 URL）
- `chunk_size`: 每塊行數（字串整數；預設 400）
- `chunks_total`: 目前分塊數量（字串整數）
- `sub_txt`: 完整輸出（文字）
- `etag`: 完整輸出之 SHA-256 hex
- `sub_txt_{i}`: 第 i 塊內容（1 起算）
- `etag_{i}`: 第 i 塊內容之 SHA-256 hex
- `last_updated_iso`: ISO 字串，最後更新時間

### 路由

- `GET /sub_{index}.txt?token=xxx`：分塊輸出，`index` 從 1 起算（需要有效的訂閱 token）
- 管理面板與 API（路徑上移一層）：
  - `GET /`：登入/管理頁
  - `POST /login`、`POST /logout`
  - `GET /list`、`POST /add`、`POST /remove`
  - `GET /config`、`POST /config`（目前支援 `chunk_size`）
- 更新：`POST /refresh`（需 Cookie 或 `Authorization: Bearer <ADMIN_PASSWORD>`）

## 更新流程（runUpdate）

1) 從 KV 讀 `sources` 與 `chunk_size`（預設 400）
2) 以受控併發抓取各來源（逾時 + 輕量重試）
   - 支援 `inline:` 與 `data:` 方便測試
3) 訂閱處理：
   - 若整段疑似 Base64 訂閱，先解碼
   - 逐行解析支援 vmess/vless/trojan/ss（忽略空行/註解/無法解析）
   - 正規化為統一記錄結構（NormalizedRecord）
4) 去重：以 key = `server:port:servername:(password|uuid)` 保留第一筆
5) 重新編碼各筆為原協議 URI，組裝輸出行陣列
6) 分塊：依 `chunk_size` 產生 `sub_txt_{i}` 與對應 `etag_{i}`
   - 若 `etag_{i}` 未變，不重寫內容
   - 若分塊數變少，清理多餘 `sub_txt_{j}`/`etag_{j}`
   - 更新 `chunks_total`
7) 完整輸出：將所有行以 `\n` 串起，計算 `etag`，僅在變更時寫入 `sub_txt`/`etag`（路由不再提供 `/sub.txt`，保留作為內部資料）
8) 更新 `last_updated_iso`，回傳統計 JSON：

```jsonc
{
  "updated": true,
  "records": 1234,
  "chunks": { "total": 4, "size": 400 },
  "perSource": { "ok": 2, "fail": 1 },
  "changed": { "full": true, "byChunk": [1,2,4] }
}
```

## 認證與安全

- 管理面板登入：比對 `env.ADMIN_PASSWORD` 成功後，回傳 HMAC 簽名的 HttpOnly Cookie（Secure + SameSite=Lax）
- `/refresh`：可用登入 Cookie，或以 `Authorization: Bearer <ADMIN_PASSWORD>` 直接呼叫
- 訂閱端點保護：`/sub_{i}.txt` 需要在 query string 提供有效的 token（例如 `/sub_1.txt?token=xxx`）
  - Token 由 `ADMIN_PASSWORD` 自動生成（SHA-256 後取前 12 位）
  - 管理面板會顯示完整的訂閱 URL（含 token），可一鍵複製
- 不在 KV 存放密碼；請用 Cloudflare Secrets 或 GitHub Secrets 注入

## 快取與 ETag

- `/sub_{i}.txt`：
  - 回應 `ETag` 與 `Cache-Control: public, max-age=300, must-revalidate`
  - 帶 `If-None-Match` 命中則回 304，且仍附帶相同的 `ETag` 與 `Cache-Control`
  - 以 `caches.default` 做 5 分鐘邊緣快取

## 本地開發

需求：Node.js、`wrangler`。

1) 安裝依賴

```bash
npm install
```

2) 設定本地變數（Miniflare 會讀 `.dev.vars`）

```
ADMIN_PASSWORD=devpass
```

3) 啟動本地開發服務

```bash
npm run dev
```

4) 測試

```bash
npm test
```

## 部署與設定

- `wrangler.jsonc` 已綁定 `KV_NAMESPACE`，部署前請在 Cloudflare 介面建立實際的 KV 並填入對應 ID
- 設定 Worker Secret：`wrangler secret put ADMIN_PASSWORD`
- 部署：

```bash
npm run deploy
```

- 部署後：
  - 造訪 `/` 登入並新增來源
  - 視需要於 `/config` 調整 `chunk_size`
  - 手動呼叫 `POST /refresh`

## CI

- GitHub Actions（`.github/workflows/refresh.yml`）
  - Secrets：
    - `REFRESH_URL`：部署後的 `https://<你的域名>/refresh`
    - `ADMIN_PASSWORD`：與 Worker 一致
  - 作業會以 Bearer 密碼呼叫 `/refresh`，並輸出 `{updated, records, chunks}` 摘要

## API 速覽

- `GET /sub_{i}.txt?token=xxx` → text/plain（1 起算；需有效 token；超出範圍 404）
- `POST /refresh` → application/json（需登入或 Bearer）
- 管理端：
  - `GET /` → text/html
  - `POST /login`、`POST /logout`
  - `GET /list` → JSON（需登入）
  - `POST /add`、`POST /remove` → JSON（需登入）
  - `GET /config`、`POST /config` → JSON（需登入，回傳包含 subscription_token）

## 測試

- 採用 vitest + @cloudflare/vitest-pool-workers + Miniflare
- 覆蓋：
  - 協議解析、錯誤處理
  - 去重邏輯
  - 雜湊（ETag）
  - Cookie 與 Bearer 認證
  - `/refresh` 端對端與分塊端點的 ETag/304

## Sample

- `sample/` 目錄包含範例節點文件（多個協議與重複項），可用於測試合併與分塊是否正確。
- 測試流程會讀取這些檔案內容，作為 `inline:` 來源注入，並驗證分塊數、ETag 與去重結果。
  - 分塊：邊界行數、最小寫入、`chunk_size` 變更後清理舊塊
