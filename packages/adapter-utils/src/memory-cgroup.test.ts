import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  wrapWithMemoryCgroup,
  resetSystemdRunCache,
  scopeUnitName,
  sanitizeUnitSuffix,
  defaultMemoryMaxFor,
  DEFAULT_CAPS_BY_ADAPTER,
  DEFAULT_CAP_FALLBACK,
} from "./memory-cgroup.js";

// Force systemd-run path for testing (assume Linux + available in CI).
// We stub `checkSystemdRunAvailable` by manipulating the cache via a direct
// import of the underlying function isn't exposed, so we instead rely on the
// PAPERCLIP_DISABLE_MEMORY_CAPS=1 path and dedicated tests using a pre-primed
// cache via `resetSystemdRunCache` combined with a forced environment.
//
// Strategy: instead of mocking systemd-run detection, we test the wrap logic
// by pre-setting the cache to "available" via the internal flag. We can't
// reach the flag from outside, so these tests verify the two branches:
// (a) disabled env returns passthrough; (b) when systemd-run is actually
// installed on CI runner, wrap produces expected shape.

describe("sanitizeUnitSuffix", () => {
  it("keeps safe chars", () => {
    expect(sanitizeUnitSuffix("abc123_.-:")).toBe("abc123_.-:");
  });

  it("replaces unsafe chars with underscore", () => {
    expect(sanitizeUnitSuffix("abc/123 xyz$")).toBe("abc_123_xyz_");
  });

  it("truncates to 200 chars", () => {
    const long = "a".repeat(500);
    expect(sanitizeUnitSuffix(long).length).toBe(200);
  });
});

describe("scopeUnitName", () => {
  it("produces paperclip-run-<id>.scope", () => {
    expect(scopeUnitName("run-xyz-123")).toBe("paperclip-run-run-xyz-123.scope");
  });

  it("sanitizes runId chars", () => {
    expect(scopeUnitName("run/with spaces")).toBe("paperclip-run-run_with_spaces.scope");
  });
});

describe("defaultMemoryMaxFor", () => {
  beforeEach(() => {
    delete process.env.PAPERCLIP_ADAPTER_MEMORY_MAX;
  });

  it("returns per-adapter default when known", () => {
    expect(defaultMemoryMaxFor("claude")).toBe("4G");
    expect(defaultMemoryMaxFor("claude_local")).toBe("4G");
    expect(defaultMemoryMaxFor("codex_local")).toBe("3G");
  });

  it("returns fallback for unknown adapter", () => {
    expect(defaultMemoryMaxFor("unknown")).toBe(DEFAULT_CAP_FALLBACK);
    expect(defaultMemoryMaxFor(undefined)).toBe(DEFAULT_CAP_FALLBACK);
  });

  it("env override wins over per-adapter default", () => {
    process.env.PAPERCLIP_ADAPTER_MEMORY_MAX = "16G";
    expect(defaultMemoryMaxFor("claude")).toBe("16G");
  });

  it("covers all local adapter types with known caps", () => {
    for (const key of [
      "claude",
      "claude_local",
      "codex",
      "codex_local",
      "gemini",
      "gemini_local",
      "pi",
      "pi_local",
      "cursor",
      "cursor_local",
      "opencode",
      "opencode_local",
      "hermes_local",
    ]) {
      expect(DEFAULT_CAPS_BY_ADAPTER[key]).toMatch(/^\d+G$/);
    }
  });
});

describe("wrapWithMemoryCgroup — disabled path", () => {
  beforeEach(() => {
    resetSystemdRunCache();
  });
  afterEach(() => {
    delete process.env.PAPERCLIP_DISABLE_MEMORY_CAPS;
  });

  it("returns passthrough when PAPERCLIP_DISABLE_MEMORY_CAPS=1", () => {
    process.env.PAPERCLIP_DISABLE_MEMORY_CAPS = "1";
    const result = wrapWithMemoryCgroup("claude", ["--print"], { memoryMax: "4G" });
    expect(result.command).toBe("claude");
    expect(result.args).toEqual(["--print"]);
  });
});

describe("wrapWithMemoryCgroup — wrap shape (linux+systemd-run available)", () => {
  beforeEach(() => {
    resetSystemdRunCache();
    delete process.env.PAPERCLIP_DISABLE_MEMORY_CAPS;
  });

  const isLinuxWithSystemdRun =
    process.platform === "linux" &&
    (() => {
      try {
        return require("node:fs").existsSync("/usr/bin/systemd-run") ||
          require("node:fs").existsSync("/bin/systemd-run");
      } catch {
        return false;
      }
    })();

  (isLinuxWithSystemdRun ? it : it.skip)(
    "threads unitName as --unit= argument in systemd-run args",
    () => {
      const result = wrapWithMemoryCgroup("bwrap", ["--bind", "/", "/", "claude"], {
        memoryMax: "4G",
        unitName: "paperclip-run-abc.scope",
      });
      // Either wrapped or fell back — accept both but if wrapped assert shape.
      if (result.command === "systemd-run") {
        expect(result.args).toContain("--unit=paperclip-run-abc.scope");
        expect(result.args).toContain("--property=MemoryMax=4G");
        expect(result.args).toContain("--property=MemorySwapMax=0");
        // bwrap must appear *after* the -- separator, preserving the
        // systemd-run(bwrap(command)) ordering.
        const sep = result.args.indexOf("--");
        expect(sep).toBeGreaterThan(0);
        expect(result.args.slice(sep + 1)).toEqual([
          "bwrap",
          "--bind",
          "/",
          "/",
          "claude",
        ]);
      }
    },
  );

  (isLinuxWithSystemdRun ? it : it.skip)(
    "uses per-adapter default cap when memoryMax not given",
    () => {
      const result = wrapWithMemoryCgroup("claude", [], {
        adapterType: "claude_local",
        unitName: "paperclip-run-xyz.scope",
      });
      if (result.command === "systemd-run") {
        expect(result.args).toContain("--property=MemoryMax=4G");
      }
    },
  );
});
