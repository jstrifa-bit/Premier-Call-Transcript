export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  await new Promise(r => setTimeout(r, 500));
  const source = (req.body && req.body.source) || "default";
  let sample;
  switch (source) {
    case "googleworkspace":
      sample = "Specialist: Hi Sarah, thanks for hopping on. I want to walk through your bariatric case today.\nPatient: Sure. So you know I had a sleeve back in 2018 and I'm here because I'm thinking about a revision.\nSpecialist: Got it. Have you had an EGD recently?\nPatient: No, no one has ordered that yet.\nSpecialist: And nutrition - have you been seeing a registered dietitian?\nPatient: I saw a nutritionist once a few months ago.\n";
      break;
    case "five9":
      sample = "Specialist: Hi Bob, thanks for the time. We're talking through your right knee replacement.\nPatient: Yeah, the knee is killing me.\nSpecialist: Have you done a course of supervised physical therapy?\nPatient: Honestly no. I tried the gym a couple of times but never did real PT.\nSpecialist: And pain management - what are you taking?\nPatient: I've been on oxycodone every day for about eight months. My doctor has me on it.\nSpecialist: Got it.\n";
      break;
    default:
      sample = "Specialist: Hi Maria, how are you today?\nPatient: I am doing alright. I still smoke about half a pack a day - I tried to quit last year but it did not stick. My last A1c was 7.6.\nSpecialist: Thanks for sharing.\n";
  }
  res.status(200).json({ ok: true, source, transcript: sample, imported_at: new Date().toISOString() });
}
