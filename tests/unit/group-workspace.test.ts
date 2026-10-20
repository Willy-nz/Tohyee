import { describe, expect, it } from "vitest";
import { coversDate, dayBefore, membersOn, notEnded, periodCrossesMembership, periodOverlap } from "@/lib/consolidation/membership";
import { invalidateGroupWorkspace, readWorkspaceCache, workspaceCacheKey, workspaceCacheSize, writeWorkspaceCache } from "@/lib/consolidation/workspace-cache";
import { mergeCurrencyTotals, resolveStages, totalsByCurrency, translateTotals } from "@/lib/consolidation/workspace-figures";

/** The group workspace's rules on their own (#200, decisions 640-645, example CO13). */
describe("membership dates (decision 640)", () => {
  const holdings = { organisationId: "holdings", effectiveFrom: null, effectiveTo: null };
  const retail = { organisationId: "retail", effectiveFrom: "2026-07-01", effectiveTo: null };
  const pty = { organisationId: "pty", effectiveFrom: null, effectiveTo: "2026-09-30" };
  const ptyAgain = { organisationId: "pty", effectiveFrom: "2027-01-01", effectiveTo: null };

  it("a member is in on its first and last days, and not either side", () => {
    expect(coversDate(retail, "2026-06-30")).toBe(false);
    expect(coversDate(retail, "2026-07-01")).toBe(true);
    expect(coversDate(pty, "2026-09-30")).toBe(true);
    expect(coversDate(pty, "2026-10-01")).toBe(false);
    expect(notEnded(pty, "2026-10-01")).toBe(false);
    expect(notEnded(retail, "2026-01-01")).toBe(true);
  });

  it("works out who was in the group on a date, once each", () => {
    const all = [holdings, retail, pty, ptyAgain];
    expect(membersOn(all, "2026-06-30").map((member) => member.organisationId)).toEqual(["holdings", "pty"]);
    expect(membersOn(all, "2026-10-31").map((member) => member.organisationId)).toEqual(["holdings", "retail"]);
    expect(membersOn(all, "2027-02-01").map((member) => member.organisationId)).toEqual(["holdings", "retail", "pty"]);
  });

  it("CO13: refuses a period a member joined or left part-way through, naming the dates", () => {
    const name = (id: string) => ({ holdings: "Holdings", retail: "Retail", pty: "Pty" })[id] ?? id;
    expect(periodCrossesMembership([holdings, retail], "2026-04-01", "2026-10-31", name)).toBe(
      "Retail joined the group on 2026-07-01. Tohyee doesn't split an organisation's results at the day it joined or left, so choose dates on one side of that.",
    );
    expect(periodCrossesMembership([holdings, retail], "2026-07-01", "2026-10-31", name)).toBeNull();
    expect(periodCrossesMembership([holdings, pty], "2026-04-01", "2026-10-31", name)).toContain("Pty left the group after 2026-09-30.");
    expect(periodCrossesMembership([holdings, pty], "2026-10-01", "2026-10-31", name)).toBeNull();
    expect(periodCrossesMembership([holdings, pty], "2026-04-01", "2026-09-30", name)).toBeNull();
  });

  it("refuses stays that overlap", () => {
    expect(periodOverlap({ effectiveFrom: "2026-09-01", effectiveTo: null }, [pty])).toContain("overlaps");
    expect(periodOverlap({ effectiveFrom: null, effectiveTo: null }, [pty])).toContain("overlaps");
    expect(periodOverlap({ effectiveFrom: "2026-10-01", effectiveTo: null }, [pty])).toBeNull();
    expect(periodOverlap({ effectiveFrom: "2026-10-05", effectiveTo: "2026-10-01" }, [])).toBe("The last day can't be before the first day.");
    expect(dayBefore("2026-03-01")).toBe("2026-02-28");
  });
});

describe("currencies stay apart (decision 644)", () => {
  it("adds up per currency, the group's first, never across currencies", () => {
    const totals = totalsByCurrency(
      [
        { currencyCode: "AUD", amount: "1000.00", weighted: "500.00" },
        { currencyCode: "NZD", amount: "2400.00", weighted: "1200.00" },
        { currencyCode: "AUD", amount: "250.50", weighted: "25.05" },
      ],
      "NZD",
    );
    expect(totals).toEqual([
      { currencyCode: "NZD", amount: "2400.00", weighted: "1200.00", count: 1 },
      { currencyCode: "AUD", amount: "1250.50", weighted: "525.05", count: 2 },
    ]);
    expect(mergeCurrencyTotals([totals, [{ currencyCode: "NZD", amount: "100.00", weighted: "10.00", count: 1 }]], "NZD")[0]).toEqual({ currencyCode: "NZD", amount: "2500.00", weighted: "1210.00", count: 2 });
  });

  it("translates only with a labelled basis, rounding each currency to cents, and names currencies with no rate", () => {
    const totals = [
      { currencyCode: "NZD", amount: "2400.00", weighted: "1200.00", count: 1 },
      { currencyCode: "AUD", amount: "1250.50", weighted: "525.05", count: 2 },
      { currencyCode: "USD", amount: "100.00", weighted: "100.00", count: 1 },
    ];
    const rates = new Map([["AUD", { currencyCode: "AUD", rate: "1.15", date: "2026-10-31", changed: false }]]);
    const translated = translateTotals(totals, "NZD", rates, "At the consolidation's current rates on 31 Oct 2026");
    // 1,250.50 × 1.15 = 1,438.075 → 1,438.08; 525.05 × 1.15 = 603.8075 → 603.81.
    expect(translated.amount).toBe("3838.08");
    expect(translated.weighted).toBe("1803.81");
    expect(translated.label).toBe("At the consolidation's current rates on 31 Oct 2026");
    expect(translated.rates.map((rate) => rate.currencyCode)).toEqual(["AUD"]);
    expect(translated.untranslated.map((entry) => entry.currencyCode)).toEqual(["USD"]);
  });
});

describe("stage mappings (decision 643)", () => {
  const stages = [
    { organisationId: "a", key: "prospect", name: "Prospect", type: "open" },
    { organisationId: "b", key: "prospect", name: "Prospect", type: "open" },
    { organisationId: "a", key: "quote", name: "Quoted", type: "open" },
    { organisationId: "b", key: "proposal", name: "Proposal sent", type: "open" },
  ];

  it("combines a stage that's the same everywhere and leaves different ones unmapped", () => {
    const result = resolveStages(stages, [], ["a", "b"]);
    expect(result.resolved.get("a|prospect")).toBe("Prospect");
    expect(result.resolved.get("b|prospect")).toBe("Prospect");
    expect(result.unmapped.map((stage) => `${stage.organisationId}|${stage.key}`)).toEqual(["a|quote", "b|proposal"]);
  });

  it("uses a person's mappings, and a mapped key is never also matched by name", () => {
    const result = resolveStages(
      stages,
      [
        { organisationId: "a", stageKey: "quote", groupStage: "Proposal" },
        { organisationId: "b", stageKey: "proposal", groupStage: "Proposal" },
        { organisationId: "a", stageKey: "prospect", groupStage: "Lead" },
      ],
      ["a", "b"],
    );
    expect(result.resolved.get("a|quote")).toBe("Proposal");
    expect(result.resolved.get("b|proposal")).toBe("Proposal");
    expect(result.resolved.get("a|prospect")).toBe("Lead");
    expect(result.unmapped.map((stage) => `${stage.organisationId}|${stage.key}`)).toEqual(["b|prospect"]);
  });
});

describe("the workspace's copies (decision 645)", () => {
  const base = { userId: "u1", groupId: "g1", version: 1, periods: [{ organisationId: "a", effectiveFrom: null, effectiveTo: null }], roles: [["a", "owner"]] as Array<[string, string | undefined]>, extra: "2026-10-31|none" };

  it("a changed role, version or member date is a different copy", () => {
    const key = workspaceCacheKey(base);
    expect(workspaceCacheKey({ ...base, roles: [["a", "viewer"]] })).not.toBe(key);
    expect(workspaceCacheKey({ ...base, roles: [["a", undefined]] })).not.toBe(key);
    expect(workspaceCacheKey({ ...base, version: 2 })).not.toBe(key);
    expect(workspaceCacheKey({ ...base, periods: [{ organisationId: "a", effectiveFrom: null, effectiveTo: "2026-10-01" }] })).not.toBe(key);
    expect(workspaceCacheKey({ ...base, userId: "u2" })).not.toBe(key);
  });

  it("expires after a minute and is dropped when the group changes", () => {
    const key = workspaceCacheKey(base);
    writeWorkspaceCache(key, "g1", { figure: 1 }, 1_000);
    expect(readWorkspaceCache<{ figure: number }>(key, 30_000)?.value).toEqual({ figure: 1 });
    expect(readWorkspaceCache(key, 62_000)).toBeNull();
    writeWorkspaceCache(key, "g1", { figure: 2 }, Date.now());
    expect(workspaceCacheSize("g1")).toBe(1);
    invalidateGroupWorkspace("g1");
    expect(workspaceCacheSize("g1")).toBe(0);
    expect(readWorkspaceCache(key)).toBeNull();
  });
});
