import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { QualityStore } from "./store.js";
import {
  performPathReview,
  reviewResponseFromRow,
} from "./review-orchestrator.js";
import { PathSecurityError } from "./path-security.js";
import { HandoffValidationError } from "./handoff-validate.js";

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
  if (err instanceof PathSecurityError || err instanceof HandoffValidationError) {
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
          sendJson(res, 200, { ok: true, service: "quality-service" });
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

        sendJson(res, 404, { error: "not_found" });
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
}): ReturnType<typeof createServer> {
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const server = createQualityApp(opts.store);
  server.listen(port, () => {
    console.log(`quality-service listening on ${port}`);
  });
  return server;
}
