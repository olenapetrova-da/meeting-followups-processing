# Architecture Decision Records

## ADR-001: Use an Apps Script web app to create Drive/Docs files instead of the n8n Service Account

**Date:** 2026-06-10
**Status:** Accepted

**Context:**
The n8n processing workflow (`MEET-PROCESSING_transcribe`) needs to create a new Google Doc (transcript) in a Drive folder. The existing n8n Google credential is a Service Account (`Google Service Account account`).

**Problem:**
Service Accounts have **zero Drive storage quota** on personal (non-Workspace) Google accounts. Any "create file" operation (Docs, Drive upload, etc.) via the Service Account fails with `storageQuotaExceeded`, even when the target folder is shared with the Service Account with Editor access. Read/download operations work fine — only file creation is blocked.

**Decision:**
Create files (transcript Doc, and later the minutes Doc) via a small **Google Apps Script web app** (`PMI-drive-actions`, source in `integrations/apps-script/PMI-drive-actions.gs`), deployed as "Execute as: Me" (the user's own Google account), "Who has access: Anyone". The script:
- Validates a shared-secret token (`SHARED_SECRET`, stored in Apps Script Script Properties and in `.env`)
- Creates the Doc via `DocumentApp.create()` (runs as the user → has quota)
- Moves it into the target Drive folder
- Returns `docId` and `webViewLink`

n8n calls this web app via an `HTTP Request` node (`WEB_APP_URL` + `SHARED_SECRET` from `.env`), instead of the native `n8n-nodes-base.googleDocs` node.

**Consequences:**
- The old `Docs: create transcript Google Doc` node (Service Account, `googleDocs`) is kept in the workflow JSON but `disabled: true`, for reference.
- Any future "create a new file" step (e.g., the minutes Doc in the Make/Stage 3 scenario, if done via n8n) must use the same Apps Script pattern, not the Service Account credential.
- New required env vars: `WEB_APP_URL`, `SHARED_SECRET` (added to `.env` and `.env.example`).
