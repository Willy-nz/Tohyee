import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, getStatementLine, listBankAccounts, listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine, suggestionsForLine } from "@/lib/bank/reconcile";
import type { OrgTx } from "@/lib/db/org-transaction";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/** A CSV statement of (date, amount, description) lines. */
const csv = (lines: Array<[string, string, string]>) =>
  Buffer.from(["Date,Amount,Payee", ...lines.map(([date, amount, payee]) => `${date.split("-").reverse().join("/")},${amount},${payee}`)].join("\n")).toString("base64");

/**
 * Transfers between the organisation's own accounts (#258, BK8 with AIB3's
 * matching): the other account's unreconciled line for the opposite amount
 * within 2 days is suggested, and choosing it saves the transfer and
 * reconciles both lines at once.
 */
describeWithDatabase("suggested transfers between your own accounts", () => {
  let server: TestServer;
  let owner: SessionUser;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("transfer-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("suggests the other side within 2 days, and reconciles both lines with one transfer", async () => {
    await createTestOrganisation(owner, "transfer-co");
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation("transfer-co", { userId: owner.id, email: owner.email }, work);
    await as((tx) => createBankAccount(tx, { code: "1010", name: "Savings", accountType: "bank" }));
    await as((tx) => createBankAccount(tx, { code: "1020", name: "Visa", accountType: "credit_card" }));
    const accounts = new Map((await as((tx) => listBankAccounts(tx))).map((account) => [account.code, account]));
    const [cheque, savings, visa] = ["1000", "1010", "1020"].map((code) => accounts.get(code)!);
    const load = (accountId: string, lines: Array<[string, string, string]>) =>
      as((tx) => importStatementFile(tx, accountId, { idempotencyKey: key("import"), fileName: "statement.csv", fileBase64: csv(lines) }));
    await load(cheque.id, [
      ["2026-10-10", "-500.00", "TO SAVINGS"],
      ["2026-10-10", "-75.00", "COFFEE"],
    ]);
    // Savings shows it a day later; Visa has a 500.00 too, but 5 days out; another savings line is a different amount.
    await load(savings.id, [
      ["2026-10-11", "500.00", "FROM CHEQUE"],
      ["2026-10-11", "499.00", "OTHER"],
    ]);
    await load(visa.id, [["2026-10-15", "500.00", "PAYMENT"]]);
    const lineOn = async (accountId: string, amount: string) =>
      (await as((tx) => listStatementLines(tx, accountId, { status: "all" }))).lines.find((entry) => entry.amount === amount)!;
    const out = await lineOn(cheque.id, "-500.00");
    const into = await lineOn(savings.id, "500.00");

    const suggestions = await as((tx) => suggestionsForLine(tx, out.id));
    expect(suggestions.transfers).toEqual([
      { lineId: into.id, accountId: savings.id, accountCode: "1010", accountName: "Savings", date: "2026-10-11", amount: "500.00", description: "FROM CHEQUE" },
    ]);
    const coffee = await lineOn(cheque.id, "-75.00");
    expect((await as((tx) => suggestionsForLine(tx, coffee.id))).transfers).toEqual([]);

    // A line that isn't on the chosen account is refused, and nothing is saved.
    const visaLine = await lineOn(visa.id, "500.00");
    await expect(
      as((tx) => reconcileStatementLine(tx, out.id, { idempotencyKey: key("rec"), kind: "transfer", otherAccountCode: "1010", otherLineId: visaLine.id })),
    ).rejects.toThrow("That line isn't on 1010.");
    expect((await as((tx) => getStatementLine(tx, out.id))).status).toBe("unreconciled");

    const done = await as((tx) => reconcileStatementLine(tx, out.id, { idempotencyKey: key("rec"), kind: "transfer", otherAccountCode: "1010", otherLineId: into.id }));
    expect(done.line.status).toBe("reconciled");
    const other = await as((tx) => getStatementLine(tx, into.id));
    expect(other.status).toBe("reconciled");
    // Both lines are reconciled to the one transfer journal.
    expect(other.reconciliation!.items[0].journalId).toBe(done.line.reconciliation!.items[0].journalId);
    const journals = await as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals where origin = 'bank_transfer'"));
    expect(journals.rows[0].n).toBe("1");
    // The savings line's own suggestions no longer offer the cheque line.
    const otherSavings = await lineOn(savings.id, "499.00");
    expect((await as((tx) => suggestionsForLine(tx, otherSavings.id))).transfers).toEqual([]);
  });
});
