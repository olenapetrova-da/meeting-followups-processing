# Workspace Migration Analysis

**Date:** 2026-06-19
**Status:** Analysis only — not a current decision

This document captures how the pipeline would change if the project moved from a personal Google account to Google Workspace. It is a reference for future planning, not an action item.

---

## Context

The current stack runs on a personal Google account. Several workarounds exist because of personal account limitations:

- **ADR-001** (Apps Script web app) — Service Account has zero Drive storage quota on personal Google; file creation requires a workaround.
- **Zoom as recorder** — Google Meet on personal Google has no recording or transcription features.
- **Manual upload** — recordings are saved locally by Zoom and uploaded to Drive manually.
- **OAuth refresh token instability** — External OAuth app in Testing mode; Google may revoke refresh tokens after ~7 days.

---

## What Workspace unlocks

### Google Meet recording (Business Standard+)
Meet automatically saves recordings to Drive when the meeting ends. The file is named after the Calendar event title, e.g. `Project Name meeting 2026-03-28.mp4`. No Zoom, no local folder, no manual upload.

### Google Meet transcription (Business Standard+)
Meet auto-generates a text transcript and saves it to Drive alongside the recording. If the transcript is used as pipeline input instead of the audio file, the Whisper API call is eliminated entirely — the slowest and most expensive step in the current pipeline.

### Service Account Drive quota
Service Accounts under a Workspace domain have real Drive storage quota. The Apps Script web app workaround (ADR-001) is no longer needed. n8n can create Docs files directly via the Service Account credential.

### Stable OAuth tokens
Internal Workspace apps are not subject to the 7-day refresh token revocation applied to External + Testing apps. Token stability is no longer a manual maintenance concern.

### Calendar attendees with display names
Workspace Calendar attendees are organization members. The Calendar API returns `attendees[].displayName` reliably, making the title and participants lookup unambiguous.

---

## Pipeline comparison

### Current (personal Google)

```
Zoom records locally
→ manual upload to Drive intake folder
→ Cloudflare Worker (push notification gate)
→ n8n:
    - idempotency check (Notion)
    - Drive download
    - OpenAI Whisper (transcription)
    - Apps Script web app (create transcript Doc)
    - Notion status update
    - POST to Make
→ Make:
    - GPT-4o-mini (minutes from transcript)
    - Create minutes Google Doc
    - Gmail draft
    - Notion DONE
```

### With Workspace (Business Standard)

```
Google Meet ends
→ Drive auto-saves recording + transcript (named after Calendar event title)
→ Cloudflare Worker (push notification gate — unchanged)
→ n8n:
    - idempotency check (Notion)
    - Calendar API lookup (attendees — optional if Meet names file correctly)
    - Read transcript from Drive (skip Whisper)
    - Create transcript Doc directly via Service Account (no Apps Script)
    - Notion status update
    - POST to Make
→ Make:
    - GPT-4o-mini (minutes from transcript)
    - Create minutes Google Doc
    - Gmail draft
    - Notion DONE
```

---

## Components removed on Workspace

| Component | Current role | On Workspace |
|---|---|---|
| Zoom | Recording | Eliminated |
| Local folder / manual upload | Required step | Eliminated |
| Local file watcher (future) | Needed for automation | Eliminated |
| OpenAI Whisper | Transcription | Optional — Meet transcript replaces it |
| Apps Script web app (`PMI-drive-actions`) | ADR-001 workaround | Eliminated |
| OAuth token rotation | Manual maintenance task | Eliminated |

---

## What stays the same

- **Cloudflare Worker gate** — Drive push noise absorption is independent of account type. Still needed to protect n8n quota.
- **n8n intake + processing workflows** — structure stays the same; Whisper node replaced by a Drive read of the Meet transcript file.
- **Make scenario** — unchanged.
- **Notion register** — unchanged.

---

## Recommended Workspace tier

**Business Standard** (~$12/user/month) is sufficient. It includes Meet recording + transcription to Drive, 2 TB storage, and stable Service Account support. Business Plus adds audit logs and eDiscovery — not needed for this use case.
