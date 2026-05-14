// Deterministic next_step_actionability scoring. Replaces Gemini's
// judgment for this dimension. The analyzer prompt mandates a specific
// next_steps structure - we score against THAT structure rather than
// Gemini's prose impression of "specificity."
//
// Required structure per the analyze prompt:
//   1. One step prefixed with [SOP-ID] for EVERY finding (mandatory).
//   2. A disposition-specific tail step (e.g. "Notify patient of
//      ineligibility...") after all SOP-prefixed steps.
//   3. A documentation step at the END ("Document the call summary...").
//
// Score:
//   1.0 baseline
//   -0.3 for each finding without a corresponding [SOP-ID]-prefixed step
//   -0.2 if the final step isn't a documentation step
//   -0.1 if next_steps has fewer than 2 entries (no tail step)
//   Floor 0, ceiling 1.

const SOP_ID_PATTERN = /\[([A-Z]+-\d+)\]/;
const DOCUMENTATION_PATTERN = /\b(document|documentation|log|record)\b.*\b(ehr|call|summary|disposition|patient)/i;

export function scoreNextStepActionability({ findings, next_steps }) {
  const f = Array.isArray(findings) ? findings : [];
  const steps = Array.isArray(next_steps) ? next_steps : [];

  // No findings case: Pending or Cleared. next_steps is a follow-up
  // questionnaire built dynamically. Skip detailed structural checks;
  // just require non-empty steps.
  if (f.length === 0) {
    if (steps.length === 0) {
      return { score: 0, reason: "No findings and no next_steps. Deterministic check." };
    }
    return { score: 1, reason: "No findings; next_steps populated as follow-up questionnaire. Deterministic check." };
  }

  const violations = [];
  let score = 1.0;

  // (1) Every finding must have a corresponding [SOP-ID] step.
  const stepSopIds = new Set();
  for (const s of steps) {
    const m = String(s).match(SOP_ID_PATTERN);
    if (m) stepSopIds.add(m[1]);
  }
  const missing = [];
  for (const item of f) {
    if (item?.sop_id && !stepSopIds.has(item.sop_id)) {
      missing.push(item.sop_id);
    }
  }
  if (missing.length > 0) {
    score -= 0.3 * missing.length;
    violations.push(`Findings without a corresponding [SOP-ID] step: ${missing.join(", ")}.`);
  }

  // (2) Final step should be the documentation step.
  const lastStep = steps[steps.length - 1] || "";
  if (!DOCUMENTATION_PATTERN.test(lastStep)) {
    score -= 0.2;
    violations.push(`Final next_step is not a documentation step: "${String(lastStep).slice(0, 80)}".`);
  }

  // (3) Tail step expected after SOP-prefixed ones (so total >= findings + 2).
  if (steps.length < f.length + 2) {
    score -= 0.1;
    violations.push(`next_steps has ${steps.length} entries; expected at least ${f.length + 2} (one per finding + disposition tail + documentation).`);
  }

  score = Math.max(0, Math.min(1, score));
  const reason = violations.length === 0
    ? "Every finding has a corresponding [SOP-ID]-prefixed step, the disposition tail and documentation step are present in order. Deterministic check."
    : "Deterministic check found: " + violations.join(" | ");

  return { score, reason };
}
