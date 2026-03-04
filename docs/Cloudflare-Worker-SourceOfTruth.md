# Cloudflare Worker — Source of Truth (Permanent)

This document is the **single source of truth** for the Cloudflare side of the project:
Google Drive Push Notifications → Cloudflare Worker + KV gate → n8n webhook.

It captures:
- what is deployed,
- what must stay consistent across tools,
- what settings to keep,
- how to sanity-check and recover.

---

## 1) Deployed assets

### Worker
- Name: `pmi-drive-watch`
- Public host (workers.dev): `https://pmi-drive-watch.elenipster.workers.dev`
- Source-of-truth code file in repo:
  - `cloudflare/worker/pmi-drive-watch.js`

### KV
- Namespace binding name in Worker: `KV`
- State key (single JSON blob): `drive_watch_state` (value of `STATE_KEY`)

### Endpoints (implemented in Worker code)
- `POST /drive/setup` — a manual endpoint you call once to **create/renew** the Drive watch channel
- `POST /drive/push` — where **Google Drive push pings** are sent
- `GET  /drive/status` — read-only debug status (no secrets)

---

## 2) Responsibility split (important)

### Worker owns (must NOT be duplicated in n8n)
- validating Drive push headers (channel/resource/token/message number)
- calling Drive `changes.list`
- filtering to “file is currently in INTAKE_FOLDER_ID”
- calling n8n webhook (only when a match is confirmed)
- dedupe (Worker-side best effort)
- persisting `pageToken` + channel state in KV
- renewing the watch channel (via Worker Cron)

### n8n owns
- webhook consumer (Production URL)
- verifying `x-worker-token`
- downstream idempotency (Notion `drive_file_id`)
- then: create/update Notion + trigger Make, etc.

**Rule:** do not keep “Drive watch/channel/changelog/token” logic in n8n. It causes conflicts and quota waste.

---

## 3) Variables and Secrets (Cloudflare)

### Secrets (must be Secret type)
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `N8N_SHARED_SECRET`

### Plaintext variables
- `INTAKE_FOLDER_ID` = `1tBji5XdYzKyXrTfhenNkmYPdmlQ2M6Jq`
- `N8N_WEBHOOK_URL` = `https://olenap.app.n8n.cloud/webhook/f20c33d1-0166-4d04-919b-e541bbac2430`
- `STATE_KEY` = `drive_watch_state`

---

## 4) Cron trigger (Cloudflare)

### Do we need Cron?
Yes. Drive watch channels **expire** and must be renewed.

### Recommended Cron expression
Default for demo:
- `*/15 * * * *`  (every 15 minutes)

Explanation:
- Cron format: `minute hour day-of-month month day-of-week`
- `*/15` in the minute field = “every 15 minutes”.

In the Cloudflare UI:
- “Schedule” view and “Cron expression” view are just two ways to set **the same** schedule.
- You only need to set it once; ensure both views describe the same cadence.

### Renewal window consistency
Worker code uses a renewal window constant:
- `RENEW_IF_EXPIRES_WITHIN_MS = 20 minutes`

This means: the Cron interval must be **shorter than 20 minutes** to guarantee at least one renewal attempt in that window.
- `*/15 * * * *` is OK.
- If you want a larger safety buffer (e.g., 60 minutes), change the constant in the Worker code and redeploy, then you can use a slower Cron.

---

## 5) How to arm / re-arm the watch

### One-time (or after any secret change)
1) `POST https://pmi-drive-watch.elenipster.workers.dev/drive/setup`  (Postman, no auth, body `{}`)
2) Confirm KV key `drive_watch_state` exists and contains:
   - `pageToken`, `channelId`, `resourceId`, `expirationMs`

---

## 6) Consistency checks (what must match)

### Cross-tool values that must be consistent
1) Worker `N8N_WEBHOOK_URL` == n8n webhook **Production URL** (must be `/webhook/...`, not `/webhook-test/...`)
2) Worker `N8N_SHARED_SECRET` == n8n “Auth” check right-value
3) Worker `INTAKE_FOLDER_ID` matches the real Google Drive folder
4) Only one state key in KV (`drive_watch_state`) is used (no parallel versions)

### Quick health check (no digging)
Open:
- `GET https://pmi-drive-watch.elenipster.workers.dev/drive/status`

Expect:
- `state` is not null
- `lastRenewError` is null
- `expirationMs` is in the future

### Proof of end-to-end processing (after one upload)
After uploading a new tiny file into the intake folder:
- KV fields must change:
  - `pageToken` changes
  - `lastMessageNumber` increases
  - `recentEmittedCount` increases (or `recentEmitted` grows)
- n8n shows exactly 1 execution for that upload

---

## 7) Operational troubleshooting

### A) `/drive/push` is hit but `pageToken` does not change
Usually means Worker returns early (e.g., duplicate message number / in-flight / token mismatch).
Recovery:
1) In KV `drive_watch_state`, set:
   - `lastMessageNumber: null`
   - `inFlightUntilMs: 0`
2) Call `POST /drive/setup` once
3) Upload a tiny new file again

### B) Worker logs show `invalid_grant` / `oauth_refresh_failed`
Refresh token is invalid/revoked/expired.
Fix:
1) Generate a new refresh token in Google Cloud
2) Replace Worker secret `GOOGLE_REFRESH_TOKEN`
3) Call `POST /drive/setup`

### C) Multiple channels / renewal thrash
Symptoms:
- `channelId` changes too frequently
Fix:
- ensure Cron cadence + renewal window are consistent
- keep only one Cron trigger
- avoid repeatedly calling `/drive/setup` manually

---

## 8) What should be backed up (and what should not be committed)

### Do NOT commit secrets
Never commit:
- refresh token
- client secret
- n8n shared secret

### Runtime state backup (optional, outside repo)
KV `drive_watch_state` JSON can be exported into:
- `Backups/drive_watch_state_<date>.json` (outside repo)

This is for recovery/debug only; it is not “source-of-truth configuration”.
