import { describe, expect, it } from "vitest";
import { type CoverPair, fitWithWeather, validate } from "@/lib/farming/vegetation/cover-fit";
import { daysFromForecasts, rainBefore, rainFor, temperatureBefore } from "@/lib/farming/weather-history-rules";

/** FW1-FW8 and MCV9 in docs/ACCOUNTING-EXAMPLES.md (not yet reviewed). Made-up forecasts. */
const hour = (at: string, rainMm: string | null, temperatureC: string | null = "10.0") => ({ at, rainMm, temperatureC });

describe("daily weather from kept MetService forecasts", () => {
  it("FW2: each hour from the forecast fetched latest before it, else the earliest after", () => {
    // 1 Nov 2026 NZDT is 31 Oct 11:00Z to 1 Nov 11:00Z.
    const hours = (rain: string, from = 0, count = 24) => Array.from({ length: count }, (_, i) => hour(new Date(Date.parse("2026-10-31T11:00:00Z") + (from + i) * 3_600_000).toISOString(), rain));
    const early = { fetchedAt: "2026-10-30T00:00:00Z", hours: hours("1.0") };
    const later = { fetchedAt: "2026-10-31T17:00:00Z", hours: hours("0.5") };
    const history = { fetchedAt: "2026-11-04T00:00:00Z", hours: hours("9.9") };
    // Hours before 17:00Z come from the early one (6 h at 1.0), after it from the later one (18 h at 0.5): 15.0 mm.
    expect(daysFromForecasts([early, later, history], "2026-11-05")).toEqual([{ day: "2026-11-01", rainMm: "15.0", temperatureC: "10.0", hours: 24 }]);
    // Only MetService's history: the hours come from it.
    expect(daysFromForecasts([history], "2026-11-05")[0]).toMatchObject({ rainMm: "237.6", hours: 24 });
    // A day still going isn't worked out.
    expect(daysFromForecasts([early], "2026-11-01")).toEqual([]);
    // Hours with no value aren't counted, and the day says how many it had.
    expect(daysFromForecasts([{ fetchedAt: "2026-10-30T00:00:00Z", hours: hours("2.0", 0, 10) }], "2026-11-05")[0]).toMatchObject({ rainMm: "20.0", hours: 10 });
  });

  it("FW4: a gauge reading comes first; the 14 days before a date, or unknown", () => {
    expect(rainFor(["12.4", "13.0"], "8.0")).toEqual({ mm: "12.7", source: "gauge" });
    expect(rainFor([], "8.0")).toEqual({ mm: "8.0", source: "metservice" });
    expect(rainFor([], null)).toBeNull();
    const days = new Map(Array.from({ length: 14 }, (_, i) => [`2026-11-${String(i + 1).padStart(2, "0")}`, "1.5"]));
    expect(rainBefore(days, "2026-11-15")).toBe("21.0");
    expect(rainBefore(days, "2026-11-16")).toBeNull();
    expect(temperatureBefore(new Map([...days].map(([day]) => [day, "11.0"])), "2026-11-15")).toBe("11.0");
  });
});

describe("modelled cover with the weather", () => {
  /** 24 readings on 6 dates; cover = 500 + 3000 × greenness + 20 × rain in the 14 days before. */
  function pairs(rainMatters: boolean): CoverPair[] {
    const out: CoverPair[] = [];
    const rains = ["10.0", "60.0", "25.0", "80.0", "5.0", "40.0"];
    const ndvis = ["0.40", "0.55", "0.70", "0.85"];
    rains.forEach((rain, d) =>
      ndvis.forEach((ndvi, i) =>
        out.push({
          farmId: "1",
          paddockId: String(i + 1),
          sceneId: `s${d}`,
          imageOn: `2026-0${d + 1}-15`,
          measuredOn: `2026-0${d + 1}-15`,
          ndvi,
          cover: 500 + 3000 * Number(ndvi) + (rainMatters ? 20 * Number(rain) : (i % 2 ? 30 : -30)),
          rain14: rain,
          temperature14: String(8 + d),
        }),
      ),
    );
    return out;
  }

  it("MCV9: fits greenness and rain exactly, and uses it only when it's closer on dates left out", () => {
    expect(fitWithWeather(pairs(true), "rain")).toEqual({ intercept: "500.0000", slope: "3000.0000", rain: "20.0000" });
    const helped = validate(pairs(true)).weather!;
    expect(helped.best).not.toBe("greenness");
    expect(helped.greennessOnly.meanError).toBeGreaterThan(helped.options.find((option) => option.terms === "rain")!.withheldDates.meanError);
    // When rain makes no difference, greenness alone stays.
    expect(validate(pairs(false)).weather!.best).toBe("greenness");
    // Too few readings with their weather known: not compared.
    expect(validate(pairs(true).map((pair, i) => (i < 14 ? { ...pair, rain14: null } : pair))).weather).toBeNull();
  });
});
