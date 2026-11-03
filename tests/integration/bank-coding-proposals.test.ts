import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as approveRoute from "@/app/api/bank-coding-proposals/[proposalId]/approve/route";
import * as rejectRoute from "@/app/api/bank-coding-proposals/[proposalId]/reject/route";
import * as proposalRoute from "@/app/api/bank-coding-proposals/[proposalId]/route";
import * as rowRoute from "@/app/api/bank-coding-proposals/[proposalId]/rows/[rowId]/route";
import * as listRoute from "@/app/api/bank-coding-proposals/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { getStatementLine, listBankAccounts, listStatementLines, type BankAccount, type StatementLine } from "@/lib/bank/accounts";
import { resumeBankBatch } from "@/lib/bank/batches";
import { approveProposalRows, getProposal, type Proposal, proposeBankCoding } from "@/lib/bank/coding-proposals";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine, unreconcileStatementLine } from "@/lib/bank/reconcile";
import { getBatch } from "@/lib/batches/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import { type OrgRunner, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { getOrganisation } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
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

const ORG = "proposals-co";
const OTHER_ORG = "proposals-other-co";
const AI_SOURCE = "ai-proposer";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;

/** Throws after the n-th batch action's transaction commits: the answer is lost, as when a server stops. */
function stopsAfter(base: OrgRunner, at: number): OrgRunner {
  let actions = 0;
  return async <T>(work: (tx: OrgTx) => Promise<T>) => {
    let isAction = false;
    const value = await base(async (tx) => {
      const query = tx.query;
      const spy = {
        ...tx,
        query: ((text: string, values?: unknown[]) => {
          if (text === "savepoint batch_action") {
            isAction = true;
            actions += 1;
          }
          return query(text, values);
        }) as OrgTx["query"],
      } as OrgTx;
      return work(spy);
    });
    if (isAction && actions === at) throw new Error("connection lost (test)");
    return value;
  };
}

describeWithDatabase("Bank coding proposals: review before anything posts (#544, decisions 1292-1299, BCP1-BCP8)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let outsider: SessionUser;
  let bank: BankAccount;
  let zEnergy: Contact;
  let fileNumber = 0;
  const tokens: Record<string, string> = {};
  let aiTx: <T>(work: (tx: OrgTx) => Promise<T>) => Promise<T>;
  let personRun: OrgRunner;

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const sql = async <T extends Json = Json>(text: string, values: unknown[] = []) => (await asUser(owner, (tx) => tx.query<T>(text, values))).rows;
  const count = async (text: string, values: unknown[] = []) => Number((await sql<{ n: string }>(`select count(*)::text as n from ${text}`, values))[0].n);
  const journals = () => count("ledger_journals");
  const line = (id: string) => asUser(owner, (tx) => getStatementLine(tx, id));
  const proposal = (id: string, filter?: string) => asUser(owner, (tx) => getProposal(tx, id, { filter }));

  async function importLines(rows: string[]): Promise<StatementLine[]> {
    fileNumber += 1;
    await asUser(owner, (tx) =>
      importStatementFile(tx, bank.id, {
        idempotencyKey: key("import"),
        fileName: `p${fileNumber}.csv`,
        fileBase64: Buffer.from(`Date,Amount,Payee\n${rows.join("\n")}\n`).toString("base64"),
      }),
    );
    const all = (await asUser(owner, (tx) => listStatementLines(tx, bank.id, { status: "all", limit: 500 }))).lines;
    return rows.map((row) => {
      const [date, amount, payee] = row.split(",");
      const iso = `${date.slice(6)}-${date.slice(3, 5)}-${date.slice(0, 2)}`;
      return all.find((entry) => entry.amount === amount && entry.date === iso && entry.description.includes(payee))!;
    });
  }

  const fuel = (lineId: string, extra: Json = {}) => ({
    lineId,
    contactId: zEnergy.id,
    accountCode: "6120",
    taxCode: "GST",
    rationale: "Z Energy is fuel for the ute.",
    confidence: "0.9",
    gstEvidence: "tax_document",
    evidence: "Receipt in the bills inbox",
    ...extra,
  });

  const propose = (rows: Json[], idempotencyKey = key("prop"), source = AI_SOURCE) =>
    aiTx((tx) => proposeBankCoding(tx, { accountId: bank.id, rows, idempotencyKey, source }));

  const picked = (p: Proposal, ids?: string[]) => p.rows.filter((row) => !ids || ids.includes(row.id)).map((row) => ({ id: row.id, version: row.version }));

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

  const send = async (
    handler: (request: Request, context: unknown) => Promise<Response>,
    method: string,
    path: string,
    user: SessionUser,
    body: Json | null,
    params: Json,
  ) => {
    const response = await handler(apiRequest(path, { method, cookie: await sessionCookieFor(user), ...(body ? { body } : {}) }), { params: Promise.resolve(params) });
    return { status: response.status, body: (await response.json()) as Json };
  };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("proposal-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    bookkeeper = await createTestUser("proposal-bookkeeper@example.com");
    viewer = await createTestUser("proposal-viewer@example.com");
    outsider = await createTestUser("proposal-outsider@example.com");
    await createTestOrganisation(owner, ORG);
    await createTestOrganisation(outsider, OTHER_ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'viewer')", [ORG, bookkeeper.id, viewer.id]);
    const organisation = (await getOrganisation(ORG))!;
    aiTx = (work) => withOrganisationTransaction(organisation, { userId: owner.id, email: owner.email, via: 'AI key "Test"' }, work);
    personRun = (work) => withOrganisationTransaction(organisation, { userId: bookkeeper.id, email: bookkeeper.email }, work);
    await asUser(owner, (tx) => updateOrganisationSettings(tx, { gstRegistrationConfirmed: true }));
    zEnergy = (await asUser(owner, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Z Energy", isSupplier: true }))).contact;
    bank = (await asUser(owner, (tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    for (const level of ["draft", "read"] as const) {
      const response = await tokensRoute.POST(
        apiRequest("/api/ai/tokens", { method: "POST", cookie: await sessionCookieFor(owner), body: { organisationId: ORG, name: level, accessLevel: level } }),
        noContext,
      );
      expect(response.status).toBe(201);
      tokens[level] = ((await response.json()) as { token: string }).token;
    }
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("BCP1/BCP2: a 100-line proposal changes neither the ledger nor reconciliation until approval; then approve 60, reject 40", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => `${String((index % 28) + 1).padStart(2, "0")}/06/2026,-${10 + index}.50,SYN ${index}`);
    const lines = await importLines(rows);
    const journalsBefore = await journals();
    const recsBefore = await count("bank_reconciliations");
    const auditBefore = await count("audit_events");

    const made = await propose(lines.map((entry) => fuel(entry.id)));
    expect(made.created).toBe(true);
    expect(made.proposal.counts).toMatchObject({ total: 100, proposed: 100, posted: 0 });
    expect(made.proposal.aiDrafted).toBe(true);
    expect(made.proposal.rows.every((row) => row.state === "proposed" && !row.reviewed && row.problems.length === 0)).toBe(true);
    // Nothing posted, nothing reconciled.
    expect(await journals()).toBe(journalsBefore);
    expect(await count("bank_reconciliations")).toBe(recsBefore);
    expect(await count("bank_statement_lines where id = any($1::bigint[]) and status = 'unreconciled'", [lines.map((entry) => entry.id)])).toBe(100);
    // The audit trail has counts, not what was proposed.
    const audit = await sql<{ details: Json }>("select details from audit_events order by id desc limit 1");
    expect(await count("audit_events")).toBe(auditBefore + 1);
    expect(audit[0].details).toEqual({ rows: 100, refused: 0, via: 'AI key "Test"' });
    // Totals: 100 lines out, 10.50 + ... + 109.50 = 6000.00, all on 6120 with GST.
    expect(made.proposal.totals.moneyOut).toBe("6000.00");
    expect(made.proposal.totals.byAccount).toEqual([{ key: "6120", label: expect.stringContaining("6120"), rows: 100, moneyIn: "0.00", moneyOut: "6000.00" }]);
    expect(made.proposal.totals.byTax.map((entry) => entry.key)).toEqual(["GST"]);

    const first60 = made.proposal.rows.slice(0, 60).map((row) => row.id);
    const last40 = made.proposal.rows.slice(60).map((row) => row.id);
    const rejected = await send(rejectRoute.POST as never, "POST", `/api/bank-coding-proposals/${made.proposal.id}/reject`, bookkeeper, { organisationId: ORG, rows: picked(made.proposal, last40), reason: "Not fuel" }, { proposalId: made.proposal.id });
    expect(rejected.status).toBe(200);
    expect(await journals()).toBe(journalsBefore);

    const approved = await send(approveRoute.POST as never, "POST", `/api/bank-coding-proposals/${made.proposal.id}/approve`, bookkeeper, { organisationId: ORG, rows: picked(made.proposal, first60), idempotencyKey: key("approve") }, { proposalId: made.proposal.id });
    expect(approved.status).toBe(201);
    expect((approved.body.batch as Json).counts).toMatchObject({ total: 60, committed: 60, failed: 0 });
    expect(await journals()).toBe(journalsBefore + 60);
    expect(await count("bank_statement_lines where id = any($1::bigint[]) and status = 'reconciled'", [lines.map((entry) => entry.id)])).toBe(60);
    const after = await proposal(made.proposal.id);
    expect(after.counts).toMatchObject({ posted: 60, rejected: 40, proposed: 0 });
    expect(after.rows[0].reviewedByEmail).toBe(bookkeeper.email);
    expect(after.rows[99].rejectReason).toBe("Not fuel");
    // Totals leave out the rejected rows.
    expect(after.totals.rows).toBe(60);
  });

  it("BCP3: duplicate submissions: same proposal key, same approval key, a second proposal for the same line, a new key for posted rows", async () => {
    const lines = await importLines(["01/07/2026,-46.00,DUP ONE", "01/07/2026,-23.00,DUP TWO"]);
    const rows = lines.map((entry) => fuel(entry.id));
    const proposalKey = key("dup");
    const first = await propose(rows, proposalKey);
    const again = await propose(rows, proposalKey);
    expect(again.created).toBe(false);
    expect(again.proposal.id).toBe(first.proposal.id);
    await expect(propose(rows.slice(0, 1), proposalKey)).rejects.toThrow(/already used/);
    // The same lines in a new proposal aren't kept: they're open in the first.
    await expect(propose(rows, key("dup2"))).rejects.toThrow(new RegExp(`already in proposal ${first.proposal.id}`));

    const before = await journals();
    const approvalKey = key("dupapprove");
    const one = await approveProposalRows(personRun, first.proposal.id, { rows: picked(first.proposal), idempotencyKey: approvalKey, source: "ui" });
    const two = await approveProposalRows(personRun, first.proposal.id, { rows: picked(first.proposal), idempotencyKey: approvalKey, source: "ui" });
    expect(two.created).toBe(false);
    expect(two.batch.id).toBe(one.batch.id);
    expect(await journals()).toBe(before + 2);
    // Approving the posted rows again with a new key is refused; nothing more posts.
    await expect(approveProposalRows(personRun, first.proposal.id, { rows: picked(first.proposal), idempotencyKey: key("dupagain"), source: "ui" })).rejects.toThrow(
      /changed since you looked|already posted/,
    );
    const current = await proposal(first.proposal.id);
    await expect(approveProposalRows(personRun, first.proposal.id, { rows: picked(current), idempotencyKey: key("dupagain"), source: "ui" })).rejects.toThrow(/already posted/);
    expect(await journals()).toBe(before + 2);
    for (const entry of lines) expect(await count("bank_reconciliations where statement_line_id = $1", [entry.id])).toBe(1);
  });

  it("BCP4: stale rows are flagged and left alone; an approval only posts what still holds; a version from before an edit is refused", async () => {
    const lines = await importLines(["02/07/2026,-31.00,STALE ONE", "02/07/2026,-32.00,STALE TWO", "02/07/2026,-33.00,STALE THREE"]);
    const made = await propose(lines.map((entry) => fuel(entry.id)));
    // Someone reconciles line 1 on the reconcile screen; line 2 is reconciled and unreconciled again.
    const byHand = (lineId: string, amount: string) =>
      asUser(owner, (tx) =>
        reconcileStatementLine(tx, lineId, { source: "ui", idempotencyKey: key("hand"), kind: "bank_transaction", contactId: zEnergy.id, amountsMode: "no_tax", lines: [{ description: "By hand", accountCode: "6120", amount }] }),
      );
    await byHand(lines[0].id, "31.00");
    await byHand(lines[1].id, "32.00");
    await asUser(owner, (tx) => unreconcileStatementLine(tx, lines[1].id, { source: "ui", idempotencyKey: key("unrec") }));
    const seen = await proposal(made.proposal.id);
    expect(seen.rows.map((row) => row.stale)).toEqual([true, true, false]);
    expect(seen.rows[0].problems[0].text).toBe("The line is now reconciled.");
    expect(seen.rows[1].problems[0].text).toMatch(/reconciled and unreconciled/);
    expect((await proposal(made.proposal.id, "attention")).rows.map((row) => row.id)).toEqual([seen.rows[0].id, seen.rows[1].id]);

    const before = await journals();
    const outcome = await approveProposalRows(personRun, made.proposal.id, { rows: picked(seen), idempotencyKey: key("stale"), source: "ui" });
    expect(outcome.skipped.map((entry) => entry.rowId)).toEqual([seen.rows[0].id, seen.rows[1].id]);
    expect(outcome.batch.counts).toMatchObject({ total: 1, committed: 1 });
    expect(await journals()).toBe(before + 1);
    const after = await proposal(made.proposal.id);
    expect(after.rows.map((row) => row.state)).toEqual(["proposed", "proposed", "posted"]);
    // The person's own reconciliation of line 1 is untouched.
    expect((await line(lines[0].id)).reconciliation?.kind).toBe("bank_transaction");
    expect(await count("bank_reconciliations where statement_line_id = $1 and status = 'active'", [lines[0].id])).toBe(1);
    // Only stale rows chosen: refused, with why.
    await expect(approveProposalRows(personRun, made.proposal.id, { rows: picked(after, [after.rows[0].id]), idempotencyKey: key("stale2"), source: "ui" })).rejects.toThrow(
      /None of these can be approved.*now reconciled/,
    );

    // A line that changes after approval but before posting: the batch refuses that row and nothing is overwritten.
    const late = await importLines(["03/07/2026,-34.00,LATE ONE"]);
    const lateProposal = await propose([fuel(late[0].id)]);
    const stalled = await approveProposalRows(personRun, lateProposal.proposal.id, { rows: picked(lateProposal.proposal), idempotencyKey: key("late"), source: "ui" }, { budgetMs: -1 });
    expect(stalled.stopped).toBe("time");
    await byHand(late[0].id, "34.00");
    const resumed = await resumeBankBatch(personRun, stalled.batch.id);
    expect(resumed.batch.actions[0].status).toBe("failed");
    expect(resumed.batch.actions[0].error).toMatch(/now reconciled/);
    expect((await proposal(lateProposal.proposal.id)).rows[0].state).toBe("failed");
    expect(await count("bank_reconciliations where statement_line_id = $1", [late[0].id])).toBe(1);
  });

  it("BCP5: edit, then approve as edited; the AI's coding is kept; an old version is refused; a person edits, an AI can't", async () => {
    const lines = await importLines(["04/07/2026,-57.50,EDIT ONE"]);
    const made = await propose([fuel(lines[0].id, { gstEvidence: undefined, taxCode: "GST" })]);
    const row = made.proposal.rows[0];
    expect(row.problems.map((problem) => problem.kind)).toEqual(["gst"]);
    // An AI can't edit or approve, even through the services.
    await expect(aiTx((tx) => import("@/lib/bank/coding-proposals").then((m) => m.editProposalRow(tx, made.proposal.id, row.id, { version: row.version, contactId: zEnergy.id, accountCode: "6120", taxCode: null })))).rejects.toThrow(/by a person/);
    const aiRun: OrgRunner = (work) => aiTx(work);
    await expect(approveProposalRows(aiRun, made.proposal.id, { rows: picked(made.proposal), idempotencyKey: key("aiapprove"), source: AI_SOURCE })).rejects.toThrow(/by a person/);

    const path = `/api/bank-coding-proposals/${made.proposal.id}/rows/${row.id}`;
    const viewerEdit = await send(rowRoute.PATCH as never, "PATCH", path, viewer, { organisationId: ORG, version: row.version, contactId: zEnergy.id, accountCode: "6120", taxCode: "GST" }, { proposalId: made.proposal.id, rowId: row.id });
    expect(viewerEdit.status).toBe(403);
    const edited = await send(rowRoute.PATCH as never, "PATCH", path, bookkeeper, { organisationId: ORG, version: row.version, contactId: zEnergy.id, accountCode: "6120", taxCode: "GST", description: "Diesel" }, { proposalId: made.proposal.id, rowId: row.id });
    expect(edited.status).toBe(200);
    const editedRow = edited.body.row as Json;
    expect(editedRow).toMatchObject({ gstEvidence: "person_said", description: "Diesel", reviewed: true, problems: [], version: row.version + 1 });
    expect((editedRow.original as Json).description).toBe("EDIT ONE");
    // The old version can't be approved: it changed since.
    await expect(approveProposalRows(personRun, made.proposal.id, { rows: picked(made.proposal), idempotencyKey: key("old"), source: "ui" })).rejects.toThrow(/changed since you looked/);
    const now = await proposal(made.proposal.id);
    await approveProposalRows(personRun, made.proposal.id, { rows: picked(now), idempotencyKey: key("edited"), source: "ui" });
    const reconciled = await line(lines[0].id);
    expect(reconciled.status).toBe("reconciled");
    // Posted as edited: GST inclusive 57.50 = 50.00 + 7.50 GST.
    const posted = await sql<{ code: string; debit: string }>(
      `select a.code, l.debit_amount::text as debit from ledger_journal_lines l join accounts a on a.id = l.account_id
        where l.journal_id = $1 and l.debit_amount > 0 order by a.code`,
      [reconciled.reconciliation!.items[0].journalId],
    );
    expect(posted).toEqual([
      { code: "2100", debit: "7.50" },
      { code: "6120", debit: "50.00" },
    ]);
  });

  it("BCP6: GST and lock dates are checked again at approval", async () => {
    const lines = await importLines(["20/04/2026,-11.50,LOCKED ONE", "25/07/2026,-23.00,GST ONE"]);
    const made = await propose([fuel(lines[0].id), fuel(lines[1].id)]);
    await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: "2026-04-30", reason: "Test set-up" }));
    // As before anyone confirmed it (#546: settings can't take a confirmation back).
    await sql("update organisation_settings set gst_registration_confirmed_at = null, gst_registration_confirmed_by = null where id = true");
    try {
      const seen = await proposal(made.proposal.id);
      expect(seen.rows[0].problems.map((problem) => problem.kind)).toEqual(["locked", "gst"]);
      expect(seen.rows[1].problems.map((problem) => problem.text)).toEqual(["GST registration isn't confirmed. Confirm it in Settings, or choose no GST."]);
      const before = await journals();
      await expect(approveProposalRows(personRun, made.proposal.id, { rows: picked(seen), idempotencyKey: key("gst"), source: "ui" })).rejects.toThrow(/None of these/);
      expect(await journals()).toBe(before);
    } finally {
      await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: null, reason: "Test set-up" }));
      await sql("update organisation_settings set gst_registration_confirmed_at = now(), gst_registration_confirmed_by = 'Test set-up' where id = true");
    }
    const fixed = await proposal(made.proposal.id);
    expect(fixed.rows.every((row) => row.problems.length === 0)).toBe(true);
  });

  it("BCP7: a stopped approval resumes from the Batches path and posts each row exactly once", async () => {
    const lines = await importLines(["06/07/2026,-41.00,RES ONE", "06/07/2026,-42.00,RES TWO", "06/07/2026,-43.00,RES THREE"]);
    const made = await propose(lines.map((entry) => fuel(entry.id)));
    const before = await journals();
    const stopped = await approveProposalRows(stopsAfter(personRun, 2), made.proposal.id, { rows: picked(made.proposal), idempotencyKey: key("resume"), source: "ui" });
    expect(stopped.stopped).toBe("lost_connection");
    expect(await journals()).toBe(before + 2);
    const mid = await proposal(made.proposal.id);
    expect(mid.rows.map((row) => row.state)).toEqual(["posted", "posted", "approved"]);
    const batchId = mid.rows[0].approvalBatchId!;
    expect((await asUser(owner, (tx) => getBatch(tx, batchId))).kind).toBe("bank_coding");
    const resumed = await resumeBankBatch(personRun, batchId);
    expect(resumed.batch.counts).toMatchObject({ committed: 3, failed: 0 });
    expect(await journals()).toBe(before + 3);
    for (const entry of lines) expect(await count("bank_reconciliations where statement_line_id = $1", [entry.id])).toBe(1);
    expect((await proposal(made.proposal.id)).rows.map((row) => row.state)).toEqual(["posted", "posted", "posted"]);
  });

  it("BCP8: MCP and cross-organisation: a draft key proposes, a read key can't; nothing crosses organisations", async () => {
    const lines = await importLines(["07/07/2026,-19.00,MCP ONE", "07/07/2026,-19.50,MCP TWO"]);
    const answer = await call(tokens.draft, "propose_bank_coding", {
      accountId: bank.id,
      rows: [fuel(lines[0].id), { ...fuel(lines[1].id), accountCode: "9999" }],
      idempotencyKey: "mcp-proposal-1",
    });
    expect(answer.created).toBe(true);
    expect((answer.rows as Json[]).map((row) => [row.state, row.reviewedByPerson])).toEqual([["proposed", false]]);
    expect((answer.refused as Json[])[0]).toMatchObject({ index: 1, lineId: lines[1].id, reason: expect.stringContaining("9999") });
    const proposalId = String(answer.proposalId);
    expect((await line(lines[0].id)).status).toBe("unreconciled");
    await expect(call(tokens.read, "propose_bank_coding", { accountId: bank.id, rows: [fuel(lines[1].id)] })).rejects.toThrow();
    const read = await call(tokens.read, "get_bank_coding_proposal", { proposalId, filter: "proposed" });
    expect((read.rows as Json[]).length).toBe(1);
    const listed = await call(tokens.read, "list_bank_coding_proposals", { accountId: bank.id });
    expect((listed.proposals as Json[]).some((entry) => entry.id === proposalId)).toBe(true);

    // The outsider isn't a member of ORG (not found, as for any organisation they can't see); in their own, the id doesn't exist.
    const theirs = await send(proposalRoute.GET as never, "GET", `/api/bank-coding-proposals/${proposalId}?organisationId=${ORG}`, outsider, null, { proposalId });
    expect(theirs.status).toBe(404);
    const elsewhere = await send(proposalRoute.GET as never, "GET", `/api/bank-coding-proposals/${proposalId}?organisationId=${OTHER_ORG}`, outsider, null, { proposalId });
    expect(elsewhere.status).toBe(404);
    const rows = [{ id: String((answer.rows as Json[])[0].rowId), version: 1 }];
    const crossApprove = await send(approveRoute.POST as never, "POST", `/api/bank-coding-proposals/${proposalId}/approve`, outsider, { organisationId: OTHER_ORG, rows, idempotencyKey: key("cross") }, { proposalId });
    expect(crossApprove.status).toBe(404);
    const viewerApprove = await send(approveRoute.POST as never, "POST", `/api/bank-coding-proposals/${proposalId}/approve`, viewer, { organisationId: ORG, rows, idempotencyKey: key("viewer") }, { proposalId });
    expect(viewerApprove.status).toBe(403);
    expect((await line(lines[0].id)).status).toBe("unreconciled");
    const list = await send(listRoute.GET as never, "GET", `/api/bank-coding-proposals?organisationId=${ORG}&accountId=${bank.id}`, viewer, null, {});
    expect(list.status).toBe(200);
  });
});
