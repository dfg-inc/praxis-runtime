import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeAuthorization, generateApprovalKeyPair, encodeAuthorization, signAuthorization } from "@praxis/contracts";

const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return "NO_ERROR";
};
import { installTestBroker } from "./test-broker.mjs";

const repo = () => mkdtempSync(join(tmpdir(), "praxis-tb-"));
let broker;
let savedMode;
let savedOverride;
// The workspace unit-test setup defaults to compatibility mode; the helper must be exercised in the real default.
beforeEach(() => {
  savedMode = process.env.PRAXIS_SECURITY_MODE;
  savedOverride = process.env.PRAXIS_TEST_ALLOW_SAME_IDENTITY;
  delete process.env.PRAXIS_SECURITY_MODE;
  process.env.PRAXIS_TEST_ALLOW_SAME_IDENTITY = "1"; // what the accept:* npm scripts provide
});
afterEach(() => {
  broker?.close();
  broker = undefined;
  if (savedMode === undefined) delete process.env.PRAXIS_SECURITY_MODE;
  else process.env.PRAXIS_SECURITY_MODE = savedMode;
  if (savedOverride === undefined) delete process.env.PRAXIS_TEST_ALLOW_SAME_IDENTITY;
  else process.env.PRAXIS_TEST_ALLOW_SAME_IDENTITY = savedOverride;
});

describe("acceptance test broker", () => {
  it("refuses to start without an explicit acknowledgement that it is not isolated", () => {
    expect(() => installTestBroker()).toThrow(/acknowledgeUnisolated/);
    expect(() => installTestBroker({ acknowledgeUnisolated: false })).toThrow(/acknowledgeUnisolated/);
  });

  it("refuses to start unless the caller set PRAXIS_TEST_ALLOW_SAME_IDENTITY=1", () => {
    delete process.env.PRAXIS_TEST_ALLOW_SAME_IDENTITY;
    expect(() => installTestBroker({ acknowledgeUnisolated: true })).toThrow(/PRAXIS_TEST_ALLOW_SAME_IDENTITY/);
    process.env.PRAXIS_TEST_ALLOW_SAME_IDENTITY = "0";
    expect(() => installTestBroker({ acknowledgeUnisolated: true })).toThrow(/PRAXIS_TEST_ALLOW_SAME_IDENTITY/);
  });

  it("uses an ephemeral key and a temporary ledger outside the workspace", () => {
    broker = installTestBroker({ acknowledgeUnisolated: true });
    expect(process.env.PRAXIS_APPROVAL_LEDGER).toMatch(/praxis-test-broker-/);
    expect(process.env.PRAXIS_APPROVAL_PUBLIC_KEY).toContain("BEGIN PUBLIC KEY");
    expect(process.env.PRAXIS_APPROVAL_PRIVATE_KEY).toBeUndefined();
  });

  it("refuses to run beside compatibility mode or a real private key", () => {
    process.env.PRAXIS_SECURITY_MODE = "compatibility";
    expect(() => installTestBroker({ acknowledgeUnisolated: true })).toThrow(/compatibility/);
    delete process.env.PRAXIS_SECURITY_MODE;
    process.env.PRAXIS_APPROVAL_PRIVATE_KEY = "x";
    try {
      expect(() => installTestBroker({ acknowledgeUnisolated: true })).toThrow(/PRIVATE_KEY/);
    } finally {
      delete process.env.PRAXIS_APPROVAL_PRIVATE_KEY;
    }
  });

  it("keeps secure mode on, never reads operator key paths, and restores the environment on close", () => {
    process.env.PRAXIS_APPROVAL_PUBLIC_KEY_PATH = "/operator/public.pem";
    broker = installTestBroker({ acknowledgeUnisolated: true });
    expect(process.env.PRAXIS_SECURITY_MODE).toBe("secure");
    expect(process.env.PRAXIS_APPROVAL_PUBLIC_KEY_PATH).toBeUndefined();
    expect(process.env.PRAXIS_APPROVAL_PRIVATE_KEY).toBeUndefined();
    broker.close();
    broker = undefined;
    expect(process.env.PRAXIS_APPROVAL_PUBLIC_KEY_PATH).toBe("/operator/public.pem");
    expect(process.env.PRAXIS_TEST_ALLOW_SAME_IDENTITY).toBe("1"); // the caller's own value is untouched
    delete process.env.PRAXIS_APPROVAL_PUBLIC_KEY_PATH;
  });

  it("lets a correctly signed write through and still refuses an unsigned one", async () => {
    broker = installTestBroker({ acknowledgeUnisolated: true });
    const dir = repo();
    const done = await broker.authorized({ repo: dir, action: "demo_write" }, async () => "wrote");
    expect(done).toBe("wrote");
    expect(codeOf(() => broker.authorized({ repo: dir, action: "demo_write", authorization: "" }, () => "no"))).toBe("APPROVAL_REQUIRED");
  });

  it("refuses an authorization signed by another key, a tampered one, and a replay for a different request", () => {
    broker = installTestBroker({ acknowledgeUnisolated: true });
    const dir = repo();
    const other = generateApprovalKeyPair();
    const request = {
      repo: dir, operation: "repository_edit", provider: "local", instanceId: "acceptance-fixture",
      workItemId: "acceptance", repository: dir, action: "demo_write", planId: "p1", planFingerprint: "sha256:" + "ab".repeat(32),
    };
    const forged = encodeAuthorization(signAuthorization(decodeAuthorization(broker.token(request)).body, other.privateKeyPem));
    expect(codeOf(() => broker.authorized({ ...request, authorization: forged }, () => "x"))).toMatch(/^APPROVAL_/);
    const good = broker.token(request, { consumptionId: "fixed-1" });
    expect(broker.authorized({ ...request, authorization: good, planId: "p1", planFingerprint: request.planFingerprint }, () => "first")).toBe("first");
    expect(codeOf(() => broker.authorized({ ...request, action: "other_write", authorization: good, planId: "p1", planFingerprint: request.planFingerprint }, () => "x"))).toMatch(/^APPROVAL_/);
  });

  it("signs every token with the machine channel, which a production build refuses", () => {
    broker = installTestBroker({ acknowledgeUnisolated: true });
    const token = broker.token({
      repo: "/r", operation: "repository_edit", provider: "local", instanceId: "local", workItemId: "w", repository: "/r", action: "a", planId: "p", planFingerprint: "sha256:" + "ab".repeat(32),
    });
    expect(decodeAuthorization(token).body.channel).toBe("machine");
    expect(decodeAuthorization(token).body.approver).toBe("acceptance-test-signer");
  });

  it("is imported by no product source and is absent from every shipped bundle in this repository", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const hits = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|mjs|cjs|js)$/.test(name) && /test-broker/.test(readFileSync(path, "utf8"))) hits.push(path.replace(root, ""));
      }
    };
    walk(join(root, "packages"));
    walk(join(root, "apps"));
    expect(hits).toEqual([]);
    const bundle = readFileSync(join(root, "plugins/runtime/server/praxis-mcp.cjs"), "utf8");
    expect(bundle).not.toMatch(/test-broker|acknowledgeUnisolated|acceptance-test-signer/);
  });
});
