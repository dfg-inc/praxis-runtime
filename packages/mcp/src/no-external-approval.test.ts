import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Runtime needs no broker, daemon, OS account or installer to approve anything: approval is the user's, in the MCP
 * client. This fails if the source or the shipped bundle depends on one again.
 */
const root = resolve(import.meta.dirname, "../../..");
const FORBIDDEN: Array<[RegExp, string]> = [
  [/PRAXIS_BROKER/, "the approval broker"],
  [/PRAXIS_SECURITY_MODE/, "the security mode switch"],
  [/PRAXIS_APPROVAL_(PUBLIC_KEY|PRIVATE_KEY|LEDGER|AUTHORIZATION|SERVICE_ENDPOINT)/, "signed authorizations or the approval service endpoint"],
  [/approval[-_ ]service/i, "the Approval Service"],
  [/_praxisapproval|LaunchDaemon|systemctl/, "an OS account or service"],
  [/webauthn/i, "WebAuthn"],
];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git" || name === "vendor") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|mjs|json)$/.test(name) && !/\.test\.(ts|mjs)$/.test(name) && !/package-lock\.json$/.test(name)) out.push(path);
  }
  return out;
}

describe("no mandatory external approval component in the Runtime", () => {
  const files = ["packages", "apps", "tools/scripts", "plugins"].flatMap((dir) => (existsSync(join(root, dir)) ? sources(join(root, dir)) : []));
  const bundle = join(root, "plugins/runtime/server/praxis-mcp.cjs");

  for (const [pattern, what] of FORBIDDEN) {
    it(`source and the shipped bundle do not depend on ${what}`, () => {
      const hits = files.filter((file) => pattern.test(readFileSync(file, "utf8"))).map((file) => relative(root, file));
      expect(hits).toEqual([]);
      if (existsSync(bundle)) expect(pattern.test(readFileSync(bundle, "utf8")), `${what} in the bundle`).toBe(false);
    });
  }

  it("the tool list has no approval-granting tool", () => {
    const catalog = readFileSync(join(root, "packages/mcp/src/catalog.ts"), "utf8");
    expect(catalog).not.toMatch(/praxis_approval_confirm|praxis_approval_grant|praxis_plan_approve/);
  });
});
