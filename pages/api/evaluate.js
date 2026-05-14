import { invokeGeminiEvaluation } from "../../lib/evaluate-gemini.js";
import { scoreSopAccuracy } from "../../lib/score-sop-accuracy.js";
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
    try {
      const sops = (readSops().rules || []);
      const deterministic = scoreSopAccuracy({
        findings: body.findings,
        overall_disposition: body.overall_disposition,
        extraction: body.extraction,
        sops
      });
      evaluation.sop_accuracy = deterministic;

      // Recompute overall_score with the corrected sop_accuracy
      // (40% / 30% / 20% / 10% weights per the system prompt).
      const ec = evaluation.extraction_completeness?.score;
      const ns = evaluation.next_step_actionability?.score;
      const hr = evaluation.human_review_appropriateness?.score;
      if (typeof ec === "number" && typeof ns === "number" && typeof hr === "number") {
        const overall = 0.4 * deterministic.score + 0.3 * ec + 0.2 * ns + 0.1 * hr;
        evaluation.overall_score = Math.round(overall * 100) / 100;
        evaluation.score_label = overall >= 0.76 ? "High" : overall >= 0.51 ? "Medium" : "Low";
      }
      // Re-evaluate escalation: original rule was sop_accuracy < 0.6 OR
      // extraction_completeness < 0.5. Update needs_escalation if our
      // deterministic sop_accuracy disagrees with Gemini's prior call.
      const needsEsc = deterministic.score < 0.6 || (typeof ec === "number" && ec < 0.5);
      if (needsEsc !== evaluation.needs_escalation) {
        evaluation.needs_escalation = needsEsc;
        if (!needsEsc) evaluation.escalation_reason = null;
      }
    } catch (deterErr) {
      console.warn("Deterministic sop_accuracy override failed:", deterErr.message);
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
