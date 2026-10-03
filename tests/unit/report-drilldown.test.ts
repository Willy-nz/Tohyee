import { describe, expect, it } from "vitest";
import { accountTransactionsHref } from "@/lib/reports/drilldown";

describe("account transaction drill-down", () => {
  it("keeps the account, period, basis, and tracking filter in the report URL", () => {
    const href = accountTransactionsHref({
      accountId: "42",
      from: "2026-04-01",
      to: "2026-06-30",
      basis: "accrual",
      trackingCategoryId: "8",
      trackingValueId: "13",
    });

    expect(href).toBe(
      "/operations/reports?report=transactions&account=42&from=2026-04-01&to=2026-06-30&basis=accrual&trackingCategoryId=8&trackingValueId=13",
    );
  });

  it("does not emit an incomplete or empty tracking filter", () => {
    const href = accountTransactionsHref({ accountId: "42", from: null, to: "2026-06-30" });

    expect(href).toBe("/operations/reports?report=transactions&account=42&to=2026-06-30");
  });
});
