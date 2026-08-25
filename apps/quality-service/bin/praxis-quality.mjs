#!/usr/bin/env node
import { join } from "node:path";
import { QualityStore, runCli } from "../dist/index.js";

const dbPath =
  process.env.PRAXIS_QUALITY_DB ??
  join(process.cwd(), ".praxis-quality", "quality.sqlite");

const store = new QualityStore(dbPath);
try {
  const result = runCli(process.argv, store);
  console.log(JSON.stringify(result.output, null, 2));
  process.exit(result.ok ? 0 : 1);
} finally {
  store.close();
}
