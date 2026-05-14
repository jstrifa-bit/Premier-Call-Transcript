// Deterministic human_review_appropriateness scoring. Replaces Gemini's
// judgment for this dimension because Gemini repeatedly downgraded the
// score on review_reason prose quality even when the flag itself was set
// correctly (Sarah's case: "flag correctly set to true" + 0.5 because
// the prose "lacks specific details").
//
// Rule: judge the BOOLEAN flag, not the prose. Prose quality is not a
// routing risk; flag direction is.
//
// Score (one-sided - escalation is never wrong, suppression can be):
//   1.0 - flag is true with a non-empty review_reason (conservative escalation
//         is always acceptable, regardless of findings count or confidence)
//   1.0 - flag is false AND there is no signal that review is mandatory
//         (null_flag_count < threshold AND findings is non-empty)
//   0.5 - flag is true but review_reason is missing/empty
//   0.0 - flag is false BUT the case is missing data
//         (null_flag_count >= threshold OR findings.length === 0) -
//         this is the only real failure mode: silently passing incomplete data.

const NULL_FLAG_THRESHOLD = 3;

export function scoreHumanReview({ extraction, findings }) {
  const meta = extraction?.extraction_metadata || {};
  const flagValue = meta.requires_human_review;
  const reviewReason = (meta.review_reason || "").trim();
  const nullCount = typeof meta.null_flag_count === "number" ? meta.null_flag_count : 0;
  const findingCount = Array.isArray(findings) ? findings.length : 0;

  // No extraction object - dimension not applicable. Treat as full marks.
  if (!extraction) {
    return { score: 1, reason: "No extraction object provided; dimension not applicable. Deterministic check." };
  }

  const reviewMandatory = nullCount >= NULL_FLAG_THRESHOLD || findingCount === 0;

  // Escalation path: flag is true. Always acceptable, just check the reason text.
  if (flagValue === true) {
    if (!reviewReason) {
      return {
        score: 0.5,
        reason: "requires_human_review is true but review_reason is empty. Deterministic check."
      };
    }
    return {
      score: 1,
      reason: "requires_human_review is true with a non-empty review_reason (conservative escalation is always acceptable). Deterministic check."
    };
  }

  // Suppression path: flag is false (or missing). Only acceptable if data is complete.
  if (reviewMandatory) {
    return {
      score: 0,
      reason: `requires_human_review is ${flagValue === false ? "false" : "missing"} but null_flag_count=${nullCount} and findings=${findingCount} indicate review is mandatory. Deterministic check.`
    };
  }
  return {
    score: 1,
    reason: "requires_human_review is false and the case has sufficient data to route without escalation. Deterministic check."
  };
}
