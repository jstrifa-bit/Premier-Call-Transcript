import { invokePreflight } from "../../lib/preflight.js";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  if (!process.env.ANTHROPIC_API_KEY) {
    // Without Claude, we can't run the preflight; allow analysis to proceed
    // (the frontend treats a 503 as "skip preflight").
    res.status(503).json({ ok: false, error: "ANTHROPIC_API_KEY not configured" });
    return;
  }
  const { transcript } = req.body || {};
  if (!transcript) { res.status(400).json({ ok: false, error: "transcript required" }); return; }

  try {
    const result = await invokePreflight(transcript);
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
