import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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
  };
}
