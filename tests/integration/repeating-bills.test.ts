import { afterAll, beforeAll, expect, it } from "vitest";
import * as runRoute from "@/app/api/repeating-bills/[repeatingBillId]/run/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill, deleteBill, getBill, listBills } from "@/lib/bills/service";
import { archiveContact, createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { inventoryValuation } from "@/lib/reports/financial";
import { createItem, updateItem } from "@/lib/items/service";
import { getJournal } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { getOrganisation } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import {
  createRepeatingBill,
  getRepeatingBill,
  repeatingForBill,
  runRepeatingBills,
  setRepeatingBillStatus,
  updateRepeatingBill,
} from "@/lib/repeating/bills";
import { runOrganisationRepeatingBills } from "@/lib/repeating/scheduler";
import { createTrackingValue, getTrackingSetup } from "@/lib/tracking/service";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  params,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

/** Examples RB1-RB10 in docs/ACCOUNTING-EXAMPLES.md ("Repeating bills"). Each test gets its own organisation. */
describeWithDatabase("repeating bills", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("repeating-bills-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("repeating-bills-viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const RENT = { description: "Office rent", quantity: "1", unitPrice: "1000.00", accountCode: "6150", taxCode: "GST" };

  async function setup() {
    organisations += 1;
    const org = `rbill-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const job = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: null, email: "repeating-bills@tohyee" }, work);
    const harbour = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Property Ltd", isSupplier: true }))).contact;
    const template = async (extra: Record<string, unknown> = {}) =>
      (
        await as((tx) =>
          createRepeatingBill(tx, {
            idempotencyKey: key("rb"),
            contactId: harbour.id,
            supplierInvoiceNumber: "RENT-{month}",
            amountsMode: "exclusive",
            lines: [RENT],
            period: "month",
            every: 1,
            startDate: "2026-01-31",
            dueRule: "day_of_next_month",
            dueDays: 20,
            saveAs: "draft",
            ...extra,
          }),
        )
      ).repeatingBill;
    const run = (today: string, id?: string) => job((tx) => runRepeatingBills(tx, { today, repeatingBillId: id }));
    const bills = async () =>
      (await as((tx) => listBills(tx, {}))).bills.map((b) => [b.billDate, b.dueDate, b.status, b.supplierInvoiceNumber, b.total]).reverse();
    const journal = async (journalId: string) => {
      const found = await as((tx) => getJournal(tx, journalId));
      return [found.postingDate, ...found.lines.map((l) => [l.accountCode, l.debitAmount, l.creditAmount])];
    };
    return { org, as, harbour, template, run, bills, journal };
  }

  it("RB1: saving a template posts nothing; the number pattern, supplier and due day are checked", async () => {
    const w = await setup();
    const template = await w.template();
    expect([template.status, template.nextDate, template.nextSupplierInvoiceNumber, template.total, template.runs]).toEqual([
      "active",
      "2026-01-31",
      "RENT-2026-01",
      "1150.00",
      [],
    ]);
    expect((await w.as((tx) => tx.query("select 1 from bills"))).rowCount).toBe(0);
    expect((await w.as((tx) => tx.query("select 1 from ledger_journals"))).rowCount).toBe(0);
    await expect(w.template({ supplierInvoiceNumber: "RENT" })).rejects.toThrow("needs {date} or {n} (or {month})");
    await expect(w.template({ period: "week" })).rejects.toThrow("needs {date} or {n} in it");
    await expect(w.template({ dueDays: 0 })).rejects.toThrow("dueDays must be a whole number from 1 to 31");
    const cafe = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Cafe", isCustomer: true }))).contact;
    await expect(w.template({ contactId: cafe.id })).rejects.toThrow("isn't marked as a supplier");
    await expect(w.as((tx) => tx.query("delete from repeating_bills where id = $1", [template.id]))).rejects.toThrow("can't be deleted");
  });

  it("RB2: saved as drafts, a run makes each missed month in order with its number and due date", async () => {
    const w = await setup();
    const template = await w.template();
    expect(await w.run("2026-03-05")).toEqual({ made: 2, approved: 0, refused: 0, failed: 0 });
    expect(await w.bills()).toEqual([
      ["2026-01-31", "2026-02-20", "draft", "RENT-2026-01", "1150.00"],
      ["2026-02-28", "2026-03-20", "draft", "RENT-2026-02", "1150.00"],
    ]);
    const after = await w.as((tx) => getRepeatingBill(tx, template.id));
    expect(after.runs.map((r) => [r.scheduledDate, r.outcome, r.supplierInvoiceNumber, r.billStatus])).toEqual([
      ["2026-02-28", "draft", "RENT-2026-02", "draft"],
      ["2026-01-31", "draft", "RENT-2026-01", "draft"],
    ]);
    expect([after.nextDate, after.nextSupplierInvoiceNumber]).toEqual(["2026-03-31", "RENT-2026-03"]);
    expect(await w.as((tx) => repeatingForBill(tx, after.runs[1].billId!))).toEqual({ id: template.id, scheduledDate: "2026-01-31" });
    const bill = await w.as((tx) => getBill(tx, after.runs[1].billId!));
    expect(bill.lines.map((l) => [l.description, l.accountCode, l.taxCode, l.lineAmount, l.taxAmount])).toEqual([["Office rent", "6150", "GST", "1000.00", "150.00"]]);
    expect((await w.as((tx) => tx.query("select 1 from ledger_journals"))).rowCount).toBe(0);
  });

  it("RB3: {n} and {date} numbers with due dates N days after the bill date or the end of its month", async () => {
    const w = await setup();
    await w.template({ supplierInvoiceNumber: "Invoice {n}", dueRule: "days_after", dueDays: 30 });
    const other = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Southern Cleaning", isSupplier: true }))).contact;
    await w.template({
      contactId: other.id,
      supplierInvoiceNumber: "SC {date}",
      dueRule: "days_after_month_end",
      dueDays: 7,
      lines: [{ description: "Cleaning", quantity: "1", unitPrice: "46.00", accountCode: "6030", taxCode: "GST" }],
      amountsMode: "inclusive",
    });
    await w.run("2026-03-05");
    expect(await w.bills()).toEqual([
      ["2026-01-31", "2026-03-02", "draft", "Invoice 1", "1150.00"],
      ["2026-02-28", "2026-03-30", "draft", "Invoice 2", "1150.00"],
      ["2026-01-31", "2026-02-07", "draft", "SC 2026-01-31", "46.00"],
      ["2026-02-28", "2026-03-07", "draft", "SC 2026-02-28", "46.00"],
    ]);
  });

  it("RB4: running twice never makes two; the hourly job runs each template on its own", async () => {
    const w = await setup();
    const good = await w.template();
    expect((await w.run("2026-03-05")).made).toBe(2);
    expect((await w.run("2026-03-05")).made).toBe(0);
    const both = await Promise.all([w.run("2026-03-31"), w.run("2026-03-31")]);
    expect(both.map((r) => r.made).sort()).toEqual([0, 1]);
    expect((await w.bills()).map((b) => b[3])).toEqual(["RENT-2026-01", "RENT-2026-02", "RENT-2026-03"]);

    const v = await setup();
    const kept = await v.template();
    const gone = (await v.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Old Landlord", isSupplier: true }))).contact;
    const stuck = await v.template({ contactId: gone.id });
    await v.as((tx) => archiveContact(tx, gone.id));
    const organisation = (await getOrganisation(v.org))!;
    expect(await runOrganisationRepeatingBills(organisation, "2026-03-05")).toEqual({ made: 2, failed: 1 });
    expect(await runOrganisationRepeatingBills(organisation, "2026-03-05")).toEqual({ made: 0, failed: 1 });
    expect((await v.as((tx) => getRepeatingBill(tx, kept.id))).runs).toHaveLength(2);
    expect((await v.as((tx) => getRepeatingBill(tx, stuck.id))).lastError).toMatch(/^2026-01-31: Old Landlord is archived/);
    expect(good.id).not.toBe(stuck.id);
  });

  it("RB5: approve automatically posts each bill on its own date, and nothing is paid", async () => {
    const w = await setup();
    await w.template({ saveAs: "approve" });
    expect(await w.run("2026-03-05")).toEqual({ made: 2, approved: 2, refused: 0, failed: 0 });
    const made = (await w.as((tx) => listBills(tx, {}))).bills.reverse();
    expect(made.map((b) => [b.billDate, b.status, b.supplierInvoiceNumber, b.amountPaid, b.amountDue, b.paidStatus])).toEqual([
      ["2026-01-31", "approved", "RENT-2026-01", "0.00", "1150.00", "unpaid"],
      ["2026-02-28", "approved", "RENT-2026-02", "0.00", "1150.00", "unpaid"],
    ]);
    expect(await w.journal(made[0].approvalJournalId!)).toEqual([
      "2026-01-31",
      ["6150", "1000.00", "0.00"],
      ["2100", "150.00", "0.00"],
      ["2000", "0.00", "1150.00"],
    ]);
    expect(await w.journal(made[1].approvalJournalId!)).toEqual([
      "2026-02-28",
      ["6150", "1000.00", "0.00"],
      ["2100", "150.00", "0.00"],
      ["2000", "0.00", "1150.00"],
    ]);
    expect((await w.as((tx) => tx.query("select 1 from supplier_payments"))).rowCount).toBe(0);
  });

  it("RB6: changing the template changes later bills only", async () => {
    const w = await setup();
    const template = await w.template();
    await w.run("2026-03-05");
    await w.as((tx) => updateRepeatingBill(tx, template.id, { lines: [{ ...RENT, unitPrice: "1050.00" }] }, "2026-03-05"));
    await w.run("2026-03-31");
    expect((await w.bills()).map((b) => [b[0], b[3], b[4]])).toEqual([
      ["2026-01-31", "RENT-2026-01", "1150.00"],
      ["2026-02-28", "RENT-2026-02", "1150.00"],
      ["2026-03-31", "RENT-2026-03", "1207.50"],
    ]);
  });

  it("RB7: stock items fill the supplier's price, need a Location, and come into stock when approved", async () => {
    const w = await setup();
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const category = (await w.as((tx) => getTrackingSetup(tx))).categories.find((c) => c.kind === "location")!.id;
    const setupAfter = await w.as((tx) => createTrackingValue(tx, { categoryId: category, name: "Dunedin" }));
    const dunedin = setupAfter.categories.find((c) => c.id === category)!.values.find((v) => v.name === "Dunedin")!.id;
    const paw = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Paw Supplies", isSupplier: true }))).contact;
    const widget = (
      await w.as((tx) =>
        createItem(tx, {
          idempotencyKey: key("item"),
          code: "WIDGET",
          name: "Widget",
          itemType: "stock",
          salePrice: "12.00",
          purchasePrice: "5.00",
          incomeAccountCode: "4000",
          salesTaxCode: "GST",
          purchaseAccountCode: "1400",
          purchaseTaxCode: "GST",
        }),
      )
    ).item;
    await w.as((tx) => updateItem(tx, widget.id, { suppliers: [{ contactId: paw.id, price: "4.80", isPreferred: true }] }));
    const stock = { contactId: paw.id, supplierInvoiceNumber: "PS-{n}", startDate: "2026-01-15", dueRule: "days_after", dueDays: 20, saveAs: "approve" };
    await expect(w.template({ ...stock, lines: [{ itemId: widget.id, quantity: "10" }] })).rejects.toThrow("WIDGET is a stock item, so it needs a Location");
    const template = await w.template({ ...stock, lines: [{ itemId: widget.id, quantity: "10", tracking: { [category]: dunedin } }] });
    expect(template.lines.map((l) => [l.description, l.unitPrice, l.accountCode, l.lineAmount])).toEqual([["Widget", "4.8", "1400", "48.00"]]);
    expect(await w.run("2026-02-20")).toEqual({ made: 2, approved: 2, refused: 0, failed: 0 });
    const made = (await w.as((tx) => listBills(tx, {}))).bills.reverse();
    expect(made.map((b) => [b.billDate, b.dueDate, b.supplierInvoiceNumber, b.total])).toEqual([
      ["2026-01-15", "2026-02-04", "PS-1", "55.20"],
      ["2026-02-15", "2026-03-07", "PS-2", "55.20"],
    ]);
    expect(await w.journal(made[1].approvalJournalId!)).toEqual(["2026-02-15", ["1400", "48.00", "0.00"], ["2100", "7.20", "0.00"], ["2000", "0.00", "55.20"]]);
    const valuation = await w.as((tx) => inventoryValuation(tx));
    expect(valuation.items.map((row) => [row.itemCode, row.locationName, row.quantity, row.value])).toEqual([["WIDGET", "Dunedin", "20", "96.00"]]);
    expect(valuation.inventoryAccountBalance).toBe("96.00");
  });

  it("RB8: pausing stops the job, resuming skips the paused dates, ending is final", async () => {
    const w = await setup();
    const template = await w.template();
    await w.run("2026-03-05");
    await w.as((tx) => setRepeatingBillStatus(tx, template.id, "paused", "2026-03-05"));
    expect((await w.run("2026-05-05")).made).toBe(0);
    const resumed = await w.as((tx) => setRepeatingBillStatus(tx, template.id, "active", "2026-05-10"));
    expect([resumed.nextDate, resumed.nextSupplierInvoiceNumber]).toEqual(["2026-05-31", "RENT-2026-05"]);
    await w.run("2026-06-01");
    expect((await w.bills()).map((b) => b[3])).toEqual(["RENT-2026-01", "RENT-2026-02", "RENT-2026-05"]);
    await w.as((tx) => setRepeatingBillStatus(tx, template.id, "ended"));
    expect((await w.run("2026-08-01")).made).toBe(0);
    await expect(w.as((tx) => setRepeatingBillStatus(tx, template.id, "active"))).rejects.toThrow("has ended");
    await expect(w.as((tx) => updateRepeatingBill(tx, template.id, { dueDays: 25 }))).rejects.toThrow("has ended");
    // Every 2 weeks until an end date: the template ends itself once every date is made.
    const fortnightly = await w.template({ period: "week", every: 2, startDate: "2026-01-05", endDate: "2026-02-02", supplierInvoiceNumber: "W{n}" });
    expect((await w.run("2026-02-10", fortnightly.id)).made).toBe(3);
    const ended = await w.as((tx) => getRepeatingBill(tx, fortnightly.id));
    expect([ended.status, ended.nextDate, ended.runs.map((r) => r.supplierInvoiceNumber)]).toEqual(["ended", null, ["W3", "W2", "W1"]]);
  });

  it("RB9: a refused approval leaves a draft; a number the supplier already has stops the run", async () => {
    const w = await setup();
    await w.as((tx) => updatePeriodControls(tx, { lockDate: "2026-01-31" }));
    const locked = await w.template({ saveAs: "approve" });
    expect(await w.run("2026-03-05")).toEqual({ made: 2, approved: 1, refused: 1, failed: 0 });
    expect((await w.bills()).map((b) => [b[0], b[2], b[3]])).toEqual([
      ["2026-01-31", "draft", "RENT-2026-01"],
      ["2026-02-28", "approved", "RENT-2026-02"],
    ]);
    const history = (await w.as((tx) => getRepeatingBill(tx, locked.id))).runs;
    expect(history[1].outcome).toBe("approval_refused");
    expect(history[1].message).toMatch(/^Left as a draft: 2026-01-31 is in a locked period/);

    const v = await setup();
    const typed = await v.as((tx) =>
      createBill(tx, {
        idempotencyKey: key("b"),
        contactId: v.harbour.id,
        billDate: "2026-01-31",
        dueDate: "2026-02-20",
        supplierInvoiceNumber: "rent-2026-01",
        amountsMode: "exclusive",
        lines: [RENT],
      }),
    );
    const clash = await v.template({ saveAs: "approve" });
    expect(await v.run("2026-03-05")).toEqual({ made: 0, approved: 0, refused: 0, failed: 1 });
    const stopped = await v.as((tx) => getRepeatingBill(tx, clash.id));
    expect(stopped.lastError).toMatch(/^2026-01-31: Harbour Property Ltd already has a bill with the invoice number rent-2026-01/);
    expect(stopped.nextDate).toBe("2026-01-31");
    // Once the bill typed by hand is gone (it was the same bill), the next run makes both.
    await v.as((tx) => deleteBill(tx, typed.bill.id));
    expect(await v.run("2026-03-05")).toEqual({ made: 2, approved: 2, refused: 0, failed: 0 });
    expect((await v.as((tx) => getRepeatingBill(tx, clash.id))).lastError).toBeNull();
  });

  it("RB10: a deleted draft stays in the history and isn't made again; viewers can't run it", async () => {
    const w = await setup();
    const template = await w.template({ supplierInvoiceNumber: "R{n}" });
    await w.run("2026-02-01");
    const [run] = (await w.as((tx) => getRepeatingBill(tx, template.id))).runs;
    await w.as((tx) => deleteBill(tx, run.billId!));
    await expect(w.as((tx) => getBill(tx, run.billId!))).rejects.toThrow("Bill not found");
    const after = await w.as((tx) => getRepeatingBill(tx, template.id));
    expect(after.runs.map((r) => [r.scheduledDate, r.billId, r.billDeleted])).toEqual([["2026-01-31", null, true]]);
    expect((await w.run("2026-02-01")).made).toBe(0);
    // The next bill is still the template's second.
    expect(after.nextSupplierInvoiceNumber).toBe("R2");
    await w.run("2026-02-28");
    expect((await w.bills()).map((b) => b[3])).toEqual(["R2"]);
    // A draft it made can be approved by hand like any other.
    const second = (await w.as((tx) => getRepeatingBill(tx, template.id))).runs[0];
    expect((await w.as((tx) => approveBill(tx, second.billId!, { idempotencyKey: key("a") }))).bill.status).toBe("approved");
    const cookie = await sessionCookieFor(viewer);
    const response = await runRoute.POST(
      apiRequest(`/api/repeating-bills/${template.id}/run`, { method: "POST", cookie, body: { organisationId: w.org } }),
      params({ repeatingBillId: template.id }),
    );
    expect(response.status).toBe(403);
  });
});
