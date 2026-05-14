// Deterministic sop_accuracy scoring. Replaces Gemini's judgment for this
// dimension because Gemini repeatedly violated its own prompt's
// SCORE-MUST-MATCH-REASON rule (writing "correctly applied" in the reason
// and then scoring 0.7).
//
// We check the four penalty grounds named in the evaluator system prompt:
//   (a) a fired rule's case_status doesn't match sops.json
//   (b) disposition doesn't equal the case_status of the lowest-priority finding
//   (c) a rule fires on null required_flag values
//   (d) [skipped here — fuzzy "missing rule despite explicit evidence";
//        the analyzer's Patient Certainty Rule is the safeguard for this]
//
// Each violation costs a fixed amount; floor at 0, ceiling at 1.
// A clean output scores 1.0.

import { STATUS_PRIORITY } from "./disposition.js";

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

export function scoreSopAccuracy({ findings, overall_disposition, extraction, sops }) {
  const f = findings || [];
  const dispStatus = overall_disposition?.status || null;
  const sopsList = sops || [];
  const violations = [];
  let score = 1.0;

  // (a) Each finding's case_status must match the SOP definition.
  for (const item of f) {
    const sop = sopsList.find(s => s.id === item.sop_id);
    if (!sop) {
      violations.push(`Finding ${item.sop_id} has no matching SOP in sops.json.`);
      score -= 0.3;
      continue;
    }
    if (sop.case_status !== item.status) {
      violations.push(`Finding ${item.sop_id} has case_status "${item.status}" but sops.json defines "${sop.case_status}".`);
      score -= 0.3;
    }
  }

  // (b) Disposition must equal the lowest-priority-number finding's case_status.
  // Skip when there are zero findings (Pending / Cleared handled elsewhere).
  if (f.length > 0 && dispStatus) {
    const priorities = f.map(item => ({
      item,
      pri: STATUS_PRIORITY[item.status] ?? 99
    }));
    priorities.sort((a, b) => a.pri - b.pri);
    const expectedStatus = priorities[0].item.status;
    if (expectedStatus !== dispStatus) {
      violations.push(`Disposition "${dispStatus}" does not match lowest-priority finding status "${expectedStatus}" (priority ${priorities[0].pri}).`);
      score -= 0.3;
    }
  }

  // (c) No fired rule may have null required_flag values.
  if (extraction) {
    for (const item of f) {
      const sop = sopsList.find(s => s.id === item.sop_id);
      if (!sop) continue;
      const nulls = (sop.required_flags || []).filter(rf => flagValueFromExtraction(extraction, rf) === null);
      if (nulls.length > 0) {
        violations.push(`Finding ${item.sop_id} fired but required_flags [${nulls.join(", ")}] are null in the extraction.`);
        score -= 0.4;
      }
    }
  }

  score = Math.max(0, Math.min(1, score));
  const reason = violations.length === 0
    ? "All fired rules carry correct case_status, the overall disposition equals the case_status of the lowest-priority-number finding, and no rule fired on null required_flag values. Deterministic check."
    : "Deterministic check found: " + violations.join(" | ");
  return { score, reason };
}
