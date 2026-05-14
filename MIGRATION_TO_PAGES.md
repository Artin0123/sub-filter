# 遷移到 Cloudflare Pages 的說明與架構解析

這份文檔記錄了我們將專案從 Cloudflare Workers 遷移至 Cloudflare Pages 的原因、架構變更，以及過程中遇到的問題和解決方案。給未來接手這份代碼的人一個詳細的參考。

## 整體架構變更

*   **平台轉移:** 從純 Cloudflare Workers 遷移到了 Cloudflare Pages。
*   **入口點變更:**
    *   以前 Workers 是一個單一的入口點。
    *   現在 Pages 採用了「進階模式」（Advanced Mode），我們直接將原來的 `src/index.ts` 作為 Pages 的 Entry point。靜態檔案放在 `public/` 目錄。
*   **路由機制:** 當請求進入 Pages：
    1. 所有請求首先進入 `src/index.ts` 處理。
    2. 若請求匹配到 API 端點（如 `/list`, `/refresh`），則由相應的邏輯處理。
    3. 若請求不匹配任何 API（或者是受保護的 `/`, `/index.html` 在驗證通過後），我們調用 `env.ASSETS.fetch(request)` 將請求退回給 Pages 的靜態資源伺服器，由它來回傳靜態檔案。

## 解決的問題：環境變數與 Secret 鎖定 (TOML 影響)

**問題現象:**
在 Dashboard 設置環境變數（ENV）時，系統提示因為受到 TOML（`wrangler.toml`）配置的影響，無法以明文文字方式存儲，只能使用加密的 Secret 方式。

**原因與說明:**
Cloudflare Pages 專案如果使用了 `wrangler.toml` 來聲明綁定（例如 `kv_namespaces`），這意味著專案正在使用 **Pages Advanced Mode**。在這種模式下，環境變數的行為與傳統的 Workers 更相似。
在目前的 Cloudflare Pages 架構中，如果在 Dashboard 配置了 `wrangler.toml`，出於安全性與配置一致性的考量，Dashboard 上的環境變數設定會傾向被視為 Secret。這是因為 `wrangler.toml` 預期成為基礎配置（包括普通的環境變數 `[vars]`），而敏感信息則作為 Secret。
因此，如果你想要明文，你必須在 `wrangler.toml` 的 `[vars]` 區塊中宣告它。然而，密碼 (`ADMIN_PASSWORD`) **本來就應該是 Secret**，所以使用 Dashboard 的加密 Secret 方式不僅是系統限制，更是最佳實踐。我們不需要刪除 TOML，只需要適應它：密碼就用 Secret，如果未來有非敏感變數，再放進 `wrangler.toml`。

> **注意：** 我們在代碼中已將 `ADMIN_KEY` 統一更名為 `ADMIN_PASSWORD`，以與文檔和常見實踐保持一致。

## 解決的問題：登入異常與登入繞過

**問題現象:**
用戶可以繞過登入頁面直接進入管理面板（`/index.html`），但因為沒有有效的 session，所有 API 請求（如 `/list`, `/config`, `/debug`）都會返回 HTTP 401 Unauthorized。而前端代碼（`public/admin.js`）錯誤地試圖將 "Unauthorized" 字符串作為 JSON 解析，導致了大量的 `SyntaxError: Unexpected token 'U', "Unauthorized" is not valid JSON` 報錯。此外，無法正常登出。

**解決方案:**

1.  **伺服器端攔截 (Server-side):**
    在 `src/index.ts` 中，我們新增了針對根路徑 `/` 和 `/index.html` 的攔截。
    ```typescript
    if (pathname === '/' || pathname === '/index.html') {
        if (!(await requireLogin(request, env))) {
            return Response.redirect(new URL('/login-page.html', request.url).toString(), 302);
        }
        return env.ASSETS.fetch(request);
    }
    ```
    現在，如果用戶沒有登入（`requireLogin` 返回 false），會被強制 302 重定向到 `/login-page.html`。如果已經登入，我們使用 `env.ASSETS.fetch(request)`，這會將請求放行給 Pages 的靜態資源伺服器來返回真正的 `public/index.html` 內容。

2.  **客戶端錯誤處理 (Client-side):**
    我們修改了 `public/admin.js` 中的 API 請求邏輯。在每一次 `fetch` 後，我們先檢查 `response.status === 401`。
    如果是 401，我們直接觸發 `location.href = '/login-page.html'`，而不是繼續呼叫 `r.json()` 去解析非 JSON 的報錯字符串。這徹底消除了控制台裡的 SyntaxError。

## 其他變更

*   修改了 `package.json` 中的腳本，將 `wrangler deploy` 和 `wrangler dev` 變更為 Pages 專用的 `wrangler pages deploy public` 和 `wrangler pages dev public`。
*   修改了 `vitest.config.mts`，讓它指向正確的 `./wrangler.toml` 而非原本不存在的 `./wrangler.jsonc`。
