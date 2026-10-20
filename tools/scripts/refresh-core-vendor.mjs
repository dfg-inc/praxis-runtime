#!/usr/bin/env node
/**
 * Refresh the vendored Praxis Core packages from a local praxis-core checkout.
 *
 *   node tools/scripts/refresh-core-vendor.mjs --core ../praxis-core
 *
 * Packs Core with its own pack-core-vendor.mjs, copies the packages listed in
 * vendor/manifest.json, records the Core commit as `baseline`, rewrites the
 * lockfile integrity for those tarballs, reinstalls with `npm ci`, and
 * regenerates the Claude Code plugin bundle. Version is unchanged; nothing is
 * published. Refuses a Core checkout with uncommitted changes so the baseline
 * always names the code that was packed.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fail(msg) {
  console.error(`refresh-core-vendor: ${msg}`);
  process.exit(1);
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if ((r.status ?? 1) !== 0) fail(`${cmd} ${args.join(" ")}\n${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

const argv = process.argv.slice(2);
const coreArg = argv[argv.indexOf("--core") + 1];
if (!argv.includes("--core") || !coreArg) fail("usage: --core <path to praxis-core>");
const core = resolve(coreArg);
if (!existsSync(join(core, "tools/scripts/pack-core-vendor.mjs"))) fail(`not a praxis-core checkout: ${core}`);

const dirty = run("git", ["status", "--porcelain", "--untracked-files=no"], core);
if (dirty) fail(`praxis-core has uncommitted changes; commit them first:\n${dirty}`);
const baseline = run("git", ["rev-parse", "HEAD"], core);

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const coreVersion = JSON.parse(readFileSync(join(core, "package.json"), "utf8")).version;
if (coreVersion !== version) fail(`version mismatch: runtime ${version}, core ${coreVersion}`);

console.log(`refresh-core-vendor: building praxis-core ${baseline.slice(0, 7)}`);
run("npm", ["run", "build"], core);
const staged = mkdtempSync(join(tmpdir(), "praxis-core-vendor-"));
run(process.execPath, [join(core, "tools/scripts/pack-core-vendor.mjs"), staged], core);

const manifestPath = join(root, "vendor", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const changed = [];
for (const npmName of manifest.packages) {
  const file = `${npmName.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
  const from = join(staged, file);
  if (!existsSync(from)) fail(`pack did not produce ${file}`);
  const to = join(root, "vendor", file);
  const same = existsSync(to) && readFileSync(to).equals(readFileSync(from));
  if (!same) {
    copyFileSync(from, to);
    changed.push(file);
  }
}
rmSync(staged, { recursive: true, force: true });
manifest.baseline = baseline;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const lockPath = join(root, "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  if (!key.startsWith("node_modules/@praxis/") || !entry.resolved?.startsWith("file:vendor/")) continue;
  const tgz = join(root, entry.resolved.slice("file:".length));
  entry.integrity = `sha512-${createHash("sha512").update(readFileSync(tgz)).digest("base64")}`;
}
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

run("npm", ["ci"], root);
run("npm", ["run", "build"], root);
const { bundlePraxisMcp } = await import("./mcp-bundle.mjs");
await bundlePraxisMcp(join(root, "plugins/runtime/server/praxis-mcp.cjs"), version);

console.log(
  JSON.stringify({ baseline, version, changed, bundle: "plugins/runtime/server/praxis-mcp.cjs" }, null, 2),
);
