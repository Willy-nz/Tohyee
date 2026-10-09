import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import { AI_TOOLS } from "@/lib/ai/catalogue";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, listBankAccounts, listStatementLines, type BankAccount } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine, unreconcileStatementLine } from "@/lib/bank/reconcile";
import { type Contact, createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { recordPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, getInvoice, type InvoiceSummary } from "@/lib/invoices/service";
import { getJournal } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { getOrganisation } from "@/lib/organisations/registry";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  sessionCookieFor,
  startTestServer,
  testDatabaseUrl,
  type TestServer,
  withDb,
} from "../helpers/test-server";

const ORG = "ai-bank";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;
type Line = { id: string; amount: string; status: string; reconciliation: { kind: string; items: { journalId: string }[] } | null };

const FULL_ONLY = AI_TOOLS.filter((tool) => tool.level === "full").map((tool) => tool.name).sort();
const UP_TO_POST = AI_TOOLS.filter((tool) => tool.level !== "full").map((tool) => tool.name).sort();
const ALL = AI_TOOLS.map((tool) => tool.name).sort();

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

async function toolNames(token: string): Promise<string[]> {
  return ((await rpc(token, "tools/list")).result as { tools: { name: string }[] }).tools.map((tool) => tool.name).sort();
}

/** Calls a tool; returns its JSON answer, or throws with the error text. */
async function call(token: string, name: string, args: Json = {}): Promise<Json> {
  const body = await rpc(token, "tools/call", { name, arguments: args });
  if (body.error) throw new Error(`rpc ${(body.error as Json).code}: ${(body.error as Json).message}`);
  const result = body.result as { content: { text: string }[]; isError?: boolean };
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text) as Json;
}

/** Decision 488 and examples AIB1-AIB8: Full access AI keys and the bank reconciliation tools (#205). */
describeWithDatabase("AI keys reconciling bank lines (decision 488, AIB1-AIB8)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let formerOwner: SessionUser;
  let bank: BankAccount;
  let savings: BankAccount;
  let kobe: Contact;
  let zEnergy: Contact;
  let invoice: InvoiceSummary;
  const tokens: Record<string, string> = {};
  let fileNumber = 0;

  const asOwner = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const sql = async <T extends Json = Json>(text: string, values: unknown[] = []) => (await asOwner((tx) => tx.query<T>(text, values))).rows;
  const journalCount = async () => Number((await sql<{ count: string }>("select count(*)::text as count from ledger_journals"))[0].count);

  async function makeKey(user: SessionUser, name: string, accessLevel: string, extra: Json = {}) {
    return tokensRoute.POST(
      apiRequest("/api/ai/tokens", { method: "POST", cookie: await sessionCookieFor(user), body: { organisationId: ORG, name, accessLevel, ...extra } }),
      noContext,
    );
  }

  /** Imports rows "dd/mm/2026,amount,payee" into an account and returns the new lines by amount. */
  async function importLines(account: BankAccount, rows: string[]): Promise<Record<string, Line>> {
    fileNumber += 1;
    const csv = `Date,Amount,Payee\n${rows.join("\n")}\n`;
    await asOwner((tx) =>
      importStatementFile(tx, account.id, { idempotencyKey: key("import"), fileName: `s${fileNumber}.csv`, fileBase64: Buffer.from(csv).toString("base64") }),
    );
    const lines = (await asOwner((tx) => listStatementLines(tx, account.id, { status: "all", limit: 500 }))).lines;
    const byAmount: Record<string, Line> = {};
    for (const row of rows) {
      const amount = row.split(",")[1];
      const found = lines.find((line) => line.amount === amount);
      if (found) byAmount[amount] = found as unknown as Line;
    }
    return byAmount;
  }

  const line = async (lineId: string) => (await call(tokens.full, "get_bank_line", { lineId })).line as Line;
  const postedLines = async (journalId: string) =>
    (await asOwner((tx) => getJournal(tx, journalId))).lines.map((entry) => [entry.accountCode, entry.debitAmount, entry.creditAmount]);

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true, displayName: "Jess" });
    await createTestOrganisation(owner, ORG);
    bookkeeper = await createTestUser("bookkeeper@example.com");
    formerOwner = await createTestUser("former@example.com");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'owner')", [
      ORG,
      bookkeeper.id,
      formerOwner.id,
    ]);
    kobe = (await asOwner((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Ltd", isCustomer: true }))).contact;
    zEnergy = (await asOwner((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Z Energy", isSupplier: true }))).contact;
    await asOwner((tx) => createBankAccount(tx, { code: "1010", name: "Savings account", accountType: "bank" }));
    const accounts = await asOwner((tx) => listBankAccounts(tx));
    bank = accounts.find((account) => account.code === "1000")!;
    savings = accounts.find((account) => account.code === "1010")!;
    invoice = await asOwner(async (tx) => {
      const drafted = await createInvoice(tx, {
        idempotencyKey: key("invoice"),
        contactId: kobe.id,
        invoiceDate: "2026-05-10",
        dueDate: "2026-06-20",
        amountsMode: "exclusive",
        lines: [{ description: "Consulting", quantity: "2", unitPrice: "50.00", accountCode: "4000", taxCode: "GST" }],
      });
      return (await approveInvoice(tx, drafted.invoice.id, { idempotencyKey: key("approve") })).invoice;
    });
    for (const [name, user, level] of [
      ["full", owner, "full"],
      ["other", owner, "full"],
      ["post", owner, "post"],
      ["former", formerOwner, "full"],
    ] as const) {
      const response = await makeKey(user, name, level, level === "full" ? { confirmFullAccess: true } : {});
      expect(response.status).toBe(201);
      tokens[name] = ((await response.json()) as { token: string }).token;
    }
    // Jess's co-owner is now an admin: their Full access key works as "Make and post" (AIB5).
    await coreQuery("update organisation_members set role = 'admin' where organisation_id = $1 and user_id = $2", [ORG, formerOwner.id]);
  });

  afterAll(async () => {
    await server?.teardown();
  });

  describe("making a Full access key", () => {
    it("is for Owners only, and needs the warning confirmed", async () => {
      expect((await makeKey(bookkeeper, "Nope", "full", { confirmFullAccess: true })).status).toBe(403);
      const unconfirmed = await makeKey(owner, "Unconfirmed", "full");
      expect(unconfirmed.status).toBe(400);
      expect(((await unconfirmed.json()) as Json).error).toMatch(/tick the box/);
      const audit = await coreQuery<{ details: Json }>(
        "select details from admin_audit_events where event_type = 'ai_access_token.created' and details->>'name' = 'full'",
      );
      expect(audit.rows[0].details).toMatchObject({ accessLevel: "full" });
    });
  });

  it("AIB5: tools/list shows the bank tools to the levels they're for, capped by the owner's role now", async () => {
    expect(await toolNames(tokens.full)).toEqual(ALL);
    expect(await toolNames(tokens.post)).toEqual(UP_TO_POST);
    expect(await toolNames(tokens.former)).toEqual(UP_TO_POST);
    expect(UP_TO_POST).toEqual(expect.arrayContaining(["list_bank_accounts", "list_bank_lines", "get_bank_line", "reconciliation_summary"]));
    expect(FULL_ONLY).toEqual(expect.arrayContaining(
      ["apply_bank_rule", "bulk_reconcile", "create_and_match", "create_bank_rule", "match_bank_line", "transfer_and_match", "unmatch_bank_line", "update_bank_rule"],
    ));
    const refused = await rpc(tokens.post, "tools/call", { name: "create_and_match", arguments: {} });
    expect(refused.error).toMatchObject({ message: expect.stringContaining('"Full access" access and the Owner role') });
    expect(((await rpc(tokens.full, "initialize", {})).result as Json).instructions).toContain("unmatch_bank_line");
  });

  it("reads accounts, lines (filtered), suggestions, rules and the summary", async () => {
    const lines = await importLines(bank, ["01/05/2026,11.11,READ ONE", "02/05/2026,-22.22,READ TWO", "28/05/2026,-33.33,READ THREE"]);
    const accounts = (await call(tokens.post, "list_bank_accounts")).accounts as Json[];
    expect(accounts.find((account) => account.code === "1000")).toMatchObject({ type: "bank", currencyCode: "NZD", unreconciledCount: expect.any(Number) });
    const filtered = await call(tokens.post, "list_bank_lines", { accountId: bank.id, from: "2026-05-01", to: "2026-05-02", search: "READ" });
    expect((filtered.lines as Line[]).map((entry) => entry.amount)).toEqual(["11.11", "-22.22"]);
    expect(filtered.total).toBe(2);
    expect(((await call(tokens.post, "list_bank_lines", { accountId: bank.id, search: "-33.33" })).lines as Line[]).map((entry) => entry.id)).toEqual([
      lines["-33.33"].id,
    ]);
    const one = await call(tokens.post, "get_bank_line", { lineId: lines["11.11"].id });
    expect(one).toMatchObject({ line: { status: "unreconciled", amount: "11.11" }, suggestions: { matches: expect.any(Array), rule: null } });
    const summary = (await call(tokens.post, "reconciliation_summary")).accounts as Json[];
    expect(summary.find((account) => account.code === "1000")).toMatchObject({ oldestUnreconciled: "2026-05-01", difference: null });
    expect(await call(tokens.post, "list_bank_rules")).toEqual({ rules: [] });
  });

  it("AIB1: match_bank_line matches what's posted (nothing posted) and pays invoices, part payments included; wrong totals are refused", async () => {
    const lines = await importLines(bank, ["20/05/2026,115.00,KOBE LTD", "21/05/2026,40.00,KOBE PART"]);
    const payment = await asOwner((tx) =>
      recordPayment(tx, invoice.id, { idempotencyKey: key("pay"), paymentDate: "2026-05-20", amount: "115.00", bankAccountCode: "1000" }),
    );
    const suggestions = (await call(tokens.full, "get_bank_line", { lineId: lines["115.00"].id })).suggestions as { matches: Json[] };
    const candidate = suggestions.matches.find((match) => match.journalId === payment.payment.journalId)!;
    await expect(call(tokens.full, "match_bank_line", { lineId: lines["40.00"].id, journalLineIds: [candidate.journalLineId] })).rejects.toThrow(
      /add up to 115.00, but the line is 40.00/,
    );
    const before = await journalCount();
    const matched = await call(tokens.full, "match_bank_line", { lineId: lines["115.00"].id, journalLineIds: [candidate.journalLineId] });
    expect(matched).toMatchObject({ created: true, line: { status: "reconciled", reconciliation: { kind: "match", by: "owner@example.com" } } });
    expect(await journalCount()).toBe(before);

    // A second invoice, part paid from the 40.00 line.
    const second = await asOwner(async (tx) => {
      const drafted = await createInvoice(tx, {
        idempotencyKey: key("invoice"),
        contactId: kobe.id,
        invoiceDate: "2026-05-11",
        dueDate: "2026-06-20",
        amountsMode: "exclusive",
        lines: [{ description: "More consulting", quantity: "1", unitPrice: "100.00", accountCode: "4000", taxCode: "GST" }],
      });
      return (await approveInvoice(tx, drafted.invoice.id, { idempotencyKey: key("approve") })).invoice;
    });
    await expect(call(tokens.full, "match_bank_line", { lineId: lines["40.00"].id, allocations: [{ invoiceId: second.id, amount: "30.00" }] })).rejects.toThrow(
      /must add up to the line/,
    );
    const paid = await call(tokens.full, "match_bank_line", { lineId: lines["40.00"].id, allocations: [{ invoiceId: second.id, amount: "40.00" }] });
    expect(paid).toMatchObject({ created: true, line: { reconciliation: { kind: "payments" } } });
    expect(await asOwner((tx) => getInvoice(tx, second.id))).toMatchObject({ amountPaid: "40.00", amountDue: "75.00" });
    const history = await sql<{ via: string }>(
      "select details->>'via' as via from audit_events where event_type = 'statement_line.reconciled' and entity_id = $1",
      [lines["40.00"].id],
    );
    expect(history[0].via).toBe('AI key "full"');
  });

  it("AIB2: create_and_match posts BK6's spend money and reconciles; a retry with the same key posts nothing more", async () => {
    const lines = await importLines(bank, ["21/05/2026,-46.00,Z ENERGY"]);
    const args = {
      lineId: lines["-46.00"].id,
      contactId: zEnergy.id,
      amountsMode: "inclusive",
      lines: [{ description: "Petrol", accountCode: "6120", taxCode: "GST", amount: "46.00" }],
      idempotencyKey: "aib2-create-and-match",
    };
    const done = await call(tokens.full, "create_and_match", args);
    expect(done).toMatchObject({ created: true, line: { status: "reconciled", reconciliation: { kind: "bank_transaction" } } });
    const journalId = (done.line as Line).reconciliation!.items[0].journalId;
    expect(await postedLines(journalId)).toEqual([
      ["6120", "40.00", "0.00"],
      ["2100", "6.00", "0.00"],
      ["1000", "0.00", "46.00"],
    ]);
    const before = await journalCount();
    expect(await call(tokens.full, "create_and_match", args)).toMatchObject({ created: false });
    expect(await journalCount()).toBe(before);
  });

  it("AIB3: transfer_and_match records the transfer and matches the other account's line when there's exactly one", async () => {
    const out = await importLines(bank, ["22/05/2026,-500.00,TRANSFER SAVINGS"]);
    const inn = await importLines(savings, ["22/05/2026,500.00,TRANSFER IN"]);
    const done = await call(tokens.full, "transfer_and_match", { lineId: out["-500.00"].id, otherAccountCode: "1010" });
    expect(done).toMatchObject({ created: true, line: { status: "reconciled", reconciliation: { kind: "transfer" } }, otherSide: { matched: true, lineId: inn["500.00"].id } });
    expect((await line(inn["500.00"].id)).status).toBe("reconciled");
    // No line on the other side yet: the transfer is still recorded.
    const lonely = await importLines(bank, ["23/05/2026,-77.00,TRANSFER LATER"]);
    expect(await call(tokens.full, "transfer_and_match", { lineId: lonely["-77.00"].id, otherAccountCode: "1010" })).toMatchObject({
      created: true,
      otherSide: { matched: false, reason: expect.stringContaining("No unreconciled 77.00 line") },
    });
  });

  it("create_bank_rule, update_bank_rule (staying switched on) and apply_bank_rule (BK10 through a key)", async () => {
    const made = await call(tokens.full, "create_bank_rule", {
      name: "Fuel",
      direction: "out",
      conditions: [{ field: "any", operator: "contains", text: "caltex" }],
      contactMode: "chosen",
      contactId: zEnergy.id,
      lines: [{ accountCode: "6120", taxCode: "GST", percentage: "100" }],
    });
    const rule = made.rule as Json;
    expect(rule).toMatchObject({ name: "Fuel", isActive: true });
    await expect(call(tokens.post, "create_bank_rule", { name: "x" })).rejects.toThrow(/Full access/);
    const updated = await call(tokens.full, "update_bank_rule", {
      ruleId: rule.id,
      name: "Fuel (Caltex)",
      direction: "out",
      conditions: [{ field: "any", operator: "contains", text: "caltex" }],
      contactMode: "chosen",
      contactId: zEnergy.id,
      lines: [{ accountCode: "6120", taxCode: "GST", percentage: "100" }],
    });
    expect(updated.rule).toMatchObject({ name: "Fuel (Caltex)", isActive: true });
    expect(await call(tokens.full, "get_bank_rule", { ruleId: rule.id })).toMatchObject({ rule: { name: "Fuel (Caltex)" } });

    const lines = await importLines(bank, ["24/05/2026,-23.00,CALTEX DUNEDIN", "24/05/2026,-24.00,COUNTDOWN"]);
    const applied = await call(tokens.full, "apply_bank_rule", { lineIds: [lines["-23.00"].id, lines["-24.00"].id], idempotencyKey: "apply-rule-1" });
    expect(applied).toMatchObject({
      succeeded: 1,
      failed: 1,
      results: [
        { lineId: lines["-23.00"].id, ok: true, created: true },
        { lineId: lines["-24.00"].id, ok: false, error: "No bank rule applies to this line." },
      ],
    });
    const journalId = (await line(lines["-23.00"].id)).reconciliation!.items[0].journalId;
    expect(await postedLines(journalId)).toEqual([
      ["6120", "20.00", "0.00"],
      ["2100", "3.00", "0.00"],
      ["1000", "0.00", "23.00"],
    ]);
    // A retry does the first line again as a replay.
    expect(await call(tokens.full, "apply_bank_rule", { lineIds: [lines["-23.00"].id], idempotencyKey: "apply-rule-1" })).toMatchObject({
      results: [{ ok: true, created: false }],
    });
  });

  it("AIB4: bulk_reconcile does each line on its own and says why one was refused", async () => {
    const lines = await importLines(bank, ["25/05/2026,-11.50,BULK ONE", "25/05/2026,-12.50,BULK TWO"]);
    const code = (lineId: string, amount: string) => ({
      action: "create_and_match",
      lineId,
      contactId: zEnergy.id,
      amountsMode: "no_tax",
      lines: [{ description: "Bulk", accountCode: "6120", amount }],
    });
    const before = await journalCount();
    const result = await call(tokens.full, "bulk_reconcile", {
      idempotencyKey: "bulk-aib4",
      actions: [code(lines["-11.50"].id, "11.50"), code(lines["-12.50"].id, "99.00"), { action: "match", lineId: "999999", journalLineIds: ["1"] }],
    });
    expect(result).toMatchObject({
      succeeded: 1,
      failed: 2,
      results: [
        { index: 0, ok: true, created: true },
        { index: 1, ok: false, error: expect.stringMatching(/46|99.00|12.50/) },
        { index: 2, ok: false, error: "Statement line not found." },
      ],
    });
    expect(await journalCount()).toBe(before + 1);
    expect((await line(lines["-12.50"].id)).status).toBe("unreconciled");
    const tooMany = Array.from({ length: 101 }, () => ({ action: "match", lineId: "1" }));
    await expect(call(tokens.full, "bulk_reconcile", { actions: tooMany })).rejects.toThrow(/at most 100/);
  });

  it("AIB7: unmatch_bank_line undoes the key's own reconciliation, reversing what it posted on the line's date", async () => {
    // Spend money.
    const lines = await importLines(bank, ["26/05/2026,-57.50,UNDO SPEND", "26/05/2026,13.00,UNDO MATCH"]);
    const made = await call(tokens.full, "create_and_match", {
      lineId: lines["-57.50"].id,
      contactId: zEnergy.id,
      amountsMode: "inclusive",
      lines: [{ description: "Fuel", accountCode: "6120", taxCode: "GST", amount: "57.50" }],
    });
    const journalId = (made.line as Line).reconciliation!.items[0].journalId;
    const undone = await call(tokens.full, "unmatch_bank_line", { lineId: lines["-57.50"].id, idempotencyKey: "undo-spend-1" });
    expect(undone).toMatchObject({ created: true, line: { status: "unreconciled", reconciliation: null }, reversed: { bankTransactionId: expect.any(String) } });
    const voided = (
      await sql<{ status: string; void_date: string; void_journal_id: string }>(
        "select status, void_date::text, void_journal_id::text from bank_transactions where journal_id = $1",
        [journalId],
      )
    )[0];
    expect(voided).toMatchObject({ status: "voided", void_date: "2026-05-26" });
    expect(await postedLines(voided.void_journal_id)).toEqual([
      ["6120", "0.00", "50.00"],
      ["2100", "0.00", "7.50"],
      ["1000", "57.50", "0.00"],
    ]);
    // A retry with the same key answers the same and does nothing more.
    const before = await journalCount();
    expect(await call(tokens.full, "unmatch_bank_line", { lineId: lines["-57.50"].id, idempotencyKey: "undo-spend-1" })).toMatchObject({ created: false });
    expect(await journalCount()).toBe(before);

    // A match to something already posted: unreconciled only.
    const posted = await asOwner((tx) =>
      reconcileStatementLine(tx, lines["13.00"].id, {
        source: "api",
        idempotencyKey: key("not-ai"),
        kind: "bank_transaction",
        contactId: kobe.id,
        amountsMode: "no_tax",
        lines: [{ description: "Interest", accountCode: "4000", amount: "13.00" }],
      }),
    );
    const postedJournalLine = (await sql<{ id: string }>("select id::text from ledger_journal_lines where journal_id = $1 and account_id = $2", [
      posted.line.reconciliation!.items[0].journalId,
      bank.id,
    ]))[0].id;
    await asOwner((tx) => unreconcileStatementLine(tx, lines["13.00"].id, { idempotencyKey: key("unrec") }));
    await call(tokens.full, "match_bank_line", { lineId: lines["13.00"].id, journalLineIds: [postedJournalLine] });
    const afterMatch = await journalCount();
    expect(await call(tokens.full, "unmatch_bank_line", { lineId: lines["13.00"].id })).toMatchObject({ created: true, reversed: null });
    expect(await journalCount()).toBe(afterMatch);

    // A transfer matched on both sides: both unreconciled, the transfer voided on the line's date.
    const out = await importLines(bank, ["27/05/2026,-250.00,UNDO TRANSFER"]);
    const inn = await importLines(savings, ["27/05/2026,250.00,UNDO TRANSFER IN"]);
    expect(await call(tokens.full, "transfer_and_match", { lineId: out["-250.00"].id, otherAccountCode: "1010" })).toMatchObject({ otherSide: { matched: true } });
    const undoneTransfer = await call(tokens.full, "unmatch_bank_line", { lineId: out["-250.00"].id });
    expect(undoneTransfer).toMatchObject({ reversed: { transferId: expect.any(String) }, otherLinesUnreconciled: [inn["250.00"].id] });
    expect((await line(inn["250.00"].id)).status).toBe("unreconciled");
    expect(
      (await sql<{ status: string; void_date: string }>("select status, void_date::text from bank_transfers where id = $1", [
        (undoneTransfer.reversed as Json).transferId,
      ]))[0],
    ).toEqual({ status: "voided", void_date: "2026-05-27" });
  });

  it("AIB8: unmatch_bank_line refuses a person's match, another key's, and one over 24 hours old", async () => {
    const lines = await importLines(bank, ["28/05/2026,-14.00,BY A PERSON", "28/05/2026,-15.00,BY OTHER KEY", "28/05/2026,-16.00,OLD MATCH"]);
    const spend = (amount: string) => ({ contactId: zEnergy.id, amountsMode: "no_tax", lines: [{ description: "x", accountCode: "6120", amount }] });
    await asOwner((tx) => reconcileStatementLine(tx, lines["-14.00"].id, { idempotencyKey: key("person"), kind: "bank_transaction", ...spend("14.00") }));
    await call(tokens.other, "create_and_match", { lineId: lines["-15.00"].id, ...spend("15.00") });
    await call(tokens.full, "create_and_match", { lineId: lines["-16.00"].id, ...spend("16.00") });
    await expect(call(tokens.full, "unmatch_bank_line", { lineId: lines["-14.00"].id })).rejects.toThrow(/by a person or another AI key.*A person must/);
    await expect(call(tokens.full, "unmatch_bank_line", { lineId: lines["-15.00"].id })).rejects.toThrow(/by a person or another AI key/);

    // Make the third reconciliation 25 hours old (the database won't let it change otherwise).
    const organisation = await getOrganisation(ORG);
    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, organisation!.databaseName) });
    await client.connect();
    try {
      await client.query("set session_replication_role = replica");
      await client.query("update bank_reconciliations set created_at = now() - interval '25 hours' where statement_line_id = $1 and status = 'active'", [
        lines["-16.00"].id,
      ]);
    } finally {
      await client.end();
    }
    await expect(call(tokens.full, "unmatch_bank_line", { lineId: lines["-16.00"].id })).rejects.toThrow(/more than 24 hours ago/);
    for (const amount of ["-14.00", "-15.00", "-16.00"]) expect((await line(lines[amount].id)).status).toBe("reconciled");
  });

  it("no tool deletes, excludes or switches anything off", () => {
    for (const tool of AI_TOOLS) {
      for (const word of ["delete", "void", "archive", "exclude", "deactivate", "unreconcile"]) expect(tool.name.split("_"), tool.name).not.toContain(word);
      if (tool.level !== "read" && !tool.readOnly) expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(/isActive|archiv|void|delete|"excluded"/i);
    }
  });

  // Last: it locks May for the rest of the file.
  it("AIB6: a locked period is refused, for reconciling and for undoing, and nothing changes", async () => {
    const lines = await importLines(bank, ["29/05/2026,-17.00,BEFORE LOCK", "29/05/2026,-18.00,LOCKED"]);
    const spend = (amount: string) => ({ contactId: zEnergy.id, amountsMode: "no_tax", lines: [{ description: "x", accountCode: "6120", amount }] });
    await call(tokens.full, "create_and_match", { lineId: lines["-17.00"].id, ...spend("17.00") });
    await asOwner((tx) => updatePeriodControls(tx, { lockDate: "2026-05-31", reason: "Test set-up" }));
    const before = await journalCount();
    await expect(call(tokens.full, "create_and_match", { lineId: lines["-18.00"].id, ...spend("18.00") })).rejects.toThrow(/lock/i);
    await expect(call(tokens.full, "unmatch_bank_line", { lineId: lines["-17.00"].id })).rejects.toThrow(/lock/i);
    expect(await journalCount()).toBe(before);
    expect((await line(lines["-17.00"].id)).status).toBe("reconciled");
    expect((await line(lines["-18.00"].id)).status).toBe("unreconciled");
  });
});
