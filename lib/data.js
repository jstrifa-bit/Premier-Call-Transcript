import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const SOPS_PATH = path.join(ROOT, "sops.json");
const CRM_PATH = path.join(ROOT, "crm.json");

// Defensive: strip a leading UTF-8 BOM (U+FEFF) if present. Windows PowerShell
// 5.1's `Set-Content -Encoding utf8` writes UTF-8-with-BOM by default, which
// crashes JSON.parse on Vercel. Past incident: see commit history around the
// extracted_flags -> required_flags rename for the symptom.
function stripBom(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

export function readSops() {
  return JSON.parse(stripBom(fs.readFileSync(SOPS_PATH, "utf8")));
}

export function writeSops(doc) {
  if (process.env.VERCEL) {
    const err = new Error("SOP writes are disabled in this hosted environment.");
    err.code = "READONLY";
    throw err;
  }
  fs.writeFileSync(SOPS_PATH, JSON.stringify(doc, null, 2), "utf8");
}

export function readCrm() {
  return JSON.parse(stripBom(fs.readFileSync(CRM_PATH, "utf8")));
}

export function findCrmByQuery({ name, patient_id }) {
  const crm = readCrm();
  const idTrim = (patient_id || "").trim();
  const nameLower = (name || "").trim().toLowerCase();
  if (idTrim) {
    const byId = crm.records.find(r => r.patient_id.toLowerCase() === idTrim.toLowerCase());
    if (byId) return byId;
  }
  if (nameLower) {
    for (const r of crm.records) {
      for (const alias of r.name_aliases || []) {
        const a = alias.toLowerCase();
        if (a === nameLower || nameLower.includes(a)) return r;
      }
    }
  }
  return null;
}

export function findCrmFromTranscript(transcript) {
  if (!transcript) return null;
  const lc = transcript.toLowerCase();
  const crm = readCrm();
  for (const r of crm.records) {
    for (const alias of r.name_aliases || []) {
      if (lc.includes(alias.toLowerCase())) return r;
    }
  }
  return null;
}
