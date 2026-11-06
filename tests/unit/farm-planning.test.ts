import { describe, expect, it } from "vitest";
import { birthsFrom, inCalfPercent, planRound, roundText, scanningPercent } from "@/lib/farming/planning-rules";

describe("breeding figures (BR1-BR3)", () => {
  it("works out scanning %, in-calf % and expected births", () => {
    expect(scanningPercent({ head: 500, singles: 250, twins: 210, triplets: 10 })).toBe("140");
    expect(scanningPercent({ head: 500, singles: 250, twins: 210, triplets: 10 }, 520)).toBe("135");
    expect(inCalfPercent(200, 188)).toBe("94.0");
    expect(birthsFrom("sheep", "2026-04-01")).toBe("2026-08-26");
    expect(birthsFrom("dairy_cattle", "2026-10-20")).toBe("2027-07-30");
  });
});

describe("rotation (BR5-BR6)", () => {
  it("shares a round between paddocks by area, adding up to the round", () => {
    const stops = planRound(
      [
        { paddockId: "1", name: "A", hectares: "10.00" },
        { paddockId: "2", name: "B", hectares: "5.00" },
        { paddockId: "3", name: "C", hectares: "15.00" },
      ],
      "2026-11-01",
      30,
    );
    expect(stops.map((stop) => [stop.name, stop.plannedOn, stop.days])).toEqual([
      ["A", "2026-11-01", 10],
      ["B", "2026-11-11", 5],
      ["C", "2026-11-16", 15],
    ]);
    // No area: the average of the rest; every paddock gets at least a day.
    const odd = planRound([{ paddockId: "1", name: "A", hectares: "1" }, { paddockId: "2", name: "B", hectares: null }, { paddockId: "3", name: "C", hectares: "100" }], "2026-11-01", 10);
    expect(odd.map((stop) => stop.days)).toEqual([1, 3, 6]);
    expect(odd.reduce((sum, stop) => sum + stop.days, 0)).toBe(10);
    expect(roundText("2026-10-18", 25, "2026-11-05")).toBe("18 of 25 days");
    expect(roundText("2026-10-01", 25, "2026-11-05")).toBe("35 days since grazed (round 25)");
  });
});
