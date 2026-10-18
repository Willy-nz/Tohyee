import { describe, expect, it } from "vitest";
import { bearerFarmAppKey, parseScopes } from "@/lib/farm-apps/keys";
import { effectiveScopes, scopesAllowed } from "@/lib/farm-apps/scopes";

describe("farm app keys and scopes (FA1, FA2, not yet reviewed)", () => {
  it("FA2 reading needs a role that sees Farming; recording needs bookkeeper or higher", () => {
    expect(scopesAllowed("viewer")).toEqual(["read_farm", "read_soil", "read_pasture"]);
    expect(scopesAllowed("bookkeeper")).toEqual(["read_farm", "read_soil", "read_pasture", "record_soil_samples", "record_pasture"]);
    expect(scopesAllowed("report_viewer")).toEqual([]);
    expect(scopesAllowed("sales_rep")).toEqual([]);
    expect(effectiveScopes(["read_soil", "record_soil_samples"], "viewer")).toEqual(["read_soil"]);
  });

  it("FA1 scopes are checked, de-duplicated and put in order", () => {
    expect(parseScopes(["record_pasture", "read_farm", "read_farm"])).toEqual(["read_farm", "record_pasture"]);
    expect(() => parseScopes([])).toThrow("at least one");
    expect(() => parseScopes(["read_books"])).toThrow("scopes must be from");
  });

  it("FA7 only a bearer header shaped like an app key counts", () => {
    const key = `tohyee_app_${"a".repeat(43)}`;
    expect(bearerFarmAppKey(`Bearer ${key}`)).toBe(key);
    expect(bearerFarmAppKey(`Bearer tohyee_ai_${"a".repeat(43)}`)).toBeNull();
    expect(bearerFarmAppKey(null)).toBeNull();
  });
});
