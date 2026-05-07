# Premier Call Transcript Analyzer

A demo single-folder web app for Care Specialists. Sign in with mock SSO, look up a patient, paste/import a call transcript, click **Analyze**, and get a 3-4 sentence summary, an SOP-mapped recommendation, and patient-specific next steps with one-click automations.

Designed to *feel* like an internal tool integrated with Salesforce / Google Meet / Outlook (all mocked). Built deliberately with **zero build tooling**: PowerShell 5.1 backend (`System.Net.HttpListener`) and a single self-contained HTML file frontend.

## Quick start

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1
# then open http://localhost:4321/app.html
```

To enable AI engines:

```powershell
Copy-Item .env.example .env
# edit .env, add ANTHROPIC_API_KEY (analysis) and/or GEMINI_API_KEY (confidence scoring)
# then restart the server
```

Without `ANTHROPIC_API_KEY` the server uses a deterministic local heuristic. Without `GEMINI_API_KEY` the confidence-score panel is hidden.

## What's in the box

| Capability | Implementation |
|---|---|
| Mock Carrum SSO gate | `POST /api/sso/signin` returns hardcoded "Jordan G" |
| CRM lookup | `POST /api/crm/lookup` against `crm.json` (3 sample patients) |
| Transcript import | `POST /api/integrations/import?source=googlemeet` returns canned text |
| Transcript file upload | `.txt .md .log .html .json .csv .xml .srt .vtt .docx .pdf` (PDFs/DOCX via lazy-loaded CDN libraries) |
| Structured-JSON flatten | Auto-flattens `{messages:[{speaker,text}]}` shapes into `Speaker: text` lines |
| SOP analysis | `POST /api/analyze` -> Claude (Anthropic) or local heuristic |
| Confidence scoring | `POST /api/evaluate` -> Gemini scores Recommendation & Next Steps 0-100 |
| Per-step approval | 👍 unlocks the recommended automation; 👎 flags the step for manual follow-up |
| SOP editor | CRUD in the UI; writes back to `sops.json` (no DB) |
| Mock exports | `POST /api/integrations/export` -> fake `EXP-######` reference |

## Sample patients (smoke tests)

The 3 case-study patients are inlined in `app.html` as quick-load buttons. Expected dispositions (must hold across heuristic / prompt / SOP edits):

| Patient | Disposition | Findings |
|---|---|---|
| Sarah Mitchell | Revision Case | BAR-001, BAR-002, BAR-003 |
| Robert Carlson | Ineligible | JNT-002, JNT-004 |
| Maria Alvarez | Deferred | JNT-001, JNT-003 |

## Files

- **`server.ps1`** - HTTP listener, all API routes, both analysis engines, Gemini evaluator
- **`app.html`** - Single-page UI (no framework, no bundler)
- **`sops.json`** - SOP library v2.0 (`rules[]` with `applies_to` / `case_status` / `trigger_logic`)
- **`crm.json`** - Mock CRM (3 patients with name aliases)
- **`samples/`** - Sample transcripts for manual upload testing
- **`CLAUDE.md`** - Architecture deep-dive for Claude Code / future contributors

## Status

Prototype. All integrations (Salesforce, Google Meet, Epic, Outlook) are stubs. No persistence beyond JSON files on disk. No tests beyond the 3 inline smoke samples.
