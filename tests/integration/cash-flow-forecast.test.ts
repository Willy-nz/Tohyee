import { afterAll, beforeAll, expect, it } from "vitest";
import * as forecastRoute from "@/app/api/cash-flow/route";
import * as itemsRoute from "@/app/api/cash-flow/items/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount } from "@/lib/bank/accounts";
import { approveBill, createBill } from "@/lib/bills/service";
import { cashFlowForecast, createCashFlowItem, forecastPeriods, listCashFlowItems, removeCashFlowItem, setCashFlowAverages, updateCashFlowItem } from "@/lib/cash-flow/forecast";
import type { CashFlowForecast } from "@/lib/cash-flow/types";
import { createContact, type Contact } from "@/lib/contacts/service";
import { createPaymentTerm } from "@/lib/customers/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveExpenseClaim, createExpenseClaim, submitExpenseClaim } from "@/lib/expense-claims/service";
import { addExchangeRates } from "@/lib/fx/rates";
import { approveInvoice, createInvoice, voidInvoice } from "@/lib/invoices/service";
import { recordPayment } from "@/lib/invoices/payments";
import { postJournal } from "@/lib/ledger/journals";
import { approvePurchaseOrder, createPurchaseOrder } from "@/lib/purchase-orders/service";
import { createRepeatingBill, setRepeatingBillStatus } from "@/lib/repeating/bills";
import { createRepeatingInvoice } from "@/lib/repeating/service";
import { approveSalesOrder, createSalesOrder, invoiceSalesOrder } from "@/lib/sales-orders/service";
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
const TODAY = "2026-10-05";

/**
 * Examples CF1-CF9 in docs/ACCOUNTING-EXAMPLES.md ("Cash flow forecast").
 * Kowhai Ltd, NZD, today Monday 5 Oct 2026; 1000 Business account
 * 12,000.00 and 1010 Savings 5,000.00. Jess is the owner, Mere a
 * bookkeeper, Vic a viewer. Each test gets its own organisation.
 */
describeWithDatabase("cash flow forecast (CF1-CF9)", () => {
  let server: TestServer;
  let jess: SessionUser;
  let mere: SessionUser;
  let vic: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    jess = await createTestUser("cf-jess@example.com", { serverAdmin: true, displayName: "Jess" });
    mere = await createTestUser("cf-mere@example.com", { displayName: "Mere" });
    vic = await createTestUser("cf-vic@example.com", { displayName: "Vic" });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `cf-${organisations}-co`;
    await createTestOrganisation(jess, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'viewer')", [org, mere.id, vic.id]);
    const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
    const run = <T>(work: (tx: OrgTx) => Promise<T>) => as(jess, work);
    await run((tx) => createBankAccount(tx, { code: "1010", name: "Savings", accountType: "bank" }));
    const journal = (postingDate: string, lines: Array<{ accountCode: string; debitAmount?: string; creditAmount?: string }>) =>
      run((tx) => postJournal(tx, { idempotencyKey: key("j"), postingDate, reference: "Setup", lines }));
    await journal("2026-09-01", [
      { accountCode: "1000", debitAmount: "12000.00" },
      { accountCode: "1010", debitAmount: "5000.00" },
      { accountCode: "3000", creditAmount: "17000.00" },
    ]);
    await run((tx) => addExchangeRates(tx, { idempotencyKey: key("rate"), rates: [{ currencyCode: "USD", effectiveDate: "2026-10-01", rate: "1.65" }] }));
    const contact = (name: string, extra: Record<string, unknown> = {}) =>
      run(async (tx) => (await createContact(tx, { idempotencyKey: key("c"), name, isCustomer: true, isSupplier: true, ...extra })).contact);
    const people = {
      aroha: await contact("Aroha Cafe"),
      kobe: await contact("Kobe Ltd"),
      pacific: await contact("Pacific Co", { currencyCode: "USD" }),
      tui: await contact("Tui Ltd"),
      kauri: await contact("Kauri"),
    };
    const invoice = async (to: Contact, invoiceDate: string, dueDate: string, unitPrice: string, options: { approve?: boolean; taxCode?: string | null } = {}) => {
      const draft = (
        await run((tx) =>
          createInvoice(
            tx,
            {
              idempotencyKey: key("inv"),
              contactId: to.id,
              invoiceDate,
              dueDate,
              amountsMode: options.taxCode === null ? "no_tax" : "exclusive",
              lines: [{ description: "Work", quantity: "1", unitPrice, accountCode: "4000", ...(options.taxCode === null ? {} : { taxCode: options.taxCode ?? "GST" }) }],
            },
            { foreignCurrency: true },
          ),
        )
      ).invoice;
      return options.approve === false ? draft : (await run((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("ai") }))).invoice;
    };
    const bill = async (number: string, dueDate: string, unitPrice: string) => {
      const draft = (
        await run((tx) =>
          createBill(tx, {
            idempotencyKey: key("bill"),
            contactId: people.kauri.id,
            billDate: "2026-09-25",
            dueDate,
            supplierInvoiceNumber: number,
            amountsMode: "exclusive",
            lines: [{ description: "Supplies", quantity: "1", unitPrice, accountCode: "6010", taxCode: "GST" }],
          }),
        )
      ).bill;
      return (await run((tx) => approveBill(tx, draft.id, { idempotencyKey: key("ab"), approveDespiteWarnings: true }))).bill;
    };
    const forecast = (options: Record<string, unknown> = {}) => run((tx) => cashFlowForecast(tx, { today: TODAY, ...options }));
    return { org, as, run, journal, people, invoice, bill, forecast };
  }

  /** CF1-CF4: the documents and the forecast item. */
  async function books() {
    const w = await setup();
    const { people } = w;
    await w.invoice(people.aroha, "2026-09-01", "2026-09-30", "2000.00");
    await w.invoice(people.kobe, "2026-10-01", "2026-10-15", "1000.00");
    await w.invoice(people.pacific, "2026-10-01", "2026-10-20", "1000.00", { taxCode: null });
    const tui = await w.invoice(people.tui, "2026-10-01", "2026-10-31", "2000.00", { taxCode: null });
    await w.run((tx) => recordPayment(tx, tui.id, { idempotencyKey: key("pay"), paymentDate: "2026-10-02", amount: "500.00", bankAccountCode: "1000" }));
    // A voided invoice and a paid one aren't in it.
    const voided = await w.invoice(people.kobe, "2026-10-01", "2026-10-10", "300.00");
    await w.run((tx) => voidInvoice(tx, voided.id, { idempotencyKey: key("void"), voidDate: "2026-10-02" }));
    const paid = await w.invoice(people.kobe, "2026-10-01", "2026-10-10", "100.00");
    await w.run((tx) => recordPayment(tx, paid.id, { idempotencyKey: key("pay"), paymentDate: "2026-10-02", amount: "115.00", bankAccountCode: "1000" }));
    // The payments went into 1000, so put its balance back to 12,000.00.
    await w.journal("2026-10-02", [
      { accountCode: "3000", debitAmount: "615.00" },
      { accountCode: "1000", creditAmount: "615.00" },
    ]);
    await w.bill("K-301", "2026-10-09", "400.00");
    await w.bill("K-300", "2026-10-20", "1000.00");
    const claim = await w.as(mere, async (tx) =>
      submitExpenseClaim(
        tx,
        (
          await createExpenseClaim(tx, {
            idempotencyKey: key("claim"),
            receipts: [{ receiptDate: "2026-10-01", supplierName: "Noel Leeming", description: "Monitor", accountCode: "6140", taxCode: "GST", amount: "345.00", supplierGstNumber: "123-456-789" }],
          })
        ).claim.id,
      ),
    );
    await w.run((tx) => approveExpenseClaim(tx, "owner", claim.id, { idempotencyKey: key("ac"), claimDate: "2026-10-02" }));
    await w.run((tx) =>
      createRepeatingInvoice(tx, {
        idempotencyKey: key("ri"),
        contactId: people.aroha.id,
        amountsMode: "exclusive",
        lines: [{ description: "Monthly supply", quantity: "1", unitPrice: "500.00", accountCode: "4000", taxCode: "GST" }],
        period: "month",
        every: 1,
        startDate: "2026-11-01",
        dueRule: "days_after",
        dueDays: 20,
        saveAs: "draft",
      }),
    );
    await w.run((tx) =>
      createRepeatingBill(tx, {
        idempotencyKey: key("rb"),
        contactId: people.kauri.id,
        supplierInvoiceNumber: "RENT-{date}",
        amountsMode: "exclusive",
        lines: [{ description: "Rent", quantity: "1", unitPrice: "2000.00", accountCode: "6010", taxCode: "GST" }],
        period: "month",
        every: 1,
        startDate: "2026-11-01",
        dueRule: "days_after",
        dueDays: 0,
        saveAs: "draft",
      }),
    );
    const gst = await w.as(mere, (tx) => createCashFlowItem(tx, { direction: "out", description: "GST payment", amount: "3200.00", date: "2026-10-28" }));
    return { ...w, gst };
  }

  const summary = (forecast: CashFlowForecast) => forecast.periods.map((period) => [period.start, period.moneyIn, period.moneyOut, period.closing]);
  const linesOf = (forecast: CashFlowForecast, index: number) => forecast.periods[index].lines.map((line) => [line.direction, line.label, line.baseAmount, line.overdue]);

  it("periods: weeks from this Monday, days from today, months from the 1st", () => {
    expect(forecastPeriods(TODAY, "week", 2)).toEqual([
      { start: "2026-10-05", end: "2026-10-11" },
      { start: "2026-10-12", end: "2026-10-18" },
    ]);
    expect(forecastPeriods("2026-10-07", "week", 1)).toEqual([{ start: "2026-10-05", end: "2026-10-11" }]);
    expect(forecastPeriods("2026-10-04", "week", 1)).toEqual([{ start: "2026-09-28", end: "2026-10-04" }]);
    expect(forecastPeriods(TODAY, "day", 2)).toEqual([
      { start: "2026-10-05", end: "2026-10-05" },
      { start: "2026-10-06", end: "2026-10-06" },
    ]);
    expect(forecastPeriods(TODAY, "month", 4).map((period) => `${period.start}..${period.end}`)).toEqual([
      "2026-10-01..2026-10-31",
      "2026-11-01..2026-11-30",
      "2026-12-01..2026-12-31",
      "2027-01-01..2027-01-31",
    ]);
  });

  it("CF1-CF5: invoices, bills, claims, repeating documents and a forecast item, week by week", async () => {
    const w = await books();
    const forecast = await w.forecast();
    expect([forecast.opening, forecast.accounts.map((account) => [account.code, account.balance])]).toEqual([
      "17000.00",
      [
        ["1000", "12000.00"],
        ["1010", "5000.00"],
      ],
    ]);
    expect(linesOf(forecast, 0)).toEqual([
      ["in", "INV-0001 Aroha Cafe", "2300.00", true],
      ["out", `CLAIM-${forecast.periods[0].lines.find((line) => line.source === "expense_claim")!.id} Mere`, "345.00", false],
      ["out", "K-301 Kauri", "460.00", false],
    ]);
    expect(linesOf(forecast, 2)).toEqual([
      ["in", "INV-0003 Pacific Co", "1650.00", false],
      ["out", "K-300 Kauri", "1150.00", false],
    ]);
    expect(forecast.periods[2].lines[0]).toMatchObject({ currencyCode: "USD", amount: "1000.00" });
    expect(linesOf(forecast, 3)).toEqual([
      ["in", "INV-0004 Tui Ltd", "1500.00", false],
      ["out", "GST payment", "3200.00", false],
      ["out", "Repeating bill from Kauri, 2026-11-01", "2300.00", false],
    ]);
    expect(summary(forecast)).toEqual([
      ["2026-10-05", "2300.00", "805.00", "18495.00"],
      ["2026-10-12", "1150.00", "0.00", "19645.00"],
      ["2026-10-19", "1650.00", "1150.00", "20145.00"],
      ["2026-10-26", "1500.00", "5500.00", "16145.00"],
      ["2026-11-02", "0.00", "0.00", "16145.00"],
      ["2026-11-09", "0.00", "0.00", "16145.00"],
      ["2026-11-16", "575.00", "0.00", "16720.00"],
      ["2026-11-23", "0.00", "0.00", "16720.00"],
      ["2026-11-30", "0.00", "2300.00", "14420.00"],
      ["2026-12-07", "0.00", "0.00", "14420.00"],
      ["2026-12-14", "0.00", "0.00", "14420.00"],
      ["2026-12-21", "575.00", "0.00", "14995.00"],
      ["2026-12-28", "0.00", "2300.00", "12695.00"],
    ]);
    expect([forecast.lowest, forecast.firstBelowZero, forecast.excluded]).toEqual([{ index: 12, closing: "12695.00" }, null, []]);
    // By month, October: in 6,600.00, out 5,155.00 (rent on 1 Nov is in November).
    const months = await w.forecast({ period: "month" });
    expect(summary(months)[0]).toEqual(["2026-10-01", "6600.00", "5155.00", "18445.00"]);
    // Only the chosen accounts start it.
    const savings = await w.forecast({ accountIds: months.availableAccounts.find((account) => account.code === "1010")!.id });
    expect(savings.opening).toBe("5000.00");
  });

  it("CF3: a paused repeating bill isn't in it; one that ends on 30 Nov only gives 1 Nov", async () => {
    const w = await setup();
    const rent = (endDate: string | null) =>
      w.run((tx) =>
        createRepeatingBill(tx, {
          idempotencyKey: key("rb"),
          contactId: w.people.kauri.id,
          supplierInvoiceNumber: `R${Math.random().toString(36).slice(2, 6)}-{date}`,
          amountsMode: "no_tax",
          lines: [{ description: "Rent", quantity: "1", unitPrice: "100.00", accountCode: "6010" }],
          period: "month",
          every: 1,
          startDate: "2026-11-01",
          endDate,
          dueRule: "days_after",
          dueDays: 0,
          saveAs: "draft",
        }),
      );
    const paused = (await rent(null)).repeatingBill;
    await w.run((tx) => setRepeatingBillStatus(tx, paused.id, "paused", TODAY));
    await rent("2026-11-30");
    const forecast = await w.forecast();
    expect(forecast.periods.flatMap((period) => period.lines.map((line) => [line.date, line.baseAmount]))).toEqual([["2026-11-01", "100.00"]]);
  });

  it("CF4: forecast items are added, changed and removed by bookkeepers, with their history", async () => {
    const w = await books();
    await expect(w.as(mere, (tx) => createCashFlowItem(tx, { direction: "out", description: "", amount: "1", date: TODAY }))).rejects.toThrow("The description is required.");
    await expect(w.as(mere, (tx) => createCashFlowItem(tx, { direction: "out", description: "X", amount: "0", date: TODAY }))).rejects.toThrow("The amount must not be zero.");
    await expect(w.as(mere, (tx) => createCashFlowItem(tx, { direction: "out", description: "X", amount: "1", date: TODAY, repeat: "week", untilDate: "2026-10-01" }))).rejects.toThrow(
      "The until date can't be before the date.",
    );
    const changed = await w.as(jess, (tx) => updateCashFlowItem(tx, w.gst.id, { ...w.gst, amount: "3300.00", version: w.gst.version }));
    expect([changed.amount, changed.updatedByEmail, changed.version]).toEqual(["3300.00", jess.email, 2]);
    await expect(w.as(jess, (tx) => updateCashFlowItem(tx, w.gst.id, { ...w.gst, version: 1 }))).rejects.toThrow("Someone else changed this forecast item");
    // Wages each Wednesday from 7 Oct until 21 Oct: three weeks.
    await w.as(mere, (tx) => createCashFlowItem(tx, { direction: "out", description: "Wages", amount: "1000.00", date: "2026-10-07", repeat: "week", untilDate: "2026-10-21" }));
    const forecast = await w.forecast();
    expect(forecast.periods.slice(0, 4).map((period) => period.lines.filter((line) => line.label === "Wages").length)).toEqual([1, 1, 1, 0]);
    await w.as(mere, (tx) => removeCashFlowItem(tx, w.gst.id));
    expect((await w.run((tx) => listCashFlowItems(tx))).map((item) => item.description)).toEqual(["Wages"]);
    const history = await w.run((tx) => tx.query<{ event_type: string; actor_email: string }>("select event_type, actor_email from audit_events where entity_type = 'cash_flow_item' and entity_id = $1 order by id", [w.gst.id]));
    expect(history.rows.map((row) => [row.event_type, row.actor_email])).toEqual([
      ["cash_flow_item.created", mere.email],
      ["cash_flow_item.updated", jess.email],
      ["cash_flow_item.removed", mere.email],
    ]);
  });

  it("CF6: 6200 Wages from its 3-month average: 2,800.00 a week, below zero in week 6", async () => {
    const w = await books();
    for (const [date, amount] of [
      ["2026-07-15", "12000.00"],
      ["2026-08-15", "12400.00"],
      ["2026-09-15", "12400.00"],
    ]) {
      await w.journal(date, [
        { accountCode: "6200", debitAmount: amount },
        { accountCode: "3000", creditAmount: amount },
      ]);
    }
    const wages = (await w.run((tx) => tx.query<{ id: string }>("select id::text from accounts where code = '6200'"))).rows[0].id;
    await expect(w.as(mere, (tx) => setCashFlowAverages(tx, [{ accountId: wages, direction: "out", months: 4 }]))).rejects.toThrow("An average is over the last 3 or 6 months.");
    const bank = (await w.run((tx) => tx.query<{ id: string }>("select id::text from accounts where code = '1000'"))).rows[0].id;
    await expect(w.as(mere, (tx) => setCashFlowAverages(tx, [{ accountId: bank, direction: "out", months: 3 }]))).rejects.toThrow("1000 can't be averaged");
    await w.as(mere, (tx) => setCashFlowAverages(tx, [{ accountId: wages, direction: "out", months: 3 }]));
    const forecast = await w.forecast();
    expect(forecast.periods.map((period) => period.lines.find((line) => line.source === "average")?.baseAmount)).toEqual(Array(13).fill("2800.00"));
    expect([forecast.periods[12].closing, forecast.firstBelowZero, forecast.periods[5].closing, forecast.lowest]).toEqual(["-23705.00", 5, "-655.00", { index: 12, closing: "-23705.00" }]);
    expect((await w.forecast({ period: "month" })).periods[0].lines.find((line) => line.source === "average")?.baseAmount).toBe("12400.00");
  });

  it("CF7: approved sales and purchase orders, for what's not yet invoiced or billed, plus payment terms", async () => {
    const w = await setup();
    const setup20th = await w.run((tx) => createPaymentTerm(tx, { name: "20th of next month", kind: "day_of_next_month", days: 20 }));
    const fourteen = await w.run((tx) => createPaymentTerm(tx, { name: "Fourteen days", kind: "days_after_invoice", days: 14 }));
    await w.run((tx) => tx.query("update contacts set payment_term_id = $2 where id = $1", [w.people.kobe.id, setup20th.paymentTerms.at(-1)!.id]));
    await w.run((tx) => tx.query("update contacts set supplier_payment_term_id = $2 where id = $1", [w.people.kauri.id, fourteen.paymentTerms.at(-1)!.id]));
    const order = (
      await w.run((tx) =>
        createSalesOrder(tx, {
          idempotencyKey: key("so"),
          contactId: w.people.kobe.id,
          orderDate: "2026-09-20",
          expectedDate: "2026-10-01",
          amountsMode: "exclusive",
          lines: [{ description: "Chairs", quantity: "2", unitPrice: "1000.00", accountCode: "4000", taxCode: "GST" }],
        }),
      )
    ).salesOrder;
    const approvedOrder = (await w.run((tx) => approveSalesOrder(tx, order.id, { idempotencyKey: key("aso") }))).salesOrder;
    await w.run((tx) => invoiceSalesOrder(tx, order.id, { idempotencyKey: key("iso"), invoiceDate: "2026-10-02", lines: [{ salesOrderLineId: approvedOrder.lines[0].id, quantity: "1" }] }));
    const po = (
      await w.run((tx) =>
        createPurchaseOrder(tx, {
          idempotencyKey: key("po"),
          contactId: w.people.kauri.id,
          orderDate: "2026-10-01",
          deliveryDate: "2026-10-14",
          amountsMode: "exclusive",
          lines: [{ description: "Fabric", quantity: "1", unitPrice: "800.00", accountCode: "6010", taxCode: "GST" }],
        }),
      )
    ).purchaseOrder;
    await w.run((tx) => approvePurchaseOrder(tx, po.id, { idempotencyKey: key("apo") }));
    expect((await w.forecast()).periods.every((period) => period.lines.length === 0)).toBe(true);
    const forecast = await w.forecast({ includeOrders: true });
    const all = forecast.periods.flatMap((period, index) => period.lines.map((line) => [index + 1, line.source, line.date, line.baseAmount, line.fromOrder]));
    expect(all).toEqual([
      [4, "purchase_order", "2026-10-28", "920.00", true],
      [7, "sales_order", "2026-11-20", "1150.00", true],
    ]);
  });

  it("CF8: drafts are marked; an amount with no exchange rate is left out and listed", async () => {
    const w = await setup();
    await w.invoice(w.people.kobe, TODAY, "2026-10-08", "347.83", { approve: false, taxCode: "GST" });
    const gbp = await w.run(async (tx) => (await createContact(tx, { idempotencyKey: key("c"), name: "Bristol Ltd", isCustomer: true, currencyCode: "GBP" })).contact);
    await w.run((tx) =>
      createInvoice(
        tx,
        {
          idempotencyKey: key("inv"),
          contactId: gbp.id,
          invoiceDate: TODAY,
          dueDate: "2026-10-20",
          amountsMode: "no_tax",
          lines: [{ description: "Work", quantity: "1", unitPrice: "300.00", accountCode: "4000" }],
          exchangeRate: "2.1",
        },
        { foreignCurrency: true },
      ),
    );
    expect((await w.forecast()).periods[0].lines).toEqual([]);
    const forecast = await w.forecast({ includeDrafts: true });
    expect(forecast.periods[0].lines.map((line) => [line.label, line.baseAmount, line.draft])).toEqual([["Draft invoice Kobe Ltd", "400.00", true]]);
    expect(forecast.excluded).toEqual([{ label: "Draft invoice Bristol Ltd (GBP 300.00)", reason: "no GBP exchange rate to convert it" }]);
  });

  it("CF9: viewers see it; only bookkeepers add forecast items", async () => {
    const w = await books();
    const seen = await forecastRoute.GET(apiRequest(`/api/cash-flow?organisationId=${w.org}&period=month&count=2`, { cookie: await sessionCookieFor(vic) }), noContext);
    expect(seen.status).toBe(200);
    expect(((await seen.json()) as { forecast: CashFlowForecast }).forecast.periods).toHaveLength(2);
    const refused = await itemsRoute.POST(
      apiRequest("/api/cash-flow/items", { method: "POST", cookie: await sessionCookieFor(vic), body: { organisationId: w.org, direction: "in", description: "Grant", amount: "100", date: TODAY } }),
      noContext,
    );
    expect(refused.status).toBe(403);
    await expect(w.forecast({ period: "week", count: 53 })).rejects.toThrow("Show 1 to 52 weeks.");
  });
});
