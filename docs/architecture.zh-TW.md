# 架構說明

## 平台

- Cloudflare Pages
- Pages Functions
- Workers KV

## 入口與分層

- `functions/[[path]].ts`
  - Pages 正式 catch-all 入口
- `src/index.ts`
  - 對外薄入口，轉交給路由層
- `src/routes/`
  - 依 URL 路徑分發 request
- `src/services/`
  - 封裝登入、設定、來源管理、刷新等業務邏輯
- `src/lib/`
  - cookie、env、request body 解析等通用工具
- `public/`
  - 靜態資產與登入頁 / 後台頁

## 請求流程

1. 請求先進入 `functions/[[path]].ts`
2. 轉交 `src/index.ts` 的 `handleRequest()`
3. `src/routes/index.ts` 判斷 API 路徑或靜態資產回退
4. 若為非 API，使用 `env.ASSETS.fetch(request)` 交給 Pages 靜態資產服務

## 驗證邊界

- `/` 與 `/index.html`
  - 必須先驗證登入狀態
  - 未登入直接 302 到 `/login-page.html`
- 管理 API
  - 使用 session cookie 或 Bearer token 驗證
- 訂閱端點
  - `/sub_{i}` 使用獨立 subscription token

## 配置來源

- 線上
  - Cloudflare Dashboard 為準
- 本地
  - `.dev.vars`：本地 secret
  - `.local/wrangler.toml`：需要時才由 `pnpm run cf:sync-config` 下載，不進版控
