# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Carrum Care Specialist Console** — a single-folder web app that helps Carrum Health Care Specialists analyze patient call transcripts against the Carrum SOP library and recommend next steps. Designed to *feel* like an internal Carrum tool integrated with Salesforce, Epic, Five9, and Outlook (all mocked).

Three things on top of plain transcript-analysis:
- **Mock SSO sign-in gate** (Carrum SSO / Okta) before the app loads. The signed-in specialist is hardcoded as "Jordan G".
- **Integration import/export stubs** — `Import from Five9 Call Recording` / `Import note from Epic EHR` buttons in the analyzer card pull canned transcripts; the export bar under Next Steps pushes the result to mocked Salesforce / Epic / Outlook endpoints.
- **In-app SOP editor** — care leads can add/edit/delete SOPs from the UI; changes write back to `sops.json` on disk.

## Run / dev

PowerShell 5.1 only — no Node/Python/.NET CLI. Backend is `System.Net.HttpListener`, no package manager, no build step.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1
# then open http://localhost:4321/app.html
```

Or via Claude Code preview using `.claude/launch.json` config name `carrum-analyzer`.

To enable Claude-powered analysis instead of the local heuristic: copy `.env.example` to `.env`, set `ANTHROPIC_API_KEY=sk-ant-...`, restart. Engine is selected at server startup based on whether the key is present.

**Restart pitfall:** `server.ps1` reads `sops.json`/`crm.json`/`.env` from `$PSScriptRoot`. Always launch with an absolute path — `-File C:\...\Call Transcript Analyzer\server.ps1` — or set the working directory explicitly. Starting with a relative path can leave the listener bound to a stale folder's data.

## Smoke tests (no test suite — use the 3 inline samples)

The 3 case-study patients are inlined in `app.html` (`SAMPLES`). Click the side-panel buttons, or POST to `/api/analyze`. Expected dispositions (these MUST hold after any heuristic / prompt / SOP change):

| Sample | Disposition  | Findings (local engine) |
|--------|--------------|--------------------------------------|
| Sarah  | Revision Case | BAR-001, BAR-002, BAR-003           |
| Bob    | Ineligible    | JNT-002, JNT-004                    |
| Maria  | Deferred      | JNT-001, JNT-003                    |

Claude mode may produce extra defensible findings; dispositions above must still hold.

## Architecture

```
 app.html
    │
    │ SSO gate ─▶ POST /api/sso/signin (mock user)
    │ Lookup    ─▶ POST /api/crm/lookup
    │ Analyze   ─▶ POST /api/analyze ──┐
    │ SOP CRUD  ─▶ /api/sops[/{id}]    │
    │ Import    ─▶ POST /api/integrations/import   (mock pull from Five9 / Epic)
    │ Export    ─▶ POST /api/integrations/export   (mock push to Salesforce / Epic / Outlook)
    ▼                                  │
 server.ps1                            ▼
    │                       ┌─ Invoke-ClaudeAnalysis (when ANTHROPIC_API_KEY set)
    │  /api/analyze         ├─ Invoke-LocalAnalysis (fallback / default)
    │                       └─ Get-OverallDisposition
    │
    ├─ sops.json   (read by /api/sops, written by SOP editor)
    ├─ crm.json    (read by /api/crm/lookup and analyze)
    └─ .env        (optional, gitignored)
```

The shared JSON contract returned by `/api/analyze` (consumed by `renderResults` in `app.html`):
```
{ ok, engine, model, crm_record, patient_summary, recommendation, findings[], overall_disposition, next_steps[], elapsed_ms }
```
Both engines must produce this shape. Changing it requires touching `Invoke-LocalAnalysis`, `Invoke-ClaudeAnalysis`, AND `renderResults`.

- `patient_summary` — 3-4 sentence prose summary of the call (rendered as the left "Transcript Summary" pane).
- `recommendation` — 2-3 sentence narrative that explicitly cites SOP IDs and tells the Specialist what to do (rendered as the right "Recommendation" pane, in bold, beneath the disposition status badge with class `.status-lg`).
- `findings[]` — per-SOP triggers. Each carries `sop_id`, `title` (sourced from the SOP's `finding` text), `category`, `finding` (detail), `status` (sourced from the SOP's `case_status`), `action`, `evidence`. The `evidence` quote is **not** rendered in the Findings card; it is surfaced inline next to the matching `[SOP-ID]` step in Next Steps via `findEvidenceForStep`.
- `overall_disposition.status` — selected by the strict priority rules below; rendered as the large status pill.
- `next_steps[]` — patient-specific imperative actions, SOP-tied ones prefixed `[SOP-ID]`. The Claude prompt requires these to be derived from `patient_summary` + `recommendation`.

A second optional engine evaluates the analysis after it renders:
- `POST /api/evaluate` (Gemini) takes `{ transcript, patient_summary, recommendation, next_steps, findings, overall_disposition }` and returns `{ ok, evaluator, model, recommendation: { score, rationale }, next_steps: { score, rationale } }`. Scores are 0-100 with frontend color bands (red 0-50, yellow 51-75, green 76-100). The frontend fires this automatically after `renderResults` and paints pills in the Recommendation pane and Next Steps card headers.

## SOP schema (v2.0)

`sops.json` top-level keys: `version`, `last_updated`, `rules[]`, `status_priority`, `status_colors`. The analyzer reads `rules[]` (NOT `sops[]`) — older v1 code that referenced `(Get-Sops).sops` will silently produce no findings.

Each rule:
```
{ id, category, applies_to: ["joint","bariatric"], finding, case_status, action,
  extracted_flags: [...], trigger_logic: "..." }
```

- `applies_to` is lowercase and gates the rule against `crm_record.case_type` (case-insensitive). A rule whose `applies_to` doesn't include the patient's case type is skipped entirely by the local engine and the Claude prompt is told to do the same.
- `case_status` is the disposition contributed by the rule when it fires. The frontend mirrors `status_colors`/`status_priority` from this file in its CSS classes — keep them in sync if you add new statuses.
- `extracted_flags` and `trigger_logic` are documentation/intent fields. The local engine doesn't evaluate `trigger_logic` directly; each SOP id has a hand-written guardrail block in `Invoke-LocalAnalysis` that implements the same intent. Claude sees these fields verbatim in the prompt.

## Key behaviors / gotchas

### Disposition priority (most blocking first)
`Ineligible (1) > Deferred (2) > High Complexity (3) > Review (4) > Revision Case (5) > Hold (6) > Action Required (7)`. `Cleared` is an **internal-only** sentinel (priority 99 in `$STATUS_PRIORITY`) used when no findings fire. It is not in `sops.json#status_priority` and is not selectable in the SOP editor. Three places must stay in sync:
1. `$STATUS_PRIORITY` in `server.ps1`.
2. The numbered list inside the Claude system prompt in `Invoke-ClaudeAnalysis`.
3. The status palette and editor `<select>` options in `app.html`.

### Local heuristic principles
Each SOP has a hand-written guardrail block in `Invoke-LocalAnalysis` (`switch ($sop.id)`) gated by `applies_to`. Two recurring traps when adjusting:
1. **Don't match on the specialist's question.** Sarah's transcript contains "Have you had an EGD?" — naive keyword match for "EGD" reads as confirmation. Require negation or explicit patient-side affirmation.
2. **Don't fire on absence alone.** Maria's transcript never mentions PT — JNT-002 must not fire just because PT wasn't discussed. Fire only when the topic is raised AND a weak/no-attempt response is present.

After ANY change to the heuristic, re-run all 3 sample transcripts and confirm the table above still holds.

### Mock SSO / Integrations
- `/api/sso/signin` returns a hardcoded `Jordan G / Care Specialist` user (the role/team fields exist in the response but are not displayed in the UI — only the name and avatar initials render in the user chip).
- `/api/integrations/import` returns a canned transcript per source. Currently only `googlemeet` is wired in the UI ("Import from Google Meet"). The default branch covers any other source value.
- `/api/integrations/export` returns a fake `EXP-######` reference. Called per-step (one CTA per Next Steps row) with `step_index` + `step_text` in the body. Has artificial latency to *feel* real.
- **Don't let "make these real" silently turn into real integrations.** They are deliberately stubs for the prototype — anything wiring them to real Salesforce/Epic/Google Meet must be explicitly scoped.

### Per-step thumbs gating (Next Steps card)
Each step row in `renderSteps` carries state in `STEP_STATE[i] = { vote, done }`. Behavior:
- The recommended CTA button is `disabled` until the specialist clicks 👍 (then `vote === "up"` enables it). 👎 sets `vote === "down"` and visually flags the row as **Follow-up flagged** but keeps the CTA disabled.
- Toggling the same thumb again clears the vote.
- The CTA target/kind is inferred from the step text by `inferStepCta` (keyword match on "document", "notify", "schedule", "escalate", "request", "revision pathway", "close case"). If you add new disposition-tail steps in the local heuristic or change the Claude prompt's wording, update `inferStepCta` so the right CTA fires.
- After a successful `/api/integrations/export`, the row is marked `done`, locked, and turns green.

### CRM-transcript match guard
`onAnalyze` enforces that if a CRM record is loaded (`CURRENT_CRM != null`), the transcript must mention at least one of `CURRENT_CRM.name_aliases` (or the full `name`). On mismatch it shows a blocking `alert()` and calls `onLookupReset()` to clear name, ID, transcript, and prior results. If lookup was skipped (no CRM loaded), the analyzer runs against the transcript alone — `Get-CrmFromTranscript` may still backfill a record by alias scan server-side.

### Gemini evaluator (Confidence Scores)
Optional second engine in `Invoke-GeminiEvaluation`. Configured via `GEMINI_API_KEY` and `GEMINI_MODEL` (default `gemini-2.0-flash`). **The default `gemini-2.0-flash` has a free-tier limit of 0 on at least some accounts — switch to `gemini-2.5-flash-lite` (or another available model) in `.env` if you hit 429.** Legacy `gemini-1.5-*` names are no longer served on `v1beta` for new keys; if you need to enumerate what's available for a key, hit `https://generativelanguage.googleapis.com/v1beta/models?key=...`.

The evaluator uses `system_instruction` + `generationConfig.responseMimeType="application/json"` to force JSON output and the same outermost-`{...}` extraction trick as the Anthropic path. Scoring guidance is calibrated (no scores >90 unless SOP IDs and patient quotes are explicitly cited). Frontend silently degrades to "Evaluation unavailable" pills + tooltip on failure — check the browser console (`Evaluation failed: ...`) for the underlying API error.

### Claude prompt / response handling
The system prompt in `Invoke-ClaudeAnalysis` is load-bearing in four ways:
1. **`applies_to` gating** — the prompt instructs Claude to skip rules whose `applies_to` doesn't include the patient's case_type. The SOP block exposes `applies_to` per rule.
2. **Strict priority enforcement** — disposition priority is given as a numbered list with explicit instructions: "take the status of EVERY finding, look up its number, pick the LOWEST, copy verbatim." Without this, Claude tended to pick the *last-mentioned* status instead of the most-blocking one (e.g., Hold instead of Revision Case for Sarah).
3. **`next_steps` ordering instruction** — Claude must write `next_steps` *last*, deriving each step from the already-written `patient_summary` and `recommendation`, sequenced in priority order, with the documentation step pinned to the end.
4. **Robust JSON extraction** — the response parser locates the outermost `{...}` and parses that, instead of just stripping code fences. Claude sometimes wraps JSON in prose; the simpler approach broke with `Invalid JSON primitive: ..`. Don't simplify back to fence-stripping.

### File upload (frontend, browser-side)
The transcript textarea accepts `.txt .md .log .html .htm .json .csv .xml .srt .vtt .docx .pdf`. `onFileChosen` dispatches by extension:
- Plain text formats read with `FileReader.readAsText`.
- `.html`/`.htm` are stripped to text via a temporary DOM node.
- `.srt`/`.vtt` have cue numbers and `HH:MM:SS,mmm --> ...` timestamps stripped before being placed in the textarea.
- `.json` is run through `flattenJsonTranscript` — looks for an array under `messages|transcript|dialogue|conversation|turns|utterances|entries`, maps each entry's `speaker|role|from|author|name` and `text|content|utterance|message|body`, and emits `Speaker [timestamp]: text` lines. Falls back to raw JSON if no recognizable structure is found.
- `.docx` uses `mammoth.browser.min.js` (CDN, lazy-loaded on first use).
- `.pdf` uses `pdfjs-dist` (CDN, lazy-loaded on first use, with a worker URL fallback).

The CDN libraries are loaded once via `loadScriptOnce` and cached on `window.__scripts`. They are the only external runtime dependencies — keep this contained to the upload path.

### PowerShell 5.1 traps (these have all bitten in prior versions)
1. **Source must be ASCII-only.** PS 5.1 reads UTF-8-without-BOM as Windows-1252 — em-dashes, smart quotes, etc., cause cryptic parse errors.
2. **`$resp.OutputStream.Close()` in every code path** (success AND error). HttpListener leaks otherwise.
3. **No ternary.** Use `if (cond) { val } else { other }`.
4. **`ConvertFrom-Json` returns PSCustomObject**, not hashtable — use `.foo` not `["foo"]`.

### UTF-8 round-trip on the Anthropic path
Three explicit UTF-8 boundaries (any one of them defaulting back to ANSI mangles non-ASCII transcripts):
1. **Read request body** — `StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)` in `Read-RequestBody`.
2. **Send to Anthropic** — `[System.Text.Encoding]::UTF8.GetBytes($bodyJson)`, pass byte array as `-Body`.
3. **Decode response** — `Invoke-WebRequest -UseBasicParsing` + `[System.Text.Encoding]::UTF8.GetString($rawResp.RawContentStream.ToArray())`. **Do not** use `Invoke-RestMethod` — it auto-decodes via the response's declared charset and falls back to Latin-1.

The Anthropic catch block reads `$_.Exception.Response.GetResponseStream()` to surface the real error body (low credit, bad model name, etc.). Don't strip it out.

## SOP editor → file persistence

`POST /api/sops`, `PUT /api/sops/{id}`, `DELETE /api/sops/{id}` all rewrite `sops.json` via `Save-Sops`, mutating the `rules` array in place. There is no DB and no migration — the JSON file is the source of truth. If you're worried about overwrites during local dev, back up `sops.json` first.

## Files

| File | Purpose |
|------|---------|
| `server.ps1` | HTTP listener, all API routes, both analysis engines. Single source of truth for analysis logic. |
| `app.html`   | Single-page UI (SSO gate, top bar, analyzer, SOP editor). No bundler, no framework. CDN libraries (mammoth, pdf.js) lazy-loaded only for `.docx`/`.pdf` upload. |
| `sops.json`  | v2.0 SOP library under `rules[]` (8 rules: 1 General, 4 Joint, 3 Bariatric). Editable from the UI. |
| `crm.json`   | Mock CRM (3 sample patients). Edit `name_aliases` to control which transcripts match. |
| `samples/`   | Standalone sample transcripts (e.g. `sample-transcript.json`) for manual upload testing. |
| `.env.example` | Template — copy to `.env` and add `ANTHROPIC_API_KEY` to enable Claude mode. |
| `.gitignore` | Excludes `.env`, `.claude/settings.local.json`. **Load-bearing for security** — don't loosen without auditing. |
| `.claude/launch.json` | Preview config (`carrum-analyzer`). |

### Git / repository

`.gitignore` is load-bearing for keeping the Anthropic API key out of the repo — run `git check-ignore -v .env` before any commit that touches gitignore. Never `git add -f .env`.
