import { invokeLocalAnalysis } from "../../lib/analyze-local.js";
import { invokeClaudeAnalysis } from "../../lib/analyze-claude.js";
import { invokeExtraction } from "../../lib/extract.js";
import { findCrmByQuery, findCrmFromTranscript, readSops } from "../../lib/data.js";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

// Patient-friendly labels for missing flags used when drafting the
// follow-up questionnaire next step.
const FLAG_TO_TOPIC = {
  dental_visit_within_6_months: "recent dental visit",
  pending_dental_work: "pending dental work",
  active_smoker: "current smoking status",
  quit_smoking_within_3_months: "recent smoking cessation",
  attempted_pt: "physical therapy history",
  hba1c_value: "most recent HbA1c value",
  daily_opioid_use: "daily opioid use",
  opioid_duration_months: "opioid duration",
  prior_weight_loss_surgery: "prior weight-loss surgery history",
  endoscopy_within_3_months: "recent endoscopy",
  has_registered_dietician: "registered dietitian relationship"
};

function flagValueFromExtraction(extraction, flagName) {
  const cf = extraction?.clinical_flags || {};
  for (const cat of ["general", "joint", "bariatric"]) {
    if (cf[cat] && Object.prototype.hasOwnProperty.call(cf[cat], flagName)) {
      const v = cf[cat][flagName]?.value;
      return v === undefined ? null : v;
    }
  }
  return null; // flag not present in extraction
}

function applyIncompleteTranscriptRule({ extraction, result, crm }) {
  if (!extraction) {
    return { findings: result.findings, next_steps: result.next_steps, overall_disposition: result.overall_disposition, unresolvable: [] };
  }
  const sops = (readSops().rules || []);
  const caseType = (crm?.case_type || "").toLowerCase();
  const applicable = sops.filter(s => (s.applies_to || []).some(at => String(at).toLowerCase() === caseType));

  // Per-rule unresolvable check: any required_flag null -> rule cannot evaluate.
  const unresolvable = [];
  for (const rule of applicable) {
    for (const f of (rule.required_flags || [])) {
      if (flagValueFromExtraction(extraction, f) === null) {
        unresolvable.push({ id: rule.id, finding: rule.finding, missing_flags: (rule.required_flags || []).filter(rf => flagValueFromExtraction(extraction, rf) === null) });
        break;
      }
    }
  }
  const unresolvableIds = new Set(unresolvable.map(u => u.id));

  // Remove findings whose sop_id is unresolvable - the analyzer should not
  // route on rules whose flags couldn't be read.
  const newFindings = (result.findings || []).filter(f => !unresolvableIds.has(f.sop_id));

  const meta = extraction.extraction_metadata || {};
  const incomplete = (Number(meta.null_flag_count) >= 3) || meta.requires_human_review === true;

  if (!incomplete) {
    return { findings: newFindings, next_steps: result.next_steps, overall_disposition: result.overall_disposition, unresolvable };
  }

  // Incompleteness override: status -> Pending - Callback Required;
  // next_steps -> dynamic follow-up questionnaire built from missing flags.
  const missingTopics = [];
  for (const rule of applicable) {
    for (const f of (rule.required_flags || [])) {
      if (flagValueFromExtraction(extraction, f) === null) {
        const topic = FLAG_TO_TOPIC[f] || f;
        if (!missingTopics.includes(topic)) missingTopics.push(topic);
      }
    }
  }
  const questionnaire = missingTopics.length
    ? `Send follow-up questionnaire covering: ${missingTopics.join(", ")}.`
    : "Send follow-up questionnaire to capture missing clinical history.";

  return {
    findings: newFindings,
    next_steps: [
      questionnaire,
      "Document the call summary and disposition in the patient's EHR record."
    ],
    overall_disposition: { status: "Pending - Callback Required", reason: "Insufficient data to evaluate SOPs; follow-up needed." },
    unresolvable
  };
}

export default async function handler(req, res) {
  // Outermost try/catch so any unhandled error returns a JSON envelope
  // instead of letting Vercel render its HTML error page. The browser's
  // response.json() then surfaces the real error rather than the
  // unhelpful "Unexpected token '<'" parse failure.
  try {
    if (req.method !== "POST") { res.status(405).end(); return; }
    const started = Date.now();
    const { transcript, patient_name, patient_id } = req.body || {};
    if (!transcript) { res.status(400).json({ ok: false, error: "transcript required" }); return; }

    let crm = findCrmByQuery({ name: patient_name, patient_id });
    if (!crm) crm = findCrmFromTranscript(transcript);

    const hasClaude = !!process.env.ANTHROPIC_API_KEY;
    const analysisPromise = hasClaude
      ? invokeClaudeAnalysis(transcript, crm).catch(e => ({ __error: e.message }))
      : Promise.resolve(invokeLocalAnalysis(transcript, crm));
    const extractionPromise = hasClaude
      ? invokeExtraction(transcript, crm).catch(e => ({ __error: e.message }))
      : Promise.resolve({ __error: "extraction requires ANTHROPIC_API_KEY" });

    const [analysisRaw, extractionRaw] = await Promise.all([analysisPromise, extractionPromise]);

    let result, claude_error = null;
    if (analysisRaw.__error) {
      claude_error = analysisRaw.__error;
      result = invokeLocalAnalysis(transcript, crm);
    } else {
      result = analysisRaw;
    }

    const extraction = extractionRaw.__error ? null : extractionRaw;

    // Defensive: if the post-process throws (bad extraction shape, sops.json
    // unreachable, etc.) fall back to the raw result so the analyze response
    // still succeeds without unresolvable[] / pending status.
    let post;
    try {
      post = applyIncompleteTranscriptRule({ extraction, result, crm });
    } catch (e) {
      console.warn("applyIncompleteTranscriptRule threw:", e.message, e.stack);
      post = {
        findings: result.findings,
        next_steps: result.next_steps,
        overall_disposition: result.overall_disposition,
        unresolvable: []
      };
    }

    const out = {
      ok: true,
      engine: result.engine,
      model: result.model,
      crm_record: crm,
      patient_summary: result.patient_summary,
      recommendation: result.recommendation,
      findings: post.findings,
      overall_disposition: post.overall_disposition,
      next_steps: post.next_steps,
      unresolvable: post.unresolvable,
      extraction,
      elapsed_ms: Date.now() - started
    };
    if (claude_error) out.claude_error = claude_error;
    if (extractionRaw.__error) out.extraction_error = extractionRaw.__error;
    res.status(200).json(out);
  } catch (fatal) {
    console.error("ANALYZE FATAL:", fatal.message, fatal.stack);
    res.status(500).json({ ok: false, error: fatal.message, where: "analyze handler" });
  }
}
