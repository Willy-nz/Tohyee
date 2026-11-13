import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts, listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine } from "@/lib/bank/reconcile";
import type { OrgTx } from "@/lib/db/org-transaction";
import { correctJournal, getJournal, postJournal } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "ai-journal-correct";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;

let rpcId = 0;
async function rpc(token: string, method: string, rpcParams?: unknown) {
  rpcId += 1;
  const response = await mcpRoute.POST(
    new Request("http://tohyee.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: rpcParams }),
    }),
    noContext,
  );
  return (await response.json()) as Json;
}
async function call(token: string, name: string, args: Json = {}): Promise<Json> {
  const body = await rpc(token, "tools/call", { name, arguments: args });
  if (body.error) throw new Error(`rpc ${(body.error as Json).code}: ${(body.error as Json).message}`);
  const result = body.result as { content: { text: string }[]; isError?: boolean };
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text) as Json;
}

/** AJC1-AJC5 (decision 1608, not yet reviewed): the AI correcting a manual journal, as Edit this journal does. Made-up figures. */
describeWithDatabase("the AI correcting manual journals", () => {
  let server: TestServer;
  let owner: SessionUser;
  const tokens: Record<string, string> = {};
  const asOwner = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);

  /** A person posts Dr 6010 / Cr 1290-ish (3000 here) 100.00; returns the journal's id. */
  async function personPosts(postingDate: string, debit = "6010", credit = "3000", amount = "100.00"): Promise<string> {
    const posted = await asOwner((tx) =>
      postJournal(tx, {
        idempotencyKey: key("p"),
        postingDate,
        reference: "Shopify sales",
        description: "Made-up month",
        lines: [
          { accountCode: debit, debitAmount: amount, creditAmount: "0", description: "Gross" },
          { accountCode: credit, debitAmount: "0", creditAmount: amount, description: "Net" },
        ],
      }),
    );
    return posted.journal.id;
  }
  const NEW_LINES = [
    { accountCode: "6010", debitAmount: "100.00", description: "Gross" },
    { accountCode: "4000", creditAmount: "100.00", description: "Sales" },
  ];

  beforeAll(async () => {
    server = await startTestServer({ separateRuntimeLogin: true });
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    for (const [name, level] of [
      ["Claude", "full"],
      ["Other", "full"],
      ["Poster", "post"],
    ] as const) {
      const response = await tokensRoute.POST(
        apiRequest("/api/ai/tokens", {
          method: "POST",
          cookie: await sessionCookieFor(owner),
          body: { organisationId: ORG, name, accessLevel: level, ...(level === "full" ? { confirmFullAccess: true } : {}) },
        }),
        noContext,
      );
      expect(response.status).toBe(201);
      tokens[name] = ((await response.json()) as { token: string }).token;
    }
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("AJC1-AJC3: previews the original, the new version and the effect; then posts a reversal and the new version on the original's date", async () => {
    const journalId = await personPosts("2026-06-30");
    const count = () => asOwner((tx) => tx.query<{ n: number }>("select count(*)::int as n from ledger_journals"));
    const before = (await count()).rows[0].n;
    const preview = await call(tokens.Claude, "correct_journal", { journalId, lines: NEW_LINES });
    expect(preview).toMatchObject({
      preview: true,
      journalId,
      postingDate: "2026-06-30",
      reference: "Shopify sales",
      description: "Made-up month",
      effect: [
        { accountCode: "3000", amount: "100.00" },
        { accountCode: "4000", amount: "-100.00" },
      ],
    });
    expect((preview.replacement as Json[])[1]).toMatchObject({ accountCode: "4000", credit: "100.00", description: "Sales" });
    expect((await count()).rows[0].n).toBe(before);

    const idempotencyKey = key("c");
    const done = await call(tokens.Claude, "correct_journal", { journalId, lines: NEW_LINES, previewHash: preview.previewHash, idempotencyKey });
    expect(done).toMatchObject({ created: true, journalId });
    const reversal = await asOwner((tx) => getJournal(tx, done.reversalJournalId as string));
    const replacement = await asOwner((tx) => getJournal(tx, done.replacementJournalId as string));
    expect(reversal).toMatchObject({ postingDate: "2026-06-30", correctionKind: "reversal", relatedJournalId: journalId });
    expect(replacement).toMatchObject({ postingDate: "2026-06-30", reference: "Shopify sales", correctionKind: "replacement", relatedJournalId: journalId });
    expect(replacement.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["6010", "100.00", "0.00"],
      ["4000", "0.00", "100.00"],
    ]);
    // A retry with the same key posts nothing more; correcting again is refused (correct the replacement).
    expect(await call(tokens.Claude, "correct_journal", { journalId, lines: NEW_LINES, previewHash: preview.previewHash, idempotencyKey })).toMatchObject({
      created: false,
      reversalJournalId: done.reversalJournalId,
      replacementJournalId: done.replacementJournalId,
    });
    expect((await count()).rows[0].n).toBe(before + 2);
    await expect(call(tokens.Claude, "correct_journal", { journalId, lines: NEW_LINES })).rejects.toThrow("already been voided or corrected");
    // The replacement can itself be corrected.
    const again = await call(tokens.Claude, "correct_journal", { journalId: done.replacementJournalId, lines: NEW_LINES, postingDate: "2026-07-01" });
    expect(again).toMatchObject({ preview: true, postingDate: "2026-07-01", effect: [] });
  });

  it("AJC1: a person's or an AI's journal, a correction's replacement, but not a reversal or a record's journal; Full access only", async () => {
    const journalId = await personPosts("2026-06-29");
    await expect(call(tokens.Poster, "correct_journal", { journalId, lines: NEW_LINES })).rejects.toThrow(/correct_journal/);
    const corrected = await asOwner((tx) =>
      correctJournal(tx, { idempotencyKey: key("x"), originalJournalId: journalId, postingDate: "2026-06-29", reference: "Shopify sales", lines: NEW_LINES }),
    );
    await expect(call(tokens.Claude, "correct_journal", { journalId: corrected.reversalJournal.id, lines: NEW_LINES })).rejects.toThrow("isn't a manual journal");
    expect(await call(tokens.Claude, "correct_journal", { journalId: corrected.replacementJournal.id, lines: NEW_LINES })).toMatchObject({ preview: true });
  });

  it("AJC4: refused in a locked period, to a locked date, and when matched to a bank line", async () => {
    const may = await personPosts("2026-05-20");
    await asOwner((tx) => updatePeriodControls(tx, { lockDate: "2026-05-31", reason: "Test set-up" }));
    await expect(call(tokens.Claude, "correct_journal", { journalId: may, lines: NEW_LINES })).rejects.toThrow("locked period");
    const june = await personPosts("2026-06-15");
    await expect(call(tokens.Claude, "correct_journal", { journalId: june, lines: NEW_LINES, postingDate: "2026-05-30" })).rejects.toThrow("locked period");
    await asOwner((tx) => updatePeriodControls(tx, { lockDate: null, reason: "Test set-up" }));

    const banked = await personPosts("2026-07-02", "1000", "4000", "43.00");
    const bank = (await asOwner((tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    const csv = "Date,Amount,Payee\n02/07/2026,43.00,Made-up customer\n";
    await asOwner((tx) => importStatementFile(tx, bank.id, { idempotencyKey: key("i"), fileName: "s.csv", fileBase64: Buffer.from(csv).toString("base64") }));
    const line = (await asOwner((tx) => listStatementLines(tx, bank.id, { status: "all", limit: 50 }))).lines.find((entry) => entry.amount === "43.00")!;
    const journalLine = (await asOwner((tx) => tx.query<{ id: string }>("select l.id::text from ledger_journal_lines l join accounts a on a.id = l.account_id where l.journal_id = $1 and a.code = '1000'", [banked]))).rows[0].id;
    await asOwner((tx) => reconcileStatementLine(tx, line.id, { idempotencyKey: key("r"), kind: "match", journalLineIds: [journalLine] }));
    await expect(call(tokens.Claude, "correct_journal", { journalId: banked, lines: NEW_LINES })).rejects.toThrow("matched to a bank statement line");
  });

  it("AJC5: an unbalanced new version is refused, and a changed one needs a new preview", async () => {
    const journalId = await personPosts("2026-06-28");
    await expect(
      call(tokens.Claude, "correct_journal", { journalId, lines: [{ accountCode: "6010", debitAmount: "100.00" }, { accountCode: "4000", creditAmount: "99.00" }] }),
    ).rejects.toThrow(/balance/i);
    const preview = await call(tokens.Claude, "correct_journal", { journalId, lines: NEW_LINES });
    const changed = [NEW_LINES[0], { ...NEW_LINES[1], description: "Changed" }];
    await expect(call(tokens.Claude, "correct_journal", { journalId, lines: changed, previewHash: preview.previewHash, idempotencyKey: key("c") })).rejects.toThrow("Preview it again");
  });
});
