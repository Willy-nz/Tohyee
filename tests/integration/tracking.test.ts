import { afterAll, beforeAll, expect, it } from "vitest";
import * as splitRoute from "@/app/api/reports/profit-and-loss/route";
import * as trackingRoute from "@/app/api/tracking/route";
import * as valuesRoute from "@/app/api/tracking/values/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts } from "@/lib/bank/accounts";
import { createBankTransaction, voidBankTransaction } from "@/lib/bank/transactions";
import { approveBill, createBill, getBill, voidBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import { approveCreditNote, createCreditNote } from "@/lib/credit-notes/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveInvoice, createInvoice, getInvoice, updateInvoice, voidInvoice } from "@/lib/invoices/service";
import { correctJournal, getJournal, postJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createCustomReport, getCustomReport, publishCustomReport, updateCustomReport } from "@/lib/reports/custom";
import type { CustomReportFigures } from "@/lib/reports/custom-layout";
import { calculateGstReturn } from "@/lib/reports/gst-return";
import { profitAndLoss, profitAndLossSplit } from "@/lib/reports/financial";
import { approveSupplierCreditNote, createSupplierCreditNote } from "@/lib/supplier-credit-notes/service";
import { createTaxCode } from "@/lib/tax/codes";
import { createTrackingValue, getTrackingSetup, type TrackingSetup, updateTrackingCategory, updateTrackingValue } from "@/lib/tracking/service";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const noContext = undefined as unknown;

/**
 * Examples TC1-TC10 in docs/ACCOUNTING-EXAMPLES.md ("Tracking categories").
 * Each test gets its own organisation. Setup: advanced features on;
 * Department Retail and Wholesale; Class Jewellery and Kits; Location Otago
 * (Dunedin, Queenstown) and Canterbury (Christchurch); GST 15%.
 */
describeWithDatabase("tracking categories", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup(options: { values?: boolean } = {}) {
    organisations += 1;
    const org = `tracking-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) =>
      createTaxCode(tx, { idempotencyKey: key("tax"), code: "GST", label: "GST (15%)", category: "standard", rate: "0.15", effectiveFrom: "2026-01-01" }),
    );
    const contact = async (name: string, flags: Record<string, unknown>): Promise<Contact> =>
      (await as((tx) => createContact(tx, { idempotencyKey: key("contact"), name, ...flags }))).contact;
    const kobe = await contact("Kobe Ltd", { isCustomer: true, isSupplier: true });
    const categories = (await as((tx) => getTrackingSetup(tx))).categories;
    const cat = (kind: string) => categories.find((c) => c.kind === kind)!.id;
    const department = cat("department");
    const klass = cat("class");
    const location = cat("location");
    const v: Record<string, string> = {};
    const find = (s: TrackingSetup, category: string, name: string) =>
      s.categories.find((c) => c.id === category)!.values.find((value) => value.name === name)!.id;
    const add = async (category: string, name: string, parent?: string) => {
      const s = await as((tx) => createTrackingValue(tx, { categoryId: category, name, parentId: parent ? v[parent] : null }));
      v[name] = find(s, category, name);
    };
    if (options.values !== false) {
      await as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
      await add(department, "Retail");
      await add(department, "Wholesale");
      await add(klass, "Jewellery");
      await add(klass, "Kits");
      await add(location, "Otago");
      await add(location, "Dunedin", "Otago");
      await add(location, "Queenstown", "Otago");
      await add(location, "Canterbury");
      await add(location, "Christchurch", "Canterbury");
    }
    const tags = (dept?: string, cls?: string, loc?: string) => ({
      ...(dept ? { [department]: v[dept] } : {}),
      ...(cls ? { [klass]: v[cls] } : {}),
      ...(loc ? { [location]: v[loc] } : {}),
    });
    const line = (amount: string, tracking: Record<string, string>, accountCode = "4000") => ({
      description: "Item",
      quantity: "1",
      unitPrice: amount,
      accountCode,
      taxCode: "GST",
      tracking,
    });
    const draftInvoice = (lines: unknown[]) =>
      as((tx) =>
        createInvoice(tx, {
          idempotencyKey: key("invoice"),
          contactId: kobe.id,
          invoiceDate: "2026-06-10",
          dueDate: "2026-07-10",
          amountsMode: "exclusive",
          lines,
        }),
      );
    const approve = (id: string) => as((tx) => approveInvoice(tx, id, { idempotencyKey: key("approve") }));
    let bills = 0;
    const draftBill = (lines: unknown[]) => {
      bills += 1;
      return as((tx) =>
        createBill(tx, {
          idempotencyKey: key("bill"),
          contactId: kobe.id,
          billDate: "2026-06-12",
          dueDate: "2026-07-12",
          supplierInvoiceNumber: `B-${bills}`,
          amountsMode: "exclusive",
          lines,
        }),
      );
    };
    const lines = async (journalId: string) =>
      (await as((tx) => getJournal(tx, journalId))).lines.map((l) => [l.accountCode, l.debitAmount, l.creditAmount, l.tracking]);
    return { org, as, kobe, department, klass, location, v, tags, line, draftInvoice, approve, draftBill, lines, add };
  }

  it("TC1: off by default; tags are refused while off; switching is recorded", async () => {
    const w = await setup({ values: false });
    const setupNow = await w.as((tx) => getTrackingSetup(tx));
    expect(setupNow.advancedFeatures).toBe(false);
    expect(setupNow.categories.map((c) => [c.kind, c.name, c.values.length])).toEqual([
      ["department", "Department", 0],
      ["class", "Class", 0],
      ["location", "Location", 0],
    ]);
    await expect(w.as((tx) => createTrackingValue(tx, { categoryId: w.department, name: "Retail" }))).rejects.toThrow(/Advanced features are off/);
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    await w.add(w.department, "Retail");
    await w.add(w.department, "Wholesale");
    const tagged = (await w.draftInvoice([w.line("100.00", w.tags("Retail"))])).invoice;
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: false }));
    await expect(w.draftInvoice([w.line("100.00", w.tags("Retail"))])).rejects.toThrow(/advanced features are off/);
    // A draft tagged while it was on keeps its tags, but gets no new ones.
    await expect(w.as((tx) => updateInvoice(tx, tagged.id, { lines: [w.line("100.00", w.tags("Wholesale"))] }))).rejects.toThrow(/advanced features are off/);
    await w.as((tx) => updateInvoice(tx, tagged.id, { lines: [w.line("120.00", w.tags("Retail"))] }));
    const kept = (await w.approve(tagged.id)).invoice;
    expect(await w.lines(kept.approvalJournalId!)).toContainEqual(["4000", "0.00", "120.00", w.tags("Retail")]);
    // Without tags nothing changes.
    await w.draftInvoice([w.line("100.00", {})]);
    const history = await w.as((tx) =>
      tx.query<{ details: { advancedFeatures: boolean } }>(
        "select details from audit_events where event_type = 'organisation.settings_updated' order by id",
      ),
    );
    expect(history.rows.map((row) => row.details.advancedFeatures)).toEqual([true, false]);
  });

  it("TC2: value trees: sibling names, no loops, archive not delete", async () => {
    const w = await setup();
    await w.add(w.location, "Dunedin", "Canterbury");
    await expect(w.as((tx) => createTrackingValue(tx, { categoryId: w.location, name: "dunedin", parentId: w.v.Otago }))).rejects.toThrow(
      "There's already a value called dunedin there.",
    );
    const dunedinUnderOtago = (await w.as((tx) => getTrackingSetup(tx))).categories
      .find((c) => c.id === w.location)!
      .values.find((value) => value.path === "Otago › Dunedin")!;
    await expect(w.as((tx) => updateTrackingValue(tx, w.v.Otago, { parentId: dunedinUnderOtago.id }))).rejects.toThrow(/under itself or its own children/);
    await expect(w.as((tx) => tx.query("delete from tracking_values where id = $1", [w.v.Queenstown]))).rejects.toThrow(/archive them instead/);
    const draft = (await w.draftInvoice([w.line("10.00", w.tags(undefined, undefined, "Queenstown"))])).invoice;
    await w.as((tx) => updateTrackingValue(tx, w.v.Queenstown, { isActive: false }));
    await expect(w.draftInvoice([w.line("10.00", w.tags(undefined, undefined, "Queenstown"))])).rejects.toThrow("Line 1: Otago › Queenstown is archived.");
    // The draft that already had it keeps it, and can be approved.
    const approved = (await w.approve(draft.id)).invoice;
    expect(approved.lines[0].tracking).toEqual({ [w.location]: w.v.Queenstown });
    expect(await w.lines(approved.approvalJournalId!)).toContainEqual(["4000", "0.00", "10.00", { [w.location]: w.v.Queenstown }]);
  });

  it("TC3: invoice lines keep their tags; equal tags post together; GST unchanged", async () => {
    const w = await setup();
    const { invoice } = await w.draftInvoice([
      w.line("100.00", w.tags("Retail", "Jewellery", "Dunedin")),
      w.line("50.00", w.tags("Wholesale", "Kits", "Christchurch")),
    ]);
    const approved = (await w.approve(invoice.id)).invoice;
    expect(await w.lines(approved.approvalJournalId!)).toEqual([
      ["1100", "172.50", "0.00", {}],
      ["4000", "0.00", "100.00", w.tags("Retail", "Jewellery", "Dunedin")],
      ["4000", "0.00", "50.00", w.tags("Wholesale", "Kits", "Christchurch")],
      ["2100", "0.00", "22.50", {}],
    ]);
    const same = (await w.draftInvoice([w.line("30.00", w.tags("Retail")), w.line("20.00", w.tags("Retail"))])).invoice;
    const approvedSame = (await w.approve(same.id)).invoice;
    expect(await w.lines(approvedSame.approvalJournalId!)).toEqual([
      ["1100", "57.50", "0.00", {}],
      ["4000", "0.00", "50.00", w.tags("Retail")],
      ["2100", "0.00", "7.50", {}],
    ]);
    const gst = await w.as((tx) => calculateGstReturn(tx, { periodStart: "2026-06-01", periodEnd: "2026-06-30" }));
    expect(gst.boxes).toMatchObject({ box5: "230.00", box8: "30.00" });
  });

  it("TC4: bill lines keep their tags; voiding reverses them with the same tags", async () => {
    const w = await setup();
    const { bill } = await w.draftBill([w.line("40.00", w.tags("Retail", undefined, "Dunedin"), "6010"), w.line("60.00", {}, "6010")]);
    const approved = (await w.as((tx) => approveBill(tx, bill.id, { idempotencyKey: key("approve") }))).bill;
    expect(await w.lines(approved.approvalJournalId!)).toEqual([
      ["6010", "40.00", "0.00", w.tags("Retail", undefined, "Dunedin")],
      ["6010", "60.00", "0.00", {}],
      ["2100", "15.00", "0.00", {}],
      ["2000", "0.00", "115.00", {}],
    ]);
    const voided = (await w.as((tx) => voidBill(tx, bill.id, { idempotencyKey: key("void"), voidDate: "2026-06-20" }))).bill;
    expect(await w.lines(voided.voidJournalId!)).toEqual([
      ["6010", "0.00", "40.00", w.tags("Retail", undefined, "Dunedin")],
      ["6010", "0.00", "60.00", {}],
      ["2100", "0.00", "15.00", {}],
      ["2000", "115.00", "0.00", {}],
    ]);
    expect((await w.as((tx) => getBill(tx, bill.id))).lines.map((l) => l.tracking)).toEqual([w.tags("Retail", undefined, "Dunedin"), {}]);
  });

  it("TC5: manual journals and corrections", async () => {
    const w = await setup();
    const posted = await w.as((tx) =>
      postJournal(tx, {
        idempotencyKey: key("journal"),
        postingDate: "2026-06-15",
        reference: "Fees",
        lines: [
          { accountCode: "6010", debitAmount: "25.00", tracking: w.tags("Retail") },
          { accountCode: "1000", creditAmount: "25.00" },
        ],
      }),
    );
    expect(await w.lines(posted.journal.id)).toEqual([
      ["6010", "25.00", "0.00", w.tags("Retail")],
      ["1000", "0.00", "25.00", {}],
    ]);
    await expect(
      w.as((tx) =>
        postJournal(tx, {
          idempotencyKey: key("journal"),
          postingDate: "2026-06-15",
          reference: "Wrong",
          lines: [
            { accountCode: "6010", debitAmount: "25.00", tracking: { [w.department]: w.v.Dunedin } },
            { accountCode: "1000", creditAmount: "25.00" },
          ],
        }),
      ),
    ).rejects.toThrow("Line 1: that isn't a Department value.");
    const corrected = await w.as((tx) =>
      correctJournal(tx, {
        idempotencyKey: key("correct"),
        originalJournalId: posted.journal.id,
        postingDate: "2026-06-16",
        reference: "Fees",
        lines: [
          { accountCode: "6010", debitAmount: "25.00", tracking: w.tags("Wholesale") },
          { accountCode: "1000", creditAmount: "25.00" },
        ],
      }),
    );
    expect(await w.lines(corrected.reversalJournal.id)).toEqual([
      ["6010", "0.00", "25.00", w.tags("Retail")],
      ["1000", "25.00", "0.00", {}],
    ]);
    expect(await w.lines(corrected.replacementJournal.id)).toContainEqual(["6010", "25.00", "0.00", w.tags("Wholesale")]);
    // A correction can keep a value the original had, even once it's archived.
    await w.as((tx) => updateTrackingValue(tx, w.v.Wholesale, { isActive: false }));
    const again = await w.as((tx) =>
      correctJournal(tx, {
        idempotencyKey: key("correct"),
        originalJournalId: corrected.replacementJournal.id,
        postingDate: "2026-06-17",
        reference: "Fees",
        lines: [
          { accountCode: "6010", debitAmount: "30.00", tracking: w.tags("Wholesale") },
          { accountCode: "1000", creditAmount: "30.00" },
        ],
      }),
    );
    expect(await w.lines(again.replacementJournal.id)).toContainEqual(["6010", "30.00", "0.00", w.tags("Wholesale")]);
  });

  it("TC6: a required category is needed on income and expense lines to approve or post", async () => {
    const w = await setup();
    await w.as((tx) => updateTrackingCategory(tx, w.department, { isRequired: true }));
    const { invoice } = await w.draftInvoice([w.line("100.00", w.tags("Retail")), w.line("50.00", {})]);
    await expect(w.approve(invoice.id)).rejects.toThrow("Line 2 needs a Department.");
    const { bill } = await w.draftBill([w.line("40.00", w.tags("Retail"), "6010"), w.line("60.00", {}, "6010")]);
    await expect(w.as((tx) => approveBill(tx, bill.id, { idempotencyKey: key("approve") }))).rejects.toThrow("Line 2 needs a Department.");
    const journal = (tracking: Record<string, string>) =>
      w.as((tx) =>
        postJournal(tx, {
          idempotencyKey: key("journal"),
          postingDate: "2026-06-15",
          reference: "Fees",
          lines: [
            { accountCode: "6010", debitAmount: "25.00", tracking },
            { accountCode: "1000", creditAmount: "25.00" },
          ],
        }),
      );
    await expect(journal({})).rejects.toThrow("Line 1 needs a Department.");
    await journal(w.tags("Retail"));
    // The draft saves without it; filling it in lets it approve.
    await w.as((tx) => updateInvoice(tx, invoice.id, { lines: [w.line("100.00", w.tags("Retail")), w.line("50.00", w.tags("Wholesale"))] }));
    await w.approve(invoice.id);
    await w.as((tx) => updateTrackingCategory(tx, w.department, { isRequired: false }));
    await w.as((tx) => approveBill(tx, bill.id, { idempotencyKey: key("approve") }));
    await journal({});
  });

  async function juneData() {
    const w = await setup();
    const { invoice } = await w.draftInvoice([
      w.line("100.00", w.tags("Retail", "Jewellery", "Dunedin")),
      w.line("50.00", w.tags("Wholesale", "Kits", "Christchurch")),
    ]);
    await w.approve(invoice.id);
    const { bill } = await w.draftBill([w.line("40.00", w.tags("Retail", undefined, "Dunedin"), "6010"), w.line("60.00", {}, "6010")]);
    await w.as((tx) => approveBill(tx, bill.id, { idempotencyKey: key("approve") }));
    return { w, invoiceId: invoice.id };
  }

  const june = { from: "2026-06-01", to: "2026-06-30" };
  const columns = (report: Awaited<ReturnType<typeof profitAndLossSplit>>, totals: Record<string, string>) =>
    Object.fromEntries(report.columns.map((c) => [c.label, totals[c.key]]));

  it("TC7: profit and loss split by department and by location", async () => {
    const { w } = await juneData();
    const byDepartment = await w.as((tx) => profitAndLossSplit(tx, { ...june, categoryId: w.department }));
    expect(byDepartment.columns.map((c) => c.label)).toEqual(["Retail", "Wholesale", "Not set", "Total"]);
    expect(columns(byDepartment, byDepartment.revenue.totals)).toEqual({ Retail: "100.00", Wholesale: "50.00", "Not set": "0.00", Total: "150.00" });
    expect(columns(byDepartment, byDepartment.expenses.totals)).toEqual({ Retail: "40.00", Wholesale: "0.00", "Not set": "60.00", Total: "100.00" });
    expect(columns(byDepartment, byDepartment.netProfit)).toEqual({ Retail: "60.00", Wholesale: "50.00", "Not set": "-60.00", Total: "50.00" });
    expect((await w.as((tx) => profitAndLoss(tx, june))).netProfit).toBe("50.00");
    const byLocation = await w.as((tx) => profitAndLossSplit(tx, { ...june, categoryId: w.location }));
    expect(columns(byLocation, byLocation.revenue.totals)).toEqual({ Canterbury: "50.00", Otago: "100.00", "Not set": "0.00", Total: "150.00" });
    expect(columns(byLocation, byLocation.expenses.totals)).toEqual({ Canterbury: "0.00", Otago: "40.00", "Not set": "60.00", Total: "100.00" });
    expect(columns(byLocation, byLocation.netProfit)).toEqual({ Canterbury: "50.00", Otago: "60.00", "Not set": "-60.00", Total: "50.00" });
  });

  it("TC8: a custom report filtered to Otago", async () => {
    const { w } = await juneData();
    const report = (await w.as((tx) => createCustomReport(tx, { idempotencyKey: key("report"), base: "profit_and_loss", periodEnd: "2026-06-30" }))).report;
    const saved = await w.as((tx) =>
      updateCustomReport(tx, report.id, { layout: { ...report.layout, filter: { categoryId: w.location, valueId: w.v.Otago } }, version: 1 }),
    );
    const rows = (figures: CustomReportFigures) =>
      Object.fromEntries(
        (figures.blocks[0] as { rows: Array<{ label: string; values: Record<string, string | null> }> }).rows.map((row) => [row.label, row.values.p0]),
      );
    expect(rows(saved.figures)).toMatchObject({ Revenue: "100.00", Expenses: "40.00", "Net profit": "60.00" });
    expect(saved.figures.filterLabel).toBe("Location: Otago");
    const published = (await w.as((tx) => publishCustomReport(tx, report.id, { idempotencyKey: key("publish") }))).report;
    const frozen = await w.as((tx) => getCustomReport(tx, published.id));
    expect(frozen.figures.filterLabel).toBe("Location: Otago");
    expect(rows(frozen.figures)["Net profit"]).toBe("60.00");
    const sheet = (await w.as((tx) => createCustomReport(tx, { idempotencyKey: key("report"), base: "balance_sheet", periodEnd: "2026-06-30" }))).report;
    await expect(
      w.as((tx) => updateCustomReport(tx, sheet.id, { layout: { ...sheet.layout, filter: { categoryId: w.location, valueId: w.v.Otago } }, version: 1 })),
    ).rejects.toThrow("Only a profit and loss can be filtered by a tracking category.");
  });

  it("TC9: voiding the invoice nets to zero in every column", async () => {
    const { w, invoiceId } = await juneData();
    await w.as((tx) => voidInvoice(tx, invoiceId, { idempotencyKey: key("void"), voidDate: "2026-06-25" }));
    const split = await w.as((tx) => profitAndLossSplit(tx, { ...june, categoryId: w.department }));
    expect(Object.values(split.revenue.totals ?? {}).every((amount) => amount === "0.00")).toBe(true);
    expect((await w.as((tx) => getInvoice(tx, invoiceId))).status).toBe("voided");
  });

  it("TC10: credit notes and spend and receive money carry tags; control lines don't", async () => {
    const w = await setup();
    const credit = (
      await w.as((tx) =>
        createCreditNote(tx, {
          idempotencyKey: key("cn"),
          contactId: w.kobe.id,
          creditNoteDate: "2026-06-15",
          amountsMode: "exclusive",
          lines: [w.line("20.00", w.tags("Retail"))],
        }),
      )
    ).creditNote;
    const approvedCredit = (await w.as((tx) => approveCreditNote(tx, credit.id, { idempotencyKey: key("approve") }))).creditNote;
    expect(await w.lines(approvedCredit.approvalJournalId!)).toEqual([
      ["4000", "20.00", "0.00", w.tags("Retail")],
      ["2100", "3.00", "0.00", {}],
      ["1100", "0.00", "23.00", {}],
    ]);
    const supplierCredit = (
      await w.as((tx) =>
        createSupplierCreditNote(tx, {
          idempotencyKey: key("scn"),
          contactId: w.kobe.id,
          creditNoteDate: "2026-06-15",
          supplierCreditNoteNumber: "CR-1",
          amountsMode: "exclusive",
          lines: [w.line("10.00", w.tags("Wholesale"), "6010")],
        }),
      )
    ).creditNote;
    const approvedSupplierCredit = (await w.as((tx) => approveSupplierCreditNote(tx, supplierCredit.id, { idempotencyKey: key("approve") })))
      .creditNote;
    expect(await w.lines(approvedSupplierCredit.approvalJournalId!)).toContainEqual(["6010", "0.00", "10.00", w.tags("Wholesale")]);
    const bank = (await w.as((tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    const spend = await w.as((tx) =>
      createBankTransaction(tx, {
        idempotencyKey: key("spend"),
        kind: "spend",
        accountId: bank.id,
        contactId: w.kobe.id,
        date: "2026-06-15",
        amountsMode: "exclusive",
        lines: [{ description: "Courier", accountCode: "6010", taxCode: "GST", amount: "30.00", tracking: w.tags("Retail", undefined, "Dunedin") }],
      }),
    );
    expect(spend.bankTransaction.lines[0].tracking).toEqual(w.tags("Retail", undefined, "Dunedin"));
    expect(await w.lines(spend.bankTransaction.journalId)).toEqual([
      ["6010", "30.00", "0.00", w.tags("Retail", undefined, "Dunedin")],
      ["2100", "4.50", "0.00", {}],
      ["1000", "0.00", "34.50", {}],
    ]);
    const voided = await w.as((tx) => voidBankTransaction(tx, spend.bankTransaction.id, { idempotencyKey: key("void"), voidDate: "2026-06-16" }));
    expect(await w.lines(voided.bankTransaction.voidJournalId!)).toContainEqual(["6010", "0.00", "30.00", w.tags("Retail", undefined, "Dunedin")]);
  });

  it("over HTTP: viewers can read the setup and the split; only admins add values", async () => {
    const { w } = await juneData();
    const viewerCookie = await sessionCookieFor(viewer);
    const cookie = await sessionCookieFor(owner);
    const read = await trackingRoute.GET(apiRequest(`/api/tracking?organisationId=${w.org}`, { cookie: viewerCookie }), noContext);
    expect(read.status).toBe(200);
    expect(((await read.json()) as TrackingSetup).advancedFeatures).toBe(true);
    const body = { organisationId: w.org, categoryId: w.department, name: "Online" };
    expect((await valuesRoute.POST(apiRequest("/api/tracking/values", { method: "POST", cookie: viewerCookie, body }), noContext)).status).toBe(403);
    expect((await valuesRoute.POST(apiRequest("/api/tracking/values", { method: "POST", cookie, body }), noContext)).status).toBe(201);
    const split = await splitRoute.GET(
      apiRequest(`/api/reports/profit-and-loss?organisationId=${w.org}&from=2026-06-01&to=2026-06-30&splitBy=${w.department}`, { cookie: viewerCookie }),
      noContext,
    );
    expect(split.status).toBe(200);
    expect(((await split.json()) as { netProfit: Record<string, string> }).netProfit.total).toBe("50.00");
  });
});
