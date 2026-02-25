# Cloudflare Worker (source-of-truth)

Cloudflare UI is not your source-of-truth. GitHub is.

## What to commit (without leaking secrets)

1) Worker source code
- Copy the deployed Worker code from Cloudflare → Workers & Pages → pmi-drive-watch → Edit code
- Paste it into: `cloudflare/worker/index.js`

2) Config snapshot
- Commit: `docs/Cloudflare-Config-Snapshot.md`

3) KV state backups (DO NOT COMMIT)
- Cloudflare → KV → open `drive_watch_state` → copy JSON into:
  `backups/drive_watch_state_<YYYY-MM-DD>.json` (keep local)

## Secrets policy
Never commit:
- GOOGLE_CLIENT_SECRET
- GOOGLE_REFRESH_TOKEN
- N8N_SHARED_SECRET (treat as secret)

Commit only secret *names* and where they are set (Cloudflare UI).
