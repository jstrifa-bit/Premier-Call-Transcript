import { invokeGeminiEvaluation } from "../../lib/evaluate-gemini.js";
import { scoreSopAccuracy } from "../../lib/score-sop-accuracy.js";
import { scoreExtractionCompleteness } from "../../lib/score-extraction-completeness.js";
import { scoreHumanReview } from "../../lib/score-human-review.js";
import { scoreNextStepActionability } from "../../lib/score-next-step-actionability.js";
import { readSops } from "../../lib/data.js";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  if (!process.env.GEMINI_API_KEY) {
    res.status(503).json({ ok: false, error: "Gemini key not configured" });
    return;
  }
  try {
    const body = req.body || {};
    const result = await invokeGeminiEvaluation(body);

    // Override Gemini's sop_accuracy with a deterministic score computed from
    // the priority table + required_flags + extraction. Gemini repeatedly
    // ignored its own prompt rules and scored below 1.0 with no penalty
    // ground named. The deterministic check encodes every valid penalty
    // ground from the prompt; if none triggers, the score is 1.0.
    const evaluation = { ...(result.evaluation || {}) };
    let sopAccuracyScore = evaluation.sop_accuracy?.score;
    try {
      const sops = (readSops().rules || []);
      const deterministic = scoreSopAccuracy({
        findings: body.findings,
        overall_disposition: body.overall_disposition,
        extraction: body.extraction,
        sops
      });
      evaluation.sop_accuracy = deterministic;
      sopAccuracyScore = deterministic.score;
    } catch (deterErr) {
      console.warn("Deterministic sop_accuracy override failed:", deterErr.message);
    }

    // Separate try so a throw here cannot leave us with mixed
    // deterministic-sop + Gemini-extraction values.
    try {
      const deterministicEc = scoreExtractionCompleteness({
        extraction: body.extraction,
        transcript: body.transcript,
        case_type: body.case_type || body.crm_record?.case_type
      });
      evaluation.extraction_completeness = deterministicEc;
    } catch (ecErr) {
      console.warn("Deterministic extraction_completeness override failed:", ecErr.message);
    }

    // Deterministic human_review_appropriateness — Gemini repeatedly
    // downgraded this dimension on review_reason prose quality even
    // when the boolean flag was correctly set. Judge the flag, not
    // the prose.
    try {
      const deterministicHr = scoreHumanReview({
        extraction: body.extraction,
        findings: body.findings
      });
      evaluation.human_review_appropriateness = deterministicHr;
    } catch (hrErr) {
      console.warn("Deterministic human_review override failed:", hrErr.message);
    }

    // Deterministic next_step_actionability — scores against the
    // structural contract from the analyze prompt ([SOP-ID] per finding,
    // disposition tail, documentation step at end) rather than Gemini's
    // prose impression of "specificity."
    try {
      const deterministicNs = scoreNextStepActionability({
        findings: body.findings,
        next_steps: body.next_steps
      });
      evaluation.next_step_actionability = deterministicNs;
    } catch (nsErr) {
      console.warn("Deterministic next_step_actionability override failed:", nsErr.message);
    }

    // Recompute overall_score and escalation using whatever values are now in evaluation.
    const sa = evaluation.sop_accuracy?.score;
    const ec = evaluation.extraction_completeness?.score;
    const ns = evaluation.next_step_actionability?.score;
    const hr = evaluation.human_review_appropriateness?.score;
    if ([sa, ec, ns, hr].every(v => typeof v === "number")) {
      const overall = 0.4 * sa + 0.3 * ec + 0.2 * ns + 0.1 * hr;
      evaluation.overall_score = Math.round(overall * 100) / 100;
      evaluation.score_label = overall >= 0.76 ? "High" : overall >= 0.51 ? "Medium" : "Low";
      const needsEsc = sa < 0.6 || ec < 0.5;
      if (needsEsc !== evaluation.needs_escalation) {
        evaluation.needs_escalation = needsEsc;
        if (!needsEsc) evaluation.escalation_reason = null;
      }
    }

    res.status(200).json({
      ok: true,
      evaluator: "gemini+deterministic",
      model: result.model,
      evaluation
    });
  } catch (e) {
    const msg = typeof e?.message === "string" ? e.message : String(e?.message ?? e ?? "unknown error");
    console.error("EVALUATE FATAL:", msg, e?.stack);
    res.status(500).json({ ok: false, error: msg });
  }
}
