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
- `src/subscription.ts`、`src/dedup.ts`、`src/update.ts`
  - 訂閱內容解析、去重、分塊與 KV / ETag 更新管線
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

## 訂閱更新與去重管線

1. **抓取來源**：依序支援 `https://...`、`inline:...`、`data:...` 來源，外部 HTTP 請求以併發上限 5 抓取。
2. **解碼與解析**：自動偵測批量 Base64 訂閱並解碼，逐行解析代理 URI（支援 `vmess`、`vless`、`trojan`、`ss`、`hysteria2` / `hy2`）；不支援或格式異常的行會計入 `failedByScheme`。
3. **全局去重**：合併所有來源後統一去重（涵蓋單一來源內部與跨來源重複），保留最先出現的節點。判重鍵為 `type:server:port:sni:method:id`（`server` 與 `sni` 轉小寫並略過無效 port，不比較節點名稱備註）。
4. **分塊與快取**：保留 `rawUri` 依 `chunk_size` 分塊（可選 Base64 編碼），僅在內容 ETag 變化或編碼設定切換時寫入 KV，並清理多餘舊分塊。

## 配置來源

- 線上
  - Cloudflare Dashboard 為準
- 本地
  - `.dev.vars`：本地 secret
  - `.local/wrangler.toml`：需要時才由 `npm run cf:sync-config` 下載，不進版控
- 測試
  - `wrangler.vitest.toml` + `vitest.config.mts`：透過 `@cloudflare/vitest-plugin` 與 Miniflare 提供獨立的 Workers 測試環境與測試用 `ADMIN_PASSWORD`
