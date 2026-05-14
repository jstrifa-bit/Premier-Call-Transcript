import { readSops } from "./data.js";

function extractOutermostJson(text) {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.substring(first, last + 1);
  return text;
}

export async function invokeClaudeAnalysis(transcript, crmRecord) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const sops = readSops().rules || [];
  const sopBlock = sops.map(s =>
    `- ${s.id} [${s.category} / ${s.case_status}] applies_to=[${(s.applies_to || []).join(", ")}] required_flags=[${(s.required_flags || []).join(", ")}]: finding='${s.finding}' | trigger_logic='${s.trigger_logic}' | action='${s.action}'`
  ).join("\n");

  // Case type is the ONLY thing we pass from CRM, and only for applies_to gating.
  // Demographic and clinical CRM fields (name, age, sex, BMI, dx, location) are
  // intentionally withheld so the LLM cannot reference them in the output.
  const caseTypeBlock = crmRecord && crmRecord.case_type
    ? `Case type (use ONLY to gate which SOPs apply via their applies_to lists; do not reference this field in patient_summary or recommendation): ${crmRecord.case_type}`
    : "Case type unknown - apply general SOPs only.";

  const system = `You are a clinical data extraction assistant for the Premier Health Care Team.

CRITICAL - NO CRM/EHR GROUNDING: You are given ONLY the patient's case_type plus the call transcript. You do NOT have access to any EHR, CRM, or demographic database. Treat the case_type as a routing tag only - never paraphrase or restate it as patient context. NEVER invent or include the patient's full name, age, sex, location/city/state, BMI, or primary diagnosis in patient_summary or recommendation unless the patient or specialist explicitly stated that fact aloud in the transcript. Phrasing like "per EHR", "per CRM", "according to EHR/CRM", "based on the patient profile", or "presenting with [diagnosis] per EHR" is forbidden. If a fact is not in the transcript text below, do not write it.

CRITICAL - PATIENT CERTAINTY RULE (a finding requires confirmed evidence):
A finding fires ONLY when the patient's response provides direct, confirmed evidence of the triggering fact. Patient hedges signal MISSING DATA, not a triggered rule. Treat the following as non-triggering:
- "maybe", "possibly", "I think", "I'm not sure", "I don't know", "I can't remember", "I don't recall"
- "I did some stuff", "something", "a while back", "a while ago", "at some point"
- Any response where the patient cannot quantify, date, or name the clinical fact being asked about
- The specialist asking the question (the question is not the patient's confirmation)

When the patient is unable to confirm or deny a clinical fact, DO NOT include a finding for that rule. An empty findings array is the CORRECT output for an ambiguous call; you may return zero findings. Producing a finding with hedged evidence ("Maybe?", "It's been a while") is a routing error - the data must be collected via follow-up before a rule fires.

Positive triggers look like clear past-tense affirmation ("I had a sleeve in 2018", "I'm on oxycodone every day"), clear denial ("No, no one has ordered that yet"), or specific numbers ("My A1c was 7.6"). If the evidence is anything weaker than that, omit the finding.

DIRECT DENIAL DOMINATES NEARBY SOFTENING: When a single patient response contains both a direct denial AND softening words about adjacent activities, the direct denial governs. Examples:
- "Honestly no. I tried the gym a couple of times but never did real PT." → direct denials "Honestly no" and "never did real PT" dominate the softening "tried the gym a couple of times". The patient is confirming attempted_pt == false. JNT-002 fires.
- "No, I haven't seen a dietitian. I looked at some pamphlets once." → "No, I haven't seen a dietitian" is the direct answer. The pamphlet remark doesn't erase it. has_registered_dietician = false fires BAR-003.
- "I haven't smoked in five years, though I had a cigarette at a wedding last month." → the recent cigarette is a softening event; the direct denial about being a smoker dominates the active_smoker flag (false), though contradictions warrant a low-confidence note.

This is different from a pure hedge: "Maybe? I think I did something" has NO direct denial and NO direct affirmation - it's all uncertainty, so the rule does not fire. The direct-denial-dominates rule applies only when the response contains an unambiguous yes/no statement about the SOP-relevant fact, with the softening words decorating adjacent details.

Compare the call transcript against the SOPs and return STRICT JSON with this shape:
{
  "patient_summary": "A 3-4 sentence clinical summary GROUNDED ENTIRELY IN THE TRANSCRIPT. Cover the chief concern, key clinical facts the patient or specialist actually said (BMI if stated in the call, prior surgeries mentioned, comorbidities discussed, medications named, lifestyle factors raised), and any red flags raised in conversation. Plain prose, no bullet points. DO NOT reference, paraphrase, or infer from CRM data, demographics, or any patient information not stated in the transcript itself.",
  "recommendation": "A 2-3 sentence narrative recommendation that names the specific SOPs that drove the disposition (cite their IDs like BAR-002) and tells the Specialist what to do next in clinical terms. Reference only what was discussed in the transcript - DO NOT mention EHR/CRM data, demographic context, or facts not present in the call.",
  "findings": [
    { "sop_id": "BAR-002", "title": "...", "category": "...", "finding": "...", "status": "...", "action": "...", "evidence": "short quoted snippet from transcript" }
  ],
  "overall_disposition": { "status": "Ineligible|Deferred|High Complexity|Review|Revision Case|Hold|Action Required|Cleared", "reason": "one-line summary of the most blocking finding" },
  "next_steps": ["short imperative actions specific to THIS patient, derived from patient_summary and recommendation; SOP-tied ones prefixed like [BAR-002]"]
}
Only include findings that are clearly supported by the transcript. Use the exact SOP id, the SOP's case_status as 'status', and copy the SOP's finding text into 'title'. Each SOP has an applies_to list - only fire SOPs whose applies_to includes the patient's case_type (case-insensitive).

Disposition priority (lower number = more blocking, MUST be applied strictly):
1. Ineligible
2. Deferred
3. High Complexity
4. Review
5. Revision Case
6. Hold
7. Action Required
8. Cleared (only when no SOPs are triggered)

To set overall_disposition.status: take the status field of EVERY finding, look up its priority number above, pick the finding with the LOWEST number, and copy its status verbatim. Do not aggregate, average, or substitute. If a Revision Case finding (priority 5) coexists with a Hold finding (priority 6), the disposition is Revision Case.

CONSISTENCY RULE - the findings array is the source of truth:
Write 'findings' FIRST, then derive 'recommendation', 'patient_summary', and 'next_steps' from it. Every SOP ID you cite in 'recommendation' or 'patient_summary' MUST appear as an entry in the 'findings' array - and vice versa, every SOP ID in 'findings' must be referenced by the 'recommendation' it drove. Never mention a SOP id in prose that isn't in the structured findings list. If you decided the Patient Certainty Rule prevents JNT-002 from firing (so JNT-002 is NOT in findings), then JNT-002 must NOT appear in the recommendation either - drop it from the prose. This consistency check prevents the case where the prose says "two SOPs fire" but the structured output only lists one.

The 'overall_disposition.status' field also follows from findings alone: compute it from the case_status values of the items actually in findings (using the strict priority rule above), never from rules you only described in prose.

How to build next_steps (do this LAST, after writing patient_summary, recommendation, findings, and overall_disposition):
1. Re-read the patient_summary and recommendation you just wrote. Every step must be traceable to something stated there.
2. Produce 3-7 short, imperative steps in execution order (most blocking first, mirroring the disposition priority).
3. For EVERY entry in findings, produce one step prefixed with its SOP id in brackets, e.g. "[BAR-002] Order pre-op EGD and place case on hold until results are reviewed." This is mandatory: a finding without a corresponding [SOP-ID] step is a routing error. If two findings fired, you produce two SOP-prefixed steps - one each - even when one finding drives the overall disposition. The disposition tail step and documentation step come AFTER all SOP-prefixed steps.
4. After the SOP-tied steps, add a disposition-specific tail step (e.g. "Notify patient of ineligibility and close case in EHR" for Ineligible; "Schedule 90-day follow-up with cessation resources" for Deferred).
5. End with one documentation step: "Document the call summary, disposition, and next-step assignments in the patient's EHR record."
6. Steps must be patient-specific (use names, dosages, timeframes pulled from the transcript when present). Do NOT emit generic placeholders like "follow up with patient."`;

  const user = `SOPs:\n${sopBlock}\n\n${caseTypeBlock}\n\nTranscript:\n${transcript}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 50000);

  let respJson;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        system,
        messages: [{ role: "user", content: user }]
      }),
      signal: controller.signal
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Claude API error: ${resp.status} ${resp.statusText}. Body: ${errBody}`);
    }
    respJson = await resp.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Claude analysis timed out after 50s");
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
  const text = respJson.content?.[0]?.text || "";
  const cleaned = extractOutermostJson(text).trim();
  const parsed = JSON.parse(cleaned);

  return {
    engine: "claude",
    model,
    patient_summary: parsed.patient_summary,
    recommendation: parsed.recommendation,
    findings: parsed.findings,
    overall_disposition: parsed.overall_disposition,
    next_steps: parsed.next_steps
  };
}
