import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill } from "@/lib/bills/service";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import {
  createPlan,
  getPlanReport,
  importApplications,
  linkableBillLines,
  linkPurchase,
  linkSpreading,
  listPlans,
  listProducts,
  previewApplicationImport,
  recordApplication,
  removeApplication,
  savePlanVersion,
  saveProduct,
  unlinkSpreading,
} from "@/lib/farming/fertiliser";
import { addPaddock, saveFarm, setFarmingEnabled, splitPaddock } from "@/lib/farming/paddocks";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/** Farming stage 2: fertiliser plans, purchases, applications and spreading (#249, FB1-FB8). Each test gets its own organisation. */
describeWithDatabase("fertiliser planner", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("fertiliser-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `fert-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    const farm = (await as((tx) => saveFarm(tx, { name: "Kōwhai Dairies home block" })))[0];
    const twelve = await as((tx) => addPaddock(tx, { farmId: farm.id, name: "12", effectiveHa: "20.0", onDate: "2026-07-01" }));
    const fourteen = await as((tx) => addPaddock(tx, { farmId: farm.id, name: "14", effectiveHa: "15.0", onDate: "2026-07-01" }));
    const urea = (await as((tx) => saveProduct(tx, { name: "Urea", nPct: "46" })))[0];
    const journals = async () => Number((await as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n);
    const bill = (supplier: string, description: string, quantity: string, unitPrice: string, accountCode: string) =>
      as(async (tx) => {
        const contact = (await createContact(tx, { idempotencyKey: key("contact"), name: supplier, isSupplier: true })).contact;
        const drafted = await createBill(tx, {
          idempotencyKey: key("bill"),
          contactId: contact.id,
          billDate: "2026-09-01",
          dueDate: "2026-09-20",
          supplierInvoiceNumber: key("inv"),
          amountsMode: "exclusive",
          lines: [{ description, quantity, unitPrice, accountCode, taxCode: "GST" }],
        });
        return (await approveBill(tx, drafted.bill.id, { idempotencyKey: key("approve") })).bill;
      });
    const lineFor = async (description: string) => (await as((tx) => linkableBillLines(tx))).find((line) => line.description === description)!;
    return { as, farm, twelve, fourteen, urea, journals, bill, lineFor };
  }

  it("turning Farming on adds 6310 Fertiliser and lime and 6320 Fertiliser spreading", async () => {
    const w = await setup();
    const accounts = await w.as((tx) => tx.query<{ code: string; name: string; account_class: string }>("select code, name, account_class from accounts where code in ('6310', '6320') order by code"));
    expect(accounts.rows).toEqual([
      { code: "6310", name: "Fertiliser and lime", account_class: "expense" },
      { code: "6320", name: "Fertiliser spreading", account_class: "expense" },
    ]);
    // Turning it off and on again doesn't add them twice.
    await w.as((tx) => setFarmingEnabled(tx, { enabled: false }));
    await w.as((tx) => setFarmingEnabled(tx, { enabled: true }));
    expect((await w.as((tx) => tx.query("select 1 from accounts where code in ('6310', '6320')"))).rowCount).toBe(2);
    expect((await w.as((tx) => listProducts(tx))).map((product) => [product.name, product.nPct])).toEqual([["Urea", "46.00"]]);
    await expect(w.as((tx) => saveProduct(tx, { name: "Too much", nPct: "60", pPct: "50" }))).rejects.toThrow("more than 100%");
  });

  it("FB1-FB6: a plan in two versions, a bill, two applications and spreading, planned against actual", async () => {
    const w = await setup();
    const before = await w.journals();
    const plan = await w.as((tx) => createPlan(tx, { farmId: w.farm.id, name: "Spring urea 2026" }));

    // FB2 version 1: treated hectares default to the effective area (FB1).
    const v1 = await w.as((tx) =>
      savePlanVersion(tx, plan.id, {
        spreadingPerHa: "25.00",
        lines: [
          { paddockId: w.twelve.id, productId: w.urea.id, rateKgHa: "100", pricePerTonne: "780.00" },
          { paddockId: w.fourteen.id, productId: w.urea.id, rateKgHa: "80", pricePerTonne: "780.00" },
        ],
      }),
    );
    expect(v1.versions[0].lines.map((line) => [line.paddockName, line.treatedHa, line.tonnes, line.nKgHa, line.nKg])).toEqual([
      ["12", "20.00", "2.000", "46.0", "920.0"],
      ["14", "15.00", "1.200", "36.8", "552.0"],
    ]);
    expect(v1.versions[0].totals).toEqual({ tonnes: "3.200", nKg: "1472.0", productCost: "2496.00", spreadingCost: "875.00", total: "3371.00" });

    // FB2 version 2: paddock 14 at 100 kg/ha. Version 1 is kept.
    const v2 = await w.as((tx) =>
      savePlanVersion(tx, plan.id, {
        spreadingPerHa: "25.00",
        note: "14 up to 100 kg/ha",
        lines: [
          { paddockId: w.twelve.id, productId: w.urea.id, rateKgHa: "100", pricePerTonne: "780.00" },
          { paddockId: w.fourteen.id, productId: w.urea.id, rateKgHa: "100", pricePerTonne: "780.00" },
        ],
      }),
    );
    expect(v2.versions.map((version) => [version.version, version.totals.tonnes, version.totals.total])).toEqual([
      [2, "3.500", "3605.00"],
      [1, "3.200", "3371.00"],
    ]);
    expect((await w.as((tx) => listPlans(tx, { farmId: w.farm.id })))[0]).toMatchObject({ name: "Spring urea 2026", latestVersion: 2 });
    expect(await w.journals()).toBe(before);

    // FB3: the bill posts (expensed when bought); linking it to the plan posts nothing.
    await w.bill("Southern Fertiliser Ltd", "Urea", "3.5", "780.00", "6310");
    const afterBill = await w.journals();
    expect(afterBill).toBeGreaterThan(before);
    const ureaLine = await w.lineFor("Urea");
    expect(ureaLine).toMatchObject({ quantity: "3.500", net: "2730.00", accountCode: "6310", linked: false });
    await w.as((tx) => linkPurchase(tx, plan.id, { billLineId: ureaLine.id, productId: w.urea.id }));
    await expect(w.as((tx) => linkPurchase(tx, plan.id, { billLineId: ureaLine.id, productId: w.urea.id }))).rejects.toThrow("already linked");
    expect((await w.lineFor("Urea")).linked).toBe(true);

    // FB4: applications, costed at the bill's average price.
    await w.as((tx) => recordApplication(tx, plan.id, { paddockId: w.twelve.id, productId: w.urea.id, appliedOn: "2026-09-12", tonnes: "2.0" }));
    const applied = await w.as((tx) => recordApplication(tx, plan.id, { paddockId: w.fourteen.id, productId: w.urea.id, appliedOn: "2026-09-15", tonnes: "1.4" }));
    expect(applied.applications.map((app) => [app.paddockName, app.kgHa, app.nKgHa, app.productCost, app.quoted])).toEqual([
      ["12", "100.0", "46.0", "1560.00", false],
      ["14", "93.3", "42.9", "1092.00", false],
    ]);
    expect(applied.products).toEqual([
      expect.objectContaining({ productName: "Urea", plannedTonnes: "3.500", boughtTonnes: "3.500", appliedTonnes: "3.400", plannedCost: "2730.00", expensed: "2730.00", appliedCost: "2652.00", notYetApplied: "78.00", notYetAppliedTonnes: "0.100" }),
    ]);
    expect(applied.warnings).toEqual([]);

    // FB5: spreading posts once and is shared by hectares for reports.
    await w.bill("Clutha Spreading Ltd", "Spreading 35 ha", "35", "25.00", "6320");
    const afterSpreading = await w.journals();
    const spreadLine = await w.lineFor("Spreading 35 ha");
    expect(spreadLine).toMatchObject({ net: "875.00", accountCode: "6320" });
    const report = await w.as((tx) => linkSpreading(tx, plan.id, { billLineId: spreadLine.id, applicationIds: applied.applications.map((app) => app.id) }));
    expect(report.applications.map((app) => app.spreadingCost)).toEqual(["500.00", "375.00"]);
    expect(report.spreadingTotals).toEqual({ planned: "875.00", actual: "875.00" });

    // FB6: plan against actual.
    expect(report.paddocks.map((p) => [p.paddockName, p.plannedNKgHa, p.actualNKgHa, p.plannedCost, p.actualCost, p.actualPerHa])).toEqual([
      ["12", "46.0", "46.0", "2060.00", "2060.00", "103.00"],
      ["14", "46.0", "42.9", "1545.00", "1467.00", "97.80"],
    ]);
    expect(report.purchases).toEqual([expect.objectContaining({ productName: "Urea", tonnes: "3.500", net: "2730.00", supplier: "Southern Fertiliser Ltd", voided: false })]);
    expect(await w.journals()).toBe(afterSpreading);
    expect(afterSpreading - afterBill).toBe(afterBill - before);

    // FB7: splitting 14 keeps the application on 14 with its cost.
    await w.as((tx) =>
      splitPaddock(tx, w.fourteen.id, {
        onDate: "2026-11-01",
        parts: [
          { name: "14A", effectiveHa: "9.0" },
          { name: "14B", effectiveHa: "6.0" },
        ],
      }),
    );
    const later = await w.as((tx) => getPlanReport(tx, plan.id));
    expect(later.paddocks.find((p) => p.paddockName === "14")).toMatchObject({ actualCost: "1467.00", actualPerHa: "97.80" });
    expect(later.paddocks.map((p) => p.paddockName)).toEqual(["12", "14"]);
    expect(later.applications.find((app) => app.paddockName === "14")).toMatchObject({ treatedHa: "15.00", tonnes: "1.400" });

    // An application a spreading bill covers can't be removed until the spreading is unlinked,
    // so its share never moves onto another paddock without anyone choosing that.
    await expect(w.as((tx) => removeApplication(tx, later.applications[1].id))).rejects.toThrow("Unlink the spreading first.");
    await w.as((tx) => unlinkSpreading(tx, plan.id, { billLineId: spreadLine.id }));
    const removed = await w.as((tx) => removeApplication(tx, later.applications[1].id));
    expect(removed.applications.map((app) => [app.paddockName, app.spreadingCost])).toEqual([["12", "0.00"]]);
    expect(removed.spreading).toEqual([]);
    expect(await w.journals()).toBe(afterSpreading);
  });

  it("FB8: more applied than bought warns and uses the quoted price; the same file twice adds nothing", async () => {
    const w = await setup();
    const plan = await w.as((tx) => createPlan(tx, { farmId: w.farm.id, name: "Autumn urea 2027" }));
    await w.as((tx) =>
      savePlanVersion(tx, plan.id, {
        lines: [
          { paddockId: w.twelve.id, productId: w.urea.id, rateKgHa: "100", pricePerTonne: "800.00" },
          { paddockId: w.fourteen.id, productId: w.urea.id, rateKgHa: "100", pricePerTonne: "800.00" },
        ],
      }),
    );
    await w.bill("Southern Fertiliser Ltd", "Urea 2t", "2", "780.00", "6310");
    const line = await w.lineFor("Urea 2t");
    await w.as((tx) => linkPurchase(tx, plan.id, { billLineId: line.id, productId: w.urea.id }));
    const before = await w.journals();

    const csv = "Paddock,Product,Date,Tonnes\n12,Urea,2027-03-01,2.0\n14,urea,2027-03-02,1.5\n99,Urea,2027-03-02,1\n";
    const preview = await w.as((tx) => previewApplicationImport(tx, plan.id, { fileName: "spreader.csv", content: csv }));
    expect(preview).toMatchObject({ valid: 2, errors: 1, alreadyImportedOn: null });
    expect(preview.rows[2].error).toBe("There's no current paddock 99 on this farm.");
    expect((await w.as((tx) => getPlanReport(tx, plan.id))).applications).toHaveLength(0);

    const report = await w.as((tx) => importApplications(tx, plan.id, { fileName: "spreader.csv", content: csv }));
    expect(report.applications.map((app) => [app.paddockName, app.productCost, app.quoted, app.source])).toEqual([
      ["12", "1560.00", false, "Imported from spreader.csv"],
      ["14", "1200.00", true, "Imported from spreader.csv"],
    ]);
    expect(report.warnings).toEqual(["1.500 t more Urea was applied than the linked bills bought. It may have come from earlier purchases; it's costed at the quoted price."]);
    await expect(w.as((tx) => importApplications(tx, plan.id, { fileName: "again.csv", content: csv }))).rejects.toThrow("already imported");
    expect((await w.as((tx) => getPlanReport(tx, plan.id))).applications).toHaveLength(2);
    expect(await w.journals()).toBe(before);

    // A draft bill can't be linked.
    await expect(
      w.as(async (tx) => {
        const contact = (await createContact(tx, { idempotencyKey: key("contact"), name: "Draft Fert", isSupplier: true })).contact;
        const drafted = await createBill(tx, {
          idempotencyKey: key("bill"),
          contactId: contact.id,
          billDate: "2027-03-01",
          dueDate: "2027-03-20",
          amountsMode: "exclusive",
          lines: [{ description: "Draft urea", quantity: "1", unitPrice: "780.00", accountCode: "6310", taxCode: "GST" }],
        });
        const row = await tx.query<{ id: string }>("select id::text from bill_lines where bill_id = $1", [drafted.bill.id]);
        return linkPurchase(tx, plan.id, { billLineId: row.rows[0].id, productId: w.urea.id });
      }),
    ).rejects.toThrow("Only lines of approved bills");
  });
});
