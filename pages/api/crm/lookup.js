import { findCrmByQuery } from "../../../lib/data.js";

export default function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  const { name, patient_id } = req.body || {};
  const rec = findCrmByQuery({ name, patient_id });
  if (rec) res.status(200).json({ ok: true, crm_record: rec });
  else res.status(200).json({ ok: true, crm_record: null, note: "No record found in mock CRM. Demo only includes 3 sample patients." });
}
