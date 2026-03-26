import { describe, expect, it } from "bun:test";

describe("test infrastructure", () => {
  it("runs in test environment", () => {
    expect(process.env.NODE_ENV).toBe("test");
  });
});
