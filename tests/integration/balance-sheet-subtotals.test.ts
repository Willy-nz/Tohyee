import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { postJournal } from "@/lib/ledger/journals";
import { balanceSheet } from "@/lib/reports/financial";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/** Current and non-current subtotals on the balance sheet (#259). */
describeWithDatabase("balance sheet current and non-current subtotals", () => {
  let server: TestServer;
  let owner: SessionUser;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("bs-terms-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("P4: current 4,500 + non-current 2,000 assets; current 200 + non-current 1,500 liabilities; net assets 4,800 = equity", async () => {
    await createTestOrganisation(owner, "bs-terms-co");
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation("bs-terms-co", { userId: owner.id, email: owner.email }, work);
    const journal = (postingDate: string, debit: string, credit: string, amount: string) =>
      as((tx) =>
        postJournal(tx, {
          idempotencyKey: key("journal"),
          postingDate,
          reference: "P4",
          lines: [
            { accountCode: debit, debitAmount: amount, creditAmount: "0" },
            { accountCode: credit, debitAmount: "0", creditAmount: amount },
          ],
        }),
      );
    await journal("2026-05-01", "1000", "3000", "5000.00");
    await journal("2026-05-05", "1620", "1000", "2000.00");
    await journal("2026-05-10", "1000", "2800", "1500.00");
    await journal("2026-05-20", "6010", "2400", "200.00");

    const bs = await as((tx) => balanceSheet(tx, { asAt: "2026-05-31" }));
    expect(bs.assets.current.total).toBe("4500.00");
    expect(bs.assets.current.sections.map((section) => section.key)).toEqual(["bank"]);
    expect(bs.assets.nonCurrent.total).toBe("2000.00");
    expect(bs.assets.nonCurrent.sections.map((section) => section.key)).toEqual(["fixed_asset"]);
    expect(bs.assets.total).toBe("6500.00");
    expect(bs.liabilities.current.total).toBe("200.00");
    expect(bs.liabilities.current.sections.map((section) => section.key)).toEqual(["credit_card"]);
    expect(bs.liabilities.nonCurrent.total).toBe("1500.00");
    expect(bs.liabilities.total).toBe("1700.00");
    expect(bs.netAssets).toBe("4800.00");
    expect(bs.equity.total).toBe("4800.00");
    expect(bs.balanced).toBe(true);
    // The flat list is still there, current first, for anything that reads it.
    expect(bs.assets.sections.map((section) => section.key)).toEqual(["bank", "fixed_asset"]);
  });
});
