/**
 * Filesystem path allowlist for Quality local path reviews.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

export class PathSecurityError extends Error {
  readonly statusCode = 400;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PathSecurityError";
    this.code = code;
  }
}

/**
 * Resolve and canonicalize a requested review path.
 * When `allowedRoot` is set, the path must remain inside that root.
 */
export function resolveAllowedPath(
  requestedPath: string,
  allowedRoot: string | undefined,
): string {
  if (!requestedPath || typeof requestedPath !== "string") {
    throw new PathSecurityError("invalid_path", "path is required");
  }
  if (requestedPath.includes("\0")) {
    throw new PathSecurityError("invalid_path", "path contains NUL");
  }

  const abs = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(process.cwd(), requestedPath);

  // Reject obvious traversal segments before realpath (missing targets)
  const normalized = abs.split(sep).filter((p) => p !== ".");
  if (normalized.includes("..")) {
    // resolve() already collapsed ..; keep explicit check on raw input
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(requestedPath)) {
    // After resolve, check containment against root instead
  }

  if (!existsSync(abs)) {
    throw new PathSecurityError("path_missing", `path does not exist: ${abs}`);
  }

  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new PathSecurityError("path_unusable", `cannot resolve path: ${abs}`);
  }

  const st = statSync(real);
  if (!st.isDirectory()) {
    throw new PathSecurityError(
      "path_not_directory",
      `path must be a directory: ${real}`,
    );
  }

  if (allowedRoot && allowedRoot.trim()) {
    const rootAbs = isAbsolute(allowedRoot)
      ? resolve(allowedRoot)
      : resolve(process.cwd(), allowedRoot);
    if (!existsSync(rootAbs)) {
      throw new PathSecurityError(
        "allowed_root_missing",
        `PRAXIS_QUALITY_ALLOWED_ROOT does not exist: ${rootAbs}`,
      );
    }
    let rootReal: string;
    try {
      rootReal = realpathSync(rootAbs);
    } catch {
      throw new PathSecurityError(
        "allowed_root_unusable",
        `cannot resolve PRAXIS_QUALITY_ALLOWED_ROOT: ${rootAbs}`,
      );
    }
    const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
    if (real !== rootReal && !real.startsWith(prefix)) {
      throw new PathSecurityError(
        "path_outside_allowed_root",
        `path ${real} is outside PRAXIS_QUALITY_ALLOWED_ROOT ${rootReal}`,
      );
    }
  }

  return real;
}

export function allowedRootFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const v = env.PRAXIS_QUALITY_ALLOWED_ROOT?.trim();
  return v || undefined;
}
