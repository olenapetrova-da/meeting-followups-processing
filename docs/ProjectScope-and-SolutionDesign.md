# Project Scope and Solution Design (S1 baseline, implemented)
Baseline name: Event-driven meeting recording → minutes email (Drive push → **Worker + KV gate** → n8n → Make → Notion)

This document replaces the earlier baseline where Google Drive push notifications called **n8n directly** (or where n8n used Schedule Trigger). The design goal is strict: **n8n runs only when a real new file in the target Drive folder is confirmed**.

---

## 0) Current status (as of 2026-02-25)

**Phase 1 (Concept/Plan): DONE**
- Minimal architecture agreed
- Risks + acceptance criteria defined
- Worker → n8n data contract defined

**Phase 2 (Implementation): IN PROGRESS**
- A) Google Cloud: DONE (Drive API enabled; OAuth client + refresh token available)
- B) Cloudflare: DONE (Worker deployed; KV bound; variables/secrets set; Cron configured; watch initialized)
- C) n8n: DONE (webhook-only workflow; auth header check; Notion idempotency)
- D) Drive watch initialization: DONE (`POST /drive/setup` succeeded; KV state created)
- E) Acceptance tests: BLOCKED (n8n execution quota exhausted; planned resume on **2026-03-01**)

---

## 1) Fixed inputs (this environment)

- **Drive intake folderId**: `1tBji5XdYzKyXrTfhenNkmYPdmlQ2M6Jq`
- **Worker base URL**: `https://pmi-drive-watch.elenipster.workers.dev`
- **Worker endpoints**
  - `POST /drive/push` — where Google Drive push pings will be sent
  - `POST /drive/setup` — a manual endpoint you call once to create/renew the watch
- **n8n Production webhook URL**: `https://olenap.app.n8n.cloud/webhook/f20c33d1-0166-4d04-919b-e541bbac2430`

---

## 2) Architecture (text diagram)

```
[User drops file into Drive intake folder]
            |
            v
(Drive Push Notification: changes.watch ping)
            |
            v
+---------------------------------------------+
| Cloudflare Worker (gate)                    |
| - receives push pings (cheap, not n8n)      |
| - reads KV state (pageToken + watch state)  |
| - calls Drive changes.list since pageToken  |
| - filters to "new file in folderId"         |
| - if match: POST to n8n Production webhook  |
| - updates KV pageToken + dedupe cache       |
| - renews watch via Cron (no n8n)            |
+---------------------------------------------+
            |
            v
        [n8n Webhook workflow]
            |
            v
   (auth check → Notion idempotency → Make/Notion pipeline)
```

---

## 3) What “new file in folder” means in this demo

Worker filters changes to items where:
- `file.parents` contains the intake `folderId`
- `file.trashed` is false
- and the event looks like a creation/upload (implementation uses a **createdTime vs change time** “near-equal” heuristic)

This is demo-grade reliability (good enough for the exercise, not a compliance-grade ingest).

---

## 4) Cloudflare state (what exists, where it lives)

### 4.1 KV state (single key)
KV key: `drive_watch_state` (value is a JSON blob, updated by Worker)

State includes (at minimum):
- `pageToken` (Drive changes cursor)
- `channelId`, `resourceId`, `expirationMs` (watch channel)
- `recentEmitted` (dedupe map: fileId → timestamp)
- other operational fields (`pushUrl`, `lastMessageNumber`, etc.)

### 4.2 Worker configuration (must be recreated manually if you lose it)
- KV binding name: `KV`
- Variables (Text): `INTAKE_FOLDER_ID`, `N8N_WEBHOOK_URL`, `STATE_KEY`
- Secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `N8N_SHARED_SECRET`
- Cron schedule: daily (exact cron expression is stored in Cloudflare UI)

---

## 5) Data contract: Worker → n8n

**Request**
- Method: `POST`
- URL: n8n production webhook (above)
- Headers:
  - `Content-Type: application/json`
  - `X-Worker-Token: <N8N_SHARED_SECRET>`
  - `X-Intake-Event: drive.new_file_in_folder.v1`

**Body (JSON)**
```json
{
  "fileId": "string",
  "name": "string|null",
  "mimeType": "string|null",
  "webViewLink": "string|null",
  "createdTime": "RFC3339 string|null",
  "folderId": "string",
  "dedupeKey": "drive:file:<fileId>",
  "watch": {
    "channelId": "string",
    "resourceId": "string",
    "messageNumber": "string|null"
  },
  "emittedAt": "RFC3339 string"
}
```

---

## 6) n8n workflow requirements (webhook-only)

- Trigger is **Webhook (Production URL)** only.
- No Schedule Trigger (no periodic “check” runs).
- First node after Webhook:
  - verify header `x-worker-token` equals `N8N_SHARED_SECRET`
  - if mismatch → Respond 403
- Second: Notion idempotency:
  - query Meeting Register where `drive_file_id == {{$json.fileId}}`
  - if exists → Respond 200 `{ "status": "duplicate_ignored" }`
  - else → continue pipeline (create/update Notion, call Make, etc.)

Reference workflow export: `WF-DRIVE-PUSH_intake.json`.

---



**Repo hygiene note**
- The n8n export file (`integrations/n8n/WF-DRIVE-PUSH_intake.json`) currently contains a literal value for `N8N_SHARED_SECRET` inside an IF node. Replace it with a placeholder before committing.
## 7) Acceptance criteria (E tests)

1) Upload a new file into the intake folder → **exactly 1** n8n execution starts.
2) Non-folder Drive activity → **0** n8n executions.
3) Duplicate push pings → no duplicate n8n runs (Worker dedupe and/or Notion idempotency).
4) Watch renewals happen without any n8n executions.

---

## 8) Known constraint / pause mode

When n8n execution quota is exhausted, pause ingestion to avoid **missing files**:
- Worker continues receiving pings; if it advances `pageToken` while n8n rejects, you lose events.
- Use the documented pause procedure (see Runbook).

