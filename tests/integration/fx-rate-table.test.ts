import { afterAll, beforeAll, expect, it } from "vitest";
import * as archiveRoute from "@/app/api/fx/rates/[exchangeRateId]/archive/route";
import * as ratesRoute from "@/app/api/fx/rates/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine } from "@/lib/bank/reconcile";
import { approveBill, createBill, getBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { rateInEffect } from "@/lib/fx/rate-text";
import { addExchangeRates, archiveExchangeRate, listExchangeRates } from "@/lib/fx/rates";
import { recordPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, getInvoice } from "@/lib/invoices/service";
import { lastRateFor } from "@/lib/ledger/foreign";
import { getJournal } from "@/lib/ledger/journals";
import { approvePurchaseOrder, copyPurchaseOrderToBill, createPurchaseOrder } from "@/lib/purchase-orders/service";
import { acceptQuote, createQuote, finaliseQuote } from "@/lib/quotes/service";
import { createRepeatingBill, getRepeatingBill, runRepeatingBills } from "@/lib/repeating/bills";
import { createRepeatingInvoice, getRepeatingInvoice, runRepeatingInvoices } from "@/lib/repeating/service";
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

/**
 * Examples MC46-MC53 in docs/ACCOUNTING-EXAMPLES.md (the currency exchange
 * rates list, not yet approved by Jess), one organisation worked through in
 * order: 1000 (NZD), 1030 USD account, 1100, 2000, 4000, 6040, 7020;
 * customer Acme Inc (USD), suppliers Amazon Web Services (USD) and Bristol
 * Ltd (GBP).
 */
describeWithDatabase("currency exchange rates list", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  const ORG = "fxr-co";
  let acme: Contact;
  let aws: Contact;
  let bristol: Contact;
  const invoices: Record<string, string> = {};
  let correctionId: string;

  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => as(bookkeeper, work);
  const posted = async (journalId: string) =>
    (await run((tx) => getJournal(tx, journalId))).lines.map((line) => [
      line.accountCode,
      line.debitAmount,
      line.creditAmount,
      ...(line.foreign ? [`${line.foreign.currencyCode} ${line.foreign.amount} ${line.foreign.kind}`] : []),
    ]);
  const add = (rates: Array<{ currencyCode: string; effectiveDate: string; rate: string; note?: string }>, idempotencyKey = key("rate")) =>
    run((tx) => addExchangeRates(tx, { idempotencyKey, rates }));
  const invoice = async (name: string, invoiceDate: string, amount: string, exchangeRate?: string) => {
    const draft = await run((tx) =>
      createInvoice(
        tx,
        {
          idempotencyKey: key("inv"),
          contactId: acme.id,
          invoiceDate,
          dueDate: "2026-09-30",
          amountsMode: "exclusive",
          lines: [{ description: "Consulting", quantity: "1", unitPrice: amount, accountCode: "4000", taxCode: "ZERO" }],
          ...(exchangeRate ? { exchangeRate } : {}),
        },
        { foreignCurrency: true },
      ),
    );
    const approved = (await run((tx) => approveInvoice(tx, draft.invoice.id, { idempotencyKey: key("approve") }))).invoice;
    invoices[name] = approved.id;
    return approved;
  };
  const bill = (contact: Contact, number: string, billDate: string, amount: string, exchangeRate?: string) =>
    run((tx) =>
      createBill(
        tx,
        {
          idempotencyKey: key("bill"),
          contactId: contact.id,
          billDate,
          dueDate: "2026-09-30",
          supplierInvoiceNumber: number,
          amountsMode: "no_tax",
          lines: [{ description: "Parts", quantity: "1", unitPrice: amount, accountCode: "6040" }],
          ...(exchangeRate ? { exchangeRate } : {}),
        },
        null,
        { foreignCurrency: true },
      ),
    );

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("fxr-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("fxr-bookkeeper@example.com");
    viewer = await createTestUser("fxr-viewer@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'viewer')", [
      ORG,
      bookkeeper.id,
      viewer.id,
    ]);
    await as(owner, (tx) => createBankAccount(tx, { code: "1030", name: "USD account", accountType: "bank", currencyCode: "USD" }));
    acme = (await run((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Acme Inc", isCustomer: true, currencyCode: "USD" }))).contact;
    aws = (await run((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Amazon Web Services", isSupplier: true, currencyCode: "USD" })))
      .contact;
    bristol = (await run((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Bristol Ltd", isSupplier: true, currencyCode: "GBP" }))).contact;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("MC46: bookkeepers add rates with an effective date; wrong ones are refused; retries are idempotent", async () => {
    const one = (currencyCode: string, effectiveDate: string, rate: string) => add([{ currencyCode, effectiveDate, rate }]);
    await expect(one("NZD", "2026-07-01", "1")).rejects.toThrow(/NZD is the base currency, so it has no exchange rate/);
    await expect(one("XYZ", "2026-07-01", "1.6")).rejects.toThrow(/The currency must be one of/);
    await expect(one("USD", "2026-07-01", "0")).rejects.toThrow(/The rate must not be zero/);
    await expect(one("USD", "2026-07-01", "1.123456789")).rejects.toThrow(/The rate can have at most 8 decimal places/);
    await expect(one("USD", "2026-02-30", "1.6")).rejects.toThrow(/The effective date is not a real date/);

    // A viewer can't add rates; a bookkeeper can (through the API as the screen does).
    const body = { organisationId: ORG, idempotencyKey: key("api"), rates: [{ currencyCode: "USD", effectiveDate: "2026-07-01", rate: "1.60", note: "RBNZ" }] };
    const viewerCookie = await sessionCookieFor(viewer);
    expect((await ratesRoute.POST(apiRequest("/api/fx/rates", { method: "POST", cookie: viewerCookie, body }), undefined as unknown)).status).toBe(403);
    const created = await ratesRoute.POST(apiRequest("/api/fx/rates", { method: "POST", cookie: await sessionCookieFor(bookkeeper), body }), undefined as unknown);
    expect(created.status).toBe(201);
    const usdJuly = ((await created.json()) as { added: Array<{ id: string; rate: string; createdByEmail: string }> }).added[0];
    expect(usdJuly).toMatchObject({ rate: "1.6", createdByEmail: "fxr-bookkeeper@example.com" });

    const aug = key("aug");
    const first = await add([{ currencyCode: "usd", effectiveDate: "2026-08-01", rate: "1.65" }], aug);
    expect(first.created).toBe(true);
    // The same key again returns what was added; with a different rate it's refused.
    const again = await add([{ currencyCode: "USD", effectiveDate: "2026-08-01", rate: "1.65" }], aug);
    expect(again).toMatchObject({ created: false, added: [{ id: first.added[0].id }] });
    await expect(add([{ currencyCode: "USD", effectiveDate: "2026-08-01", rate: "1.66" }], aug)).rejects.toThrow(/idempotency key was already used/);
    await add([{ currencyCode: "EUR", effectiveDate: "2026-07-01", rate: "1.80" }]);

    const list = await run((tx) => listExchangeRates(tx, { today: "2026-07-15" }));
    expect(list.rates.map((rate) => [rate.currencyCode, rate.effectiveDate, rate.rate, rate.note])).toEqual([
      ["USD", "2026-08-01", "1.65", null],
      ["EUR", "2026-07-01", "1.8", null],
      ["USD", "2026-07-01", "1.6", "RBNZ"],
    ]);
    expect(list.current.map((entry) => [entry.currencyCode, entry.rate?.rate ?? null])).toEqual([
      ["EUR", "1.8"],
      ["GBP", null],
      ["USD", "1.6"],
    ]);
    const audit = await run((tx) =>
      tx.query<{ event_type: string; actor_email: string }>("select event_type, actor_email from audit_events where entity_type = 'exchange_rate' and entity_id = $1", [usdJuly.id]),
    );
    expect(audit.rows).toEqual([{ event_type: "exchange_rate.added", actor_email: "fxr-bookkeeper@example.com" }]);
  });

  it("MC47: a correction is a newer entry for the same date, or archiving the wrong one; nothing is changed or deleted", async () => {
    const corrected = await add([{ currencyCode: "USD", effectiveDate: "2026-08-01", rate: "1.66", note: "typo" }]);
    correctionId = corrected.added[0].id;
    expect((await run((tx) => lastRateFor(tx, "USD", "2026-08-15")))?.rate).toBe("1.66");
    // Archived through the API by a bookkeeper; a viewer can't.
    const body = { organisationId: ORG };
    expect(
      (await archiveRoute.POST(apiRequest(`/api/fx/rates/${correctionId}/archive`, { method: "POST", cookie: await sessionCookieFor(viewer), body }), params({ exchangeRateId: correctionId })))
        .status,
    ).toBe(403);
    const archived = await archiveRoute.POST(
      apiRequest(`/api/fx/rates/${correctionId}/archive`, { method: "POST", cookie: await sessionCookieFor(bookkeeper), body }),
      params({ exchangeRateId: correctionId }),
    );
    expect(archived.status).toBe(200);
    expect(await run((tx) => lastRateFor(tx, "USD", "2026-08-15"))).toEqual({ rate: "1.65", date: "2026-08-01", source: "list" });
    await expect(run((tx) => archiveExchangeRate(tx, correctionId))).rejects.toThrow(/already archived/);
    const all = await run((tx) => listExchangeRates(tx, { includeArchived: true }));
    expect(all.rates.find((rate) => rate.id === correctionId)).toMatchObject({ rate: "1.66", archivedByEmail: "fxr-bookkeeper@example.com" });
    expect((await run((tx) => listExchangeRates(tx))).rates.some((rate) => rate.id === correctionId)).toBe(false);
    // The database refuses changes, deletes and un-archiving.
    await expect(run((tx) => tx.query("update currency_exchange_rates set rate = 1.7 where id = $1", [correctionId]))).rejects.toThrow(/can't be changed/);
    await expect(run((tx) => tx.query("update currency_exchange_rates set archived_at = null where id = $1", [correctionId]))).rejects.toThrow(/can't be changed/);
    await expect(run((tx) => tx.query("delete from currency_exchange_rates where id = $1", [correctionId]))).rejects.toThrow(/can't be deleted/);
    await expect(run((tx) => tx.query("truncate currency_exchange_rates"))).rejects.toThrow(/can't be deleted/);
    await expect(
      run((tx) =>
        tx.query(
          "insert into currency_exchange_rates (command_source, idempotency_key, line_number, request_hash, currency_code, effective_date, rate) values ('api', 'x', 1, 'x', 'NZD', '2026-07-01', 1)",
        ),
      ),
    ).rejects.toThrow(/for foreign currencies, not NZD/);
  });

  it("MC48: a new document takes the list's rate effective on its date, before the last rate used; a typed rate still wins", async () => {
    // Typed 1.70 on 10 Jul: that's the last USD rate used from then on.
    expect((await invoice("INV-0001", "2026-07-10", "1000.00", "1.70")).baseTotal).toBe("1700.00");
    expect(await run((tx) => lastRateFor(tx, "USD", "2026-07-15"))).toEqual({ rate: "1.6", date: "2026-07-01", source: "list" });
    const second = await invoice("INV-0002", "2026-07-15", "500.00");
    expect(second).toMatchObject({ exchangeRate: "1.6", baseTotal: "800.00" });
    expect(await posted(second.approvalJournalId!)).toEqual([
      ["1100", "800.00", "0.00", "USD 500.00 document"],
      ["4000", "0.00", "800.00"],
    ]);
    expect(await invoice("INV-0003", "2026-08-05", "200.00")).toMatchObject({ exchangeRate: "1.65", baseTotal: "330.00" });
    expect(await invoice("INV-0004", "2026-08-06", "100.00", "1.62")).toMatchObject({ exchangeRate: "1.62", baseTotal: "162.00" });
  });

  it("MC49: with no rate in the list, the last rate used; with neither, the rate must be typed", async () => {
    await expect(bill(bristol, "BR-1", "2026-07-01", "100.00")).rejects.toThrow(
      /Type the exchange rate for this bill \(NZD per 1 GBP\): no GBP rate has been used on or before 2026-07-01 yet, and the exchange rates list \(Accounting › Exchange rates\) has none/,
    );
    const first = await bill(bristol, "BR-1", "2026-07-01", "100.00", "2.10");
    expect(first.bill).toMatchObject({ exchangeRate: "2.1", baseTotal: "210.00" });
    await run((tx) => approveBill(tx, first.bill.id, { idempotencyKey: key("approve") }));
    expect((await bill(bristol, "BR-2", "2026-07-20", "50.00")).bill).toMatchObject({ exchangeRate: "2.1", baseTotal: "105.00" });
    expect(await run((tx) => lastRateFor(tx, "GBP", "2026-07-20"))).toEqual({ rate: "2.1", date: "2026-07-01", source: "posted" });
    // USD before the list's first entry (1 Jul) and before any USD was used (10 Jul): typed.
    await expect(bill(aws, "AWS-0", "2026-06-20", "10.00")).rejects.toThrow(/no USD rate has been used on or before 2026-06-20 yet/);
  });

  it("MC50: payments and statement lines start with the list's rate too", async () => {
    const { payment } = await run((tx) =>
      recordPayment(tx, invoices["INV-0002"], { idempotencyKey: key("pay"), paymentDate: "2026-08-12", amount: "500.00", bankAccountCode: "1030" }),
    );
    expect(payment).toMatchObject({ exchangeRate: "1.65", baseAmount: "825.00", baseCleared: "800.00", realisedGain: "25.00" });
    expect(await posted(payment.journalId)).toEqual([
      ["1030", "825.00", "0.00", "USD 500.00 rate"],
      ["1100", "0.00", "800.00", "USD 500.00 carrying_value"],
      ["7020", "0.00", "25.00"],
    ]);
    const usd = (await run((tx) => tx.query<{ id: string }>("select id::text from accounts where code = '1030'"))).rows[0].id;
    await run((tx) =>
      importStatementFile(tx, usd, { idempotencyKey: key("import"), fileName: "usd.csv", fileBase64: Buffer.from("Date,Amount,Payee\n20/08/2026,100.00,ACME INC\n").toString("base64") }),
    );
    const line = (await run((tx) => listStatementLines(tx, usd, { status: "unreconciled" }))).lines[0];
    expect([line.suggestedRate, line.baseAmount]).toEqual([{ rate: "1.65", date: "2026-08-01", source: "list" }, "165.00"]);
    // Matched to INV-0003 with no rate typed: at 1.65, which is INV-0003's own, so no gain.
    await run((tx) => reconcileStatementLine(tx, line.id, { idempotencyKey: key("rec"), kind: "payments", allocations: [{ invoiceId: invoices["INV-0003"], amount: "100.00" }] }));
    expect(await run((tx) => getInvoice(tx, invoices["INV-0003"]))).toMatchObject({ amountDue: "100.00", amountDueBase: "165.00" });
  });

  it("MC51: an accepted quote and a copied purchase order take the rate for the new document's date", async () => {
    const quote = await run((tx) =>
      createQuote(tx, {
        idempotencyKey: key("quote"),
        contactId: acme.id,
        quoteDate: "2026-07-25",
        amountsMode: "exclusive",
        lines: [{ description: "Design", quantity: "1", unitPrice: "400.00", accountCode: "4000", taxCode: "ZERO" }],
      }),
    );
    await run((tx) => finaliseQuote(tx, quote.quote.id, { idempotencyKey: key("fin") }));
    const accepted = await run((tx) => acceptQuote(tx, quote.quote.id, { idempotencyKey: key("accept"), invoiceDate: "2026-08-03", dueDate: "2026-09-03" }));
    expect(accepted.invoice).toMatchObject({ status: "draft", currencyCode: "USD", exchangeRate: "1.65", baseTotal: "660.00" });
    const order = await run((tx) =>
      createPurchaseOrder(tx, {
        idempotencyKey: key("po"),
        contactId: aws.id,
        orderDate: "2026-07-25",
        amountsMode: "no_tax",
        lines: [{ description: "Reserved instances", quantity: "3", unitPrice: "20.00", accountCode: "6040" }],
      }),
    );
    await run((tx) => approvePurchaseOrder(tx, order.purchaseOrder.id, { idempotencyKey: key("appr") }));
    const copied = await run((tx) =>
      copyPurchaseOrderToBill(tx, order.purchaseOrder.id, { idempotencyKey: key("copy"), billDate: "2026-08-03", dueDate: "2026-09-03", supplierInvoiceNumber: "AWS-PO1" }),
    );
    expect(copied.bill).toMatchObject({ status: "draft", currencyCode: "USD", exchangeRate: "1.65", baseTotal: "99.00" });
  });

  it("MC52: foreign repeating documents are approved when the list has a rate for their date, else left as drafts saying why", async () => {
    const { repeatingInvoice } = await run((tx) =>
      createRepeatingInvoice(tx, {
        idempotencyKey: key("ri"),
        contactId: acme.id,
        amountsMode: "exclusive",
        lines: [{ description: "Retainer", quantity: "1", unitPrice: "100.00", accountCode: "4000", taxCode: "ZERO" }],
        period: "month",
        every: 1,
        startDate: "2026-07-31",
        dueRule: "days_after",
        dueDays: 20,
        saveAs: "approve",
      }),
    );
    expect(repeatingInvoice).toMatchObject({ currencyCode: "USD", saveAs: "approve" });
    const made = await inOrganisation(ORG, { userId: null, email: "repeating-invoices@tohyee" }, (tx) =>
      runRepeatingInvoices(tx, { today: "2026-08-31", repeatingInvoiceId: repeatingInvoice.id }),
    );
    expect(made).toEqual({ made: 2, approved: 2, refused: 0, failed: 0 });
    const runs = (await run((tx) => getRepeatingInvoice(tx, repeatingInvoice.id))).runs;
    const july = await run((tx) => getInvoice(tx, runs[1].invoiceId!));
    expect(july).toMatchObject({ status: "approved", invoiceDate: "2026-07-31", exchangeRate: "1.6", baseTotal: "160.00" });
    expect(await posted(july.approvalJournalId!)).toEqual([
      ["1100", "160.00", "0.00", "USD 100.00 document"],
      ["4000", "0.00", "160.00"],
    ]);
    expect(await run((tx) => getInvoice(tx, runs[0].invoiceId!))).toMatchObject({ status: "approved", invoiceDate: "2026-08-31", exchangeRate: "1.65", baseTotal: "165.00" });

    // GBP has no rate in the list: the bill takes the last rate used and is left as a draft, saying why.
    const { repeatingBill } = await run((tx) =>
      createRepeatingBill(tx, {
        idempotencyKey: key("rb"),
        contactId: bristol.id,
        supplierInvoiceNumber: "BR-{month}",
        amountsMode: "no_tax",
        lines: [{ description: "Parts", quantity: "1", unitPrice: "40.00", accountCode: "6040" }],
        period: "month",
        every: 1,
        startDate: "2026-07-31",
        dueRule: "days_after",
        dueDays: 14,
        saveAs: "approve",
      }),
    );
    const runBills = (today: string) =>
      inOrganisation(ORG, { userId: null, email: "repeating-bills@tohyee" }, (tx) => runRepeatingBills(tx, { today, repeatingBillId: repeatingBill.id }));
    expect(await runBills("2026-07-31")).toEqual({ made: 1, approved: 0, refused: 1, failed: 0 });
    let history = (await run((tx) => getRepeatingBill(tx, repeatingBill.id))).runs;
    expect(history[0]).toMatchObject({ scheduledDate: "2026-07-31", outcome: "approval_refused" });
    expect(history[0].message).toBe(
      "Left as a draft: The exchange rates list has no GBP rate effective on or before 2026-07-31, so this bill took the last GBP rate used (2.1). Check its rate, then approve it; or add rates under Accounting › Exchange rates.",
    );
    expect(await run((tx) => getBill(tx, history[0].billId!))).toMatchObject({ status: "draft", exchangeRate: "2.1", baseTotal: "84.00" });
    // With a GBP rate in the list from 1 Aug, August's bill is approved at it.
    await add([{ currencyCode: "GBP", effectiveDate: "2026-08-01", rate: "2.05" }]);
    expect(await runBills("2026-08-31")).toEqual({ made: 1, approved: 1, refused: 0, failed: 0 });
    history = (await run((tx) => getRepeatingBill(tx, repeatingBill.id))).runs;
    const august = await run((tx) => getBill(tx, history[0].billId!));
    expect(august).toMatchObject({ status: "approved", billDate: "2026-08-31", exchangeRate: "2.05", baseTotal: "82.00" });
    expect(await posted(august.approvalJournalId!)).toEqual([
      ["6040", "82.00", "0.00"],
      ["2000", "0.00", "82.00", "GBP 40.00 document"],
    ]);
  });

  it("MC53: several rates pasted at once, all or nothing; the month-end rate is suggested for revaluation", async () => {
    await expect(run((tx) => addExchangeRates(tx, { idempotencyKey: key("paste"), text: "USD, 2026-08-31, 1.62\nUSD, 2026-08-31, abc\n" }))).rejects.toThrow(
      /Line 2: The rate must be a plain number/,
    );
    const pasted = await run((tx) =>
      addExchangeRates(tx, { idempotencyKey: key("paste"), text: "Currency,Date,Rate,Note\nUSD,31/08/2026,1.62,RBNZ month end\n\nEUR\t2026-08-31\t1.85\n" }),
    );
    expect(pasted.added.map((rate) => [rate.currencyCode, rate.effectiveDate, rate.rate, rate.note])).toEqual([
      ["USD", "2026-08-31", "1.62", "RBNZ month end"],
      ["EUR", "2026-08-31", "1.85", null],
    ]);
    const list = await run((tx) => listExchangeRates(tx));
    expect(rateInEffect(list.rates, "USD", "2026-08-31")?.rate).toBe("1.62");
    expect(rateInEffect(list.rates, "USD", "2026-08-30")?.rate).toBe("1.65");
    expect(rateInEffect(list.rates, "GBP", "2026-07-31")).toBeNull();
    expect((await run((tx) => lastRateFor(tx, "USD", "2026-08-31")))?.rate).toBe("1.62");
  });
});
