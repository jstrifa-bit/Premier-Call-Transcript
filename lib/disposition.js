// Mirrors sops.json status_priority. "Cleared" and "Pending - Callback Required"
// are internal-only (no SOP rule emits them; they are set by pipeline post-processing).
export const STATUS_PRIORITY = {
  "Pending - Callback Required": 0,
  "Ineligible": 1,
  "Deferred": 2,
  "High Complexity": 3,
  "Review": 4,
  "Revision Case": 5,
  "Hold": 6,
  "Action Required": 7,
  "Cleared": 99
};

export function getOverallDisposition(findings) {
  if (!findings || findings.length === 0) {
    return { status: "Cleared", reason: "No SOP triggers detected" };
  }
  const sorted = [...findings].sort(
    (a, b) => (STATUS_PRIORITY[a.status] ?? 99) - (STATUS_PRIORITY[b.status] ?? 99)
  );
  const top = sorted[0];
  return { status: top.status, reason: `Driven by ${top.sop_id}: ${top.finding}` };
}
