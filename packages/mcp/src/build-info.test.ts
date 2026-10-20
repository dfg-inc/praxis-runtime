import { afterEach, describe, expect, it } from "vitest";
import { runtimeBuildInfo } from "./build-info.js";

describe("runtimeBuildInfo", () => {
  const saved = process.env.PRAXIS_BUILD_INFO;
  afterEach(() => {
    if (saved === undefined) delete process.env.PRAXIS_BUILD_INFO;
    else process.env.PRAXIS_BUILD_INFO = saved;
  });

  it("reports a source run as such, with no fabricated digest", () => {
    delete process.env.PRAXIS_BUILD_INFO;
    const info = runtimeBuildInfo("1.2.3");
    expect(info).toMatchObject({ version: "1.2.3", origin: "source", sourceDigest: null, bundleSha256: null });
  });

  it("reports the embedded source digest and Core baseline", () => {
    process.env.PRAXIS_BUILD_INFO = JSON.stringify({ sourceDigest: "abc", coreBaseline: "102d75b" });
    const info = runtimeBuildInfo("1.2.3");
    expect(info).toMatchObject({ origin: "bundle", sourceDigest: "abc", coreBaseline: "102d75b" });
    expect(info.bundleSha256).toBeNull(); // not running from a .cjs bundle file under test
  });

  it("ignores a malformed embedded value instead of crashing", () => {
    process.env.PRAXIS_BUILD_INFO = "{not json";
    expect(runtimeBuildInfo("1").origin).toBe("source");
  });
});
