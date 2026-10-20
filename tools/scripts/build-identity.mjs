/**
 * Build identity: what exactly is this Runtime built from? A version string is not an answer (alpha.47 named
 * four different runtimes). The identity is a digest of the inputs that go into the bundle, so it is the same
 * for the same sources and changes when any input does, with no dependence on git history or the clock.
 *
 *   sourceDigest  sha256 over the runtime's non-test source, the vendored Core tarballs and the version
 *   coreBaseline  the praxis-core commit the vendored Core was packed from
 *
 * The bundle embeds both. At run time praxis_doctor adds the sha256 of the bundle file that is running, so an
 * operator can tell "the file I installed" from "the file that is loaded".
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const sha = (data) => createHash("sha256").update(data).digest("hex");

function walk(dir, accept, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, accept, out);
    else if (accept(path)) out.push(path);
  }
  return out;
}

/** Sources that end up in praxis-mcp.cjs: the MCP package (not its tests) and the vendored Core. */
export function buildInputs(root) {
  const mcp = walk(join(root, "packages/mcp/src"), (f) => f.endsWith(".ts") && !/\.test\.ts$/.test(f) && !f.endsWith("workflow-test-helpers.ts"));
  const vendor = walk(join(root, "vendor"), (f) => f.endsWith(".tgz") || f.endsWith("manifest.json"));
  return [...mcp, ...vendor, join(root, "package.json")].filter((f) => existsSync(f));
}

export function buildIdentity(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lines = buildInputs(root).map((file) => `${relative(root, file).split(sep).join("/")}\0${sha(readFileSync(file))}`);
  let coreBaseline = null;
  try {
    coreBaseline = JSON.parse(readFileSync(join(root, "vendor/manifest.json"), "utf8")).baseline ?? null;
  } catch {
    coreBaseline = null;
  }
  return { version: pkg.version, sourceDigest: sha(lines.join("\n")), coreBaseline, inputs: lines.length };
}
