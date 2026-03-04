# Runbook: Drive watch gate (Cloudflare Worker + KV)

This runbook is for the demo-grade pipeline:
Drive push → Worker+KV gate → n8n webhook → Make → Notion.

---

## 1) One-time setup

### 1.1 Initialize / renew the watch channel
Call:
- `POST https://pmi-drive-watch.elenipster.workers.dev/drive/setup`

Expected:
- JSON response contains `ok: true`
- KV key `drive_watch_state` exists and includes `pageToken`, `channelId`, `resourceId`, `expirationMs`

---

## 2) Pause / resume (when n8n quota is exhausted)

### 2.1 Pause (stop advancing pageToken)
Cloudflare Dashboard → KV → open key `drive_watch_state` and set:
- `inFlightUntilMs` to a far-future timestamp (example: year 2100)

Then:
- Disable Worker Cron trigger (so renewal doesn’t overwrite pause-related fields)

Result:
- `/drive/push` ignores pings (“in_flight”) and does not progress tokens.

### 2.2 Resume
1) Re-enable Worker Cron
2) Set `drive_watch_state.inFlightUntilMs` back to `0`
3) Call `POST /drive/setup` once (safe)
4) Run acceptance test E1 (upload file → exactly one n8n execution)

---

## 3) Troubleshooting

### 3.1 /drive/setup returns an error
Check:
- Worker secrets exist and are correct:
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`
- Google Drive API is enabled in the GCP project
- OAuth consent / test user access isn’t blocking the account

Then:
- Cloudflare Worker logs for `oauth_refresh_failed` or `drive_api_failed`

### 3.2 No n8n execution after uploading a file
Check in this order:
1) Worker KV `drive_watch_state` exists and pageToken changes over time
2) Worker logs show `emittedCount > 0`
3) n8n Webhook is active (workflow active, Production URL)
4) n8n blocked by execution quota

### 3.3 Duplicate n8n runs
Check:
- Worker KV `recentEmitted` is being populated
- Notion idempotency step is before any “create” step, and uses `{{$json.fileId}}`

---

## 4) What to “save” from Cloudflare (so it’s reproducible)

You cannot export Cloudflare configuration as a single file from the UI.
For GitHub traceability, store these artifacts in the repo:

1) **Worker source code** (copy from Cloudflare editor into a file in repo)
2) **Config snapshot** (names of vars/secrets, cron schedule, KV binding name)
3) **KV state export** (copy the JSON value of `drive_watch_state` into a local file for backup; do NOT commit secrets)

Use the included template: `docs/Cloudflare-Config-Snapshot.md`.

## Watch renewal (Cloudflare Cron)

- Add **one** Cron trigger on the Worker (no n8n schedule).
- Recommended schedule for demo: `*/15 * * * *` (every 15 minutes).
- Renewal logic must **not** thrash:
  - renew only when `expirationMs` is close (<= 20 minutes)
  - on any (re)watch (`/drive/setup` or renewal), reset `lastMessageNumber` to `null` to avoid `duplicate_message_number` lockout.

**Consistency checks**
- In KV `drive_watch_state`, `channelId` should stay stable most of the time (only changes on renew).
- After an upload: `pageToken` changes and `recentEmitted` grows.

## Refresh token stability

- If your Google OAuth consent screen is **External + Testing**, Google may revoke refresh tokens after ~7 days.
- For demo: acceptable; mitigation is to regenerate and replace `GOOGLE_REFRESH_TOKEN` in Worker secrets.
- To reduce manual renewals: switch the consent screen publishing status to **In production** for your project (still a private demo app).
