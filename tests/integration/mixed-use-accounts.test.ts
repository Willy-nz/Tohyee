import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as mcpRoute from "@/app/api/mcp/route";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as usageRoute from "@/app/api/bank-accounts/[accountId]/usage/route";
import * as batchRoute from "@/app/api/bank-accounts/[accountId]/mixed-use-lines/batch/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, listBankAccounts, listStatementLines, setStatementLineExcluded, type BankAccount, type StatementLine } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { getAccountUsage, listReviewLines, reviewLine, setAccountUsage, undoReview } from "@/lib/bank/mixed-use";
import { reconcileStatementLine } from "@/lib/bank/reconcile";
import { createBankTransaction, createTransfer, voidBankTransaction } from "@/lib/bank/transactions";
import { type Contact, createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { postJournal } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { calculateGstReturn } from "@/lib/reports/gst-return";
import { dec, sub, toFixedString } from "@/lib/money/decimal";
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

/**
 * Personal and mixed-use accounts (#545, examples MU1-MU14), with a made-up
 * sole trader: Aroha Lawn Care. 2410 Aroha's Visa is mixed use, 1020 Aroha's
 * everyday account personal, 1000 the business account.
 */

const ORG = "aroha-lawn-care";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;

describeWithDatabase("Personal and mixed-use accounts (#545, MU1-MU14)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let business: BankAccount;
  let visa: BankAccount;
  let everyday: BankAccount;
  let zEnergy: Contact;
  let stationery: Contact;
  let pbTech: Contact;
  let fileNumber = 0;
  const tokens: Record<string, string> = {};

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const sql = async <T extends Json = Json>(text: string, values: unknown[] = []) => (await asUser(owner, (tx) => tx.query<T>(text, values))).rows;
  const balance = async (code: string) =>
    (await sql<{ b: string }>("select coalesce(sum(l.debit_amount - l.credit_amount), 0)::numeric(14,2)::text as b from ledger_journal_lines l join accounts a on a.id = l.account_id where a.code = $1", [code]))[0].b;
  const journalLines = async (journalId: string) =>
    (await sql<{ code: string; debit: string; credit: string }>(
      "select a.code, l.debit_amount::numeric(14,2)::text as debit, l.credit_amount::numeric(14,2)::text as credit from ledger_journal_lines l join accounts a on a.id = l.account_id where l.journal_id = $1 order by l.line_order",
      [journalId],
    )).map((row) => `${row.code} ${row.debit === "0.00" ? `Cr ${row.credit}` : `Dr ${row.debit}`}`);
  const btJournal = async (bankTransactionId: string) => (await sql<{ j: string }>("select journal_id::text as j from bank_transactions where id = $1", [bankTransactionId]))[0].j;

  async function importLines(account: BankAccount, rows: string[]): Promise<StatementLine[]> {
    fileNumber += 1;
    await asUser(owner, (tx) =>
      importStatementFile(tx, account.id, {
        idempotencyKey: key("import"),
        fileName: `mu${fileNumber}.csv`,
        fileBase64: Buffer.from(`Date,Amount,Payee\n${rows.join("\n")}\n`).toString("base64"),
      }),
    );
    const all = (await asUser(owner, (tx) => listStatementLines(tx, account.id, { status: "all", limit: 500 }))).lines;
    return rows.map((row) => {
      const [date, amount, payee] = row.split(",");
      const iso = `${date.slice(6)}-${date.slice(3, 5)}-${date.slice(0, 2)}`;
      return all.filter((entry) => entry.amount === amount && entry.date === iso && entry.description.includes(payee)).at(-1)!;
    });
  }

  const review = (lineId: string, body: Json, user: SessionUser = bookkeeper, ai = false) =>
    asUser(user, (tx) => reviewLine(tx, lineId, { idempotencyKey: key("review"), ...body }, { ai }));
  const fuel = (lineId: string, amount = "46.00", extra: Json = {}) =>
    review(lineId, { decision: "business", contactId: zEnergy.id, lines: [{ accountCode: "6120", taxCode: "GST", amount, description: "Fuel" }], gstEvidence: "tax_document", ...extra });

  let rpcId = 0;
  async function call(token: string, name: string, args: Json = {}): Promise<Json> {
    rpcId += 1;
    const response = await mcpRoute.POST(
      new Request("http://tohyee.test/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name, arguments: args } }),
      }),
      noContext,
    );
    const body = (await response.json()) as Json;
    if (body.error) throw new Error(`rpc: ${(body.error as Json).message}`);
    const result = body.result as { content: { text: string }[]; isError?: boolean };
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text) as Json;
  }

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("aroha-owner@example.com", { serverAdmin: true, displayName: "Aroha" });
    bookkeeper = await createTestUser("aroha-bookkeeper@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, bookkeeper.id]);
    await asUser(owner, (tx) => updateOrganisationSettings(tx, { gstRegistrationConfirmed: true }));
    const contact = async (name: string) => (await asUser(owner, (tx) => createContact(tx, { idempotencyKey: key("c"), name, isSupplier: true }))).contact;
    zEnergy = await contact("Z Energy");
    stationery = await contact("Warehouse Stationery");
    pbTech = await contact("PB Tech");
    await asUser(owner, (tx) => createBankAccount(tx, { code: "2410", name: "Aroha's Visa", accountType: "credit_card" }));
    await asUser(owner, (tx) => createBankAccount(tx, { code: "1020", name: "Aroha's everyday account", accountType: "bank" }));
    const accounts = await asUser(owner, (tx) => listBankAccounts(tx));
    business = accounts.find((account) => account.code === "1000")!;
    visa = accounts.find((account) => account.code === "2410")!;
    everyday = accounts.find((account) => account.code === "1020")!;
    for (const level of ["full", "post", "read"] as const) {
      const response = await tokensRoute.POST(
        apiRequest("/api/ai/tokens", {
          method: "POST",
          cookie: await sessionCookieFor(owner),
          body: { organisationId: ORG, name: level, accessLevel: level, ...(level === "full" ? { confirmFullAccess: true } : {}) },
        }),
        noContext,
      );
      expect(response.status).toBe(201);
      tokens[level] = ((await response.json()) as { token: string }).token;
    }
  });

  afterAll(async () => {
    await server?.teardown();
  });

  describe("MU1 choosing how an account is used", () => {
    it("starts business only; an admin makes the Visa mixed use with 3000 as the owner account, and it's audited", async () => {
      expect((await asUser(owner, (tx) => getAccountUsage(tx, visa.id))).usage).toBe("business");
      // A bookkeeper can't change it (the route needs admin).
      const refused = await usageRoute.PUT(
        apiRequest(`/api/bank-accounts/${visa.id}/usage`, { method: "PUT", cookie: await sessionCookieFor(bookkeeper), body: { organisationId: ORG, usage: "mixed" } }),
        { params: Promise.resolve({ accountId: visa.id }) },
      );
      expect(refused.status).toBe(403);
      await expect(asUser(owner, (tx) => setAccountUsage(tx, visa.id, { usage: "mixed", ownerAccountCode: "6120" }))).rejects.toThrow(/must be an active equity account/);
      const set = await asUser(owner, (tx) => setAccountUsage(tx, visa.id, { usage: "mixed" }));
      expect(set).toMatchObject({ usage: "mixed", ownerAccount: { code: "3000", name: "Owner funds introduced" } });
      const audit = await sql<{ details: Json }>("select details from audit_events where event_type = 'bank_account.usage_changed' and entity_id = $1", [visa.id]);
      expect(audit[0].details).toMatchObject({ from: "business", to: "mixed" });
    });

    it("refuses an account already in the business books", async () => {
      await asUser(owner, (tx) => createBankAccount(tx, { code: "2420", name: "Old card", accountType: "credit_card" }));
      const old = (await asUser(owner, (tx) => listBankAccounts(tx))).find((account) => account.code === "2420")!;
      await asUser(owner, (tx) =>
        createBankTransaction(tx, { idempotencyKey: key("bt"), kind: "spend", accountId: old.id, contactId: zEnergy.id, date: "2026-05-01", amountsMode: "no_tax", lines: [{ description: "x", accountCode: "6120", amount: "10.00" }] }),
      );
      await expect(asUser(owner, (tx) => setAccountUsage(tx, old.id, { usage: "mixed" }))).rejects.toThrow(/already in the business books/);
    });
  });

  describe("MU2-MU6 business, private and split", () => {
    it("MU2: a business purchase posts spend money and an owner journal; the card's balance stays 0.00 and GST counts", async () => {
      const [line] = await importLines(visa, ["21/05/2026,-46.00,Z ENERGY"]);
      const gstBefore = await asUser(owner, (tx) => calculateGstReturn(tx, { periodStart: "2026-05-01", periodEnd: "2026-05-31" }));
      const done = await fuel(line.id);
      expect(done.created).toBe(true);
      const reviewed = done.line.review!;
      expect(reviewed).toMatchObject({ decision: "business", businessAmount: "46.00", privateAmount: "0.00", contactName: "Z Energy" });
      expect(await journalLines(await btJournal(reviewed.bankTransactionId!))).toEqual(["6120 Dr 40.00", "2100 Dr 6.00", "2410 Cr 46.00"]);
      expect(await journalLines(reviewed.ownerJournalId!)).toEqual(["2410 Dr 46.00", "3000 Cr 46.00"]);
      expect(await balance("2410")).toBe("0.00");
      expect(done.line.state).toBe("reviewed");
      expect((await sql("select status from bank_statement_lines where id = $1", [line.id]))[0].status).toBe("excluded");
      expect(await sql("select 1 from bank_reconciliations where statement_line_id = $1", [line.id])).toHaveLength(0);
      const gstAfter = await asUser(owner, (tx) => calculateGstReturn(tx, { periodStart: "2026-05-01", periodEnd: "2026-05-31" }));
      expect(toFixedString(sub(dec(gstAfter.boxes.box11), dec(gstBefore.boxes.box11)), 2)).toBe("46.00");
      // A retry with the same key posts nothing more.
      const again = await asUser(bookkeeper, (tx) =>
        reviewLine(tx, line.id, { idempotencyKey: "mu2-retry-key", decision: "private" }),
      ).catch((error: Error) => error);
      expect(String(again)).toMatch(/already reviewed as business/);
    });

    it("MU3: a private purchase posts nothing", async () => {
      const [line] = await importLines(visa, ["22/05/2026,-120.00,COUNTDOWN"]);
      const journals = (await sql<{ n: string }>("select count(*)::text as n from ledger_journals"))[0].n;
      const done = await review(line.id, { decision: "private" });
      expect(done.line.review).toMatchObject({ decision: "private", businessAmount: "0.00", privateAmount: "120.00", bankTransactionId: null });
      expect((await sql<{ n: string }>("select count(*)::text as n from ledger_journals"))[0].n).toBe(journals);
    });

    it("MU4: a split purchase posts only the business part", async () => {
      const [line] = await importLines(visa, ["23/05/2026,-230.00,WAREHOUSE STATIONERY"]);
      const split = (business: string) =>
        review(line.id, { decision: "split", businessAmount: business, contactId: stationery.id, lines: [{ accountCode: "6140", taxCode: "GST", amount: business }], gstEvidence: "tax_document" });
      await expect(split("230.00")).rejects.toThrow(/less than the line/);
      const done = await split("80.50");
      expect(done.line.review).toMatchObject({ decision: "split", businessAmount: "80.50", privateAmount: "149.50" });
      expect(await journalLines(await btJournal(done.line.review!.bankTransactionId!))).toEqual(["6140 Dr 70.00", "2100 Dr 10.50", "2410 Cr 80.50"]);
      expect(await journalLines(done.line.review!.ownerJournalId!)).toEqual(["2410 Dr 80.50", "3000 Cr 80.50"]);
      // MU6: 46.00 + 80.50 introduced by the owner; the card is still 0.00.
      expect(await balance("3000")).toBe("-126.50");
      expect(await balance("2410")).toBe("0.00");
    });

    it("MU5: GST needs the receipt from a person, and evidence from an AI; no GST needs neither", async () => {
      const [line] = await importLines(visa, ["24/05/2026,-46.00,Z ENERGY PARKING"]);
      await expect(fuel(line.id, "46.00", { gstEvidence: null })).rejects.toThrow(/tick that you have the receipt/);
      await expect(asUser(owner, (tx) => reviewLine(tx, line.id, { idempotencyKey: key("ai"), decision: "business", contactId: zEnergy.id, lines: [{ accountCode: "6120", taxCode: "GST", amount: "46.00" }] }, { ai: true }))).rejects.toThrow(/gstEvidence/);
      const done = await review(line.id, { decision: "business", contactId: zEnergy.id, lines: [{ accountCode: "6120", taxCode: null, amount: "46.00" }] });
      expect(await journalLines(await btJournal(done.line.review!.bankTransactionId!))).toEqual(["6120 Dr 46.00", "2410 Cr 46.00"]);
      await asUser(bookkeeper, (tx) => undoReview(tx, line.id, { idempotencyKey: key("undo") }));
    });
  });

  describe("MU7-MU9 repayments, refunds and undo", () => {
    it("MU7: paying the card from the business account is drawings; the card's +500.00 can only be private", async () => {
      const [payment] = await importLines(business, ["30/05/2026,-500.00,VISA PAYMENT"]);
      const [received] = await importLines(visa, ["30/05/2026,500.00,PAYMENT THANK YOU"]);
      await expect(
        asUser(bookkeeper, (tx) => createTransfer(tx, { idempotencyKey: key("tr"), fromAccountCode: "1000", toAccountCode: "2410", date: "2026-05-30", amount: "500.00" })),
      ).rejects.toThrow(/mixed-use or personal account/);
      await asUser(bookkeeper, (tx) =>
        reconcileStatementLine(tx, payment.id, { idempotencyKey: key("rec"), kind: "bank_transaction", contactId: zEnergy.id, amountsMode: "no_tax", lines: [{ description: "Visa payment", accountCode: "3100", amount: "500.00" }] }),
      );
      expect(await balance("3100")).toBe("500.00");
      const listed = (await asUser(bookkeeper, (tx) => listReviewLines(tx, visa.id))).lines.find((entry) => entry.id === received.id)!;
      expect(listed.looksLikePaymentFrom).toBe("1000 Business bank account");
      await expect(review(received.id, { decision: "business", contactId: zEnergy.id, lines: [{ accountCode: "6120", amount: "500.00" }] })).rejects.toThrow(/only be a refund/);
      expect((await review(received.id, { decision: "private" })).line.review?.decision).toBe("private");
      expect(await balance("2410")).toBe("0.00");
    });

    it("MU8: a refund reverses the original's accounts and GST, up to what's left", async () => {
      const [purchase, partial, rest, extra] = await importLines(visa, [
        "01/06/2026,-46.00,Z ENERGY TOKOROA",
        "02/06/2026,23.00,Z ENERGY REFUND A",
        "03/06/2026,23.00,Z ENERGY REFUND B",
        "04/06/2026,46.00,Z ENERGY REFUND C",
      ]);
      await fuel(purchase.id);
      const refund = (lineId: string, amount: string, accountCode = "6120") =>
        review(lineId, { decision: "refund", refundOfLineId: purchase.id, lines: [{ accountCode, taxCode: "GST", amount }] });
      await expect(refund(partial.id, "23.00", "6140")).rejects.toThrow(/original purchase's accounts/);
      const first = await refund(partial.id, "23.00");
      expect(await journalLines(await btJournal(first.line.review!.bankTransactionId!))).toEqual(["6120 Cr 20.00", "2100 Cr 3.00", "2410 Dr 23.00"]);
      expect(await journalLines(first.line.review!.ownerJournalId!)).toEqual(["2410 Cr 23.00", "3000 Dr 23.00"]);
      await refund(rest.id, "23.00");
      await expect(refund(extra.id, "46.00")).rejects.toThrow(/more than is left to refund/);
      expect(await balance("2410")).toBe("0.00");

      // MU9: the purchase can't be undone while a refund of it stands.
      await expect(asUser(bookkeeper, (tx) => undoReview(tx, purchase.id, { idempotencyKey: key("undo") }))).rejects.toThrow(/Undo the refund first/);
    });

    it("MU9: undo voids on the line's date and puts the line back to review; locked periods are refused", async () => {
      const [line] = await importLines(visa, ["05/06/2026,-46.00,Z ENERGY MOSGIEL"]);
      const done = await fuel(line.id);
      const owner3000 = await balance("3000");
      const undone = await asUser(bookkeeper, (tx) => undoReview(tx, line.id, { idempotencyKey: key("undo") }));
      expect(undone.line.state).toBe("to_review");
      const voided = await sql<{ status: string; void_date: string; void_journal_id: string }>(
        "select status, void_date::text, void_journal_id::text from bank_transactions where id = $1",
        [done.line.review!.bankTransactionId],
      );
      expect(voided[0]).toMatchObject({ status: "voided", void_date: "2026-06-05" });
      expect(await journalLines(voided[0].void_journal_id)).toEqual(["6120 Cr 40.00", "2100 Cr 6.00", "2410 Dr 46.00"]);
      const reversal = await sql<{ posting_date: string; id: string }>("select posting_date::text, id::text from ledger_journals where related_journal_id = $1", [done.line.review!.ownerJournalId]);
      expect(reversal[0].posting_date).toBe("2026-06-05");
      expect(await journalLines(reversal[0].id)).toEqual(["2410 Cr 46.00", "3000 Dr 46.00"]);
      expect(toFixedString(sub(dec(await balance("3000")), dec(owner3000)), 2)).toBe("46.00");
      expect(await balance("2410")).toBe("0.00");
      const history = await sql<{ status: string; undone_by_email: string }>("select status, undone_by_email from mixed_use_reviews where statement_line_id = $1", [line.id]);
      expect(history).toEqual([{ status: "undone", undone_by_email: bookkeeper.email }]);

      const [locked] = await importLines(visa, ["10/04/2026,-12.00,Z ENERGY APRIL"]);
      await fuel(locked.id, "12.00");
      await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: "2026-04-30" }));
      await expect(asUser(bookkeeper, (tx) => undoReview(tx, locked.id, { idempotencyKey: key("undo") }))).rejects.toThrow();
      await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: null, reason: "Test set-up" }));
    });
  });

  describe("MU10-MU11 no way round it, and duplicates", () => {
    it("MU10: reconciling, including a reviewed line, voiding on its own and journals to the card are refused", async () => {
      const [line, other] = await importLines(visa, ["06/06/2026,-30.00,Z ENERGY ONE", "06/06/2026,-31.00,Z ENERGY TWO"]);
      await expect(
        asUser(bookkeeper, (tx) => reconcileStatementLine(tx, other.id, { idempotencyKey: key("rec"), kind: "bank_transaction", contactId: zEnergy.id, amountsMode: "no_tax", lines: [{ description: "x", accountCode: "6120", amount: "31.00" }] })),
      ).rejects.toThrow(/Review it instead/);
      const done = await fuel(line.id, "30.00");
      await expect(asUser(bookkeeper, (tx) => setStatementLineExcluded(tx, line.id, false))).rejects.toThrow(/Undo the review first/);
      await expect(asUser(bookkeeper, (tx) => voidBankTransaction(tx, done.line.review!.bankTransactionId!, { idempotencyKey: key("void"), voidDate: "2026-06-06" }))).rejects.toThrow(
        /nothing in the business books can be owed/,
      );
      await expect(
        asUser(owner, (tx) =>
          postJournal(tx, { idempotencyKey: key("j"), postingDate: "2026-06-06", reference: "x", lines: [{ accountCode: "2410", debitAmount: "5.00" }, { accountCode: "3000", creditAmount: "5.00" }] }),
        ),
      ).rejects.toThrow();
      // A line not reviewed can still be excluded as a duplicate (BK12), and included again.
      await asUser(bookkeeper, (tx) => setStatementLineExcluded(tx, other.id, true));
      await asUser(bookkeeper, (tx) => setStatementLineExcluded(tx, other.id, false));
      expect(await balance("2410")).toBe("0.00");
    });

    it("MU11: the same file again adds nothing; a possible duplicate of a business line waits for the person", async () => {
      const ofx = `OFXHEADER:100\n<OFX><BANKTRANLIST>\n<STMTTRN><DTPOSTED>20260607<TRNAMT>-64.40<FITID>V1<NAME>BUNNINGS\n</BANKTRANLIST></OFX>`;
      const csv = "Date,Amount,Payee\n07/06/2026,-64.40,BUNNINGS\n";
      const upload = (body: string, fileName: string) =>
        asUser(owner, (tx) => importStatementFile(tx, visa.id, { idempotencyKey: key("i"), fileName, fileBase64: Buffer.from(body).toString("base64") }));
      expect((await upload(ofx, "v.ofx")).import).toMatchObject({ lineCount: 1 });
      expect((await upload(ofx, "v.ofx")).import).toMatchObject({ lineCount: 0, duplicateCount: 1 });
      expect((await upload(csv, "v.csv")).import).toMatchObject({ lineCount: 1, possibleDuplicateCount: 1 });
      const lines = (await asUser(owner, (tx) => listStatementLines(tx, visa.id, { status: "all", limit: 500 }))).lines.filter((entry) => entry.amount === "-64.40");
      const original = lines.find((entry) => !entry.possibleDuplicateOf)!;
      const flagged = lines.find((entry) => entry.possibleDuplicateOf)!;
      const tools = (lineId: string, extra: Json = {}) =>
        review(lineId, { decision: "business", contactId: pbTech.id, lines: [{ accountCode: "6160", taxCode: null, amount: "64.40" }], ...extra });
      await tools(original.id);
      await expect(tools(flagged.id)).rejects.toThrow(/looks like a duplicate/);
      await tools(flagged.id, { notDuplicate: true });
      expect(await balance("2410")).toBe("0.00");
    });
  });

  describe("MU12-MU13 personal accounts, and back to business only", () => {
    it("MU12: a personal account's lines come in private; one can be business; mixed use puts the automatic ones back", async () => {
      await asUser(owner, (tx) => setAccountUsage(tx, everyday.id, { usage: "personal" }));
      const [groceries, laptop, power] = await importLines(everyday, ["08/06/2026,-88.00,NEW WORLD", "09/06/2026,-64.40,PB TECH", "10/06/2026,-150.00,MERIDIAN"]);
      const listed = await asUser(owner, (tx) => listReviewLines(tx, everyday.id, { state: "all" }));
      expect(listed.lines.filter((entry) => [groceries.id, laptop.id, power.id].includes(entry.id)).map((entry) => [entry.state, entry.review?.automatic])).toEqual([
        ["reviewed", true],
        ["reviewed", true],
        ["reviewed", true],
      ]);
      expect((await asUser(owner, (tx) => listBankAccounts(tx))).find((account) => account.code === "1020")!.unreconciledCount).toBe(0);
      const done = await review(laptop.id, { decision: "business", contactId: pbTech.id, lines: [{ accountCode: "6070", taxCode: null, amount: "64.40" }] });
      expect(done.line.review).toMatchObject({ decision: "business", automatic: false });
      await review(power.id, { decision: "private" });
      await asUser(owner, (tx) => setAccountUsage(tx, everyday.id, { usage: "mixed" }));
      const after = await asUser(owner, (tx) => listReviewLines(tx, everyday.id, { state: "all" }));
      const state = (id: string) => after.lines.find((entry) => entry.id === id)!;
      expect(state(groceries.id).state).toBe("to_review");
      expect(state(laptop.id).review?.decision).toBe("business");
      expect(state(power.id).review?.decision).toBe("private");
    });

    it("MU13: back to business only waits for business reviews to be undone; private reviews end", async () => {
      await expect(asUser(owner, (tx) => setAccountUsage(tx, everyday.id, { usage: "business" }))).rejects.toThrow(/Undo those reviews first/);
      const laptop = (await asUser(owner, (tx) => listReviewLines(tx, everyday.id, { state: "reviewed" }))).lines.find((entry) => entry.review?.decision === "business")!;
      await asUser(owner, (tx) => undoReview(tx, laptop.id, { idempotencyKey: key("undo") }));
      expect(await balance("1020")).toBe("0.00");
      const changed = await asUser(owner, (tx) => setAccountUsage(tx, everyday.id, { usage: "business" }));
      expect(changed.usage).toBe("business");
      expect(await sql("select 1 from mixed_use_reviews r join bank_statement_lines l on l.id = r.statement_line_id where l.account_id = $1 and r.status = 'active'", [everyday.id])).toHaveLength(0);
    });
  });

  describe("MU14 AI and bulk", () => {
    it("look-only keys list; only Full access reviews (with evidence), and undoes only its own", async () => {
      const [aiLine, personLine, a, b] = await importLines(visa, ["11/06/2026,-46.00,Z ENERGY AI", "11/06/2026,-20.00,Z ENERGY PERSON", "12/06/2026,-9.00,KMART A", "12/06/2026,-8.00,KMART B"]);
      const listed = await call(tokens.read, "list_mixed_use_lines", {});
      expect((listed.accounts as Json[]).map((account) => account.code)).toContain("2410");
      const lines = await call(tokens.read, "list_mixed_use_lines", { accountId: visa.id });
      expect((lines.lines as Json[]).some((entry) => entry.id === aiLine.id)).toBe(true);
      await expect(call(tokens.post, "review_mixed_use_line", { lineId: aiLine.id, decision: "private" })).rejects.toThrow();
      await expect(call(tokens.full, "review_mixed_use_line", { lineId: aiLine.id, decision: "business", contactId: zEnergy.id, lines: [{ accountCode: "6120", taxCode: "GST", amount: "46.00" }] })).rejects.toThrow(
        /gstEvidence/,
      );
      const done = await call(tokens.full, "review_mixed_use_line", {
        lineId: aiLine.id,
        decision: "business",
        contactId: zEnergy.id,
        lines: [{ accountCode: "6120", taxCode: "GST", amount: "46.00" }],
        gstEvidence: "tax_document",
        idempotencyKey: "ai-review-0001",
      });
      expect((done.line as Json).review).toMatchObject({ decision: "business", createdVia: expect.stringContaining("full") });
      await fuel(personLine.id, "20.00");
      await expect(call(tokens.full, "undo_mixed_use_review", { lineId: personLine.id })).rejects.toThrow(/reviewed by a person/);
      const undone = await call(tokens.full, "undo_mixed_use_review", { lineId: aiLine.id });
      expect((undone.line as Json).state).toBe("to_review");

      // A batch of reviews, readable as a bank batch.
      const batch = await call(tokens.full, "review_mixed_use_lines", {
        actions: [
          { lineId: a.id, decision: "private" },
          { lineId: b.id, decision: "business", contactId: zEnergy.id, lines: [{ accountCode: "6070", taxCode: "GST", amount: "8.00" }] },
        ],
        idempotencyKey: "ai-batch-0001",
      });
      expect(batch).toMatchObject({ kind: "mixed_use_review", succeeded: 1, failed: 1 });
      expect(((batch.results as Json[])[1].error as string)).toMatch(/gstEvidence/);
      const again = await call(tokens.full, "get_bank_batch", { batchId: batch.batchId });
      expect(again).toMatchObject({ succeeded: 1 });
      // No tool changes how an account is used.
      expect(await call(tokens.full, "list_mixed_use_lines", {}).then((answer) => Object.keys(answer))).not.toContain("setUsage");
    });

    it("a person marks several lines private at once, as a batch", async () => {
      const [x, y] = await importLines(visa, ["13/06/2026,-5.00,DAIRY ONE", "13/06/2026,-6.00,DAIRY TWO"]);
      const response = await batchRoute.POST(
        apiRequest(`/api/bank-accounts/${visa.id}/mixed-use-lines/batch`, {
          method: "POST",
          cookie: await sessionCookieFor(bookkeeper),
          body: { organisationId: ORG, idempotencyKey: key("bulk"), actions: [{ lineId: x.id, decision: "private" }, { lineId: y.id, decision: "private" }] },
        }),
        noContext,
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as { batch: { counts: { committed: number } } };
      expect(body.batch.counts.committed).toBe(2);
    });
  });
});
