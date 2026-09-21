export const PRAXIS_ROLES = ["ba", "architect", "developer", "quality", "runtime"] as const;

export type PraxisRole = (typeof PRAXIS_ROLES)[number];

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
        workPackageId: {
          type: "string",
          description:
            "Explicit materialization scope: only this local WP may be CREATE/UPDATE/LINK. Not a hint. If omitted and multiple materializable WPs exist, preview returns WORK_PACKAGE_SCOPE_AMBIGUOUS.",
        },
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
        workPackageId: {
          type: "string",
          description:
            "Must match the previewed WP scope. Apply uses this exact fingerprinted plan; it does not rediscover sibling WPs.",
        },
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
    description:
      "READ-ONLY Developer WP status (local id, Jira key, current status, available transitions). Role: Developer.",
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
      "WRITE Developer completion: run required verification, persist evidence, emit Developer→Quality handoff, keep Jira In Progress. Requires confirmation=YES. Does not start Quality and does not mark the issue Done.",
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
    name: "praxis_developer_complete_recovery_preview",
    description:
      "READ-ONLY preview to reconcile premature Jira Done / missing Developer evidence or Quality handoff. Does not write Jira or files. Role: Developer.",
    inputSchema: {
      type: "object",
      properties: { workPackage: wpProp, repo: repoProp },
      required: ["workPackage"],
      additionalProperties: false,
    },
    roles: ["developer"],
    kind: "preview",
  },
  {
    name: "praxis_developer_complete_recovery_apply",
    description:
      "WRITE human-gated recovery after premature Jira Done. Requires confirmation=YES and previewFingerprint. Restores development status, then reconciles Developer completion evidence and Quality handoff. Does not start Quality.",
    inputSchema: {
      type: "object",
      properties: {
        workPackage: wpProp,
        repo: repoProp,
        confirmation: confirmProp,
        previewFingerprint: fingerprintProp,
      },
      required: ["workPackage", "confirmation", "previewFingerprint"],
      additionalProperties: false,
    },
    roles: ["developer"],
    kind: "apply",
  },
  {
    name: "praxis_quality_status",
    description:
      "READ-ONLY Quality runtime health (not_started / starting / healthy / failed / stopped / unknown / unavailable) and Work Package Quality lifecycle when workPackage is given. Does not start the service. Role: Quality.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp, workPackage: wpProp },
      additionalProperties: false,
    },
    roles: ["quality"],
    kind: "read",
  },
  {
    name: "praxis_quality_ensure",
    description:
      "Start or reuse the local Quality HTTP service bundled in Praxis Runtime. Does not run Quality Review, does not write Jira, does not mark Done. Role: Quality.",
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
      "READ/VERIFY Quality Review for a Work Package via the Quality HTTP Service. Executes acceptance checks, persists QA evidence and SQLite review. Does NOT mutate Jira. No confirmation required. Role: Quality.",
    inputSchema: {
      type: "object",
      properties: { workPackage: wpProp, repo: repoProp },
      required: ["workPackage"],
      additionalProperties: false,
    },
    roles: ["quality"],
    kind: "preview",
  },
  {
    name: "praxis_quality_report",
    description:
      "Safe alias of praxis_quality_review. Local Quality Review only — does not write Jira. Role: Quality.",
    inputSchema: {
      type: "object",
      properties: { workPackage: wpProp, repo: repoProp },
      required: ["workPackage"],
      additionalProperties: false,
    },
    roles: ["quality"],
    kind: "preview",
  },
  {
    name: "praxis_quality_apply_preview",
    description:
      "READ-ONLY preview of Jira writes for a persisted Quality Review. Resolves live transitions. Returns previewFingerprint. Does not write Jira. Role: Quality.",
    inputSchema: {
      type: "object",
      properties: {
        workPackage: wpProp,
        repo: repoProp,
        reviewId: { type: "number", description: "Optional persisted Quality review id" },
      },
      required: ["workPackage"],
      additionalProperties: false,
    },
    roles: ["quality"],
    kind: "preview",
  },
  {
    name: "praxis_quality_apply",
    description:
      "WRITE the previously previewed Quality Apply plan. Requires confirmation=YES and matching previewFingerprint. Jira Done / Bugs only from this approved plan. Role: Quality.",
    inputSchema: {
      type: "object",
      properties: {
        workPackage: wpProp,
        repo: repoProp,
        confirmation: confirmProp,
        previewFingerprint: fingerprintProp,
      },
      required: ["workPackage", "confirmation", "previewFingerprint"],
      additionalProperties: false,
    },
    roles: ["quality"],
    kind: "apply",
  },
  {
    name: "praxis_quality_apply_status",
    description:
      "READ-ONLY Quality Apply postconditions: Jira properties, managed comment lookup, local manifest, apply journal, and consistency. Does not write Jira. Role: Quality.",
    inputSchema: {
      type: "object",
      properties: { workPackage: wpProp, repo: repoProp },
      required: ["workPackage"],
      additionalProperties: false,
    },
    roles: ["quality"],
    kind: "read",
  },
  {
    name: "praxis_quality_review_show",
    description:
      "READ-ONLY Quality Review by id from Quality storage (HTTP GET /reviews/:id). Does not start Quality and does not write Jira. Role: Quality.",
    inputSchema: {
      type: "object",
      properties: {
        workPackage: wpProp,
        repo: repoProp,
        reviewId: { type: "number", description: "Quality Review id" },
      },
      required: ["workPackage", "reviewId"],
      additionalProperties: false,
    },
    roles: ["quality"],
    kind: "read",
  },
];

export function toolsForRole(role: PraxisRole): ToolDef[] {
  if (role === "runtime") return TOOLS;
  return TOOLS.filter((t) => t.roles.includes(role));
}

export function isPraxisRole(raw: unknown): raw is PraxisRole {
  return (
    raw === "ba" ||
    raw === "architect" ||
    raw === "developer" ||
    raw === "quality" ||
    raw === "runtime"
  );
}

export class PraxisMcpRoleError extends Error {
  readonly code = "PRAXIS_MCP_ROLE_INVALID";
  constructor(raw: string | undefined) {
    super(
      `PRAXIS_MCP_ROLE_INVALID: expected ba|architect|developer|quality|runtime, got ${JSON.stringify(raw ?? "")}`,
    );
    this.name = "PraxisMcpRoleError";
  }
}

export function parseRole(raw: string | undefined): PraxisRole {
  if (isPraxisRole(raw)) return raw;
  throw new PraxisMcpRoleError(raw);
}

export function parseRoleArgv(argv: string[]): PraxisRole {
  const i = argv.indexOf("--role");
  return parseRole(i >= 0 ? argv[i + 1] : undefined);
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
