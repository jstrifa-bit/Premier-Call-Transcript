import { invokeGeminiEvaluation } from "../../lib/evaluate-gemini.js";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  if (!process.env.GEMINI_API_KEY) {
    res.status(503).json({ ok: false, error: "Gemini key not configured" });
    return;
  }
  try {
    const result = await invokeGeminiEvaluation(req.body || {});
    res.status(200).json({
      ok: true,
      evaluator: "gemini",
      model: result.model,
      recommendation: result.recommendation,
      next_steps: result.next_steps
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
