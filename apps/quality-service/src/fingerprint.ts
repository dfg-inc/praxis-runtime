import type { Finding } from "./review-engine.js";

export type FingerprintGroup = {
  fingerprint: string;
  count: number;
  findingIds: string[];
  sampleDetail: string;
};

/** Group review findings by stable fingerprint (WBS 6.8). */
export function groupFindingsByFingerprint(
  findings: Finding[],
): FingerprintGroup[] {
  const map = new Map<string, FingerprintGroup>();
  for (const f of findings) {
    const fingerprint = `${f.id}:${f.ok ? "ok" : "fail"}:${f.severity}`;
    const cur = map.get(fingerprint);
    if (cur) {
      cur.count += 1;
      cur.findingIds.push(f.id);
    } else {
      map.set(fingerprint, {
        fingerprint,
        count: 1,
        findingIds: [f.id],
        sampleDetail: f.detail,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}
