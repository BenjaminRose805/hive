import { describe, expect, test } from "bun:test";
import { CORE_DOMAINS, NO_WORKTREE_ROLES, VALID_ROLES } from "./agent-types.ts";
import {
  AGENT_NAME_RE,
  parseAgentAssignment,
  RESERVED_NAMES,
  validateAgentNames,
  validateDomain,
  validateRole,
  validateSafeName,
} from "./validation.ts";

// ---------------------------------------------------------------------------
// validateSafeName
// ---------------------------------------------------------------------------

describe("validateSafeName", () => {
  test("accepts valid alphanumeric names", () => {
    expect(() => validateSafeName("alice")).not.toThrow();
    expect(() => validateSafeName("bob-2")).not.toThrow();
    expect(() => validateSafeName("Agent-007")).not.toThrow();
    expect(() => validateSafeName("a")).not.toThrow();
  });

  test("accepts names up to 32 chars", () => {
    expect(() => validateSafeName("a".repeat(32))).not.toThrow();
  });

  test("rejects names longer than 32 chars", () => {
    expect(() => validateSafeName("a".repeat(33))).toThrow(/Invalid name/);
  });

  test("rejects empty string", () => {
    expect(() => validateSafeName("")).toThrow(/Invalid name/);
  });

  test("rejects names with spaces", () => {
    expect(() => validateSafeName("has space")).toThrow(/Invalid name/);
  });

  test("rejects names with special characters", () => {
    expect(() => validateSafeName("name@bad")).toThrow(/Invalid name/);
    expect(() => validateSafeName("path/traversal")).toThrow(/Invalid name/);
    expect(() => validateSafeName("../escape")).toThrow(/Invalid name/);
    expect(() => validateSafeName("semi;colon")).toThrow(/Invalid name/);
    expect(() => validateSafeName("back`tick")).toThrow(/Invalid name/);
    expect(() => validateSafeName("dollar$sign")).toThrow(/Invalid name/);
  });

  test("rejects names with underscores (only hyphens allowed)", () => {
    expect(() => validateSafeName("has_underscore")).toThrow(/Invalid name/);
  });
});

// ---------------------------------------------------------------------------
// validateRole
// ---------------------------------------------------------------------------

describe("validateRole", () => {
  test("accepts all valid roles", () => {
    for (const role of VALID_ROLES) {
      expect(() => validateRole(role)).not.toThrow();
    }
  });

  test("includes product role", () => {
    expect(VALID_ROLES.has("product")).toBe(true);
    expect(() => validateRole("product")).not.toThrow();
    expect(NO_WORKTREE_ROLES.has("product")).toBe(true);
  });

  test("rejects invalid roles", () => {
    expect(() => validateRole("admin")).toThrow(/Invalid role/);
    expect(() => validateRole("superuser")).toThrow(/Invalid role/);
    expect(() => validateRole("")).toThrow(/Invalid role/);
  });

  test("role validation is case-sensitive", () => {
    expect(() => validateRole("Manager")).toThrow(/Invalid role/);
    expect(() => validateRole("ENGINEER")).toThrow(/Invalid role/);
  });
});

// ---------------------------------------------------------------------------
// validateDomain
// ---------------------------------------------------------------------------

describe("validateDomain", () => {
  test("accepts all core domains", () => {
    for (const domain of CORE_DOMAINS) {
      expect(() => validateDomain(domain)).not.toThrow();
    }
  });

  test("accepts custom alphanumeric domains", () => {
    expect(() => validateDomain("my-custom-domain")).not.toThrow();
  });

  test("rejects domains with special characters", () => {
    expect(() => validateDomain("bad/domain")).toThrow(/Invalid domain/);
    expect(() => validateDomain("")).toThrow(/Invalid domain/);
  });
});

// ---------------------------------------------------------------------------
// parseAgentAssignment
// ---------------------------------------------------------------------------

describe("parseAgentAssignment", () => {
  test("parses name:role pair", () => {
    const result = parseAgentAssignment("alice:engineer");
    expect(result).toEqual({ name: "alice", role: "engineer" });
  });

  test("parses name:role:domain triple", () => {
    const result = parseAgentAssignment("bob:qa:testing");
    expect(result).toEqual({ name: "bob", role: "qa", domain: "testing" });
  });

  test("trims whitespace around parts", () => {
    const result = parseAgentAssignment(" alice : engineer : backend ");
    expect(result).toEqual({ name: "alice", role: "engineer", domain: "backend" });
  });

  test("rejects single value (no colon)", () => {
    expect(() => parseAgentAssignment("alice")).toThrow(/Invalid agent assignment/);
  });

  test("rejects too many colons", () => {
    expect(() => parseAgentAssignment("a:b:c:d")).toThrow(/Invalid agent assignment/);
  });

  test("rejects empty string", () => {
    expect(() => parseAgentAssignment("")).toThrow(/Invalid agent assignment/);
  });
});

// ---------------------------------------------------------------------------
// validateAgentNames
// ---------------------------------------------------------------------------

describe("validateAgentNames", () => {
  test("accepts a list of valid unique names", () => {
    expect(() => validateAgentNames(["alice", "bob", "charlie"])).not.toThrow();
  });

  test("rejects reserved names", () => {
    for (const reserved of RESERVED_NAMES) {
      expect(() => validateAgentNames([reserved])).toThrow(/reserved/);
    }
  });

  test("reserved name check is case-insensitive", () => {
    expect(() => validateAgentNames(["Gateway"])).toThrow(/reserved/);
    expect(() => validateAgentNames(["HIVE"])).toThrow(/reserved/);
  });

  test("rejects duplicate names", () => {
    expect(() => validateAgentNames(["alice", "alice"])).toThrow(/Duplicate/);
  });

  test("duplicate check is case-insensitive", () => {
    expect(() => validateAgentNames(["Alice", "alice"])).toThrow(/Duplicate/);
  });

  test("rejects invalid names in the list", () => {
    expect(() => validateAgentNames(["valid", "bad name"])).toThrow(/Invalid name/);
  });

  test("accepts empty list", () => {
    expect(() => validateAgentNames([])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AGENT_NAME_RE (regex contract)
// ---------------------------------------------------------------------------

describe("AGENT_NAME_RE", () => {
  test("matches valid patterns", () => {
    expect(AGENT_NAME_RE.test("a")).toBe(true);
    expect(AGENT_NAME_RE.test("agent-1")).toBe(true);
    expect(AGENT_NAME_RE.test("ABC123")).toBe(true);
  });

  test("rejects injection patterns", () => {
    expect(AGENT_NAME_RE.test("../etc/passwd")).toBe(false);
    expect(AGENT_NAME_RE.test("$(whoami)")).toBe(false);
    expect(AGENT_NAME_RE.test("name; rm -rf /")).toBe(false);
  });
});
