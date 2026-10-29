import { describe, expect, it } from "vitest";
import { FARM_TABS, farmTabFor } from "@/lib/farming/farm-nav";

/** The Farm tabs on every farm page (#498 item 2, decision 1111): which tab each page marks. */
describe("farm tabs", () => {
  it("are Today, Map, Log, Safety and More", () => {
    expect(FARM_TABS.map((tab) => tab.label)).toEqual(["Today", "Map", "Log", "Safety", "More"]);
  });

  it("mark the page's own tab, however it was opened", () => {
    expect(farmTabFor("/operations/farm")).toBe("today");
    expect(farmTabFor("/operations/farm/")).toBe("today");
    expect(farmTabFor("/operations/farm/map")).toBe("map");
    expect(farmTabFor("/operations/farm/tractor")).toBe("map");
    expect(farmTabFor("/operations/farm/tractor/abc")).toBe("map");
    expect(farmTabFor("/operations/farm/log")).toBe("log");
    expect(farmTabFor("/operations/farm/safety")).toBe("safety");
    expect(farmTabFor("/operations/farming/safety")).toBe("safety");
    expect(farmTabFor("/operations/farm/more")).toBe("more");
  });

  it("put Effluent and the other farm pages under More", () => {
    for (const path of ["/operations/farm/effluent", "/operations/farm/offline", "/operations/farming", "/operations/farming/pasture", "/operations/farming/calendar", "/operations/farming/benchmarks"]) expect(farmTabFor(path)).toBe("more");
  });
});
