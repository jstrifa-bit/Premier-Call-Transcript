// Deterministic human_review_appropriateness scoring. Replaces Gemini's
// judgment for this dimension because Gemini repeatedly downgraded the
// score on review_reason prose quality even when the flag itself was set
// correctly (Sarah's case: "flag correctly set to true" + 0.5 because
// the prose "lacks specific details").
//
// Rule: judge the BOOLEAN flag, not the prose. Prose quality is not a
// routing risk; flag direction is.
//
// Score:
//   1.0 - flag set correctly (true when review is needed, false when not)
//         AND if true, review_reason is non-empty
//   0.5 - flag set correctly but review_reason is missing/empty when true
//   0.0 - flag is wrong direction (should be true but is false, or vice versa)
//
// "Review is needed" is defined the same way the analyze post-process
// defines it: null_flag_count >= 3 OR no findings produced. Anything
// more permissive lets the extractor wave the flag off on incomplete data.

const NULL_FLAG_THRESHOLD = 3;

export function scoreHumanReview({ extraction, findings }) {
  const meta = extraction?.extraction_metadata || {};
  const flagValue = meta.requires_human_review;
  const reviewReason = (meta.review_reason || "").trim();
  const nullCount = typeof meta.null_flag_count === "number" ? meta.null_flag_count : 0;
  const findingCount = Array.isArray(findings) ? findings.length : 0;

  // No extraction object - cannot evaluate this dimension. Treat as full
  // marks (the absent-extraction case is handled by the analyze pipeline
  // refusing to run, not by docking points here).
  if (!extraction) {
    return { score: 1, reason: "No extraction object provided; dimension not applicable. Deterministic check." };
  }

  const reviewNeeded = nullCount >= NULL_FLAG_THRESHOLD || findingCount === 0;

  // Wrong direction: should be true but is false, or vice versa.
  if (reviewNeeded && flagValue !== true) {
    return {
      score: 0,
      reason: `requires_human_review is ${flagValue === false ? "false" : "missing"} but null_flag_count=${nullCount} and findings=${findingCount} indicate review is needed. Deterministic check.`
    };
  }
  if (!reviewNeeded && flagValue === true) {
    return {
      score: 0,
      reason: `requires_human_review is true but null_flag_count=${nullCount} and findings=${findingCount} indicate the case has sufficient data to route. Deterministic check.`
    };
  }

  // Flag direction is correct. If true, check review_reason presence.
  if (flagValue === true && !reviewReason) {
    return {
      score: 0.5,
      reason: "requires_human_review is correctly true but review_reason is empty. Deterministic check."
    };
  }

  return {
    score: 1,
    reason: flagValue === true
      ? "requires_human_review is correctly true and review_reason is present. Deterministic check."
      : "requires_human_review is correctly false (sufficient data to route). Deterministic check."
  };
}
