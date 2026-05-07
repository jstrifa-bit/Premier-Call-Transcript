import { readSops, writeSops } from "../../../lib/data.js";

export default function handler(req, res) {
  const { id } = req.query;
  const doc = readSops();
  const existing = (doc.rules || []).find(r => r.id === id);

  if (req.method === "PUT") {
    if (!existing) { res.status(404).json({ ok: false, error: "not found" }); return; }
    const body = req.body || {};
    doc.rules = doc.rules.map(r => (r.id === id ? body : r));
    try {
      writeSops(doc);
      res.status(200).json({ ok: true, sop: body });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
    return;
  }
  if (req.method === "DELETE") {
    if (!existing) { res.status(404).json({ ok: false, error: "not found" }); return; }
    doc.rules = doc.rules.filter(r => r.id !== id);
    try {
      writeSops(doc);
      res.status(200).json({ ok: true, deleted: id });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
    return;
  }
  res.status(405).end();
}
