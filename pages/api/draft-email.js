import { invokeDraftEmail } from "../../lib/draft-email.js";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({ ok: false, error: "ANTHROPIC_API_KEY not configured" });
    return;
  }
  try {
    const result = await invokeDraftEmail(req.body || {});
    res.status(200).json({ ok: true, subject: result.subject, body: result.body, model: result.model });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
