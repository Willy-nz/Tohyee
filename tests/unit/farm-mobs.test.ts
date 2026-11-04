import { describe, expect, it } from "vitest";
import { classFrom, gainText, kindFrom, mobName, weightGain } from "@/lib/farming/mob-rules";
import { factorsWith, STOCK_UNIT_DEFAULTS, stocking } from "@/lib/farming/stock-units";
import { LIVESTOCK_CLASSES } from "@/lib/livestock/classes";

describe("stock units (decision 1424, MOB10)", () => {
  it("has a default for every IRD class, each with the row of the table it uses", () => {
    for (const entry of LIVESTOCK_CLASSES) {
      const found = STOCK_UNIT_DEFAULTS.find((row) => row.kind === entry.kind && row.classCode === entry.code);
      expect(found, `${entry.kind}.${entry.code}`).toBeDefined();
      expect(found!.basis.length).toBeGreaterThan(3);
    }
    expect(STOCK_UNIT_DEFAULTS.length).toBe(LIVESTOCK_CLASSES.length);
  });

  it("works out SU/ha and head/ha in decimals, with changed factors", () => {
    const factors = factorsWith([{ kind: "dairy_cattle", classCode: "ma_cows", factor: "7.3" }]);
    const result = stocking(
      [
        { head: 300, kind: "dairy_cattle", classCode: "ma_cows" },
        { head: 3, kind: "sheep", classCode: "ewe_hoggets" },
      ],
      "120.50",
      factors,
    );
    // 300 × 7.3 + 3 × 0.7 = 2,192.1 SU on 120.5 ha.
    expect(result).toEqual({ head: 303, stockUnits: "2192.1", hectares: "120.50", suPerHa: "18.2", headPerHa: "2.5" });
    expect(factors.find((row) => row.classCode === "ma_cows" && row.kind === "dairy_cattle")).toMatchObject({ factor: "7.30", defaultFactor: "8.00", changed: true });
    expect(stocking([{ head: 10, kind: "sheep", classCode: "ma_ewes" }], null, factors)).toMatchObject({ stockUnits: "10.0", suPerHa: null });
  });
});

describe("mob rules (MOB8)", () => {
  it("works out the gain between weighings", () => {
    const gain = weightGain({ date: "2026-09-01", averageKg: "412.0" }, { date: "2026-10-01", averageKg: "436.0" });
    expect(gain).toEqual({ kg: "24.0", days: 30, kgPerDay: "0.80" });
    expect(gainText(gain)).toBe("+24.0 kg over 30 days (+0.80 kg a day)");
    expect(weightGain({ date: "2026-09-01", averageKg: "50" }, { date: "2026-09-01", averageKg: "48.5" })).toEqual({ kg: "-1.5", days: 0, kgPerDay: null });
  });

  it("reads kinds and classes from a file's words", () => {
    expect(kindFrom("Sheep")).toBe("sheep");
    expect(kindFrom("Dairy cows")).toBe("dairy_cattle");
    expect(kindFrom("beef")).toBe("beef_cattle");
    expect(kindFrom("Red deer")).toBe("deer_red");
    expect(kindFrom("pigs")).toBeNull();
    expect(classFrom("sheep", "Two-tooth ewes")).toBe("two_tooth_ewes");
    expect(classFrom("sheep", "ewe_hoggets")).toBe("ewe_hoggets");
    expect(classFrom("dairy_cattle", "Cows")).toBeNull();
    expect(mobName({ name: null, kind: "sheep", classCode: "ma_ewes" })).toBe("Mixed-age ewes (rising three and four)");
  });
});
