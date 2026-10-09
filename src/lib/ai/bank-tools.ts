import { randomBytes } from "node:crypto";
import { boundedLimit } from "@/lib/ai/limits";
import { type AiTool, DATE, type JsonSchema, schema, type ToolContext } from "@/lib/ai/tools";
import { getStatementLine, listBankAccounts, listStatementLines, type StatementLine } from "@/lib/bank/accounts";
import { lineErrorText } from "@/lib/bank/bulk";
import { reconcileStatementLine, suggestionsForLine, unreconcileStatementLine } from "@/lib/bank/reconcile";
import { type BankRule, createBankRule, getBankRule, listBankRules, ruleAmountsMode, ruleContact, ruleLinesFor, ruleMatches, updateBankRule } from "@/lib/bank/rules";
import { voidBankTransaction, voidTransfer } from "@/lib/bank/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ValidationError } from "@/lib/errors";
import { dec, neg, sub, toFixedString } from "@/lib/money/decimal";
import { asRecord, requireArray, requireId, requireIdempotencyKey, requireOneOf } from "@/lib/validation";

/**
 * Bank reconciliation for a connected AI (#205, decision 488, examples
 * AIB1-AIB8). The read tools are for any key; the rest need a Full access
 * key. Each reconciling tool sends the same command the reconcile screen
 * does (BK4-BK9), so it posts exactly what a person's click would; nothing
 * here excludes a line, deletes an import, voids, or deletes or switches off
 * a rule. The one undo is unmatch_bank_line, for the key's own
 * reconciliations in the last 24 hours (AIB7, AIB8).
 */

const MAX_LINES = 200;
/** At most this many lines in one call of bulk_reconcile or apply_bank_rule (#205). */
export const MAX_BULK_LINES = 100;
/** How long a key can undo its own reconciliation (#205). */
const UNDO_HOURS = 24;

/** Shorter than other tools' keys: a bulk call adds the line id to it for each line. */
const IDEMPOTENCY: JsonSchema = {
  type: "string",
  pattern: "^[A-Za-z0-9._:-]{8,80}$",
  description:
    "8-80 letters, numbers, dots, colons, dashes or underscores. Send the same key if you retry the same call, so nothing is posted twice; a new key for a new one. Made up for you if left out (then a retry would do it again).",
};
const ID = (what: string): JsonSchema => ({ type: "string", description: `The ${what}'s id.` });
const EXCHANGE_RATE: JsonSchema = {
  type: "string",
  description: "Only for a line in a foreign currency: base currency per 1 unit. Left out, the last rate used for that currency.",
};
const CODE_LINES: JsonSchema = {
  type: "array",
  minItems: 1,
  maxItems: 100,
  description: "What the money was for. The amounts must add up to the line (without its sign).",
  items: {
    type: "object",
    properties: {
      description: { type: "string" },
      accountCode: { type: "string", description: "From list_accounts." },
      taxCode: { type: ["string", "null"], description: "A GST code, e.g. GST, ZERO, EXEMPT, or null for none." },
      amount: { type: "string", description: "A decimal, e.g. \"46.00\"." },
      tracking: { type: "object", description: "Tracking options, e.g. {\"Region\": \"Otago\"}." },
    },
    required: ["description", "accountCode", "amount"],
  },
};
const ALLOCATIONS: JsonSchema = {
  type: "array",
  minItems: 1,
  maxItems: 100,
  description:
    "Invoices (money in) or bills (money out) paid by the line, each with the amount paid; part payments are fine. They must add up to the line exactly.",
  items: {
    type: "object",
    properties: { invoiceId: { type: "string" }, billId: { type: "string" }, amount: { type: "string" } },
    required: ["amount"],
  },
};
const RULE_FIELDS: Record<string, JsonSchema> = {
  name: { type: "string" },
  priority: { type: "integer", description: "Lower runs first." },
  accountId: { type: ["string", "null"], description: "Only for this bank account (from list_bank_accounts); null for every account." },
  direction: { type: "string", enum: ["any", "in", "out"] },
  matchMode: { type: "string", enum: ["all", "any"], description: "Whether every condition or any one must hold." },
  conditions: {
    type: "array",
    minItems: 1,
    maxItems: 10,
    items: {
      type: "object",
      properties: {
        field: { type: "string", enum: ["any", "description", "payee", "particulars", "code", "reference", "amount"] },
        operator: { type: "string", enum: ["contains", "equals", "starts_with", "at_least", "at_most", "between"] },
        text: { type: "string" },
        amount: { type: "string", description: "Without its sign." },
        amountTo: { type: "string", description: "For between." },
      },
      required: ["field"],
    },
  },
  contactMode: { type: "string", enum: ["chosen", "payee"], description: "chosen: contactId; payee: the contact named like the line's payee." },
  contactId: { type: ["string", "null"] },
  lines: {
    type: "array",
    minItems: 1,
    maxItems: 20,
    description: "Fixed amounts are taken first; percentages share what's left and must add up to 100.",
    items: {
      type: "object",
      properties: {
        accountCode: { type: "string" },
        taxCode: { type: ["string", "null"] },
        description: { type: "string" },
        tracking: { type: "object" },
        fixedAmount: { type: "string" },
        percentage: { type: "string" },
      },
      required: ["accountCode"],
    },
  },
};

function idempotencyKey(input: unknown): string {
  if (input === undefined || input === null || input === "") return `ai-${randomBytes(12).toString("hex")}`;
  const key = requireIdempotencyKey(input);
  if (key.length > 80) throw new ValidationError("idempotencyKey must be at most 80 characters for bank tools.");
  return key;
}

function lineSummary(line: StatementLine) {
  return {
    id: line.id,
    accountId: line.accountId,
    date: line.date,
    amount: line.amount,
    currencyCode: line.currencyCode,
    description: line.description,
    payee: line.payee,
    particulars: line.particulars,
    code: line.code,
    reference: line.reference,
    status: line.status,
    possibleDuplicateOf: line.possibleDuplicateOf,
    reconciliation: line.reconciliation
      ? {
          kind: line.reconciliation.kind,
          at: line.reconciliation.createdAt,
          by: line.reconciliation.createdByEmail,
          items: line.reconciliation.items.map((item) => ({
            journalId: item.journalId,
            journalLineId: item.journalLineId,
            amount: item.amount,
            postingDate: item.postingDate,
            origin: item.origin,
            reference: item.reference,
          })),
        }
      : null,
  };
}

function ruleSummary(rule: BankRule) {
  return {
    id: rule.id,
    name: rule.name,
    isActive: rule.isActive,
    priority: rule.priority,
    accountId: rule.accountId,
    accountCode: rule.accountCode,
    direction: rule.direction,
    matchMode: rule.matchMode,
    conditions: rule.conditions,
    contactMode: rule.contactMode,
    contactId: rule.contactId,
    contactName: rule.contactName,
    lines: rule.lines.map(({ accountCode, accountName, taxCode, description, tracking, fixedAmount, percentage }) => ({
      accountCode,
      accountName,
      taxCode,
      description,
      tracking,
      fixedAmount,
      percentage,
    })),
  };
}

/** Runs `work` in a savepoint, so a refused line rolls back on its own and the call carries on. */
async function inSavepoint<T>(tx: OrgTx, work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  await tx.query("savepoint ai_bank_line");
  try {
    const value = await work();
    await tx.query("release savepoint ai_bank_line");
    return { ok: true, value };
  } catch (error) {
    await tx.query("rollback to savepoint ai_bank_line");
    return { ok: false, error: lineErrorText(error) };
  }
}

type Reconciled = { created: boolean; line: StatementLine };

async function matchLine(tx: OrgTx, args: Record<string, unknown>, context: ToolContext, key: string): Promise<Reconciled> {
  const hasMatches = args.journalLineIds != null;
  const hasAllocations = args.allocations != null;
  if (hasMatches === hasAllocations) {
    throw new ValidationError("Give either journalLineIds (things already posted) or allocations (invoices or bills to pay), not both.");
  }
  return reconcileStatementLine(tx, args.lineId, {
    source: context.source,
    idempotencyKey: key,
    ...(hasMatches ? { kind: "match", journalLineIds: args.journalLineIds } : { kind: "payments", allocations: args.allocations }),
    ...(args.exchangeRate != null ? { exchangeRate: args.exchangeRate } : {}),
  });
}

async function createAndMatch(tx: OrgTx, args: Record<string, unknown>, context: ToolContext, key: string): Promise<Reconciled> {
  return reconcileStatementLine(tx, args.lineId, {
    source: context.source,
    idempotencyKey: key,
    kind: "bank_transaction",
    contactId: args.contactId,
    amountsMode: args.amountsMode,
    lines: args.lines,
    ...(args.reference != null ? { reference: args.reference } : {}),
    ...(args.exchangeRate != null ? { exchangeRate: args.exchangeRate } : {}),
  });
}

type TransferResult = Reconciled & { otherSide: { lineId: string; matched: true } | { matched: false; reason: string } };

/**
 * A transfer from the line (BK8), then the other account's own line for it
 * when there's exactly one unreconciled line there for the opposite amount on
 * the same day (AIB3). That second match is left for later if it's refused.
 */
async function transferAndMatch(tx: OrgTx, args: Record<string, unknown>, context: ToolContext, key: string): Promise<TransferResult> {
  const result = await reconcileStatementLine(tx, args.lineId, {
    source: context.source,
    idempotencyKey: key,
    kind: "transfer",
    otherAccountCode: args.otherAccountCode,
    ...(args.otherAmount != null ? { otherAmount: args.otherAmount } : {}),
    ...(args.reference != null ? { reference: args.reference } : {}),
  });
  const line = result.line;
  const journalId = line.reconciliation?.items[0]?.journalId;
  if (!journalId) return { ...result, otherSide: { matched: false, reason: "The transfer wasn't found." } };
  const other = await tx.query<{ journal_line_id: string; account_id: string }>(
    `select l.id::text as journal_line_id, l.account_id::text
       from ledger_journal_lines l join accounts a on a.id = l.account_id
      where l.journal_id = $1 and l.account_id <> $2 and a.account_type in ('bank', 'credit_card')
      order by l.id`,
    [journalId, line.accountId],
  );
  if (other.rows.length !== 1) return { ...result, otherSide: { matched: false, reason: "The transfer has no single line on the other account." } };
  const { journal_line_id: otherJournalLineId, account_id: otherAccountId } = other.rows[0];
  const already = await tx.query<{ statement_line_id: string }>(
    `select r.statement_line_id::text from bank_reconciliation_items i join bank_reconciliations r on r.id = i.reconciliation_id
      where i.journal_line_id = $1 and i.active`,
    [otherJournalLineId],
  );
  if (already.rows[0]) return { ...result, otherSide: { lineId: already.rows[0].statement_line_id, matched: true } };
  const opposite = toFixedString(neg(dec(line.amount)), 2);
  const candidates = await tx.query<{ id: string }>(
    `select b.id::text from bank_statement_lines b
      where b.account_id = $1 and b.status = 'unreconciled' and b.line_date = $2::date and b.amount = $3::numeric
      order by b.id limit 2`,
    [otherAccountId, line.date, opposite],
  );
  if (candidates.rows.length !== 1) {
    return {
      ...result,
      otherSide: {
        matched: false,
        reason:
          candidates.rows.length === 0
            ? `No unreconciled ${opposite} line on the other account on ${line.date} yet; match it to the transfer when it arrives.`
            : `More than one ${opposite} line on the other account on ${line.date}; choose which with match_bank_line.`,
      },
    };
  }
  const otherLineId = candidates.rows[0].id;
  const matched = await inSavepoint(tx, () =>
    reconcileStatementLine(tx, otherLineId, {
      source: context.source,
      idempotencyKey: `${key}:other`,
      kind: "match",
      journalLineIds: [otherJournalLineId],
    }),
  );
  return { ...result, otherSide: matched.ok ? { lineId: otherLineId, matched: true } : { matched: false, reason: matched.error } };
}

/** A rule's spend or receive money for a line, as OKing its suggestion does (BK10, BK18). */
async function applyRule(tx: OrgTx, lineId: string, ruleIdInput: unknown, context: ToolContext, key: string): Promise<Reconciled> {
  const line = await getStatementLine(tx, lineId);
  if (line.status !== "unreconciled") {
    // A retry of the same call finds the line reconciled with this key: the same answer as before.
    const replay = await tx.query("select 1 from bank_reconciliations where command_source = $1 and idempotency_key = $2 and statement_line_id = $3", [
      context.source,
      key,
      lineId,
    ]);
    if ((replay.rowCount ?? 0) > 0) return { created: false, line };
    throw new ConflictError(`This line is ${line.status}.`);
  }
  let rule: BankRule;
  if (ruleIdInput == null || ruleIdInput === "") {
    const fitting = (await suggestionsForLine(tx, lineId)).rule;
    if (!fitting) throw new ConflictError("No bank rule applies to this line.");
    rule = fitting;
  } else {
    rule = await getBankRule(tx, ruleIdInput);
    if (!ruleMatches(rule, line)) throw new ConflictError(`Bank rule "${rule.name}" doesn't apply to this line${rule.isActive ? "" : " (it's switched off)"}.`);
  }
  const lines = ruleLinesFor(rule, line);
  if (!lines) throw new ConflictError(`Bank rule "${rule.name}" can't split this line's amount.`);
  const contact = await ruleContact(tx, rule, line);
  if (!contact) throw new ConflictError(`No contact called "${line.payee ?? line.description}" for bank rule "${rule.name}". Use create_and_match with a contact.`);
  return reconcileStatementLine(tx, lineId, {
    source: context.source,
    idempotencyKey: key,
    kind: "bank_transaction",
    contactId: contact.id,
    amountsMode: ruleAmountsMode(lines),
    lines: lines.map((entry) => ({
      description: entry.description,
      accountCode: entry.accountCode,
      ...(entry.taxCode ? { taxCode: entry.taxCode } : {}),
      amount: entry.amount,
      ...(Object.keys(entry.tracking).length > 0 ? { tracking: entry.tracking } : {}),
    })),
  });
}

type UnmatchResult = { created: boolean; line: StatementLine; voided: { bankTransactionId: string } | { transferId: string } | null; otherLines: string[] };

/**
 * Undoes this key's own reconciliation of a line made in the last 24 hours
 * (AIB7, AIB8): the line is unreconciled (BK11) and, when the reconciliation
 * made a spend or receive money or a transfer, that's voided on the line's
 * date (Jess, 9 Oct 2026), after unreconciling the transfer's other side when
 * this key matched it too. Anything else is for a person.
 */
async function unmatchLine(tx: OrgTx, lineIdInput: unknown, context: ToolContext, key: string): Promise<UnmatchResult> {
  const lineId = requireId(lineIdInput, "lineId");
  const earlier = await tx.query<{ statement_line_id: string }>(
    "select statement_line_id::text from bank_reconciliations where removal_command_source = $1 and removal_idempotency_key = $2",
    [context.source, key],
  );
  if (earlier.rows[0]) {
    if (earlier.rows[0].statement_line_id !== lineId) throw new ConflictError("That idempotency key was already used to unmatch another line.");
    return { created: false, line: await getStatementLine(tx, lineId), voided: null, otherLines: [] };
  }
  await tx.query("select id from bank_statement_lines where id = $1 for update", [lineId]);
  const line = await getStatementLine(tx, lineId);
  const person = "A person must unreconcile it on the reconcile screen in Tohyee.";
  if (line.status !== "reconciled" || !line.reconciliation) throw new ConflictError("This line isn't reconciled.");
  const reconciliation = (
    await tx.query<{ command_source: string; kind: string; recent: boolean; split_id: string | null }>(
      `select command_source, kind, created_at > now() - make_interval(hours => $2) as recent, split_id::text
         from bank_reconciliations where id = $1`,
      [line.reconciliation.id, UNDO_HOURS],
    )
  ).rows[0];
  if (reconciliation.command_source !== context.source) {
    throw new ConflictError(`This line was reconciled by a person or another AI key, not this key. ${person}`);
  }
  if (!reconciliation.recent) throw new ConflictError(`This key reconciled this line more than ${UNDO_HOURS} hours ago. ${person}`);
  if (reconciliation.split_id) throw new ConflictError(`This line is part of a split. ${person}`);

  const journalId = line.reconciliation.items[0]?.journalId;
  let made: { kind: "bank_transaction" | "transfer"; id: string } | null = null;
  if (reconciliation.kind === "bank_transaction" || reconciliation.kind === "transfer") {
    const table = reconciliation.kind === "bank_transaction" ? "bank_transactions" : "bank_transfers";
    const found = await tx.query<{ id: string; status: string }>(`select id::text, status from ${table} where journal_id = $1`, [journalId]);
    if (!found.rows[0]) throw new ConflictError(`What this line was reconciled with wasn't found. ${person}`);
    if (found.rows[0].status === "posted") made = { kind: reconciliation.kind, id: found.rows[0].id };
  }

  // A transfer's other side: unreconciled too when this key matched it (AIB7); refused when someone else did (AIB8).
  const otherLines: string[] = [];
  if (made?.kind === "transfer") {
    const others = await tx.query<{ statement_line_id: string; command_source: string; recent: boolean }>(
      `select r.statement_line_id::text, r.command_source, r.created_at > now() - make_interval(hours => $3) as recent
         from bank_reconciliation_items i
         join bank_reconciliations r on r.id = i.reconciliation_id
         join ledger_journal_lines l on l.id = i.journal_line_id
        where i.active and l.journal_id = $1 and r.statement_line_id <> $2
        order by r.statement_line_id`,
      [journalId, lineId, UNDO_HOURS],
    );
    for (const other of others.rows) {
      if (other.command_source !== context.source || !other.recent) {
        throw new ConflictError(`The other side of this transfer was matched by someone else or more than ${UNDO_HOURS} hours ago. ${person}`);
      }
      await unreconcileStatementLine(tx, other.statement_line_id, { source: context.source, idempotencyKey: `${key}:other:${other.statement_line_id}` });
      otherLines.push(other.statement_line_id);
    }
  }

  const undone = await unreconcileStatementLine(tx, lineId, { source: context.source, idempotencyKey: key });
  let voided: UnmatchResult["voided"] = null;
  if (made?.kind === "bank_transaction") {
    await voidBankTransaction(tx, made.id, { source: context.source, idempotencyKey: `${key}:void`, voidDate: line.date });
    voided = { bankTransactionId: made.id };
  } else if (made?.kind === "transfer") {
    await voidTransfer(tx, made.id, { source: context.source, idempotencyKey: `${key}:void`, voidDate: line.date });
    voided = { transferId: made.id };
  }
  return { created: undone.created, line: await getStatementLine(tx, lineId), voided, otherLines };
}

const BULK_ACTIONS = ["match", "create_and_match", "transfer_and_match", "apply_bank_rule"] as const;

export const BANK_READ_TOOLS: readonly AiTool[] = [
  {
    name: "list_bank_accounts",
    title: "Bank accounts",
    level: "read",
    description:
      "Bank and credit card accounts with their statement balance (the last the bank gave), ledger balance (in the base currency) and how many statement lines are waiting to be reconciled.",
    inputSchema: schema({ includeArchived: { type: "boolean" } }),
    async run(tx, args) {
      const accounts = await listBankAccounts(tx, { includeArchived: args.includeArchived === true });
      return {
        accounts: accounts.map((account) => ({
          id: account.id,
          code: account.code,
          name: account.name,
          type: account.accountType,
          isActive: account.isActive,
          currencyCode: account.statementCurrency,
          statementBalance: account.statementBalance,
          statementBalanceAt: account.statementBalanceAt,
          ledgerBalance: account.ledgerBalance,
          unreconciledCount: account.unreconciledCount,
          lastLineDate: account.lastLineDate,
        })),
      };
    },
  },
  {
    name: "list_bank_lines",
    title: "Bank statement lines",
    level: "read",
    description:
      `Statement lines on one bank account: unreconciled lines oldest first (the order to work through them), otherwise newest first. Filter by status, dates and text or an exact amount (e.g. "-46.00"). At most ${MAX_LINES} at a time; use offset for the next page.`,
    inputSchema: schema(
      {
        accountId: ID("bank account (from list_bank_accounts)"),
        status: { type: "string", enum: ["unreconciled", "reconciled", "excluded", "all"], description: "Default unreconciled." },
        from: DATE,
        to: DATE,
        search: { type: "string", description: "Text in the description, or an exact signed amount." },
        limit: { type: "integer", minimum: 1, maximum: MAX_LINES, description: `Default 50, at most ${MAX_LINES}.` },
        offset: { type: "integer", minimum: 0 },
      },
      ["accountId"],
    ),
    async run(tx, args) {
      const result = await listStatementLines(tx, args.accountId, {
        status: args.status ?? "unreconciled",
        from: args.from,
        to: args.to,
        search: args.search,
        limit: boundedLimit(args.limit, 50, MAX_LINES),
        offset: args.offset,
      });
      return { lines: result.lines.map(lineSummary), total: result.total };
    },
  },
  {
    name: "get_bank_line",
    title: "One bank statement line",
    level: "read",
    description:
      "One statement line with what it's reconciled with, or, when it's unreconciled, what Tohyee suggests: posted transactions on its account it could match (exact amounts first), open invoices or bills for its exact amount, and the bank rule that applies.",
    inputSchema: schema({ lineId: ID("statement line") }, ["lineId"]),
    async run(tx, args) {
      const line = await getStatementLine(tx, args.lineId);
      if (line.status !== "unreconciled") return { line: lineSummary(line) };
      const suggestions = await suggestionsForLine(tx, line.id);
      return {
        line: lineSummary(line),
        suggestions: {
          matches: suggestions.matches,
          documents: suggestions.documents,
          rule: suggestions.rule
            ? {
                id: suggestions.rule.id,
                name: suggestions.rule.name,
                contactId: suggestions.rule.contactId,
                contactName: suggestions.rule.contactName,
                lines: suggestions.rule.suggestedLines,
                problem: suggestions.rule.problem,
              }
            : null,
        },
      };
    },
  },
  {
    name: "list_bank_rules",
    title: "Bank rules",
    level: "read",
    description: "Bank rules, in the order they're tried, with their conditions and what they code lines to. Switched-off rules are included, marked isActive false.",
    inputSchema: schema(),
    async run(tx) {
      return { rules: (await listBankRules(tx)).map(ruleSummary) };
    },
  },
  {
    name: "get_bank_rule",
    title: "One bank rule",
    level: "read",
    description: "One bank rule with its conditions and lines.",
    inputSchema: schema({ ruleId: ID("bank rule") }, ["ruleId"]),
    async run(tx, args) {
      return { rule: ruleSummary(await getBankRule(tx, args.ruleId)) };
    },
  },
  {
    name: "reconciliation_summary",
    title: "Reconciliation summary",
    level: "read",
    description:
      "For each active bank and credit card account: lines left to reconcile, the oldest one's date, and the difference between the statement balance and the ledger balance (only for accounts in the base currency with a statement balance).",
    inputSchema: schema(),
    async run(tx) {
      const accounts = (await listBankAccounts(tx)).filter((account) => account.isActive);
      const oldest = await tx.query<{ account_id: string; oldest: string }>(
        "select account_id::text, min(line_date)::text as oldest from bank_statement_lines where status = 'unreconciled' group by account_id",
      );
      const oldestBy = new Map(oldest.rows.map((row) => [row.account_id, row.oldest]));
      return {
        accounts: accounts.map((account) => ({
          id: account.id,
          code: account.code,
          name: account.name,
          currencyCode: account.statementCurrency,
          unreconciledCount: account.unreconciledCount,
          oldestUnreconciled: oldestBy.get(account.id) ?? null,
          statementBalance: account.statementBalance,
          statementBalanceAt: account.statementBalanceAt,
          ledgerBalance: account.isForeign ? null : account.ledgerBalance,
          difference:
            account.isForeign || account.statementBalance === null
              ? null
              : toFixedString(sub(dec(account.statementBalance), dec(account.ledgerBalance)), 2),
        })),
      };
    },
  },
];

const MATCH_FIELDS: Record<string, JsonSchema> = {
  lineId: ID("statement line"),
  journalLineIds: {
    type: "array",
    minItems: 1,
    maxItems: 50,
    items: { type: "string" },
    description: "Journal lines already posted on the line's bank account (get_bank_line's suggestions), adding up to the line exactly.",
  },
  allocations: ALLOCATIONS,
  exchangeRate: EXCHANGE_RATE,
};
const CREATE_FIELDS: Record<string, JsonSchema> = {
  lineId: ID("statement line"),
  contactId: { type: "string", description: "From list_contacts." },
  amountsMode: { type: "string", enum: ["inclusive", "exclusive", "no_tax"], description: "Whether the amounts include GST, exclude it, or have none." },
  lines: CODE_LINES,
  reference: { type: "string" },
  exchangeRate: EXCHANGE_RATE,
};
const TRANSFER_FIELDS: Record<string, JsonSchema> = {
  lineId: ID("statement line"),
  otherAccountCode: { type: "string", description: "The other bank or credit card account's code." },
  otherAmount: { type: "string", description: "Only when the other account is in another currency: the amount in its currency." },
  reference: { type: "string" },
};

export const BANK_WRITE_TOOLS: readonly AiTool[] = [
  {
    name: "match_bank_line",
    title: "Match a bank line",
    level: "full",
    description:
      "Reconciles an unreconciled statement line with things already posted on its account (journalLineIds: payments, transfers, spend or receive money, journals), which posts nothing, or by paying invoices (money in) or bills (money out) from it (allocations), which records the payments on the line's date. The total must equal the line exactly. Refused in a locked period.",
    inputSchema: schema({ ...MATCH_FIELDS, idempotencyKey: IDEMPOTENCY }, ["lineId"]),
    async run(tx, args, context) {
      const result = await matchLine(tx, args, context, idempotencyKey(args.idempotencyKey));
      return { created: result.created, line: lineSummary(result.line) };
    },
  },
  {
    name: "create_and_match",
    title: "Code a bank line",
    level: "full",
    description:
      "Posts spend money (money out) or receive money (money in) for an unreconciled statement line, dated the line's date, to the accounts, GST codes and contact given, and reconciles the line with it. The lines must add up to the line's amount. Refused in a locked period.",
    inputSchema: schema({ ...CREATE_FIELDS, idempotencyKey: IDEMPOTENCY }, ["lineId", "contactId", "amountsMode", "lines"]),
    async run(tx, args, context) {
      const result = await createAndMatch(tx, args, context, idempotencyKey(args.idempotencyKey));
      return { created: result.created, line: lineSummary(result.line) };
    },
  },
  {
    name: "transfer_and_match",
    title: "Record a transfer from a bank line",
    level: "full",
    description:
      "Records a transfer between the line's account and another bank or credit card account, dated the line's date, and reconciles the line with it. If the other account has exactly one unreconciled line for the opposite amount on the same day, that's matched too.",
    inputSchema: schema({ ...TRANSFER_FIELDS, idempotencyKey: IDEMPOTENCY }, ["lineId", "otherAccountCode"]),
    async run(tx, args, context) {
      const result = await transferAndMatch(tx, args, context, idempotencyKey(args.idempotencyKey));
      return { created: result.created, line: lineSummary(result.line), otherSide: result.otherSide };
    },
  },
  {
    name: "apply_bank_rule",
    title: "Apply a bank rule",
    level: "full",
    description: `Codes statement lines with a bank rule, as a person OKing the rule's suggestion does: spend or receive money for each line, reconciled. Without ruleId, each line's first rule that applies. Each line is done or refused on its own; at most ${MAX_BULK_LINES} lines.`,
    inputSchema: schema(
      {
        lineIds: { type: "array", minItems: 1, maxItems: MAX_BULK_LINES, items: { type: "string" } },
        ruleId: ID("bank rule"),
        idempotencyKey: IDEMPOTENCY,
      },
      ["lineIds"],
    ),
    async run(tx, args, context) {
      const key = idempotencyKey(args.idempotencyKey);
      const lineIds = [...new Set(requireArray(args.lineIds, "lineIds", MAX_BULK_LINES).map((id, index) => requireId(id, `lineIds[${index}]`)))];
      const results = [];
      for (const lineId of lineIds) {
        const done = await inSavepoint(tx, () => applyRule(tx, lineId, args.ruleId, context, `${key}:${lineId}`));
        results.push(done.ok ? { lineId, ok: true, created: done.value.created } : { lineId, ok: false, error: done.error });
      }
      const succeeded = results.filter((result) => result.ok).length;
      return { results, succeeded, failed: results.length - succeeded };
    },
  },
  {
    name: "bulk_reconcile",
    title: "Reconcile many bank lines",
    level: "full",
    description: `Up to ${MAX_BULK_LINES} reconciling actions in one call. Each has an action (match, create_and_match, transfer_and_match or apply_bank_rule) and that tool's fields. Each line is done or refused on its own, with the reason; the answer counts both. Retrying with the same idempotencyKey doesn't post anything twice.`,
    inputSchema: schema(
      {
        actions: {
          type: "array",
          minItems: 1,
          maxItems: MAX_BULK_LINES,
          items: {
            type: "object",
            properties: { action: { type: "string", enum: [...BULK_ACTIONS] }, ...MATCH_FIELDS, ...CREATE_FIELDS, ...TRANSFER_FIELDS, ruleId: ID("bank rule") },
            required: ["action", "lineId"],
          },
        },
        idempotencyKey: IDEMPOTENCY,
      },
      ["actions"],
    ),
    async run(tx, args, context) {
      const key = idempotencyKey(args.idempotencyKey);
      const actions = requireArray(args.actions, "actions", MAX_BULK_LINES).map((raw, index) => asRecord(raw, `Action ${index + 1}`));
      if (actions.length === 0) throw new ValidationError("Give at least one action.");
      const seen = new Set<string>();
      const results = [];
      for (const [index, action] of actions.entries()) {
        const label = `Action ${index + 1}`;
        const done = await inSavepoint(tx, async () => {
          const kind = requireOneOf(action.action, `${label} action`, BULK_ACTIONS);
          const lineId = requireId(action.lineId, `${label} lineId`);
          if (seen.has(lineId)) throw new ValidationError(`${label}: line ${lineId} is already in this call.`);
          seen.add(lineId);
          const lineKey = `${key}:${lineId}`;
          const fields = { ...action, lineId };
          if (kind === "match") return { kind, ...(await matchLine(tx, fields, context, lineKey)) };
          if (kind === "create_and_match") return { kind, ...(await createAndMatch(tx, fields, context, lineKey)) };
          if (kind === "transfer_and_match") return { kind, ...(await transferAndMatch(tx, fields, context, lineKey)) };
          return { kind, ...(await applyRule(tx, lineId, action.ruleId, context, lineKey)) };
        });
        results.push(
          done.ok
            ? {
                index,
                lineId: done.value.line.id,
                ok: true,
                created: done.value.created,
                ...("otherSide" in done.value ? { otherSide: done.value.otherSide } : {}),
              }
            : { index, lineId: typeof action.lineId === "string" ? action.lineId : null, ok: false, error: done.error },
        );
      }
      const succeeded = results.filter((result) => result.ok).length;
      return { results, succeeded, failed: results.length - succeeded };
    },
  },
  {
    name: "unmatch_bank_line",
    title: "Undo your own reconciliation",
    level: "full",
    description: `Unreconciles a line this same AI key reconciled in the last ${UNDO_HOURS} hours, in an unlocked period. If that made spend money, receive money or a transfer, it's reversed on the line's date, so the books are as they were. Anything else (a person's reconciliation, another key's, older ones) is refused: a person must do it in Tohyee.`,
    inputSchema: schema({ lineId: ID("statement line"), idempotencyKey: IDEMPOTENCY }, ["lineId"]),
    async run(tx, args, context) {
      const result = await unmatchLine(tx, args.lineId, context, idempotencyKey(args.idempotencyKey));
      return { created: result.created, line: lineSummary(result.line), reversed: result.voided, otherLinesUnreconciled: result.otherLines };
    },
  },
  {
    name: "create_bank_rule",
    title: "Make a bank rule",
    level: "full",
    description:
      "Makes a bank rule that suggests spend or receive money for lines it fits. It's switched on and only suggests: nothing posts until a line is reconciled. Check list_bank_rules first so you don't make the same rule twice.",
    inputSchema: schema(RULE_FIELDS, ["name", "conditions", "lines"]),
    async run(tx, args) {
      return { rule: ruleSummary(await createBankRule(tx, { ...ruleInput(args), isActive: true })) };
    },
  },
  {
    name: "update_bank_rule",
    title: "Edit a bank rule",
    level: "full",
    description:
      "Changes a bank rule. Send the whole rule as it should be (its conditions and lines replace the old ones). It stays switched on or off as it was; switching rules off and deleting them is for people.",
    inputSchema: schema({ ruleId: ID("bank rule"), ...RULE_FIELDS }, ["ruleId", "name", "conditions", "lines"]),
    async run(tx, args) {
      const current = await getBankRule(tx, args.ruleId);
      return { rule: ruleSummary(await updateBankRule(tx, current.id, { ...ruleInput(args), isActive: current.isActive })) };
    },
  },
];

/** Only the rule's own fields: never isActive (people switch rules off, #205). */
function ruleInput(args: Record<string, unknown>) {
  const { name, priority, accountId, direction, matchMode, conditions, contactMode, contactId, lines } = args;
  return { name, priority, accountId, direction, matchMode, conditions, contactMode, contactId, lines };
}
