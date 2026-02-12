# Baseline: Event-driven meeting recording → minutes email (Drive push → n8n → Make) + Notion register

## 0) Context

This baseline is for the PMI course exercise: convert a meeting **recording** into a **meeting minutes email** using a realistic, commercial-style workflow.

**Key constraint:** avoid polling for *new files*; use an event-driven trigger.

**Chosen stack**
- **Google Drive (My Drive)** — recording storage (“document library” analogue)
- **Google Drive Push Notifications + Changes API** — event trigger (no folder polling)
- **n8n** — backend worker: change resolution, transcription, orchestration, idempotency
- **Make** — minutes formatting + email drafting/sending (PMI-aligned)
- **Notion** — register/dashboard (“SharePoint List analogue”). Write-only in the automation chain.

---

## 1) Goal and scope

### Goal
When a new recording file appears in a specific Drive folder:
1) create/update a Notion “Meeting Register” entry
2) transcribe the recording (OpenAI STT)
3) generate meeting minutes (Google Doc)
4) generate a minutes email (Gmail draft or send)
5) keep a full audit trail of statuses + links in Notion

### In scope
- Event-driven detection of new files in Drive folder
- Transcription + minutes generation + email drafting
- Basic operational safety: idempotency, retries, error status, traceability
- Artifact storage strategy (Drive / Notion / GitHub)

### Out of scope (for the exercise)
- Enterprise compliance controls (DLP, legal holds, tenant governance)
- Advanced speaker diarization accuracy guarantees
- Full SharePoint/Graph implementation

---

## 2) Architecture (text diagram)

```
[User drops file into Drive folder]
            |
            v
(Drive Push Notification: changes.watch)
            |
            v
        [n8n Webhook]
            |
            v
   (Resolve changes.list since last token)
            |
            v
  (Filter: "new file in target folder")
            |
            v
  +------------------------------+
  | n8n: backend worker          |
  | - idempotency check (Notion) |
  | - download file from Drive   |
  | - OpenAI transcription       |
  | - save transcript doc (Drive)|
  | - update Notion status/links |
  +------------------------------+
            |
            v
     (HTTP POST to Make webhook)
            |
            v
  +------------------------------+
  | Make: minutes + email        |
  | - generate minutes text      |
  | - create minutes Google Doc  |
  | - create Gmail draft / send  |
  | - update Notion status/links |
  +------------------------------+
```

---

## 3) Trigger strategy (Drive push + Changes API)

### Why not polling
Polling “Watch folder every X minutes” is simple but:
- introduces latency
- wastes operations
- conflicts with the “event-driven” learning objective

### How Drive push actually works (important)
Drive push does **not** deliver “here is the new file payload”. It delivers a notification that “something changed”.
You must:
1) keep a persisted **pageToken** (state)
2) call **changes.list** using that token
3) process the returned deltas
4) store the next token

### Recommended watch type
Use **changes.watch** (Changes API), not “watch a single file”.
Reason: it’s the robust pattern for detecting additions/moves and then filtering to your target folder.

### Folder filtering approach
For each change item, check if:
- it is a file (not trashed)
- the file’s `parents` contains the target folder ID
- the event represents a new file (or “file moved into folder”), depending on your rules

**Rule of thumb:** treat “file appears in folder” as eligible when parents contain folderId and file is not trashed.

---

## 4) State and renewal strategy

### State you must persist (minimum)
Persist these values somewhere durable (recommended: n8n workflowStaticData + optional backup JSON in Drive):
- `startPageToken` (initial snapshot token)
- `pageToken` / `nextPageToken` (cursor for changes.list)
- `channelId`
- `resourceId`
- `expiration` timestamp (ms)
- `folderId` being monitored
- last processed IDs for idempotency support (optional, but helpful)

### Renewal (unavoidable)
Drive watch subscriptions **expire**. “No polling” is achievable for new file detection, but you still must renew the watch channel before expiration.

**Baseline approach**
- A small n8n “renewal” workflow runs on a schedule (e.g., daily).
- If `expiration` is within a threshold (e.g., next 24–48h), renew:
  - stop old channel (optional, but cleaner)
  - request a new `changes.watch` channel
  - update stored `channelId/resourceId/expiration`

### Resync strategy (when state is lost)
If page tokens are lost or invalid:
- call `changes.getStartPageToken`
- set that as the new baseline
- accept that you may miss historical changes since the last known token
- document this as a known limitation for the exercise

---

## 5) Notion register schema + idempotency

### Role of Notion in the chain
Notion is **not** a trigger. It is the operational register:
- status tracking
- clickable links to artifacts
- manual correction point (participants, title) if needed
- error visibility

### Database: “Meeting Register”
Recommended properties (types in parentheses):
- `drive_file_id` (Text) — primary idempotency key
- `drive_file_name` (Text)
- `drive_file_url` (URL)
- `status` (Select): NEW / TRANSCRIBING / TRANSCRIBED / MINUTES_READY / EMAIL_DRAFTED / DONE / ERROR
- `recording_created_at` (Date) — from Drive file metadata
- `transcript_doc_url` (URL)
- `minutes_doc_url` (URL)
- `email_draft_url_or_id` (Text/URL)
- `participants` (Text) — optional for the exercise
- `error_message` (Text)
- `run_id` (Text) — for traceability between n8n and Make runs

### Idempotency rule (mandatory)
Before processing a candidate Drive file, query Notion by `drive_file_id`:
- if exists with status DONE → skip
- if exists with status PROCESSING/TRANSCRIBING → skip or dedupe (depends on your retry logic)
- if not exists → create row and proceed

This prevents duplicates caused by:
- repeated Drive notifications
- retries
- Make webhook resends

---

## 6) Make scenario responsibilities + webhook notes

### Make trigger
- **Custom Webhook** (instant)

### Make responsibilities
Input from n8n should include:
- `notion_page_id`
- `drive_file_url`
- `transcript_text` or `transcript_doc_url`
- `meeting_title` (derived from filename or Notion)
- `run_id`

Steps:
1) Generate minutes content from transcript (LLM prompt)
2) Create a Google Doc for minutes
3) Create Gmail draft (or send email) to participants
4) Update Notion page with:
   - minutes doc link
   - draft id/link
   - final status DONE (or ERROR)

### Notes
- Make should treat the incoming webhook as potentially duplicated and be safe to re-run (idempotent updates to Notion).
- If sending emails, prefer drafting first for the exercise; sending can be a second step.

---

## 7) Security and privacy notes

Minimum baseline controls:
- Drive folder should not be public; use restricted sharing.
- Use least-privilege OAuth scopes for Drive access.
- Do not store the raw recording outside Drive.
- Do not commit transcripts/minutes/emails to GitHub.
- Make and n8n should store API keys as secrets (credentials manager / env vars), not inside exported files.
- Decide retention:
  - keep transcripts/minutes in Drive for X days/months
  - keep Notion register indefinitely (or with an archival policy)

OpenAI usage:
- Treat meeting content as potentially sensitive; ensure this is acceptable under your organization’s policy before using external APIs.

---

## 8) Failure modes + runbook pointers

### Common failure modes
- Watch channel expired → no notifications arrive
- Token drift / invalid pageToken → changes.list fails
- Duplicate notifications → double processing without idempotency
- Drive permissions / download failures (shared links not accessible)
- OpenAI transcription errors (file too large, unsupported format)
- Make webhook unavailable → minutes/email step fails

### Runbook pointers (baseline)
- Renewal: verify `expiration` and renew channel before expiry
- Replay: allow manual “reprocess” by setting Notion status back to NEW and/or using a controlled re-run workflow with a specific Drive file id
- Recovery: if tokens lost, reinitialize from `getStartPageToken`
- Observability: store `run_id` and include it in n8n + Make logs and in Notion

---

## 9) Project artifacts and storage plan

### 9.1 Google Drive (operational artifacts)
Root: `PMI_GenAI_MeetingMinutes/`
- `00_intake/` — raw recordings (drop here)
- `01_transcripts/` — transcript Google Docs
- `02_minutes/` — meeting minutes Google Docs
- `03_email_exports/` — optional: email body exports (txt/html)
- `_system/` — optional: backups/state snapshots (no secrets)

Naming convention:
- `YYYY-MM-DD__<meeting-slug>__recording.ext`
- `YYYY-MM-DD__<meeting-slug>__transcript.gdoc`
- `YYYY-MM-DD__<meeting-slug>__minutes.gdoc`

### 9.2 GitHub (versioned project artifacts, no data)
Repo structure:
- `docs/`
  - `baseline.md` (this file)
  - `runbook.md` (ops checklist)
  - `prompts.md` (minutes/email prompt templates + rationale)
- `workflows/`
  - `n8n/` (exported workflows JSON)
  - `make/` (exported blueprints JSON)
- `schemas/`
  - `notion_db_properties.md`
- `samples/`
  - redacted webhook payloads
  - redacted transcript snippet + expected minutes output

### 9.3 Notion (ops register)
Database: `Meeting Register`
- statuses + links + errors + traceability
- optional “manual override” properties if you want human-in-the-loop

---

## References
- Google Drive Push Notifications: https://developers.google.com/workspace/drive/api/guides/push
- Drive Changes (list/watch): https://developers.google.com/workspace/drive/api/reference/rest/v3/changes
- n8n Webhook node: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/
- n8n Drive push workflow example: https://n8n.io/workflows/6106-monitor-file-changes-with-google-drive-push-notifications/
- Make webhooks: https://help.make.com/webhooks
- Notion database query: https://developers.notion.com/reference/post-database-query
