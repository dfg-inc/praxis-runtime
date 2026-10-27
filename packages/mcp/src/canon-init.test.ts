import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ApprovalRequest, AskAnswer, UserApprovalChannel } from "@praxis/contracts";
import { applyCanonInit, configText, countersText, planCanonInit, visionText } from "./canon-init.js";
import { callTool } from "./tools.js";
import type { McpEnvelope } from "./workflow-test-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "fixtures", "canon-init", name), "utf8");
const call = async (tool: string, repo: string, args: Record<string, unknown>, channel?: UserApprovalChannel) => (await callTool(tool, { repo, ...args }, { role: "ba", version: "test", approvalChannel: channel })) as McpEnvelope;
const dialog = (answer: AskAnswer) => {
  const seen: ApprovalRequest[] = [];
  return { seen, channel: { kind: "client-elicitation", async ask(r: ApprovalRequest) { seen.push(r); return answer; } } as UserApprovalChannel };
};

describe("the Runtime creates the same canon root as `praxis-ba init`", () => {
  it("files are byte-identical to what the BA CLI wrote (golden fixtures made by the CLI)", () => {
    expect(configText()).toBe(fixture("config.yaml"));
    expect(countersText()).toBe(fixture("counters.yaml"));
    expect(visionText()).toBe(fixture("vision.md"));
    expect(visionText("Orders App")).toBe(fixture("vision-orders-app.md"));
  });

  it("preview lists the plan and writes nothing; apply needs the user's dialog and creates exactly that", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-canon-"));
    const preview = (await call("praxis_canon_init_preview", repo, { product: "Orders App" })).data as any;
    expect(preview.willCreate).toEqual([".ba/", ".ba/config.yaml", ".ba/counters.yaml", "vision.md", "epics/", "epics/.gitkeep", "br/", "br/.gitkeep", "cr/", "cr/.gitkeep", "wp/", "wp/.gitkeep", "bugs/", "bugs/.gitkeep", "baselines/", "baselines/.gitkeep"]);
    expect(existsSync(join(repo, ".ba"))).toBe(false);
    const noDialog = await call("praxis_canon_init_apply", repo, { confirmation: "YES" });
    expect(noDialog.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    expect(existsSync(join(repo, ".ba"))).toBe(false);
    const declined = dialog({ answer: "reject" });
    expect((await call("praxis_canon_init_apply", repo, { confirmation: "YES" }, declined.channel)).code).toBe("APPROVAL_REJECTED");
    expect((await call("praxis_canon_init_apply", repo, { confirmation: "NO" }, dialog({ answer: "approve" }).channel)).ok).toBe(false);
    expect(existsSync(join(repo, ".ba"))).toBe(false);
    const ok = dialog({ answer: "approve" });
    const applied = await call("praxis_canon_init_apply", repo, { confirmation: "YES", product: "Orders App" }, ok.channel);
    expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
    expect(ok.seen[0].description).toMatch(/- \.ba\/config\.yaml/);
    expect(readFileSync(join(repo, "vision.md"), "utf8")).toBe(fixture("vision-orders-app.md"));
    expect(readFileSync(join(repo, ".ba", "counters.yaml"), "utf8")).toBe(fixture("counters.yaml"));
    // idempotent: nothing left to create and no dialog is shown
    const again = dialog({ answer: "approve" });
    const second = await call("praxis_canon_init_apply", repo, { confirmation: "YES" }, again.channel);
    expect((second.data as any).created).toEqual([]);
    expect(again.seen.length).toBe(0);
  });

  it("never overwrites: an edited vision and an existing config are left as they are", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-canon2-"));
    mkdirSync(join(repo, ".ba"));
    writeFileSync(join(repo, "vision.md"), "my own vision\n");
    writeFileSync(join(repo, ".ba", "config.yaml"), "canon_roots:\n  - product/\n");
    const res = await call("praxis_canon_init_apply", repo, { confirmation: "YES" }, dialog({ answer: "approve" }).channel);
    expect(res.ok).toBe(true);
    expect(readFileSync(join(repo, "vision.md"), "utf8")).toBe("my own vision\n");
    expect(readFileSync(join(repo, ".ba", "config.yaml"), "utf8")).toBe("canon_roots:\n  - product/\n");
    expect(existsSync(join(repo, ".ba", "counters.yaml"))).toBe(true);
  });

  it("refuses symbolic links and paths of the wrong kind before writing anything", () => {
    const outside = mkdtempSync(join(tmpdir(), "praxis-canon-out-"));
    const a = mkdtempSync(join(tmpdir(), "praxis-canon3-"));
    symlinkSync(outside, join(a, ".ba"));
    expect(() => planCanonInit(a)).toThrow(/symbolic link/);
    const b = mkdtempSync(join(tmpdir(), "praxis-canon4-"));
    writeFileSync(join(b, "epics"), "a file where a folder belongs");
    expect(() => planCanonInit(b)).toThrow(/expected a directory/);
    expect(existsSync(join(b, ".ba"))).toBe(false);
    expect(() => planCanonInit(join(b, "nope"))).toThrow(/does not exist/);
  });

  it("the result is a canon the BA CLI accepts (when the BA repository is next to this one)", () => {
    const cli = join(here, "../../../../praxis-ba/plugins/ba/canon-graph/bin/praxis-ba.mjs");
    // the BA repository is a sibling checkout only in the split workspace; elsewhere this check has nothing to run against
    const present = existsSync(cli);
    const repo = mkdtempSync(join(tmpdir(), "praxis-canon5-"));
    const plan = planCanonInit(repo);
    for (const item of plan.create) {
      if (item.kind === "dir") mkdirSync(join(plan.repo, item.path));
      else writeFileSync(join(plan.repo, item.path), item.content ?? "");
    }
    if (present) {
      const status = spawnSync(process.execPath, [cli, "status", "--repo", repo], { encoding: "utf8" });
      expect(status.stdout + status.stderr).not.toMatch(/no canon here/);
      const id = spawnSync(process.execPath, [cli, "id", "next", "--scope", "cr", "--repo", repo], { encoding: "utf8" });
      expect(id.status, id.stdout + id.stderr).toBe(0);
    }
    expect(plan.create.length).toBeGreaterThan(0);
  });
});

describe("existing user files are validated, product is bounded, writes are all-or-nothing", () => {
  const fresh = () => mkdtempSync(join(tmpdir(), "praxis-canon-v-"));
  it("an existing valid config/counters is kept byte for byte", () => {
    const repo = fresh();
    mkdirSync(join(repo, ".ba"));
    writeFileSync(join(repo, ".ba", "config.yaml"), "canon_roots:\n  - vision.md\n  - custom/\n");
    const plan = planCanonInit(repo);
    expect(plan.skipped).toContain(".ba/config.yaml");
    applyCanonInit(plan);
    expect(readFileSync(join(repo, ".ba", "config.yaml"), "utf8")).toBe("canon_roots:\n  - vision.md\n  - custom/\n");
  });
  it("an invalid existing config or counters refuses the whole plan and nothing is written", () => {
    for (const [name, text] of [["config.yaml", "nothing: here\n"], ["config.yaml", "canon_roots: vision.md\n"], ["counters.yaml", "product:\n  epic: x\n"]] as const) {
      const repo = fresh();
      mkdirSync(join(repo, ".ba"));
      writeFileSync(join(repo, ".ba", name), text);
      expect(() => planCanonInit(repo)).toThrow(/not a valid canon file/);
      expect(readdirSync(repo)).toEqual([".ba"]);
      expect(readFileSync(join(repo, ".ba", name), "utf8")).toBe(text);
    }
  });
  it("a product name over the limit is refused", () => {
    expect(() => planCanonInit(fresh(), { product: "x".repeat(121) })).toThrow(/longer than 120/);
    expect(() => planCanonInit(fresh(), { product: "x".repeat(120) })).not.toThrow();
  });
  it("a failure while writing leaves the project as it was", () => {
    const repo = fresh();
    const plan = planCanonInit(repo);
    mkdirSync(join(repo, "wp")); // appears after planning: the later step fails
    const before = readdirSync(repo).sort();
    expect(() => applyCanonInit(plan)).toThrow();
    expect(readdirSync(repo).sort()).toEqual(before);
    chmodSync(repo, 0o755);
  });
});
