import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill } from "@/lib/bills/service";
import { createContact } from "@/lib/contacts/service";
import { createItem } from "@/lib/items/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { printedDocument } from "@/lib/documents/print";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { periodChecklist } from "@/lib/ledger/period-close";
import { getOrganisationSettings, updateOrganisationSettings } from "@/lib/organisations/settings";
import { calculateGstReturn } from "@/lib/reports/gst-return";
import {
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

/**
 * Issue #180, examples NR1-NR8 in docs/ACCOUNTING-EXAMPLES.md ("Not
 * registered for GST"): Kowhai Crafts isn't registered for GST, then
 * registers from 1 Nov 2026 and deregisters on 31 Mar 2027.
 */
describeWithDatabase("not registered for GST (#180, NR1-NR8)", () => {
  let server: TestServer;
  let owner: SessionUser;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
  });
  afterAll(async () => {
    await server?.teardown();
  });

  let counter = 0;
  async function setup() {
    const org = `kowhai-${++counter}`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) => updateOrganisationSettings(tx, { displayName: "Kowhai Crafts", gstRegistered: false }));
    const kobe = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Cafe", isCustomer: true }))).contact;
    const paper = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Paper Co", isSupplier: true }))).contact;
    const invoice = (date: string, taxCode: string | null, amountsMode: "exclusive" | "no_tax" = "exclusive") =>
      as((tx) =>
        createInvoice(tx, {
          idempotencyKey: key("i"),
          contactId: kobe.id,
          invoiceDate: date,
          dueDate: date,
          amountsMode,
          lines: [{ description: "Cards", quantity: "2", unitPrice: "50", accountCode: "4000", ...(taxCode ? { taxCode } : {}) }],
        }),
      );
    const gstLines = (journalId: string) =>
      as((tx) =>
        tx.query<{ count: string }>(
          `select count(*)::text as count from ledger_journal_lines l join accounts a on a.id = l.account_id
            where a.system_key = 'gst' and l.journal_id = $1`,
          [journalId],
        ),
      );
    return { org, as, kobe, paper, invoice, gstLines };
  }

  it("new organisations start registered, as before (NR8)", async () => {
    const org = `fresh-${++counter}`;
    await createTestOrganisation(owner, org);
    const settings = await inOrganisation(org, { userId: owner.id, email: owner.email }, (tx) => getOrganisationSettings(tx));
    expect(settings).toMatchObject({ gstRegistered: true, gstRegisteredFrom: null, gstRegisteredUntil: null });
  });

  it("NR1: an invoice with no GST is 100.00, with nothing on the GST account, printed as Invoice", async () => {
    const w = await setup();
    const { invoice: draft } = await w.invoice("2026-10-15", "NONE");
    expect(draft).toMatchObject({ subtotal: "100.00", taxTotal: "0.00", total: "100.00" });
    const { invoice } = await w.as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("a") }));
    expect((await w.gstLines(invoice.approvalJournalId!)).rows[0].count).toBe("0");
    const printed = await w.as((tx) => printedDocument(tx, "invoice", invoice.id));
    expect(printed.labels.title).toBe("Invoice");
    expect(printed.labels.warnings).toEqual([]);
  });

  it("NR1: an item with a GST code doesn't put GST on the line while not registered", async () => {
    const w = await setup();
    const { item } = await w.as((tx) =>
      createItem(tx, { idempotencyKey: key("item"), code: "CARD", name: "Card", itemType: "non_stock", salePrice: "50.00", incomeAccountCode: "4000", salesTaxCode: "GST" }),
    );
    for (const amountsMode of ["no_tax", "exclusive"] as const) {
      const { invoice } = await w.as((tx) =>
        createInvoice(tx, {
          idempotencyKey: key("i"),
          contactId: w.kobe.id,
          invoiceDate: "2026-10-15",
          dueDate: "2026-10-15",
          amountsMode,
          lines: [{ itemId: item.id, quantity: "2" }],
        }),
      );
      expect(invoice).toMatchObject({ taxTotal: "0.00", total: "100.00" });
      expect(invoice.lines[0].taxCode).toBeNull();
    }
    // A blank line with No GST amounts, as the editor sends it.
    const { invoice } = await w.invoice("2026-10-15", null, "no_tax");
    expect(invoice).toMatchObject({ taxTotal: "0.00", total: "100.00" });
  });

  it("NR2: GST, zero-rated and exempt codes are refused on sales and purchases", async () => {
    const w = await setup();
    for (const code of ["GST", "ZERO", "EXEMPT"]) {
      await expect(w.invoice("2026-10-15", code)).rejects.toThrow(
        `Line 1: Kowhai Crafts isn't registered for GST, so it can't charge or claim GST. Tax code ${code} can't be used; use a code with no GST.`,
      );
    }
    await expect(
      w.as((tx) =>
        createBill(tx, {
          idempotencyKey: key("b"),
          contactId: w.paper.id,
          billDate: "2026-10-15",
          dueDate: "2026-10-30",
          supplierInvoiceNumber: "P-1",
          amountsMode: "inclusive",
          lines: [{ description: "Card stock", quantity: "1", unitPrice: "115", accountCode: "6010", taxCode: "GST" }],
        }),
      ),
    ).rejects.toThrow("isn't registered for GST");
  });

  it("NR3: a 115.00 bill from a registered supplier is a 115.00 cost", async () => {
    const w = await setup();
    const { bill: draft } = await w.as((tx) =>
      createBill(tx, {
        idempotencyKey: key("b"),
        contactId: w.paper.id,
        billDate: "2026-10-15",
        dueDate: "2026-10-30",
        supplierInvoiceNumber: "P-2",
        amountsMode: "inclusive",
        lines: [{ description: "Card stock", quantity: "1", unitPrice: "115", accountCode: "6010", taxCode: "NONE" }],
      }),
    );
    expect(draft).toMatchObject({ subtotal: "115.00", taxTotal: "0.00", total: "115.00" });
    const { bill } = await w.as((tx) => approveBill(tx, draft.id, { idempotencyKey: key("ab") }));
    expect((await w.gstLines(bill.approvalJournalId!)).rows[0].count).toBe("0");
  });

  it("NR4: period close shows the GST check as not applicable", async () => {
    const w = await setup();
    const checklist = await w.as((tx) => periodChecklist(tx, { periodEnd: "2026-10-31" }));
    expect(checklist.checks.find((check) => check.key === "gst")).toMatchObject({
      status: "not_applicable",
      summary: "Not applicable (not registered for GST).",
    });
  });

  it("NR5: registering from 1 Nov 2026: GST from that date, not before; the first return has nothing earlier", async () => {
    const w = await setup();
    await expect(w.as((tx) => updateOrganisationSettings(tx, { gstRegistered: true, gstRegisteredFrom: "2026-11-01" }))).rejects.toThrow(
      "Enter the GST number to register for GST.",
    );
    await w.as((tx) =>
      updateOrganisationSettings(tx, { gstRegistered: true, gstRegisteredFrom: "2026-11-01", gstNumber: "123-456-789", gstBasis: "invoice" }),
    );
    const { invoice: draft } = await w.invoice("2026-11-01", "GST");
    expect(draft).toMatchObject({ subtotal: "100.00", taxTotal: "15.00", total: "115.00" });
    const { invoice } = await w.as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("a") }));
    expect((await w.as((tx) => printedDocument(tx, "invoice", invoice.id))).labels.title).toBe("Tax invoice");
    await expect(w.invoice("2026-10-31", "GST")).rejects.toThrow(
      "Kowhai Crafts isn't registered for GST on 2026-10-31 (it's registered from 2026-11-01)",
    );
    const gst = await w.as((tx) => calculateGstReturn(tx, { periodStart: "2026-11-01", periodEnd: "2026-12-31" }));
    expect(gst.lines.map((line) => line.eventDate)).toEqual(["2026-11-01"]);
  });

  it("NR6-NR7: deregistering on 31 Mar 2027: no GST after it, a reminder on the last return, and earlier documents unchanged", async () => {
    const w = await setup();
    await w.as((tx) => updateOrganisationSettings(tx, { gstRegistered: true, gstRegisteredFrom: "2026-11-01", gstNumber: "123-456-789" }));
    const { invoice: draft } = await w.invoice("2026-11-15", "GST");
    const { invoice } = await w.as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("a") }));
    await w.as((tx) => updateOrganisationSettings(tx, { gstRegisteredUntil: "2027-03-31" }));
    await expect(w.invoice("2027-04-01", "GST")).rejects.toThrow("(its registration ended 2027-03-31)");
    const last = await w.as((tx) => calculateGstReturn(tx, { periodStart: "2027-02-01", periodEnd: "2027-03-31" }));
    expect(last.registrationEnded).toEqual({ until: "2027-03-31", assetsHeld: [] });
    // NR7: the November invoice keeps its GST and still prints as a tax invoice.
    const printed = await w.as((tx) => printedDocument(tx, "invoice", invoice.id));
    expect(printed).toMatchObject({ taxTotal: "15.00", labels: { title: "Tax invoice" } });
    // GST already in the books can't be left outside the registration dates.
    await expect(w.as((tx) => updateOrganisationSettings(tx, { gstRegisteredUntil: "2026-11-10" }))).rejects.toThrow(
      "GST has been charged or claimed in the books on dates outside these registration dates (2026-11-15).",
    );
    await expect(w.as((tx) => updateOrganisationSettings(tx, { gstRegistered: false }))).rejects.toThrow(
      "so this organisation can't be made not registered. Set the date its registration ended instead.",
    );
  });
});

describe("GST registration dates (#180)", () => {
  it("are inclusive at both ends", async () => {
    const { isRegisteredOn } = await import("@/lib/tax/registration");
    const registration = { registered: true, from: "2026-11-01", until: "2027-03-31" };
    expect(["2026-10-31", "2026-11-01", "2027-03-31", "2027-04-01"].map((date) => isRegisteredOn(registration, date))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(isRegisteredOn({ registered: true, from: null, until: null }, "1990-01-01")).toBe(true);
    expect(isRegisteredOn({ registered: false, from: null, until: null }, "2026-11-01")).toBe(false);
  });
});
