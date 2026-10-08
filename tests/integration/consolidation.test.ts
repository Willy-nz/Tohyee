import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { createAccount } from "@/lib/accounts/service";
import { approveBill, createBill } from "@/lib/bills/service";
import { getBudget, listBudgets, setBudgetAmounts } from "@/lib/budgets/service";
import { createAdjustment, createGroup, listGroups, removeAdjustment, requireGroup, setBudgetRate, setRateOverride } from "@/lib/consolidation/groups";
import { setIntercompany } from "@/lib/consolidation/intercompany";
import { consolidatedBalanceSheet, consolidatedBudgetVsActual, consolidatedProfitAndLoss, consolidationRates } from "@/lib/consolidation/report";
import type { ConsolidatedReport } from "@/lib/consolidation/types";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { applyEcbRates, ecbCrossRate, parseEcbXml, refreshEcbRates, setEcbFetchForTests, updateEcbSettings } from "@/lib/fx/ecb";
import { addExchangeRates, listedRates } from "@/lib/fx/rates";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { postJournal } from "@/lib/ledger/journals";
import { getOrganisation } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * Examples CO1-CO11 and FX1 in docs/ACCOUNTING-EXAMPLES.md ("Consolidation").
 * Kowhai Holdings Ltd (the parent, NZD, 31 March), Kowhai Retail Ltd (NZD,
 * 31 March) and Kowhai Pty Ltd (AUD, 30 June). Jess owns all three; Mere is a
 * bookkeeper of Retail only; Vic is a viewer of all three.
 */
describeWithDatabase("consolidation (CO1-CO11, FX1)", () => {
  let server: TestServer;
  let jess: SessionUser;
  let mere: SessionUser;
  let vic: SessionUser;
  let sets = 0;

  beforeAll(async () => {
    server = await startTestServer();
    jess = await createTestUser("co-jess@example.com", { serverAdmin: true, displayName: "Jess" });
    mere = await createTestUser("co-mere@example.com", { displayName: "Mere" });
    vic = await createTestUser("co-vic@example.com", { displayName: "Vic" });
  });

  afterAll(async () => {
    setEcbFetchForTests(null);
    await server?.teardown();
  });

  async function setup() {
    sets += 1;
    const ids = { holdings: `co${sets}-holdings`, retail: `co${sets}-retail`, pty: `co${sets}-pty` };
    await createTestOrganisation(jess, ids.holdings);
    await createTestOrganisation(jess, ids.retail);
    await createTestOrganisation(jess, ids.pty, { baseCurrency: "AUD" });
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ids.retail, mere.id]);
    for (const id of Object.values(ids)) await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [id, vic.id]);
    const as = <T>(org: string, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: jess.id, email: jess.email }, work);
    await as(ids.pty, (tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 6 }));
    const journal = (org: string, postingDate: string, lines: Array<{ accountCode: string; debitAmount?: string; creditAmount?: string }>) =>
      as(org, (tx) => postJournal(tx, { idempotencyKey: key("j"), postingDate, reference: "Setup", lines }));
    const account = (org: string, code: string, name: string, accountType: string) => as(org, (tx) => createAccount(tx, { code, name, accountType }));
    await account(ids.holdings, "1150", "Loan to Kowhai Retail", "non_current_asset");
    await account(ids.holdings, "1160", "Investment in Kowhai Retail", "non_current_asset");
    await account(ids.holdings, "4150", "Management fees", "revenue");
    await account(ids.retail, "2150", "Loan from Kowhai Holdings", "non_current_liability");
    await account(ids.retail, "6250", "Management fees", "expense");
    // Stock bought outside the stock records (1400 only moves with stock items).
    await account(ids.retail, "1410", "Goods for resale", "current_asset");

    // Holdings: capital, the loan, the investment, accounting fees, and October's fee to Retail (unpaid).
    await journal(ids.holdings, "2026-04-01", [{ accountCode: "1000", debitAmount: "19000.00" }, { accountCode: "3000", creditAmount: "19000.00" }]);
    await journal(ids.holdings, "2026-05-01", [{ accountCode: "1150", debitAmount: "10000.00" }, { accountCode: "1160", debitAmount: "4000.00" }, { accountCode: "1000", creditAmount: "14000.00" }]);
    await journal(ids.holdings, "2026-10-15", [{ accountCode: "6010", debitAmount: "200.00" }, { accountCode: "1000", creditAmount: "200.00" }]);
    const retailContact = (await as(ids.holdings, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kowhai Retail Ltd", isCustomer: true }))).contact;
    const fee = (
      await as(ids.holdings, (tx) =>
        createInvoice(tx, {
          idempotencyKey: key("inv"),
          contactId: retailContact.id,
          invoiceDate: "2026-10-31",
          dueDate: "2026-11-20",
          amountsMode: "exclusive",
          lines: [{ description: "October management fee", quantity: "1", unitPrice: "1000.00", accountCode: "4150", taxCode: "GST" }],
        }),
      )
    ).invoice;
    await as(ids.holdings, (tx) => approveInvoice(tx, fee.id, { idempotencyKey: key("ai") }));

    // Retail: capital and the loan from Holdings, stock, October's trading, and Holdings' fee (unpaid).
    await journal(ids.retail, "2026-05-01", [{ accountCode: "1000", debitAmount: "14000.00" }, { accountCode: "3000", creditAmount: "4000.00" }, { accountCode: "2150", creditAmount: "10000.00" }]);
    await journal(ids.retail, "2026-05-02", [{ accountCode: "1410", debitAmount: "3000.00" }, { accountCode: "1000", creditAmount: "3000.00" }]);
    await journal(ids.retail, "2026-10-20", [
      { accountCode: "1000", debitAmount: "6000.00" },
      { accountCode: "5000", debitAmount: "8000.00" },
      { accountCode: "6200", debitAmount: "6000.00" },
      { accountCode: "4000", creditAmount: "20000.00" },
    ]);
    const holdingsContact = (await as(ids.retail, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kowhai Holdings Ltd", isSupplier: true }))).contact;
    const bill = (
      await as(ids.retail, (tx) =>
        createBill(tx, {
          idempotencyKey: key("bill"),
          contactId: holdingsContact.id,
          billDate: "2026-10-31",
          dueDate: "2026-11-20",
          supplierInvoiceNumber: "INV-0001",
          amountsMode: "exclusive",
          lines: [{ description: "October management fee", quantity: "1", unitPrice: "1000.00", accountCode: "6250", taxCode: "GST" }],
        }),
      )
    ).bill;
    await as(ids.retail, (tx) => approveBill(tx, bill.id, { idempotencyKey: key("ab") }));

    // Kowhai Pty Ltd (AUD): capital on 1 Sep, October's sales and wages.
    await journal(ids.pty, "2026-09-01", [{ accountCode: "1000", debitAmount: "9000.00" }, { accountCode: "3000", creditAmount: "9000.00" }]);
    await journal(ids.pty, "2026-10-10", [{ accountCode: "1000", debitAmount: "5000.00" }, { accountCode: "4000", creditAmount: "5000.00" }]);
    await journal(ids.pty, "2026-10-20", [{ accountCode: "6200", debitAmount: "3000.00" }, { accountCode: "1000", creditAmount: "3000.00" }]);

    // Holdings' exchange rates list, NZD per AUD.
    await as(ids.holdings, (tx) =>
      addExchangeRates(tx, {
        idempotencyKey: key("rates"),
        rates: [
          { currencyCode: "AUD", effectiveDate: "2026-09-01", rate: "1.1" },
          { currencyCode: "AUD", effectiveDate: "2026-10-01", rate: "1.12" },
          { currencyCode: "AUD", effectiveDate: "2026-10-31", rate: "1.15" },
        ],
      }),
    );
    const user = { id: jess.id, email: jess.email };
    return { ids, as, journal, user, retailContact, holdingsContact };
  }

  async function group(w: Awaited<ReturnType<typeof setup>>) {
    const made = await createGroup(w.user, { name: `Kowhai group ${sets}`, parentOrganisationId: w.ids.holdings, organisationIds: [w.ids.retail, w.ids.pty] });
    // CO2: the intercompany accounts and the contacts that stand for each other.
    await w.as(w.ids.holdings, async (tx) => {
      const id = (code: string) => tx.query<{ id: string }>("select id::text from accounts where code = $1", [code]).then((result) => result.rows[0].id);
      await setIntercompany(tx, {
        accounts: [
          { accountId: await id("1150"), counterpartOrganisationId: w.ids.retail },
          { accountId: await id("4150"), counterpartOrganisationId: w.ids.retail },
        ],
        contacts: [{ contactId: w.retailContact.id, counterpartOrganisationId: w.ids.retail }],
      });
    });
    await w.as(w.ids.retail, async (tx) => {
      const id = (code: string) => tx.query<{ id: string }>("select id::text from accounts where code = $1", [code]).then((result) => result.rows[0].id);
      await setIntercompany(tx, {
        accounts: [
          { accountId: await id("2150"), counterpartOrganisationId: w.ids.holdings },
          { accountId: await id("6250"), counterpartOrganisationId: w.ids.holdings },
        ],
        contacts: [{ contactId: w.holdingsContact.id, counterpartOrganisationId: w.ids.holdings }],
      });
    });
    return made;
  }

  const rows = (report: ConsolidatedReport, ids: { holdings: string; retail: string; pty: string }) =>
    report.sections.flatMap((section) =>
      section.lines
        .filter((line) => !(line.consolidated === "0.00" && Object.values(line.amounts).every((value) => value === "0.00") && line.eliminations === "0.00"))
        .map((line) => [line.code || line.name, line.amounts[ids.holdings], line.amounts[ids.retail], line.amounts[ids.pty], line.eliminations, line.consolidated]),
    );

  it("CO1, CO2: Jess makes the group; who can see it and add to it", async () => {
    const w = await setup();
    const made = await group(w);
    expect([made.currencyCode, made.members.map((member) => [member.organisationId, member.currencyCode])]).toEqual([
      "NZD",
      [
        [w.ids.holdings, "NZD"],
        [w.ids.pty, "AUD"],
        [w.ids.retail, "NZD"],
      ],
    ]);
    expect((await listGroups({ id: mere.id, email: mere.email })).map((item) => item.id)).not.toContain(made.id);
    await expect(requireGroup({ id: mere.id, email: mere.email }, made.id)).rejects.toThrow("Consolidation group not found.");
    expect((await listGroups({ id: vic.id, email: vic.email })).map((item) => item.id)).toContain(made.id);
    // Vic sees it but isn't an admin of the organisations, so can't make one.
    await expect(createGroup({ id: vic.id, email: vic.email }, { name: "Vic's", parentOrganisationId: w.ids.holdings, organisationIds: [w.ids.pty] })).rejects.toThrow(
      `You need to be an admin or owner of Test ${w.ids.holdings} to add it to a consolidation group.`,
    );
    await expect(createGroup(w.user, { name: made.name, parentOrganisationId: w.ids.holdings, organisationIds: [w.ids.retail] })).rejects.toThrow("already a consolidation group");
    // An intercompany account isn't a bank, receivable or payable account; a contact links to another organisation once.
    await expect(
      w.as(w.ids.holdings, async (tx) => setIntercompany(tx, { accounts: [{ accountId: (await tx.query<{ id: string }>("select id::text from accounts where code = '1100'")).rows[0].id, counterpartOrganisationId: w.ids.retail }] })),
    ).rejects.toThrow("1100 can't be an intercompany account");
  });

  it("CO3-CO5, CO8: Kowhai Pty Ltd's rates, and the consolidated profit and loss", async () => {
    const w = await setup();
    const made = await group(w);
    const rates = await consolidationRates(w.user, made.id, { from: "2026-09-01", to: "2026-10-31" });
    expect(rates.map((row) => [row.month, row.current, row.average, row.historical])).toEqual([
      ["2026-09-01", "1.100000", null, "1.100000"],
      ["2026-10-01", "1.150000", "1.120000", null],
    ]);
    const pnl = await consolidatedProfitAndLoss(w.user, made.id, { from: "2026-10-01", to: "2026-10-31" });
    expect(rows(pnl, w.ids)).toEqual([
      ["4000", "0.00", "20000.00", "5600.00", "0.00", "25600.00"],
      ["4150", "1000.00", "0.00", "0.00", "-1000.00", "0.00"],
      ["5000", "0.00", "8000.00", "0.00", "0.00", "8000.00"],
      ["6010", "200.00", "0.00", "0.00", "0.00", "200.00"],
      ["6200", "0.00", "6000.00", "3360.00", "0.00", "9360.00"],
      ["6250", "0.00", "1000.00", "0.00", "-1000.00", "0.00"],
    ]);
    const net = pnl.totals.find((line) => line.name === "Net profit")!;
    expect([net.amounts[w.ids.holdings], net.amounts[w.ids.retail], net.amounts[w.ids.pty], net.eliminations, net.consolidated]).toEqual(["800.00", "5000.00", "2240.00", "0.00", "8040.00"]);
    expect(pnl.notices).toEqual([]);
    // Pty's own currency beside it.
    expect(pnl.sections[0].lines[0].ownAmounts).toEqual({ [w.ids.pty]: "5000.00" });
    // CO8: the group's year to date (from 1 April) is the same; any dates can be run.
    expect((await consolidatedProfitAndLoss(w.user, made.id, { to: "2026-10-31" })).from).toBe("2026-04-01");
    expect((await consolidatedProfitAndLoss(w.user, made.id, { from: "2026-07-01", to: "2027-06-30" })).totals[1].consolidated).toBe("8040.00");
    // A changed rate is used instead, with a reason.
    await setRateOverride(w.user, made.id, { currencyCode: "AUD", month: "2026-10", kind: "average", rate: "1.13", reason: "Bank's average" });
    expect((await consolidatedProfitAndLoss(w.user, made.id, { from: "2026-10-01", to: "2026-10-31" })).sections[0].lines[0].amounts[w.ids.pty]).toBe("5650.00");
    await setRateOverride(w.user, made.id, { currencyCode: "AUD", month: "2026-10", kind: "average", rate: "" });
    await expect(setRateOverride({ id: vic.id, email: vic.email }, made.id, { currencyCode: "AUD", month: "2026-10", kind: "average", rate: "1.2", reason: "x" })).rejects.toThrow("admin or owner of every organisation");
  });

  it("CO3: with no AUD rate for a date, the report is refused", async () => {
    const w = await setup();
    const made = await group(w);
    await w.journal(w.ids.pty, "2026-08-15", [{ accountCode: "6200", debitAmount: "10.00" }, { accountCode: "1000", creditAmount: "10.00" }]);
    await expect(consolidatedProfitAndLoss(w.user, made.id, { from: "2026-08-01", to: "2026-10-31" })).rejects.toThrow(
      `Test ${w.ids.holdings}'s exchange rates list has no AUD rate for 15 Aug 2026.`,
    );
  });

  it("CO5-CO7, CO9: the consolidated balance sheet, an adjustment, and intercompany differences", async () => {
    const w = await setup();
    const made = await group(w);
    const sheet = await consolidatedBalanceSheet(w.user, made.id, { asAt: "2026-10-31" });
    expect(rows(sheet, w.ids)).toEqual([
      ["1000", "4800.00", "17000.00", "12650.00", "0.00", "34450.00"],
      ["1100", "1150.00", "0.00", "0.00", "-1150.00", "0.00"],
      ["1150", "10000.00", "0.00", "0.00", "-10000.00", "0.00"],
      ["1160", "4000.00", "0.00", "0.00", "0.00", "4000.00"],
      ["1410", "0.00", "3000.00", "0.00", "0.00", "3000.00"],
      ["2000", "0.00", "1150.00", "0.00", "-1150.00", "0.00"],
      ["2100", "150.00", "-150.00", "0.00", "0.00", "0.00"],
      ["2150", "0.00", "10000.00", "0.00", "-10000.00", "0.00"],
      ["3000", "19000.00", "4000.00", "9900.00", "0.00", "32900.00"],
      ["Current year earnings", "800.00", "5000.00", "2240.00", "0.00", "8040.00"],
      ["Foreign currency translation reserve", "0.00", "0.00", "510.00", "0.00", "510.00"],
    ]);
    expect(sheet.totals.map((line) => [line.name, line.consolidated])).toEqual([
      ["Total assets", "41450.00"],
      ["Total liabilities and equity", "41450.00"],
    ]);
    // CO7: the investment against Retail's capital.
    await expect(createAdjustment(w.user, made.id, { date: "2026-10-31", description: "Uneven", lines: [{ organisationId: w.ids.retail, accountCode: "3000", debit: "4000" }, { organisationId: w.ids.holdings, accountCode: "1160", credit: "3999" }] })).rejects.toThrow(
      "must be equal",
    );
    await expect(createAdjustment(w.user, made.id, { date: "2026-10-31", description: "No account", lines: [{ organisationId: w.ids.retail, accountCode: "9999", debit: "1" }, { organisationId: w.ids.holdings, accountCode: "1160", credit: "1" }] })).rejects.toThrow(
      `Test ${w.ids.retail} has no account 9999`,
    );
    await expect(createAdjustment({ id: mere.id, email: mere.email }, made.id, { date: "2026-10-31", description: "x", lines: [] })).rejects.toThrow("not found");
    const adjustments = await createAdjustment(w.user, made.id, {
      date: "2026-10-31",
      description: "Investment in Retail",
      lines: [
        { organisationId: w.ids.retail, accountCode: "3000", debit: "4000.00" },
        { organisationId: w.ids.holdings, accountCode: "1160", credit: "4000.00" },
      ],
    });
    const adjusted = await consolidatedBalanceSheet(w.user, made.id, { asAt: "2026-10-31" });
    expect(adjusted.totals.map((line) => line.consolidated)).toEqual(["37450.00", "37450.00"]);
    expect(adjusted.sections[2].lines.find((line) => line.code === "3000")!.consolidated).toBe("28900.00");
    // Nothing is posted in any organisation.
    const journals = await w.as(w.ids.retail, (tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journal_lines l join accounts a on a.id = l.account_id where a.code = '3000'"));
    expect(journals.rows[0].n).toBe("1");
    await removeAdjustment(w.user, made.id, adjustments[0].id);

    // CO9: Retail has the loan as 9,950.00, with 50.00 put elsewhere.
    await w.journal(w.ids.retail, "2026-10-31", [{ accountCode: "2150", debitAmount: "50.00" }, { accountCode: "2200", creditAmount: "50.00" }]);
    const different = await consolidatedBalanceSheet(w.user, made.id, { asAt: "2026-10-31" });
    expect(different.sections[0].lines.at(-1)).toMatchObject({ name: "Intercompany differences (check these)", consolidated: "50.00" });
    expect(different.totals.map((line) => line.consolidated)).toEqual(["41500.00", "41500.00"]);
    expect(different.notices).toEqual([`Test ${w.ids.holdings} 1150 10,000.00 and Test ${w.ids.retail} 2150 9,950.00 don't agree (a difference of 50.00). Check them.`]);
  });

  it("CO11: consolidated budget vs actual at the budget rates", async () => {
    const w = await setup();
    const made = await group(w);
    const budget = (org: string, amount: string) =>
      w.as(org, async (tx) => {
        const overall = (await listBudgets(tx))[0];
        await setBudgetAmounts(tx, overall.id, { version: (await getBudget(tx, overall.id)).budget.version, amounts: [{ accountCode: "4000", month: "2026-10", amount }] });
      });
    await budget(w.ids.pty, "4500.00");
    await budget(w.ids.retail, "18000.00");
    await expect(consolidatedBudgetVsActual(w.user, made.id, { from: "2026-10-01", to: "2026-10-31" })).rejects.toThrow("Enter the budget exchange rates: AUD for 2026-10.");
    await setBudgetRate(w.user, made.id, { currencyCode: "AUD", month: "2026-10", rate: "1.1" });
    const report = await consolidatedBudgetVsActual(w.user, made.id, { from: "2026-10-01", to: "2026-10-31" });
    expect(report.lines.find((line) => line.code === "4000")).toMatchObject({ actual: "25600.00", budget: "22950.00", variance: "2650.00" });
  });

  it("FX1: ECB rates come into the exchange rates list, worked out through the euro; typed rates stay", async () => {
    const w = await setup();
    const xml = `<?xml version="1.0"?><gesmes:Envelope><Cube>
      <Cube time="2026-10-05"><Cube currency="USD" rate="1.0900"/><Cube currency="NZD" rate="1.9000"/><Cube currency="AUD" rate="1.7000"/></Cube>
      <Cube time="2026-10-02"><Cube currency="USD" rate="1.0800"/><Cube currency="NZD" rate="1.8800"/><Cube currency="AUD" rate="1.6900"/></Cube>
    </Cube></gesmes:Envelope>`;
    const days = parseEcbXml(xml);
    expect(days.map((day) => day.date)).toEqual(["2026-10-05", "2026-10-02"]);
    expect([ecbCrossRate(days[0], "NZD", "AUD"), ecbCrossRate(days[0], "AUD", "NZD"), ecbCrossRate(days[0], "NZD", "EUR"), ecbCrossRate(days[0], "NZD", "XYZ")]).toEqual(["1.117647", "0.894737", "1.9", null]);
    setEcbFetchForTests(async () => new Response(xml, { status: 200 }));
    const holdings = (await getOrganisation(w.ids.holdings))!;
    const pty = (await getOrganisation(w.ids.pty))!;
    // Off: nothing is added.
    expect((await refreshEcbRates(holdings)).added).toBe(0);
    await w.as(w.ids.holdings, (tx) => updateEcbSettings(tx, { enabled: true }, "2026-10-05"));
    expect((await refreshEcbRates(holdings)).added).toBe(1);
    const aud = (await w.as(w.ids.holdings, (tx) => listedRates(tx, ["AUD"]))).get("AUD")!;
    expect(aud.find((entry) => entry.date === "2026-10-05")).toEqual({ rate: "1.117647", date: "2026-10-05", until: null, label: "ECB" });
    // A rate already there for the date (typed) is never replaced, and running again adds nothing.
    await w.as(w.ids.pty, (tx) => addExchangeRates(tx, { idempotencyKey: key("rate"), rates: [{ currencyCode: "NZD", effectiveDate: "2026-10-05", rate: "0.9" }] }));
    await w.as(w.ids.pty, (tx) => updateEcbSettings(tx, { enabled: true, extraCurrencies: ["NZD", "USD"] }, "2026-10-02"));
    expect((await refreshEcbRates(pty)).added).toBe(3);
    const ptyRates = await w.as(w.ids.pty, (tx) => listedRates(tx, ["NZD", "USD"]));
    expect(ptyRates.get("NZD")).toEqual([
      { rate: "0.9", date: "2026-10-05", until: null, label: "Exchange rates list" },
      { rate: "0.898936", date: "2026-10-02", until: null, label: "ECB" },
    ]);
    expect(ptyRates.get("USD")!.map((entry) => [entry.date, entry.rate])).toEqual([
      ["2026-10-05", "1.559633"],
      ["2026-10-02", "1.564815"],
    ]);
    expect((await w.as(w.ids.pty, (tx) => applyEcbRates(tx, days))).added).toBe(0);
    // When the ECB can't be reached, the settings say so.
    setEcbFetchForTests(async () => new Response("down", { status: 503 }));
    const failed = await refreshEcbRates(holdings);
    expect(failed.error).toContain("HTTP 503");
  });
});
