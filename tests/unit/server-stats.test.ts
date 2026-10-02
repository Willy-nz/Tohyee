import { afterEach, describe, expect, it } from "vitest";
import { activeUsers, countRequest, noteActiveUser, resetCounters, takeRequestCounts } from "@/lib/server-stats/counters";
import { cpuPercentBetween, cpuTimes, processCpuPercent, pushSample, type StatsSample } from "@/lib/server-stats/sampler";

/** Decision 332: the server app's Stats page. */
describe("server stats", () => {
  afterEach(() => resetCounters());

  it("works out CPU use from two readings", () => {
    const before = cpuTimes([
      { times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
      { times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
    ]);
    expect(before).toEqual({ idle: 1700, total: 2000 });
    // 2000 more ms across both cores, 500 of them busy: 25%.
    expect(cpuPercentBetween(before, { idle: 3200, total: 4000 })).toBe(25);
    expect(cpuPercentBetween(before, before)).toBeNull();
    // Tohyee used 1.5 s of CPU in a minute on 4 cores: 0.6% of the computer.
    expect(processCpuPercent(1_500_000, 60_000, 4)).toBe(0.6);
    expect(processCpuPercent(1, 0, 4)).toBeNull();
  });

  it("counts requests per minute and starts again", () => {
    expect(takeRequestCounts()).toEqual({ requests: 0, serverErrors: 0, averageMs: null, slowestMs: null });
    countRequest(10, 200);
    countRequest(30, 500);
    countRequest(20, 404);
    expect(takeRequestCounts()).toEqual({ requests: 3, serverErrors: 1, averageMs: 20, slowestMs: 30 });
    expect(takeRequestCounts().requests).toBe(0);
  });

  it("counts people active lately, without keeping them for more than a day", () => {
    const now = Date.parse("2026-10-02T03:00:00Z");
    noteActiveUser("a", now - 60_000);
    noteActiveUser("b", now - 10 * 60_000);
    noteActiveUser("c", now - 25 * 60 * 60_000);
    noteActiveUser("a", now - 30_000);
    expect(activeUsers(5 * 60_000, now)).toBe(1);
    expect(activeUsers(24 * 60 * 60_000, now)).toBe(2);
  });

  it("keeps the newest 24 hours of samples", () => {
    const samples: StatsSample[] = [];
    for (let i = 0; i < 5; i += 1) pushSample(samples, { at: String(i) } as StatsSample, 3);
    expect(samples.map((s) => s.at)).toEqual(["2", "3", "4"]);
  });
});
