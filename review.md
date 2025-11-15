# Code Review

## 檔案功能說明

### 核心檔案

**src/index.ts** - 主要路由處理器
- Cloudflare Workers 入口點
- 處理所有 HTTP 請求路由（管理介面、訂閱端點、API）
- 實作 cookie-based 登入系統
- 提供 `/sub_1`, `/sub_2` 等公開訂閱端點（需 token 驗證）

**src/update.ts** - 訂閱更新邏輯
- 從多個來源抓取訂閱資料（支援 HTTP URL、inline、data URI）
- 解析、去重、分塊處理訂閱節點
- 計算 ETag 並只更新變更的分塊
- 支援並發抓取（concurrency = 5）

**src/subscription.ts** - 訂閱協議解析與編碼
- 支援 vmess、vless、trojan、shadowsocks 四種協議
- URI 解析與編碼（雙向轉換）
- Base64 解碼處理（支援 bulk base64 訂閱）
- 標準化為統一的 `NormalizedRecord` 格式

**src/auth.ts** - 認證系統
- HMAC-SHA256 簽名的 cookie 實作
- 包含過期時間驗證
- 用於管理介面登入

**src/dedup.ts** - 去重邏輯
- 基於 `server:port:sni:id` 組合去重
- 避免重複節點

**src/fetchers.ts** - HTTP 抓取工具
- 帶 timeout 的 fetch（預設 10 秒）
- 失敗自動重試一次（300ms 延遲）

**src/cache.ts** - 邊緣快取包裝
- Cloudflare edge cache 操作
- 5 分鐘快取時間

**src/hash.ts** - SHA-256 工具
- 用於生成訂閱 token 和 ETag

**src/kv.ts** - KV 鍵名定義
- 集中管理所有 KV 鍵名

---

## 重複/冗餘代碼

### 1. ✅ Base64 編解碼重複
**位置：**
- `src/auth.ts`: `toBase64Url()`, `fromBase64Url()`
- `src/subscription.ts`: `safeBase64Decode()`, `safeBase64EncodeUtf8()`

**說明：** 兩處都實作了 Base64 編解碼，但用途不同：
- `auth.ts` 用於 URL-safe Base64（JWT 風格）
- `subscription.ts` 用於標準 Base64（訂閱協議）

**建議：** 可接受，因為需求不同（URL-safe vs 標準），且都很短。

### 2. ✅ `generateSubscriptionToken()` 重複邏輯
**位置：**
- `src/index.ts`: `generateSubscriptionToken()` - 取前 12 字元
- `src/hash.ts`: `sha256Hex()` - 完整 hash

**說明：** 不算重複，`generateSubscriptionToken` 是特定業務邏輯。

### 3. ⚠️ parseInt 重複模式
**位置：** 多處都有 `parseInt(str, 10)` 並提供預設值的模式

**建議：** 可抽取為 `parseIntOr(str, defaultValue)` 工具函數，但影響不大。

---

## 安全性問題

### 🔴 高風險

**1. 時序攻擊（Timing Attack）風險**
**位置：** `src/index.ts:52-55`
```typescript
const validToken = await generateSubscriptionToken(env.ADMIN_PASSWORD || '');
if (!token || token !== validToken) {
    return new Response('Unauthorized', { status: 401 });
}
```
**問題：** 使用 `!==` 字串比較，可能被時序攻擊破解 token
**修復：** 使用 constant-time 比較（crypto.subtle.timingSafeEqual）

**詳細說明：**

**時序攻擊是什麼？**
- `!==` 比較字串時，會從第一個字元開始逐一比對
- 一旦發現不同就立即返回 false
- 攻擊者可以測量回應時間，推測出正確字元的位置

**範例：**
```
正確 token: "abc123456789"
嘗試 1:    "xxx123456789"  -> 第 1 字元就錯，極快返回（比如 0.001ms）
嘗試 2:    "axx123456789"  -> 第 2 字元才錯，稍慢返回（比如 0.002ms）
嘗試 3:    "abx123456789"  -> 第 3 字元才錯，更慢返回（比如 0.003ms）
```
攻擊者透過測量時間差異，可以逐字元暴力破解。

**Constant-time 比較：**
- 無論字串是否相同，都會比對完所有字元
- 回應時間固定，攻擊者無法從時間推測任何資訊

**使用方式：**
```typescript
// 需要先轉成 Uint8Array
const encoder = new TextEncoder();
const tokenBytes = encoder.encode(token);
const validBytes = encoder.encode(validToken);

// 長度必須相同
if (tokenBytes.length !== validBytes.length) {
    return new Response('Unauthorized', { status: 401 });
}

const isValid = await crypto.subtle.timingSafeEqual(tokenBytes, validBytes);
if (!isValid) {
    return new Response('Unauthorized', { status: 401 });
}
```

**額外條件：**
- 兩個 buffer 長度必須相同（否則會拋錯）
- 需要先檢查長度，但這不會洩漏資訊（長度通常是固定的）

**實際風險評估：**
- 在網路環境下，時序攻擊很難成功（網路延遲遠大於比較時間）
- 但如果攻擊者在同一資料中心或有穩定低延遲連線，仍有風險
- 安全最佳實踐建議使用 constant-time 比較

**2. Bearer Token 直接比對密碼**
**位置：** `src/index.ts:177-180`
```typescript
if (auth && auth.startsWith('Bearer ')) {
    const token = auth.split(' ')[1] ?? '';
    ok = token === env.ADMIN_PASSWORD;
}
```
**問題：** 
- Bearer token 直接用明文密碼，不符合最佳實踐
- 同樣有時序攻擊風險
**建議：** 應該用 JWT 或 HMAC 簽名的 token

**詳細說明：**

**目前的問題：**
1. **密碼直接暴露在 HTTP header**
   - 如果 HTTPS 被破解或中間人攻擊，密碼直接洩漏
   - 密碼可能被記錄在 log 中（很多系統會記錄 headers）
   
2. **無法撤銷**
   - 密碼一旦洩漏，必須改密碼（影響所有使用者）
   - 無法只撤銷單一 token

3. **無過期時間**
   - 密碼永久有效，被竊取後可以一直使用

**JWT (JSON Web Token) 是什麼？**
- 一種簽名的 JSON 格式 token
- 結構：`header.payload.signature`
- 包含過期時間、發行者等資訊
- 可以驗證但無法偽造（因為有簽名）

**範例：**
```typescript
// 已經有類似實作（auth.ts 的 signCookie）
// 可以改用在 Bearer token：

// 生成 token（伺服器端）
const token = await signCookie(env.ADMIN_PASSWORD, {
    sub: 'admin',
    exp: Math.floor(Date.now() / 1000) + 3600  // 1 小時後過期
});
// 回傳給客戶端：eyJzdWIiOiJhZG1pbiIsImV4cCI6MTczMTY3ODAwMH0.a1b2c3d4...

// 驗證 token（伺服器端）
const payload = await verifyCookie(env.ADMIN_PASSWORD, token);
if (payload) {
    // token 有效且未過期
}
```

**HMAC 簽名 token 是什麼？**
- 用密鑰對資料做 hash，產生簽名
- `auth.ts` 就是用 HMAC-SHA256
- 比直接用密碼安全，因為：
  - Token 洩漏不等於密碼洩漏
  - 可以設定過期時間
  - 可以包含額外資訊（如權限、用戶 ID）

**差異比較：**
```
目前做法：
Bearer mySecretPassword123
→ 密碼直接暴露

JWT/HMAC 做法：
Bearer eyJzdWIiOiJhZG1pbiIsImV4cCI6MTczMTY3ODAwMH0.a1b2c3d4e5f6...
→ 即使被攔截，攻擊者也無法得知密碼
→ Token 過期後自動失效
→ 可以撤銷特定 token（如果加入 token ID 並記錄黑名單）
```

**需要什麼額外條件？**
- 已經有 `signCookie` 和 `verifyCookie`，可以直接用
- 不需要額外套件或資料庫
- 只需要改 `/refresh` 端點的驗證邏輯

**建議修改：**
```typescript
// 改成這樣
if (auth && auth.startsWith('Bearer ')) {
    const token = auth.split(' ')[1] ?? '';
    try {
        const payload = await verifyCookie(env.ADMIN_PASSWORD, token);
        ok = !!payload;  // 驗證簽名和過期時間
    } catch {
        ok = false;
    }
}
```

**實際風險評估：**
- 如果只有你自己用，且 HTTPS 正常運作，風險較低
- 如果是多人使用或公開服務，強烈建議改用 JWT/HMAC

### 🟡 中風險

**3. Cookie 缺少 SameSite=Strict**
**位置：** `src/index.ts:23`
```typescript
return `session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires}`;
```
**問題：** `SameSite=Lax` 允許 top-level navigation 帶 cookie，可能有 CSRF 風險
**建議：** 改用 `SameSite=Strict`（除非需要從外部連結登入）

**詳細說明：**

**SameSite 是什麼？**
- 控制 cookie 在跨站請求時是否被送出
- 三種模式：`Strict`、`Lax`、`None`

**SameSite=Lax 的行為：**
- ✅ 允許：使用者點擊連結跳轉到你的網站（top-level navigation）
- ✅ 允許：使用者直接在網址列輸入你的網址
- ❌ 禁止：iframe 嵌入、AJAX 請求、form POST（跨站）

**SameSite=Strict 的行為：**
- ❌ 禁止：所有跨站請求都不帶 cookie
- ✅ 允許：只有同站請求才帶 cookie

**實際風險場景：**

**場景 1：CSRF 攻擊（SameSite=Lax 可能被繞過）**
```html
<!-- 攻擊者的網站 evil.com -->
<a href="https://your-worker.com/remove?url=important-source">
  點我領取免費獎品！
</a>
```
1. 你已經登入 your-worker.com（有 session cookie）
2. 你在 evil.com 點了這個連結
3. **SameSite=Lax 會帶上 cookie**（因為是 top-level navigation）
4. 如果 `/remove` 端點接受 GET 請求，你的訂閱來源就被刪除了

**你的專案是否有風險？**
- ✅ 安全：你的 `/remove` 只接受 POST，不接受 GET
- ✅ 安全：你的所有修改操作都是 POST
- ⚠️ 理論風險：如果未來加入 GET 的修改操作，就有風險

**場景 2：SameSite=Strict 的副作用**
```
使用者在 Gmail 收到你的通知信：
「訂閱更新失敗，點此查看」
→ 連結到 https://your-worker.com/

使用者點擊連結：
- SameSite=Lax：帶 cookie，直接看到管理介面 ✅
- SameSite=Strict：不帶 cookie，被導向登入頁面 ❌（需要重新登入）
```

**建議：**
- 如果你的管理介面只從內部連結訪問 → 用 `Strict`
- 如果可能從外部連結（郵件、書籤、其他網站）訪問 → 用 `Lax`
- 你的專案因為所有修改都是 POST，`Lax` 已經足夠安全

**實際風險評估：**
- 你的專案目前風險很低（因為沒有 GET 修改操作）
- 如果改成 `Strict`，使用者體驗會稍差（外部連結需重新登入）
- 建議保持 `Lax`，但確保未來不要加入 GET 的修改操作

**4. 沒有 Rate Limiting**
**位置：** 所有 API 端點
**問題：** 
- `/login` 可被暴力破解
- `/refresh` 可被濫用（消耗資源）
**建議：** 加入 Cloudflare Rate Limiting 或自行實作

**詳細說明：**

**Workers 內建記憶體（不持久）**
```typescript
// 使用 Map 記錄（重啟後清空）
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    const record = rateLimitMap.get(ip);
    
    if (!record || now > record.resetAt) {
        rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
        return true;
    }
    
    if (record.count >= maxRequests) {
        return false;  // 超過限制
    }
    
    record.count++;
    return true;
}

// 使用
const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
if (!checkRateLimit(clientIP, 5, 60000)) {  // 每分鐘 5 次
    return new Response('Too Many Requests', { status: 429 });
}
```

**優點：**
- 不需要 KV 或資料庫
- 實作簡單

**缺點：**
- Worker 重啟後記錄消失
- 多個 Worker 實例不共享記錄（可能被繞過）

**5. 錯誤訊息洩漏資訊**
**位置：** `src/index.ts:192`
```typescript
return new Response(JSON.stringify({ error: 'refresh_failed', message: String(e) }), { status: 500, ...});
```
**問題：** 將完整錯誤訊息回傳給客戶端，可能洩漏內部實作細節
**建議：** 只在開發環境回傳詳細錯誤，生產環境用通用訊息

**詳細說明：**

**不需要隱藏的情況：**
1. **程式碼已開源** → 攻擊者可以直接看原始碼，隱藏錯誤意義不大
2. **只有你自己用** → 詳細錯誤訊息方便除錯
3. **錯誤不包含敏感資訊** → 如果只是 "fetch failed" 之類的，沒關係

**仍需要隱藏的情況：**
1. **錯誤包含環境變數** → 如 "ADMIN_PASSWORD is undefined"
2. **錯誤包含內部路徑** → 如 "/var/www/secret/config.json not found"
3. **錯誤包含第三方 API 金鑰** → 如 "API key abc123 is invalid"
4. **錯誤包含資料庫結構** → 如 "Column 'secret_field' does not exist"

**你的專案可能洩漏的資訊：**
```typescript
// 範例錯誤訊息
"TypeError: Cannot read property 'get' of undefined at line 42"
→ 洩漏程式碼結構

"fetch failed: https://internal-api.example.com/secret"
→ 洩漏內部 API 位址

"KV_NAMESPACE.get is not a function"
→ 洩漏配置問題（但這個還好）
```

**建議做法：**

```typescript
// 只回傳安全的錯誤類型
const safeErrors = ['timeout', 'network_error', 'invalid_format'];
const errorType = e.name || 'unknown';
const message = safeErrors.includes(errorType) ? String(e) : 'Internal server error';
```

**實際風險評估：**
建議避免洩漏：
- 環境變數值
- 內部 API 位址
- 第三方服務的金鑰或 token

### 🟢 低風險

**6. 沒有 CORS 保護**
**位置：** 所有端點
**說明：** 如果只給自己用，可接受；如果是公開服務，應該設定 CORS

**7. 訂閱 token 只有 12 字元**
**位置：** `src/index.ts:46`
```typescript
return hash.substring(0, 12);
```
**問題：** 12 hex 字元 = 48 bits，理論上可暴力破解
**建議：** 至少 16 字元（64 bits）

---

## 其他建議

### 程式碼品質

1. **✅ 良好的模組化** - 功能分離清楚
2. **✅ 型別定義完整** - TypeScript 使用得當
3. **✅ 錯誤處理** - 大部分地方都有 try-catch
4. **⚠️ 缺少輸入驗證** - URL、chunk_size 等應該更嚴格驗證

### 效能

1. **✅ 並發控制** - update.ts 有限制並發數（5）
2. **✅ 快取機制** - 使用 edge cache 和 ETag
3. **✅ 增量更新** - 只更新變更的分塊

### 可維護性

1. **✅ 註解清楚** - 關鍵邏輯都有說明
2. **✅ 命名語意化** - 函數和變數名稱清楚
3. **⚠️ Magic numbers** - 一些數字應該抽成常數（如 concurrency=5, timeout=10000）

---

## 總結

**優點：**
- 架構清晰，模組化良好
- 支援多種訂閱協議
- 有快取和去重機制
- 測試覆蓋率不錯

**需要改進：**
- 🔴 修復時序攻擊風險（高優先）
- 🟡 加強認證機制（Bearer token 不應直接用密碼）
- 🟡 加入 rate limiting
- 🟢 增加訂閱 token 長度

---

## 已實作的安全修復

### ✅ 1. Constant-time 比較
**位置：** `src/index.ts`
- 新增 `constantTimeEqual()` 函數使用 `crypto.subtle.timingSafeEqual`
- 在 `handleSubChunk()` 中使用 constant-time 比較訂閱 token
- 防止時序攻擊

### ✅ 2. HMAC 簽名 Bearer Token
**位置：** `src/index.ts:handleRefresh()`
- 改用 `verifyCookie()` 驗證 Bearer token（HMAC-SHA256 簽名）
- 不再直接比對明文密碼
- Token 包含過期時間，自動失效

### ✅ 3. Rate Limiting（記憶體版）
**位置：** `src/index.ts`
- 新增 `rateLimitMap` 和 `checkRateLimit()` 函數
- `/login` 端點：每 IP 每分鐘 5 次請求
- `/refresh` 端點：每 IP 每 10 分鐘 10 次請求
- 超過限制回傳 429 Too Many Requests

**限制：**
- Worker 重啟後記錄清空
- 多個 Worker 實例不共享（可能被繞過）
- 適合低流量或個人使用

### ✅ 4. 安全的錯誤訊息
**位置：** `src/index.ts:handleRefresh()`
- 只回傳安全的錯誤類型（TypeError, SyntaxError, AbortError）
- 其他錯誤回傳通用訊息
- 完整錯誤仍記錄到 console（可在 Cloudflare Dashboard 查看）

### ✅ 5. 訂閱 Token 長度增加
**位置：** `src/index.ts:generateSubscriptionToken()`
- 從 12 字元（48 bits）增加到 16 字元（64 bits）
- 提高暴力破解難度
- 同步更新測試檔案（`test/update.spec.ts`, `test/cache-etag.spec.ts`）

---

## 測試驗證

執行 `npm test` 確認所有測試通過：
- ✅ 訂閱 token 長度更新
- ✅ Constant-time 比較不影響功能
- ✅ Rate limiting 不影響正常請求
- ✅ 錯誤處理正常運作
