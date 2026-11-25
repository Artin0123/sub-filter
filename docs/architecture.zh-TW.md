# 架構說明

## 平台

- Cloudflare Pages
- Pages Functions
- Workers KV
- Workers Cache API（`caches.default`，只用於訂閱分塊）

## 入口與分層

- `functions/[[path]].ts`
  - Pages 正式 catch-all 入口
- `src/index.ts`
  - 對外薄入口，含全域錯誤邊界（未預期例外一律記錄並回 `{"error":"internal_error"}`）
- `src/routes/`
  - `index.ts`：路徑與 HTTP method 的唯一分發表
  - `admin.ts`、`auth.ts`、`subscription.ts`、`static.ts`：各端點 handler
- `src/services/`
  - `session.ts`：後台 session / Bearer token 驗證、訂閱 token 產生與驗證、常數時間比較
  - `config.ts`：後台設定讀寫、`chunk_size` 正規化
  - `source-store.ts`：來源清單的格式校驗與持久化
  - `refresh.ts`：刷新流程外殼（含去抖動鎖）
- `src/update.ts`
  - 更新管線：抓取 → 解碼/解析 → 去重 → 分塊 → 比對 ETag → 寫 KV
- `src/subscription.ts`、`src/dedup.ts`
  - 訂閱內容解析與去重
- `src/fetchers.ts`
  - 來源 → 文字的單一入口：scheme 分流、私網位址封鎖、timeout、重試、大小上限
- `src/cache.ts`
  - edge cache 與訂閱回應 cache 策略常數
- `src/auth.ts`、`src/hash.ts`、`src/kv.ts`
  - HMAC token 簽章、SHA-256、KV key 集中定義
- `src/lib/`
  - `cookies.ts`、`env.ts`、`http.ts`、`async.ts`（有上限的併發 map）
- `public/`
  - 靜態資產與登入頁 / 後台頁

## 請求流程

1. 請求進入 `functions/[[path]].ts`，轉交 `src/index.ts` 的 `handleRequest()`
2. `src/routes/index.ts` 依 pathname 比對路由表，並檢查該路徑允許的 HTTP method
3. 未命中任何 API 路徑時，交給 `handleStaticRequest()`：
   - `/` 與 `/index.html` 先驗證登入，未登入則 302 到 `/login-page.html`
   - 其餘交給 `env.ASSETS.fetch(request)`
4. 訂閱分塊另外走 cache 流程：
   - 驗 token → 讀 `chunks_total` → 檢查 `If-None-Match` → 讀 edge cache（ETag 需與 KV 一致）→ 讀 KV → 回填 cache

## 路由與 method 契約

路由表（`ROUTES`）同時決定「哪個 handler」與「允許哪些 method」；未列出的 method 回 `405` 並附 `Allow` header。
`/sub_{i}` 走獨立分支，只接受 GET 與 HEAD（HEAD 不經 Cache API，因為 `cache.put()` 只接受 GET）。
完整端點清單見 [README 的 API 章節](../README.md#api)。

## 驗證邊界

- **管理 API**：session cookie 或 `Authorization: Bearer <token>`
  - 兩者共用同一套 HMAC-SHA256 簽章格式，驗證標準一致（都要求 payload 的 `sub === 'admin'`）
  - 有效期由 payload 的 `exp` 決定
- **`/login`**
  - 密碼比較使用常數時間比較
  - per-isolate 的盡力而為限流：同一 IP 每分鐘 5 次；`Map` 有過期清掃與 1024 筆上限
  - 跨 colo 的暴力破解防護需在 Cloudflare 層用 WAF rate limiting rule
- **訂閱端點**
  - token 是 24 bytes 隨機值的 base64url（32 字元），存在 KV 的 `subscription_token`
  - token 只由 `GET /config` 建立；`/sub_{i}` 只讀取，匿名請求不會寫 KV，也不會引發多 colo 同時建立而互相覆蓋
  - token 沒有 TTL 與輪換機制：寫入後就一直有效，只有手動刪除或覆寫該 key（例如重建 namespace）才會變更
  - 撤銷方式：刪除 KV 的 `subscription_token`，`/sub_{i}` 立即回 401，下一次 `GET /config` 重新產生；KV 是最終一致性，全球生效約需 60 秒
  - 驗證使用常數時間比較；KV 內沒有 token 時一律視為未授權
  - token 與 `ADMIN_PASSWORD` 沒有推導關係：訂閱 URL 外流不等於密碼可被離線破解
- **來源位址**
  - scheme 白名單：`http(s)://`、`inline:`
  - `http(s)` 來源在 `addSource()` 與 `fetchSource()` 兩處都會檢查 hostname，
    擋掉 localhost、`*.localhost`、`*.local`、`*.internal`、私有網段、link-local（含雲端 metadata）、
    multicast/reserved，以及 IPv6 unique-local / link-local / multicast / IPv4-mapped
  - `new URL()` 會先把 `2130706433`、`0x7f.0.0.1`、`127.1` 等寫法正規化成標準 IPv4，
    因此檢查正規化後的 hostname 即可
  - IPv6 另外封鎖內嵌 IPv4 的轉換形式：NAT64（`64:ff9b::/96`、`64:ff9b:1::/48`）與 6to4（`2002::/16`）
  - 未涵蓋：DNS rebinding（例如 `10.0.0.1.nip.io` 解析後才指向私有位址）。Workers 沒有 DNS API，
    hostname 檢查無法得知解析結果；要完全封死需在 Cloudflare 層加存取規則

## 訂閱更新與去重管線

1. **抓取來源**：`fetchSource()` 依 scheme 分流；外部 HTTP 以併發上限 5 抓取，逾時 10 秒，
   只對可恢復的失敗（網路錯 / 408 / 429 / 5xx）重試一次；回應以串流讀取並在超過大小上限時中止。
   失敗的來源會以 `{ url, error }` 列在 `RefreshResult.failedSources`，`perSource` 只提供計數。
2. **解碼與解析**：自動偵測批量 Base64 訂閱並解碼，逐行解析代理 URI（支援 `vmess`、`vless`、`trojan`、`ss`、`hysteria2` / `hy2`）；
   不支援或格式異常的行會計入 `failedByScheme`。
3. **全局去重**：合併所有來源後統一去重（涵蓋單一來源內部與跨來源重複），保留最先出現的節點。
   判重鍵為 `type:server:port:sni:method:憑證:variant`：
   - `server`、`sni` 轉小寫；`port` 必須落在 1–65535
   - `variant` 是解析階段算出的傳輸層指紋（query 參數排序後的 `k=v` 串；vmess 用 JSON 去掉名稱欄位後排序；ss 取 `?` 之後的 plugin 參數），
     用來區分「同一組 server/port/uuid/sni 但 ws/tcp 不同、reality 公鑰不同、ss plugin 不同」的節點
   - 節點名稱（`#fragment` / vmess `ps`）不列入比較
4. **分塊與寫入**：保留 `rawUri` 依 `chunk_size` 分塊（可選 Base64 編碼），
   既有 ETag 以每批 100 個 key 分批讀回（KV 單次多鍵 get 的上限），
   僅在內容 ETag 變化或編碼設定切換時平行寫入 KV（併發上限 5），並清理多餘舊分塊。
5. **編碼旗標**：`last_base64_setting` 只在所有分塊寫入成功之後才更新。
   若中途失敗就提前翻新，下一次刷新會誤以為編碼沒變而不再重寫，輸出格式會停在舊設定。

## KV key 一覽

| key | 內容 |
| --- | --- |
| `sources` | 來源清單（JSON string array） |
| `source_filters` | 各來源的協議過濾（JSON：`{ [url]: ProtocolType[] }`，無紀錄 = 不過濾） |
| `chunk_size` | 分塊行數（讀取時經 `normalizeChunkSize()` 正規化） |
| `base64_encode` | `'1'` = 輸出 Base64 |
| `last_base64_setting` | 上次成功輸出時使用的編碼設定 |
| `chunks_total` | 分塊總數 |
| `sub_txt_{i}` | 第 i 塊內容 |
| `etag_{i}` | 第 i 塊內容的 SHA-256（輸出時加上引號成為合法 ETag） |
| `last_updated_iso` | 上次刷新時間 |
| `last_stats` | 上次刷新的統計（`/debug` 用） |
| `subscription_token` | 訂閱端點用的隨機 token |
| `refresh_started_at` | 刷新鎖時間戳（盡力而為，60 秒） |

## 配置來源

- 線上
  - Cloudflare Dashboard 為準
- 本地
  - `.dev.vars`：本地 secret
  - `.local/wrangler.toml`：需要時才由 `npm run cf:sync-config` 下載，不進版控
- 測試
  - `wrangler.vitest.toml` + `vitest.config.mts`：透過 `@cloudflare/vitest-plugin` 與 Miniflare 提供獨立的 Workers 測試環境與測試用 `ADMIN_PASSWORD`

## 已知問題（刻意保留，尚未修）

### `parseBody()` 會對已消耗的 body 二次讀取

`src/lib/http.ts`：

```ts
if (ct.includes('application/json')) return await req.json(); // 解析失敗時 body 已被讀完
...
const text = await req.text(); // 這裡會拋 Body has already been used
```

影響（以 `SELF.fetch` 探針實測確認）：

- `content-type: application/json` 且內容不是合法 JSON → 拋 `TypeError: Body has already been used`，回 500
- JSON 內容為 `null`（或非物件）→ 讀取 `body.url` 時拋 `TypeError`，回 500

目前由 `src/index.ts` 的全域錯誤邊界接住，回應是 `{"error":"internal_error"}` 且錯誤進 log，但正確行為應為 400。

**為何先不改**：改成單次讀取會連帶改變 `application/x-www-form-urlencoded` 與空 body 的解析路徑，
需要先確認所有呼叫端。建議的修法（待辦）：

```ts
export async function parseBody(req: Request): Promise<Record<string, unknown>> {
	const ct = req.headers.get('content-type') || '';
	const text = await req.text();          // 只讀一次
	if (!text) return {};
	if (ct.includes('application/json')) {
		try {
			const parsed = JSON.parse(text);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}
	return Object.fromEntries(new URLSearchParams(text)); // 同時涵蓋 urlencoded
}
```

對應測試待補：畸形 JSON、JSON `null`、空 body、urlencoded。
