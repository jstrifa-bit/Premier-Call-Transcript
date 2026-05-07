export default function handler(req, res) {
  const hasClaude = !!process.env.ANTHROPIC_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;
  res.status(200).json({
    ok: true,
    engine: hasClaude ? "claude" : "local",
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
    evaluator: hasGemini ? "gemini" : null,
    evaluator_model: hasGemini ? (process.env.GEMINI_MODEL || "gemini-2.5-flash-lite") : null
  });
}
