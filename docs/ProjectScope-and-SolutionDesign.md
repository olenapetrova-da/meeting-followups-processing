# Project Scope and Solution Design (updated)
Baseline name: Event-driven meeting recording → minutes email (Drive push → **Worker gate** → n8n → Make) + Notion register

This document replaces the earlier baseline where Google Drive push notifications called **n8n directly**. The reason for the change is operational: on n8n **Starter** (2500 executions/month), any Drive push “noise” (and/or duplicated watch channels) can burn the quota even if the workflow exits early. The new design guarantees: **n8n runs only when a real new file in the target folder is confirmed**.

---

## 0) Context

PMI course exercise: convert a meeting **recording** into a **meeting minutes email** using a realistic workflow.

**Hard constraint (this project):**
- **No n8n executions “just to check”.**
- n8n should execute **only** when a **new file appears in the specified Drive folder**.

**Chosen stack**
- **Google Drive (personal / My Drive)** — recording storage (“document library” analogue)
- **Google Drive Push Notifications + Changes API** — event trigger (push pings + delta fetch)
- **Cloudflare Worker (Free) + KV (Free)** — **filter gate + state** (pageToken + channel data), so n8n is called only on true events
- **n8n (Starter)** — backend worker for transcription/orchestration (runs only on true events)
- **Make (Free)** — minutes formatting + email drafting/sending
- **Notion (Free)** — register/dashboard (“SharePoint List analogue”). Write-only in automation chain.

---

## Glossary (on-demand)

- **Watch channel**: a subscription that tells Google where to send push pings (expires; must be renewed).
- **pageToken**: a cursor used by Drive `changes.list` to fetch “what changed since last time”.
- **KV**: Cloudflare built-in key/value storage (we store one JSON blob with watch + pageToken state).

---

## 1) Goal and scope

### Goal
When a new recording file appears in a specific Drive folder:
1) create/update a Notion “Meeting Register” entry
2) transcribe the recording (OpenAI STT)
3) generate meeting minutes (Google Doc)
4) generate a minutes email (Gmail draft or send)
5) keep an audit trail of statuses + links in Notion

### In scope
- Event-driven detection of new files in a Drive folder (no folder polling in n8n)
- Worker-side filtering to guarantee n8n runs only on true events
- Transcription + minutes generation + email drafting
- Basic operational safety: idempotency, retries, error status, traceability
- Artifact storage strategy (Drive / Notion / GitHub)

### Out of scope (for the exercise)
- Enterprise compliance controls (DLP, legal holds, tenant governance)
- Advanced diarization accuracy guarantees
- Full SharePoint/Graph implementation

---

## 2) Architecture (text diagram)

```
[User drops file into Drive folder]
            |
            v
(Drive Push Notification: changes.watch ping)
            |
            v
+---------------------------------------------+
| Cloudflare Worker (gate)                    |
| - receives push pings (cheap, not n8n)      |
| - reads KV state (pageToken, channel data)  |
| - calls Drive changes.list since pageToken  |
| - filters: new file IN target folder        |
| - if match: POST to n8n webhook             |
| - updates KV pageToken + dedupe cache       |
+---------------------------------------------+
            |
            v
        [n8n Webhook: /new-intake-file]
            |
            v
  +-------------------------------------------+
  | n8n: backend worker (runs only on events) |
  | - idempotency check (Notion by file_id)   |
  | - download file from Drive                |
  | - OpenAI transcription                    |
  | - save transcript doc (Drive)             |
  | - update Notion status/links              |
  +-------------------------------------------+
            |
            v
     (HTTP POST to Make webhook)
            |
            v
  +-------------------------------------------+
  | Make: minutes + email                     |
  | - generate minutes text                   |
  | - create minutes Google Doc               |
  | - create Gmail draft / send               |
  | - update Notion status/links              |
  +-------------------------------------------+
```

---

## 3) Trigger strategy (Drive push + Changes API + Worker gate)

### Why not n8n direct push
Drive push does **not** send “new file payload”. It sends “something changed” pings.
If n8n is the webhook target, **every ping is an n8n execution** (even if later filtered). This violates the project constraint.

### How Drive push works (actual mechanics)
1) Worker creates a **watch channel** using `changes.watch`.
2) Google sends push pings to Worker when “something changed”.
3) Worker calls `changes.list` using stored **pageToken** to get actual deltas.
4) Worker filters deltas for “new file in target folder”.
5) Worker calls n8n **only** when a real match exists.

### Folder filter rule (demo-safe)
A change is eligible when:
- item is a file (not trashed)
- file `parents` contains the target `folderId`
- event indicates appearance in folder (created or moved into folder)

Note: Drive changes can be noisy (renames, metadata, unrelated folder changes). Worker absorbs that noise; n8n does not.

---

## 4) State and renewal strategy (moved out of n8n)

### State you must persist (minimum)
Persist a single KV record (one key, e.g. `drive_watch_state`) with:
- `folderId`
- `pageToken` (cursor for `changes.list`)
- `channelId`
- `resourceId`
- `expiration` timestamp (ms)
- dedupe cache (small list/set of recently-emitted fileIds; optional but recommended)

### Renewal (unavoidable; still “no polling in n8n”)
Watch channels expire. Renewal is handled by **Worker Cron Trigger**, not n8n.

Renew logic (daily Cron is enough for demo):
- If `expiration` is within threshold (e.g., 48h), renew:
  - stop old channel (optional but cleaner)
  - create new `changes.watch`
  - update KV with new `channelId/resourceId/expiration`

### Resync strategy (when state is lost)
If pageToken is missing/invalid:
- call `changes.getStartPageToken`
- store it as the new baseline
- accept that you may miss changes between loss and reset (documented limitation)

---

## 5) Notion register schema + idempotency

### Role of Notion
Notion is **not** a trigger. It is the register:
- status tracking
- clickable links to artifacts
- manual correction point (participants/title) if needed
- error visibility

### Database: “Meeting Register”
Recommended properties:
- `drive_file_id` (Text) — primary idempotency key
- `drive_file_name` (Text)
- `drive_file_url` (URL)
- `status` (Select): NEW / TRANSCRIBING / TRANSCRIBED / MINUTES_READY / EMAIL_DRAFTED / DONE / ERROR
- `recording_created_at` (Date)
- `transcript_doc_url` (URL)
- `minutes_doc_url` (URL)
- `email_draft_url_or_id` (Text/URL)
- `participants` (Text) — optional
- `error_message` (Text)
- `run_id` (Text)

### Idempotency rule (mandatory)
n8n must query Notion by `drive_file_id` before processing:
- exists with DONE → skip
- exists with PROCESSING/TRANSCRIBING → skip or controlled retry
- not exists → create row and proceed

Worker may also dedupe pings, but **Notion check is the final gate**.

---

## 6) Make scenario responsibilities

### Make trigger
- Custom Webhook (instant) from n8n

### Make responsibilities
Input from n8n should include:
- `notion_page_id`
- `drive_file_url`
- `transcript_text` or `transcript_doc_url`
- `meeting_title` (from filename or Notion)
- `run_id`

Steps:
1) Generate minutes content from transcript (LLM prompt)
2) Create a Google Doc for minutes
3) Create Gmail draft (or send)
4) Update Notion page with minutes link, draft id/link, DONE/ERROR

---

## 7) Security and privacy notes (exercise-level)

- Drive folder restricted sharing only.
- Store Google OAuth refresh token and API keys only in secrets/credentials (Worker secrets, n8n credentials, Make connections).
- Do not commit transcripts/minutes/emails to GitHub.
- Keep raw recording in Drive only.

---

## 8) Failure modes + runbook pointers (updated)

### Common failure modes
- Watch channel expired → no pings arrive (fix: Worker renew)
- Token invalid → `changes.list` fails (fix: Worker resync from startPageToken)
- Duplicate pings → Worker dedupe + Notion idempotency
- Drive permissions / download failure
- OpenAI transcription errors
- Make webhook unavailable
- Worker cannot refresh OAuth token (fix: re-authorize and update refresh token secret)

### Runbook pointers
- Worker KV should show current `expiration` and `pageToken`
- If no events for long time: verify watch still valid and Worker endpoint reachable
- If missed events after state loss: reinitialize token and document limitation

---

## 9) Project artifacts and storage plan (unchanged)

### 9.1 Google Drive (operational artifacts)
Root: `PMI_GenAI_MeetingMinutes/`
- `00_intake/` — raw recordings (drop here)
- `01_transcripts/` — transcript Google Docs
- `02_minutes/` — meeting minutes Google Docs
- `03_email_exports/` — optional exports
- `_system/` — optional state snapshots (no secrets)

Naming:
- `YYYY-MM-DD__<meeting-slug>__recording.ext`
- `YYYY-MM-DD__<meeting-slug>__transcript.gdoc`
- `YYYY-MM-DD__<meeting-slug>__minutes.gdoc`

### 9.2 GitHub (versioned project artifacts, no data)
- `docs/` (this document, runbook, prompts)
- `workflows/` (`n8n/`, `make/`)
- `schemas/` (Notion db properties)
- `samples/` (redacted payloads)

### 9.3 Notion (ops register)
Database: `Meeting Register` (statuses + links + traceability)

---

## References
- Google Drive Push Notifications: https://developers.google.com/workspace/drive/api/guides/push
- Drive Changes (list/watch): https://developers.google.com/workspace/drive/api/reference/rest/v3/changes
- n8n Webhook node: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/
- Make webhooks: https://help.make.com/webhooks
- Notion database query: https://developers.notion.com/reference/post-database-query
