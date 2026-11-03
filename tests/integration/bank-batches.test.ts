import { afterAll, beforeAll, expect, it } from "vitest";
import * as batchRoute from "@/app/api/bank-batches/[batchId]/route";
import * as resumeRoute from "@/app/api/bank-batches/[batchId]/resume/route";
import * as undoRoute from "@/app/api/bank-batches/[batchId]/undo/route";
import * as listRoute from "@/app/api/bank-batches/route";
import * as unreconcileRoute from "@/app/api/bank-batches/unreconcile/route";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, getStatementLine, listBankAccounts, listStatementLines, type BankAccount, type StatementLine } from "@/lib/bank/accounts";
import { planUnreconcile, resumeBankBatch, startReconcileBatch, startUnreconcileBatch, type Plan } from "@/lib/bank/batches";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine } from "@/lib/bank/reconcile";
import { createBankTransaction } from "@/lib/bank/transactions";
import { type Batch, getBatch, type RunOutcome } from "@/lib/batches/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import { type OrgRunner, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { TooManyRequestsError } from "@/lib/errors";
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

const ORG = "batches-co";
const OTHER_ORG = "batches-other-co";
const SOURCE = "ai-test";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;

/** The connection went away: thrown by a runner to stand in for a lost database connection or server. */
class LostConnection extends Error {
  constructor() {
    super("connection lost (test)");
  }
}

/**
 * A runner that fails the `at`-th action's own transaction (the one doing
 * the work): "before" throws inside it, so it rolls back; "after" lets it
 * commit and throws afterwards, so the caller never hears that it did;
 * "rate_limit" makes the work itself hit a rate limit.
 */
function faulty(base: OrgRunner, at: number, when: "before" | "after" | "rate_limit"): OrgRunner {
  let actions = 0;
  return async <T>(work: (tx: OrgTx) => Promise<T>) => {
    let isAction = false;
    let fired = false;
    const value = await base(async (tx) => {
      const query = tx.query;
      let armed = false;
      const spy = {
        ...tx,
        query: ((text: string, values?: unknown[]) => {
          if (text === "savepoint batch_action") {
            isAction = true;
            actions += 1;
            armed = when === "rate_limit" && actions === at;
            return query(text, values);
          }
          if (armed && !fired) {
            fired = true;
            throw new TooManyRequestsError("Slow down (test).", 30);
          }
          return query(text, values);
        }) as OrgTx["query"],
      } as OrgTx;
      const result = await work(spy);
      if (isAction && actions === at && when === "before") throw new LostConnection();
      return result;
    });
    if (isAction && actions === at && when === "after") throw new LostConnection();
    return value;
  };
}

describeWithDatabase("Durable bank batches: resume, unreconcile selected and undo (#547, decisions 1273-1279)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let outsider: SessionUser;
  let bank: BankAccount;
  let savings: BankAccount;
  let zEnergy: Contact;
  let fileNumber = 0;
  const tokens: Record<string, string> = {};

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  let run: OrgRunner;
  const sql = async <T extends Json = Json>(text: string, values: unknown[] = []) => (await asUser(owner, (tx) => tx.query<T>(text, values))).rows;
  const count = async (text: string, values: unknown[] = []) => Number((await sql<{ n: string }>(`select count(*)::text as n from ${text}`, values))[0].n);
  const journals = () => count("ledger_journals");
  const line = (id: string) => asUser(owner, (tx) => getStatementLine(tx, id));
  const batch = (id: string) => asUser(owner, (tx) => getBatch(tx, id));
  const statuses = (b: Batch) => b.actions.map((action) => action.status);

  async function importLines(account: BankAccount, rows: string[]): Promise<StatementLine[]> {
    fileNumber += 1;
    await asUser(owner, (tx) =>
      importStatementFile(tx, account.id, {
        idempotencyKey: key("import"),
        fileName: `b${fileNumber}.csv`,
        fileBase64: Buffer.from(`Date,Amount,Payee\n${rows.join("\n")}\n`).toString("base64"),
      }),
    );
    const all = (await asUser(owner, (tx) => listStatementLines(tx, account.id, { status: "all", limit: 500 }))).lines;
    return rows.map((row) => {
      const [date, amount, payee] = row.split(",");
      const iso = `${date.slice(6)}-${date.slice(3, 5)}-${date.slice(0, 2)}`;
      return all.find((entry) => entry.amount === amount && entry.date === iso && entry.description.includes(payee))!;
    });
  }

  const spend = (lineId: string, amount: string) => ({
    action: "create_and_match",
    lineId,
    contactId: zEnergy.id,
    amountsMode: "no_tax",
    lines: [{ description: "Fuel", accountCode: "6120", amount }],
    gstEvidence: "person_said",
  });

  /** Each line reconciled at most once, and at most one spend money per line: no double posting. */
  async function assertExactlyOnce(lineIds: string[]) {
    for (const lineId of lineIds) {
      expect(await count("bank_reconciliations where statement_line_id = $1 and status = 'active'", [lineId]), lineId).toBeLessThanOrEqual(1);
      expect(await count("bank_reconciliations where statement_line_id = $1", [lineId]), lineId).toBeLessThanOrEqual(1);
    }
  }

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

  const post = async (handler: (request: Request, context: unknown) => Promise<Response>, path: string, user: SessionUser, body: Json, params?: Json) => {
    const response = await handler(
      apiRequest(path, { method: "POST", cookie: await sessionCookieFor(user), body }),
      params ? { params: Promise.resolve(params) } : noContext,
    );
    return { status: response.status, body: (await response.json()) as Json, headers: response.headers };
  };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("batch-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    bookkeeper = await createTestUser("batch-bookkeeper@example.com");
    viewer = await createTestUser("batch-viewer@example.com");
    outsider = await createTestUser("batch-outsider@example.com");
    await createTestOrganisation(owner, ORG);
    await createTestOrganisation(outsider, OTHER_ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'viewer')", [
      ORG,
      bookkeeper.id,
      viewer.id,
    ]);
    const organisation = (await getOrganisation(ORG))!;
    run = (work) => withOrganisationTransaction(organisation, { userId: owner.id, email: owner.email, via: 'AI key "Test"' }, work);
    // #546: a confirmed GST registration, so the AI's coding needs evidence rather than being refused.
    await asUser(owner, (tx) => updateOrganisationSettings(tx, { gstRegistrationConfirmed: true }));
    zEnergy = (await asUser(owner, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Z Energy", isSupplier: true }))).contact;
    await asUser(owner, (tx) => createBankAccount(tx, { code: "1010", name: "Savings account", accountType: "bank" }));
    const accounts = await asUser(owner, (tx) => listBankAccounts(tx));
    bank = accounts.find((account) => account.code === "1000")!;
    savings = accounts.find((account) => account.code === "1010")!;
    for (const [name, level] of [
      ["full", "full"],
      ["post", "post"],
      ["read", "read"],
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

  it("disconnect before commit: the action rolls back, shows as outcome unknown, and a resume does it exactly once", async () => {
    const lines = await importLines(bank, ["02/06/2026,-10.10,DBC ONE", "02/06/2026,-10.20,DBC TWO", "02/06/2026,-10.30,DBC THREE"]);
    const before = await journals();
    const outcome = await startReconcileBatch(
      faulty(run, 2, "before"),
      { actions: [spend(lines[0].id, "10.10"), spend(lines[1].id, "10.20"), spend(lines[2].id, "10.30")], idempotencyKey: "dbc-batch-1", source: SOURCE },
    );
    expect(outcome.stopped).toBe("lost_connection");
    expect(statuses(outcome.batch)).toEqual(["committed", "unknown", "pending"]);
    expect(outcome.batch.state).toBe("waiting");
    expect(await journals()).toBe(before + 1);
    expect((await line(lines[1].id)).status).toBe("unreconciled");

    const resumed = await resumeBankBatch(run, outcome.batch.id);
    expect(resumed.stopped).toBeNull();
    expect(statuses(resumed.batch)).toEqual(["committed", "committed", "committed"]);
    expect(resumed.batch.state).toBe("done");
    expect(resumed.batch.actions[1].attempts).toBe(2);
    expect(await journals()).toBe(before + 3);
    await assertExactlyOnce(lines.map((entry) => entry.id));
    // The original keys were kept.
    expect(await count("bank_reconciliations where command_source = $1 and idempotency_key = any($2::text[])", [SOURCE, lines.map((entry) => `dbc-batch-1:${entry.id}`)])).toBe(3);
  });

  it("disconnect after commit: the action is shown committed (not failed), and sending the same call again posts nothing more", async () => {
    const lines = await importLines(bank, ["03/06/2026,-11.10,DAC ONE", "03/06/2026,-11.20,DAC TWO", "03/06/2026,-11.30,DAC THREE"]);
    const actions = [spend(lines[0].id, "11.10"), spend(lines[1].id, "11.20"), spend(lines[2].id, "11.30")];
    const before = await journals();
    const outcome = await startReconcileBatch(faulty(run, 2, "after"), { actions, idempotencyKey: "dac-batch-1", source: SOURCE });
    expect(outcome.stopped).toBe("lost_connection");
    expect(statuses(outcome.batch)).toEqual(["committed", "committed", "pending"]);
    expect(await journals()).toBe(before + 2);

    // The AI never got its answer, so it sends the same call again: that's a resume of the same batch.
    const again = await startReconcileBatch(run, { actions, idempotencyKey: "dac-batch-1", source: SOURCE });
    expect(again.created).toBe(false);
    expect(again.batch.id).toBe(outcome.batch.id);
    expect(statuses(again.batch)).toEqual(["committed", "committed", "committed"]);
    expect(await journals()).toBe(before + 3);
    await assertExactlyOnce(lines.map((entry) => entry.id));

    // The same key with different actions is refused.
    await expect(startReconcileBatch(run, { actions: actions.slice(0, 2), idempotencyKey: "dac-batch-1", source: SOURCE })).rejects.toThrow(
      /already used for a different batch/,
    );
  });

  it("partial failures: refused actions keep their reason, the rest are done; retrying refused ones posts nothing new", async () => {
    const lines = await importLines(bank, ["04/06/2026,-12.10,PF ONE", "04/06/2026,-12.20,PF TWO"]);
    const before = await journals();
    const outcome = await startReconcileBatch(run, {
      actions: [spend(lines[0].id, "12.10"), spend(lines[1].id, "99.00"), { action: "nonsense", lineId: lines[1].id }, spend(lines[0].id, "12.10")],
      idempotencyKey: "pf-batch-1",
      source: SOURCE,
    });
    expect(statuses(outcome.batch)).toEqual(["committed", "failed", "failed", "failed"]);
    expect(outcome.batch.state).toBe("finished_with_failures");
    expect(outcome.batch.actions[1].error).toMatch(/12.20|99.00|add up/);
    expect(outcome.batch.actions[2].error).toMatch(/action/);
    expect(outcome.batch.actions[3].error).toMatch(/already in this call/);
    expect(await journals()).toBe(before + 1);
    const retried = await resumeBankBatch(run, outcome.batch.id, { retryFailed: true });
    expect(statuses(retried.batch)).toEqual(["committed", "failed", "failed", "failed"]);
    expect(retried.batch.actions[1].attempts).toBe(2);
    // Refused before any work (malformed): not tried again.
    expect(retried.batch.actions[2].attempts).toBe(0);
    expect(await journals()).toBe(before + 1);
  });

  it("a rate limit: progress is kept, the batch waits (retry-after), and carries on afterwards", async () => {
    const lines = await importLines(bank, ["05/06/2026,-13.10,RL ONE", "05/06/2026,-13.20,RL TWO", "05/06/2026,-13.30,RL THREE"]);
    const before = await journals();
    const outcome = await startReconcileBatch(faulty(run, 2, "rate_limit"), {
      actions: [spend(lines[0].id, "13.10"), spend(lines[1].id, "13.20"), spend(lines[2].id, "13.30")],
      idempotencyKey: "rl-batch-1",
      source: SOURCE,
    });
    expect(outcome.stopped).toBe("rate_limit");
    expect(outcome.retryAfterSeconds).toBe(30);
    expect(statuses(outcome.batch)).toEqual(["committed", "pending", "pending"]);
    expect(outcome.batch.state).toBe("rate_limited");
    expect(outcome.batch.retryAfterSeconds).toBeGreaterThan(25);
    expect(await journals()).toBe(before + 1);

    // Resuming too early is turned away with how long to wait; nothing changes.
    const early = await resumeBankBatch(run, outcome.batch.id);
    expect(early.stopped).toBe("busy");
    expect(early.retryAfterSeconds).toBeGreaterThan(25);
    expect(await journals()).toBe(before + 1);

    // Over the HTTP API too: 200 with a Retry-After header.
    const http = await post(resumeRoute.POST as never, `/api/bank-batches/${outcome.batch.id}/resume`, bookkeeper, { organisationId: ORG }, { batchId: outcome.batch.id });
    expect(http.status).toBe(200);
    expect(Number(http.headers.get("retry-after"))).toBeGreaterThan(25);

    await sql("update batches set not_before = now() - interval '1 second' where id = $1", [outcome.batch.id]);
    const later = await resumeBankBatch(run, outcome.batch.id);
    expect(statuses(later.batch)).toEqual(["committed", "committed", "committed"]);
    expect(await journals()).toBe(before + 3);
    await assertExactlyOnce(lines.map((entry) => entry.id));
  });

  it("a server restart mid-batch: the dead worker's lease runs out, then a resume finishes it, and repeated resumes change nothing", async () => {
    const lines = await importLines(bank, ["08/06/2026,-14.10,RS ONE", "08/06/2026,-14.20,RS TWO"]);
    const before = await journals();
    // Recorded, then the server stopped while doing the first action (as if it died holding the lease).
    const made = await startReconcileBatch(faulty(run, 1, "before"), {
      actions: [spend(lines[0].id, "14.10"), spend(lines[1].id, "14.20")],
      idempotencyKey: "rs-batch-1",
      source: SOURCE,
    });
    await sql("update batches set lease_token = 'dead-server', lease_until = now() + interval '40 seconds' where id = $1", [made.batch.id]);
    await sql("update batch_actions set status = 'started' where batch_id = $1 and position = 0", [made.batch.id]);
    const blocked = await batch(made.batch.id);
    expect(blocked.state).toBe("working");
    expect(statuses(blocked)).toEqual(["in_progress", "pending"]);

    const busy = await resumeBankBatch(run, made.batch.id);
    expect(busy.stopped).toBe("busy");
    expect(busy.retryAfterSeconds).toBeGreaterThan(30);

    await sql("update batches set lease_until = now() - interval '1 second' where id = $1", [made.batch.id]);
    expect(statuses(await batch(made.batch.id))).toEqual(["unknown", "pending"]);
    const done = await resumeBankBatch(run, made.batch.id);
    expect(statuses(done.batch)).toEqual(["committed", "committed"]);
    expect(await journals()).toBe(before + 2);

    for (let time = 0; time < 3; time += 1) {
      const again = await resumeBankBatch(run, made.batch.id);
      expect(again.stopped).toBeNull();
      expect(statuses(again.batch)).toEqual(["committed", "committed"]);
    }
    expect(await journals()).toBe(before + 2);
    await assertExactlyOnce(lines.map((entry) => entry.id));
    // What was asked can't be changed or removed.
    await expect(sql("update batch_actions set payload = '{}'::jsonb where batch_id = $1", [made.batch.id])).rejects.toThrow(/can't be changed/);
    await expect(sql("delete from batch_actions where batch_id = $1", [made.batch.id])).rejects.toThrow(/can't be deleted/);
  });

  it("a long batch pauses when out of time and is resumed from where it stopped", async () => {
    const lines = await importLines(bank, ["09/06/2026,-15.10,TB ONE", "09/06/2026,-15.20,TB TWO"]);
    let clock = 0;
    const outcome = await startReconcileBatch(
      run,
      { actions: [spend(lines[0].id, "15.10"), spend(lines[1].id, "15.20")], idempotencyKey: "tb-batch-1", source: SOURCE },
      { budgetMs: 10, now: () => (clock += 8) },
    );
    expect(outcome.stopped).toBe("time");
    expect(statuses(outcome.batch)).toEqual(["committed", "pending"]);
    expect(statuses((await resumeBankBatch(run, outcome.batch.id)).batch)).toEqual(["committed", "committed"]);
  });

  it("Unreconcile selected: a preview first, nothing posted or voided, splits together, a transfer's other side stays, and permissions", async () => {
    const [plain, transferOut, splitA, splitB] = await importLines(bank, [
      "10/06/2026,-16.00,UR PLAIN",
      "10/06/2026,-300.00,UR TRANSFER",
      "11/06/2026,200.00,UR SPLIT A",
      "12/06/2026,100.00,UR SPLIT B",
    ]);
    const [transferIn] = await importLines(savings, ["10/06/2026,300.00,UR TRANSFER IN"]);
    await asUser(owner, (tx) =>
      reconcileStatementLine(tx, plain.id, { idempotencyKey: key("p"), kind: "bank_transaction", contactId: zEnergy.id, amountsMode: "no_tax", lines: [{ description: "x", accountCode: "6120", amount: "16.00" }] }),
    );
    await startReconcileBatch(run, { actions: [{ action: "transfer_and_match", lineId: transferOut.id, otherAccountCode: "1010" }], idempotencyKey: "ur-transfer", source: SOURCE });
    expect((await line(transferIn.id)).status).toBe("reconciled");
    const { bankTransaction: receive } = await asUser(owner, (tx) =>
      createBankTransaction(tx, { idempotencyKey: key("r"), kind: "receive", accountId: bank.id, contactId: zEnergy.id, date: "2026-06-11", amountsMode: "no_tax", lines: [{ description: "Split", accountCode: "4000", amount: "300.00" }] }),
    );
    const journalLine = (await sql<{ id: string }>("select id::text from ledger_journal_lines where journal_id = $1 and account_id = $2", [receive.journalId, bank.id]))[0].id;
    await asUser(owner, (tx) => reconcileStatementLine(tx, splitA.id, { idempotencyKey: key("s"), kind: "split", journalLineId: journalLine, otherLineIds: [splitB.id] }));

    const lineIds = [plain.id, transferOut.id, splitA.id];
    // Viewers can't; someone who isn't a member isn't even told the organisation exists.
    expect((await post(unreconcileRoute.POST as never, "/api/bank-batches/unreconcile", viewer, { organisationId: ORG, lineIds })).status).toBe(403);
    expect((await post(unreconcileRoute.POST as never, "/api/bank-batches/unreconcile", outsider, { organisationId: ORG, lineIds })).status).toBe(404);

    const preview = await post(unreconcileRoute.POST as never, "/api/bank-batches/unreconcile", bookkeeper, { organisationId: ORG, lineIds });
    expect(preview.status).toBe(200);
    const plan = preview.body.plan as Plan;
    expect(plan.counts).toMatchObject({ items: 3, lines: 4, blocked: 0, voids: 0 });
    expect(plan.items.find((item) => item.lineId === splitA.id)!.alsoLines.map((other) => [other.lineId, other.why])).toEqual([[splitB.id, "split"]]);
    expect(plan.items.find((item) => item.lineId === transferOut.id)!.notes.join(" ")).toMatch(/other side of this transfer .* stays reconciled/);
    // Previewing changed nothing.
    expect((await line(plain.id)).status).toBe("reconciled");

    const wrong = await post(unreconcileRoute.POST as never, "/api/bank-batches/unreconcile", bookkeeper, { organisationId: ORG, lineIds, previewHash: "stale", idempotencyKey: "ur-run-0001" });
    expect(wrong.status).toBe(409);

    const before = await journals();
    const transactionsBefore = await count("bank_transactions where status = 'voided'");
    const done = await post(unreconcileRoute.POST as never, "/api/bank-batches/unreconcile", bookkeeper, { organisationId: ORG, lineIds, previewHash: plan.hash, idempotencyKey: "ur-run-0001" });
    expect(done.status).toBe(201);
    const outcome = done.body as unknown as RunOutcome;
    expect(outcome.batch).toMatchObject({ kind: "bank_unreconcile", state: "done", counts: { committed: 3 }, createdByEmail: bookkeeper.email });
    for (const id of [plain.id, transferOut.id, splitA.id, splitB.id]) expect((await line(id)).status, id).toBe("unreconciled");
    expect((await line(transferIn.id)).status).toBe("reconciled");
    expect(await journals()).toBe(before);
    expect(await count("bank_transactions where status = 'voided'")).toBe(transactionsBefore);
    // The same request again answers the same and does nothing more.
    const again = await post(unreconcileRoute.POST as never, "/api/bank-batches/unreconcile", bookkeeper, { organisationId: ORG, lineIds, previewHash: plan.hash, idempotencyKey: "ur-run-0001" });
    expect(again.status).toBe(200);
    expect((again.body as unknown as RunOutcome).batch.id).toBe(outcome.batch.id);
    // Audit: who did it, line by line, and the batch.
    expect(await count("audit_events where event_type = 'statement_line.unreconciled' and entity_id = any($1::text[]) and actor_email = $2", [[plain.id, splitA.id, splitB.id], bookkeeper.email])).toBe(3);
    expect(await count("audit_events where event_type = 'batch.created' and entity_id = $1", [outcome.batch.id])).toBe(1);

    // Batches on the account: viewers can see them.
    const listed = await listRoute.GET(apiRequest(`/api/bank-batches?organisationId=${ORG}&accountId=${bank.id}`, { cookie: await sessionCookieFor(viewer) }), noContext);
    expect(((await listed.json()) as { batches: Batch[] }).batches.map((entry) => entry.id)).toContain(outcome.batch.id);
  });

  it("cross-organisation: another organisation can't see or resume this one's batches", async () => {
    const mine = (await asUser(owner, (tx) => tx.query<{ id: string }>("select max(id)::text as id from batches"))).rows[0].id;
    const read = await batchRoute.GET(apiRequest(`/api/bank-batches/${mine}?organisationId=${ORG}`, { cookie: await sessionCookieFor(outsider) }), {
      params: Promise.resolve({ batchId: mine }),
    });
    expect(read.status).toBe(404);
    // In the outsider's own organisation that id is someone else's database: not found.
    const theirs = await batchRoute.GET(apiRequest(`/api/bank-batches/${mine}?organisationId=${OTHER_ORG}`, { cookie: await sessionCookieFor(outsider) }), {
      params: Promise.resolve({ batchId: mine }),
    });
    expect(theirs.status).toBe(404);
    expect((await post(resumeRoute.POST as never, `/api/bank-batches/${mine}/resume`, outsider, { organisationId: OTHER_ORG }, { batchId: mine })).status).toBe(404);
    expect((await post(undoRoute.POST as never, `/api/bank-batches/${mine}/undo`, outsider, { organisationId: OTHER_ORG }, { batchId: mine })).status).toBe(404);
  });

  it("AI unreconciling (Jess, decision 1277): a Full access key may unreconcile anyone's lines after a preview; lower levels can't", async () => {
    const [byPerson] = await importLines(bank, ["15/06/2026,-17.00,AI UR PERSON"]);
    await asUser(bookkeeper, (tx) =>
      reconcileStatementLine(tx, byPerson.id, { idempotencyKey: key("p"), kind: "bank_transaction", contactId: zEnergy.id, amountsMode: "no_tax", lines: [{ description: "x", accountCode: "6120", amount: "17.00" }] }),
    );
    await expect(call(tokens.post, "unmatch_bank_lines", { lineIds: [byPerson.id] })).rejects.toThrow(/needs an AI key with "Full access"/);
    await expect(call(tokens.read, "unmatch_bank_lines", { lineIds: [byPerson.id] })).rejects.toThrow(/needs an AI key with "Full access"/);
    await expect(call(tokens.read, "resume_bank_batch", { batchId: "1" })).rejects.toThrow(/needs an AI key with "Full access"/);
    expect((await line(byPerson.id)).status).toBe("reconciled");
    const preview = await call(tokens.full, "unmatch_bank_lines", { lineIds: [byPerson.id] });
    expect(preview).toMatchObject({ preview: true, lines: 1, blocked: 0 });
    expect((await line(byPerson.id)).status).toBe("reconciled");
    const before = await journals();
    const done = await call(tokens.full, "unmatch_bank_lines", { lineIds: [byPerson.id], previewHash: preview.previewHash, idempotencyKey: "ai-unmatch-001" });
    expect(done).toMatchObject({ kind: "bank_unreconcile", state: "done", succeeded: 1, results: [{ status: "committed", lineId: byPerson.id }] });
    expect((await line(byPerson.id)).status).toBe("unreconciled");
    expect(await journals()).toBe(before);
    // Its history names the person, via the AI key.
    const audit = await sql<{ actor_email: string; details: Json }>(
      "select actor_email, details from audit_events where event_type = 'statement_line.unreconciled' and entity_id = $1 order by id desc limit 1",
      [byPerson.id],
    );
    expect(audit[0]).toMatchObject({ actor_email: owner.email, details: { via: expect.stringContaining("full") } });

    // Read keys can look at batches; an AI can't resume a batch someone else made.
    const seen = await call(tokens.read, "get_bank_batch", { batchId: done.batchId as string });
    expect(seen).toMatchObject({ batchId: done.batchId, state: "done" });
    const person = (await asUser(owner, (tx) => tx.query<{ id: string }>("select id::text from batches where command_source = 'ui' order by id limit 1"))).rows[0].id;
    await expect(call(tokens.full, "resume_bank_batch", { batchId: person })).rejects.toThrow(/made by someone else/);
  });

  it("bulk_reconcile over MCP answers with its batch, and get_bank_batch reads it after a lost answer", async () => {
    const lines = await importLines(bank, ["16/06/2026,-18.10,MCP ONE", "16/06/2026,-18.20,MCP TWO"]);
    const actions = [spend(lines[0].id, "18.10"), spend(lines[1].id, "18.20")];
    const first = await call(tokens.full, "bulk_reconcile", { actions, idempotencyKey: "mcp-batch-01" });
    expect(first).toMatchObject({ state: "done", succeeded: 2, failed: 0, next: "All done.", results: [{ ok: true, created: true }, { ok: true, created: true }] });
    const before = await journals();
    const again = await call(tokens.full, "bulk_reconcile", { actions, idempotencyKey: "mcp-batch-01" });
    expect(again).toMatchObject({ batchId: first.batchId, succeeded: 2 });
    expect(await journals()).toBe(before);
    expect(await call(tokens.full, "get_bank_batch", { batchId: first.batchId as string })).toMatchObject({ counts: { committed: 2, total: 2 } });
    expect(((await call(tokens.full, "list_bank_batches", { mine: true })).batches as Json[]).map((entry) => entry.id)).toContain(first.batchId);
  });

  it("undoing a batch: reviewed first, voids what it posted on the line's date, both sides of a transfer, and a locked line is left with its reason", async () => {
    const [locked, spendLine, transferOut, matchLine] = await importLines(bank, [
      "20/04/2026,-19.00,UNDO LOCKED",
      "20/07/2026,-46.00,UNDO SPEND",
      "21/07/2026,-500.00,UNDO TRANSFER",
      "22/07/2026,25.00,UNDO MATCH",
    ]);
    const [transferIn] = await importLines(savings, ["21/07/2026,500.00,UNDO TRANSFER IN"]);
    const { bankTransaction: posted } = await asUser(owner, (tx) =>
      createBankTransaction(tx, { idempotencyKey: key("r"), kind: "receive", accountId: bank.id, contactId: zEnergy.id, date: "2026-07-22", amountsMode: "no_tax", lines: [{ description: "Refund", accountCode: "4000", amount: "25.00" }] }),
    );
    const postedLine = (await sql<{ id: string }>("select id::text from ledger_journal_lines where journal_id = $1 and account_id = $2", [posted.journalId, bank.id]))[0].id;
    const made = await startReconcileBatch(run, {
      actions: [
        spend(locked.id, "19.00"),
        { action: "create_and_match", lineId: spendLine.id, contactId: zEnergy.id, amountsMode: "inclusive", lines: [{ description: "Fuel", accountCode: "6120", taxCode: "GST", amount: "46.00" }], gstEvidence: "tax_document" },
        { action: "transfer_and_match", lineId: transferOut.id, otherAccountCode: "1010" },
        { action: "match", lineId: matchLine.id, journalLineIds: [postedLine] },
      ],
      idempotencyKey: "undo-src-1",
      source: SOURCE,
    });
    expect(made.batch.state).toBe("done");
    expect((await line(transferIn.id)).status).toBe("reconciled");
    await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: "2026-04-30", reason: "Test set-up" }));

    const path = `/api/bank-batches/${made.batch.id}/undo`;
    const params = { batchId: made.batch.id };
    expect((await post(undoRoute.POST as never, path, viewer, { organisationId: ORG }, params)).status).toBe(403);
    const preview = await post(undoRoute.POST as never, path, bookkeeper, { organisationId: ORG }, params);
    const plan = preview.body.plan as Plan;
    expect(plan.counts).toMatchObject({ items: 4, blocked: 1, voids: 2 });
    expect(plan.items.find((item) => item.lineId === locked.id)!.blocked).toMatch(/locked period/);
    expect(plan.items.find((item) => item.lineId === transferOut.id)!.alsoLines.map((other) => [other.lineId, other.why])).toEqual([[transferIn.id, "transfer"]]);
    expect(plan.items.find((item) => item.lineId === matchLine.id)!.voids).toBeNull();

    const before = await journals();
    // A partial failure part way: the second action's transaction is lost before it commits.
    const organisation = (await getOrganisation(ORG))!;
    const asBookkeeper: OrgRunner = (work) => withOrganisationTransaction(organisation, { userId: bookkeeper.id, email: bookkeeper.email }, work);
    const { startBatchUndo } = await import("@/lib/bank/batches");
    const partial = await startBatchUndo(faulty(asBookkeeper, 2, "before"), made.batch.id, { previewHash: plan.hash, idempotencyKey: "undo-run-0001", source: "ui" });
    expect(partial.stopped).toBe("lost_connection");
    expect(statuses(partial.batch)).toEqual(["failed", "committed", "unknown", "pending"]);
    expect(partial.batch.actions[0].error).toMatch(/locked period/);
    expect((await line(spendLine.id)).status).toBe("unreconciled");
    expect((await line(transferOut.id)).status).toBe("reconciled");
    expect((await line(transferIn.id)).status).toBe("reconciled");
    expect(await journals()).toBe(before + 1);

    const finished = await post(resumeRoute.POST as never, `/api/bank-batches/${partial.batch.id}/resume`, bookkeeper, { organisationId: ORG }, { batchId: partial.batch.id });
    expect(finished.status).toBe(200);
    const result = (finished.body as unknown as RunOutcome).batch;
    expect(statuses(result)).toEqual(["failed", "committed", "committed", "committed"]);
    expect(result.state).toBe("finished_with_failures");
    for (const id of [spendLine.id, transferOut.id, transferIn.id, matchLine.id]) expect((await line(id)).status, id).toBe("unreconciled");
    expect((await line(locked.id)).status).toBe("reconciled");
    // Two voids (the spend money and the transfer), on the lines' dates; the match posted nothing to reverse.
    expect(await journals()).toBe(before + 2);
    const voids = await sql<{ void_date: string }>(
      `select void_date::text from bank_transactions where status = 'voided' and void_command_source = 'ui' and void_idempotency_key like 'undo-run-0001:%'
       union all select void_date::text from bank_transfers where status = 'voided' and void_command_source = 'ui' and void_idempotency_key like 'undo-run-0001:%' order by 1`,
    );
    expect(voids.map((row) => row.void_date)).toEqual(["2026-07-20", "2026-07-21"]);
    // Linked both ways, and nothing deleted: the reconciliations are kept as removed.
    expect((await batch(made.batch.id)).undoneByBatchIds).toEqual([partial.batch.id]);
    expect(await count("bank_reconciliations where command_source = $1 and idempotency_key like 'undo-src-1:%'", [SOURCE])).toBe(5);
    // Undoing again finds nothing left but the locked line.
    const second = (await post(undoRoute.POST as never, path, bookkeeper, { organisationId: ORG }, params)).body.plan as Plan;
    expect(second.items.filter((item) => !item.blocked)).toEqual([]);
  });

  it("planUnreconcile refuses lines that aren't reconciled and lines in a locked period, and startUnreconcileBatch records them as refused", async () => {
    const [open, lockedLine] = await importLines(bank, ["23/07/2026,-20.00,NOT RECONCILED", "21/04/2026,-21.00,LOCKED LINE"]);
    await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: null, reason: "Test set-up" }));
    await asUser(owner, (tx) =>
      reconcileStatementLine(tx, lockedLine.id, { idempotencyKey: key("p"), kind: "bank_transaction", contactId: zEnergy.id, amountsMode: "no_tax", lines: [{ description: "x", accountCode: "6120", amount: "21.00" }] }),
    );
    await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: "2026-04-30", reason: "Test set-up" }));
    const plan = await asUser(bookkeeper, (tx) => planUnreconcile(tx, [open.id, lockedLine.id]));
    expect(plan.items.map((item) => Boolean(item.blocked))).toEqual([true, true]);
    const outcome = await startUnreconcileBatch(run, { lineIds: [open.id, lockedLine.id], previewHash: plan.hash, idempotencyKey: "ur-locked-01", source: SOURCE });
    expect(statuses(outcome.batch)).toEqual(["failed", "failed"]);
    expect((await line(lockedLine.id)).status).toBe("reconciled");
  });
});
