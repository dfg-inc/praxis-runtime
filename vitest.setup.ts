import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PRAXIS_TEST_APPROVALS = "1";
process.env.PRAXIS_STATE_HOME ??= mkdtempSync(join(tmpdir(), "praxis-test-home-"));
