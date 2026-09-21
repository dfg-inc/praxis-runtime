import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { QualityStore } from "./store.js";
import {
  persistWorkPackageReview,
  performPathReview,
  reviewResponseFromRow,
} from "./review-orchestrator.js";
import { reviewWorkPackage, WorkPackageReviewError } from "./wp-review.js";
import { PathSecurityError, allowedRootFromEnv, resolveAllowedPath } from "./path-security.js";
import { HandoffValidationError } from "./handoff-validate.js";
import {
  analyzeRepeatedFindings,
  createQualityReturn,
  GovernanceError,
  performCodebaseAudit,
  performMrReview,
  recordHotfixEvent,
  recordRollbackEvent,
  resolveQualityReturn,
} from "./quality-governance.js";

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(
          Object.assign(new Error("invalid JSON body"), {
            statusCode: 400,
            code: "invalid_json",
          }),
        );
      }
    });
    req.on("error", reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function errorPayload(err: unknown): {
  status: number;
  body: Record<string, unknown>;
} {
  if (err instanceof WorkPackageReviewError) {
    return {
      status: err.code === "QUALITY_CHANGE_SPEC_INVALID" || err.code === "QUALITY_MANIFEST_MISSING" ? 400 : 409,
      body: { error: err.code, message: err.message, details: err.details },
    };
  }
  if (
    err instanceof PathSecurityError ||
    err instanceof HandoffValidationError ||
    err instanceof GovernanceError
  ) {
    return {
      status: err.statusCode,
      body: {
        error: err.code,
        message: err.message,
        details: "details" in err ? (err as HandoffValidationError).details : undefined,
      },
    };
  }
  if (err && typeof err === "object" && "statusCode" in err) {
    const e = err as {
      statusCode?: number;
      code?: string;
      message?: string;
    };
    return {
      status: e.statusCode ?? 500,
      body: {
        error: e.code ?? "error",
        message: e.message ?? "request failed",
      },
    };
  }
  return {
    status: 500,
    body: {
      error: "internal_error",
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

export function createQualityApp(store: QualityStore) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");

        if (req.method === "GET" && url.pathname === "/health") {
          sendJson(res, 200, {
            ok: true,
            service: "quality-service",
            allowedRoot: process.env.PRAXIS_QUALITY_ALLOWED_ROOT ?? null,
            db: process.env.PRAXIS_QUALITY_DB ?? null,
            pid: process.pid,
            port: Number(process.env.PRAXIS_QUALITY_PORT ?? process.env.PORT ?? 8787),
            sqliteEngine: store.engineName,
          });
          return;
        }

        if (req.method === "GET" && url.pathname === "/metrics") {
          const project = url.searchParams.get("project") ?? undefined;
          sendJson(res, 200, store.metrics(project ?? undefined));
          return;
        }

        if (req.method === "GET" && url.pathname.startsWith("/reviews/")) {
          const idRaw = url.pathname.slice("/reviews/".length);
          if (!/^\d+$/.test(idRaw)) {
            sendJson(res, 400, {
              error: "invalid_review_id",
              message: "review id must be a positive integer",
            });
            return;
          }
          const row = store.getReview(Number(idRaw));
          if (!row) {
            sendJson(res, 404, {
              error: "not_found",
              message: `review ${idRaw} not found`,
            });
            return;
          }
          sendJson(res, 200, reviewResponseFromRow(row));
          return;
        }

        if (req.method === "GET" && url.pathname === "/reviews") {
          const project = url.searchParams.get("project") ?? url.searchParams.get("projectId") ?? undefined;
          const wp = url.searchParams.get("workPackageId") ?? undefined;
          const rows = store.listReviews(project);
          const mapped = rows
            .map((row) => reviewResponseFromRow(row))
            .filter((r) => (wp ? r["workPackageId"] === wp : true));
          sendJson(res, 200, { reviews: mapped, latest: mapped[mapped.length - 1] ?? null });
          return;
        }

        if (req.method === "POST" && url.pathname === "/reviews/work-package") {
          const body = (await readJsonBody(req)) as {
            projectId?: string;
            workPackageId?: string;
            path?: string;
            runtimeVersion?: string;
          };
          if (!body?.path || typeof body.path !== "string") {
            sendJson(res, 400, { error: "invalid_request", message: "path is required" });
            return;
          }
          if (!body.workPackageId || typeof body.workPackageId !== "string") {
            sendJson(res, 400, { error: "invalid_request", message: "workPackageId is required" });
            return;
          }
          const resolvedPath = resolveAllowedPath(body.path, allowedRootFromEnv());
          const reviewed = reviewWorkPackage({
            repo: resolvedPath,
            workPackageId: body.workPackageId,
            runtimeVersion: body.runtimeVersion,
          });
          const persisted = persistWorkPackageReview(store, {
            projectId: body.projectId ?? reviewed.workPackageId,
            path: resolvedPath,
            reviewed,
            runtimeVersion: body.runtimeVersion,
          });
          sendJson(res, 200, persisted);
          return;
        }

        if (req.method === "POST" && /^\/reviews\/\d+\/applied$/.test(url.pathname)) {
          const id = Number(url.pathname.split("/")[2]);
          const row = store.getReview(id);
          if (!row) {
            sendJson(res, 404, { error: "not_found", message: `review ${id} not found` });
            return;
          }
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          let notes: Record<string, unknown> = {};
          try {
            notes = JSON.parse(row.notes || "{}") as Record<string, unknown>;
          } catch {
            notes = {};
          }
          notes.applied = {
            at: new Date().toISOString(),
            ...(body ?? {}),
          };
          store.updateReviewNotes(id, JSON.stringify(notes));
          sendJson(res, 200, { ok: true, reviewId: id, applied: notes.applied });
          return;
        }

        if (req.method === "POST" && url.pathname === "/reviews/path") {
          const body = (await readJsonBody(req)) as {
            projectId?: string;
            path?: string;
            handoff?: unknown;
          };
          if (!body?.path || typeof body.path !== "string") {
            sendJson(res, 400, {
              error: "invalid_request",
              message: "path is required",
            });
            return;
          }
          if (!body.projectId || typeof body.projectId !== "string") {
            sendJson(res, 400, {
              error: "invalid_request",
              message: "projectId is required",
            });
            return;
          }
          if (body.handoff === undefined) {
            sendJson(res, 400, {
              error: "invalid_request",
              message: "handoff is required",
            });
            return;
          }

          const result = performPathReview(store, {
            path: body.path,
            projectId: body.projectId,
            handoff: body.handoff,
            requireValidHandoff: true,
            rerunTests: true,
          });

          // Successful transport even when code review verdict is fail
          sendJson(res, 200, {
            reviewId: result.reviewId,
            projectId: result.projectId,
            workPackageId: result.workPackageId,
            verdict: result.verdict,
            findings: result.findings,
            testExecution: result.testExecution,
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/reviews/mr") {
          const body = (await readJsonBody(req)) as {
            context?: unknown;
            handoff?: unknown;
            skipTests?: boolean;
          };
          if (!body?.context) {
            sendJson(res, 400, { error: "invalid_request", message: "context is required" });
            return;
          }
          const result = performMrReview(store, {
            context: body.context,
            handoff: body.handoff as never,
            rerunTests: body.skipTests === true ? false : true,
          });
          sendJson(res, 200, {
            reviewId: result.reviewId,
            projectId: result.projectId,
            workPackageId: result.workPackageId,
            verdict: result.verdict,
            findings: result.findings,
            mrRef: result.mrRef,
            testExecution: result.testExecution,
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/audits") {
          const body = (await readJsonBody(req)) as {
            path?: string;
            projectId?: string;
          };
          if (!body?.path) {
            sendJson(res, 400, { error: "invalid_request", message: "path is required" });
            return;
          }
          const result = performCodebaseAudit(store, {
            path: body.path,
            projectId: body.projectId ?? "default",
          });
          sendJson(res, 200, result);
          return;
        }

        if (req.method === "GET" && url.pathname.startsWith("/audits/")) {
          const idRaw = url.pathname.slice("/audits/".length);
          if (!/^\d+$/.test(idRaw)) {
            sendJson(res, 400, { error: "invalid_audit_id", message: "audit id must be a positive integer" });
            return;
          }
          const row = store.getAudit(Number(idRaw));
          if (!row) {
            sendJson(res, 404, { error: "not_found", message: `audit ${idRaw} not found` });
            return;
          }
          sendJson(res, 200, {
            audit: row,
            report: row.report_json ? JSON.parse(row.report_json) : null,
            reportMd: row.report_md,
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/rollbacks") {
          const body = (await readJsonBody(req)) as { event?: unknown; repo?: string };
          const row = recordRollbackEvent(store, body.event ?? body, { repo: body.repo });
          sendJson(res, 200, row);
          return;
        }

        if (req.method === "GET" && url.pathname === "/rollbacks") {
          const project = url.searchParams.get("project");
          if (!project) {
            sendJson(res, 400, { error: "invalid_request", message: "project is required" });
            return;
          }
          sendJson(res, 200, {
            rollbacks: store.listRollbacks(project),
            hotfixes: store.listHotfixes(project),
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/hotfixes") {
          const body = (await readJsonBody(req)) as { event?: unknown; repo?: string };
          if (!body.repo) {
            sendJson(res, 400, { error: "invalid_request", message: "repo is required" });
            return;
          }
          const row = recordHotfixEvent(store, body.event ?? body, { repo: body.repo });
          sendJson(res, 200, row);
          return;
        }

        if (req.method === "POST" && url.pathname === "/returns") {
          const body = (await readJsonBody(req)) as {
            reviewId?: number;
            source?: "qa" | "code-review";
            blockingFindingIds?: string[];
            reason?: string;
          };
          if (!body.reviewId || !body.source || !body.blockingFindingIds) {
            sendJson(res, 400, {
              error: "invalid_request",
              message: "reviewId, source, blockingFindingIds required",
            });
            return;
          }
          const row = createQualityReturn(store, {
            reviewId: body.reviewId,
            source: body.source,
            blockingFindingIds: body.blockingFindingIds,
            reason: body.reason ?? "blocking findings",
          });
          sendJson(res, 200, row);
          return;
        }

        if (req.method === "POST" && /^\/returns\/\d+\/resolve$/.test(url.pathname)) {
          const id = Number(url.pathname.split("/")[2]);
          const body = (await readJsonBody(req)) as { followUpReviewId?: number };
          if (!body.followUpReviewId) {
            sendJson(res, 400, { error: "invalid_request", message: "followUpReviewId required" });
            return;
          }
          sendJson(res, 200, resolveQualityReturn(store, {
            returnId: id,
            followUpReviewId: body.followUpReviewId,
          }));
          return;
        }

        if (req.method === "GET" && url.pathname === "/returns") {
          const project = url.searchParams.get("project");
          if (!project) {
            sendJson(res, 400, { error: "invalid_request", message: "project is required" });
            return;
          }
          sendJson(res, 200, store.listReturns(project));
          return;
        }

        if (req.method === "POST" && url.pathname === "/norms/analyze") {
          const body = (await readJsonBody(req)) as {
            projectId?: string;
            knowledgeStorePath?: string;
            threshold?: number;
          };
          if (!body.projectId || !body.knowledgeStorePath) {
            sendJson(res, 400, {
              error: "invalid_request",
              message: "projectId and knowledgeStorePath required",
            });
            return;
          }
          sendJson(res, 200, analyzeRepeatedFindings(store, {
            projectId: body.projectId,
            knowledgeStorePath: body.knowledgeStorePath,
            threshold: body.threshold,
          }));
          return;
        }

        if (req.method === "POST" && url.pathname === "/shutdown") {
          sendJson(res, 200, { ok: true });
          const srv = (req.socket as { server?: { close?: (cb?: () => void) => void } }).server;
          const halt = () => process.exit(0);
          if (srv?.close) srv.close(halt);
          else halt();
          return;
        }

        sendJson(res, 404, {
          error: "not_found",
          message: `${req.method} ${url.pathname}`,
        });
      } catch (err) {
        const { status, body } = errorPayload(err);
        sendJson(res, status, body);
      }
    })();
  });
}

export function startServer(opts: {
  store: QualityStore;
  port?: number;
  host?: string;
}): ReturnType<typeof createServer> {
  const port =
    opts.port ??
    Number(process.env.PRAXIS_QUALITY_PORT ?? process.env.PORT ?? 8787);
  const host = opts.host ?? process.env.PRAXIS_QUALITY_HOST ?? "127.0.0.1";
  const server = createQualityApp(opts.store);
  server.on("error", (err) => {
    console.error(`[praxis-quality] listen failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.error(`[praxis-quality] listening host=${host} port=${port} pid=${process.pid}`);
  });
  return server;
}
