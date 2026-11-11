import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PRAXIS_TEST_APPROVALS = "1";
process.env.PRAXIS_STATE_HOME ??= mkdtempSync(join(tmpdir(), "praxis-test-home-"));
// Unit tests script the client's dialog and answer at once; the tests of the answer-time rule set it themselves.
process.env.PRAXIS_APPROVAL_MIN_ANSWER_MS ??= "0";
// No test opens a real browser tab: the approval-page tests switch the page on and receive its link through a test opener.
process.env.PRAXIS_APPROVAL_PAGE ??= "off";
// The approval tests run under whatever started them (an IDE, an agent session); the check of the client's command line
// sees a neutral client instead. trust-boundary.test.ts tests that check with its own command lines.
process.env.PRAXIS_TEST_ANCESTRY ??= JSON.stringify(["test-client"]);
