import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { postJournal } from "@/lib/ledger/journals";
import { accountTransactions } from "@/lib/reports/account-transactions";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "general-ledger";

/** The general ledger (GL1; not yet reviewed). Made-up figures. */
describeWithDatabase("general ledger", () => {
  let server: TestServer;
  let owner: SessionUser;
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("general-ledger-owner@example.com");
    await createTestOrganisation(owner, ORG);
    const pair = (date: string, debit: string, credit: string, amount: string) =>
      run((tx) =>
        postJournal(tx, {
          idempotencyKey: key("j"),
          postingDate: date,
          reference: "GL",
          lines: [
            { accountCode: debit, debitAmount: amount, creditAmount: "0" },
            { accountCode: credit, debitAmount: "0", creditAmount: amount },
          ],
        }),
      );
    await pair("2026-04-01", "1000", "3000", "1000.00");
    await pair("2026-05-05", "6010", "1000", "230.00");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("GL1: every account with an opening balance or a line, in code order; the rest left out", async () => {
    const ledger = await run((tx) => accountTransactions(tx, { from: "2026-05-01", to: "2026-05-31" }));
    expect(ledger.accounts.map((account) => [account.code, account.opening, account.lines.map((line) => [line.debit, line.credit]), account.closing])).toEqual([
      ["1000", "1000.00", [["0.00", "230.00"]], "770.00"],
      ["3000", "-1000.00", [], "-1000.00"],
      ["6010", "0.00", [["230.00", "0.00"]], "230.00"],
    ]);
    expect([ledger.totalDebit, ledger.totalCredit]).toEqual(["230.00", "230.00"]);
    // One account asked for is shown even with nothing in it (Account transactions).
    const one = await run(async (tx) => accountTransactions(tx, { accountId: (await tx.query<{ id: string }>("select id::text from accounts where code = '4000'")).rows[0].id, from: "2026-05-01", to: "2026-05-31" }));
    expect(one.accounts.map((account) => [account.code, account.lines.length])).toEqual([["4000", 0]]);
  });
});
