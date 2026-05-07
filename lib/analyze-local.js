import { readSops } from "./data.js";
import { STATUS_PRIORITY, getOverallDisposition } from "./disposition.js";

const hasMatch = (text, patterns) => patterns.some(p => new RegExp(p, "i").test(text));

const findA1c = (text) => {
  const m = /(?:hba1c|a1c)[^\d%]{0,12}(\d+(?:\.\d+)?)\s*%?/i.exec(text);
  return m ? parseFloat(m[1]) : null;
};

function evaluateRule(sop, transcript, lc, crm) {
  let hit = false;
  let detail = "";
  switch (sop.id) {
    case "GEN-001": {
      const dentalRaised = hasMatch(lc, ["dental", "\\bteeth\\b", "\\bcavity\\b", "\\babscess\\b", "\\bgum\\b", "pending dental"]);
      if (dentalRaised) {
        const recentClearance = hasMatch(lc, ["dental clearance", "dental exam (last|this|recent)", "cleared by (the )?dentist", "dentist (last|this) (week|month)", "saw the dentist (last|this) (week|month)"]);
        const pendingWork = hasMatch(lc, ["pending dental", "need(s|ed)? dental", "dental work (still |is )?(pending|outstanding)"]);
        if (!recentClearance || pendingWork) {
          hit = true; detail = "Dental concern raised; clearance not documented within 6 months";
        }
      }
      break;
    }
    case "JNT-001": {
      const smokes = hasMatch(lc, ["\\bsmok(e|ing|er)\\b", "cigarette", "\\bvape\\b|vaping", "nicotine", "tobacco", "pack a day", "half a pack"]);
      const quitRecent = hasMatch(lc, ["quit (last|this) (week|month)", "quit (\\d+) (weeks?|months?) ago", "stopped smoking (\\d+) (weeks?|months?) ago", "just quit", "recently quit"]);
      const quitClean = hasMatch(lc, ["quit (\\d+ )?years? ago", "haven'?t smoked in (\\d+ )?years", "stopped smoking (\\d+ )?years ago"]);
      if ((smokes && !quitClean) || quitRecent) { hit = true; detail = "Active smoker or recent quit (<3 months)"; }
      break;
    }
    case "JNT-002": {
      const ptRaised = hasMatch(lc, ["physical therapy", "\\bpt\\b", "conservative therapy", "exercise program"]);
      if (ptRaised) {
        const completedPt = hasMatch(lc, ["completed (a |the )?(course of )?(supervised )?pt", "pt for (\\d+) weeks", "six weeks of pt", "finished physical therapy", "completed physical therapy", "did (a course of )?pt"]);
        const noAttempt = hasMatch(lc, ["never did (real )?pt", "didn'?t do (real )?pt", "no pt", "honestly no", "haven'?t done pt", "tried (the )?gym", "gym (sessions?|a couple)", "couple of times"]);
        if (!completedPt && noAttempt) { hit = true; detail = "No documented attempt at supervised PT"; }
      }
      break;
    }
    case "JNT-003": {
      const a1c = findA1c(transcript);
      if (a1c && a1c > 7.0) { hit = true; detail = `HbA1c ${a1c} exceeds 7.0 threshold`; }
      break;
    }
    case "JNT-004": {
      const opioidMention = hasMatch(lc, ["opioid", "oxycodone", "hydrocodone", "tramadol", "morphine", "percocet", "vicodin", "norco"]);
      const daily = hasMatch(lc, ["every day", "daily", "chronic", "long.?term"]);
      const duration = hasMatch(lc, ["for (\\d+ )?(months|years)", "(\\d+) months", "(\\d+) years"]);
      if (opioidMention && daily && duration) { hit = true; detail = "Daily opioid use exceeding 3 months indicated"; }
      break;
    }
    case "BAR-001": {
      if (hasMatch(lc, ["gastric bypass", "sleeve gastrectomy", "\\bsleeve\\b", "lap.?band", "prior bariatric", "previous bariatric", "had (a |the )?(bypass|sleeve)", "prior weight.?loss surgery"])) {
        hit = true; detail = "Prior weight-loss surgery mentioned";
      }
      break;
    }
    case "BAR-002": {
      const egdRaised = hasMatch(lc, ["\\begd\\b", "upper endoscopy", "esophagogastroduoden", "endoscopy"]);
      if (egdRaised) {
        const negation = hasMatch(lc, ["no one (has )?ordered", "haven'?t had", "hasn'?t had", "not yet", "not ordered", "no one's ordered", "none yet", "no endoscopy"]);
        const recent = hasMatch(lc, ["egd (last|this) (week|month)", "endoscopy (last|this) (week|month)", "completed (an |the )?egd", "had (an |the )?egd (\\d+ )?(weeks?|months?) ago"]);
        if (negation && !recent) { hit = true; detail = "No EGD within last 3 months"; }
      }
      break;
    }
    case "BAR-003": {
      const rdRaised = hasMatch(lc, ["registered dietitian", "registered dietician", "\\brd\\b", "dietitian", "dietician", "nutrition"]);
      if (rdRaised) {
        const hasRd = hasMatch(lc, ["my (registered )?dietitian", "my (registered )?dietician", "working with (a |an |my )?(registered )?dietitian", "working with (a |an |my )?(registered )?dietician", "saw (my |an )?(registered )?dietitian (last|this) (week|month)"]);
        const nutritionistOnly = hasMatch(lc, ["nutritionist (once|one time)", "saw a nutritionist", "met with (a |the )?nutritionist", "that'?s it"]);
        const missing = hasMatch(lc, ["haven'?t (seen|met)", "never (seen|met) (a |an |the )?(rd|dietitian|dietician)", "no dietitian", "no dietician"]);
        if (!hasRd && (nutritionistOnly || missing)) { hit = true; detail = "No registered dietitian identified"; }
      }
      break;
    }
  }
  return { hit, detail };
}

export function invokeLocalAnalysis(transcript, crmRecord) {
  const sops = readSops().rules || [];
  const lc = (transcript || "").toLowerCase();
  const caseTypeLower = (crmRecord?.case_type || "").toLowerCase();
  const findings = [];

  for (const sop of sops) {
    const applies = (sop.applies_to || []).some(at => at.toLowerCase() === caseTypeLower);
    if (!applies) continue;
    const { hit, detail } = evaluateRule(sop, transcript, lc, crmRecord);
    if (hit) {
      findings.push({
        sop_id: sop.id,
        title: sop.finding,
        category: sop.category,
        finding: detail || sop.finding,
        status: sop.case_status,
        action: sop.action,
        evidence: detail
      });
    }
  }

  const disposition = getOverallDisposition(findings);
  const patient_summary = buildLocalSummary(crmRecord, findings, transcript);
  const recommendation = buildLocalRecommendation(findings, disposition);
  const next_steps = buildLocalNextSteps(findings, disposition);

  return {
    engine: "local",
    model: "heuristic-v1",
    patient_summary,
    recommendation,
    findings,
    overall_disposition: disposition,
    next_steps
  };
}

function buildLocalSummary(crm, findings, transcript) {
  const out = [];
  if (crm) {
    out.push(`${crm.name} is a ${crm.age}-year-old ${crm.sex} from ${crm.location} presenting for a ${crm.case_type} case (BMI ${crm.bmi}; primary diagnosis: ${crm.primary_dx}).`);
  } else {
    out.push("Patient identifiers were not found in the CRM, so this summary is based on the transcript alone.");
  }
  if (findings.length > 0) {
    const topics = findings.map(f => f.evidence || f.finding);
    out.push("Key clinical points raised: " + topics.join("; ") + ".");
  } else {
    out.push("No SOP triggers were detected in the discussion.");
  }
  const a1c = findA1c(transcript);
  if (a1c) out.push(`Most recent HbA1c referenced: ${a1c}.`);
  if (findings.length >= 2) {
    out.push("Multiple workup gaps were identified during the call - see the SOP findings below for the full list.");
  } else {
    out.push("Disposition is driven by the findings detailed below.");
  }
  return out.join(" ");
}

function buildLocalRecommendation(findings, disposition) {
  if (!findings || findings.length === 0) {
    return "No SOP triggers were detected. Recommend proceeding to surgical consultation scheduling per the standard pathway.";
  }
  const sorted = [...findings].sort((a, b) => (STATUS_PRIORITY[a.status] ?? 99) - (STATUS_PRIORITY[b.status] ?? 99));
  const top = sorted[0];
  const ids = sorted.map(f => f.sop_id).join(", ");
  const line1 = `Recommended disposition: ${disposition.status}. This is driven by ${top.sop_id} (${top.title}) - ${(top.finding || "").toLowerCase()}.`;
  const line2 = findings.length > 1
    ? `Additional SOPs in play: ${ids}. Each requires the action listed in its finding card before this case can advance.`
    : `Address the action listed in the ${top.sop_id} finding card to move the case forward.`;
  const tails = {
    "Ineligible": "Notify the patient of ineligibility and close the case in CRM.",
    "Deferred": "Schedule a 90-day follow-up and provide cessation/support resources.",
    "Hold": "Place the case on hold pending requirement completion and set a 30-day check-in.",
    "Action Required": "Request the outstanding records and re-evaluate when received.",
    "High Complexity": "Escalate to medical director review before scheduling.",
    "Review": "Route to a clinical reviewer for medical risk assessment.",
    "Revision Case": "Move the case to the Revision pathway and notify the scheduling team."
  };
  return `${line1} ${line2} ${tails[disposition.status] || "Document the call and proceed per the SOP guidance below."}`;
}

function buildLocalNextSteps(findings, disposition) {
  const steps = [];
  const sorted = [...findings].sort((a, b) => (STATUS_PRIORITY[a.status] ?? 99) - (STATUS_PRIORITY[b.status] ?? 99));
  for (const f of sorted) steps.push(`[${f.sop_id}] ${f.action}`);
  const tails = {
    "Ineligible": "Notify patient of ineligibility and close case in CRM.",
    "Deferred": "Schedule 90-day follow-up and send cessation/support resources.",
    "Hold": "Place case on hold pending requirement completion; set 30-day check-in.",
    "Action Required": "Request outstanding records and re-evaluate when received.",
    "High Complexity": "Escalate case to medical director review.",
    "Review": "Route to clinical reviewer.",
    "Revision Case": "Move case to Revision pathway and notify scheduling team.",
    "Cleared": "Proceed to surgical consultation scheduling."
  };
  if (tails[disposition.status]) steps.push(tails[disposition.status]);
  steps.push("Document the call summary and disposition in the patient's CRM record.");
  return steps;
}
