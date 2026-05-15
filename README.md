# sub-filter

Cloudflare Pages 訂閱聚合與分塊服務。支援多個來源的代理 URI 聚合、去重、重新編碼，並提供受保護的管理後台。

## 目前架構

- 平台：Cloudflare Pages + Pages Functions + Workers KV
- 靜態檔案：`public/`
- Pages 入口：`functions/[[path]].ts`
- 路由分發：`src/routes/`
- 業務邏輯：`src/services/`

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
pnpm run dev
```

這會直接用 CLI 參數啟動 `wrangler pages dev`，不依賴 repo 內的 `wrangler.toml`。

### 3. 同步線上 bindings 到本地

```bash
pnpm run cf:sync-config
pnpm run cf:typegen
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
pnpm run dev
pnpm run test
pnpm run cf:sync-config
pnpm run cf:typegen
pnpm run deploy
```

## 部署

```bash
pnpm run deploy
```

目前部署命令是：

```bash
wrangler pages deploy public --project-name sub-filter
```

線上設定來源以 Cloudflare Dashboard 為準，不依賴 repo 內的 Wrangler 設定檔。

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
3. 逐行解析代理 URI
4. 去重
5. 依 `chunk_size` 分塊輸出

## 測試

```bash
pnpm run test
```

測試環境會：

- 使用 `.local/wrangler.toml` 的 production bindings
- 用 Miniflare 注入測試用 `ADMIN_PASSWORD`
- 不依賴線上 secret 回流
