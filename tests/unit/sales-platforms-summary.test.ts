import { describe, expect, it } from "vitest";
import { integrationsSummary } from "@/lib/sales-platforms/summary";
import type { SalesPlatformConnection } from "@/lib/sales-platforms/types";

const store = (status: SalesPlatformConnection["status"]) => ({ id: status, status }) as SalesPlatformConnection;

/** What CRM Home says about Shopify (#342, decision 582). Made-up connections. */
describe("CRM Home's sales platforms card", () => {
  it("asks an admin to connect Shopify when no store is connected", () => {
    expect(integrationsSummary([], true)).toEqual({ kind: "connect" });
    expect(integrationsSummary([store("disconnected")], true)).toEqual({ kind: "connect" });
  });

  it("says nothing to someone who can't connect a store", () => {
    expect(integrationsSummary([], false)).toBeNull();
  });

  it("lists connected and paused stores, leaving out disconnected ones", () => {
    const summary = integrationsSummary([store("active"), store("disconnected"), store("paused")], false);
    expect(summary?.kind).toBe("stores");
    expect(summary && summary.kind === "stores" ? summary.connections.map((connection) => connection.status) : []).toEqual(["active", "paused"]);
  });
});
