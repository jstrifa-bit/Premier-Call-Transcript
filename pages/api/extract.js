import { invokeExtraction } from "../../lib/extract.js";
import { findCrmByQuery, findCrmFromTranscript } from "../../lib/data.js";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({ ok: false, error: "ANTHROPIC_API_KEY not configured" });
    return;
  }
  const { transcript, patient_name, patient_id } = req.body || {};
  if (!transcript) { res.status(400).json({ ok: false, error: "transcript required" }); return; }

  let crm = findCrmByQuery({ name: patient_name, patient_id });
  if (!crm) crm = findCrmFromTranscript(transcript);

  try {
    const extraction = await invokeExtraction(transcript, crm);
    res.status(200).json({ ok: true, extraction, crm_record: crm });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
