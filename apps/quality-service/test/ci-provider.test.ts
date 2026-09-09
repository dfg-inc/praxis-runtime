import { describe, expect, it } from "vitest";
import {
  buildCiContextRequest,
  qualityServiceUnavailableStep,
} from "@praxis/contracts";

describe("CI/MR provider preview (WBS 6.2 readiness)", () => {
  it("builds GitHub status URL without writing", () => {
    const p = buildCiContextRequest({
      provider: "github",
      baseUrl: "https://api.github.com",
      projectPath: "org/app",
      sha: "abc123",
    });
    expect(p.dryRun).toBe(true);
    expect(p.wouldWrite).toBe(false);
    expect(p.missingCredentials).toBe(true);
    expect(p.url).toContain("/commits/abc123/status");
  });

  it("does not mark the MR when Quality is down", () => {
    const step = qualityServiceUnavailableStep();
    expect(step.postedToMergeRequest).toBe(false);
    expect(step.status).toBe("failed");
  });
});
