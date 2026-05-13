function extractOutermostJson(text) {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.substring(first, last + 1);
  return text;
}

export async function invokeDraftEmail({ patient_name, case_type, disposition, copied_messages, specialist_name }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const firstName = String(patient_name || "Patient").split(/\s+/)[0];
  const stepBullets = (copied_messages || [])
    .map(m => `- ${m.message}${m.sop_id ? " [" + m.sop_id + "]" : ""}`)
    .join("\n") || "(no step messages collected)";

  const system = `You draft patient-facing emails on behalf of Care Specialists at Premier Health. Output STRICT JSON only, no prose, no code fences. Shape:
{
  "subject": "string",
  "body": "string"
}

The body must:
- Greet the patient by first name on its own line ("Dear <FirstName>,").
- Thank them for the call in one sentence.
- Acknowledge the disposition in ONE short paragraph in plain language (Ineligible / Deferred / Hold / Action Required / High Complexity / Review / Revision Case). Do NOT use clinical jargon. This paragraph is general-purpose disposition framing and must NOT borrow content from the Next step messages list below — those messages are the bullets, not the intro.
- List EVERY entry from "Next step messages" as its OWN bullet line, one bullet per message, in the order provided. Never merge two messages into one bullet. Never paraphrase a message into the intro paragraph. Never drop a message because its content overlaps the disposition framing - keep it as a separate bullet. The only exception: if two messages reference the exact same SOP ID and have identical text, you may dedupe to one bullet.
- After the bullets, add at most one short sentence of warm guidance for patient communication (e.g. "Please don't hesitate to reach out with any questions").
- Close with a blank line then the Specialist's name on its own line, then "Care Specialist, Premier Health" on the next line.
- Sound warm and professional. No medical advice beyond what the next-step messages already state.

The subject must be a short, friendly subject line (no "Subject:" prefix).`;

  const user = `Patient first name: ${firstName}
Case type: ${case_type || "(unknown)"}
Disposition: ${disposition || "(unknown)"}
Specialist name: ${specialist_name || "Care Specialist"}

Next step messages the Specialist already copied (in the order copied):
${stepBullets}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

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
        max_tokens: 1000,
        system,
        messages: [{ role: "user", content: user }]
      }),
      signal: controller.signal
    });
    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Draft email API error: ${resp.status} ${resp.statusText}. Body: ${errBody}`);
    }
    respJson = await resp.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Draft email timed out after 30s");
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }

  const text = respJson.content?.[0]?.text || "";
  const cleaned = extractOutermostJson(text).trim();
  const parsed = JSON.parse(cleaned);
  return { subject: parsed.subject || "Following up on your call", body: parsed.body || "", model };
}
