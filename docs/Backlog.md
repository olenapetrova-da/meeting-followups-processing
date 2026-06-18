# Backlog — future work and improvement ideas

Items listed here are not in scope for the current exercise but are worth returning to.
Each entry notes where in the pipeline the change would be made.

---

## Prompt & transcription quality

### B-01 Expand the minutes prompt
**What:** The current prompt ("You are an expert project manager...") produces basic minutes. Make it more structured: add sections for summary, decisions made, action items with owners and due dates, open questions.
**Where:** Edit the Google Doc fetched by Make module 8 (doc ID `13sNLMo3tZAzdU_O7aTXzNCR3TBjMZJKz7JRxajBVzEY`). No code changes needed — the doc is fetched live at runtime.
**Related:** §11.2 in ProjectScope-and-SolutionDesign.md.

### B-02 Speaker diarization (recognize who said what)
**What:** Whisper transcribes speech but does not identify speakers. Adding diarization would label each segment with a speaker ID (Speaker 1, Speaker 2…) or name, making minutes more readable and action item assignment more accurate.
**Where:** After the `Transcribe a recording` node in n8n, add a diarization step. Options: pyannote.audio (self-hosted), AssemblyAI (cloud, supports diarization natively), or Deepgram. Requires replacing or augmenting the current Whisper call.
**Dependency:** B-03 (participants list) — speaker IDs become useful once you can match them to real names.

### B-03 Add meeting participants to the pipeline
**What:** Capture who attended the meeting. Source options: Drive file metadata (if the recording tool embeds it), filename convention, or a manual Notion field filled before/after the meeting.
**Where:** n8n intake workflow (`MEET-DRIVE-PUSH_intake`) — extract participants from filename or prompt the user to fill the Notion field. Pass participant list to Make in the webhook payload so it can be included in the minutes and email.
**Notion field:** `participants` (Text) is already in the database schema — see §5 of ProjectScope-and-SolutionDesign.md.

### B-04 Clean up Whisper output before sending to GPT
**What:** Whisper output can include filler words ("um", "uh"), repeated phrases, and run-on sentences. A light cleanup step before the GPT call would improve minutes quality.
**Where:** Add a `Code` node in n8n between `Transcribe a recording` and the `HTTP: POST to Make webhook`, or add preprocessing logic inside the Make scenario before module 5.

---

## Intake & file handling

### B-05 Group intake by project / subfolder
**What:** Currently all recordings land in a single flat intake folder. Organizing by project (subfolders inside `00_intake/`) would allow filtering and routing: different projects could use different prompts, recipients, or Notion databases.
**Where:** Cloudflare Worker — extend the folder filter logic to detect which subfolder the file landed in and pass a `project` field to n8n. n8n passes it to Make. Make could then use different prompt docs or email recipients per project.
**Impact:** Requires updating the Worker, n8n webhook payload, Make scenario, and Notion schema.

### B-06 MIME type guard — block non-audio files early
**What:** Currently any file dropped in the intake folder triggers the full pipeline. A non-audio file (PDF, image, spreadsheet) will run all the way to Whisper and fail there.
**Where:** Cloudflare Worker (`cloudflare/worker/pmi-drive-watch.js`) — add a check on `file.mimeType` before calling n8n. Accept only `audio/*` and `video/*`. Non-matching files return 200 silently.
**Related:** §11.1 in ProjectScope-and-SolutionDesign.md.

### B-07 Handle recordings larger than 25 MB
**What:** OpenAI Whisper rejects files over 25 MB. Longer meetings will fail silently at that step.
**Where:** n8n — add a file size check after `Drive: download recording`. If over limit: either set Notion status to `ERROR` with a clear message, or add a compression/splitting step (e.g., via a Code node calling ffmpeg through an external service).
**Related:** §11.1 in ProjectScope-and-SolutionDesign.md.

---

## Output & distribution

### B-08 Write minutes_doc_url back to Notion from Make
**What:** Currently Make creates the minutes Google Doc but never updates Notion with the link. The `minutes_doc_url` field in the Meeting Register stays empty. Make should update Notion to `DONE` with the doc URL after the draft is created.
**Where:** Add a Notion module at the end of the Make scenario (after module 13), using the Notion connection, updating the page by `notion_page_id` (already passed in the webhook payload).

### B-09 Parameterize the email recipient
**What:** The email recipient (`elenipster@gmail.com`) is hardcoded in Make module 13. In a real scenario the recipient list varies per meeting or project.
**Where:** Make module 13 — replace the hardcoded address with `{{2.meeting_title}}` or a mapped field. Better: add a `recipients` field to the n8n → Make webhook payload, populated from Notion or from the filename convention.

### B-10 Add a Slack or Teams notification
**What:** In addition to (or instead of) the email draft, post a short meeting summary to a Slack channel or Teams channel when minutes are ready.
**Where:** Add a module after module 13 in Make (Slack: Create a Message, or Microsoft Teams: Create a Message). Input: `{{2.meeting_title}}`, minutes doc share link from module 10.

---

## Security & operations

### B-11 OAuth refresh token stability
**What:** If the Google OAuth consent screen is set to External + Testing, Google revokes refresh tokens after ~7 days, breaking the Cloudflare Worker's Drive access.
**Where:** Google Cloud Console — switch the OAuth consent screen publishing status to **In production** for the project. This is a Google Cloud setting, not a code change.
**Related:** "Refresh token stability" section in ProjectScope-and-SolutionDesign.md.

### B-12 Rotate the Apps Script shared secret
**What:** The `SHARED_SECRET` used to authenticate n8n calls to the Apps Script web app is static. Periodic rotation reduces risk if it is ever exposed.
**Where:** Generate a new UUID, update `SHARED_SECRET` in Apps Script Script Properties, update `SHARED_SECRET` in the n8n `HTTP Request` node credential/env, update `.env`. No code changes needed.
**Related:** ADR-001.

### B-13 Make webhook URL exposure
**What:** The Make webhook URL is committed to the repo (`integrations/n8n/MEET-PROCESSING_transcribe.json`). Anyone with the URL can trigger the Make scenario. For a personal/course project the risk is low, but for a production setup the URL should be treated as a secret.
**Where:** Move the URL out of the n8n JSON into an n8n credential or environment variable. Replace the committed value with a placeholder (as is done for the Apps Script URL).

---

## Testing & observability

### B-14 End-to-end test with a real recording
**What:** The pipeline has not yet been tested with a real audio file through all stages (Drive drop → Gmail draft). Run one full end-to-end test, document what worked and what failed.
**Where:** Drop a short `.m4a` or `.mp4` file into the intake folder and trace the execution through Cloudflare Worker logs → n8n execution history → Make scenario history → Notion register → Gmail Drafts.

### B-15 Execution monitoring / alerting
**What:** Currently there is no alert if the pipeline stalls or fails. Errors are visible in the Notion register (`ERROR` status) but only if you look.
**Where:** Options: n8n error workflow (global error handler) that sends a notification email or Slack message on any execution failure; or a Notion automation that triggers when `status = ERROR`.
