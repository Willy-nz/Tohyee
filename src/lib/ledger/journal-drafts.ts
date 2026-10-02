import { resolveAccountsByCode } from "@/lib/accounts/service";
import { writeAuditEvent } from "@/lib/audit";
import type { CustomValues } from "@/lib/custom-fields/values";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { getJournal, type JournalBody, type JournalWithLines, parseJournalBody, postJournal } from "@/lib/ledger/journals";
import { currencyMinorUnits } from "@/lib/money/currency";
import { dec, toFixedString, toPlainString } from "@/lib/money/decimal";
import type { TrackingTags } from "@/lib/tracking/service";
import { optionalSource, requireId, requireIdempotencyKey, requireOneOf } from "@/lib/validation";

/**
 * Draft manual journals (examples MJD1-MJD9, decisions 349-352), like Xero's
 * draft manual journals. A draft posts nothing. Saving checks it the way a
 * journal is checked before it posts (at least two lines, each a debit or a
 * credit, debits equal to credits, active accounts); the checks that depend
 * on when it posts (the period being open, tracking and custom fields, the
 * inventory account, foreign amounts) run when it's posted, through the same
 * path as any manual journal. Posting links the journal; a posted draft
 * can't change or be deleted (the database refuses it too).
 */

export const DRAFT_STATUSES = ["draft", "posted"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export type JournalDraftLine = {
  lineOrder: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  description: string | null;
  debitAmount: string;
  creditAmount: string;
  tracking: TrackingTags;
  customFields: CustomValues;
  /** Typed for a line on a foreign-currency account; checked when posted. */
  foreignAmount: string | null;
  exchangeRate: string | null;
};

export type JournalDraft = {
  id: string;
  status: DraftStatus;
  postingDate: string;
  reference: string;
  description: string | null;
  total: string;
  customFields: CustomValues;
  createdByEmail: string;
  /** e.g. 'AI key "Claude on my laptop"' when an AI key made it. */
  createdVia: string | null;
  createdAt: string;
  updatedByEmail: string | null;
  updatedVia: string | null;
  updatedAt: string;
  postedJournalId: string | null;
  postedByEmail: string | null;
  postedVia: string | null;
  postedAt: string | null;
};

export type JournalDraftWithLines = JournalDraft & { lines: JournalDraftLine[] };

type DraftRow = {
  id: string;
  command_source: string;
  idempotency_key: string;
  request_hash: string;
  status: DraftStatus;
  posting_date: string;
  reference: string;
  description: string | null;
  total: string;
  custom_fields: CustomValues;
  created_by_email: string;
  created_via: string | null;
  created_at: string;
  updated_by_email: string | null;
  updated_via: string | null;
  updated_at: string;
  posted_journal_id: string | null;
  posted_by_email: string | null;
  posted_via: string | null;
  posted_at: string | null;
};

const DRAFT_COLUMNS = `id::text, command_source, idempotency_key, request_hash, status, posting_date::text, reference, description,
  total::text, custom_fields, created_by_email, created_via, created_at, updated_by_email, updated_via, updated_at,
  posted_journal_id::text, posted_by_email, posted_via, posted_at`;

function toDraft(row: DraftRow): JournalDraft {
  return {
    id: row.id,
    status: row.status,
    postingDate: row.posting_date,
    reference: row.reference,
    description: row.description,
    total: row.total,
    customFields: row.custom_fields ?? {},
    createdByEmail: row.created_by_email,
    createdVia: row.created_via,
    createdAt: row.created_at,
    updatedByEmail: row.updated_by_email,
    updatedVia: row.updated_via,
    updatedAt: row.updated_at,
    postedJournalId: row.posted_journal_id,
    postedByEmail: row.posted_by_email,
    postedVia: row.posted_via,
    postedAt: row.posted_at,
  };
}

export type JournalDraftInput = {
  postingDate: unknown;
  reference: unknown;
  description?: unknown;
  lines: unknown;
  customFields?: unknown;
};

function label(draft: { id: string; reference: string }): string {
  return `Draft journal #${draft.id} (${draft.reference})`;
}

/** Parses and checks a draft's content the way a journal is checked (balanced, active accounts). */
async function parseDraft(tx: OrgTx, input: JournalDraftInput): Promise<{ body: JournalBody; accountIds: string[] }> {
  const body = parseJournalBody(tx, {
    postingDate: input.postingDate,
    reference: input.reference,
    description: input.description,
    lines: input.lines,
    customFields: input.customFields,
  });
  const accounts = await resolveAccountsByCode(
    tx,
    body.lines.map((line) => line.accountCode),
  );
  return { body, accountIds: body.lines.map((line) => accounts.get(line.accountCode)!.id) };
}

function draftHash(body: JournalBody): string {
  return requestHash("journal_draft", {
    postingDate: body.postingDate,
    reference: body.reference,
    description: body.description,
    lines: body.lines.map((line) => ({
      account: line.accountCode.toLowerCase(),
      debit: line.debit,
      credit: line.credit,
      description: line.description,
      tracking: line.tracking,
      customFields: line.customInput ?? {},
      foreign: line.foreign ? { amount: line.foreign.amount, rate: line.foreign.rate } : null,
    })),
    customFields: body.customInput ?? {},
  });
}

async function writeLines(tx: OrgTx, draftId: string, body: JournalBody, accountIds: string[]): Promise<void> {
  for (const [index, line] of body.lines.entries()) {
    await tx.query(
      `insert into ledger_journal_draft_lines
         (draft_id, line_order, account_id, description, debit_amount, credit_amount, tracking, custom_fields, foreign_amount, exchange_rate)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
      [
        draftId,
        index + 1,
        accountIds[index],
        line.description,
        line.debit,
        line.credit,
        JSON.stringify(line.tracking),
        JSON.stringify(line.customInput ?? {}),
        line.foreign?.amount ?? null,
        line.foreign?.rate ?? null,
      ],
    );
  }
}

async function loadDraftRow(tx: OrgTx, draftIdInput: unknown, options: { lock?: boolean } = {}): Promise<DraftRow> {
  const draftId = requireId(draftIdInput, "draftId");
  const result = await tx.query<DraftRow>(
    `select ${DRAFT_COLUMNS} from ledger_journal_drafts where id = $1${options.lock ? " for update" : ""}`,
    [draftId],
  );
  if (!result.rows[0]) throw new NotFoundError(`Draft journal #${draftId} not found.`);
  return result.rows[0];
}

export async function getJournalDraft(tx: OrgTx, draftIdInput: unknown): Promise<JournalDraftWithLines> {
  const row = await loadDraftRow(tx, draftIdInput);
  const lines = await tx.query<{
    line_order: number;
    account_id: string;
    code: string;
    name: string;
    description: string | null;
    debit_amount: string;
    credit_amount: string;
    tracking: TrackingTags;
    custom_fields: CustomValues;
    foreign_amount: string | null;
    exchange_rate: string | null;
  }>(
    `select l.line_order, l.account_id::text, a.code, a.name, l.description, l.debit_amount::text, l.credit_amount::text,
            l.tracking, l.custom_fields, l.foreign_amount::text, l.exchange_rate::text
       from ledger_journal_draft_lines l join accounts a on a.id = l.account_id
      where l.draft_id = $1 order by l.line_order`,
    [row.id],
  );
  const scale = currencyMinorUnits(tx.baseCurrency);
  return {
    ...toDraft(row),
    total: toFixedString(dec(row.total), scale),
    lines: lines.rows.map((line) => ({
      lineOrder: line.line_order,
      accountId: line.account_id,
      accountCode: line.code,
      accountName: line.name,
      description: line.description,
      debitAmount: toFixedString(dec(line.debit_amount), scale),
      creditAmount: toFixedString(dec(line.credit_amount), scale),
      tracking: line.tracking ?? {},
      customFields: line.custom_fields ?? {},
      foreignAmount: line.foreign_amount === null ? null : toPlainString(dec(line.foreign_amount)),
      exchangeRate: line.exchange_rate === null ? null : toPlainString(dec(line.exchange_rate)),
    })),
  };
}

/** Drafts, newest first; `status` filters (draft or posted). At most `limit` (default 50, max 200). */
export async function listJournalDrafts(tx: OrgTx, filters: { status?: unknown; limit?: unknown } = {}): Promise<JournalDraft[]> {
  const status = filters.status == null || filters.status === "" ? null : requireOneOf(filters.status, "status", DRAFT_STATUSES);
  const limitRaw = Number(filters.limit ?? 50);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 50;
  const result = await tx.query<DraftRow>(
    `select ${DRAFT_COLUMNS} from ledger_journal_drafts
      where ($1::text is null or status = $1)
      order by id desc limit ${limit}`,
    [status],
  );
  const scale = currencyMinorUnits(tx.baseCurrency);
  return result.rows.map((row) => ({ ...toDraft(row), total: toFixedString(dec(row.total), scale) }));
}

/** Saves a new draft. Posts nothing (MJD1). Retrying with the same key returns the same draft. */
export async function createJournalDraft(
  tx: OrgTx,
  command: JournalDraftInput & { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; draft: JournalDraftWithLines }> {
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const { body, accountIds } = await parseDraft(tx, command);
  const hash = draftHash(body);
  const existing = await tx.query<{ id: string; request_hash: string }>(
    "select id::text, request_hash from ledger_journal_drafts where command_source = $1 and idempotency_key = $2",
    [source, idempotencyKey],
  );
  if (existing.rows[0]) {
    assertSameRequest(existing.rows[0].request_hash, hash, "draft journal");
    return { created: false, draft: await getJournalDraft(tx, existing.rows[0].id) };
  }
  const inserted = await tx.query<{ id: string }>(
    `insert into ledger_journal_drafts
       (command_source, idempotency_key, request_hash, posting_date, reference, description, custom_fields, total,
        created_by_user_id, created_by_email, created_via)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
     returning id::text`,
    [
      source,
      idempotencyKey,
      hash,
      body.postingDate,
      body.reference,
      body.description,
      JSON.stringify(body.customInput ?? {}),
      body.total,
      tx.actor.userId,
      tx.actor.email,
      tx.actor.via ?? null,
    ],
  );
  const draftId = inserted.rows[0].id;
  await writeLines(tx, draftId, body, accountIds);
  await writeAuditEvent(tx, {
    eventType: "journal_draft.created",
    entityType: "journal_draft",
    entityId: draftId,
    details: { reference: body.reference, postingDate: body.postingDate, total: body.total },
  });
  return { created: true, draft: await getJournalDraft(tx, draftId) };
}

/** Replaces a draft's date, reference, description and lines (MJD3). Refused once it's posted (MJD5). */
export async function updateJournalDraft(tx: OrgTx, draftIdInput: unknown, input: JournalDraftInput): Promise<JournalDraftWithLines> {
  const row = await loadDraftRow(tx, draftIdInput, { lock: true });
  if (row.status !== "draft") {
    throw new ConflictError(`${label(row)} has been posted as journal #${row.posted_journal_id}, so it can't be changed. Correct the journal instead.`);
  }
  const { body, accountIds } = await parseDraft(tx, input);
  await tx.query("delete from ledger_journal_draft_lines where draft_id = $1", [row.id]);
  await tx.query(
    `update ledger_journal_drafts
        set posting_date = $2, reference = $3, description = $4, custom_fields = $5::jsonb, total = $6,
            updated_by_email = $7, updated_via = $8, updated_at = now()
      where id = $1`,
    [row.id, body.postingDate, body.reference, body.description, JSON.stringify(body.customInput ?? {}), body.total, tx.actor.email, tx.actor.via ?? null],
  );
  await writeLines(tx, row.id, body, accountIds);
  await writeAuditEvent(tx, {
    eventType: "journal_draft.updated",
    entityType: "journal_draft",
    entityId: row.id,
    details: { reference: body.reference, postingDate: body.postingDate, total: body.total },
  });
  return getJournalDraft(tx, row.id);
}

/**
 * Posts a draft (MJD4, MJD5): one manual journal through postJournal, so the
 * usual checks apply (balanced, open period, active accounts, tracking,
 * custom fields, foreign amounts). Exactly once: the journal's idempotency
 * key is the draft's id, the draft row is locked, and posting a posted draft
 * returns its journal. A refusal leaves the draft as it was (MJD6).
 */
export async function postJournalDraft(
  tx: OrgTx,
  draftIdInput: unknown,
): Promise<{ created: boolean; draft: JournalDraftWithLines; journal: JournalWithLines }> {
  const row = await loadDraftRow(tx, draftIdInput, { lock: true });
  if (row.status === "posted") {
    return { created: false, draft: await getJournalDraft(tx, row.id), journal: await getJournal(tx, row.posted_journal_id!) };
  }
  const draft = await getJournalDraft(tx, row.id);
  const posted = await postJournal(tx, {
    source: "journal-draft",
    idempotencyKey: `journal-draft-${draft.id}`,
    postingDate: draft.postingDate,
    reference: draft.reference,
    description: draft.description,
    customFields: draft.customFields,
    lines: draft.lines.map((line) => ({
      accountCode: line.accountCode,
      description: line.description,
      debitAmount: line.debitAmount,
      creditAmount: line.creditAmount,
      tracking: line.tracking,
      customFields: line.customFields,
      foreignAmount: line.foreignAmount,
      exchangeRate: line.exchangeRate,
    })),
  });
  await tx.query(
    `update ledger_journal_drafts
        set status = 'posted', posted_journal_id = $2, posted_by_email = $3, posted_via = $4, posted_at = now()
      where id = $1`,
    [draft.id, posted.journal.id, tx.actor.email, tx.actor.via ?? null],
  );
  await writeAuditEvent(tx, {
    eventType: "journal_draft.posted",
    entityType: "journal_draft",
    entityId: draft.id,
    details: { reference: draft.reference, journalId: posted.journal.id, total: draft.total },
  });
  return { created: true, draft: await getJournalDraft(tx, draft.id), journal: posted.journal };
}

/** Deletes a draft that hasn't been posted (MJD7). People only: AI keys never delete (decision 347). */
export async function deleteJournalDraft(tx: OrgTx, draftIdInput: unknown): Promise<void> {
  const row = await loadDraftRow(tx, draftIdInput, { lock: true });
  if (row.status !== "draft") {
    throw new ConflictError(`${label(row)} has been posted as journal #${row.posted_journal_id}, so it can't be deleted. Correct the journal instead.`);
  }
  await tx.query("delete from ledger_journal_drafts where id = $1", [row.id]);
  await writeAuditEvent(tx, {
    eventType: "journal_draft.deleted",
    entityType: "journal_draft",
    entityId: row.id,
    details: { reference: row.reference, postingDate: row.posting_date },
  });
}
