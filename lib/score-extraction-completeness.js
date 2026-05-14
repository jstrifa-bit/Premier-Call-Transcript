// Deterministic extraction_completeness scoring. Replaces Gemini's judgment
// for this dimension because Gemini repeatedly penalized null flags whose
// underlying topic was never discussed in the transcript (e.g. Bob's short
// PT+opioids call — Gemini docked points for "missing" dental and smoking
// flags even though the Care Specialist never asked).
//
// Rule: a null flag is only a penalty when the transcript contains keyword
// evidence that the topic WAS raised. Topics never discussed → null is the
// correct extraction → no penalty.
//
// Score: 1.0 baseline; -0.2 per unjustified null; floor 0, ceiling 1.

const FLAG_KEYWORDS = {
  // general
  dental_visit_within_6_months: /\b(dental|dentist|teeth|tooth)\b/i,
  pending_dental_work: /\b(dental|dentist|cavity|crown|filling|root canal|extraction)\b/i,
  // joint
  active_smoker: /\b(smoke|smoker|smoking|cigarette|cigarettes|tobacco|vape|vaping|nicotine)\b/i,
  quit_smoking_within_3_months: /\b(smoke|smoker|smoking|cigarette|cigarettes|tobacco|quit|quitting)\b/i,
  attempted_pt: /\b(physical therapy|PT|therapist|therapy sessions?|rehab|rehabilitation)\b/i,
  hba1c_value: /\b(a1c|hba1c|hemoglobin|blood sugar|glucose|diabetes|diabetic)\b/i,
  daily_opioid_use: /\b(opioid|opiate|oxycodone|hydrocodone|percocet|vicodin|norco|tramadol|morphine|fentanyl|pain (medication|med|killer|pill)s?)\b/i,
  opioid_duration_months: /\b(opioid|opiate|oxycodone|hydrocodone|percocet|vicodin|norco|tramadol|morphine|fentanyl|pain (medication|med|killer|pill)s?)\b/i,
  // bariatric
  prior_weight_loss_surgery: /\b(sleeve|bypass|lap[- ]?band|gastric band|banding|bariatric|wls|weight[- ]loss surgery|revision)\b/i,
  endoscopy_within_3_months: /\b(egd|endoscop\w*|upper gi|scope)\b/i,
  has_registered_dietician: /\b(dietician|dietitian|registered dietitian|RD|nutrition\w*)\b/i
};

const APPLICABLE_BY_CASE_TYPE = {
  joint: ["dental_visit_within_6_months", "pending_dental_work", "active_smoker", "quit_smoking_within_3_months", "attempted_pt", "hba1c_value", "daily_opioid_use", "opioid_duration_months"],
  bariatric: ["dental_visit_within_6_months", "pending_dental_work", "prior_weight_loss_surgery", "endoscopy_within_3_months", "has_registered_dietician"]
};

function flagValueFromExtraction(extraction, flagName) {
  const cf = extraction?.clinical_flags || {};
  for (const cat of ["general", "joint", "bariatric"]) {
    if (cf[cat] && Object.prototype.hasOwnProperty.call(cf[cat], flagName)) {
      const v = cf[cat][flagName]?.value;
      return v === undefined ? null : v;
    }
  }
  return null;
}

export function scoreExtractionCompleteness({ extraction, transcript, case_type }) {
  if (!extraction) {
    return { score: 0, reason: "No extraction object provided. Deterministic check." };
  }
  const transcriptText = transcript || "";
  const ct = (case_type || extraction?.patient?.case_type || "").toLowerCase();
  const applicable = APPLICABLE_BY_CASE_TYPE[ct] || Object.keys(FLAG_KEYWORDS);

  const unjustifiedNulls = [];
  for (const flagName of applicable) {
    const value = flagValueFromExtraction(extraction, flagName);
    if (value !== null) continue;
    const pattern = FLAG_KEYWORDS[flagName];
    if (!pattern) continue;
    if (pattern.test(transcriptText)) {
      unjustifiedNulls.push(flagName);
    }
  }

  let score = 1.0 - 0.2 * unjustifiedNulls.length;
  score = Math.max(0, Math.min(1, score));

  const reason = unjustifiedNulls.length === 0
    ? "Every applicable flag is either populated or its topic was never raised in the transcript. Deterministic check."
    : `Deterministic check found ${unjustifiedNulls.length} flag(s) null despite transcript evidence: ${unjustifiedNulls.join(", ")}.`;

  return { score, reason };
}
