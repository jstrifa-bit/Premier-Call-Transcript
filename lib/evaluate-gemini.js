function extractOutermostJson(text) {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.substring(first, last + 1);
  return text;
}

export async function invokeGeminiEvaluation({ transcript, patient_summary, recommendation, next_steps, findings, overall_disposition }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  if (!apiKey) throw new Error("Gemini API key not configured");

  const stepsText = (next_steps && next_steps.length) ? next_steps.map(s => `- ${s}`).join("\n") : "(none)";
  const findingsText = (findings && findings.length)
    ? findings.map(f => `- ${f.sop_id} [${f.status}]: ${f.finding}`).join("\n")
    : "(none)";
  const dispText = overall_disposition ? `${overall_disposition.status} - ${overall_disposition.reason}` : "(unknown)";

  const systemInstruction = `You are a clinical QA evaluator scoring how well a Care Specialist's analysis matches the call transcript and SOP findings. Return STRICT JSON only, no prose, no code fences. Shape:
{
  "recommendation": { "score": 0-100, "rationale": "one sentence" },
  "next_steps":     { "score": 0-100, "rationale": "one sentence" }
}
Scoring guide:
- 76-100 = strongly grounded in transcript, cites correct SOPs, actionable, complete.
- 51-75  = mostly correct but with a noticeable gap, generic phrasing, or one minor mismatch.
- 0-50   = unsupported by transcript, contradicts findings, or missing critical actions.
Be calibrated: a perfect output is rare; do not score above 90 unless the output explicitly cites SOP IDs and quotes patient evidence.`;

  const userText = `TRANSCRIPT:\n${transcript || ""}\n\nOVERALL DISPOSITION: ${dispText}\n\nFINDINGS:\n${findingsText}\n\nRECOMMENDATION TO EVALUATE:\n${recommendation || ""}\n\nNEXT STEPS TO EVALUATE:\n${stepsText}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
    })
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Gemini API error: ${resp.status} ${resp.statusText}. Body: ${errBody}`);
  }

  const respJson = await resp.json();
  const text = respJson.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const cleaned = extractOutermostJson(text).trim();
  const parsed = JSON.parse(cleaned);
  return { recommendation: parsed.recommendation, next_steps: parsed.next_steps, model };
}
