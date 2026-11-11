import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts, listStatementLines, getStatementLine } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine } from "@/lib/bank/reconcile";
import { findRecodable, planRecode, recodeBankTransactions } from "@/lib/bank/recode";
import { createBankTransaction, getBankTransaction } from "@/lib/bank/transactions";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "recode-bank";

/** RC1-RC6 (decision 1587, not yet reviewed): recoding spend and receive money in place. Made-up figures. */
describeWithDatabase("recoding bank transactions", () => {
  let server: TestServer;
  let owner: SessionUser;
  let shop: string;
  let bankId: string;
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const balance = async (code: string) =>
    (
      await run((tx) =>
        tx.query<{ net: string }>(
          "select to_char(coalesce(sum(l.debit_amount - l.credit_amount), 0), 'FM999999990.00') as net from ledger_journal_lines l join accounts a on a.id = l.account_id where a.code = $1",
          [code],
        ),
      )
    ).rows[0].net;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    shop = (await run((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Made-up Stationers", isSupplier: true }))).contact.id;
    bankId = (await run((tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!.id;
    const csv = "Date,Amount,Payee\n05/06/2026,-23.00,Made-up Stationers\n06/06/2026,-46.00,Made-up Stationers\n";
    await run((tx) => importStatementFile(tx, bankId, { idempotencyKey: key("i"), fileName: "s.csv", fileBase64: Buffer.from(csv).toString("base64") }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const coded = async (amount: string) => {
    const line = (await run((tx) => listStatementLines(tx, bankId, { status: "all", limit: 50 }))).lines.find((entry) => entry.amount === amount)!;
    const done = await run((tx) =>
      reconcileStatementLine(tx, line.id, {
        idempotencyKey: key("r"),
        kind: "bank_transaction",
        contactId: shop,
        amountsMode: "inclusive",
        lines: [{ description: "Paper", accountCode: "6140", taxCode: "GST", amount: amount.replace("-", "") }],
      }),
    );
    const journalId = done.line.reconciliation!.items[0].journalId;
    const id = (await run((tx) => tx.query<{ id: string }>("select id::text from bank_transactions where journal_id = $1", [journalId]))).rows[0].id;
    return { id, lineId: line.id };
  };

  it("RC1-RC5: recodes reconciled ones in place, on their dates, still reconciled; the old ones voided and linked", async () => {
    const a = await coded("-23.00");
    const b = await coded("-46.00");
    expect([await balance("6140"), await balance("6000")]).toEqual(["60.00", "0.00"]);
    const change = { fromAccountCode: "6140", accountCode: "6000", description: "Flyers" };
    const plan = await run((tx) => planRecode(tx, { bankTransactionIds: [a.id, b.id], change }));
    expect(plan.items.map((item) => item.blocked)).toEqual([null, null]);
    expect(plan.effect).toEqual([
      { month: "2026-06", accountCode: "6000", amount: "60.00" },
      { month: "2026-06", accountCode: "6140", amount: "-60.00" },
    ]);
    const idempotencyKey = key("rc");
    const done = await run((tx) => recodeBankTransactions(tx, { bankTransactionIds: [a.id, b.id], change, previewHash: plan.hash, idempotencyKey }));
    expect(done.recoded).toHaveLength(2);
    expect([await balance("6140"), await balance("6000"), await balance("1000")]).toEqual(["0.00", "60.00", "-69.00"]);
    const fresh = await run((tx) => getBankTransaction(tx, done.recoded[0].to));
    expect([fresh.date, fresh.total, fresh.lines[0].accountCode, fresh.lines[0].description, fresh.lines[0].taxCode]).toEqual(["2026-06-05", "23.00", "6000", "Flyers", "GST"]);
    expect((await run((tx) => getBankTransaction(tx, a.id))).status).toBe("voided");
    const line = await run((tx) => getStatementLine(tx, a.lineId));
    expect(line.status).toBe("reconciled");
    expect(line.reconciliation!.items[0].journalId).toBe(fresh.journalId);
    const link = await run((tx) => tx.query<{ from_id: string }>("select from_id::text from bank_transaction_recodes where to_id = $1", [fresh.id]));
    expect(link.rows[0].from_id).toBe(a.id);
    // A retry does nothing more; the old ones can't be recoded again.
    expect((await run((tx) => recodeBankTransactions(tx, { bankTransactionIds: [a.id, b.id], change, previewHash: plan.hash, idempotencyKey }))).created).toBe(false);
    expect((await run((tx) => planRecode(tx, { bankTransactionIds: [a.id], change }))).items[0].blocked).toBe("It's voided.");
  });

  it("RC4, RC6: an unreconciled one; refused when locked, nothing to change, or a stale preview; finding them", async () => {
    const loose = (
      await run((tx) =>
        createBankTransaction(tx, {
          idempotencyKey: key("b"),
          kind: "spend",
          accountId: bankId,
          contactId: shop,
          date: "2026-07-01",
          amountsMode: "inclusive",
          lines: [{ description: "Toner", accountCode: "6140", taxCode: "GST", amount: "11.50" }],
        }),
      )
    ).bankTransaction;
    expect((await run((tx) => findRecodable(tx, { accountCode: "6140", text: "toner" }))).map((entry) => entry.id)).toEqual([loose.id]);
    const plan = await run((tx) => planRecode(tx, { bankTransactionIds: [loose.id], change: { accountCode: "6000" } }));
    await expect(run((tx) => recodeBankTransactions(tx, { bankTransactionIds: [loose.id], change: { accountCode: "6000" }, previewHash: "stale", idempotencyKey: key("rc") }))).rejects.toThrow("Preview it again");
    const done = await run((tx) => recodeBankTransactions(tx, { bankTransactionIds: [loose.id], change: { accountCode: "6000" }, previewHash: plan.hash, idempotencyKey: key("rc") }));
    expect((await run((tx) => getBankTransaction(tx, done.recoded[0].to))).lines[0].accountCode).toBe("6000");
    expect((await run((tx) => planRecode(tx, { bankTransactionIds: [done.recoded[0].to], change: { accountCode: "6000" } }))).items[0].blocked).toBe("Nothing would change.");
    await run((tx) => updatePeriodControls(tx, { lockDate: "2026-07-31", reason: "Test set-up" }));
    expect((await run((tx) => planRecode(tx, { bankTransactionIds: [done.recoded[0].to], change: { accountCode: "6140" } }))).items[0].blocked).toMatch("locked period");
    await run((tx) => updatePeriodControls(tx, { lockDate: null, reason: "Test set-up" }));
    await expect(run((tx) => planRecode(tx, { bankTransactionIds: [done.recoded[0].to], change: {} }))).rejects.toThrow("Choose what to change");
  });
});
