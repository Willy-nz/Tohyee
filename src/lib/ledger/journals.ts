import { parseAccountCodeInput, resolveAccountsByCode } from "@/lib/accounts/service";
import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate, parseOptionalIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { assertPostingDateAllowed } from "@/lib/ledger/period-controls";
import { currencyMinorUnits, parseCurrencyCode } from "@/lib/money/currency";
import {
  add,
  cmp,
  dec,
  isPositive,
  parseDecimalInput,
  toFixedString,
  toPlainString,
  ZERO_DECIMAL,
} from "@/lib/money/decimal";
import {
  asRecord,
  optionalId,
  optionalSource,
  optionalString,
  requireArray,
  requireId,
  requireIdempotencyKey,
  requireString,
} from "@/lib/validation";

export type JournalOrigin = "manual" | "correction" | "inventory" | "fx_revaluation" | "invoice" | "customer_payment";
export type CorrectionKind = "reversal" | "replacement";

export type JournalLine = {
  lineOrder: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  description: string | null;
  debitAmount: string;
  creditAmount: string;
};

export type Journal = {
  id: string;
  commandSource: string;
  idempotencyKey: string;
  origin: JournalOrigin;
  postingDate: string;
  reference: string;
  description: string | null;
  currencyCode: string;
  totalDebit: string;
  totalCredit: string;
  relatedJournalId: string | null;
  correctionKind: CorrectionKind | null;
  createdByEmail: string | null;
  createdAt: string;
};

export type JournalWithLines = Journal & { lines: JournalLine[] };

type JournalRow = {
  id: string;
  command_source: string;
  idempotency_key: string;
  request_hash: string;
  origin: JournalOrigin;
  posting_date: string;
  reference: string;
  description: string | null;
  currency_code: string;
  total_debit: string;
  total_credit: string;
  related_journal_id: string | null;
  correction_kind: CorrectionKind | null;
  created_by_email: string | null;
  created_at: string;
};

const JOURNAL_COLUMNS = `id, command_source, idempotency_key, request_hash, origin, posting_date,
  reference, description, currency_code, total_debit, total_credit, related_journal_id,
  correction_kind, created_by_email, created_at`;

function toJournal(row: JournalRow): Journal {
  return {
    id: row.id,
    commandSource: row.command_source,
    idempotencyKey: row.idempotency_key,
    origin: row.origin,
    postingDate: row.posting_date,
    reference: row.reference,
    description: row.description,
    currencyCode: row.currency_code,
    totalDebit: row.total_debit,
    totalCredit: row.total_credit,
    relatedJournalId: row.related_journal_id,
    correctionKind: row.correction_kind,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
}

export type JournalBody = {
  postingDate: string;
  reference: string;
  description: string | null;
  currencyCode: string;
  lines: Array<{
    accountCode: string;
    debit: string;
    credit: string;
    description: string | null;
  }>;
  total: string;
};

const MAX_LINES = 500;

/**
 * Validates a journal's content: base currency only, amounts limited to the
 * currency's minor units (cents for NZD), each line either a debit or a
 * credit, at least two lines, and debits equal to credits. Account codes are
 * checked separately against the chart of accounts.
 */
export function parseJournalBody(
  tx: Pick<OrgTx, "baseCurrency">,
  input: {
    postingDate: unknown;
    reference: unknown;
    description?: unknown;
    currencyCode?: unknown;
    lines: unknown;
  },
): JournalBody {
  const postingDate = parseIsoDate(input.postingDate, "postingDate");
  const reference = requireString(input.reference, "reference", { maxLength: 100 });
  const description = optionalString(input.description, "description", { maxLength: 500 });
  const currencyCode =
    input.currencyCode == null || input.currencyCode === ""
      ? tx.baseCurrency
      : parseCurrencyCode(input.currencyCode);
  if (currencyCode !== tx.baseCurrency) {
    throw new ValidationError(
      `Journals are posted in this organisation's base currency (${tx.baseCurrency}). Foreign-currency transactions aren't supported yet; convert the amounts first.`,
    );
  }
  const scale = currencyMinorUnits(currencyCode);

  const rawLines = requireArray(input.lines, "lines", MAX_LINES);
  if (rawLines.length < 2) {
    throw new ValidationError("A journal needs at least two lines.");
  }

  let debitTotal = ZERO_DECIMAL;
  let creditTotal = ZERO_DECIMAL;
  const lines = rawLines.map((raw, index) => {
    const label = `Line ${index + 1}`;
    const line = asRecord(raw, label);
    const accountCode = parseAccountCodeInput(line.accountCode, `${label} account`);
    const debit =
      line.debitAmount == null || line.debitAmount === ""
        ? "0"
        : parseDecimalInput(line.debitAmount, `${label} debit`, { maxScale: scale, allowZero: true });
    const credit =
      line.creditAmount == null || line.creditAmount === ""
        ? "0"
        : parseDecimalInput(line.creditAmount, `${label} credit`, { maxScale: scale, allowZero: true });
    const hasDebit = isPositive(dec(debit));
    const hasCredit = isPositive(dec(credit));
    if (hasDebit === hasCredit) {
      throw new ValidationError(`${label} needs either a debit or a credit amount (not both).`);
    }
    debitTotal = add(debitTotal, dec(debit));
    creditTotal = add(creditTotal, dec(credit));
    return {
      accountCode,
      // Stored with exactly the currency's minor units, e.g. "115.00".
      debit: toFixedString(dec(debit), scale),
      credit: toFixedString(dec(credit), scale),
      description: optionalString(line.description, `${label} description`, { maxLength: 200 }),
    };
  });

  if (cmp(debitTotal, creditTotal) !== 0) {
    throw new ValidationError(
      `The journal doesn't balance: debits ${toPlainString(debitTotal)}, credits ${toPlainString(creditTotal)}.`,
    );
  }

  return {
    postingDate,
    reference,
    description,
    currencyCode,
    lines,
    total: toFixedString(debitTotal, scale),
  };
}

type PostOptions = {
  origin: JournalOrigin;
  relatedJournalId?: string | null;
  correctionKind?: CorrectionKind | null;
};

function journalHash(body: JournalBody, options: PostOptions): string {
  return requestHash("journal", {
    postingDate: body.postingDate,
    reference: body.reference,
    description: body.description,
    currencyCode: body.currencyCode,
    lines: body.lines.map((line) => ({
      account: line.accountCode.toLowerCase(),
      debit: line.debit,
      credit: line.credit,
      description: line.description,
    })),
    origin: options.origin,
    relatedJournalId: options.relatedJournalId ?? null,
    correctionKind: options.correctionKind ?? null,
  });
}

async function findJournalByKey(
  tx: OrgTx,
  commandSource: string,
  idempotencyKey: string,
): Promise<JournalRow | null> {
  const result = await tx.query<JournalRow>(
    `select ${JOURNAL_COLUMNS} from ledger_journals
      where command_source = $1 and idempotency_key = $2`,
    [commandSource, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

export async function getJournal(tx: OrgTx, journalId: string): Promise<JournalWithLines> {
  const result = await tx.query<JournalRow>(
    `select ${JOURNAL_COLUMNS} from ledger_journals where id = $1`,
    [journalId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError(`Journal #${journalId} not found.`);
  }
  const lines = await tx.query<{
    line_order: number;
    account_id: string;
    code: string;
    name: string;
    description: string | null;
    debit_amount: string;
    credit_amount: string;
  }>(
    `select l.line_order, l.account_id, a.code, a.name, l.description, l.debit_amount, l.credit_amount
       from ledger_journal_lines l
       join accounts a on a.id = l.account_id
      where l.journal_id = $1
      order by l.line_order`,
    [journalId],
  );
  return {
    ...toJournal(row),
    lines: lines.rows.map((line) => ({
      lineOrder: line.line_order,
      accountId: line.account_id,
      accountCode: line.code,
      accountName: line.name,
      description: line.description,
      debitAmount: line.debit_amount,
      creditAmount: line.credit_amount,
    })),
  };
}

export type PostResult = { created: boolean; journal: JournalWithLines };

/**
 * Posts a validated journal exactly once per (commandSource, idempotencyKey).
 * A retry with the same key and the same content returns the original journal;
 * the same key with different content is refused. The existing-key check runs
 * first, so a retry still succeeds after the period has since been locked.
 */
export async function postJournalBody(
  tx: OrgTx,
  commandSource: string,
  idempotencyKey: string,
  body: JournalBody,
  options: PostOptions,
): Promise<PostResult> {
  const hash = journalHash(body, options);
  const existing = await findJournalByKey(tx, commandSource, idempotencyKey);
  if (existing) {
    assertSameRequest(existing.request_hash, hash, "journal");
    return { created: false, journal: await getJournal(tx, existing.id) };
  }

  const accounts = await resolveAccountsByCode(
    tx,
    body.lines.map((line) => line.accountCode),
  );
  await assertPostingDateAllowed(tx, body.postingDate);

  const inserted = await tx.query<{ id: string }>(
    `insert into ledger_journals (
       command_source, idempotency_key, request_hash, origin, posting_date, reference,
       description, currency_code, total_debit, total_credit, related_journal_id,
       correction_kind, created_by_user_id, created_by_email
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $9::numeric, $10, $11, $12, $13)
     on conflict (command_source, idempotency_key) do nothing
     returning id`,
    [
      commandSource,
      idempotencyKey,
      hash,
      options.origin,
      body.postingDate,
      body.reference,
      body.description,
      body.currencyCode,
      body.total,
      options.relatedJournalId ?? null,
      options.correctionKind ?? null,
      tx.actor.userId,
      tx.actor.email,
    ],
  );
  const journalId = inserted.rows[0]?.id;
  if (!journalId) {
    // Another request with the same key committed first.
    const winner = await findJournalByKey(tx, commandSource, idempotencyKey);
    if (!winner) {
      throw new ConflictError("That journal is being posted by another request. Try again.");
    }
    assertSameRequest(winner.request_hash, hash, "journal");
    return { created: false, journal: await getJournal(tx, winner.id) };
  }

  const values: unknown[] = [];
  const tuples = body.lines.map((line, index) => {
    const account = accounts.get(line.accountCode)!;
    values.push(journalId, index + 1, account.id, line.description, line.debit, line.credit);
    const base = index * 6;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::numeric, $${base + 6}::numeric)`;
  });
  await tx.query(
    `insert into ledger_journal_lines (journal_id, line_order, account_id, description, debit_amount, credit_amount)
     values ${tuples.join(", ")}`,
    values,
  );

  await writeAuditEvent(tx, {
    eventType: "ledger.journal_posted",
    entityType: "ledger_journal",
    entityId: journalId,
    details: {
      origin: options.origin,
      postingDate: body.postingDate,
      reference: body.reference,
      total: body.total,
      commandSource,
      idempotencyKey,
    },
  });

  return { created: true, journal: await getJournal(tx, journalId) };
}

/** Manual journal from the API. */
export async function postJournal(
  tx: OrgTx,
  command: {
    source?: unknown;
    idempotencyKey: unknown;
    postingDate: unknown;
    reference: unknown;
    description?: unknown;
    currencyCode?: unknown;
    lines: unknown;
  },
): Promise<PostResult> {
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const body = parseJournalBody(tx, command);
  return postJournalBody(tx, source, idempotencyKey, body, { origin: "manual" });
}

export type JournalListFilters = {
  postingDateFrom?: unknown;
  postingDateTo?: unknown;
  referenceQuery?: unknown;
  kind?: unknown;
  beforeId?: unknown;
  limit?: unknown;
};

export async function listJournals(
  tx: OrgTx,
  filters: JournalListFilters = {},
): Promise<{ journals: Journal[]; nextBeforeId: string | null }> {
  const from = parseOptionalIsoDate(filters.postingDateFrom, "postingDateFrom");
  const to = parseOptionalIsoDate(filters.postingDateTo, "postingDateTo");
  if (from && to && from > to) {
    throw new ValidationError("postingDateFrom must be on or before postingDateTo.");
  }
  const referenceQuery = optionalString(filters.referenceQuery, "referenceQuery", { maxLength: 100 });
  const kind = optionalString(filters.kind, "kind", { maxLength: 20 });
  const origins = ["manual", "inventory", "fx_revaluation", "invoice", "customer_payment"];
  const validKinds = ["primary", "reversal", "replacement", ...origins];
  if (kind && !validKinds.includes(kind)) {
    throw new ValidationError(`kind must be one of: ${validKinds.join(", ")}.`);
  }
  const beforeId = optionalId(filters.beforeId, "beforeId");
  const limitRaw = Number(filters.limit ?? 50);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 50;

  const conditions: string[] = [];
  const values: unknown[] = [];
  const param = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (from) conditions.push(`posting_date >= ${param(from)}`);
  if (to) conditions.push(`posting_date <= ${param(to)}`);
  if (referenceQuery) {
    conditions.push(`reference ilike ${param(`%${referenceQuery.replace(/[\\%_]/g, "\\$&")}%`)}`);
  }
  if (kind === "primary") conditions.push("correction_kind is null");
  if (kind === "reversal" || kind === "replacement") conditions.push(`correction_kind = ${param(kind)}`);
  if (kind && origins.includes(kind)) {
    conditions.push(`origin = ${param(kind)}`);
  }
  if (beforeId) conditions.push(`id < ${param(beforeId)}`);

  const result = await tx.query<JournalRow>(
    `select ${JOURNAL_COLUMNS} from ledger_journals
      ${conditions.length ? `where ${conditions.join(" and ")}` : ""}
      order by id desc
      limit ${limit + 1}`,
    values,
  );
  const rows = result.rows.slice(0, limit);
  return {
    journals: rows.map(toJournal),
    nextBeforeId: result.rows.length > limit ? rows[rows.length - 1].id : null,
  };
}

export async function getJournalDetails(tx: OrgTx, journalIdInput: unknown) {
  const journalId = requireId(journalIdInput, "journalId");
  const journal = await getJournal(tx, journalId);
  const parent = journal.relatedJournalId
    ? toJournal(
        (
          await tx.query<JournalRow>(`select ${JOURNAL_COLUMNS} from ledger_journals where id = $1`, [
            journal.relatedJournalId,
          ])
        ).rows[0],
      )
    : null;
  const corrections = await tx.query<JournalRow>(
    `select ${JOURNAL_COLUMNS} from ledger_journals where related_journal_id = $1 order by id`,
    [journalId],
  );
  const correctionJournals = corrections.rows.map(toJournal);
  const reversedBy = correctionJournals.find((entry) => entry.correctionKind === "reversal") ?? null;
  return {
    journal,
    parentJournal: parent,
    correctionJournals,
    canCorrect: canBeCorrected(journal, reversedBy !== null),
  };
}

function canBeCorrected(journal: Journal, alreadyReversed: boolean): boolean {
  return (
    !alreadyReversed &&
    journal.correctionKind !== "reversal" &&
    journal.origin !== "inventory" &&
    journal.origin !== "fx_revaluation" &&
    journal.origin !== "invoice" &&
    journal.origin !== "customer_payment"
  );
}

/**
 * Corrects a posted journal without editing it: posts a reversal of the
 * original and a replacement, both dated `postingDate` (which must be in an
 * open period). A replacement can itself be corrected later. Journals created
 * by stock movements, FX revaluations, sales invoices or customer payments must
 * be corrected at their source, so those records and the ledger stay in step.
 */
export async function correctJournal(
  tx: OrgTx,
  command: {
    source?: unknown;
    idempotencyKey: unknown;
    originalJournalId: unknown;
    postingDate: unknown;
    reference: unknown;
    description?: unknown;
    lines: unknown;
  },
) {
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const originalId = requireId(command.originalJournalId, "originalJournalId");
  const original = await getJournal(tx, originalId);

  if (original.origin === "inventory") {
    throw new ValidationError(
      `Journal #${original.id} was created by a stock movement. Correct it with a stock adjustment or return, so the stock records stay in step with the ledger.`,
    );
  }
  if (original.origin === "fx_revaluation") {
    throw new ValidationError(
      `Journal #${original.id} was created by an FX revaluation and can't be corrected here.`,
    );
  }
  if (original.origin === "invoice") {
    throw new ValidationError(
      `Journal #${original.id} was posted by a sales invoice (${original.reference}), so it can't be corrected in the ledger. To cancel an approved invoice, void it.`,
    );
  }
  if (original.origin === "customer_payment") {
    throw new ValidationError(
      `Journal #${original.id} was posted by a customer payment (${original.reference}), so it can't be corrected in the ledger. To undo a payment, void it from its invoice.`,
    );
  }
  if (original.correctionKind === "reversal") {
    throw new ValidationError("A reversal can't itself be corrected. Correct the replacement journal instead.");
  }

  const commandSource = `correction:${source}`;
  const reversalKey = `${idempotencyKey}:reversal`;
  const replacementKey = `${idempotencyKey}:replacement`;

  const existingReversal = await tx.query<{ id: string; command_source: string; idempotency_key: string }>(
    `select id, command_source, idempotency_key from ledger_journals
      where related_journal_id = $1 and correction_kind = 'reversal'`,
    [originalId],
  );
  const reversalRow = existingReversal.rows[0];
  if (
    reversalRow &&
    (reversalRow.command_source !== commandSource || reversalRow.idempotency_key !== reversalKey)
  ) {
    throw new ConflictError(
      `Journal #${original.id} has already been corrected (reversed by journal #${reversalRow.id}).`,
    );
  }

  const reversalBody = parseJournalBody(tx, {
    postingDate: command.postingDate,
    reference: `REV-${original.reference}`.slice(0, 100),
    description: `Reversal of journal #${original.id}`,
    currencyCode: original.currencyCode,
    lines: original.lines.map((line) => ({
      accountCode: line.accountCode,
      debitAmount: line.creditAmount,
      creditAmount: line.debitAmount,
      description: line.description,
    })),
  });
  const replacementBody = parseJournalBody(tx, {
    postingDate: command.postingDate,
    reference: command.reference,
    description: command.description,
    currencyCode: original.currencyCode,
    lines: command.lines,
  });

  const reversal = await postJournalBody(tx, commandSource, reversalKey, reversalBody, {
    origin: "correction",
    relatedJournalId: originalId,
    correctionKind: "reversal",
  });
  const replacement = await postJournalBody(tx, commandSource, replacementKey, replacementBody, {
    origin: "correction",
    relatedJournalId: originalId,
    correctionKind: "replacement",
  });

  if (reversal.created || replacement.created) {
    await writeAuditEvent(tx, {
      eventType: "ledger.journal_corrected",
      entityType: "ledger_journal",
      entityId: originalId,
      details: {
        reversalJournalId: reversal.journal.id,
        replacementJournalId: replacement.journal.id,
        postingDate: replacementBody.postingDate,
      },
    });
  }

  return {
    created: reversal.created || replacement.created,
    originalJournal: original,
    reversalJournal: reversal.journal,
    replacementJournal: replacement.journal,
  };
}
