import fs from "fs";
import path from "path";

function extractOutermostJson(text) {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.substring(first, last + 1);
  return text;
}

function readSchema() {
  const p = path.join(process.cwd(), "schemas", "extraction-schema.json");
  return fs.readFileSync(p, "utf8");
}

export async function invokeExtraction(transcript, crmRecord) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const schemaText = readSchema();
  const crmBlock = crmRecord
    ? `Patient (from CRM): ${crmRecord.name}, ${crmRecord.age}${crmRecord.sex}, ${crmRecord.location}. Case type: ${crmRecord.case_type}. BMI: ${crmRecord.bmi}. Dx: ${crmRecord.primary_dx}.`
    : "Patient not found in CRM. Use transcript only.";

  const system = `You are a clinical fact extractor for the Carrum Health Care Team. Read the call transcript and output a single JSON object that matches the provided schema. The schema's leaf values are TYPE HINTS (e.g. "boolean | null") — your output must replace each hint with a concrete value of that type, or null when the transcript does not address the flag.

EXTRACTION RULES:
- For every flag, populate "value" with a concrete typed value (boolean, integer, float, or string per the hint), or null if the transcript is silent on it.
- For every flag where value is non-null, include a short verbatim "source_quote" from the transcript that justifies the value. Keep quotes under 25 words.
- "confidence" must be one of "high" (explicit, unambiguous patient/clinician statement), "medium" (clearly inferred), "low" (weak or indirect signal). Use null when value is null.
- patient.case_type must be lowercase ("joint" or "bariatric") and should match the CRM case_type if available.
- clinical_flags.general always applies. clinical_flags.joint applies only when case_type is "joint"; clinical_flags.bariatric only when "bariatric". Flags outside the applicable case_type may all be null.
- additional_context: extract any comorbidities, infections, blood clot history, oxygen use, substance use, current medications, mobility status. Empty arrays / nulls are fine when not mentioned.

SOP RECOMMENDATIONS:
Generate sop_recommendations[] entries from triggered flags using this mapping:
- GEN-001 (General, Action Required, priority 7): triggered when dental_visit_within_6_months == false OR pending_dental_work == true.
- JNT-001 (Joint, Deferred, priority 2): active_smoker == true OR quit_smoking_within_3_months == true.
- JNT-002 (Joint, Ineligible, priority 1): attempted_pt == false.
- JNT-003 (Joint, Review, priority 4): hba1c_value > 7.0.
- JNT-004 (Joint, High Complexity, priority 3): daily_opioid_use == true AND opioid_duration_months > 3.
- BAR-001 (Bariatric, Revision Case, priority 5): prior_weight_loss_surgery == true.
- BAR-002 (Bariatric, Action Required, priority 7): endoscopy_within_3_months == false.
- BAR-003 (Bariatric, Hold, priority 6): has_registered_dietician == false.
For each triggered SOP, fill: id, category, finding (one short sentence describing the trigger), case_status, action (the corresponding intervention), triggered_by_flags (the flag names that fired it), priority.

OVERALL CASE STATUS:
overall_case_status = the case_status of the sop_recommendation with the LOWEST priority number. If sop_recommendations is empty, set "Clear".

CASE SUMMARY:
case_summary: 2-3 plain-English sentences summarizing the patient and what is driving the disposition.

EXTRACTION METADATA:
- extraction_confidence: high if most flags have high confidence, medium if mixed, low if mostly low/null.
- requires_human_review: true if (a) any flag has confidence "low", OR (b) more than half of the case-type-applicable flags are null, OR (c) overall_case_status is Ineligible/Deferred/High Complexity (high-impact dispositions warrant a second look).
- review_reason: short reason if requires_human_review is true, else null.
- missing_flags: array of dotted flag paths whose value is null and that should have been extractable (e.g. "joint.attempted_pt").
- ambiguous_flags: array of dotted flag paths where confidence is "low".
- null_flag_count: integer count of flags with null value.

OUTPUT: STRICT JSON only, no prose, no code fences. Match the schema below exactly.

SCHEMA:
${schemaText}`;

  const user = `${crmBlock}\n\nTRANSCRIPT:\n${transcript}`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: 3000,
      system,
      messages: [{ role: "user", content: user }]
    })
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Claude extraction error: ${resp.status} ${resp.statusText}. Body: ${errBody}`);
  }

  const respJson = await resp.json();
  const text = respJson.content?.[0]?.text || "";
  const cleaned = extractOutermostJson(text).trim();
  return JSON.parse(cleaned);
}
