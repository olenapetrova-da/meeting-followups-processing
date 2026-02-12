# Meeting Follow-ups Processing (PMI GenAI exercise)

Event-driven pipeline that turns a meeting recording dropped into Google Drive into:
- transcript (Google Doc)
- meeting minutes (Google Doc)
- meeting minutes email (Gmail draft / send)
with status tracking in Notion.

## Architecture (high level)
Drive Push Notifications (Changes API) → n8n webhook → transcription + artifact creation → Make webhook → minutes formatting + email → Notion updated.

## Documentation
- docs/ProjectScope-and-SolutionDesign.md

## Repo structure
- docs/ — scope, solution design, runbook, prompts
- workflows/n8n/ — exported n8n workflows (JSON)
- workflows/make/ — exported Make blueprints (JSON)
- schemas/ — Notion DB properties, data contracts
- samples/ — redacted example payloads only

## Safety / privacy
This repository is public.
Do NOT commit recordings, transcripts, minutes exports, or any secrets.
See .gitignore and .env.example.
