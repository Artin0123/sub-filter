# sub-filter

Cloudflare Pages 訂閱聚合與分塊服務。支援多個來源的代理 URI 聚合、去重與分塊輸出，並提供受保護的管理後台。

## 架構

詳細模組分層、請求流程、驗證邊界與去重管線說明請見 [架構說明](docs/architecture.zh-TW.md)。

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
npm run cf:sync-config
npm run cf:typegen
npm run deploy
```

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

## API

### 訂閱端點

- `GET /sub_{i}?token=...`

### 管理端點

- `POST /login`
- `POST /logout`
- `GET /list`
- `POST /add`
- `POST /remove`
- `GET /config`
- `POST /config`
- `POST /refresh`
- `GET /debug`

## 來源格式

支援：

- `https://...`
- `inline:...`
- `data:text/plain,...`

更新流程會自動：

1. 抓取來源內容
2. 判斷是否為批量 Base64 訂閱
3. 逐行解析代理 URI（支援 `vmess`、`vless`、`trojan`、`ss`、`hysteria2` / `hy2`；其餘不支援的協議或無效格式會略過並計入 `/debug` 的 `failedByScheme`）
4. 全局去重（同時涵蓋單一訂閱源內部與跨來源重複，保留最先出現的一筆；依 `type`、小寫 `server`、有效 `port` (1–65535)、小寫 `sni`、`method` 與 `password` / `uuid` 判重，忽略節點名稱備註）
5. 保留原始 URI 並依 `chunk_size` 分塊輸出

## 測試

```bash
npm run test
```

測試環境會：

- 使用 `wrangler.vitest.toml` 與 `@cloudflare/vitest-plugin` 建立獨立的測試環境
- 用 Miniflare 注入測試用 `ADMIN_PASSWORD`
- 不依賴線上 secret 或 `.local/` 回流
