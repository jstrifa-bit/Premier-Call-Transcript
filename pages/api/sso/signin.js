export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  // Tiny artificial latency for the "real" feel.
  await new Promise(r => setTimeout(r, 600));
  res.status(200).json({
    ok: true,
    user: {
      id: "u-7421",
      name: "Jordan G",
      email: "jordan.g@carrum.health",
      role: "Care Specialist",
      team: "Bariatric & Joint Pod 2",
      avatar_initials: "JG",
      provider: "Carrum SSO (Okta)",
      signed_in_at: new Date().toISOString()
    }
  });
}
