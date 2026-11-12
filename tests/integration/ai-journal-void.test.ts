import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import { previewAiJournalVoid, saveAiJournalVoidSettings } from "@/lib/ai/journal-void";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts, listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine } from "@/lib/bank/reconcile";
import type { OrgTx } from "@/lib/db/org-transaction";
import { getJournal, getJournalDetails, postJournal } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "ai-journal-void";
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

/** AJV1-AJV6 (decision 1581, not yet reviewed): the AI voiding manual journals it posted itself. Made-up figures. */
describeWithDatabase("the AI voiding its own journals", () => {
  let server: TestServer;
  let owner: SessionUser;
  const tokens: Record<string, string> = {};
  const asOwner = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);

  /** The AI makes and posts a draft journal; returns the journal's id. */
  async function aiPosts(token: string, postingDate: string, debit = "6010", credit = "3000", amount = "100.00"): Promise<string> {
    const draft = await call(token, "create_draft_journal", {
      idempotencyKey: key("d"),
      postingDate,
      reference: "AI-J",
      lines: [
        { accountCode: debit, debitAmount: amount, creditAmount: "0" },
        { accountCode: credit, debitAmount: "0", creditAmount: amount },
      ],
    });
    const posted = await call(token, "post_draft_journal", { draftId: (draft.draft as Json).id });
    return posted.journalId as string;
  }
  const voidIt = async (token: string, journalId: string) => {
    const preview = await call(token, "void_own_journal", { journalId });
    return call(token, "void_own_journal", { journalId, previewHash: preview.previewHash, idempotencyKey: key("v") });
  };

  beforeAll(async () => {
    server = await startTestServer();
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

  it("AJV1-AJV3: previews, then voids its own journal with an exact reversal on its date; the original is kept", async () => {
    const journalId = await aiPosts(tokens.Claude, "2026-06-10");
    const before = await asOwner((tx) => tx.query("select count(*)::int as n from ledger_journals"));
    const preview = await call(tokens.Claude, "void_own_journal", { journalId });
    expect(preview).toMatchObject({ preview: true, journalId, postingDate: "2026-06-10", total: "100.00" });
    expect(await asOwner((tx) => tx.query("select count(*)::int as n from ledger_journals"))).toMatchObject({ rows: before.rows });
    const idempotencyKey = key("v");
    const done = await call(tokens.Claude, "void_own_journal", { journalId, previewHash: preview.previewHash, idempotencyKey });
    expect(done).toMatchObject({ created: true, journalId });
    const reversal = await asOwner((tx) => getJournal(tx, done.reversalJournalId as string));
    expect(reversal.postingDate).toBe("2026-06-10");
    expect(reversal.description).toBe(`Voided by the AI (AI key "Claude"): journal #${journalId}`);
    expect(reversal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["6010", "0.00", "100.00"],
      ["3000", "100.00", "0.00"],
    ]);
    const details = await asOwner((tx) => getJournalDetails(tx, journalId));
    expect(details.journal.id).toBe(journalId);
    expect(details.correctionJournals.map((entry) => entry.commandSource.startsWith("ai-void:"))).toEqual([true]);
    // A retry does nothing more; voiding again is refused.
    expect(await call(tokens.Claude, "void_own_journal", { journalId, previewHash: preview.previewHash, idempotencyKey })).toMatchObject({ created: false });
    await expect(call(tokens.Claude, "void_own_journal", { journalId })).rejects.toThrow("already been voided");
  });

  it("AJV1: another AI connection's journal (decision 1595), not a person's, not anything but a manual journal; Full access only", async () => {
    const others = await aiPosts(tokens.Other, "2026-06-11");
    expect(await voidIt(tokens.Claude, others)).toMatchObject({ created: true, journalId: others });
    const persons = (
      await asOwner((tx) =>
        postJournal(tx, {
          idempotencyKey: key("p"),
          postingDate: "2026-06-12",
          reference: "Person",
          lines: [
            { accountCode: "6010", debitAmount: "5.00", creditAmount: "0" },
            { accountCode: "3000", debitAmount: "0", creditAmount: "5.00" },
          ],
        }),
      )
    ).journal.id;
    await expect(call(tokens.Claude, "void_own_journal", { journalId: persons })).rejects.toThrow("wasn't posted through an AI connection");
    const mine = await aiPosts(tokens.Claude, "2026-06-13");
    const reversal = (await voidIt(tokens.Claude, mine)).reversalJournalId as string;
    await expect(call(tokens.Claude, "void_own_journal", { journalId: reversal })).rejects.toThrow("isn't a manual journal");
    await expect(call(tokens.Poster, "void_own_journal", { journalId: mine })).rejects.toThrow(/void_own_journal/);
  });

  it("AJV4: refused in a locked period and when matched to a bank line", async () => {
    const may = await aiPosts(tokens.Claude, "2026-05-20");
    await asOwner((tx) => updatePeriodControls(tx, { lockDate: "2026-05-31", reason: "Test set-up" }));
    await expect(call(tokens.Claude, "void_own_journal", { journalId: may })).rejects.toThrow("locked period");
    await asOwner((tx) => updatePeriodControls(tx, { lockDate: null, reason: "Test set-up" }));

    const banked = await aiPosts(tokens.Claude, "2026-07-01", "1000", "4000", "42.00");
    const bank = (await asOwner((tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    const csv = "Date,Amount,Payee\n01/07/2026,42.00,Made-up customer\n";
    await asOwner((tx) => importStatementFile(tx, bank.id, { idempotencyKey: key("i"), fileName: "s.csv", fileBase64: Buffer.from(csv).toString("base64") }));
    const line = (await asOwner((tx) => listStatementLines(tx, bank.id, { status: "all", limit: 50 }))).lines.find((entry) => entry.amount === "42.00")!;
    const journalLine = (await asOwner((tx) => tx.query<{ id: string }>("select l.id::text from ledger_journal_lines l join accounts a on a.id = l.account_id where l.journal_id = $1 and a.code = '1000'", [banked]))).rows[0].id;
    await asOwner((tx) => reconcileStatementLine(tx, line.id, { idempotencyKey: key("r"), kind: "match", journalLineIds: [journalLine] }));
    await expect(call(tokens.Claude, "void_own_journal", { journalId: banked })).rejects.toThrow("matched to a bank statement line");
  });

  it("AJV5, AJV6: a time limit, and a changed hash", async () => {
    const recent = await aiPosts(tokens.Claude, "2026-08-01");
    await asOwner((tx) => saveAiJournalVoidSettings(tx, { maxDays: 30 }));
    // Journals can't be changed, so the check is run as if 31 days have passed, as this AI key.
    const later = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    await expect(
      inOrganisation(ORG, { userId: owner.id, email: owner.email, via: 'AI key "Claude"' }, (tx) => previewAiJournalVoid(tx, recent, later)),
    ).rejects.toThrow("more than 30 days ago");
    expect(await call(tokens.Claude, "void_own_journal", { journalId: recent })).toMatchObject({ preview: true });
    await expect(asOwner((tx) => saveAiJournalVoidSettings(tx, { maxDays: 0 }))).rejects.toThrow("1 to 3650");
    await asOwner((tx) => saveAiJournalVoidSettings(tx, { maxDays: null }));
    await expect(call(tokens.Claude, "void_own_journal", { journalId: recent, previewHash: "not-the-hash", idempotencyKey: key("v") })).rejects.toThrow("Preview it again");
  });

  it("AJV7: discards a draft an AI made, not a person's, not one a person edited, not one posted", async () => {
    const draftOf = async (token: string) =>
      ((
        await call(token, "create_draft_journal", {
          idempotencyKey: key("d"),
          postingDate: "2026-06-20",
          reference: "AI-D",
          lines: [
            { accountCode: "6010", debitAmount: "7.00", creditAmount: "0" },
            { accountCode: "3000", debitAmount: "0", creditAmount: "7.00" },
          ],
        })
      ).draft as Json).id as string;
    const journals = await asOwner((tx) => tx.query<{ n: number }>("select count(*)::int as n from ledger_journals"));
    const mine = await draftOf(tokens.Other);
    expect(await call(tokens.Claude, "discard_own_draft_journal", { draftId: mine })).toMatchObject({ discarded: true, draftId: mine, reference: "AI-D" });
    expect((await asOwner((tx) => tx.query("select 1 from ledger_journal_drafts where id = $1", [mine]))).rowCount).toBe(0);
    expect((await asOwner((tx) => tx.query("select 1 from audit_events where event_type = 'journal_draft.discarded_by_ai' and entity_id = $1", [mine]))).rowCount).toBe(1);
    expect((await asOwner((tx) => tx.query<{ n: number }>("select count(*)::int as n from ledger_journals"))).rows[0].n).toBe(journals.rows[0].n);

    const edited = await draftOf(tokens.Claude);
    await asOwner((tx) => tx.query("update ledger_journal_drafts set updated_by_email = 'owner@example.com', updated_via = null where id = $1", [edited]));
    await expect(call(tokens.Claude, "discard_own_draft_journal", { draftId: edited })).rejects.toThrow("edited by a person");
    const persons = await asOwner((tx) => tx.query<{ id: string }>("update ledger_journal_drafts set created_via = null where id = $1 returning id::text", [edited]));
    await expect(call(tokens.Claude, "discard_own_draft_journal", { draftId: persons.rows[0].id })).rejects.toThrow("made by a person");
    const posted = await draftOf(tokens.Claude);
    await call(tokens.Claude, "post_draft_journal", { draftId: posted });
    await expect(call(tokens.Claude, "discard_own_draft_journal", { draftId: posted })).rejects.toThrow("has been posted");
    await expect(call(tokens.Poster, "discard_own_draft_journal", { draftId: posted })).rejects.toThrow(/discard_own_draft_journal/);
  });
});
