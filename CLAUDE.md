# Claude Code instructions

## At the start of every session
1. Read `docs/ProjectScope-and-SolutionDesign.md` — understand scope and the full system architecture
2. Read `https://app.notion.com/p/38623195240a459b82739b7705e595c0?v=7740859dc16c425da07c886235b1219a&source=copy_link` - understand current status and what is in progress
3. Read `docs/ADR.md` if exist — understand decisions already made and why
4. Read `docs/Cloudflare-Config-Snapshot.md`, `docs/Cloudflare-Worker-SourceOfTruth.md`, `docs/Runbook-DriveWatch-Worker.md`
5. Ask me which task to work on, or confirm the next one from [https://app.notion.com/p/38623195240a459b82739b7705e595c0?v=7740859dc16c425da07c886235b1219a&source=copy_link]

## During work
- Before making a non-obvious technical decision, state the options and ask me to confirm
- If you make a decision without asking, add an ADR entry immediately
- After completing a task, mark it done in [https://app.notion.com/p/38623195240a459b82739b7705e595c0?v=7740859dc16c425da07c886235b1219a&source=copy_link] and commit

## After completing a task
- Update [https://app.notion.com/p/38623195240a459b82739b7705e595c0?v=7740859dc16c425da07c886235b1219a&source=copy_link] (mark done, move next task to "In progress")
- Add ADR entry if any decisions were made
- Commit with a clear message: `feat:`, `fix:`, `chore:` prefix
- Tell me the task is done and what the next step is

## Stack reminder
- Cloudflare Worker: deployed via dashboard, no Wrangler
- n8n: Starter plan, executions are critical — minimise them
- Supabase: free tier
- AI extraction: OpenAI GPT-4o-mini (no Claude API budget)
- n8n Google Service Account credential (`Google Service Account account`): read-only in practice — Drive download, Notion etc. work, but it has **zero Drive storage quota**, so it cannot create new Drive/Docs files (`storageQuotaExceeded`). For any "create a new file" step, use the `PMI-drive-actions` Apps Script web app (`integrations/apps-script/PMI-drive-actions.gs`, URL/secret in `.env` as `WEB_APP_URL`/`SHARED_SECRET`) — see `docs/ADR.md` ADR-001.