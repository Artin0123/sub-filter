# TODO（依 plan.md 落地實作 + 分塊輸出）

> 目標：在 Cloudflare Workers 上實作公開訂閱端點，具備管理面板與排程更新、KV 最小持久化、去重與快取機制；新增「分塊輸出」能力。
>
> 完成定義（DoD）：
> - `GET /sub.txt` 穩定服務（保留相容性，提供完整合併輸出），支援 ETag/304 與 5 分鐘邊緣快取。
> - 新增分塊輸出：可設定每檔固定筆數（預設 400），產生 `sub_1.txt`、`sub_2.txt`…（每塊各自 ETag/304 與快取）。
> - 管理端可登入、列出/新增/移除來源並觸發刷新。
> - `POST /refresh` 可被 CI（Bearer 密碼）或登入狀態呼叫，成功更新 KV 並回傳統計 JSON。
> - 更新流程包含抓取、解析（vmess/vless/trojan/ss）、去重、輸出（含分塊）、雜湊比對與最小寫入。
> - 具基本單元測試與 1-2 個整合測試通過（vitest）。

---

## 0) 專案與環境準備

- [ ] 新增/確認 Cloudflare Workers 基本設定（`wrangler.jsonc` 或 `wrangler.toml`）
  - [ ] 綁定 KV：`KV_NAMESPACE`（讀/寫 `sources`、`chunk_size`、`chunks_total`、`sub_txt`、`etag`、`sub_txt_{i}`、`etag_{i}`、`last_updated_iso`）
  - [ ] 設定環境變數：`ADMIN_PASSWORD`
- [ ] 在 `src/` 建立必要的模組切分（若尚未存在）：
  - [ ] `src/index.ts` 路由分派與回應組裝
  - [ ] `src/auth.ts` Cookie 簽名/驗證、Bearer 判定
  - [ ] `src/kv.ts` KV 操作封裝（keys 常數與 typed helpers）
  - [ ] `src/fetchers.ts` 來源抓取（逾時、重試、受控併發）
  - [ ] `src/subscription.ts` 解析/編碼（vmess/vless/trojan/ss + Base64 安全解碼）
  - [ ] `src/dedup.ts` 去重邏輯
  - [ ] `src/hash.ts` SHA-256 → hex（ETag）
  - [ ] `src/cache.ts` caches.default 包裝（/sub.txt 與 /sub_{i}.txt）
- [ ] 型別與設定：對應 `worker-configuration.d.ts`、`tsconfig.json`

## 1) 路由與權限

- [ ] GET `/sub.txt`（公開，完整合併輸出）
  - [ ] 讀 KV `sub_txt`，附 `ETag` 與 `Cache-Control: public, max-age=300, must-revalidate`
  - [ ] 若 `If-None-Match` 符合 `etag` → 回 304
  - [ ] 使用 `caches.default` 做 5 分鐘邊緣快取（key 以 URL）
- [ ] GET `/sub_{index}.txt`（公開，分塊輸出；index 從 1 起算）
  - [ ] 讀 KV `sub_txt_{index}`，附 `ETag`（`etag_{index}`）與相同 `Cache-Control`
  - [ ] 若 `If-None-Match` 符合對應 `etag_{index}` → 回 304
  - [ ] 輸入驗證：index 必須為 1…`chunks_total` 之間，否則 404
  - [ ] 使用 `caches.default` 做 5 分鐘邊緣快取（key 以 URL）
- [ ] GET `/admin`（管理面板）
  - [ ] 未登入顯示登入表單；已登入顯示來源清單與操作按鈕
- [ ] POST `/admin/login`
  - [ ] 比對 `env.ADMIN_PASSWORD`，成功則核發 HttpOnly + Secure + SameSite=Lax 的簽名 Cookie（HMAC，無伺服端狀態）
- [ ] POST `/admin/logout`：清除 Cookie
- [ ] GET `/admin/list`（需登入）：回傳 KV `sources` JSON
- [ ] POST `/admin/add`（需登入）：加入來源 URL
- [ ] POST `/admin/remove`（需登入）：移除來源 URL
- [ ] GET `/admin/config`（需登入）：回傳 `chunk_size` 等基本設定
- [ ] POST `/admin/config`（需登入）：更新 `chunk_size`（整數；預設 400；建議範圍 50–2000）
- [ ] POST `/refresh`（需登入或 Bearer）
  - [ ] 驗證：有效登入 Cookie 或 `Authorization: Bearer <ADMIN_PASSWORD>`
  - [ ] 觸發更新流程並回傳結果 JSON

## 2) 更新流程（抓取 → 解析 → 合併 → 去重 → 輸出）

- [ ] 讀 KV `sources`（JSON 陣列 of URL）
- [ ] 受控併發抓取各來源（建議 5-10 併發）
  - [ ] 每請求逾時（AbortController）與 1 次輕量重試（可加簡單退避）
- [ ] Base64（UTF-8 安全）解碼檢測
  - [ ] 若整段可解碼且含多行 `scheme://`，則當作 Base64 訂閱解碼
- [ ] 逐行解析 URI（忽略空行/註解）
  - [ ] 支援 `vmess://`（base64 JSON：取 add/port/id/sni/tls/ps）
  - [ ] 支援 `vless://user@host:port?query#tag`（user→uuid；取 sni/encryption/flow）
  - [ ] 支援 `trojan://password@host:port?query#tag`（password；取 sni/tls）
  - [ ] 支援 `ss://`（method:password@host:port 或 base64 credentials）
  - [ ] 正規化 NormalizedRecord：
    - `type`: 'vmess' | 'vless' | 'trojan' | 'ss'
    - `server`（小寫），`port`（number），`servername/sni`（或空字串）
    - `password` 或 `uuid` 擇一；另一個空字串
    - 可選欄位：`tls`、`reality`、`name/tag` 等
  - [ ] 缺關鍵欄位（server/port）或無法解析者略過
- [ ] 合併所有來源記錄
- [ ] 去重（等價 dedup.go）
  - [ ] key = `server:port:servername:(password or uuid)`；server 小寫、port 數字
  - [ ] `server` 為空則丟棄
- [ ] 重新編碼為原協議 URI，逐行輸出文字（不再二次 Base64）
- [ ] 分塊輸出：
  - [ ] 從 KV 讀取 `chunk_size`（預設 400）；將輸出行依序切成多個塊（1 起算）
  - [ ] 逐塊計算 `etag_{i}` = SHA-256(hex) of 該塊內容
  - [ ] 與 KV 既有 `etag_{i}` 比對：相同則略過寫入；不同則寫入 `sub_txt_{i}` 與 `etag_{i}`
  - [ ] 更新 `chunks_total` 為新的塊數；若舊的塊數 > 新塊數，刪除多餘的 `sub_txt_{j}`/`etag_{j}`（j > 新塊數）
- [ ] 完整輸出副本：
  - [ ] 合併所有塊（或直接以全量行陣列）產出 `sub_txt` 與 `etag`（同樣採用最小寫入）
  - [ ] 更新 `last_updated_iso`
- [ ] 回傳更新結果 JSON：`{ updated, records, chunks: { total, size }, perSource: { ok, fail }, changed: { full, byChunk: number[] } }`

## 3) KV 與快取

- [ ] KV keys：
  - `sources`（JSON 陣列）
  - `chunk_size`（整數；預設 400）
  - `chunks_total`（目前塊數；整數）
  - `sub_txt`（完整輸出）與 `etag`（完整輸出之 SHA-256 hex）
  - `sub_txt_{i}`（第 i 塊內容）與 `etag_{i}`（第 i 塊之 SHA-256 hex）
  - `last_updated_iso`
- [ ] `caches.default` 對 `/sub.txt` 與 `/sub_{i}.txt` 的包裝（讀寫）
- [ ] `Cache-Control` 與 ETag/If-None-Match 邏輯

## 4) 管理面板（簡易 HTML）

- [ ] 極簡 UI：登入表單、來源清單、加入/移除按鈕、手動刷新按鈕、分塊大小設定（chunk_size）
- [ ] 以 Fetch API 呼叫後端 API（附上 Cookie）
- [ ] 錯誤提示與成功訊息

## 5) CI/Cron 與維運

- [ ] GitHub Actions 或 Cloudflare Cron 排程呼叫 `POST /refresh`
  - [ ] 以 `Authorization: Bearer <ADMIN_PASSWORD>` 認證
  - [ ] 紀錄輸出 JSON（`updated`、`records`、`chunks.total`、`chunks.size`）

## 6) 測試與品質

- [ ] 單元測試（vitest）
  - [ ] `subscription` 解析：vmess/vless/trojan/ss 最少 1 條 happy path + 1 條錯誤/邊界
  - [ ] `dedup`：相同 key 僅保留一條、server 為空丟棄
  - [ ] `hash`：固定輸入得到固定 hex
  - [ ] `auth`：Cookie 簽名/驗證、Bearer 驗證
  - [ ] 分塊：
    - [ ] 行數 0、1、399、400、401、800、801 的塊數計算與最後一塊大小
    - [ ] `etag_{i}` 與內容對應關係；同內容不重寫
    - [ ] 變更 `chunk_size` 之後的重新分塊與多餘塊清理
- [ ] 簡單整合測試
  - [ ] 模擬多來源 → 更新流程回傳計數正確、KV 寫入如預期（含分塊）
  - [ ] `/sub.txt` 回傳 ETag，第二次請求帶 If-None-Match 得到 304
  - [ ] `/sub_2.txt` 回傳 ETag，第二次請求帶 If-None-Match 得到 304；index 越界返回 404
- [ ] Lint/型別檢查（若專案有 ESLint/TS 設定則執行）

## 7) 驗收（依計畫）

- [ ] 綁定 KV 與 `ADMIN_PASSWORD` 後部署 Worker
- [ ] 以 `/admin` 登入並新增 1～2 個訂閱 URL
- [ ] 在管理面板設定 `chunk_size`（預設 400，可改 200 以便驗證）
- [ ] 手動呼叫 `/refresh`，確認產生完整輸出與分塊輸出（`chunks_total`、`sub_txt_{i}`/`etag_{i}`）
- [ ] 瀏覽 `/sub.txt`（完整輸出）與 `/sub_1.txt` `/sub_2.txt`（分塊）；重複請求驗證各自 ETag 304 與快取
- [ ] 調整 `chunk_size` 後再次刷新，驗證分塊數與內容更新，舊多餘塊被清理
- [ ] 啟用排程，觀察 `updated`、行數與 `chunks.total` 變化

## 8) 後續擴充（Nice to have）

- [ ] 更多協議/欄位支援（如 hysteria、reality 詳參數）
- [ ] 來源分組與標籤策略（如自訂過濾與排序）
- [ ] 更完整的錯誤觀測（計時、分佈、失敗樣本）
- [ ] Admin UI 美化（Tailwind/Vanilla Extract）
- [ ] 指標端點（如 `/metrics` 供外部監控）
