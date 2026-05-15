# sub-filter

Cloudflare Pages 訂閱合併與分塊服務。整合多個來源訂閱（vmess/vless/trojan/ss），自動去重並產生分塊輸出，支援 ETag/304 與邊緣快取。

## 核心功能

- **分塊輸出**：`/sub_1`、`/sub_2`…（每塊預設 400 筆，可調整）
- **Base64 編碼**：可選擇將訂閱內容 Base64 編碼（標準訂閱格式）
- **來源管理**：Web 管理面板，可新增/移除來源與調整分塊大小
- **自動更新**：`POST /refresh` 觸發抓取 → 解析 → 去重 → 寫入 KV
- **智能快取**：ETag/304 支援與 5 分鐘邊緣快取，自動檢測內容變更
- **Token 保護**：訂閱端點需提供有效 token（自動生成）
- **CI 整合**：GitHub Actions 定時更新

## 快速開始

### 1. 環境變數設定

**必要變數**：
- `ADMIN_PASSWORD` - 管理介面登入密碼（也用於生成訂閱 token）

**本地開發**：
```bash
echo "ADMIN_PASSWORD=your_password_here" > .dev.vars
```

**生產環境**（Cloudflare Pages）：
```bash
wrangler secret put ADMIN_PASSWORD
# 輸入你的密碼
```

### 2. KV Namespace 設定

**建立 KV**：
```bash
# 建立 KV namespace
wrangler kv namespace create KV_NAMESPACE

# 會得到類似輸出：
# { binding = "KV_NAMESPACE", id = "abc123..." }
```

**更新 `wrangler.jsonc`**：
```jsonc
{
  "kv_namespaces": [
    {
      "binding": "KV_NAMESPACE",  // ⚠️ 必須是 "KV_NAMESPACE"（程式碼中使用）
      "id": "你的KV_ID"            // 替換成上面建立的 ID
    }
  ]
}
```

**重要**：
- ✅ `binding` 必須是 `"KV_NAMESPACE"`（程式碼中固定使用此名稱）
- ✅ `id` 替換成你的 KV namespace ID
- ⚠️ 本地開發時 Miniflare 會自動模擬 KV，不需要真實 ID

### 3. 部署

```bash
npm install
npm run deploy
```

### 4. GitHub Actions 自動更新（可選）

如果要使用 GitHub Actions 定時更新訂閱，需要設定以下 Secrets：

**在 GitHub repo 設定 Secrets**（Settings → Secrets and variables → Actions）：

| Secret 名稱      | 說明                           | 範例                                               |
| ---------------- | ------------------------------ | -------------------------------------------------- |
| `REFRESH_URL`    | 你的 Worker 的 `/refresh` 端點 | `https://sub-filter.your-name.pages.dev/refresh` |
| `ADMIN_PASSWORD` | 與 Worker 相同的管理密碼       | `your_password_here`                               |

**注意**：
- ✅ GitHub Actions 使用 HMAC 簽名的 Bearer token（安全）
- ⏰ 預設每小時執行一次（可在 `.github/workflows/refresh.yml` 修改 cron）
- 📊 執行結果會顯示更新統計（records、chunks 等）

**手動觸發**：
- 進入 GitHub repo → Actions → Refresh Subscription → Run workflow

**Cron 時間說明**：
```yaml
# 每小時執行（預設）
- cron: "0 * * * *"

# 每 6 小時執行
- cron: "0 */6 * * *"

# 每天凌晨 2 點執行
- cron: "0 2 * * *"
```

## 架構

**平台**：Cloudflare Pages + Workers KV

**主要模組**（`src/`）：
- `index.ts` - 路由與管理面板
- `update.ts` - 更新管線（抓取/解析/去重/分塊）
- `subscription.ts` - 協議解析與編碼（vmess/vless/trojan/ss）
- `dedup.ts` - 去重邏輯（`server:port:servername:credential`）
- `fetchers.ts` - 併發抓取與重試
- `auth.ts` - HMAC Cookie 與 Bearer 驗證
- `cache.ts` - 邊緣快取封裝
- `hash.ts` - SHA-256 ETag 生成
- `kv.ts` - KV key 常數

## API 端點

**訂閱端點**（需 token）：
- `GET /sub_{i}?token=xxx` - 第 i 塊內容（1 起算，例如 `/sub_1?token=xxx`）

**管理端點**（需登入）：
- `GET /` - 管理面板
- `POST /login` / `POST /logout` - 登入/登出
- `GET /list` - 列出來源
- `POST /add` / `POST /remove` - 新增/移除來源
- `GET /config` / `POST /config` - 讀取/設定配置（`chunk_size`、`base64_encode`）

**更新端點**（需登入或 Bearer）：
- `POST /refresh` - 立即更新訂閱

## 去重邏輯

本專案的去重策略參考並改進自 [subs-check](https://github.com/beck-8/subs-check) 的實作：

**去重鍵**：`server:port:servername:credential`

**改進點**：
- ✅ **Server 正規化**：將 server 轉為小寫，避免 `Example.COM` 和 `example.com` 被視為不同節點
- ✅ **Port 驗證**：過濾 port = 0 或無效的節點
- ✅ **SNI Fallback**：支援 `servername` 或 `sni` 欄位，提升相容性
- ✅ **型別安全**：使用 TypeScript 強型別，減少執行時錯誤

**範例**：
```typescript
// 這兩個節點會被視為重複（相同連線參數）
vless://uuid123@example.com:443?sni=cdn.example.com#節點A
vless://uuid123@EXAMPLE.COM:443?sni=cdn.example.com#節點B  // 被過濾

// 這兩個節點不會被視為重複（不同 server）
vless://uuid123@server1.com:443#香港節點
vless://uuid123@server2.com:443#香港節點  // 保留
```

## 來源類型

除了標準的 HTTP(S) 訂閱 URL，本專案還支援以下特殊格式，方便測試和調試：

### 1. HTTP(S) URL - 標準訂閱連結

**用途**：從外部伺服器抓取訂閱內容

**格式**：任意 HTTP(S) URL

**範例**：
```
https://example.com/subscription
https://example.com/sub
https://example.com/api/nodes
https://example.com/v2ray
https://example.com/123
https://example.com/abc.json
```

**支援的內容格式**：
- ✅ 純文字節點列表（每行一個 URI）
- ✅ Base64 編碼的訂閱（自動偵測並解碼）
- ✅ 混合格式（部分 Base64，部分純文字）

**Base64 自動處理**（針對來源 URL 返回的內容）：

系統會智能判斷來源內容是否為 Base64 編碼：

1. **已包含協議的純文字**（如 `vless://...`）
   - 直接使用，不嘗試解碼 ✅

2. **Base64 編碼的訂閱**
   - 嘗試解碼
   - 檢查是否包含代理協議（`vmess://`、`vless://`、`trojan://`、`ss://`）
   - 如果是，使用解碼後的內容 ✅

3. **非訂閱內容**
   - Base64 解碼失敗 → 使用原始文字 ✅
   - 解碼成功但不包含代理協議 → 使用原始文字 ✅
   - 二進制檔案 → 解碼失敗，安全跳過 ✅
   - 亂碼或其他 URL（如 `http://`）→ 不匹配協議，安全跳過 ✅

### 2. `inline:` - 直接貼上內容

**用途**：最簡單的方式，直接貼上節點 URI

**格式**：
```
inline:<訂閱內容>
```

**範例**：
```
inline:vless://uuid@example.com:443?sni=example.com#節點1
trojan://password@example.com:443?sni=example.com#節點2
```

**使用場景**：
- 快速測試單個或多個節點
- 臨時添加節點而不需要建立訂閱 URL
- 開發和調試時驗證解析邏輯

### 3. `data:` - Data URL 格式

**用途**：支援標準的 [Data URL](https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/Data_URLs) 格式

**格式**：
```
data:text/plain,<內容>
data:text/plain;base64,<Base64編碼內容>
```

**範例**：
```
# 純文字
data:text/plain,vless://uuid@example.com:443#node1

# Base64 編碼
data:text/plain;base64,dmxlc3M6Ly91dWlkQGV4YW1wbGUuY29tOjQ0MyNub2RlMQ==
```

**使用場景**：
- 需要 URL 編碼的特殊字符
- 與其他工具或腳本整合（標準格式）
- 壓縮或編碼大量節點數據

### 混合使用

你可以同時使用多種來源類型：

```
https://example.com/subscription          # 標準訂閱（任意路徑）
https://example.com/sub                    # 不帶 .txt 也可以
https://example.com/api/v2ray              # API 端點
inline:vless://uuid@test.com:443#測試     # 直接貼上
data:text/plain;base64,dmxlc3M6Ly8uLi4=   # Base64 編碼
```

**注意事項**：
- ⚠️ 單個來源建議不超過 10KB
- 💡 少量節點（< 10 個）：使用 `inline:`
- 💡 大量節點：使用外部 HTTP(S) URL
- 💡 生產環境：建議使用外部 URL（更易維護）
- ✅ **URL 路徑不限格式**：`/sub`、`/123`、`/abc`、`/api/nodes` 都可以

## 配置選項

在管理面板的 **Config** 區域可以設定：

### chunk_size（分塊大小）
- **預設值**：400
- **範圍**：50 - 2000
- **說明**：每個分塊包含的節點數量。較小的值會產生更多分塊，但每個檔案更小。

### Base64 encode（Base64 編碼）
- **預設值**：關閉
- **說明**：
  - **關閉**：訂閱內容為純文字格式（每行一個節點 URI）
  - **開啟**：訂閱內容會被 Base64 編碼（標準訂閱格式，相容大部分代理工具）

**範例：**

未編碼（關閉）：
```
vless://uuid@example.com:443?sni=example.com#節點1
trojan://password@example.com:443?sni=example.com#節點2
ss://method:password@example.com:443#節點3
```

已編碼（開啟）：
```
dmxlc3M6Ly91dWlkQGV4YW1wbGUuY29tOjQ0Mz9zbmk9ZXhhbXBsZS5jb20j6IqC6bueMQp0cm9qYW46Ly9wYXNzd29yZEBleGFtcGxlLmNvbTo0NDM/c25pPWV4YW1wbGUuY29tI+iKgueCuTIKc3M6Ly9tZXRob2Q6cGFzc3dvcmRAZXhhbXBsZS5jb206NDQzI+iKgueCuTM=
```

**注意：**
- 修改設定後，點擊 **Save** 儲存
- 點擊 **Refresh Now** 立即套用新設定並更新訂閱內容
- Base64 設定變更時，所有分塊都會強制更新

## 更新流程

1. 從 KV 讀取來源清單與配置（`chunk_size`、`base64_encode`）
2. 併發抓取各來源（支援 HTTP(S)、`inline:`、`data:` 格式）
3. 解析訂閱內容（自動偵測 Base64 編碼）
4. 正規化為統一記錄結構
5. 去重（依 `server:port:servername:credential`）
6. 重新編碼為原協議 URI
7. 分塊（依 `chunk_size`）
8. Base64 編碼（如果啟用）
9. 計算各塊 ETag
10. 僅更新變更的塊（最小寫入）
11. 清理多餘舊塊
12. 回傳統計 JSON
