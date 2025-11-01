## 目標與原則

- 單一公開端點：代理工具抓 `https://你的名稱.workers.dev/sub.txt`。
- 管理介面：在 Worker 提供路由維護「訂閱來源清單」。
- 後台更新：由 GitHub Actions 或 Cloudflare Cron 觸發，不在前台請求時計算。
- 最小持久化：只存「來源清單」「最終輸出」「etag/timestamp」。

---

## 高階架構（TypeScript on Cloudflare Workers）

- Worker + 自訂路由。
- 儲存層：Workers KV。
  - Keys：`sources`（JSON 陣列）、`sub_txt`（最新輸出）、`etag`（SHA-256 hex）、`last_updated_iso`。
- 更新觸發：GitHub Actions 定時呼叫 `POST /refresh`；或使用 Cloudflare Cron。
- 外部消費：代理工具直接 `GET /sub.txt`。

---

## 路由與權限

- 公開端點
  - GET `/sub.txt`
    - 從 KV 讀 `sub_txt`；回應 `ETag`、`Cache-Control: public, max-age=300, must-revalidate`。
    - 若帶 `If-None-Match` 且相符，回 304。
    - 可用 `caches.default` 做 5 分鐘邊緣快取。

- 管理端（以環境變數中的密碼 + 面板登入）
  - GET `/admin`：登入/管理面板（HTML）。未登入則顯示登入表單。
  - POST `/admin/login`：提交密碼，與 `env.ADMIN_PASSWORD` 比對，成功後核發 HttpOnly + Secure + SameSite=Lax 的簽名 Cookie（無伺服端儲存，HMAC 簽名）。
  - POST `/admin/logout`：清除 Cookie。
  - GET `/admin/list`：回傳 `sources`（JSON）。需有效登入 Cookie。
  - POST `/admin/add`：加入來源 URL。需有效登入 Cookie。
  - POST `/admin/remove`：移除來源 URL。需有效登入 Cookie。
  - POST `/refresh`：立刻執行更新流程。驗證方式二擇一：
    1) 具有有效登入 Cookie；或
    2) Header `Authorization: Bearer <ADMIN_PASSWORD>`（便於 GitHub Actions/CI 直接呼叫）。

---

## 更新流程（抓取、解析、合併、去重、輸出）

1) 從 KV 讀取 `sources`（多個訂閱 URL）。
2) 以受控併發抓取每個來源（設定逾時與簡單重試）。
3) 針對每個回應內容進行「Subscription 處理」：
   - 若內容看起來是 Base64 訂閱（整段可被解碼，且解碼後包含多行 `scheme://...`），先 Base64 解碼得到純文字。
   - 按行切分；忽略空行與註解。
   - 支援常見協議 URI：`vmess://`、`vless://`、`trojan://`、`ss://`（可逐步擴充）。
   - 將各 URI 解析為統一結構（NormalizedRecord）：
     - `type`: 'vmess' | 'vless' | 'trojan' | 'ss'
     - `server`: string（host/IP，小寫）
     - `port`: number
     - `servername`/`sni`: string | ''
     - `password` 或 `uuid`: string | ''（兩者擇一填，另一個留空）
     - 其他可選欄位：`tls`、`reality`、`name/tag` 等
   - 無法解析或缺關鍵欄位（如 server/port）者略過。
4) 合併所有來源的 NormalizedRecord 為同一陣列。
5) 去重（沿用 dedup.go 的原則，轉為 TypeScript）：
   - Key = `server` + ':' + `port` + ':' + `servername` + ':' + (`password` or `uuid`)。
   - 只要 Key 相同就視為重複；`server` 正規化為小寫，`port` 以數字比較。
   - 若 `server` 為空則丟棄。
6) 產生輸出文字：
   - 將去重後的紀錄「按原協議重新編碼為 URI」，逐行輸出成純文字；
   - 行與行之間以 `\n` 分隔；不再做第二層 Base64 包裝（讓客戶端直接當訂閱使用）。
7) 計算 `etagNew` = SHA-256(hex) of 整包輸出。
8) 與 KV 中 `etagOld` 比對：若相同則不寫；不同則同時更新 `sub_txt`、`etag`、`last_updated_iso`。
9) 回傳更新結果（JSON）：包含 `updated` 布林、`records` 行數、各來源成功/失敗數。

---

## TypeScript 實作要點（Cloudflare Workers）

- 抓取與併發：使用 `Promise.allSettled` 或簡單併發池；每個請求加 `AbortController` 逾時與一次輕量重試。
- Base64（UTF-8 安全）解碼：避免直接用 `atob` 取得錯誤字元；做法為 `const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const text = new TextDecoder('utf-8').decode(bytes);`。
- 雜湊：`crypto.subtle.digest('SHA-256', data)`，再轉 hex 字串當 ETag。
- 邊緣快取：`caches.default.match/put` 包住 `/sub.txt` 回應。
- KV 綁定：在 `wrangler.toml` 綁定 `KV_NAMESPACE`；程式以 `env.KV_NAMESPACE.get/put` 操作。
- 權限：以 `env.ADMIN_PASSWORD` 作為唯一密碼；`/admin/login` 對比後核發簽名 Cookie；`/refresh` 亦可接受 `Authorization: Bearer <ADMIN_PASSWORD>` 以利 CI。

---

## URI 解析規格（簡述，可逐步擴充）

- vmess:// base64(JSON) → 解析 JSON 後取 `add/port/id/sni/tls/ps` 等欄位。
- vless://user@host:port?query#tag → user 當 uuid；query 取 `sni`/`encryption`/`flow` 等。
- trojan://password@host:port?query#tag → password 當密碼；query 取 `sni`/`tls`。
- ss://method:password@host:port#tag 或 base64-encoded credentials 形式；解出 host/port/password。
- 正規化：
  - `server` 小寫；`port` 轉數字；空值以空字串表示。
  - `servername` 優先取 `sni`；無則空。
  - `password` 與 `uuid` 二擇一填；另一個留空。

---

## 失敗處理與可觀測性（實作相關）

- 單一來源抓取或解析失敗：略過該來源並在結果 JSON 記錄錯誤摘要。
- 重試策略：對網路錯誤做 1 次輕量重試（指數退避可選）。
- 基本日誌：在 `/refresh` 回應中回報來源成功/失敗數與總輸出行數。

---

## GitHub Actions／Cron（簡述動作）

- 以排程呼叫管理端 `POST /refresh`，攜帶 `Authorization: Bearer <ADMIN_PASSWORD>`（或先登入取得 Cookie，但建議使用 Bearer 密碼）。
- 讀回 JSON，紀錄 `updated` 與行數即可。

---

## 驗收步驟

1. 綁定 KV 與 `ADMIN_PASSWORD` 後部署 Worker。
2. 先瀏覽 `/admin` 登入面板，登入成功後用 `/admin/add` 新增 1～2 個訂閱 URL。
3. 手動呼叫 `/refresh`，確認產生 `sub_txt/etag`。
4. 瀏覽 `/sub.txt` 是否為可用的多行 URI 清單；重複請求驗證 ETag 304。
5. 啟用排程（Actions 或 Cron），觀察更新 JSON 的 `updated` 與行數變化。

---

## 去重原則對應（from dedup.go → TypeScript）

- 來源檔案 `dedup.go` 的邏輯：以 `server:port:servername:(password or uuid)` 作為唯一鍵；`server` 為空則忽略。
- TypeScript 等價邏輯（描述）：
  - 建立 `seen = new Set<string>()`；
  - 對每筆記錄：`key = [server.toLowerCase(), port, servername || '', password || uuid || ''].join(':')`；
  - 若 `!server` 則跳過；若 `!seen.has(key)` 則加入輸出並 `seen.add(key)`。
