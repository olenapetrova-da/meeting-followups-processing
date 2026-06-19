# Meeting Follow-ups Processing (PMI GenAI exercise)

Event-driven pipeline: drop a meeting recording into Google Drive → get a transcript Google Doc, meeting minutes Google Doc, and a Gmail draft. Status tracked in Notion throughout.

**Current status:** Pipeline fully built and end-to-end tested (v0.1.0-alpha, 2026-06-18).

---

## How it works

```
Recording dropped into Drive intake folder
        |
        v
Drive Push Notification (Changes API ping)
        |
        v
Cloudflare Worker — gate
  reads KV state (pageToken), fetches Drive deltas,
  filters: new file in intake folder only,
  calls n8n only on a confirmed new file
        |
        v
n8n: MEET-DRIVE-PUSH_intake
  auth + idempotency check (Notion by drive_file_id)
  creates Meeting Register row → status: NEW
        |
        v
n8n: MEET-PROCESSING_transcribe
  downloads recording (Service Account)
  transcribes via OpenAI Whisper (auto-detect language)
  creates transcript Google Doc via Apps Script web app*
  updates Notion → TRANSCRIBED
  POSTs to Make webhook
  updates Notion → MINUTES_READY
        |
        v
Make: PMI meeting followup
  fetches prompt Google Doc (live)
  GPT-4o-mini → meeting minutes text
  creates minutes Google Doc
  shares (anyone/reader)
  creates Gmail draft to elenipster@gmail.com
        |
        v
Notion Meeting Register: status trail + artifact links
```

*Apps Script is required because the n8n Service Account has zero Drive storage quota on a personal Google account. See `docs/ADR.md` ADR-001.

---

## Stack

| Layer | Tool | Plan |
|---|---|---|
| Event gate | Cloudflare Worker + KV | Free |
| Orchestration | n8n | Starter (2500 exec/month) |
| File creation workaround | Google Apps Script web app | Free |
| Minutes + email | Make | Free |
| Transcription | OpenAI Whisper | Pay-per-use |
| Minutes generation | GPT-4o-mini via Make | Pay-per-use |
| Status register | Notion | Free |

---

## Repo structure

```
cloudflare/
  worker/pmi-drive-watch.js     — Cloudflare Worker source (deploy via dashboard)
docs/
  ProjectScope-and-SolutionDesign.md  — full architecture + configuration reference
  ADR.md                              — architecture decisions and reasons
  Backlog.md                          — open issues and future improvements
  Runbook-DriveWatch-Worker.md        — Worker operational runbook
  Cloudflare-Config-Snapshot.md       — Cloudflare dashboard config snapshot
  Cloudflare-Worker-SourceOfTruth.md  — Worker source of truth notes
  Workspace-Migration-Analysis.md     — how the pipeline changes on Google Workspace
integrations/
  n8n/MEET-DRIVE-PUSH_intake.json        — n8n intake workflow export
  n8n/MEET-PROCESSING_transcribe.json    — n8n processing workflow export
  make/PMI-meeting-followup.blueprint.json — Make scenario blueprint export
  apps-script/PMI-drive-actions.gs       — Apps Script web app source
samples/
  prompt_simple_1.md            — redacted LLM prompt example
```

---

## Key operational references

| Resource | Location |
|---|---|
| Notion Project Backlog | https://app.notion.com/p/38623195240a459b82739b7705e595c0 |
| Notion Meeting Register DB | ID `30594a8e-2162-803b-ab4d-cd4214ca0ff7` |
| Drive intake folder | ID `1tBji5XdYzKyXrTfhenNkmYPdmlQ2M6Jq` |
| Drive transcripts folder | ID `1ynuk44Atlea3jpJfxVK0yLIl80qozNJ_` |
| Drive minutes folder | ID `1EabDhz0l5AC1IQIw9G5PN1fgUEYFnx0z` |
| LLM prompt Google Doc | ID `13sNLMo3tZAzdU_O7aTXzNCR3TBjMZJKz7JRxajBVzEY` |
| GitHub repo | https://github.com/olenapetrova-da/meeting-followups-processing |

---

## Known open issues

Top items from `docs/Backlog.md`:

- **B-06** No MIME type guard in Worker — non-audio files run the full pipeline and fail at Whisper
- **B-07** No >25 MB file handling — Whisper rejects oversized files silently
- **B-08** Make does not write `minutes_doc_url` back to Notion — field stays empty
- **B-09** Email recipient hardcoded in Make module 13
- **B-11** OAuth refresh token may expire after ~7 days (External + Testing consent screen)
- **B-13** Make webhook URL committed to repo — should move to n8n credential

Full list with context and fix locations: `docs/Backlog.md`.

---

## Where to start when returning to this project

1. **This file** — current state, architecture, open issues
2. **[Notion Project Backlog](https://app.notion.com/p/38623195240a459b82739b7705e595c0)** — task statuses (Done / In Progress / Blocked)
3. **`docs/ProjectScope-and-SolutionDesign.md`** — full architecture detail, §10 implementation status, §11 configuration reference
4. **`docs/Backlog.md`** — open issues with exact fix locations
5. **`docs/ADR.md`** — why key decisions were made (start here before changing anything in the stack)
6. **`docs/Workspace-Migration-Analysis.md`** — read before considering a Google Workspace upgrade

---

## Safety / privacy

This repository is public. Do NOT commit:
- recording files, transcripts, or minutes exports
- `.env` or any file containing secrets

See `.gitignore` and `.env.example` for what is safe to commit.
