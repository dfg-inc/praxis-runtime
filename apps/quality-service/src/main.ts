#!/usr/bin/env node
import { QualityStore, startServer } from "./index.js";

function installProcessDiagnostics(): void {
  const log = (event: string, extra = "") => {
    process.stderr.write(
      `[praxis-quality] ${event} pid=${process.pid} ${extra}`.trimEnd() + "\n",
    );
  };
  log("startup");
  process.on("SIGTERM", () => {
    log("received signal SIGTERM");
    process.exit(0);
  });
  process.on("SIGINT", () => {
    log("received signal SIGINT");
    process.exit(0);
  });
  process.on("uncaughtException", (err) => {
    log("uncaught exception", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log("unhandled rejection", reason instanceof Error ? reason.message : String(reason));
  });
  process.on("disconnect", () => {
    log("parent disconnected");
  });
  process.on("exit", (code) => {
    log("shutdown", `exit code=${code}`);
  });
}

async function main(): Promise<void> {
  installProcessDiagnostics();
  const dbPath = process.env.PRAXIS_QUALITY_DB ?? ":memory:";
  process.stderr.write(
    `[praxis-quality] quality.db.init start path=${dbPath === ":memory:" ? ":memory:" : "file"}\n`,
  );
  const store = await QualityStore.create(dbPath);
  process.stderr.write(`[praxis-quality] quality.db.init engine=${store.engineName}\n`);
  startServer({ store });
}

main().catch((err) => {
  const code =
    err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : undefined;
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `[praxis-quality] quality.db.init failed code=${code ?? "QUALITY_DB_INIT_FAILED"} message=${message}\n`,
  );
  process.exit(1);
});
