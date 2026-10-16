import { afterAll, beforeAll, expect, it } from "vitest";
import * as assetRoute from "@/app/api/income-tax/assets/[assetId]/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { disposeFixedAsset, runDepreciation } from "@/lib/fixed-assets/runs";
import { createFixedAsset, createFixedAssetType } from "@/lib/fixed-assets/service";
import { postJournal } from "@/lib/ledger/journals";
import { listTaxAssets, setTaxDetails } from "@/lib/tax/income/assets";
import { buildIncomeTax, getIncomeTaxSettings, updateIncomeTaxSettings } from "@/lib/tax/income/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

/** Tax depreciation and Investment Boost (ITX11-ITX18; from IRD's published rules, not yet reviewed). */
describeWithDatabase("income tax: tax depreciation and Investment Boost", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  const org = "tax-depreciation-co";
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
  let machineId = "";
  let deskId = "";

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("taxdep-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("taxdep-bookkeeper@example.com");
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [org, bookkeeper.id]);
    const settings = await as((tx) => getIncomeTaxSettings(tx));
    await as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "company", agentExtension: false, version: settings.version }));
    const type = (
      await as((tx) =>
        createFixedAssetType(tx, { idempotencyKey: key("type"), name: "Plant", assetAccountCode: "1640", accumulatedDepreciationAccountCode: "1650", depreciationExpenseAccountCode: "6300", method: "sl", rate: "20" }),
      )
    ).type;
    // Bought for 100,000.00 on 1 June 2025; a desk bought in 2024 has no tax details.
    await as((tx) => postJournal(tx, { idempotencyKey: key("j"), postingDate: "2025-06-01", reference: "Machine", lines: [{ accountCode: "1640", debitAmount: "100000.00" }, { accountCode: "1000", creditAmount: "100000.00" }] }));
    await as((tx) => postJournal(tx, { idempotencyKey: key("j"), postingDate: "2025-08-30", reference: "Sales", lines: [{ accountCode: "1000", debitAmount: "100000.00" }, { accountCode: "4000", creditAmount: "100000.00" }] }));
    machineId = (await as((tx) => createFixedAsset(tx, { idempotencyKey: key("asset"), name: "Machine", typeId: type.id, purchaseDate: "2025-06-01", cost: "100000.00" }))).asset.id;
    deskId = (await as((tx) => createFixedAsset(tx, { idempotencyKey: key("asset"), name: "Desk", typeId: type.id, purchaseDate: "2024-08-01", cost: "800.00" }))).asset.id;
    await as((tx) => runDepreciation(tx, { idempotencyKey: key("run"), periodEnd: "2026-03-31" }));
  }, 300_000);

  afterAll(async () => {
    await server?.teardown();
  });

  it("ITX11, ITX14 refuses what IRD doesn't allow", async () => {
    await expect(as((tx) => setTaxDetails(tx, deskId, { method: "sl", rate: "20", newAsset: true, investmentBoost: true, version: 0 }))).rejects.toThrow("on or after 22 May 2025");
    await expect(as((tx) => setTaxDetails(tx, machineId, { method: "sl", rate: "20", investmentBoost: true, version: 0 }))).rejects.toThrow("tick that it's new");
    await expect(as((tx) => setTaxDetails(tx, machineId, { method: "low_value", version: 0 }))).rejects.toThrow("1,000.00 or less");
    await expect(as((tx) => setTaxDetails(tx, machineId, { method: "low_value", newAsset: true, investmentBoost: true, version: 0 }))).rejects.toThrow("Investment Boost is only for assets depreciated");
    await expect(as((tx) => setTaxDetails(tx, machineId, { method: "dv", version: 0 }))).rejects.toThrow("rate");
    // Only owners and admins, through the API.
    const cookie = await sessionCookieFor(bookkeeper);
    const refused = await assetRoute.PUT(
      apiRequest(`/api/income-tax/assets/${machineId}`, { method: "PUT", cookie, body: { organisationId: org, method: "sl", rate: "20", version: 0 } }),
      params({ assetId: machineId }),
    );
    expect(refused.status).toBe(403);
  });

  it("ITX14, ITX18 Investment Boost replaces book depreciation in the 2026 workpaper", async () => {
    const saved = await as((tx) => setTaxDetails(tx, machineId, { method: "sl", rate: "20", newAsset: true, investmentBoost: true, version: 0 }));
    expect(saved.details).toMatchObject({ method: "sl", rate: "20", taxCost: "100000.00", businessUsePercent: "100", availableOn: "2025-06-01", investmentBoost: true, version: 1 });
    await expect(as((tx) => setTaxDetails(tx, machineId, { method: "sl", rate: "20", version: 0 }))).rejects.toThrow("Someone else changed");

    const report = await as((tx) => buildIncomeTax(tx, { incomeYear: 2026, today: "2026-10-16" }));
    expect(report.supported).toBe(true);
    if (!report.supported) return;
    // The desk (no tax details) keeps its book depreciation: 266.67 for August 2024 to March 2026, posted by the same run.
    expect(report.workpaper.netProfit).toBe("83066.66");
    expect(report.workpaper.adjustments.map((entry) => [entry.description, entry.amount])).toEqual([
      ["Book depreciation on assets with tax details, added back", "16666.67"],
      ["Investment Boost", "-20000.00"],
      ["Tax depreciation", "-13333.33"],
    ]);
    expect(report.workpaper.taxableIncome).toBe("66400.00");
    expect(report.taxAssets.find((asset) => asset.assetId === machineId)?.year).toMatchObject({ months: 10, investmentBoost: "20000.00", depreciation: "13333.33", closingAtv: "66666.67" });
    expect(report.notes.join(" ")).toContain("FA-0002 Desk");
    const audit = await as((tx) => tx.query<{ n: string }>("select count(*)::text as n from audit_events where event_type = 'income_tax.asset_details_set'"));
    expect(audit.rows[0].n).toBe("1");
  });

  it("ITX14, ITX17, ITX18 a sale: no tax depreciation that year, and depreciation recovered replaces the book gain", async () => {
    await as((tx) => postJournal(tx, { idempotencyKey: key("j"), postingDate: "2026-09-30", reference: "Sold", lines: [{ accountCode: "1000", debitAmount: "80000.00" }, { accountCode: "1640", creditAmount: "80000.00" }] }));
    await as((tx) => disposeFixedAsset(tx, machineId, { idempotencyKey: key("dispose"), disposalDate: "2026-09-30", proceeds: "80000.00", proceedsAccountCode: "1640" }));

    const report = await as((tx) => buildIncomeTax(tx, { incomeYear: 2027, today: "2026-10-16" }));
    expect(report.supported).toBe(true);
    if (!report.supported) return;
    // Book: April to August 2026 depreciation (8,333.33), book value 75,000.00, so a 5,000.00 gain;
    // tax: no depreciation in the year of sale, ATV 66,666.67, so 13,333.33 recovered (at most cost less ATV).
    expect(report.workpaper.adjustments.map((entry) => [entry.description, entry.amount])).toEqual([
      ["Book depreciation on assets with tax details, added back", "8333.33"],
      ["Book gains and losses on their disposal, reversed", "-5000.00"],
      ["Depreciation recovered (tax)", "13333.33"],
    ]);
    expect(report.workpaper.netProfit).toBe("-3333.33");
    expect(report.workpaper.taxableIncome).toBe("13333.33");
    const assets = await as((tx) => listTaxAssets(tx, 2027));
    expect(assets.find((asset) => asset.assetId === machineId)?.year).toMatchObject({ openingAtv: "66666.67", depreciation: "0.00", recovered: "13333.33", disposed: true });
  });
});
