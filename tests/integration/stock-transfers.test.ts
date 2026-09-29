import { afterAll, beforeAll, expect, it } from "vitest";
import * as transfersRoute from "@/app/api/inventory/transfers/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill, voidBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { listMovements } from "@/lib/inventory/movements";
import { listTransfers, transferStock } from "@/lib/inventory/transfers";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { createItem, type Item } from "@/lib/items/service";
import { getJournal } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { dec, sub, toFixedString } from "@/lib/money/decimal";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { inventoryValuation, trialBalance } from "@/lib/reports/financial";
import { createTaxCode } from "@/lib/tax/codes";
import { createTrackingValue, getTrackingSetup, updateTrackingValue } from "@/lib/tracking/service";
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

/** Examples TR1-TR6 in docs/ACCOUNTING-EXAMPLES.md ("Stock transfers between locations"). Each test gets its own organisation. */
describeWithDatabase("stock transfers", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("transfer-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("transfer-viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup(options: { locations?: boolean; negative?: boolean } = { locations: true }) {
    organisations += 1;
    const org = `transfer-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) =>
      createTaxCode(tx, { idempotencyKey: key("tax"), code: "GST", label: "GST (15%)", category: "standard", rate: "0.15", effectiveFrom: "2026-01-01" }),
    );
    await as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const loc: Record<string, string> = {};
    const category = (await as((tx) => getTrackingSetup(tx))).categories.find((c) => c.kind === "location")!.id;
    if (options.locations !== false) {
      for (const name of ["Dunedin", "Auckland", "Christchurch"]) {
        const setup = await as((tx) => createTrackingValue(tx, { categoryId: category, name }));
        loc[name] = setup.categories.find((c) => c.id === category)!.values.find((v) => v.name === name)!.id;
      }
    }
    if (options.negative) await as((tx) => updateOrganisationSettings(tx, { allowNegativeStock: true }));
    const contact = async (name: string, extra: Record<string, unknown>): Promise<Contact> =>
      (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name, ...extra }))).contact;
    const paw = await contact("Paw Supplies", { isSupplier: true });
    const kobe = await contact("Kobe Ltd", { isCustomer: true });
    const item = async (fields: Record<string, unknown>): Promise<Item> =>
      (await as((tx) => createItem(tx, { idempotencyKey: key("item"), incomeAccountCode: "4000", salesTaxCode: "GST", purchaseTaxCode: "GST", ...fields }))).item;
    const widget = await item({ code: "WIDGET", name: "Widget", itemType: "stock", salePrice: "12.00", purchasePrice: "5.00", purchaseAccountCode: "1400" });
    const at = (name?: string) => (name ? { [category]: loc[name] } : {});
    const bill = async (lines: Array<[string, string, string?]>, billDate = "2026-06-01") => {
      const draft = await as((tx) =>
        createBill(tx, {
          idempotencyKey: key("bill"),
          contactId: paw.id,
          billDate,
          dueDate: "2026-07-20",
          supplierInvoiceNumber: key("S"),
          amountsMode: "exclusive",
          lines: lines.map(([quantity, unitPrice, where]) => ({ itemId: widget.id, quantity, unitPrice, tracking: at(where) })),
        }),
      );
      return (await as((tx) => approveBill(tx, draft.bill.id, { idempotencyKey: key("a") }))).bill;
    };
    const invoice = async (quantity: string, where: string, invoiceDate = "2026-06-20") => {
      const draft = await as((tx) =>
        createInvoice(tx, {
          idempotencyKey: key("inv"),
          contactId: kobe.id,
          invoiceDate,
          dueDate: "2026-07-20",
          amountsMode: "exclusive",
          lines: [{ itemId: widget.id, quantity, unitPrice: "12.00", tracking: at(where) }],
        }),
      );
      return (await as((tx) => approveInvoice(tx, draft.invoice.id, { idempotencyKey: key("a") }))).invoice;
    };
    const transfer = (quantity: string, from: string, to: string, extra: Record<string, unknown> = {}) =>
      as((tx) =>
        transferStock(tx, {
          idempotencyKey: key("tr"),
          transferDate: "2026-06-15",
          itemId: widget.id,
          fromLocationValueId: loc[from],
          toLocationValueId: loc[to],
          quantity,
          reference: "Restock Auckland",
          ...extra,
        }),
      );
    const stock = async () => {
      const report = await as((tx) => inventoryValuation(tx));
      return Object.fromEntries(report.items.map((row) => [`${row.itemCode}${row.locationName ? `@${row.locationName}` : ""}`, [row.quantity, row.value]]));
    };
    /** Stock always equals account 1400 to the cent, on the stock report and the trial balance. */
    const assertTies = async () => {
      const report = await as((tx) => inventoryValuation(tx));
      const tb = await as((tx) => trialBalance(tx, { asAt: "2026-12-31" }));
      const row = tb.rows.find((entry) => entry.code === "1400");
      const ledger = row ? toFixedString(sub(dec(row.debit), dec(row.credit)), 2) : "0.00";
      expect(report.inventoryAccountBalance).toBe(report.totalValue);
      expect(ledger).toBe(report.totalValue);
      return ledger;
    };
    return { org, as, loc, category, widget, item, bill, invoice, transfer, stock, assertTies };
  }

  it("TR1: a transfer moves the value at the from-location's average, with a journal between locations", async () => {
    const w = await setup();
    await w.bill([["10", "5.00", "Dunedin"]]);
    const { transfer } = await w.transfer("4", "Dunedin", "Auckland");
    expect([transfer.quantity, transfer.value, transfer.fromLocationName, transfer.toLocationName, transfer.transferDate]).toEqual([
      "4",
      "20.00",
      "Dunedin",
      "Auckland",
      "2026-06-15",
    ]);
    const journal = await w.as((tx) => getJournal(tx, transfer.journalId));
    expect(journal.postingDate).toBe("2026-06-15");
    expect(journal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount, line.tracking])).toEqual([
      ["1400", "20.00", "0.00", { [w.category]: w.loc.Auckland }],
      ["1400", "0.00", "20.00", { [w.category]: w.loc.Dunedin }],
    ]);
    expect(await w.stock()).toEqual({ "WIDGET@Auckland": ["4", "20.00"], "WIDGET@Dunedin": ["6", "30.00"] });
    expect(await w.assertTies()).toBe("50.00");
    const movements = (await w.as((tx) => listMovements(tx))).movements.slice(0, 2);
    expect(movements.map((m) => [m.movementType, m.locationName, m.quantityDelta, m.valueDelta, m.ledgerJournalId, m.sourceType, m.sourceId])).toEqual([
      ["transfer_in", "Auckland", "4", "20.00", transfer.journalId, "transfer", transfer.id],
      ["transfer_out", "Dunedin", "-4", "-20.00", transfer.journalId, "transfer", transfer.id],
    ]);
    // Nothing goes to cost of sales.
    const cogs = await w.as((tx) => tx.query("select 1 from ledger_journal_lines l join accounts a on a.id = l.account_id where a.code = '5000'"));
    expect(cogs.rowCount).toBe(0);
    // Transfers can't be changed or deleted (the database refuses).
    await expect(w.as((tx) => tx.query("update stock_transfers set quantity = 5"))).rejects.toThrow();
    await expect(w.as((tx) => tx.query("delete from stock_transfers"))).rejects.toThrow();
  });

  it("TR2: moving what's left takes the whole remaining value (W3, W4)", async () => {
    const w = await setup();
    await w.bill([["3", "3.3333", "Dunedin"]]);
    expect(await w.stock()).toEqual({ "WIDGET@Dunedin": ["3", "10.00"] });
    expect((await w.transfer("1", "Dunedin", "Auckland")).transfer.value).toBe("3.33");
    expect((await w.transfer("2", "Dunedin", "Auckland")).transfer.value).toBe("6.67");
    expect(await w.stock()).toEqual({ "WIDGET@Auckland": ["3", "10.00"] });
    await w.assertTies();
  });

  it("TR3: averages stay per location", async () => {
    const w = await setup();
    await w.bill([
      ["10", "5.00", "Dunedin"],
      ["10", "7.00", "Auckland"],
    ]);
    await w.transfer("4", "Dunedin", "Auckland");
    expect(await w.stock()).toEqual({ "WIDGET@Auckland": ["14", "90.00"], "WIDGET@Dunedin": ["6", "30.00"] });
    const sold = await w.invoice("1", "Auckland");
    const lines = (await w.as((tx) => getJournal(tx, sold.approvalJournalId!))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount]);
    expect(lines.slice(3)).toEqual([
      ["5000", "6.43", "0.00"],
      ["1400", "0.00", "6.43"],
    ]);
    expect(await w.stock()).toEqual({ "WIDGET@Auckland": ["13", "83.57"], "WIDGET@Dunedin": ["6", "30.00"] });
    await w.assertTies();
  });

  it("TR4: the negative stock setting applies", async () => {
    const off = await setup();
    await off.bill([["2", "5.00", "Dunedin"]]);
    await expect(off.transfer("3", "Dunedin", "Auckland")).rejects.toThrow("Only 2 on hand");
    expect(await off.stock()).toEqual({ "WIDGET@Dunedin": ["2", "10.00"] });

    const on = await setup({ locations: true, negative: true });
    await on.bill([["2", "5.00", "Dunedin"]]);
    expect((await on.transfer("3", "Dunedin", "Auckland")).transfer.value).toBe("15.00");
    expect(await on.stock()).toEqual({ "WIDGET@Auckland": ["3", "15.00"], "WIDGET@Dunedin": ["-1", "-5.00"] });
    await on.assertTies();
    // Into a location below zero: only a bill costs the shortfall (ST10).
    await expect(on.transfer("1", "Auckland", "Dunedin")).rejects.toThrow("Dunedin is below zero");
  });

  it("TR5: refusals", async () => {
    const w = await setup();
    await w.bill([["10", "5.00", "Dunedin"]]);
    await expect(w.transfer("1", "Dunedin", "Dunedin")).rejects.toThrow("two different locations");
    await expect(w.transfer("0", "Dunedin", "Auckland")).rejects.toThrow("quantity");
    const box = await w.item({ code: "GIFTBOX", name: "Gift box", itemType: "non_stock", salePrice: "4", purchasePrice: "2", purchaseAccountCode: "5100" });
    await expect(w.transfer("1", "Dunedin", "Auckland", { itemId: box.id })).rejects.toThrow("isn't a stock item");
    await expect(w.transfer("1", "Dunedin", "Auckland", { transferDate: "2026-05-31" })).rejects.toThrow("Backdated stock movements aren't supported yet");
    await w.as((tx) => updateTrackingValue(tx, w.loc.Christchurch, { isActive: false }));
    await expect(w.transfer("1", "Dunedin", "Christchurch")).rejects.toThrow("Christchurch is archived");
    await w.as((tx) => updatePeriodControls(tx, { lockDate: "2026-06-30" }));
    await expect(w.transfer("1", "Dunedin", "Auckland", { transferDate: "2026-06-20" })).rejects.toThrow(/lock/i);
    expect(await w.stock()).toEqual({ "WIDGET@Dunedin": ["10", "50.00"] });
    expect((await w.as((tx) => listTransfers(tx))).transfers).toEqual([]);

    const none = await setup({ locations: false });
    await expect(
      none.as((tx) =>
        transferStock(tx, {
          idempotencyKey: key("tr"),
          transferDate: "2026-06-15",
          itemId: none.widget.id,
          fromLocationValueId: "1",
          toLocationValueId: "2",
          quantity: "1",
          reference: "X",
        }),
      ),
    ).rejects.toThrow("There are no locations yet");
  });

  it("TR6: retries, voiding the bill afterwards, and roles", async () => {
    const w = await setup();
    const bought = await w.bill([["10", "5.00", "Dunedin"]]);
    const retryKey = key("tr");
    const first = await w.transfer("4", "Dunedin", "Auckland", { idempotencyKey: retryKey });
    const again = await w.transfer("4", "Dunedin", "Auckland", { idempotencyKey: retryKey });
    expect([first.created, again.created, again.transfer.id]).toEqual([true, false, first.transfer.id]);
    await expect(w.transfer("5", "Dunedin", "Auckland", { idempotencyKey: retryKey })).rejects.toThrow("idempotency key");
    expect(await w.stock()).toEqual({ "WIDGET@Auckland": ["4", "20.00"], "WIDGET@Dunedin": ["6", "30.00"] });
    // The bill's stock has moved since, so it can't be voided (ST4's rule).
    await expect(w.as((tx) => voidBill(tx, bought.id, { idempotencyKey: key("v"), voidDate: "2026-06-16" }))).rejects.toThrow("has moved since");

    const cookie = await sessionCookieFor(viewer);
    const list = await transfersRoute.GET(apiRequest(`/api/inventory/transfers?organisationId=${w.org}`, { cookie }), noContext);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { transfers: unknown[] }).transfers).toHaveLength(1);
    const post = await transfersRoute.POST(
      apiRequest("/api/inventory/transfers", {
        method: "POST",
        cookie,
        body: {
          organisationId: w.org,
          idempotencyKey: key("tr"),
          transferDate: "2026-06-15",
          itemId: w.widget.id,
          fromLocationValueId: w.loc.Dunedin,
          toLocationValueId: w.loc.Auckland,
          quantity: "1",
          reference: "X",
        },
      }),
      noContext,
    );
    expect(post.status).toBe(403);
    await w.assertTies();
  });
});
