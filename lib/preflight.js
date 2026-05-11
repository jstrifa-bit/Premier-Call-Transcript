function extractOutermostJson(text) {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.substring(first, last + 1);
  return text;
}

export async function invokePreflight(transcript) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const system = `You are a transcript validator. Read the provided text and return STRICT JSON only, no prose, no code fences:
{
  "is_clinical_transcript": true | false,
  "detected_language": "english" | "spanish" | "french" | "...",
  "reason": "one short sentence"
}

Rules:
- is_clinical_transcript is TRUE only if the text reads as a patient-care or intake conversation between a clinician/specialist and a patient discussing clinical topics (symptoms, medications, prior surgeries, procedures, surgical workup, history, lifestyle factors relevant to care). FALSE for billing notes, policy documents, marketing copy, contracts, code, random text, emails, AND for calls that consist only of small talk / scheduling logistics with no clinical content exchanged.
- detected_language is the primary language of the text as a lowercase noun ("english", "spanish", etc.). If multilingual, return the dominant language ("english" only if >60% English).
- reason is one short sentence explaining the verdict (e.g. "Clinical intake call about joint surgery", or "Document is a marketing brochure with no patient interaction").`;

  // Cap input to keep preflight cheap; clinical signal usually shows up in the first few hundred words.
  const sample = String(transcript || "").slice(0, 4000);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  let respJson;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        system,
        messages: [{ role: "user", content: sample }]
      }),
      signal: controller.signal
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Preflight API error: ${resp.status} ${resp.statusText}. Body: ${errBody}`);
    }
    respJson = await resp.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Preflight timed out after 15s");
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
  const text = respJson.content?.[0]?.text || "";
  const cleaned = extractOutermostJson(text).trim();
  const parsed = JSON.parse(cleaned);
  return {
    is_clinical_transcript: !!parsed.is_clinical_transcript,
    detected_language: String(parsed.detected_language || "").toLowerCase(),
    reason: parsed.reason || ""
  };
}
