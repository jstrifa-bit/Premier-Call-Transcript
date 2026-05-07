import { invokeLocalAnalysis } from "../../lib/analyze-local.js";
import { invokeClaudeAnalysis } from "../../lib/analyze-claude.js";
import { findCrmByQuery, findCrmFromTranscript } from "../../lib/data.js";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  const started = Date.now();
  const { transcript, patient_name, patient_id } = req.body || {};
  if (!transcript) { res.status(400).json({ ok: false, error: "transcript required" }); return; }

  let crm = findCrmByQuery({ name: patient_name, patient_id });
  if (!crm) crm = findCrmFromTranscript(transcript);

  let result;
  let claude_error = null;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      result = await invokeClaudeAnalysis(transcript, crm);
    } catch (e) {
      claude_error = e.message;
      result = invokeLocalAnalysis(transcript, crm);
    }
  } else {
    result = invokeLocalAnalysis(transcript, crm);
  }

  const out = {
    ok: true,
    engine: result.engine,
    model: result.model,
    crm_record: crm,
    patient_summary: result.patient_summary,
    recommendation: result.recommendation,
    findings: result.findings,
    overall_disposition: result.overall_disposition,
    next_steps: result.next_steps,
    elapsed_ms: Date.now() - started
  };
  if (claude_error) out.claude_error = claude_error;
  res.status(200).json(out);
}
