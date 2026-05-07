import { readSops, writeSops } from "../../../lib/data.js";

export default function handler(req, res) {
  if (req.method === "GET") {
    res.status(200).json(readSops());
    return;
  }
  if (req.method === "POST") {
    const body = req.body || {};
    if (!body.id) { res.status(400).json({ ok: false, error: "id required" }); return; }
    const doc = readSops();
    if ((doc.rules || []).some(r => r.id === body.id)) {
      res.status(409).json({ ok: false, error: "id already exists" }); return;
    }
    doc.rules = [...(doc.rules || []), body];
    try {
      writeSops(doc);
      res.status(200).json({ ok: true, sop: body });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
    return;
  }
  res.status(405).end();
}
