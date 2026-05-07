import { invokeLocalAnalysis } from "../../lib/analyze-local.js";
import { invokeClaudeAnalysis } from "../../lib/analyze-claude.js";
import { invokeExtraction } from "../../lib/extract.js";
import { findCrmByQuery, findCrmFromTranscript } from "../../lib/data.js";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  const started = Date.now();
  const { transcript, patient_name, patient_id } = req.body || {};
  if (!transcript) { res.status(400).json({ ok: false, error: "transcript required" }); return; }

  let crm = findCrmByQuery({ name: patient_name, patient_id });
  if (!crm) crm = findCrmFromTranscript(transcript);

  // Run analysis and extraction in parallel when Claude is available.
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
    extraction: extractionRaw.__error ? null : extractionRaw,
    elapsed_ms: Date.now() - started
  };
  if (claude_error) out.claude_error = claude_error;
  if (extractionRaw.__error) out.extraction_error = extractionRaw.__error;
  res.status(200).json(out);
}
