/**
 * Acceptance-harness signer. NOT a broker.
 *
 * The Runtime refuses every protected write in secure mode unless it holds an authorization signed by a broker
 * key it trusts, inside its expiry, bound to this exact request, and not yet consumed. Acceptance scripts that
 * exercise product code directly (Git delivery, Quality apply, mock-Jira seeding) have to get past that gate.
 * They must not do it by switching to compatibility mode, so this helper plays the broker for the lifetime of
 * one script, with limits that keep it from being mistaken for the real thing:
 *
 *  - it must be started with { acknowledgeUnisolated: true } AND with PRAXIS_TEST_ALLOW_SAME_IDENTITY=1 already in
 *    the environment, set by the npm script that runs the scenario so the switch is visible in package.json
 *  - the key is generated in memory for this process and never written, exported or read from the environment
 *  - the ledger is a fresh temporary file outside the workspace
 *  - it refuses to start if compatibility mode is requested, a private key is in the environment, or an operator
 *    key path is configured (it removes those from this process rather than reading them)
 *  - tokens are single-purpose: one action, one repository, one work item, five minutes
 *
 * The Runtime still reports this host as unisolated (praxis_doctor), because broker and agent are one user here.
 * Independent isolation is BLOCKED until a broker runs under a separate identity; see praxis-core docs.
 * What this helper proves is the verification path: signature, expiry, scope and the replay ledger.
 */
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import {
  hasMutationLease,
  installHostApproval,
  decisionKindFor,
  encodeAuthorization,
  generateApprovalKeyPair,
  runAuthorizedMutation,
  signAuthorization,
} from "@praxis/contracts";

const OPERATOR_KEY_ENV = ["PRAXIS_APPROVAL_PUBLIC_KEY_PATH", "PRAXIS_BROKER_SHARED_DIR", "PRAXIS_APPROVAL_AUTHORIZATION"];

export function installTestBroker(options = {}) {
  if (options.acknowledgeUnisolated !== true) {
    throw new Error("test broker: pass { acknowledgeUnisolated: true }; this signer is not an independent broker");
  }
  if (process.env.PRAXIS_TEST_ALLOW_SAME_IDENTITY !== "1") {
    throw new Error("test broker: PRAXIS_TEST_ALLOW_SAME_IDENTITY=1 must be set by the caller (see the accept:* scripts in package.json)");
  }
  if (process.env.PRAXIS_SECURITY_MODE === "compatibility") {
    throw new Error("test broker: refusing to run next to PRAXIS_SECURITY_MODE=compatibility");
  }
  if (process.env.PRAXIS_APPROVAL_PRIVATE_KEY) {
    throw new Error("test broker: PRAXIS_APPROVAL_PRIVATE_KEY is set; refusing to touch a real signing key");
  }
  const saved = Object.fromEntries(
    ["PRAXIS_SECURITY_MODE", "PRAXIS_APPROVAL_PUBLIC_KEY", "PRAXIS_APPROVAL_LEDGER", "PRAXIS_TEST_ALLOW_SAME_IDENTITY", ...OPERATOR_KEY_ENV].map(
      (name) => [name, process.env[name]],
    ),
  );
  for (const name of OPERATOR_KEY_ENV) delete process.env[name];
  const keys = generateApprovalKeyPair();
  const dir = mkdtempSync(join(tmpdir(), "praxis-test-broker-"));
  // The "workspace" for fixture writes that have no repository of their own. Kept apart from the ledger.
  const scratch = mkdtempSync(join(tmpdir(), "praxis-test-scratch-"));
  process.env.PRAXIS_SECURITY_MODE = "secure";
  process.env.PRAXIS_APPROVAL_PUBLIC_KEY = keys.publicKeyPem;
  process.env.PRAXIS_APPROVAL_LEDGER = join(dir, "ledger.json");

  const sign = (request, extra = {}) => {
    const now = Date.now();
    const operation = request.operation;
    const body = {
      contract: "praxis.approval.authorization",
      version: 1,
      planFingerprint: request.planFingerprint,
      provider: request.provider,
      instanceId: request.instanceId,
      operations: [operation],
      workItemIds: [request.workItemId],
      repositories: [request.repository],
      action: request.action,
      approver: "acceptance-test-signer",
      issuedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 5 * 60_000).toISOString(),
      consumptionId: extra.consumptionId ?? `t-${randomUUID()}`,
      planId: request.planId,
      decisionKind: decisionKindFor(operation, request.action),
      ...extra.body,
    };
    return encodeAuthorization(signAuthorization(body, keys.privateKeyPem));
  };

  const broker = {
    /** Runs `write` under a freshly signed authorization for exactly this request. */
    authorized(spec, write) {
      const request = {
        repo: spec.repo,
        operation: spec.operation ?? "repository_edit",
        provider: spec.provider ?? "local",
        instanceId: spec.instanceId ?? "acceptance-fixture",
        workItemId: spec.workItemId ?? "acceptance",
        repository: spec.repository ?? spec.repo,
        action: spec.action,
        planId: spec.planId ?? `acceptance-${spec.action}`,
        planFingerprint:
          spec.planFingerprint ?? `sha256:${createHash("sha256").update(`${spec.action}:${spec.repo}:${randomUUID()}`).digest("hex")}`,
      };
      request.authorization = spec.authorization ?? sign(request, { consumptionId: spec.consumptionId });
      return runAuthorizedMutation(request, write);
    },
    /** Seeds an in-memory mock tracker. The mock is a fixture; the write still passes the secure gate. */
    seed(repo, write) {
      return broker.authorized(
        { repo, operation: "external_record_create", provider: "jira", instanceId: "mock-jira", action: "acceptance_fixture_seed" },
        write,
      );
    },
    /**
     * A tracker provider whose write methods run under a signed authorization when the caller holds no lease.
     * Inside broker.authorized() the lease already exists and calls pass straight through.
     */
    leasedProvider(provider, scratchRepo = scratch) {
      const writes = new Set(["createIssue", "updateIssue", "addComment", "transitionIssue", "setIssueProperty", "createIssueLink", "writePraxisState", "writeArchitectureMetadata"]);
      return new Proxy(provider, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof prop !== "string" || !writes.has(prop) || typeof value !== "function") return value;
          return (...args) =>
            hasMutationLease() ? value.apply(target, args) : broker.seed(scratchRepo, () => value.apply(target, args));
        },
      });
    },
    /**
     * Everything one protected MCP tool call needs in secure mode: the stored host approval for the exact plan
     * and a broker-signed authorization for the same request. Returns the extra tool arguments and runs the
     * call with the authorization in the environment, as a deployed broker would supply it, then removes it.
     */
    async approvedToolCall(spec, call) {
      const repository = resolve(spec.repo);
      const plan = installHostApproval(spec.repo, {
        planId: spec.planId ?? `acceptance-${spec.action}-${randomUUID().slice(0, 8)}`,
        role: spec.role ?? "quality",
        provider: spec.provider,
        ...(spec.instanceId ? { instanceId: spec.instanceId } : {}),
        workItemIds: [spec.workItemId],
        repositories: [repository],
        operations: [spec.operation],
        inScope: [spec.action],
        outOfScope: [],
        assumptions: [],
        risks: ["acceptance fixture"],
        previewFingerprint: spec.previewFingerprint,
      });
      const authorization = sign({
        operation: spec.operation,
        provider: spec.provider,
        instanceId: spec.instanceId ?? "local",
        workItemId: spec.workItemId,
        repository,
        action: spec.action,
        planId: plan.planId,
        planFingerprint: plan.fingerprint,
      });
      process.env.PRAXIS_APPROVAL_AUTHORIZATION = authorization;
      try {
        return await call({ planId: plan.planId, planFingerprint: plan.fingerprint, ...(spec.instanceId ? { instanceId: spec.instanceId } : {}) });
      } finally {
        delete process.env.PRAXIS_APPROVAL_AUTHORIZATION;
      }
    },
    /** A token for a request, for negative tests (tamper it, expire it, reuse it). */
    token(request, extra) {
      return sign(request, extra);
    },
    publicKeyPem: keys.publicKeyPem,
    close() {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(dir, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    },
  };
  return broker;
}
