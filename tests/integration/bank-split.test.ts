import { afterAll, beforeAll, expect, it } from "vitest";
import * as reconcileRoute from "@/app/api/statement-lines/[lineId]/reconcile/route";
import * as unreconcileRoute from "@/app/api/statement-lines/[lineId]/unreconcile/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, getStatementLine, listBankAccounts, listStatementLines } from "@/lib/bank/accounts";
import { cashCodeStatementLines } from "@/lib/bank/cash-coding";
import { confidentMatches, okConfidentMatches } from "@/lib/bank/confident";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine, unreconcileStatementLine } from "@/lib/bank/reconcile";
import { createBankTransaction, voidBankTransaction } from "@/lib/bank/transactions";
import { type Contact, createContact } from "@/lib/contacts/service";
import type { OrgRunner, OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { bankReconciliationReport } from "@/lib/reports/bank-reconciliation";
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

const b64 = (text: string) => Buffer.from(text).toString("base64");

const STATEMENT = `Date,Amount,Payee,Particulars,Code,Reference,Balance
20/05/2026,200.00,KOBE LTD,PART 1,,,200.00
03/06/2026,100.00,KOBE LTD,PART 2,,,300.00
`;

/**
 * Examples BK26-BK28 in docs/ACCOUNTING-EXAMPLES.md (one transaction on
 * several statement lines, not yet approved by Jess): receive money of 300.00
 * from Kobe Ltd on 20 May (journal line J on 1000), shown by the bank as
 * +200.00 on 20 May and +100.00 on 3 June.
 */
describeWithDatabase("one transaction split across several statement lines", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("split-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("split-bookkeeper@example.com");
    viewer = await createTestUser("split-viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup(options: { statement?: string; receiveDate?: string } = {}) {
    organisations += 1;
    const org = `split-${organisations}-co`;
    await createTestOrganisation(owner, org);
    for (const [user, role] of [
      [bookkeeper, "bookkeeper"],
      [viewer, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [org, user.id, role]);
    }
    const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) =>
      inOrganisation(org, { userId: user.id, email: user.email }, work);
    const run: OrgRunner = (work) => asUser(bookkeeper, work);
    const kobe: Contact = (
      await asUser(bookkeeper, (tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Kobe Ltd", isCustomer: true }))
    ).contact;
    await asUser(owner, (tx) => createBankAccount(tx, { code: "1010", name: "Savings account", accountType: "bank" }));
    const accounts = await asUser(viewer, (tx) => listBankAccounts(tx));
    const bank = accounts.find((account) => account.code === "1000")!;
    const savings = accounts.find((account) => account.code === "1010")!;
    const { bankTransaction: receive } = await asUser(bookkeeper, (tx) =>
      createBankTransaction(tx, {
        idempotencyKey: key("receive"),
        kind: "receive",
        accountId: bank.id,
        contactId: kobe.id,
        date: options.receiveDate ?? "2026-05-20",
        amountsMode: "no_tax",
        lines: [{ description: "Consulting", accountCode: "4000", amount: "300.00" }],
      }),
    );
    const sql = (text: string, values: unknown[] = []) => asUser(owner, (tx) => tx.query(text, values));
    const journalLine = (
      await sql("select id::text from ledger_journal_lines where journal_id = $1 and account_id = $2", [receive.journalId, bank.id])
    ).rows[0].id as string;
    const importFile = (text: string, accountId = bank.id) =>
      asUser(bookkeeper, (tx) => importStatementFile(tx, accountId, { idempotencyKey: key("import"), fileName: "statement.csv", fileBase64: b64(text) }));
    await importFile(options.statement ?? STATEMENT);
    const lines = async (status = "all", accountId = bank.id) =>
      (await asUser(viewer, (tx) => listStatementLines(tx, accountId, { status }))).lines;
    const lineOn = async (amount: string, date?: string, accountId = bank.id) =>
      (await lines("all", accountId)).find((line) => line.amount === amount && (!date || line.date === date))!;
    const split = (lineId: string, otherLineIds: string[], command: Record<string, unknown> = {}) =>
      asUser(bookkeeper, (tx) =>
        reconcileStatementLine(tx, lineId, { idempotencyKey: key("split"), kind: "split", journalLineId: journalLine, otherLineIds, ...command }),
      );
    const unreconcile = (lineId: string, idempotencyKey = key("unreconcile")) =>
      asUser(bookkeeper, (tx) => unreconcileStatementLine(tx, lineId, { idempotencyKey }));
    const line = (lineId: string) => asUser(viewer, (tx) => getStatementLine(tx, lineId));
    const journalCount = async () => Number((await sql("select count(*)::text as count from ledger_journals")).rows[0].count as string);
    const lock = (lockDate: string | null) => asUser(owner, (tx) => updatePeriodControls(tx, { lockDate }));
    const report = (asAt: string) => asUser(viewer, (tx) => bankReconciliationReport(tx, { accountId: bank.id, asAt }));
    return { org, asUser, run, kobe, bank, savings, receive, journalLine, importFile, lines, lineOn, split, unreconcile, line, journalCount, lock, report, sql };
  }

  it("BK26: splitting J across the 200.00 and 100.00 lines posts nothing and reconciles each to its part; retries", async () => {
    const world = await setup();
    const may = await world.lineOn("200.00");
    const june = await world.lineOn("100.00");
    const journals = await world.journalCount();
    const splitKey = key("split");
    const first = await world.split(may.id, [june.id], { idempotencyKey: splitKey });
    expect(first.created).toBe(true);
    expect(await world.journalCount()).toBe(journals);
    for (const [lineId, part] of [
      [may.id, "200.00"],
      [june.id, "100.00"],
    ] as const) {
      const reconciled = await world.line(lineId);
      expect(reconciled.status).toBe("reconciled");
      expect(reconciled.reconciliation).toMatchObject({
        kind: "split",
        items: [{ journalId: world.receive.journalId, journalLineId: world.journalLine, amount: part }],
        split: {
          journalAmount: "300.00",
          lines: [
            { id: may.id, date: "2026-05-20", amount: "200.00" },
            { id: june.id, date: "2026-06-03", amount: "100.00" },
          ],
        },
      });
    }
    expect((await world.asUser(viewer, (tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!.unreconciledCount).toBe(0);
    // The receive money can't be voided while it's reconciled.
    await expect(
      world.asUser(bookkeeper, (tx) => voidBankTransaction(tx, world.receive.id, { idempotencyKey: key("void"), voidDate: "2026-06-05" })),
    ).rejects.toThrow(/Unreconcile it first/);
    // Retrying returns the same result and posts nothing; another journal line with the same key is refused.
    expect(await world.split(may.id, [june.id], { idempotencyKey: splitKey })).toEqual({ ...first, created: false });
    await expect(world.split(may.id, [june.id], { idempotencyKey: splitKey, journalLineId: "999999" })).rejects.toThrow(/idempotency key/i);
    // The same key can't be reused for an ordinary reconciliation either.
    await expect(
      world.asUser(bookkeeper, (tx) => reconcileStatementLine(tx, may.id, { idempotencyKey: splitKey, kind: "match", journalLineIds: [world.journalLine] })),
    ).rejects.toThrow(/idempotency key/i);
    expect(await world.journalCount()).toBe(journals);
    // The database refuses a partial unreconcile done behind the service's back.
    await expect(
      world.asUser(owner, async (tx) => {
        await tx.query(
          `update bank_reconciliations set status = 'removed', removal_command_source = 'x', removal_idempotency_key = 'x',
                  removal_request_hash = 'x', removed_at = now()
            where statement_line_id = $1 and status = 'active'`,
          [may.id],
        );
        await tx.query("update bank_statement_lines set status = 'unreconciled' where id = $1", [may.id]);
      }),
    ).rejects.toThrow(/only partly unreconciled|isn't reconciled as a whole/);
    expect((await world.line(may.id)).status).toBe("reconciled");
  });

  it("BK26: over HTTP viewers can't split; bookkeepers can", async () => {
    const world = await setup();
    const may = await world.lineOn("200.00");
    const june = await world.lineOn("100.00");
    const [bookkeeperCookie, viewerCookie] = await Promise.all([bookkeeper, viewer].map((user) => sessionCookieFor(user)));
    const httpKey = key("http");
    const post = (cookie: string) =>
      reconcileRoute.POST(
        apiRequest(`/api/statement-lines/${may.id}/reconcile`, {
          method: "POST",
          cookie,
          body: { organisationId: world.org, idempotencyKey: httpKey, kind: "split", journalLineId: world.journalLine, otherLineIds: [june.id] },
        }),
        params({ lineId: may.id }),
      );
    expect((await post(viewerCookie)).status).toBe(403);
    expect((await post(bookkeeperCookie)).status).toBe(201);
    expect((await post(bookkeeperCookie)).status).toBe(200);
    const unreconcile = (cookie: string) =>
      unreconcileRoute.POST(
        apiRequest(`/api/statement-lines/${june.id}/unreconcile`, { method: "POST", cookie, body: { organisationId: world.org, idempotencyKey: key("un") } }),
        params({ lineId: june.id }),
      );
    expect((await unreconcile(viewerCookie)).status).toBe(403);
    expect((await unreconcile(bookkeeperCookie)).status).toBe(201);
    expect((await world.line(may.id)).status).toBe("unreconciled");
  });

  it("BK27: lines that don't add up, one line, mixed directions, other accounts, reconciled, far away, adjustments and locked periods are refused", async () => {
    const world = await setup({
      statement: `Date,Amount,Payee,Particulars,Code,Reference
20/05/2026,200.00,KOBE LTD,PART 1,,
03/06/2026,100.00,KOBE LTD,PART 2,,
21/05/2026,50.00,KOBE LTD,SHORT,,
22/05/2026,-100.00,REFUND,,,
25/07/2026,100.00,KOBE LTD,LATE,,
`,
    });
    await world.importFile("Date,Amount,Payee\n21/05/2026,100.00,KOBE LTD\n", world.savings.id);
    const may = await world.lineOn("200.00");
    const june = await world.lineOn("100.00", "2026-06-03");
    const short = await world.lineOn("50.00");
    const out = await world.lineOn("-100.00");
    const late = await world.lineOn("100.00", "2026-07-25");
    const savingsLine = await world.lineOn("100.00", "2026-05-21", world.savings.id);
    const journals = await world.journalCount();

    await expect(world.split(may.id, [short.id])).rejects.toThrow(
      "The chosen statement lines add up to 250.00, but the transaction is 300.00. They must add up to it exactly.",
    );
    await expect(world.split(may.id, [])).rejects.toThrow("Choose at least two statement lines to split a transaction across.");
    await expect(world.split(may.id, [may.id])).rejects.toThrow("Choose at least two statement lines");
    await expect(world.split(may.id, [out.id])).rejects.toThrow("Split lines must all be money in or all money out.");
    await expect(world.split(may.id, [savingsLine.id])).rejects.toThrow(/is on another account/);
    await expect(world.split(may.id, [late.id])).rejects.toThrow(/more than 60 days from the 2026-07-25 line/);
    await expect(
      world.split(may.id, [june.id], { adjustment: { accountCode: "6020", contactId: world.kobe.id } }),
    ).rejects.toThrow("An adjustment isn't available when splitting one transaction across several statement lines.");

    await world.lock("2026-05-20");
    await expect(world.split(june.id, [may.id])).rejects.toThrow(/2026-05-20 is in a locked period/);
    await world.lock(null);
    expect((await world.line(may.id)).status).toBe("unreconciled");
    expect((await world.line(june.id)).status).toBe("unreconciled");

    // A line already reconciled, and J already reconciled, are refused.
    await world.asUser(bookkeeper, (tx) =>
      reconcileStatementLine(tx, short.id, {
        idempotencyKey: key("receive"),
        kind: "bank_transaction",
        contactId: world.kobe.id,
        amountsMode: "no_tax",
        lines: [{ description: "Other", accountCode: "4000", amount: "50.00" }],
      }),
    );
    await expect(world.split(may.id, [short.id])).rejects.toThrow(/is already reconciled/);
    const posted = await world.journalCount();
    expect(posted).toBe(journals + 1);
    await world.split(may.id, [june.id]);
    await world.importFile("Date,Amount,Payee\n24/05/2026,150.00,KOBE LTD\n25/05/2026,150.00,KOBE LTD\n");
    const [a, b] = [await world.lineOn("150.00", "2026-05-24"), await world.lineOn("150.00", "2026-05-25")];
    await expect(world.split(a.id, [b.id])).rejects.toThrow(/already reconciled with another statement line/);
    await expect(
      world.asUser(bookkeeper, (tx) => reconcileStatementLine(tx, a.id, { idempotencyKey: key("m"), kind: "match", journalLineIds: [world.journalLine] })),
    ).rejects.toThrow(/already reconciled/);
    expect(await world.journalCount()).toBe(posted);
  });

  it("BK28: unreconciling one line unreconciles the whole split, posting nothing; refused if any line is locked; then J can be voided", async () => {
    const world = await setup();
    const may = await world.lineOn("200.00");
    const june = await world.lineOn("100.00");
    await world.split(may.id, [june.id]);
    const journals = await world.journalCount();

    await world.lock("2026-05-20");
    await expect(world.unreconcile(june.id)).rejects.toThrow(/2026-05-20 is in a locked period/);
    expect((await world.line(may.id)).status).toBe("reconciled");
    expect((await world.line(june.id)).status).toBe("reconciled");
    await world.lock(null);

    const unKey = key("unreconcile");
    const done = await world.unreconcile(june.id, unKey);
    expect(done).toMatchObject({ created: true, line: { id: june.id, status: "unreconciled", reconciliation: null } });
    expect((await world.line(may.id))).toMatchObject({ status: "unreconciled", reconciliation: null });
    expect(await world.journalCount()).toBe(journals);
    expect(await world.unreconcile(june.id, unKey)).toEqual({ ...done, created: false });
    await expect(world.unreconcile(may.id)).rejects.toThrow("This line isn't reconciled.");
    // The receive money stays, and can now be voided.
    const voided = await world.asUser(bookkeeper, (tx) =>
      voidBankTransaction(tx, world.receive.id, { idempotencyKey: key("void"), voidDate: "2026-06-05" }),
    );
    expect(voided.bankTransaction.status).toBe("voided");
  });

  it("BK28: a split is never a confident match, and a split journal line isn't a candidate; bulk coding refuses a split line", async () => {
    const world = await setup();
    const may = await world.lineOn("200.00");
    const june = await world.lineOn("100.00");
    const before = await world.asUser(viewer, (tx) => confidentMatches(tx, world.bank.id));
    expect(before.map((entry) => [entry.lineId, entry.suggestion, entry.candidateCount])).toEqual([
      [may.id, null, 0],
      [june.id, null, 0],
    ]);
    expect(await okConfidentMatches(world.run, world.bank.id, { idempotencyKey: key("ok") })).toEqual({ results: [], succeeded: 0, failed: 0 });

    await world.split(may.id, [june.id]);
    await world.importFile("Date,Amount,Payee\n25/05/2026,300.00,KOBE LTD\n");
    const full = await world.lineOn("300.00");
    const after = await world.asUser(viewer, (tx) => confidentMatches(tx, world.bank.id));
    expect(after).toEqual([{ lineId: full.id, suggestion: null, candidateCount: 0, competing: false }]);

    const journals = await world.journalCount();
    const coded = await cashCodeStatementLines(world.run, world.bank.id, {
      idempotencyKey: key("cash"),
      accountCode: "4000",
      contactId: world.kobe.id,
      lines: [{ lineId: may.id }],
    });
    expect(coded).toMatchObject({ succeeded: 0, failed: 1, results: [{ lineId: may.id, ok: false, error: "This line is already reconciled." }] });
    expect(await world.journalCount()).toBe(journals);
  });

  it("BK28: the bank reconciliation report counts only the part of J on lines by the date", async () => {
    const world = await setup();
    const may = await world.lineOn("200.00");
    const june = await world.lineOn("100.00");
    await world.split(may.id, [june.id]);
    const endOfMay = await world.report("2026-05-31");
    expect(endOfMay).toMatchObject({
      ledgerBalance: "300.00",
      statementBalance: "200.00",
      bankNotInTohyee: { items: [], total: "0.00" },
      tohyeeNotInBank: { total: "100.00" },
      expectedStatementBalance: "200.00",
      notExplained: "0.00",
      explained: true,
    });
    expect(endOfMay.tohyeeNotInBank.items).toEqual([
      expect.objectContaining({ journalLineId: world.journalLine, date: "2026-05-20", amount: "100.00", reconciledOn: "2026-06-03" }),
    ]);
    const endOfJune = await world.report("2026-06-30");
    expect(endOfJune).toMatchObject({ ledgerBalance: "300.00", statementBalance: "300.00", expectedStatementBalance: "300.00", explained: true });
    expect(endOfJune.tohyeeNotInBank.items).toEqual([]);
    expect(endOfJune.bankNotInTohyee.items).toEqual([]);
  });

  it("BK28: with J dated after the report date, the part on an earlier line is in the bank, not in Tohyee", async () => {
    const world = await setup({
      receiveDate: "2026-06-02",
      statement: "Date,Amount,Payee,Particulars,Code,Reference,Balance\n30/05/2026,200.00,KOBE LTD,PART 1,,,200.00\n03/06/2026,100.00,KOBE LTD,PART 2,,,300.00\n",
    });
    const may = await world.lineOn("200.00");
    const june = await world.lineOn("100.00");
    await world.split(june.id, [may.id]);
    const report = await world.report("2026-05-31");
    expect(report).toMatchObject({
      ledgerBalance: "0.00",
      statementBalance: "200.00",
      bankNotInTohyee: { total: "200.00" },
      tohyeeNotInBank: { items: [], total: "0.00" },
      expectedStatementBalance: "200.00",
      explained: true,
    });
    expect(report.bankNotInTohyee.items).toEqual([
      expect.objectContaining({ lineId: may.id, amount: "200.00", why: "matched_later", matchedJournalId: world.receive.journalId, matchedDate: "2026-06-02" }),
    ]);
    expect(await world.report("2026-06-30")).toMatchObject({ ledgerBalance: "300.00", statementBalance: "300.00", explained: true });
  });
});
