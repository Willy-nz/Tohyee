import { describe, expect, it } from "vitest";
import {
  ageText,
  classifyAnswer,
  compassPoint,
  estimateUnits,
  type ForecastHour,
  forecastDays,
  forecastRequest,
  forecastWarnings,
  freshness,
  hoursAhead,
  METSERVICE_ATTRIBUTION,
  onlyChosen,
  parseForecast,
  pastCacheLimit,
  rainDayForecast,
  rainDifference,
  stopsRefreshing,
  variablesFor,
} from "@/lib/weather/forecast-rules";

/** The MetService forecast's rules (WX1-WX10; decisions 1541-1550, not yet reviewed). Made-up numbers. */
const NZ = "Pacific/Auckland";

function hour(at: string, values: Partial<ForecastHour> = {}): ForecastHour {
  return { at, rainMm: "0.0", temperatureC: "10.0", windKmh: "10", windDirection: "270", gustKmh: "20", ...values };
}

/** 24 hours from a UTC start, one an hour. */
function day(startUtc: string, values: (index: number) => Partial<ForecastHour>): ForecastHour[] {
  return Array.from({ length: 24 }, (_, index) => hour(new Date(Date.parse(startUtc) + index * 3_600_000).toISOString(), values(index)));
}

describe("weather forecast rules", () => {
  it("WX1 the credit to MetService is word for word", () => {
    expect(METSERVICE_ATTRIBUTION).toBe("This data was provided by MetService Limited.");
  });

  it("WX2 API units: requests x variables x points, one request a farm, by the refreshes in a day", () => {
    expect(variablesFor(["rain", "temperature", "wind"])).toEqual(["precipitation.rate", "air.temperature.at-2m", "wind.speed.at-10m", "wind.direction.at-10m"]);
    expect(estimateUnits({ choices: ["rain", "temperature", "wind"], farms: 1, refreshHours: 3 })).toEqual({ perRefresh: 4, refreshesPerDay: 8, perDay: 32, per30Days: 960, variables: 4, points: 1 });
    expect(estimateUnits({ choices: ["rain"], farms: 2, refreshHours: 12 })).toMatchObject({ perRefresh: 2, perDay: 4, per30Days: 120 });
    expect(estimateUnits({ choices: ["rain", "gusts"], farms: 3, refreshHours: 1 })).toMatchObject({ perRefresh: 6, refreshesPerDay: 24, perDay: 144 });
    expect(estimateUnits({ choices: ["rain"], farms: 0, refreshHours: 3 }).perDay).toBe(0);
    // Frost risk comes from the temperature: no extra variable.
    expect(variablesFor(["temperature"])).toEqual(["air.temperature.at-2m"]);
  });

  it("WX3 a request is 7 days from the hour, hourly, for the farm's pin", () => {
    expect(forecastRequest({ latitude: "-46.100000", longitude: "169.900000" }, ["rain"], new Date("2026-11-05T10:37:12Z"))).toEqual({
      points: [{ lon: 169.9, lat: -46.1 }],
      variables: ["precipitation.rate"],
      time: { from: "2026-11-05T10:00:00Z", interval: "1h", repeat: 167 },
    });
  });

  it("WX3 MetService's answer becomes hours: Kelvin to degrees, m/s to km/h, noData as no value", () => {
    const hours = parseForecast({
      dimensions: { point: { type: "point", data: [{ lon: 169.9, lat: -46.1 }] }, time: { type: "time", data: ["2026-11-05T10:00:00Z", "2026-11-05T11:00:00Z"] } },
      noDataReasons: { GOOD: 0, GAP: 2 },
      variables: {
        "precipitation.rate": { units: "mm/h", dimensions: ["time", "point"], data: [1.26, -0.0001], noData: [0, 0] },
        "air.temperature.at-2m": { units: "K", dimensions: ["time", "point"], data: [275.15, null], noData: [0, 2] },
        "wind.speed.at-10m": { units: "m/s", dimensions: ["time", "point"], data: [5, 10], noData: [0, 0] },
        "wind.direction.at-10m": { units: "degree", dimensions: ["time", "point"], data: [225.4, 90], noData: [0, 0] },
      },
    });
    expect(hours).toEqual([
      { at: "2026-11-05T10:00:00Z", rainMm: "1.3", temperatureC: "2.0", windKmh: "18", windDirection: "225", gustKmh: null },
      { at: "2026-11-05T11:00:00Z", rainMm: "0.0", temperatureC: null, windKmh: "36", windDirection: "90", gustKmh: null },
    ]);
    expect(() => parseForecast({ nothing: true })).toThrow("shape Tohyee doesn't know");
  });

  it("WX3 with two points (time first), the first point's values are taken", () => {
    const hours = parseForecast({
      dimensions: { point: { data: [{}, {}] }, time: { data: ["2026-11-05T10:00:00Z", "2026-11-05T11:00:00Z"] } },
      variables: { "precipitation.rate": { units: "mm/h", dimensions: ["time", "point"], data: [1, null, 2, null], noData: [0, 1, 0, 1] } },
    });
    expect(hours.map((entry) => entry.rainMm)).toEqual(["1.0", "2.0"]);
  });

  it("WX3 only what was chosen is kept", () => {
    const [kept] = onlyChosen([hour("2026-11-05T10:00:00Z")], ["rain"]);
    expect(kept).toEqual({ at: "2026-11-05T10:00:00Z", rainMm: "0.0", temperatureC: null, windKmh: null, windDirection: null, gustKmh: null });
  });

  it("WX4 days are New Zealand days: the day's rain, low and high, strongest wind and gust", () => {
    // 6 November 2026 in New Zealand (NZDT, +13) starts at 11:00 UTC on the 5th.
    const hours = day("2026-11-05T11:00:00Z", (index) => ({ rainMm: index < 4 ? "1.5" : "0.0", temperatureC: String(5 + index / 2), gustKmh: index === 10 ? "55" : "20" }));
    expect(forecastDays(hours, NZ)).toEqual([{ date: "2026-11-06", hours: 24, rainMm: "6.0", minC: "5", maxC: "16.5", maxWindKmh: "10", maxGustKmh: "55" }]);
  });

  it("WX5 frost at 2 degrees or below, heavy rain at 25 mm in a day or 10 mm in an hour; one of each a day", () => {
    const frosty = day("2026-11-05T11:00:00Z", (index) => ({ temperatureC: index === 7 ? "1.5" : index === 8 ? "-0.5" : "8.0" }));
    expect(forecastWarnings(frosty, NZ)).toEqual([{ kind: "frost", date: "2026-11-06", text: "Frost risk: down to -0.5 °C." }]);
    const wet = day("2026-11-06T11:00:00Z", (index) => ({ rainMm: index < 10 ? "2.6" : "0.0" }));
    expect(forecastWarnings(wet, NZ)).toEqual([{ kind: "heavy_rain", date: "2026-11-07", text: "Heavy rain: 26.0 mm in the day." }]);
    const burst = day("2026-11-07T11:00:00Z", (index) => ({ rainMm: index === 3 ? "12.0" : "0.0" }));
    expect(forecastWarnings(burst, NZ)).toEqual([{ kind: "heavy_rain", date: "2026-11-08", text: "Heavy rain: up to 12.0 mm in an hour." }]);
    expect(forecastWarnings(day("2026-11-05T11:00:00Z", () => ({ temperatureC: "2.1", rainMm: "1.0" })), NZ)).toEqual([]);
  });

  it("WX6 stale an hour past the next refresh; gone at 24 hours; the age in words", () => {
    const now = new Date("2026-11-05T12:00:00Z");
    expect(freshness("2026-11-05T08:00:00Z", 3, now)).toBe("fresh");
    expect(freshness("2026-11-05T07:59:00Z", 3, now)).toBe("stale");
    expect(pastCacheLimit("2026-11-04T12:00:01Z", now)).toBe(false);
    expect(pastCacheLimit("2026-11-04T12:00:00Z", now)).toBe(true);
    expect(ageText("2026-11-05T11:59:50Z", now)).toBe("just now");
    expect(ageText("2026-11-05T11:00:00Z", now)).toBe("1 hour ago");
    expect(ageText("2026-11-05T11:15:00Z", now)).toBe("45 minutes ago");
    expect(ageText("2026-11-05T09:00:00Z", now)).toBe("3 hours ago");
    expect(ageText("2026-11-03T00:00:00Z", now)).toBe("3 days ago");
    const hours = [hour("2026-11-05T10:00:00Z"), hour("2026-11-05T11:00:00Z"), hour("2026-11-05T12:00:00Z"), hour("2026-11-05T13:00:00Z")];
    expect(hoursAhead(hours, new Date("2026-11-05T11:30:00Z"), 2).map((entry) => entry.at)).toEqual(["2026-11-05T11:00:00Z", "2026-11-05T12:00:00Z"]);
    expect(compassPoint("225")).toBe("SW");
    expect(compassPoint("359")).toBe("N");
    expect(compassPoint(null)).toBeNull();
  });

  it("WX7 what MetService's answers mean, and which stop refreshing (the spending guard)", () => {
    expect(classifyAnswer(200, "")).toBe("ok");
    expect(classifyAnswer(401, "Unauthorized")).toBe("bad_key");
    expect(classifyAnswer(402, "")).toBe("no_units");
    expect(classifyAnswer(403, "API unit quota exceeded")).toBe("no_units");
    expect(classifyAnswer(403, "Forbidden")).toBe("not_allowed");
    expect(classifyAnswer(429, "Too many requests, rate limit")).toBe("rate_limited");
    expect(classifyAnswer(429, "Insufficient credit")).toBe("no_units");
    expect(classifyAnswer(500, "")).toBe("error");
    expect(["no_units", "bad_key", "not_allowed", "rate_limited", "error"].map((status) => stopsRefreshing(status as never))).toEqual([true, true, true, false, false]);
  });

  it("WX9 a rain day's forecast is 9 am to 9 am, as a gauge reads it; the difference is gauge less forecast", () => {
    // 9 am NZDT on 6 November is 20:00 UTC on the 5th.
    const hours = [...day("2026-11-05T20:00:00Z", (index) => ({ rainMm: index < 5 ? "1.0" : "0.0" })), hour("2026-11-06T20:00:00Z", { rainMm: "9.0" })];
    expect(rainDayForecast(hours, "2026-11-06", NZ)).toBe("5.0");
    // Not all 24 hours: no forecast for that day.
    expect(rainDayForecast(hours.slice(1), "2026-11-06", NZ)).toBeNull();
    expect(rainDayForecast(hours.map((entry, index) => (index === 3 ? { ...entry, rainMm: null } : entry)), "2026-11-06", NZ)).toBeNull();
    expect(rainDifference("8.5", "5.0")).toBe("+3.5");
    expect(rainDifference("4.0", "5.0")).toBe("-1.0");
    expect(rainDifference("5.0", "5.0")).toBe("+0.0");
  });
});
