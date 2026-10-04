import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts, listStatementLines } from "@/lib/bank/accounts";
import { cashCodeStatementLines } from "@/lib/bank/cash-coding";
import { confidentMatches, okConfidentMatches } from "@/lib/bank/confident";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine, suggestionsForLine } from "@/lib/bank/reconcile";
import { createBankRule, listBankRules, updateBankRule } from "@/lib/bank/rules";
import { type Contact, createContact, updateContact } from "@/lib/contacts/service";
import type { OrgRunner, OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getJournal } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { calculateGstReturn } from "@/lib/reports/gst-return";
import { createTaxCode } from "@/lib/tax/codes";
import { createTrackingValue, getTrackingSetup, updateTrackingCategory } from "@/lib/tracking/service";
import {
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const CSV = `Date,Amount,Payee,Particulars,Code,Reference
02/06/2026,-115.00,SPARK,,,
03/06/2026,-230.00,SPARK,,,
04/06/2026,-69.00,CALTEX ,,,
05/06/2026,-11.50,Z ENERGY,,,
06/06/2026,-2300.00,HARBOUR PROPERTIES,,,rent
08/06/2026,-46.01,SPARK MOBILE,,,
09/06/2026,-505.00,ANZ,LOAN,,
10/06/2026,-3.00,ANZ,FEE,,
12/06/2026,-18.40,GULL,,,
`;
const b64 = (text: string) => Buffer.from(text).toString("base64");

/**
 * Bank rules with several conditions and split lines (BR1-BR10) and a
 * contact's default account and tracking (SD1-SD3), docs/ACCOUNTING-EXAMPLES.md.
 * Set-up: the default chart (6020 Bank fees, 6120 Motor vehicle expenses,
 * 6150 Rent, 6170 Telephone and internet, 2800 Term loan), GST 15%, advanced
 * features on with Department values Retail and Wholesale, the contacts
 * Spark, Caltex, Harbour Properties, ANZ, Gull NZ and Z Energy, and the June
 * 2026 statement above imported into 1000, with rules A-F.
 */
describeWithDatabase("bank rules with conditions and split lines", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("bookkeeper@example.com");
    viewer = await createTestUser("viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `rules-${organisations}-co`;
    await createTestOrganisation(owner, org);
    for (const [user, role] of [
      [bookkeeper, "bookkeeper"],
      [viewer, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [org, user.id, role]);
    }
    const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
    const run: OrgRunner = (work) => asUser(bookkeeper, work);
    await asUser(owner, (tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const categories = (await asUser(owner, (tx) => getTrackingSetup(tx))).categories;
    const department = categories.find((category) => category.kind === "department")!.id;
    const valueId = async (name: string) => {
      const setupNow = await asUser(owner, (tx) => createTrackingValue(tx, { categoryId: department, name, parentId: null }));
      return setupNow.categories.find((category) => category.id === department)!.values.find((value) => value.name === name)!.id;
    };
    const retail = await valueId("Retail");
    const wholesale = await valueId("Wholesale");
    const contact = async (name: string): Promise<Contact> =>
      (await asUser(bookkeeper, (tx) => createContact(tx, { idempotencyKey: key("contact"), name, isSupplier: true }))).contact;
    const people = {
      spark: await contact("Spark"),
      caltex: await contact("Caltex"),
      harbour: await contact("Harbour Properties"),
      anz: await contact("ANZ"),
      gull: await contact("Gull NZ"),
      zEnergy: await contact("Z Energy"),
    };
    const bank = (await asUser(viewer, (tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    const card = (await asUser(viewer, (tx) => listBankAccounts(tx))).find((account) => account.code === "2400")!;
    await asUser(bookkeeper, (tx) => importStatementFile(tx, bank.id, { idempotencyKey: key("import"), fileName: "june.csv", fileBase64: b64(CSV) }));
    const lines = async () => (await asUser(viewer, (tx) => listStatementLines(tx, bank.id, { status: "all" }))).lines;
    const lineOn = async (date: string) => (await lines()).find((line) => line.date === date)!;
    const rule = (input: Record<string, unknown>) => asUser(bookkeeper, (tx) => createBankRule(tx, { direction: "out", ...input }));
    const pct = (accountCode: string, percentage: string, taxCode: string | null, tracking?: Record<string, string>) => ({
      accountCode,
      percentage,
      taxCode,
      ...(tracking ? { tracking } : {}),
    });
    const fixed = (accountCode: string, fixedAmount: string, taxCode: string | null) => ({ accountCode, fixedAmount, taxCode });
    const rules = {
      a: await rule({
        name: "A Spark broadband",
        matchMode: "all",
        conditions: [
          { field: "payee", operator: "contains", text: "SPARK" },
          { field: "amount", operator: "at_most", amount: "200.00" },
        ],
        contactId: people.spark.id,
        lines: [pct("6170", "100", "GST")],
      }),
      b: await rule({
        name: "B Fuel",
        matchMode: "any",
        conditions: [
          { field: "payee", operator: "contains", text: "CALTEX" },
          { field: "payee", operator: "contains", text: "Z ENERGY" },
          { field: "payee", operator: "contains", text: "GULL" },
        ],
        contactMode: "payee",
        lines: [pct("6120", "100", "GST")],
      }),
      c: await rule({
        name: "C Rent",
        conditions: [
          { field: "reference", operator: "equals", text: "RENT" },
          { field: "amount", operator: "equals", amount: "2300.00" },
        ],
        contactId: people.harbour.id,
        lines: [pct("6150", "100", "GST")],
      }),
      d: await rule({
        name: "D Spark mobile",
        priority: 10,
        conditions: [{ field: "payee", operator: "starts_with", text: "SPARK MOBILE" }],
        contactId: people.spark.id,
        lines: [pct("6170", "60", "GST", { [department]: retail }), pct("6170", "40", "GST", { [department]: wholesale })],
      }),
      e: await rule({
        name: "E ANZ loan",
        priority: 20,
        conditions: [{ field: "payee", operator: "equals", text: "ANZ" }],
        contactId: people.anz.id,
        lines: [fixed("6020", "5.00", null), pct("2800", "100", null)],
      }),
      f: await rule({
        name: "F ANZ fees",
        priority: 30,
        conditions: [{ field: "payee", operator: "equals", text: "ANZ" }],
        contactId: people.anz.id,
        lines: [pct("6020", "100", null)],
      }),
    };
    const suggest = async (date: string) => {
      const lineId = (await lineOn(date)).id;
      return (await asUser(viewer, (tx) => suggestionsForLine(tx, lineId))).rule;
    };
    const shape = (suggestion: Awaited<ReturnType<typeof suggest>>) =>
      suggestion?.suggestedLines.map((entry) => [entry.accountCode, entry.amount, entry.taxCode, entry.tracking[department] ?? null]);
    const journalLines = async (journalId: string) =>
      (await asUser(owner, (tx) => getJournal(tx, journalId))).lines.map((entry) => [
        entry.accountCode,
        entry.debitAmount,
        entry.creditAmount,
        entry.tracking[department] ?? null,
      ]);
    const journalCount = async () =>
      Number((await asUser(owner, (tx) => tx.query<{ count: string }>("select count(*)::text as count from ledger_journals"))).rows[0].count);
    return { org, asUser, run, department, retail, wholesale, people, bank, card, lines, lineOn, rules, suggest, shape, journalLines, journalCount };
  }

  it("BR1: all conditions, with an amount limit; nothing is posted until OK", async () => {
    const w = await setup();
    const before = await w.journalCount();
    const suggestion = await w.suggest("2026-06-02");
    expect(suggestion).toMatchObject({ name: "A Spark broadband", contactId: w.people.spark.id, contactName: "Spark", amountsMode: "inclusive", problem: null });
    expect(w.shape(suggestion)).toEqual([["6170", "115.00", "GST", null]]);
    expect(await w.suggest("2026-06-03")).toBeNull();
    expect(await w.journalCount()).toBe(before);
  });

  it("BR2: any condition, the contact named like the payee, and none for GULL until one is chosen", async () => {
    const w = await setup();
    expect(await w.suggest("2026-06-04")).toMatchObject({ name: "B Fuel", contactId: w.people.caltex.id, contactName: "Caltex", problem: null });
    expect(await w.suggest("2026-06-05")).toMatchObject({ contactId: w.people.zEnergy.id, contactName: "Z Energy" });
    const gull = await w.suggest("2026-06-12");
    expect(gull).toMatchObject({ name: "B Fuel", contactId: null, problem: "No contact called “GULL”; choose one." });
    expect(w.shape(gull)).toEqual([["6120", "18.40", "GST", null]]);
    const gullLine = await w.lineOn("2026-06-12");
    expect((await w.asUser(viewer, (tx) => confidentMatches(tx, w.bank.id))).find((entry) => entry.lineId === gullLine.id)?.suggestion).toBeNull();
    const { line } = await w.asUser(bookkeeper, (tx) =>
      reconcileStatementLine(tx, gullLine.id, {
        idempotencyKey: key("reconcile"),
        kind: "bank_transaction",
        contactId: w.people.gull.id,
        amountsMode: gull!.amountsMode,
        lines: gull!.suggestedLines.map((entry) => ({ description: entry.description, accountCode: entry.accountCode, taxCode: entry.taxCode, amount: entry.amount })),
      }),
    );
    expect(await w.journalLines(line.reconciliation!.items[0].journalId)).toEqual(
      expect.arrayContaining([
        ["6120", "16.00", "0.00", null],
        ["2100", "2.40", "0.00", null],
        ["1000", "0.00", "18.40", null],
      ]),
    );
  });

  it("BR3: equals ignores case but isn't contains; the amount must be equal", async () => {
    const w = await setup();
    const rent = await w.suggest("2026-06-06");
    expect(rent).toMatchObject({ name: "C Rent", contactName: "Harbour Properties" });
    expect(w.shape(rent)).toEqual([["6150", "2300.00", "GST", null]]);
    await w.asUser(bookkeeper, (tx) =>
      importStatementFile(tx, w.bank.id, {
        idempotencyKey: key("import"),
        fileName: "more.csv",
        fileBase64: b64("Date,Amount,Payee,Particulars,Code,Reference\n13/06/2026,-2300.01,HARBOUR PROPERTIES,,,RENT\n14/06/2026,-2300.00,HARBOUR PROPERTIES,,,RENT JUNE\n"),
      }),
    );
    expect(await w.suggest("2026-06-13")).toBeNull();
    expect(await w.suggest("2026-06-14")).toBeNull();
  });

  it("BR4: a 60/40 split with tracking; the cent left over goes to the share that lost most", async () => {
    const w = await setup();
    const mobile = await w.suggest("2026-06-08");
    expect(mobile).toMatchObject({ name: "D Spark mobile", contactName: "Spark" });
    expect(w.shape(mobile)).toEqual([
      ["6170", "27.61", "GST", w.retail],
      ["6170", "18.40", "GST", w.wholesale],
    ]);
    const before = await w.asUser(viewer, (tx) => calculateGstReturn(tx, { periodStart: "2026-06-01", periodEnd: "2026-06-30" }));
    const result = await okConfidentMatches(w.run, w.bank.id, { idempotencyKey: key("ok"), items: [{ lineId: (await w.lineOn("2026-06-08")).id, expect: `rule:${w.rules.d.id}` }] });
    expect(result).toMatchObject({ succeeded: 1, failed: 0 });
    const line = await w.lineOn("2026-06-08");
    expect(await w.journalLines(line.reconciliation!.items[0].journalId)).toEqual(
      expect.arrayContaining([
        ["6170", "24.01", "0.00", w.retail],
        ["6170", "16.00", "0.00", w.wholesale],
        ["2100", "6.00", "0.00", null],
        ["1000", "0.00", "46.01", null],
      ]),
    );
    const after = await w.asUser(viewer, (tx) => calculateGstReturn(tx, { periodStart: "2026-06-01", periodEnd: "2026-06-30" }));
    expect(Number(after.boxes.box11) - Number(before.boxes.box11)).toBeCloseTo(46.01, 6);
    const gst = after.lines.filter((entry) => entry.documentType === "bank_transaction").reduce((sum, entry) => sum + Number(entry.gst), 0);
    expect(gst).toBeCloseTo(6.0, 6);
  });

  it("BR5 and BR6: a fixed amount first, then the rest; a rule that doesn't fit is skipped; a 0.00 share is left out", async () => {
    const w = await setup();
    const loan = await w.suggest("2026-06-09");
    expect(loan).toMatchObject({ name: "E ANZ loan", amountsMode: "no_tax" });
    expect(w.shape(loan)).toEqual([
      ["6020", "5.00", null, null],
      ["2800", "500.00", null, null],
    ]);
    const fee = await w.suggest("2026-06-10");
    expect(fee).toMatchObject({ name: "F ANZ fees" });
    expect(w.shape(fee)).toEqual([["6020", "3.00", null, null]]);
    await w.asUser(bookkeeper, (tx) =>
      importStatementFile(tx, w.bank.id, { idempotencyKey: key("import"), fileName: "five.csv", fileBase64: b64("Date,Amount,Payee\n15/06/2026,-5.00,ANZ\n") }),
    );
    const five = await w.suggest("2026-06-15");
    expect(five).toMatchObject({ name: "E ANZ loan" });
    expect(w.shape(five)).toEqual([["6020", "5.00", null, null]]);
  });

  it("BR7: priority, the rule's account, inactive rules and direction", async () => {
    const w = await setup();
    expect((await w.suggest("2026-06-08"))?.name).toBe("D Spark mobile");
    const d = w.rules.d;
    await w.asUser(bookkeeper, (tx) =>
      updateBankRule(tx, d.id, {
        name: d.name,
        priority: d.priority,
        isActive: false,
        conditions: d.conditions,
        contactId: d.contactId,
        direction: d.direction,
        lines: d.lines.map((line) => ({ accountCode: line.accountCode, percentage: line.percentage, taxCode: line.taxCode, tracking: line.tracking })),
      }),
    );
    const instead = await w.suggest("2026-06-08");
    expect(instead).toMatchObject({ name: "A Spark broadband" });
    expect(w.shape(instead)).toEqual([["6170", "46.01", "GST", null]]);
    // Rule A limited to the credit card suggests nothing on 1000.
    const a = w.rules.a;
    await w.asUser(bookkeeper, (tx) =>
      updateBankRule(tx, a.id, {
        name: a.name,
        accountId: w.card.id,
        matchMode: a.matchMode,
        conditions: a.conditions,
        contactId: a.contactId,
        direction: a.direction,
        lines: [{ accountCode: "6170", percentage: "100", taxCode: "GST" }],
      }),
    );
    expect(await w.suggest("2026-06-02")).toBeNull();
    expect(await w.suggest("2026-06-08")).toBeNull();
    // Changing a rule's direction and its GST code together is checked against the new direction.
    const moneyIn = await w.asUser(bookkeeper, (tx) =>
      createBankRule(tx, {
        name: "Was money in",
        direction: "in",
        conditions: [{ field: "payee", text: "NOBODY" }],
        contactId: w.people.caltex.id,
        lines: [{ accountCode: "4000", percentage: "100", taxCode: "GST" }],
      }),
    );
    await w.asUser(owner, (tx) =>
      createTaxCode(tx, { idempotencyKey: key("tax"), code: "PUR", label: "GST on purchases", category: "standard", rate: "0.15", effectiveFrom: "2010-10-01", availableOn: "purchases" }),
    );
    await expect(
      w.asUser(bookkeeper, (tx) =>
        updateBankRule(tx, moneyIn.id, {
          name: "Now money out",
          direction: "out",
          conditions: [{ field: "payee", text: "NOBODY" }],
          contactId: w.people.caltex.id,
          lines: [{ accountCode: "6120", percentage: "100", taxCode: "PUR" }],
        }),
      ),
    ).resolves.toMatchObject({ direction: "out", lines: [{ taxCode: "PUR" }] });
    // A money-in rule never matches money out.
    await w.asUser(bookkeeper, (tx) =>
      createBankRule(tx, {
        name: "Money in",
        direction: "in",
        priority: 1,
        conditions: [{ field: "payee", operator: "contains", text: "CALTEX" }],
        contactId: w.people.caltex.id,
        lines: [{ accountCode: "4000", percentage: "100", taxCode: "GST" }],
      }),
    );
    expect((await w.suggest("2026-06-04"))?.name).toBe("B Fuel");
  });

  it("BR8: OK all posts every confident rule suggestion on its own; a locked period refuses its lines", async () => {
    const w = await setup();
    await w.asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: "2026-06-05", reason: "Test set-up" }));
    const result = await okConfidentMatches(w.run, w.bank.id, { idempotencyKey: key("ok-all") });
    const byDate = new Map<string, boolean>();
    const all = await w.lines();
    for (const entry of result.results) byDate.set(all.find((line) => line.id === entry.lineId)!.date, entry.ok);
    expect(Object.fromEntries(byDate)).toEqual({
      "2026-06-02": false,
      "2026-06-04": false,
      "2026-06-05": false,
      "2026-06-06": true,
      "2026-06-08": true,
      "2026-06-09": true,
      "2026-06-10": true,
    });
    const after = await w.lines();
    const reconciled = after.filter((line) => line.status === "reconciled").map((line) => line.date).sort();
    expect(reconciled).toEqual(["2026-06-06", "2026-06-08", "2026-06-09", "2026-06-10"]);
    expect(after.find((line) => line.date === "2026-06-12")!.status).toBe("unreconciled");
    expect(after.find((line) => line.date === "2026-06-03")!.status).toBe("unreconciled");
  });

  it("BR9: saving a rule is refused for bad percentages, amounts, sizes, archived values and required tracking", async () => {
    const w = await setup();
    const base = {
      name: "Bad",
      direction: "out",
      conditions: [{ field: "payee", operator: "contains", text: "X" }],
      contactId: w.people.spark.id,
    };
    const save = (extra: Record<string, unknown>, user = bookkeeper) => w.asUser(user, (tx) => createBankRule(tx, { ...base, ...extra }));
    const lines = (...percentages: string[]) => ({ lines: percentages.map((percentage) => ({ accountCode: "6170", percentage, taxCode: "GST" })) });
    await expect(save(lines("60", "39.99"))).rejects.toThrow("The percentage lines add up to 99.99%; they must add up to exactly 100%.");
    await expect(save(lines("60", "40.01"))).rejects.toThrow("add up to 100.01%");
    await expect(save(lines("0", "100"))).rejects.toThrow(/percentage must (not be zero|be more than 0)/);
    await expect(save(lines("33.333", "66.667"))).rejects.toThrow(/decimal places/);
    await expect(save({ lines: [{ accountCode: "6170", fixedAmount: "5.00", taxCode: "GST" }] })).rejects.toThrow("Add at least one percentage line");
    await expect(save({ lines: [{ accountCode: "6170", fixedAmount: "0", taxCode: null }, { accountCode: "6170", percentage: "100" }] })).rejects.toThrow(
      /fixed amount must (not be zero|be more than 0)/,
    );
    await expect(save({ ...lines("100"), conditions: Array.from({ length: 11 }, () => ({ field: "payee", text: "X" })) })).rejects.toThrow(/conditions/);
    await expect(save({ lines: Array.from({ length: 21 }, () => ({ accountCode: "6170", percentage: "1" })) })).rejects.toThrow(/lines/);
    await expect(save({ ...lines("100"), conditions: [] })).rejects.toThrow("Add at least one condition.");
    await expect(save({ ...lines("100"), conditions: [{ field: "amount", operator: "between", amount: "50", amountTo: "10" }] })).rejects.toThrow(
      "the first amount can't be more than the second",
    );
    // A sales-only code on a money-out rule (TAO7, TAO8) is in tax-available-on.test.ts.
    await w.asUser(owner, (tx) => tx.query("update accounts set is_active = false where code = '6160'"));
    await expect(save({ lines: [{ accountCode: "6160", percentage: "100", taxCode: "GST" }] })).rejects.toThrow("account 6160 is archived");
    await w.asUser(owner, (tx) => updateTrackingCategory(tx, w.department, { isRequired: true }));
    await expect(save(lines("100"))).rejects.toThrow("Line 1 needs a Department");
    await expect(save({ lines: [{ accountCode: "6170", percentage: "100", taxCode: "GST", tracking: { [w.department]: w.retail } }] })).resolves.toMatchObject({
      name: "Bad",
    });
  });

  it("BR10: a rule in the older one-condition shape suggests exactly what it did", async () => {
    const w = await setup();
    const legacy = await w.asUser(bookkeeper, (tx) =>
      createBankRule(tx, {
        name: "Fuel",
        priority: 1,
        matchText: "z energy",
        direction: "out",
        contactId: w.people.zEnergy.id,
        targetAccountCode: "6120",
        taxCode: "GST",
        amountsMode: "inclusive",
      }),
    );
    expect(legacy).toMatchObject({
      matchMode: "all",
      conditions: [{ field: "any", operator: "contains", text: "z energy" }],
      contactMode: "chosen",
      lines: [{ accountCode: "6120", taxCode: "GST", percentage: "100.00", fixedAmount: null }],
    });
    const suggestion = await w.suggest("2026-06-05");
    expect(suggestion).toMatchObject({
      name: "Fuel",
      contactName: "Z Energy",
      amountsMode: "inclusive",
      suggestedLine: { description: "Z ENERGY", accountCode: "6120", taxCode: "GST", amount: "11.50" },
    });
    expect((await w.asUser(viewer, (tx) => listBankRules(tx))).map((rule) => rule.name)).toContain("Fuel");
  });

  it("SD2 and SD3: bulk coding with no account uses the contact's defaults; archived defaults are kept but not used", async () => {
    const w = await setup();
    const spark = await w.asUser(bookkeeper, (tx) =>
      updateContact(tx, w.people.spark.id, {
        defaultPurchaseAccountCode: "6170",
        defaultPurchaseTaxCode: "GST",
        defaultPurchaseTracking: { [w.department]: w.retail },
      }),
    );
    expect(spark).toMatchObject({ defaultPurchaseAccountCode: "6170", defaultPurchaseTaxCode: "GST", defaultPurchaseTracking: { [w.department]: w.retail } });
    const history = await w.asUser(owner, (tx) =>
      tx.query<{ details: { changes: Record<string, unknown> } }>(
        "select details from audit_events where entity_type = 'contact' and entity_id = $1 and event_type = 'contact.updated' order by id desc limit 1",
        [w.people.spark.id],
      ),
    );
    expect(Object.keys(history.rows[0].details.changes).sort()).toEqual(["defaultPurchaseAccountCode", "defaultPurchaseTaxCode", "defaultPurchaseTracking"]);

    const line = await w.lineOn("2026-06-03");
    const coded = await cashCodeStatementLines(w.run, w.bank.id, { idempotencyKey: key("cash"), lines: [{ lineId: line.id }] });
    expect(coded).toMatchObject({ succeeded: 1, failed: 0 });
    const reconciled = (await w.lines()).find((entry) => entry.id === line.id)!;
    expect(await w.journalLines(reconciled.reconciliation!.items[0].journalId)).toEqual(
      expect.arrayContaining([
        ["6170", "200.00", "0.00", w.retail],
        ["2100", "30.00", "0.00", null],
        ["1000", "0.00", "230.00", null],
      ]),
    );
    // A chosen account wins: 6120, GST, no tracking.
    const other = await w.lineOn("2026-06-02");
    await cashCodeStatementLines(w.run, w.bank.id, { idempotencyKey: key("cash"), accountCode: "6120", taxCode: "GST", lines: [{ lineId: other.id }] });
    const otherDone = (await w.lines()).find((entry) => entry.id === other.id)!;
    expect(await w.journalLines(otherDone.reconciliation!.items[0].journalId)).toEqual(
      expect.arrayContaining([
        ["6120", "100.00", "0.00", null],
        ["2100", "15.00", "0.00", null],
      ]),
    );

    // SD3: archived after it was set: kept, but not used.
    await w.asUser(owner, (tx) => tx.query("update accounts set is_active = false where code = '6170'"));
    const kept = await w.asUser(bookkeeper, (tx) => updateContact(tx, w.people.spark.id, { phone: "03 477 0000" }));
    expect(kept.defaultPurchaseAccountCode).toBe("6170");
    await w.asUser(bookkeeper, (tx) =>
      importStatementFile(tx, w.bank.id, { idempotencyKey: key("import"), fileName: "spark.csv", fileBase64: b64("Date,Amount,Payee\n20/06/2026,-57.50,SPARK\n") }),
    );
    const late = await w.lineOn("2026-06-20");
    const refused = await cashCodeStatementLines(w.run, w.bank.id, { idempotencyKey: key("cash"), lines: [{ lineId: late.id }] });
    expect(refused).toMatchObject({ succeeded: 0, failed: 1, results: [{ ok: false, error: "Choose an account for this line." }] });
    await expect(w.asUser(bookkeeper, (tx) => updateContact(tx, w.people.caltex.id, { defaultPurchaseAccountCode: "6170" }))).rejects.toThrow(
      "Account 6170 (Telephone and internet) is archived, so it can't be a contact's default purchase account.",
    );
    await expect(w.asUser(bookkeeper, (tx) => updateContact(tx, w.people.caltex.id, { defaultPurchaseAccountCode: "4000" }))).rejects.toThrow(
      "The default purchase account can't be account 4000",
    );
    await expect(w.asUser(bookkeeper, (tx) => updateContact(tx, w.people.caltex.id, { defaultSalesAccountCode: "6120" }))).rejects.toThrow(
      "it isn't a revenue account",
    );
  });
});
