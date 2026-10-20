import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { toolsForRole, type PraxisRole } from "./catalog.js";

export type BuildInfo = {
  version: string;
  /** Digest of the inputs this bundle was built from; null when running from source. */
  sourceDigest: string | null;
  /** praxis-core commit the vendored Core was packed from. */
  coreBaseline: string | null;
  /** sha256 of the bundle file that is running; null when not running from a single bundle file. */
  bundleSha256: string | null;
  bundlePath: string | null;
  origin: "bundle" | "source";
  /** "production" for shipped bundles; anything else is a test variant that must never be installed. */
  kind: string;
};

/** Identity of the running Runtime. A version string is not proof of which build is loaded. */
export function runtimeBuildInfo(version: string): BuildInfo {
  let embedded: { sourceDigest?: string; coreBaseline?: string | null } | null = null;
  try {
    const raw = process.env.PRAXIS_BUILD_INFO;
    if (raw) embedded = JSON.parse(raw);
  } catch {
    embedded = null;
  }
  let bundlePath: string | null = null;
  let bundleSha256: string | null = null;
  const entry = process.argv[1];
  if (embedded && entry && /\.cjs$/.test(entry)) {
    try {
      bundleSha256 = createHash("sha256").update(readFileSync(entry)).digest("hex");
      bundlePath = entry;
    } catch {
      bundleSha256 = null;
    }
  }
  return {
    version,
    sourceDigest: embedded?.sourceDigest ?? null,
    coreBaseline: embedded?.coreBaseline ?? null,
    bundleSha256,
    bundlePath,
    origin: embedded ? "bundle" : "source",
    kind: process.env.PRAXIS_BUNDLE_KIND || "source",
  };
}

/**
 * Which tools this server offers, as a count and a digest of the sorted names. A host that shows a different count
 * or digest than the server reports is running from a stale tool registry (a session that started before the
 * extension was updated) or from another build: the fix is a new session or the right bundle, not a new version.
 */
export function toolOrigin(role: PraxisRole): { role: string; count: number; digest: string; names: string[] } {
  const names = toolsForRole(role).map((tool) => tool.name).sort();
  return { role, count: names.length, digest: createHash("sha256").update(names.join("\n")).digest("hex"), names };
}
