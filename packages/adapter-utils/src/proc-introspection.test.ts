import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import {
  readCgroupMemory,
  readCgroupPids,
  readCgroupCpuStat,
  readLoadAvg,
  readSystemFdUsage,
  readSystemPidUsage,
  readSystemMemory,
  scopeCgroupPath,
} from "./proc-introspection.js";

const MB = 1024 * 1024;

function mockFile(contents: Record<string, string>) {
  const original = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((p: unknown, opts: unknown) => {
    const key = String(p);
    if (key in contents) return contents[key] as never;
    return original(p as never, opts as never);
  });
}

describe("proc-introspection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("scopeCgroupPath", () => {
    it("derives cgroup v2 path for a named scope", () => {
      const p = scopeCgroupPath("paperclip-run-abc.scope", 1002);
      expect(p).toBe(
        "/sys/fs/cgroup/user.slice/user-1002.slice/user@1002.service/app.slice/paperclip-run-abc.scope",
      );
    });
  });

  describe("readCgroupMemory", () => {
    it("parses memory.current / memory.max / memory.events", () => {
      mockFile({
        "/cg/memory.current": String(512 * MB),
        "/cg/memory.max": String(4 * 1024 * MB),
        "/cg/memory.swap.current": "0",
        "/cg/memory.events": "low 0\nhigh 0\nmax 2\noom 1\noom_kill 1\n",
      });
      const m = readCgroupMemory("/cg");
      expect(m).toEqual({
        currentMB: 512,
        maxMB: 4096,
        swapCurrentMB: 0,
        oomKillCount: 1,
        oomCount: 1,
      });
    });

    it("returns null when memory.current is missing", () => {
      vi.spyOn(fs, "readFileSync").mockImplementation(() => {
        throw new Error("ENOENT");
      });
      expect(readCgroupMemory("/cg")).toBeNull();
    });

    it("treats 'max' as unlimited", () => {
      mockFile({
        "/cg/memory.current": String(100 * MB),
        "/cg/memory.max": "max",
        "/cg/memory.swap.current": "0",
        "/cg/memory.events": "",
      });
      const m = readCgroupMemory("/cg");
      expect(m?.maxMB).toBeNull();
    });
  });

  describe("readCgroupPids", () => {
    it("parses pids.current / pids.max", () => {
      mockFile({ "/cg/pids.current": "42\n", "/cg/pids.max": "100\n" });
      expect(readCgroupPids("/cg")).toEqual({ current: 42, max: 100 });
    });

    it("treats 'max' as unlimited", () => {
      mockFile({ "/cg/pids.current": "42\n", "/cg/pids.max": "max\n" });
      expect(readCgroupPids("/cg")).toEqual({ current: 42, max: null });
    });
  });

  describe("readCgroupCpuStat", () => {
    it("parses cpu.stat fields", () => {
      mockFile({
        "/cg/cpu.stat":
          "usage_usec 123456\nuser_usec 100000\nsystem_usec 20000\nnr_periods 0\nnr_throttled 5\nthrottled_usec 500\n",
      });
      expect(readCgroupCpuStat("/cg")).toEqual({
        usageUsec: 123456,
        userUsec: 100000,
        systemUsec: 20000,
        throttledUsec: 500,
        nrThrottled: 5,
      });
    });
  });

  describe("readLoadAvg", () => {
    it("parses /proc/loadavg", () => {
      mockFile({ "/proc/loadavg": "0.50 0.25 0.10 1/200 99999\n" });
      const load = readLoadAvg();
      expect(load?.oneMin).toBe(0.5);
      expect(load?.fiveMin).toBe(0.25);
      expect(load?.fifteenMin).toBe(0.1);
      expect(load?.runnable).toBe(1);
      expect(load?.total).toBe(200);
      expect(load?.cpuCount).toBeGreaterThan(0);
    });
  });

  describe("readSystemFdUsage", () => {
    it("parses /proc/sys/fs/file-nr", () => {
      mockFile({ "/proc/sys/fs/file-nr": "1024\t0\t1000000\n" });
      const fd = readSystemFdUsage();
      expect(fd).toEqual({ used: 1024, max: 1000000, percent: 0 });
    });
  });

  describe("readSystemPidUsage", () => {
    it("counts numeric entries in /proc", () => {
      mockFile({ "/proc/sys/kernel/pid_max": "4194304\n" });
      vi.spyOn(fs, "readdirSync").mockImplementation((p: unknown) => {
        if (String(p) === "/proc") return ["1", "2", "foo", "42"] as never;
        return [] as never;
      });
      const pu = readSystemPidUsage();
      expect(pu?.count).toBe(3);
      expect(pu?.max).toBe(4194304);
    });
  });

  describe("readSystemMemory", () => {
    it("parses /proc/meminfo", () => {
      mockFile({
        "/proc/meminfo":
          "MemTotal:       16367324 kB\nMemFree:         8000000 kB\nMemAvailable:   14000000 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n",
      });
      const m = readSystemMemory();
      expect(m.totalMB).toBeGreaterThan(15000);
      expect(m.availableMB).toBeGreaterThan(13000);
      expect(m.swapTotalMB).toBe(0);
    });
  });
});
