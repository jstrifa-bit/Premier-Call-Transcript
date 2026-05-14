# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Premier Care Specialist Console** — a single-folder web app that helps Care Specialists analyze patient call transcripts against the SOP library and recommend next steps. Designed to *feel* like an internal tool integrated with Salesforce Health Cloud (the patient's EHR), Google Workspace, Five9, and Outlook (all mocked).

Three things on top of plain transcript-analysis:
- **Mock SSO sign-in gate** (Premier SSO / Okta) before the app loads. The signed-in specialist is hardcoded as "Jordan G".
- **Integration import/export stubs** — `Import from Google Workspace` and `Import from Five9` buttons pull canned transcripts; per-step CTAs push results to mocked Salesforce / EHR / Outlook endpoints.
- **In-app SOP editor** — care leads can add/edit/delete SOPs from the UI; changes write back to `sops.json` on disk (dev only — Vercel filesystem is read-only).

## Run / dev

**Two equivalent backends share the same data files and most of the `/api/*` contract.** Pick whichever your machine has set up:

**Next.js (deployable to Vercel — production target):**
```bash
npm install
npm run dev    # http://localhost:4321
```

**PowerShell 5.1 (Windows local-only fallback, no Node required):**
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1
# http://localhost:4321
```

Both serve `public/app.html` at `/` and read `sops.json` / `crm.json` from the repo root. **PowerShell mode lacks `/api/extract` and `/api/preflight`** — those are Next.js-only routes. Use `npm run dev` or deploy to Vercel for the full feature set.

To enable AI engines: copy `.env.example` to `.env` (or `.env.local` for Next.js), set `ANTHROPIC_API_KEY` and `GEMINI_API_KEY`. **For Vercel deployment, set the same vars in the Vercel project's Environment Variables — the Production scope MUST be checked, and a redeploy is required after adding/changing them** (env vars are baked at build/start, not picked up live). Verify via `/api/health` which returns `engine` and `evaluator` flags.

**PowerShell restart pitfall:** `server.ps1` reads `sops.json`/`crm.json`/`.env` from `$PSScriptRoot`. Always launch with an absolute path — `-File C:\...\Call Transcript Analyzer\server.ps1` — or set the working directory explicitly. Starting with a relative path can leave the listener bound to a stale folder's data.

**Vercel deployment caveats:**
- **SOP edits do not persist on Vercel** — the function filesystem is read-only. `lib/data.js#writeSops` throws `READONLY` when `process.env.VERCEL` is set, and the SOP CRUD routes return 503 in production. Local dev still writes to `sops.json` normally.
- The Anthropic key in the source-controlled `.env.txt` (now removed and gitignored via `.env.*`) was a near-miss during the initial repo push. Don't recreate that pattern. `.env.example` is the only `.env*` file allowed in the repo.

## Smoke tests (no test suite — 3 inline samples)

The 3 case-study patients live in `crm.json` (Sarah Mitchell, Robert Carlson, Maria Alvarez). The quick-load side-panel buttons were removed; you smoke-test by pasting their transcripts (or using the Google Workspace / Five9 import buttons which return Sarah's and Bob's transcripts respectively). Expected dispositions (these MUST hold after any heuristic / prompt / SOP change):

| Sample | Disposition | Findings (local engine) |
|--------|-------------|--------------------------|
| Sarah  | Revision Case | BAR-001, BAR-002, BAR-003 |
| Bob    | Ineligible    | JNT-002, JNT-004 |
| Maria  | Deferred      | JNT-001, JNT-003 |

Claude mode may produce extra defensible findings; dispositions above must still hold.

## Architecture

```
 public/app.html  (single SPA, served identically by both backends)
    │
    │ SSO gate    ─▶ POST /api/sso/signin
    │ Lookup      ─▶ POST /api/crm/lookup
    │ Preflight   ─▶ POST /api/preflight              (Claude gate: is_clinical_transcript + detected_language)
    │ Analyze     ─▶ POST /api/analyze                (analysis + extraction in parallel)
    │ Extract     ─▶ POST /api/extract                (standalone Claude, Next.js only)
    │ Evaluate    ─▶ POST /api/evaluate               (Gemini 4-dimension scoring, fires after renderResults)
    │ Draft Email ─▶ POST /api/draft-email            (Claude, builds patient email from COPIED_STEP_MESSAGES)
    │ SOP CRUD    ─▶ /api/sops[/{id}]
    │ Import      ─▶ POST /api/integrations/import    (googleworkspace / five9 canned transcripts)
    │ Export      ─▶ POST /api/integrations/export    (per-step CTA + disagree_notes + step_disagree_notes, mock)
    ▼
 ┌────────────────────────────────────┬──────────────────────────────────┐
 │ Next.js (pages/api/*.js)           │ server.ps1 (PowerShell)          │
 │ - full parity                      │ - no /api/preflight, /api/extract │
 │ - lib/* for engines                │ - inline functions in .ps1       │
 │ - serverless on Vercel             │ - HttpListener, local only       │
 └─────────────┬──────────────────────┴────────────┬─────────────────────┘
               │                                    │
               ├─ sops.json (read by /api/sops; written in dev only)
               ├─ crm.json  (read by /api/crm/lookup + analyze; only case_type is passed to LLMs)
               ├─ schemas/extraction-schema.json (unified case-document contract for /api/extract)
               ├─ schemas/ehr-schema.json        (EHR display contract for the patient panel)
               └─ .env / Vercel env vars
```

`lib/analyze-local.js` is a faithful JS port of `Invoke-LocalAnalysis`, including the regex guardrails per SOP id. Keep both in sync.

### Analyze response shape
The shared JSON contract returned by `/api/analyze` (consumed by `renderResults` in `app.html`):
```
{
  ok, engine, model, crm_record,
  patient_summary, recommendation,
  findings[],
  overall_disposition,
  next_steps[],
  extraction,        // populated when ANTHROPIC_API_KEY is set; null + extraction_error otherwise
  elapsed_ms,
  claude_error?     // present when Claude analysis fell back to local heuristic
}
```
Both engines must produce this shape. Changing it requires touching `lib/analyze-local.js`, `lib/analyze-claude.js`, `server.ps1`, AND `renderResults`.

- `patient_summary` and `recommendation` must be **grounded in the transcript only** — the LLM is passed `case_type` for routing/`applies_to` gating but is explicitly forbidden from referencing EHR/CRM data, demographics, or any fact not stated in the call. The local heuristic's summary builder also avoids CRM-derived demographics.
- `findings[].evidence` is rendered inline as the "Patient quote:" snippet next to the matching `[SOP-ID]` step in Next Steps, NOT in the Findings card.
- `next_steps[]` is a flat string array (`[SOP-ID] action` plus a disposition tail step and a documentation step). Note: the unified case-document schema in `schemas/extraction-schema.json` defines a richer **structured** next_steps array; that's the extractor's output, not the analyze pipeline's.

### Four LLM endpoints
- **Anthropic Claude** drives `/api/preflight` (upload gate), `/api/analyze` (analysis), `/api/extract` (clinical flags), and `/api/draft-email` (patient email). Analysis + extraction run in parallel via `Promise.allSettled` inside `/api/analyze`. Extraction failure is tolerated: the analyze response still succeeds with `extraction: null` + `extraction_error`.
- **Google Gemini** drives `/api/evaluate`. The frontend fires it automatically after `renderResults` and passes `r.extraction` alongside the analysis output.

**The extraction object is no longer rendered in the UI** — it survives only as Gemini-evaluator input. There is no Clinical Extraction card. If you re-introduce per-flag UI later, see git history around commit `a9136a2` for the previous render code.

## SOP schema (sops.json, v2.0)

`sops.json` top-level keys: `version`, `last_updated`, `rules[]`, `status_priority`, `status_colors`. The analyzer reads `rules[]` (NOT `sops[]`) — older v1 code that referenced `(Get-Sops).sops` will silently produce no findings.

Each rule:
```
{ id, category, applies_to: ["joint","bariatric"], finding, case_status, action,
  required_flags: [...], trigger_logic: "..." }
```

- `applies_to` is lowercase and gates the rule against `crm_record.case_type` (case-insensitive). Rules outside the patient's case type are skipped by the local engine, and the Claude prompt is told to do the same.
- `case_status` is the disposition contributed when the rule fires. The frontend mirrors `status_colors`/`status_priority` in its CSS classes — keep them in sync if you add statuses.
- `required_flags` and `trigger_logic` are documentation/intent fields. The local engine doesn't evaluate `trigger_logic` directly; each SOP id has a hand-written guardrail block in `evaluateRule` (`lib/analyze-local.js`) that implements the same intent. Claude sees these fields verbatim in the prompt.

## Extraction schema (schemas/extraction-schema.json)

The unified **case-document** contract for `/api/extract`. Top-level: `version`, `case_id`, `patient`, `clinical_flags`, `sop_recommendations[]`, `next_steps[]` (structured objects with `step_id`, `description`, `triggered_by_sop`, `priority`, `status`, `confidence`, `assigned_to`, `due_date`), `case_summary`, `overall_case_status`, `extraction_metadata`, `evaluation`. Leaf values in the file are pseudo-type strings (e.g. `"boolean | null"`) that the extractor replaces with concrete values. The `evaluation` block is left as a null placeholder — the dedicated `/api/evaluate` (Gemini) fills it downstream.

**Intentionally dropped from earlier schema revisions** (do not re-add unless requested):
- `additional_context` (comorbidities, blood-clot history, oxygen dependence, current medications, mobility status).
- `extraction_metadata.speaker_labels_present`, `inaudible_count`, `contradictions[]` (Layer 3 transcript-quality fields). The extractor prompt and the UI no longer reference them.

## EHR schema (schemas/ehr-schema.json)

Contract for the patient-panel display: `name`, `age`, `sex`, `location`, `employer`, `bmi`, `height_in`, `weight_lb`, `phone`. The backing data in `crm.json` contains more (`case_type`, `primary_dx`, `patient_id`, `name_aliases`, `email`) but those are not rendered in the EHR card — `case_type` is used server-side for SOP gating, `name_aliases` for the CRM-transcript match guard, but neither is exposed to the LLM in `patient_summary`/`recommendation` (see "Claude prompt / response handling" below).

## Key behaviors / gotchas

### Disposition priority (most blocking first)
`Pending - Callback Required (0) > Ineligible (1) > Deferred (2) > High Complexity (3) > Review (4) > Revision Case (5) > Hold (6) > Action Required (7)`. `Cleared` and `Pending - Callback Required` are **internal-only** sentinels — neither is in `sops.json#status_priority` and neither is selectable in the SOP editor. `Pending - Callback Required` is set by the post-process in `pages/api/analyze.js` when the extractor reports incompleteness (`null_flag_count >= 3` OR `requires_human_review === true`); see "Incomplete-transcript post-process" below. Four places must stay in sync:
1. `STATUS_PRIORITY` in `lib/disposition.js`.
2. `$STATUS_PRIORITY` in `server.ps1`.
3. The numbered list in the Claude analysis system prompt (`lib/analyze-claude.js` and `server.ps1`).
4. The status palette + SOP editor `<select>` options in `app.html`.

### Local heuristic principles
Each SOP has a hand-written guardrail block in `evaluateRule` / `Invoke-LocalAnalysis` (`switch ($sop.id)`) gated by `applies_to`. Two recurring traps when adjusting:
1. **Don't match on the specialist's question.** Sarah's transcript contains "Have you had an EGD?" — naive keyword match for "EGD" reads as confirmation. Require negation or explicit patient-side affirmation.
2. **Don't fire on absence alone.** Maria's transcript never mentions PT — JNT-002 must not fire just because PT wasn't discussed. Fire only when the topic is raised AND a weak/no-attempt response is present.

After ANY change to the heuristic, re-run all 3 sample transcripts and confirm the table above still holds.

### Claude prompt / response handling
The system prompt in `lib/analyze-claude.js` (mirrored in `server.ps1`) is load-bearing in ten ways. **All Anthropic calls (analyze, extract) run at `temperature: 0`** for determinism — same transcript must produce the same output. Don't reintroduce default temperature; the smoke tests depend on this.

1. **No CRM/EHR grounding + no invented clinical facts.** A top-of-prompt rule forbids any reference to CRM/EHR data, demographics, or facts not in the transcript. Two sub-prohibitions: (a) never invent name/age/sex/location/BMI/primary_dx unless explicitly stated; (b) never invent clinical history (DVT, comorbidities, prior procedures, allergies, lab values, risk factors not mentioned). The universal closing rule: *every concrete clinical detail in your output must be traceable to a specific sentence in the transcript*. Past failure mode: the analyzer kept hallucinating a "historical DVT" mention that wasn't in Bob's transcript.
2. **Patient Certainty Rule** — a finding fires ONLY on direct, confirmed evidence. Hedges ("maybe", "I think", "I'm not sure", "I don't know", "I can't remember", "I did some stuff", "a while back") are explicitly non-triggering. Empty findings array is the CORRECT output for ambiguous calls. Daniel-style hedge calls now produce zero findings → post-process routes them to Pending.
3. **Direct denial dominates nearby softening** — when one response contains both a direct denial AND softening words about adjacent activities ("Honestly no... I tried the gym a couple of times but never did real PT"), the direct denial governs. The patient is confirming `attempted_pt == false` and JNT-002 fires. Distinguish from pure hedges (no direct yes/no anywhere) which still don't fire.
4. **SOP-specific clinical intent** — read flag values against the rule's PURPOSE, not just the patient's literal words. JNT-002 fires when the patient has not completed a *formal supervised PT trial*: informal exercise / a few gym sessions / self-directed activity → `attempted_pt = false` for SOP purposes (the rule's action says "Refer to 6-12 week conservative PT trial" — informal activity doesn't satisfy that bar). Symmetric clarifications cover JNT-001 (a single recent slip ≠ active smoker if quit otherwise sustained) and BAR-003 (a nutritionist or pamphlet ≠ Registered Dietitian).
5. **`applies_to` gating** — the prompt instructs Claude to skip rules whose `applies_to` doesn't include the patient's case_type.
6. **Strict priority enforcement** — disposition priority is given as a numbered list with explicit instructions: "take the status of EVERY finding, look up its number, pick the LOWEST, copy verbatim." Without this, Claude picked the *last-mentioned* status instead of the most-blocking one.
7. **Consistency rule (findings ↔ recommendation ↔ disposition)** — every SOP id in `recommendation` or `patient_summary` MUST appear in `findings[]`, and vice versa. `overall_disposition.status` is computed from `findings` alone via the priority rule, never from rules described only in prose. Without this, the analyzer described "two SOPs fire" while the structured findings only listed one.
8. **`next_steps` requires one entry per finding** — for EVERY entry in findings, produce one step prefixed with its SOP id in brackets. A finding without a corresponding `[SOP-ID]` step is a routing error. Two findings produce two SOP-prefixed steps even when one drives the disposition. The disposition tail step and documentation step come AFTER all SOP-prefixed steps.
9. **`next_steps` ordering** — Claude must write `next_steps` *last*, deriving each step from the already-written `patient_summary` / `recommendation`, sequenced in priority order, with the documentation step pinned to the end.
10. **Robust JSON extraction** — the response parser locates the outermost `{...}` and parses that, instead of just stripping code fences. Claude sometimes wraps JSON in prose; the simpler approach broke with `Invalid JSON primitive: ..`. Don't simplify back to fence-stripping.

### Incomplete-transcript post-process (Next.js only)
`pages/api/analyze.js` runs `applyIncompleteTranscriptRule` after both engines resolve. The current design treats the analyzer's findings as **authoritative** — they come from direct transcript evidence with quotes. The extractor's flag state is informational, not subtractive. Behavior:

1. **Analyzer findings pass through unchanged.** Even if the extractor was bashful and left a rule's `required_flags` as null, an analyzer finding for that same rule (e.g., "I had a sleeve in 2018" → BAR-001) stays. The Patient Certainty Rule in the analyze prompt is the safeguard against the analyzer producing hedged findings in the first place.
2. **`unresolvable[]` is informational.** A rule lands there only when **both** paths agree there's no signal: the analyzer did NOT fire it, AND at least one of its `required_flags` is null in the extraction. Each entry: `{ id, finding, missing_flags }`. Rendered as the "Unresolvable Rules" card after Findings.
3. **Pending - Callback Required override** fires only when `findings.length === 0` AND extraction is incomplete (`null_flag_count >= 3` OR `requires_human_review === true`). In that case `overall_disposition` becomes `{ status: "Pending - Callback Required", reason: "Insufficient data to evaluate SOPs; follow-up needed." }` and `next_steps` is replaced with a dynamic follow-up questionnaire built from `FLAG_TO_TOPIC` plus the documentation step. If the analyzer fired even one finding, that finding's status drives the disposition instead.

**History worth knowing** — this was first implemented as "strip any analyzer finding whose rule has a null required_flag, then override." That caused **under-firing**: even Sarah's solid `"I had a sleeve in 2018"` was thrown away because the extractor hadn't populated `prior_weight_loss_surgery`. The reverse failure mode (Daniel's `"Maybe?"` hedges producing four findings of Ineligible) was fixed by the Patient Certainty Rule in the analyze prompt, not by the post-process. Keep both safeguards together — softening either one regresses one of the two cases.

Local-heuristic-only mode skips the post-process (no extraction object). PowerShell mode lacks `/api/extract` so the pipeline change does not apply there.

### Defensive error envelope (`/api/analyze`)
The whole handler is wrapped in a try/catch that converts any unhandled exception to a JSON 500 (`{ ok: false, error, where: "analyze handler" }`) instead of letting Vercel render its HTML error page (which would surface in the browser as the unhelpful `Unexpected token '<', <!DOCTYPE ... is not valid JSON`). A second try/catch wraps `applyIncompleteTranscriptRule` and falls back to the raw analyzer result on post-process failure. Both error paths log to the Vercel function log with `ANALYZE FATAL:` and `applyIncompleteTranscriptRule threw:` prefixes for quick diagnosis.

### Gemini evaluator (4-dimension QA scoring)
`/api/evaluate` returns `{ ok, evaluator, model, evaluation }` where `evaluation` carries four named dimensions (0.0–1.0 floats):
- **`sop_accuracy`** (40% weight) — **DETERMINISTIC, server-side.** Computed by `lib/score-sop-accuracy.js`, NOT Gemini.
- **`extraction_completeness`** (30%) — **DETERMINISTIC, server-side.** Computed by `lib/score-extraction-completeness.js`, NOT Gemini.
- **`next_step_actionability`** (20%) — **DETERMINISTIC, server-side.** Computed by `lib/score-next-step-actionability.js`, NOT Gemini.
- **`human_review_appropriateness`** (10%) — **DETERMINISTIC, server-side.** Computed by `lib/score-human-review.js`, NOT Gemini.

`evaluator` field is `"gemini+deterministic"`. **All four dimensions are now overridden server-side** in `pages/api/evaluate.js`. Gemini is still called (the response shape requires its initial values as a fallback in case any deterministic scorer throws), but every dimension's value is replaced before the response is sent in the happy path. If you want to drop the Gemini call entirely, the deterministic scorers can produce a complete `evaluation` object on their own — see `pages/api/evaluate.js` for the assembly. `overall_score` is recomputed using the 40/30/20/10 weights after both overrides; `score_label` and `needs_escalation` are also refreshed.

**Why deterministic for `sop_accuracy`:** through multiple prompt iterations Gemini kept scoring this dimension below 1.0 with reason text that *explicitly praised* the analyzer's output — exactly the praise-then-deduct violation the prompt forbade. Gemini's numeric output doesn't bind to prompt rules reliably enough for a clinical routing score. The deterministic scorer encodes the three named penalty grounds from the prompt and runs every time:
1. **Case_status mismatch:** any finding whose `status` doesn't match its SOP's `case_status` in `sops.json` → -0.3 each.
2. **Disposition mismatch:** `overall_disposition.status` must equal the case_status of the lowest-priority-number finding → -0.3 if violated.
3. **Null-flag firing:** a finding whose corresponding SOP's `required_flags` include a null value in the extraction → -0.4 each.

Floor at 0, ceiling at 1. The fourth ground from the prompt ("rule missing despite explicit transcript evidence") is fuzzy and left to the analyzer's Patient Certainty Rule; the deterministic check doesn't try to second-guess that.

**Why deterministic for `extraction_completeness`:** same praise-then-deduct failure mode. Gemini repeatedly penalized null flags using `extraction_metadata.null_flag_count` as the signal — but short transcripts that only cover a few topics legitimately produce many nulls (e.g. Bob's PT+opioids call never mentions dental or smoking, so those flags are correctly null). The deterministic scorer encodes the actual rule: a null is only a penalty when the transcript contains evidence the topic WAS raised.

For each flag applicable to the patient's `case_type` (general flags always apply; joint/bariatric flags gated by `case_type` from extraction or CRM), the scorer:
1. Reads the flag value from `extraction.clinical_flags`.
2. If non-null, no penalty — skip.
3. If null, tests the transcript against a per-flag keyword regex (e.g. `active_smoker` → `/smoke|smoker|smoking|cigarette|tobacco|vape|nicotine/i`).
4. If the keyword matches, the null is unjustified → -0.2.

Score: 1.0 baseline; floor 0, ceiling 1. Keyword map and applicability lists live at the top of `lib/score-extraction-completeness.js` — keep in sync with `schemas/extraction-schema.json` if you add flags.

**Recognizable reason text** — both deterministic scorers produce reason text that's distinct from Gemini prose:
- `sop_accuracy`: either lists specific violations *with the SOP id and field name* or reads `"All fired rules carry correct case_status, ... Deterministic check."`
- `extraction_completeness`: either lists unjustified-null flag names by extraction key or reads `"Every applicable flag is either populated or its topic was never raised in the transcript. Deterministic check."`

If you see this text, the override fired. If you see Gemini-style prose with a sub-1.0 score on either dimension, the deployment is stale.

The frontend uses `sop_accuracy.score` for the Recommendation header pill and `next_step_actionability.score` for the Next Steps header pill (scaled ×100; color bands red 0-50 / yellow 51-75 / green 76-100). The full breakdown renders in the Evaluation card — positioned **immediately after the Next Steps card** (which ends with the draft patient email), and before the Triggered SOP Findings card. A red **Escalation recommended** banner appears when `needs_escalation` is true.

**Cost note:** the evaluator user message embeds the entire extraction JSON plus the analyze output, so it's significantly larger than the original 2-pill prompt. If you hit 429s on Gemini, the Flash-Lite quota is the most common cause.

**Gemini model trap:** the default `gemini-2.0-flash` has a free-tier limit of 0 on at least some accounts. We use `gemini-2.5-flash-lite` instead via `GEMINI_MODEL` in `.env` / Vercel env. Legacy `gemini-1.5-*` names are no longer served on `v1beta` for new keys. To enumerate what's available for a key: `https://generativelanguage.googleapis.com/v1beta/models?key=...`. Frontend silently degrades to "Confidence unavailable" pills on Gemini failure — check browser console for the underlying error.

### Edge-case handling (Layer 1, 2, 4)
**Layer 1 — Upload (`onFileChosen`):**
- Unsupported extension → `alert()` listing supported types, block.
- Empty file → `alert()` after read, block.
- Encoding / parse errors → `try/catch`; alert suggests re-export as UTF-8.

**Layer 2 — Pre-flight gate (`/api/preflight`):** small Claude call (input capped at 4000 chars) returning `{ is_clinical_transcript, detected_language, reason }`. Frontend gates `/api/analyze` on the result:
- `is_clinical_transcript === false` → alert "This document does not appear to be a patient care transcript…", block.
- `detected_language !== "english"` → alert "English only is supported at this time", block.

Returns 503 when `ANTHROPIC_API_KEY` is missing; the frontend treats 503 as skip-gate so local-heuristic-only mode still works.

**Layer 4 — Timeouts + JSON safety:** every LLM fetch wraps an `AbortController` with a per-route timeout (preflight 15s, analyze 50s, extract 50s, evaluate 25s). `vercel.json` declares `maxDuration` per route (preflight 20s, analyze/extract 60s, evaluate 30s) so Vercel doesn't kill the function before the timeout fires. `lib/extract.js` uses `max_tokens: 4000` and wraps `JSON.parse` with a safe schema-shaped fallback (empty flags, `requires_human_review: true`, `review_reason` explains the truncation, `__parse_error` retained for debugging). Client-side `onAnalyze` has a 90s `AbortController` safety net and surfaces "Analysis is taking longer than expected. Please try again." on timeout (with the transcript hash logged for pattern analysis). Pre-flight confirm() prompt when estimated input >150k tokens.

**Frontend warnings (non-blocking):** word count >15k → confirm; char count <200 → toast warning; duplicate hash (SHA-256 of the transcript stored in `SESSION_TRANSCRIPT_HASHES`) → confirm before re-analyze.

### CRM-transcript match guard
`onAnalyze` enforces that if an EHR record is loaded (`CURRENT_CRM != null`), the transcript must mention at least one of `CURRENT_CRM.name_aliases` (or the full `name`). On mismatch it shows a blocking `alert()` and calls `onLookupReset()` to clear name, ID, transcript, and prior results. If lookup was skipped (no CRM loaded), the analyzer runs against the transcript alone — `findCrmFromTranscript` may still backfill a record by alias scan server-side.

### HITL Agree/Disagree gate on Recommendation
After analysis renders, the Recommendation pane shows **Agree** / **Disagree** CTAs. Each click opens `customConfirm(...)` — an in-page modal (`#confirmModal`) that replaces the browser-native `confirm()` so the popup doesn't show the `<vercel-domain> says` title that browsers force on `confirm()`/`alert()`. The helper is `async customConfirm(message, { title, okLabel, cancelLabel })` returning `Promise<boolean>`. Other confirms in the app (duplicate-hash check, long-transcript warning, delete-SOP) still use the native `confirm()` intentionally — swap them via `customConfirm` if you need consistent styling.
- **Agree** (confirmed) → green badge + the **Next Steps card is revealed** (hidden by default via `#nextStepsWrapper`).
- **Disagree** (confirmed) → opens `#disagreeModal`, a notes modal with a free-form textarea and two CTAs:
  - **Cancel** → closes the modal and resets the recoDecision UI so the Specialist can choose again. The decision is never committed.
  - **Push Notes to Patient Profile** → posts to `/api/integrations/export` with `kind: disagree_notes`, locks the recoDecision with "Notes pushed to the patient profile. Please return to the EHR system to review the case.", and shows the orange `#disagreeCard` banner. Empty notes are rejected with a toast.

The Evaluation and Triggered SOP Findings cards render regardless of the Agree/Disagree decision (they're audit/QA info, not action surfaces).

### Per-step thumbs gating + Copy Message (Next Steps card)
Each step row in `renderSteps` carries state in `STEP_STATE[i] = { vote, done, notes_pushed }`. A row is `locked` when `done || notes_pushed`:
- The recommended EHR CTA is `disabled` until 👍 (then `vote === "up"` enables it). Clicking 👍 again toggles back to undecided.
- 👎 **opens `#stepDownModal`**, a notes modal scoped to that step. It shows the step text (read-only), a free-form notes textarea, and two CTAs:
  - **Cancel** → closes the modal; the 👎 vote is never committed (row returns to undecided).
  - **Push to Patient Profile** → posts to `/api/integrations/export` with `kind: step_disagree_notes` and `step_index` / `step_text` / `notes`. On success: commits `vote = "down"` + `notes_pushed = true`, removes this step from `COPIED_STEP_MESSAGES` (so it's excluded from Draft Email), and locks the row with a red **"Notes pushed"** badge.
- After a successful `/api/integrations/export` on the EHR CTA, the row is marked `done` and locked with a green **"Completed"** badge.
- The CTA target/kind is inferred from the step text by `inferStepCta` (keyword match on "document", "notify", "schedule", "escalate", "request", "revision pathway", "close case"). All CTAs target "EHR" labels. If you add new disposition-tail wording, update `inferStepCta`.

**Copy Message button** appears alongside the EHR CTA on **patient-communication steps** — `PATIENT_COMM_SOPS = {GEN-001, JNT-001, JNT-002, BAR-002, BAR-003}` plus a keyword fallback (`notify|refer|instruct|cessation|...`). Internal-only SOPs (`JNT-003`, `JNT-004`, `BAR-001`) and the documentation tail step do NOT get the button. Clicking it copies a per-step patient-facing message (templates in `PATIENT_MESSAGES_BY_SOP`) to the clipboard via `navigator.clipboard.writeText` AND pushes onto `COPIED_STEP_MESSAGES` (deduped by `stepIndex`) for the Draft Email aggregator. **Copy Message stays enabled on `done` rows** — only `notes_pushed` rows disable it — so the Specialist can: approve → Update EHR → Copy Message → next step.

### Draft patient email (Claude-drafted, bottom of Next Steps)
The auto-generated email template was replaced with a Claude-drafted flow:
1. As the Specialist clicks Copy Message on comm steps, entries accumulate in `COPIED_STEP_MESSAGES` (`{stepIndex, sopId, stepText, message}`). The "Draft Email (N steps)" CTA at the bottom of the Next Steps card stays disabled until at least one message has been copied. The count updates live via `renderDraftEmailControls`.
2. Clicking **Draft Email** posts to `POST /api/draft-email` ([lib/draft-email.js](lib/draft-email.js)) with `{ patient_name, case_type, disposition, copied_messages[], specialist_name }`. Claude returns STRICT JSON `{ subject, body }`. 30s `AbortController` timeout; `max_tokens: 1000`. Vercel `maxDuration: 35`.
3. The frontend assembles `Subject: ...\n\n<body>` into an editable textarea + a **Copy Email** button. The Specialist can edit before copying.

**Prompt rule worth knowing** (commit `26defb9`): every entry in `copied_messages` must render as its own bullet line — Claude is forbidden from merging two messages into one bullet, paraphrasing a message into the disposition intro paragraph, or dropping a bullet because its content overlaps the disposition framing. The disposition intro is general-purpose framing only and cannot borrow content from the copied messages. The only allowed dedup is two messages referencing the exact same SOP id with identical text. Past failure: Bob's "notify patient of ineligibility" message was being absorbed into the intro paragraph, leaving only the PT bullet visible.

`COPIED_STEP_MESSAGES` resets in `renderResults` for each new analysis, so the email always reflects the *current* case. `onCopyEmail` reads the textarea (not the original draft) so edits survive the copy.

Both copy actions use `navigator.clipboard.writeText`, which requires HTTPS or `localhost` (works on Vercel and `npm run dev`). The whole Next Steps card — including the Draft Email block — is gated by the recommendation Agree/Disagree decision and only appears after the Specialist clicks Agree.

### Mock SSO / Integrations
- `/api/sso/signin` returns a hardcoded `Jordan G / Care Specialist` user.
- `/api/integrations/import` is a stub that returns canned transcripts per source (`googleworkspace` / `five9` / default). **Currently not called from the UI** — all three import buttons (Upload File / Import from Google Workspace / Import from Five9) trigger `#fileInput.click()` so the Specialist always picks a `.txt` from their local file system. The branded buttons exist for demo polish and visually carry inline-SVG emblems via `.brand-icon`. The endpoint and the `onImportSample` JS helper are dead-code paths kept for future re-wiring; safe to delete if you don't need them.
- `/api/integrations/export` returns a fake `EXP-######` reference. Called from multiple places with different `kind` values: per-step EHR CTAs (no `kind`, just `step_index`/`step_text`), step thumbs-down (`kind: step_disagree_notes`), recommendation Disagree (`kind: disagree_notes`). All carry the original `LAST_RESULT` as payload.
- **Don't let "make these real" silently turn into real integrations.** They are deliberately stubs — anything wiring them to real Salesforce/Google Workspace/Five9/Outlook must be explicitly scoped.

### File upload (frontend, browser-side)
The transcript textarea accepts `.txt .md .log .html .htm .json .csv .xml .srt .vtt .docx .pdf`. `onFileChosen` dispatches by extension:
- Plain text formats read with `FileReader.readAsText`.
- `.html`/`.htm` are stripped to text via a temporary DOM node.
- `.srt`/`.vtt` have cue numbers and `HH:MM:SS,mmm --> ...` timestamps stripped before being placed in the textarea.
- `.json` is run through `flattenJsonTranscript` — looks for an array under `messages|transcript|dialogue|conversation|turns|utterances|entries`, maps each entry's `speaker|role|from|author|name` and `text|content|utterance|message|body`, and emits `Speaker [timestamp]: text` lines. Falls back to raw JSON if no recognizable structure is found.
- `.docx` uses `mammoth.browser.min.js` (CDN, lazy-loaded on first use).
- `.pdf` uses `pdfjs-dist` (CDN, lazy-loaded on first use, with a worker URL fallback).

CDN libraries are loaded once via `loadScriptOnce` and cached on `window.__scripts`. They are the only external runtime dependencies — keep this contained to the upload path.

### PowerShell 5.1 traps (these have all bitten in prior versions)
1. **Source must be ASCII-only.** PS 5.1 reads UTF-8-without-BOM as Windows-1252 — em-dashes, smart quotes, etc., cause cryptic parse errors.
2. **`Set-Content -Encoding utf8` writes UTF-8-WITH-BOM in PS 5.1.** Doing this to `sops.json` or `crm.json` prepends a `U+FEFF` byte that crashes `JSON.parse` on Vercel with the misleading `Unexpected token '﻿', "﻿{ ... is not valid JSON`. Defenses in place: `readSops` / `readCrm` in `lib/data.js` strip a leading BOM before parsing. To write JSON from PS without BOM: `[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))`. Or use the Edit/Write tools (no BOM). Or PS 7's `-Encoding utf8NoBOM`.
3. **`$resp.OutputStream.Close()` in every code path** (success AND error). HttpListener leaks otherwise.
4. **No ternary.** Use `if (cond) { val } else { other }`.
5. **`ConvertFrom-Json` returns PSCustomObject**, not hashtable — use `.foo` not `["foo"]`.

### UTF-8 round-trip on the Anthropic path
Three explicit UTF-8 boundaries in `server.ps1` (any one of them defaulting back to ANSI mangles non-ASCII transcripts):
1. **Read request body** — `StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)` in `Read-RequestBody`.
2. **Send to Anthropic** — `[System.Text.Encoding]::UTF8.GetBytes($bodyJson)`, pass byte array as `-Body`.
3. **Decode response** — `Invoke-WebRequest -UseBasicParsing` + `[System.Text.Encoding]::UTF8.GetString($rawResp.RawContentStream.ToArray())`. **Do not** use `Invoke-RestMethod` — it auto-decodes via the response's declared charset and falls back to Latin-1.

The Anthropic catch block reads `$_.Exception.Response.GetResponseStream()` to surface the real error body. Don't strip it out.

## SOP Library — read-only in the UI

The **SOP Library tab is view-only** (commit `33309e6`). The Add SOP button, per-card Edit/Delete buttons, the SOP edit modal, and the `openSopEditor` / `onSaveSop` / `onDeleteSop` JS were all removed. The grid still renders each rule's id, status badge, finding, category + applies_to, action, and trigger_logic — but no mutation surface.

The CRUD route handlers (`POST /api/sops`, `PUT /api/sops/{id}`, `DELETE /api/sops/{id}`) still exist in `pages/api/sops/*` and still call `writeSops` (`lib/data.js`) which throws `READONLY` when `process.env.VERCEL` is set. Nothing in the UI currently invokes them. Re-introducing SOP editing would mean re-adding the UI; the server side is dormant but intact.

To change SOP content, edit `sops.json` in the repo and push — `main` auto-deploys.

## Files

| File / dir | Purpose |
|------------|---------|
| `package.json`, `next.config.js`, `vercel.json` | Next.js + Vercel configuration. `/` rewrites to `/app.html`. `vercel.json` declares per-route `maxDuration` (analyze/extract 60s, draft-email 35s, evaluate 30s, preflight 20s). |
| `pages/api/*.js` | Serverless route handlers — health, sso/signin, crm/lookup, sops (GET/POST), sops/[id] (PUT/DELETE), integrations/import, integrations/export, analyze, extract, evaluate, preflight, draft-email. Pages router (not App router) for simpler `req.body` handling. |
| `lib/data.js` | Reads `sops.json`/`crm.json`. `writeSops` throws `READONLY` when `process.env.VERCEL` is set. CRM lookup helpers (by query and from-transcript). |
| `lib/disposition.js` | `STATUS_PRIORITY` map and `getOverallDisposition`. Mirrored in `server.ps1` and the Claude prompts — keep all in sync. |
| `lib/analyze-local.js` | Faithful JS port of `Invoke-LocalAnalysis`, including per-SOP regex guardrails and the no-CRM-data summary builder. |
| `lib/analyze-claude.js` | Anthropic API call with the strict-no-CRM + priority + JSON-extraction prompt. 50s timeout. |
| `lib/extract.js` | Anthropic API call for structured flag extraction; reads `schemas/extraction-schema.json` at request time so schema edits go live without a redeploy. 50s timeout, `max_tokens: 4000`, safe-fallback on parse failure. |
| `lib/preflight.js` | Anthropic API call for the upload gate — returns `is_clinical_transcript` + `detected_language`. Input capped at 4000 chars; 15s timeout. |
| `lib/draft-email.js` | Anthropic API call that drafts the patient email from `COPIED_STEP_MESSAGES`. Returns STRICT JSON `{ subject, body }`. 30s timeout, `max_tokens: 1000`. |
| `lib/evaluate-gemini.js` | Gemini API call for the four evaluator dimensions. Default model `gemini-2.5-flash-lite` (free-tier-0 traps on `gemini-2.0-flash` for new keys). 25s timeout. **`sop_accuracy` AND `extraction_completeness` are deterministic and override Gemini's values in `pages/api/evaluate.js`** — only `next_step_actionability` and `human_review_appropriateness` reach the response as Gemini-judged. |
| `lib/score-extraction-completeness.js` | Deterministic `extraction_completeness` scorer. Per-flag keyword regex; -0.2 for each null flag whose topic keyword appears in the transcript. Topics never raised in the transcript → null is correct → no penalty. Gated by `case_type` so joint cases aren't checked against bariatric flags and vice versa. Replaces Gemini's judgment for this dimension. |
| `lib/score-human-review.js` | Deterministic `human_review_appropriateness` scorer. **One-sided** — conservative escalation (`requires_human_review: true`) is always acceptable; the only real failure mode is suppression on incomplete data. Score 1.0 when flag is true with non-empty review_reason OR flag is false with sufficient data (null_flag_count < 3 AND findings non-empty); 0.5 when flag is true but review_reason is empty; 0.0 only when flag is false BUT review is mandatory. Replaces Gemini's judgment for this dimension. |
| `lib/score-next-step-actionability.js` | Deterministic `next_step_actionability` scorer. Validates the structural contract from the analyze prompt: one `[SOP-ID]`-prefixed step per finding (-0.3 each missing), final step matches the documentation pattern (-0.2 if not), and step count is at least `findings + 2` to include the disposition tail (-0.1 if short). Replaces Gemini's judgment for this dimension. |
| `lib/score-sop-accuracy.js` | Deterministic `sop_accuracy` scorer. Encodes the three concrete penalty grounds: case_status mismatch (-0.3 each), disposition mismatch (-0.3), null-flag firing (-0.4 each). Clean output scores 1.0. Replaces Gemini's judgment for this dimension. |
| `public/app.html` | Single-page UI. CDN libraries (mammoth, pdf.js) lazy-loaded only for `.docx`/`.pdf` upload. Hosts all client-side edge-case handling, Agree/Disagree gate, per-step Copy Message, draft email. Analyzer view uses `container.full` (no side panel — the Engine Status side card was removed). |
| `server.ps1` | PowerShell `HttpListener` backend — Windows local-only, parity with Next.js except missing `/api/preflight` and `/api/extract`. |
| `sops.json` | v2.0 SOP library under `rules[]` (8 rules: 1 General, 4 Joint, 3 Bariatric). Editable from the UI in dev only. |
| `crm.json` | Mock EHR (3 sample patients). Edit `name_aliases` to control which transcripts match. |
| `schemas/extraction-schema.json` | Unified case-document contract for `/api/extract`. Leaf values are pseudo-type strings (`"boolean | null"`) replaced by the extractor with concrete values. The `evaluation` block is a null placeholder filled by `/api/evaluate`. |
| `schemas/ehr-schema.json` | EHR patient-panel display contract (name, age, sex, location, employer, BMI, height/weight, phone). |
| `samples/` | Standalone sample transcripts for manual upload testing. |
| `.env.example` | Template — copy to `.env` and add `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, optional `ANTHROPIC_MODEL` / `GEMINI_MODEL`. |
| `.gitignore` | `.env`, `.env.*` (with `!.env.example`), `node_modules/`, `.next/`, `.vercel/`. **Load-bearing for security.** |
| `.gitattributes` | LF in repo, CRLF for `*.ps1` working trees, binary markers for png/pdf/docx etc. |
| `.claude/launch.json` | Preview config (`premier-analyzer`). |

### Git / repository

`main` is deployed to Vercel automatically. `.gitignore` is load-bearing for keeping the Anthropic and Gemini keys out of the repo — run `git check-ignore -v .env` before any commit that touches gitignore. **Never `git add -f .env` and never copy `.env` to a name other than `.env.example`** — `.env.txt` was the bug we hit pre-push that almost shipped a real key.
