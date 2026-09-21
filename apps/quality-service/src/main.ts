#!/usr/bin/env node
import { QualityStore, startServer } from "./index.js";

async function main(): Promise<void> {
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
