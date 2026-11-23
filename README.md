# sub-filter

Cloudflare Pages 訂閱聚合與分塊服務。支援多個來源的代理 URI 聚合、去重與分塊輸出，並提供受保護的管理後台。

## 架構

模組分層、請求流程、驗證邊界、更新管線、KV key 與已知問題請見 [架構說明](docs/architecture.zh-TW.md)。

## 本地開發

### 1. 建立本地 secret

在專案根目錄建立 `.dev.vars`：

```bash
ADMIN_PASSWORD=your-local-password
```

說明：

- `.dev.vars` 只放本地 secret，不進版控
- 線上 secret 一律以 Cloudflare Dashboard 為準

### 2. 啟動本地 Pages

```bash
npm run dev
```

這會直接用 CLI 參數啟動 `wrangler pages dev`，不依賴 repo 內的 `wrangler.toml`。

### 3. 同步線上 bindings 到本地

```bash
npm run cf:sync-config
npm run cf:typegen
```

說明：

- `cf:sync-config` 會把 Pages 設定下載到 `.local/wrangler.toml`
- `.local/` 不進版控，只是本地臨時快照
- 腳本會自動移除 `[vars]`，避免把線上普通變數值帶回本地檔案
- `cf:typegen` 會用 `.local/wrangler.toml` 重新產生 `worker-configuration.d.ts`

## 線上設定

### Secrets

必填：

- `ADMIN_PASSWORD`

位置：

- Cloudflare Pages Dashboard
- `Settings`
- `Variables and Secrets`
- `Secrets`

### KV Binding

程式使用固定 binding 名稱：

```text
KV_NAMESPACE
```

請在 Cloudflare Pages Dashboard 將它綁到正確的 KV namespace。

## 常用指令

```bash
npm run dev
npm run test
npm run typecheck
npm run cf:sync-config
npm run cf:typegen
npm run deploy
```

`npm run typecheck` 會同時檢查 `src/`、`functions/`（Pages 入口）與 `test/`。

## 部署

### Pages 專案設定

- 專案名稱：`sub-filter`
- Build output directory：`public`
- Functions 入口：`functions/[[path]].ts`
- 線上設定來源以 Cloudflare Dashboard 為準，不依賴 repo 內的 Wrangler 設定檔。

### 部署前本地確認

```bash
npm run cf:sync-config
npm run cf:typegen
npm run typecheck
npm run test
```

### 部署命令

```bash
npm run deploy
```

實際執行：

```bash
wrangler pages deploy public --project-name sub-filter
```

### 部署後檢查

- 未登入訪問 `/` 會跳轉至 `/login-page.html`
- 登入後可正常進入管理後台
- `/list`、`/config`、`/refresh` 介面正常
- `GET /sub_1?token=...` 可正常讀取訂閱內容
- `GET /refresh` 回 `405`（寫入操作只接受 POST）

## API

| 端點 | Method | 說明 |
| --- | --- | --- |
| `/sub_{i}?token=...` | GET / HEAD | 訂閱分塊內容 |
| `/login` | POST | 帳密登入，成功回 `Set-Cookie` |
| `/logout` | POST | 清除 session cookie |
| `/list` | GET | 來源清單 |
| `/add` | POST | 新增來源 |
| `/remove` | POST | 移除來源 |
| `/config` | GET / POST | 讀取 / 更新設定 |
| `/refresh` | POST | 觸發刷新 |
| `/debug` | GET | 除錯資訊與上次刷新統計 |

不在表上的 method 一律回 `405`。管理端點接受 session cookie 或 `Authorization: Bearer <signed-token>`。

### 訂閱 token

訂閱 URL 的 `?token=` 是系統產生並存在 KV 的隨機值，可從後台「Subscription URL」卡片複製（或 `GET /config` 的 `subscription_token`）。它與 `ADMIN_PASSWORD` 沒有推導關係、不能用來登入後台，也沒有有效期、不會自動輪換：客戶端設定一次即可。

這個 URL 本身就是 bearer credential，視同密碼：

- 不要貼到第三方訂閱轉換 / 節點測速服務
- Cloudflare 的存取紀錄會包含完整 URL（含 token）
- 要撤銷（例如外流）：刪掉 KV 的 `subscription_token`，所有 `/sub_*` 就回 401；開一次後台會產生新 token，再更新各客戶端。KV 是最終一致性，全球生效約需 60 秒

```bash
wrangler kv key delete subscription_token --namespace-id=<namespace id> --remote
```

## 來源格式

支援：

- `https://...` / `http://...`
- `inline:...`
- `data:text/plain,...`

限制：

- 只接受上述 scheme；`ftp://`、`file://`、`javascript:` 等會被 `/add` 拒絕（400 `unsupported_source`）
- `http(s)` 來源不可指向 localhost、私有網段、link-local（含雲端 metadata 位址）等保留位址（400 `blocked_source`）
- 單一來源網址上限 4096 字元
- 單一來源內容上限 8MB，超過時該來源視為失敗
- 位址檢查只看 hostname，**無法防 DNS rebinding**（網域解析後才指向私有位址）；要完全封死需在 Cloudflare 層加存取規則
- 每個來源會用掉 1–2 個 subrequest（失敗重試一次），免費方案的單請求上限是 50，
  因此來源數超過約 24 個時部分來源會因平台限制失敗；失敗原因見 `/refresh` 回應的 `failedSources`
- `chunk_size` 允許 50–2000

`/refresh` 有 60 秒的去抖動鎖：同時觸發時，後到的請求會回 `409 refresh_in_progress`。

## 測試

```bash
npm run test
```

測試環境會：

- 使用 `wrangler.vitest.toml` 與 `@cloudflare/vitest-plugin` 建立獨立的測試環境
- 用 Miniflare 注入測試用 `ADMIN_PASSWORD`
- 不依賴線上 secret 或 `.local/` 回流

測試輸出中的 `"node:inspector" ... is not available at this Worker's compatibility date` 是 vitest 5 與 Workers runtime 的已知雜訊，不影響結果；刻意不開 `nodejs_compat`，以免掩蓋誤用 Node API 的程式碼。

## 已知問題

`parseBody()` 對已消耗的 body 會二次讀取，導致「`content-type: application/json` 但內容不是合法 JSON」時回 500 而非 400。
影響範圍與建議修法見 [架構說明 § 已知問題](docs/architecture.zh-TW.md#已知問題刻意保留尚未修)。
