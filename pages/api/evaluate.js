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
      evaluation: result.evaluation
    });
  } catch (e) {
    // Coerce to string defensively - some thrown values (notably from
    // fetch/JSON-parse failures) can carry non-string messages, which would
    // otherwise render as "[object Object]" on the frontend.
    const msg = typeof e?.message === "string" ? e.message : String(e?.message ?? e ?? "unknown error");
    console.error("EVALUATE FATAL:", msg, e?.stack);
    res.status(500).json({ ok: false, error: msg });
  }
}
