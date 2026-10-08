import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { applyEcbRates, parseEcbXml } from "@/lib/fx/ecb";
import { addExchangeRates, listExchangeRates } from "@/lib/fx/rates";
import { convertRateRows, getRateSourceSettings, listRateSets, previewRateSet, rateSourceWarning, setRateSource, uploadRateSet } from "@/lib/fx/sources";
import { approveInvoice, createInvoice, getInvoice, updateInvoice } from "@/lib/invoices/service";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * Examples FX2-FX9 in docs/ACCOUNTING-EXAMPLES.md ("Choosing where exchange
 * rates come from", #183, approved by Jess 8 Oct 2026): Glimmers (NZD, year
 * 1 Apr - 31 Mar) uses ECB rates, then IRD's monthly averages uploaded as
 * rate sets. Worked through in order.
 */
describeWithDatabase("where exchange rates come from (#183, FX2-FX9)", () => {
  let server: TestServer;
  let owner: SessionUser;
  const ORG = "glimmers-fx";
  let usdCustomer: Contact;
  let audSupplier: Contact;
  let inv0042: string;
  let octoberSet: string;

  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const csv = (text: string) => Buffer.from(text).toString("base64");
  const IRD_OCTOBER = "Currency,Rate\nUSD,0.6045\nAUD,0.8950\nJPY,98.50\n";
  const upload = (input: Record<string, unknown>) =>
    run((tx) =>
      uploadRateSet(tx, {
        idempotencyKey: key("set"),
        name: "IRD monthly average",
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        quoted: "foreign_per_base",
        fileName: "ird-october.csv",
        fileBase64: csv(IRD_OCTOBER),
        ...input,
      }),
    );
  const invoice = (invoiceDate: string, amount: string, exchangeRate?: string) =>
    run((tx) =>
      createInvoice(
        tx,
        {
          idempotencyKey: key("inv"),
          contactId: usdCustomer.id,
          invoiceDate,
          dueDate: "2026-12-31",
          amountsMode: "exclusive",
          lines: [{ description: "Paw print pendant", quantity: "1", unitPrice: amount, accountCode: "4000", taxCode: "ZERO" }],
          ...(exchangeRate ? { exchangeRate } : {}),
        },
        { foreignCurrency: true },
      ),
    );

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("fx-sources@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    usdCustomer = (await run((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Paws USA", isCustomer: true, currencyCode: "USD" }))).contact;
    audSupplier = (await run((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Sydney Silver", isSupplier: true, currencyCode: "AUD" }))).contact;
  });
  afterAll(async () => {
    await server?.teardown();
  });

  it("FX2: the source starts as typed only; ECB, set and typed rates each show where they came from", async () => {
    expect((await run((tx) => getRateSourceSettings(tx))).source).toBe("typed");
    // Typed only to ECB needs no reason (nothing else was in use).
    expect(await run((tx) => rateSourceWarning(tx, "ecb", "2026-07-01"))).toBeNull();
    await run((tx) => setRateSource(tx, { source: "ecb" }, "2026-07-01"));
    const days = parseEcbXml(`<?xml version="1.0"?><gesmes:Envelope><Cube>
      <Cube time="2026-09-01"><Cube currency="USD" rate="1.1500"/><Cube currency="NZD" rate="1.9000"/><Cube currency="AUD" rate="1.7000"/></Cube>
    </Cube></gesmes:Envelope>`);
    expect((await run((tx) => applyEcbRates(tx, days))).added).toBe(2);
    await run((tx) => addExchangeRates(tx, { idempotencyKey: key("rate"), rates: [{ currencyCode: "USD", effectiveDate: "2026-09-10", rate: "1.6543" }] }));
    const list = await run((tx) => listExchangeRates(tx));
    expect(list.rates.map((rate) => [rate.currencyCode, rate.effectiveDate, rate.sourceLabel])).toEqual([
      ["USD", "2026-09-10", "Typed"],
      ["USD", "2026-09-01", "ECB"],
      ["AUD", "2026-09-01", "ECB"],
    ]);
    // INV-0042 (FX8): USD 1,000.00 at the list's 1.6543.
    const draft = await invoice("2026-09-15", "1000.00");
    expect(draft.invoice).toMatchObject({ exchangeRate: "1.6543", exchangeRateSource: "Exchange rates list", baseTotal: "1654.30" });
    inv0042 = (await run((tx) => approveInvoice(tx, draft.invoice.id, { idempotencyKey: key("a") }))).invoice.id;
  });

  it("FX3: an uploaded file is previewed as NZD per 1 unit; unused currencies are skipped; a bad rate refuses the file", async () => {
    const preview = await run((tx) =>
      previewRateSet(tx, {
        name: "IRD monthly average",
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        quoted: "foreign_per_base",
        fileName: "ird-october.csv",
        fileBase64: csv(IRD_OCTOBER),
      }),
    );
    expect(preview.rates.map((rate) => rate.text)).toEqual(["1 USD = 1.654260 NZD", "1 AUD = 1.117318 NZD"]);
    expect(preview.skipped).toEqual([{ row: 4, currencyCode: "JPY" }]);
    expect(preview.overlaps).toEqual([]);
    expect(convertRateRows([["USD", "1.6543"]], "base_per_foreign", "NZD", new Set(["USD"])).rates[0].rate).toBe("1.6543");
    await expect(upload({ fileBase64: csv("Currency,Rate\nUSD,0.6045\nAUD,\n") })).rejects.toThrow("Row 3: the AUD rate is blank. Nothing has been saved.");
    await expect(upload({ fileBase64: csv("USD,abc\n") })).rejects.toThrow('Row 1: the USD rate "abc" isn\'t a number above 0.');
    expect(await run((tx) => listRateSets(tx))).toEqual([]);
    const saved = await upload({});
    expect(saved.set).toMatchObject({ name: "IRD monthly average", periodStart: "2026-10-01", periodEnd: "2026-10-31" });
    expect(saved.set.rates).toEqual([
      { currencyCode: "AUD", rate: "1.117318" },
      { currencyCode: "USD", rate: "1.65426" },
    ]);
    octoberSet = saved.set.id;
  });

  it("FX7: changing from ECB to uploaded sets mid-year asks for a reason, kept in the history", async () => {
    const warning =
      "Inland Revenue asks you to use the same exchange rate source over time. This year (from 1 Apr 2026) has used ECB rates, so it would use two sources. Keep a note of why you're changing.";
    expect(await run((tx) => rateSourceWarning(tx, "uploaded", "2026-11-01"))).toBe(warning);
    await expect(run((tx) => setRateSource(tx, { source: "uploaded" }, "2026-11-01"))).rejects.toThrow(`${warning} Enter the reason.`);
    const settings = await run((tx) => setRateSource(tx, { source: "uploaded", reason: "Accountant uses IRD's monthly averages" }, "2026-11-01"));
    expect(settings.source).toBe("uploaded");
    expect(settings.history[0]).toMatchObject({ fromSource: "ecb", toSource: "uploaded", reason: "Accountant uses IRD's monthly averages" });
  });

  it("FX4: a document dated in the period takes the set's rate; a typed rate still wins and is recorded as Typed", async () => {
    const usd = await invoice("2026-10-15", "500.00");
    expect(usd.invoice).toMatchObject({ exchangeRate: "1.65426", exchangeRateSource: "IRD monthly average", baseTotal: "827.13" });
    const aud = await run((tx) =>
      createBill(
        tx,
        {
          idempotencyKey: key("bill"),
          contactId: audSupplier.id,
          billDate: "2026-10-31",
          dueDate: "2026-11-30",
          supplierInvoiceNumber: "SS-1",
          amountsMode: "no_tax",
          lines: [{ description: "Sterling silver", quantity: "1", unitPrice: "1200.00", accountCode: "6040" }],
        },
        null,
        { foreignCurrency: true },
      ),
    );
    expect(aud.bill).toMatchObject({ exchangeRate: "1.117318", exchangeRateSource: "IRD monthly average", baseTotal: "1340.78" });
    const typed = await invoice("2026-10-16", "100.00", "1.66");
    expect(typed.invoice).toMatchObject({ exchangeRate: "1.66", exchangeRateSource: "Typed" });
    // Saving the draft again (the editor sends its rate back) keeps where it came from.
    const edited = await run((tx) => updateInvoice(tx, usd.invoice.id, { reference: "Order 77", exchangeRate: "1.65426" }));
    expect(edited).toMatchObject({ exchangeRateSource: "IRD monthly average", reference: "Order 77" });
  });

  it("FX5: a date outside every set doesn't carry October's rate forward; it asks for a rate", async () => {
    await expect(invoice("2026-11-03", "50.00")).rejects.toThrow(
      "Type the exchange rate for this invoice (NZD per 1 USD). There's no IRD monthly average set for November 2026 yet.",
    );
    expect((await invoice("2026-11-03", "50.00", "1.67")).invoice).toMatchObject({ exchangeRateSource: "Typed" });
  });

  it("FX6, FX8: a set overlapping another needs a reason to replace it; nothing already approved changes; the ECB job stops", async () => {
    const half = { periodStart: "2026-10-15", periodEnd: "2026-11-15", name: "IRD mid-month", fileBase64: csv("USD,0.6000\nAUD,0.9000\n") };
    await expect(upload(half)).rejects.toThrow("Part of this period is already covered by IRD monthly average (1 Oct 2026 to 31 Oct 2026). To replace it, give a reason");
    const replaced = await upload({ ...half, replaceReason: "IRD corrected its figures" });
    expect(replaced.set).toMatchObject({ replacesSetId: octoberSet, replaceReason: "IRD corrected its figures" });
    const sets = await run((tx) => listRateSets(tx));
    expect(sets.find((set) => set.id === octoberSet)?.replacedAt).not.toBeNull();
    expect((await invoice("2026-10-20", "60.00")).invoice).toMatchObject({ exchangeRate: "1.666667", exchangeRateSource: "IRD mid-month" });
    // October 1-14 had only the replaced set, so now it asks.
    await expect(invoice("2026-10-05", "60.00")).rejects.toThrow("There's no IRD mid-month set for October 2026 yet.");
    // FX8: INV-0042 is exactly as it was.
    expect(await run((tx) => getInvoice(tx, inv0042))).toMatchObject({ exchangeRate: "1.6543", baseTotal: "1654.30", exchangeRateSource: "Exchange rates list" });
    const days = parseEcbXml(`<?xml version="1.0"?><gesmes:Envelope><Cube>
      <Cube time="2026-11-02"><Cube currency="USD" rate="1.1500"/><Cube currency="NZD" rate="1.9000"/></Cube>
    </Cube></gesmes:Envelope>`);
    expect((await run((tx) => applyEcbRates(tx, days))).added).toBe(0);
  });

  it("FX9: typed only adds nothing automatically; documents take the list's rate, else the last rate used", async () => {
    await expect(run((tx) => setRateSource(tx, { source: "typed" }, "2026-11-20"))).rejects.toThrow("has used uploaded rate sets");
    await run((tx) => setRateSource(tx, { source: "typed", reason: "Back to typing rates" }, "2026-11-20"));
    // 20 Nov is after the mid-month set; the typed 1.6543 (10 Sep) is the list's latest other entry.
    expect((await invoice("2026-11-20", "10.00")).invoice).toMatchObject({ exchangeRate: "1.6543", exchangeRateSource: "Exchange rates list" });
  });
});
