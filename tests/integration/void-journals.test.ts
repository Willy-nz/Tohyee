import { afterAll, beforeAll, expect, it } from "vitest";
import * as voidRoute from "@/app/api/ledger/journals/void/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts, listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine } from "@/lib/bank/reconcile";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { correctJournal, getJournal, getJournalDetails, postJournal } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { listJournals } from "@/lib/ledger/journals";
import { planVoidJournals, voidJournals } from "@/lib/ledger/void-journals";
import { accountTransactions } from "@/lib/reports/account-transactions";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "void-journals";
const noContext = undefined as unknown;

/** VJ1-VJ5 (decision 1585, not yet reviewed): Void for manual journals. Made-up figures. */
describeWithDatabase("voiding manual journals", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const journal = async (date: string, debit: string, credit: string, amount: string) =>
    (
      await run((tx) =>
        postJournal(tx, {
          idempotencyKey: key("j"),
          postingDate: date,
          reference: "Recode",
          lines: [
            { accountCode: debit, debitAmount: amount, creditAmount: "0" },
            { accountCode: credit, debitAmount: "0", creditAmount: amount },
          ],
        }),
      )
    ).journal.id;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("viewer@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, viewer.id]);
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("VJ1-VJ3: a preview of the effect by account, then one reversal each on its own date; nothing deleted", async () => {
    const a = await journal("2026-06-10", "6010", "3000", "100.00");
    const b = await journal("2026-06-12", "6010", "3000", "40.00");
    const plan = await run((tx) => planVoidJournals(tx, { journalIds: [a, b] }));
    expect(plan.items.map((item) => item.blocked)).toEqual([null, null]);
    expect(plan.effect).toEqual([
      { accountCode: "3000", accountName: expect.any(String), debit: "140.00", credit: "0.00" },
      { accountCode: "6010", accountName: expect.any(String), debit: "0.00", credit: "140.00" },
    ]);
    const idempotencyKey = key("v");
    const done = await run((tx) => voidJournals(tx, { journalIds: [a, b], reason: "Posted twice", previewHash: plan.hash, idempotencyKey }));
    expect(done.created).toBe(true);
    const reversal = await run((tx) => getJournal(tx, done.voided[0].reversalJournalId));
    expect([reversal.postingDate, reversal.description, reversal.correctionKind]).toEqual(["2026-06-10", `Void of journal #${a}: Posted twice`, "reversal"]);
    expect(reversal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["6010", "0.00", "100.00"],
      ["3000", "100.00", "0.00"],
    ]);
    expect((await run((tx) => getJournal(tx, a))).id).toBe(a);
    expect((await run((tx) => getJournalDetails(tx, a))).canCorrect).toBe(false);
    // A retry does nothing more; voiding again is blocked.
    expect((await run((tx) => voidJournals(tx, { journalIds: [a, b], previewHash: plan.hash, idempotencyKey }))).created).toBe(false);
    expect((await run((tx) => planVoidJournals(tx, { journalIds: [a] }))).items[0].blocked).toMatch("already been voided");
  });

  it("VJ1, VJ4: a replacement can be voided; a chosen date; refused when locked, reconciled, not manual, or changed", async () => {
    const original = await journal("2026-07-01", "6010", "3000", "25.00");
    const corrected = await run((tx) =>
      correctJournal(tx, {
        idempotencyKey: key("c"),
        originalJournalId: original,
        postingDate: "2026-07-02",
        reference: "Recode 2",
        lines: [
          { accountCode: "6020", debitAmount: "25.00", creditAmount: "0" },
          { accountCode: "3000", debitAmount: "0", creditAmount: "25.00" },
        ],
      }),
    );
    const replacement = corrected.replacementJournal.id;
    const plan = await run((tx) => planVoidJournals(tx, { journalIds: [replacement], voidDate: "2026-07-31" }));
    expect(plan.items[0].blocked).toBeNull();
    const done = await run((tx) => voidJournals(tx, { journalIds: [replacement], voidDate: "2026-07-31", previewHash: plan.hash, idempotencyKey: key("v") }));
    expect((await run((tx) => getJournal(tx, done.voided[0].reversalJournalId))).postingDate).toBe("2026-07-31");
    // The reversal itself isn't a manual journal.
    expect((await run((tx) => planVoidJournals(tx, { journalIds: [corrected.reversalJournal.id] }))).items[0].blocked).toMatch("Only manual journals");

    const locked = await journal("2026-05-20", "6010", "3000", "5.00");
    await run((tx) => updatePeriodControls(tx, { lockDate: "2026-05-31", reason: "Test set-up" }));
    expect((await run((tx) => planVoidJournals(tx, { journalIds: [locked] }))).items[0].blocked).toMatch("locked period");
    // Into an open period it can go.
    expect((await run((tx) => planVoidJournals(tx, { journalIds: [locked], voidDate: "2026-06-30" }))).items[0].blocked).toBeNull();
    await run((tx) => updatePeriodControls(tx, { lockDate: null, reason: "Test set-up" }));

    const banked = await journal("2026-08-01", "1000", "4000", "42.00");
    const bank = (await run((tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    const csv = "Date,Amount,Payee\n01/08/2026,42.00,Made-up customer\n";
    await run((tx) => importStatementFile(tx, bank.id, { idempotencyKey: key("i"), fileName: "s.csv", fileBase64: Buffer.from(csv).toString("base64") }));
    const line = (await run((tx) => listStatementLines(tx, bank.id, { status: "all", limit: 50 }))).lines.find((entry) => entry.amount === "42.00")!;
    const journalLine = (await run((tx) => tx.query<{ id: string }>("select l.id::text from ledger_journal_lines l join accounts a on a.id = l.account_id where l.journal_id = $1 and a.code = '1000'", [banked]))).rows[0].id;
    await run((tx) => reconcileStatementLine(tx, line.id, { idempotencyKey: key("r"), kind: "match", journalLineIds: [journalLine] }));
    const bankedPlan = await run((tx) => planVoidJournals(tx, { journalIds: [banked] }));
    expect(bankedPlan.items[0].blocked).toMatch("reconciled");
    await expect(run((tx) => voidJournals(tx, { journalIds: [banked], previewHash: bankedPlan.hash, idempotencyKey: key("v") }))).rejects.toThrow("can't be voided");

    const plain = await journal("2026-08-05", "6010", "3000", "9.00");
    await expect(run((tx) => voidJournals(tx, { journalIds: [plain], previewHash: "stale", idempotencyKey: key("v") }))).rejects.toThrow("Preview it again");
  });

  it("VP1-VP3: voided and corrected pairs left out of the journal list and the ledger reports when asked", async () => {
    const voidOne = async (id: string, voidDate?: string) => {
      const plan = await run((tx) => planVoidJournals(tx, { journalIds: [id], voidDate }));
      return run((tx) => voidJournals(tx, { journalIds: [id], voidDate, previewHash: plan.hash, idempotencyKey: key("v") }));
    };
    const a = await journal("2026-10-02", "6030", "3000", "11.00");
    await voidOne(a);
    const b = await journal("2026-10-03", "6030", "3000", "12.00");
    const corrected = await run((tx) =>
      correctJournal(tx, {
        idempotencyKey: key("c"),
        originalJournalId: b,
        postingDate: "2026-10-03",
        reference: "Recode B",
        lines: [
          { accountCode: "6030", debitAmount: "13.00", creditAmount: "0" },
          { accountCode: "3000", debitAmount: "0", creditAmount: "13.00" },
        ],
      }),
    );
    const c = await journal("2026-10-04", "6030", "3000", "14.00");
    const d = await journal("2026-10-30", "6030", "3000", "15.00");
    await voidOne(d, "2026-11-02");

    // VP1-VP2: the list.
    const all = await run((tx) => listJournals(tx, { kind: "journals", postingDateFrom: "2026-10-01", postingDateTo: "2026-10-31", limit: 50 }));
    expect(all.journals.map((entry) => [entry.id, entry.voided ?? null]).sort()).toEqual(
      [
        [a, "voided"],
        [b, "corrected"],
        [corrected.replacementJournal.id, null],
        [c, null],
        [d, "voided"],
      ].sort(),
    );
    const hidden = await run((tx) => listJournals(tx, { kind: "journals", postingDateFrom: "2026-10-01", postingDateTo: "2026-10-31", limit: 50, hideVoided: "1" }));
    expect(hidden.journals.map((entry) => entry.id).sort()).toEqual([corrected.replacementJournal.id, c].sort());

    // VP3: account transactions for October. D's void is in November, so D stays.
    const account = (await run((tx) => tx.query<{ id: string }>("select id::text from accounts where code = '6030'"))).rows[0].id;
    const full = await run((tx) => accountTransactions(tx, { accountId: account, from: "2026-10-01", to: "2026-10-31" }));
    const short = await run((tx) => accountTransactions(tx, { accountId: account, from: "2026-10-01", to: "2026-10-31", hideVoidedPairs: "1" }));
    expect(full.hiddenPairs).toBe(0);
    expect(full.accounts[0].lines).toHaveLength(7);
    expect(short.hiddenPairs).toBe(2);
    expect(short.accounts[0].lines.map((line) => [line.journalId, line.debit])).toEqual([
      [corrected.replacementJournal.id, "13.00"],
      [c, "14.00"],
      [d, "15.00"],
    ]);
    expect(short.accounts[0].closing).toBe(full.accounts[0].closing);
  });

  it("VJ5: bookkeepers and up; viewers can't", async () => {
    const id = await journal("2026-09-01", "6010", "3000", "1.00");
    const response = await voidRoute.POST(apiRequest("/api/ledger/journals/void", { method: "POST", cookie: await sessionCookieFor(viewer), body: { organisationId: ORG, journalIds: [id] } }), noContext);
    expect(response.status).toBe(403);
    const preview = await voidRoute.POST(apiRequest("/api/ledger/journals/void", { method: "POST", cookie: await sessionCookieFor(owner), body: { organisationId: ORG, journalIds: [id] } }), noContext);
    expect(preview.status).toBe(200);
  });
});
