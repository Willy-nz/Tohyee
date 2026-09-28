import { describe, expect, it } from "vitest";
import { dueToday } from "@/lib/backups/scheduler";
import { backupsToKeep } from "@/lib/backups/retention";

describe("which backups are kept (14 daily + 12 monthly)", () => {
  const name = (stamp: string) => `green-island_${stamp}.tohyee-backup`;

  it("keeps the newest backup of each of the last 14 days that have one, and the first of each of the last 12 months", () => {
    // One a night from 1 Jan to 28 Sep 2026 (271 nights), plus a second on 28 Sep.
    const stamps: string[] = [];
    for (let day = new Date(Date.UTC(2026, 0, 1)); day <= new Date(Date.UTC(2026, 8, 28)); day.setUTCDate(day.getUTCDate() + 1)) {
      stamps.push(`${day.toISOString().slice(0, 10)}_020000`);
    }
    stamps.push("2026-09-28_143000");
    const keep = backupsToKeep(stamps.map((stamp) => ({ name: name(stamp), stamp })));

    const daily = [...Array(14).keys()].map((i) => {
      const day = new Date(Date.UTC(2026, 8, 28 - i)).toISOString().slice(0, 10);
      return name(`${day}_${i === 0 ? "143000" : "020000"}`);
    });
    const monthly = ["01", "02", "03", "04", "05", "06", "07", "08", "09"].map((m) => name(`2026-${m}-01_020000`));
    expect([...keep].sort()).toEqual([...new Set([...daily, ...monthly])].sort());
    expect(keep.has(name("2026-09-28_020000"))).toBe(false); // the earlier one that day goes
    expect(keep.size).toBe(23);
  });

  it("counts days that have a backup, so a server that was off keeps 14 anyway", () => {
    const stamps = ["2026-01-05", "2026-03-10", "2026-03-11", "2026-09-01"].map((d) => `${d}_020000`);
    const keep = backupsToKeep(stamps.map((stamp) => ({ name: stamp, stamp })));
    expect(keep.size).toBe(4);
  });

  it("drops months beyond 12", () => {
    const stamps = [...Array(15).keys()].map((i) => {
      const d = new Date(Date.UTC(2025, i, 1));
      return `${d.toISOString().slice(0, 10)}_020000`;
    });
    const keep = backupsToKeep(stamps.map((stamp) => ({ name: stamp, stamp })), 1, 12);
    expect(keep.size).toBe(12);
    expect(keep.has("2025-01-01_020000")).toBe(false);
    expect(keep.has("2026-03-01_020000")).toBe(true);
  });
});

describe("when the nightly backup is due (NZ time)", () => {
  // 28 Sep 2026 in Auckland is NZDT, UTC+13: 02:00 local = 27 Sep 13:00 UTC.
  const at = (iso: string) => new Date(iso);
  const settings = { enabled: true, time: "02:00" };
  const targets = [null, "green-island"];

  it("isn't due before the set time, and is due for everything after it", () => {
    expect(dueToday(at("2026-09-27T12:59:00Z"), settings, targets, [])).toEqual([]);
    expect(dueToday(at("2026-09-27T13:05:00Z"), settings, targets, [])).toEqual(targets);
    expect(dueToday(at("2026-09-27T13:05:00Z"), { ...settings, enabled: false }, targets, [])).toEqual([]);
  });

  it("isn't due again once there's a good backup since the set time (a manual one counts)", () => {
    const runs = [
      { organisationId: null, trigger: "schedule" as const, status: "ok", startedAt: at("2026-09-27T13:01:00Z") },
      { organisationId: "green-island", trigger: "manual" as const, status: "ok", startedAt: at("2026-09-27T20:00:00Z") },
    ];
    expect(dueToday(at("2026-09-27T21:00:00Z"), settings, targets, runs)).toEqual([]);
    // Yesterday's backups don't count for today.
    expect(dueToday(at("2026-09-28T13:10:00Z"), settings, targets, runs)).toEqual(targets);
  });

  it("tries a failed one again an hour later", () => {
    const runs = [{ organisationId: "green-island", trigger: "schedule" as const, status: "failed", startedAt: at("2026-09-27T13:01:00Z") }];
    expect(dueToday(at("2026-09-27T13:30:00Z"), settings, targets, runs)).toEqual([null]);
    expect(dueToday(at("2026-09-27T14:02:00Z"), settings, targets, runs)).toEqual(targets);
  });
});
