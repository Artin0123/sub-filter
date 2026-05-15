# 部署核對清單

## Cloudflare Pages

- 專案名稱：`sub-filter`
- Build output directory：`public`
- Functions 入口：`functions/[[path]].ts`

## Dashboard 必要設定

### Secrets

- `ADMIN_PASSWORD`

### KV Bindings

- binding：`KV_NAMESPACE`
- 指向正確的 KV namespace

## 本地確認

```bash
pnpm run cf:sync-config
pnpm run cf:typegen
pnpm run test
```

## 部署命令

```bash
pnpm run deploy
```

## 部署後檢查

- 未登入打 `/` 會跳到 `/login-page.html`
- 登入後能進後台
- `/list`、`/config`、`/refresh` 正常
- `sub_1?token=...` 可讀
