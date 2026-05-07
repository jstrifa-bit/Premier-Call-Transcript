export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  await new Promise(r => setTimeout(r, 700));
  const { target, kind } = req.body || {};
  const ref = "EXP-" + Math.floor(100000 + Math.random() * 899999);
  res.status(200).json({ ok: true, target, kind, reference: ref, exported_at: new Date().toISOString() });
}
