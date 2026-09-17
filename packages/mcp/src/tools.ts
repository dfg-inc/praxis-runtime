import {
  architectApplyOp,
  architectPreviewOp,
  architectStatusOp,
  baApplyOp,
  baPreviewOp,
  baStatusOp,
  developerClaimOp,
  developerCompleteOp,
  developerReleaseOp,
  developerStatusOp,
  doctorOp,
  jiraDiscoverOp,
  jiraEpicOp,
  jiraSmokeOp,
  jiraStatusOp,
  loadPraxisDotenv,
  PraxisOpError,
  projectInitApplyOp,
  projectInitPreviewOp,
  projectStatusOp,
  qualityEnsureOp,
  qualityReviewOp,
  qualityStatusOp,
  redact,
  workPackageListOp,
  workPackageShowOp,
  type OpContext,
} from "@praxis/cli/operations";
import { mcpEnvelope, type McpEnvelope } from "./envelope.js";

export type PraxisRole = "ba" | "architect" | "developer" | "quality";

export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
};

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  roles: PraxisRole[];
  kind: "read" | "preview" | "apply";
};

const repoProp = { type: "string", description: "Product repository path. Defaults to cwd." };
const epicProp = { type: "string", description: "Jira epic key, e.g. PRX-1" };
const wpProp = {
  type: "string",
  description: "Local WP id (WP-20260914-002) or Jira work-package key",
};
const confirmProp = {
  type: "string",
  enum: ["YES"],
  description: "Explicit human approval. Must be YES.",
};
const fingerprintProp = {
  type: "string",
  description: "sha256:... fingerprint returned by the matching preview tool",
};

export const TOOLS: ToolDef[] = [
  {
    name: "praxis_doctor",
    description:
      "READ-ONLY capability check: runtime, repository, .project presence, Jira config presence (never secret values), Quality health.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp },
      additionalProperties: false,
    },
    roles: ["ba", "architect", "developer", "quality"],
    kind: "read",
  },
  {
    name: "praxis_project_status",
    description: "READ-ONLY .project status for a repository.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp },
      additionalProperties: false,
    },
    roles: ["ba", "architect", "developer", "quality"],
    kind: "read",
  },
  {
    name: "praxis_project_init_preview",
    description: "PREVIEW inferred .project YAML. Does not write. No confirmation.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp },
      additionalProperties: false,
    },
    roles: ["ba", "architect", "developer", "quality"],
    kind: "preview",
  },
  {
    name: "praxis_project_init_apply",
    description:
      "WRITE .project from a previously shown inference. Requires confirmation=YES. Do not call in the same turn as preview without human approval.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp, confirmation: confirmProp },
      required: ["confirmation"],
      additionalProperties: false,
    },
    roles: ["ba", "architect", "developer", "quality"],
    kind: "apply",
  },
  {
    name: "praxis_jira_smoke",
    description: "READ-ONLY Jira connection check. Role: any. Does not write.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp },
      additionalProperties: false,
    },
    roles: ["ba", "architect", "developer", "quality"],
    kind: "read",
  },
  {
    name: "praxis_jira_discover",
    description: "READ-ONLY Jira issue-type discovery including numeric bugTypeId.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp },
      additionalProperties: false,
    },
    roles: ["ba", "architect", "developer", "quality"],
    kind: "read",
  },
  {
    name: "praxis_jira_epic",
    description: "READ-ONLY fetch of an epic and its children.",
    inputSchema: {
      type: "object",
      properties: { epic: epicProp, repo: repoProp },
      required: ["epic"],
      additionalProperties: false,
    },
    roles: ["ba", "architect", "developer", "quality"],
    kind: "read",
  },
  {
    name: "praxis_jira_status",
    description: "READ-ONLY hydrated epic status. Filters superseded issues (e.g. PRX-2).",
    inputSchema: {
      type: "object",
      properties: { epic: epicProp, repo: repoProp },
      required: ["epic"],
      additionalProperties: false,
    },
    roles: ["ba", "architect", "developer", "quality"],
    kind: "read",
  },
  {
    name: "praxis_ba_status",
    description: "READ-ONLY BA/Jira status for an epic. Role: BA.",
    inputSchema: {
      type: "object",
      properties: { epic: epicProp, repo: repoProp },
      required: ["epic"],
      additionalProperties: false,
    },
    roles: ["ba"],
    kind: "read",
  },
  {
    name: "praxis_ba_preview",
    description:
      "PREVIEW BA Jira write plan (CREATE/UPDATE/UNCHANGED/SUPERSEDED). No write. Returns previewFingerprint. Role: BA.",
    inputSchema: {
      type: "object",
      properties: { epic: epicProp, repo: repoProp },
      required: ["epic"],
      additionalProperties: false,
    },
    roles: ["ba"],
    kind: "preview",
  },
  {
    name: "praxis_ba_apply",
    description:
      "WRITE BA Jira materialization. Requires confirmation=YES and matching previewFingerprint. Role: BA. Do not auto-apply after preview.",
    inputSchema: {
      type: "object",
      properties: {
        epic: epicProp,
        repo: repoProp,
        confirmation: confirmProp,
        previewFingerprint: fingerprintProp,
      },
      required: ["epic", "confirmation", "previewFingerprint"],
      additionalProperties: false,
    },
    roles: ["ba"],
    kind: "apply",
  },
  {
    name: "praxis_architect_status",
    description: "READ-ONLY Architect/Jira status for an epic. Role: Architect.",
    inputSchema: {
      type: "object",
      properties: { epic: epicProp, repo: repoProp },
      required: ["epic"],
      additionalProperties: false,
    },
    roles: ["architect"],
    kind: "read",
  },
  {
    name: "praxis_architect_preview",
    description:
      "PREVIEW Architect Jira plan: CREATE one WP for canonical local WP (WP-20260914-002), UPDATE architecture, LINK, IGNORED superseded. No generic technical task. No placeholder diagrams. Returns previewFingerprint. Role: Architect.",
    inputSchema: {
      type: "object",
      properties: {
        epic: epicProp,
        repo: repoProp,
        workPackageId: { type: "string", description: "Optional local WP id hint" },
      },
      required: ["epic"],
      additionalProperties: false,
    },
    roles: ["architect"],
    kind: "preview",
  },
  {
    name: "praxis_architect_apply",
    description:
      "Materializes the previously previewed Architect plan into Jira. WRITE operation. Requires explicit human approval, confirmation=YES, and matching preview fingerprint. Role: Architect. Do not start Developer.",
    inputSchema: {
      type: "object",
      properties: {
        epic: epicProp,
        repo: repoProp,
        workPackageId: { type: "string" },
        confirmation: confirmProp,
        previewFingerprint: fingerprintProp,
      },
      required: ["epic", "confirmation", "previewFingerprint"],
      additionalProperties: false,
    },
    roles: ["architect"],
    kind: "apply",
  },
  {
    name: "praxis_work_package_list",
    description: "READ-ONLY list of local work packages.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp },
      additionalProperties: false,
    },
    roles: ["architect", "developer", "quality"],
    kind: "read",
  },
  {
    name: "praxis_work_package_show",
    description: "READ-ONLY local WP + resolved Jira key. Accepts WP-20260914-002 or Jira key.",
    inputSchema: {
      type: "object",
      properties: { workPackage: wpProp, repo: repoProp },
      required: ["workPackage"],
      additionalProperties: false,
    },
    roles: ["architect", "developer", "quality"],
    kind: "read",
  },
  {
    name: "praxis_work_package_status",
    description: "READ-ONLY alias of work-package show.",
    inputSchema: {
      type: "object",
      properties: { workPackage: wpProp, repo: repoProp },
      required: ["workPackage"],
      additionalProperties: false,
    },
    roles: ["architect", "developer", "quality"],
    kind: "read",
  },
  {
    name: "praxis_developer_status",
    description: "READ-ONLY Developer WP status (local id and Jira key). Role: Developer.",
    inputSchema: {
      type: "object",
      properties: { workPackage: wpProp, repo: repoProp },
      required: ["workPackage"],
      additionalProperties: false,
    },
    roles: ["developer"],
    kind: "read",
  },
  {
    name: "praxis_developer_claim",
    description:
      "WRITE claim of a work package. Requires confirmation=YES. Role: Developer. Idempotent for the same actor.",
    inputSchema: {
      type: "object",
      properties: {
        workPackage: wpProp,
        repo: repoProp,
        confirmation: confirmProp,
        actor: { type: "string" },
      },
      required: ["workPackage", "confirmation"],
      additionalProperties: false,
    },
    roles: ["developer"],
    kind: "apply",
  },
  {
    name: "praxis_developer_release",
    description: "WRITE force-release of a claim. Requires confirmation=YES. Role: Developer.",
    inputSchema: {
      type: "object",
      properties: {
        workPackage: wpProp,
        repo: repoProp,
        confirmation: confirmProp,
      },
      required: ["workPackage", "confirmation"],
      additionalProperties: false,
    },
    roles: ["developer"],
    kind: "apply",
  },
  {
    name: "praxis_developer_complete",
    description:
      "WRITE Developer completion evidence. Requires confirmation=YES. Role: Developer. Does not start Quality.",
    inputSchema: {
      type: "object",
      properties: {
        workPackage: wpProp,
        repo: repoProp,
        confirmation: confirmProp,
      },
      required: ["workPackage", "confirmation"],
      additionalProperties: false,
    },
    roles: ["developer"],
    kind: "apply",
  },
  {
    name: "praxis_quality_status",
    description: "READ-ONLY Quality runtime health. Role: Quality.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp },
      additionalProperties: false,
    },
    roles: ["quality"],
    kind: "read",
  },
  {
    name: "praxis_quality_ensure",
    description:
      "Ensure Quality service is reachable (may start local service). Role: Quality. Not a Jira write.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp },
      additionalProperties: false,
    },
    roles: ["quality"],
    kind: "preview",
  },
  {
    name: "praxis_quality_review",
    description:
      "WRITE QA verification result for a WP. Requires confirmation=YES. Role: Quality. Uses numeric bug type id, never display-name «Баг». Preview findings to the human first; do not auto-write.",
    inputSchema: {
      type: "object",
      properties: { workPackage: wpProp, repo: repoProp, confirmation: confirmProp },
      required: ["workPackage", "confirmation"],
      additionalProperties: false,
    },
    roles: ["quality"],
    kind: "apply",
  },
  {
    name: "praxis_quality_report",
    description: "WRITE alias of quality review. Requires confirmation=YES. Role: Quality.",
    inputSchema: {
      type: "object",
      properties: { workPackage: wpProp, repo: repoProp, confirmation: confirmProp },
      required: ["workPackage", "confirmation"],
      additionalProperties: false,
    },
    roles: ["quality"],
    kind: "apply",
  },
];

export function toolsForRole(role: PraxisRole): ToolDef[] {
  return TOOLS.filter((t) => t.roles.includes(role));
}

export function parseRole(raw: string | undefined): PraxisRole {
  if (raw === "ba" || raw === "architect" || raw === "developer" || raw === "quality") {
    return raw;
  }
  return "architect";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}

function ctxFromArgs(args: Record<string, unknown>, extra?: Partial<OpContext>): OpContext {
  return {
    repo: str(args.repo) ?? process.cwd(),
    epic: str(args.epic),
    wp: str(args.workPackage) ?? str(args.wp) ?? str(args.workPackageId),
    confirmation: str(args.confirmation),
    previewFingerprint: str(args.previewFingerprint),
    actor: str(args.actor),
    requirePreviewFingerprint: extra?.requirePreviewFingerprint,
    provider: extra?.provider,
  };
}

export async function callTool(
  name: string,
  rawArgs: unknown,
  opts: { role: PraxisRole; version: string; extra?: Partial<OpContext> },
): Promise<McpEnvelope> {
  const allowed = toolsForRole(opts.role);
  const def = allowed.find((t) => t.name === name);
  if (!def) {
    return mcpEnvelope({
      ok: false,
      operation: name,
      version: opts.version,
      code: "INVALID_INPUT",
      errors: [`tool not available for role ${opts.role}: ${name}`],
    });
  }
  const args = rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {};
  const ctx = ctxFromArgs(args, {
    ...opts.extra,
  });
  loadPraxisDotenv(ctx.repo);
  if (name === "praxis_ba_apply" || name === "praxis_architect_apply") {
    ctx.requirePreviewFingerprint = true;
  }
  if (
    name === "praxis_developer_claim" ||
    name === "praxis_quality_review" ||
    name === "praxis_quality_report"
  ) {
    if (ctx.confirmation !== "YES") {
      return mcpEnvelope({
        ok: false,
        operation: name,
        version: opts.version,
        code: "CONFIRMATION_REQUIRED",
        errors: [`${name} requires confirmation=YES`],
      });
    }
  }
  try {
    const data = await dispatchTool(name, ctx, opts.version);
    return mcpEnvelope({ ok: true, operation: name, version: opts.version, data });
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err));
    const code = err instanceof PraxisOpError ? err.code : "EXTERNAL_SERVICE_ERROR";
    return mcpEnvelope({
      ok: false,
      operation: name,
      version: opts.version,
      code,
      errors: [message],
    });
  }
}

async function dispatchTool(name: string, ctx: OpContext, version: string): Promise<unknown> {
  switch (name) {
    case "praxis_doctor":
      return doctorOp(ctx, version);
    case "praxis_project_status":
      return projectStatusOp(ctx);
    case "praxis_project_init_preview":
      return projectInitPreviewOp(ctx);
    case "praxis_project_init_apply":
      return projectInitApplyOp(ctx);
    case "praxis_jira_smoke":
      return jiraSmokeOp(ctx);
    case "praxis_jira_discover":
      return jiraDiscoverOp(ctx);
    case "praxis_jira_epic":
      return jiraEpicOp(ctx);
    case "praxis_jira_status":
      return jiraStatusOp(ctx);
    case "praxis_ba_status":
      return baStatusOp(ctx);
    case "praxis_ba_preview":
      return baPreviewOp(ctx);
    case "praxis_ba_apply":
      return baApplyOp(ctx);
    case "praxis_architect_status":
      return architectStatusOp(ctx);
    case "praxis_architect_preview":
      return architectPreviewOp(ctx);
    case "praxis_architect_apply":
      return architectApplyOp(ctx);
    case "praxis_work_package_list":
      return workPackageListOp(ctx);
    case "praxis_work_package_show":
    case "praxis_work_package_status":
      return workPackageShowOp(ctx);
    case "praxis_developer_status":
      return developerStatusOp(ctx);
    case "praxis_developer_claim":
      return developerClaimOp(ctx);
    case "praxis_developer_release":
      return developerReleaseOp(ctx);
    case "praxis_developer_complete":
      return developerCompleteOp(ctx);
    case "praxis_quality_status":
      return qualityStatusOp(ctx);
    case "praxis_quality_ensure":
      return qualityEnsureOp(ctx);
    case "praxis_quality_review":
    case "praxis_quality_report":
      return qualityReviewOp(ctx);
    default:
      throw new PraxisOpError("INVALID_INPUT", `unknown tool ${name}`);
  }
}

export function mcpConfig(role: PraxisRole): Record<string, unknown> {
  return {
    mcpServers: {
      praxis: {
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/runtime/praxis-mcp.cjs", "--role", role],
      },
    },
  };
}
