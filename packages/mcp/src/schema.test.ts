import { describe, expect, it } from "vitest";
import { TOOLS } from "./catalog.js";
import { jsonSchemaToZod } from "./schema.js";

describe("jsonSchemaToZod", () => {
  it("accepts numeric review ids and string arrays instead of rejecting them as strings", () => {
    const show = TOOLS.find((tool) => tool.name === "praxis_quality_review_show");
    const publish = TOOLS.find((tool) => tool.name === "praxis_developer_git_preview");
    expect(show).toBeTruthy();
    expect(publish).toBeTruthy();
    const showParsed = jsonSchemaToZod(show!.inputSchema).parse({
      workPackage: "WP-1",
      reviewId: 12,
    });
    expect(showParsed.reviewId).toBe(12);
    const filesParsed = jsonSchemaToZod(publish!.inputSchema).parse({
      workPackage: "WP-1",
      files: ["src/import.ts", "src/import.test.ts"],
    });
    expect(filesParsed.files).toEqual(["src/import.ts", "src/import.test.ts"]);
    expect(() =>
      jsonSchemaToZod(show!.inputSchema).parse({ workPackage: "WP-1", reviewId: "12" }),
    ).toThrow();
  });
});
