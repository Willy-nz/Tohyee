import { afterAll, beforeAll, expect, it } from "vitest";
import * as ir10Route from "@/app/api/income-tax/ir10/route";
import { createAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { runDepreciation } from "@/lib/fixed-assets/runs";
import { createFixedAsset, createFixedAssetType } from "@/lib/fixed-assets/service";
import { postJournal } from "@/lib/ledger/journals";
import { setTaxDetails } from "@/lib/tax/income/assets";
import { listIr10Accounts, setIr10Account } from "@/lib/tax/income/ir10";
import { buildIncomeTax, getIncomeTaxSettings, saveIncomeTaxYear, setAccountTreatment, updateIncomeTaxSettings } from "@/lib/tax/income/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const noContext = undefined as unknown;

/** The IR10 from the books (ITX19-ITX24; from IRD's IR10 and IR10G, not yet reviewed). */
describeWithDatabase("income tax: the IR10 financial statements summary", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  const org = "ir10-co";
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
  const journal = (date: string, lines: Array<{ accountCode: string; debitAmount?: string; creditAmount?: string }>) =>
    as((tx) => postJournal(tx, { idempotencyKey: key("j"), postingDate: date, reference: "Test", lines }));
  const accountId = async (code: string) => (await as((tx) => tx.query<{ id: string }>("select id::text from accounts where code = $1", [code]))).rows[0].id;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("ir10-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("ir10-bookkeeper@example.com");
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [org, bookkeeper.id]);
    const settings = await as((tx) => getIncomeTaxSettings(tx));
    await as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "company", agentExtension: false, version: settings.version }));
    await as((tx) => createAccount(tx, { code: "1410", name: "Stock on hand", accountType: "inventory" }));
    await as(async (tx) => setAccountTreatment(tx, { accountId: await accountId("6050"), treatment: "entertainment_50" }));
    // Opening: bank 50,000.00 and stock 10,000.00 from the owner.
    await journal("2025-03-31", [{ accountCode: "1000", debitAmount: "50000.00" }, { accountCode: "1410", debitAmount: "10000.00" }, { accountCode: "3000", creditAmount: "60000.00" }]);
    await journal("2025-06-30", [{ accountCode: "1100", debitAmount: "30000.00" }, { accountCode: "1000", debitAmount: "170000.00" }, { accountCode: "4000", creditAmount: "200000.00" }]);
    await journal("2025-07-31", [{ accountCode: "1000", debitAmount: "500.00" }, { accountCode: "4200", creditAmount: "500.00" }]);
    await journal("2025-08-31", [{ accountCode: "1410", debitAmount: "90000.00" }, { accountCode: "1000", creditAmount: "90000.00" }]);
    await journal("2026-03-31", [{ accountCode: "5100", debitAmount: "85000.00" }, { accountCode: "1410", creditAmount: "85000.00" }]);
    await journal("2025-09-30", [
      { accountCode: "6080", debitAmount: "2000.00" },
      { accountCode: "6200", debitAmount: "40000.00" },
      { accountCode: "6050", debitAmount: "1000.00" },
      { accountCode: "6070", debitAmount: "3000.00" },
      { accountCode: "1000", creditAmount: "46000.00" },
    ]);
    await journal("2025-10-31", [{ accountCode: "3100", debitAmount: "5000.00" }, { accountCode: "1000", creditAmount: "5000.00" }]);
    // A new van for 30,000.00 on a term loan, 20% SL in the books; 30% DV with Investment Boost for tax.
    await journal("2025-07-01", [{ accountCode: "1640", debitAmount: "30000.00" }, { accountCode: "2800", creditAmount: "30000.00" }]);
    const type = (
      await as((tx) =>
        createFixedAssetType(tx, { idempotencyKey: key("type"), name: "Vehicles", assetAccountCode: "1640", accumulatedDepreciationAccountCode: "1650", depreciationExpenseAccountCode: "6300", method: "sl", rate: "20" }),
      )
    ).type;
    const van = (await as((tx) => createFixedAsset(tx, { idempotencyKey: key("asset"), name: "Van", typeId: type.id, purchaseDate: "2025-07-01", cost: "30000.00" }))).asset;
    await as((tx) => runDepreciation(tx, { idempotencyKey: key("run"), periodEnd: "2026-03-31" }));
    await as((tx) => setTaxDetails(tx, van.id, { method: "dv", rate: "30", newAsset: true, investmentBoost: true, version: 0 }));
  }, 300_000);

  afterAll(async () => {
    await server?.teardown();
  });

  it("ITX19 accounts get boxes and roles, by default or as chosen", async () => {
    const accounts = await as((tx) => listIr10Accounts(tx));
    const of = (code: string) => accounts.find((account) => account.code === code)!;
    expect([of("4000").box, of("4200").box, of("6200").box, of("1640").box, of("1650").box, of("1410").box, of("2800").box]).toEqual([2, 7, 22, 33, 33, 32, 49]);
    expect(of("3100").role).toBe("drawings");
    await expect(as(async (tx) => setIr10Account(tx, { accountId: await accountId("6070"), box: 2 }))).rejects.toThrow("can go in IR10 box 12");
    await expect(as(async (tx) => setIr10Account(tx, { accountId: await accountId("6070"), box: 24, role: "drawings" }))).rejects.toThrow("can't be marked");
    const cookie = await sessionCookieFor(bookkeeper);
    const refused = await ir10Route.GET(apiRequest(`/api/income-tax/ir10?organisationId=${org}`, { cookie }), noContext);
    expect(refused.status).toBe(403);
  });

  it("ITX20-ITX23 the 2026 IR10 from the books", async () => {
    await as((tx) => saveIncomeTaxYear(tx, { incomeYear: 2026, multipleActivity: false, version: 0 }));
    const report = await as((tx) => buildIncomeTax(tx, { incomeYear: 2026, today: "2026-10-16" }));
    expect(report.supported).toBe(true);
    if (!report.supported) return;
    const ir10 = report.ir10!;
    expect(ir10).not.toBeNull();
    const boxes = (numbers: number[]) => numbers.map((number) => ir10.boxes[number]);
    expect(ir10.boxes[1]).toBe("No");
    expect(boxes([2, 3, 4, 5, 6, 7, 11])).toEqual(["200000.00", "10000.00", "90000.00", "15000.00", "115000.00", "500.00", "115500.00"]);
    expect(boxes([13, 14, 22, 24, 25, 26, 27])).toEqual(["4500.00", "2000.00", "40000.00", "4000.00", "50500.00", null, "65000.00"]);
    expect(boxes([28, 29])).toEqual(["-6400.00", "58600.00"]);
    expect(boxes([30, 31, 32, 33, 43, 49, 50, 51])).toEqual(["30000.00", "79500.00", "15000.00", "25500.00", "150000.00", "30000.00", "30000.00", "120000.00"]);
    expect(boxes([52, 53, 54, 55, 57, 59, 60])).toEqual(["11400.00", null, "30000.00", null, "5000.00", null, "30000.00"]);
    expect(ir10.checks.every((check) => check.ok)).toBe(true);
    // Not shown until the year has ended.
    const current = await as((tx) => buildIncomeTax(tx, { incomeYear: 2027, today: "2026-10-16" }));
    expect(current.supported && current.ir10).toBeNull();
  });

  it("ITX19 choosing a box moves the amount", async () => {
    await as(async (tx) => setIr10Account(tx, { accountId: await accountId("6070"), box: 16 }));
    const report = await as((tx) => buildIncomeTax(tx, { incomeYear: 2026, today: "2026-10-16" }));
    expect(report.supported && [report.ir10!.boxes[16], report.ir10!.boxes[24], report.ir10!.boxes[25]]).toEqual(["3000.00", "1000.00", "50500.00"]);
    const audit = await as((tx) => tx.query<{ n: string }>("select count(*)::text as n from audit_events where event_type = 'income_tax.ir10_account_set'"));
    expect(audit.rows[0].n).toBe("1");
  });
});
