import { createHash } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { addStatementLines, lockStatementAccount, type AddLinesResult } from "@/lib/bank/accounts";
import { RowError } from "@/lib/bank/formats/common";
import {
  detectFormat,
  MAX_STATEMENT_FILE_BYTES,
  parseLayout,
  readStatementFile,
  type ParsedStatementLine,
  type StatementFile,
  type StatementFormat,
  type TableLayout,
} from "@/lib/bank/formats";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { optionalSource, requireId, requireIdempotencyKey, requireString } from "@/lib/validation";

/**
 * Importing statement files into a bank or credit card account (examples
 * BK1-BK3, BK12): CSV, Excel (.xlsx), OFX/QFX/QBO, QIF, CAMT.053 and MT940.
 * A preview reads the file and says what would be added without changing
 * anything; the import adds the new lines in one go. Nothing is posted.
 */
export type StatementImport = {
  id: string;
  accountId: string;
  source: "file" | "akahu" | "simplefin" | "stripe" | "paypal" | "wise";
  fileName: string | null;
  fileFormat: StatementFormat | "akahu" | "simplefin" | "stripe" | "paypal" | "wise";
  /** Brought in by a folder or mailbox feed (BF1, BF7) rather than by hand. */
  fileFeed: "folder" | "mailbox" | null;
  lineCount: number;
  duplicateCount: number;
  possibleDuplicateCount: number;
  status: "active" | "deleted";
  reconciledCount: number;
  firstDate: string | null;
  lastDate: string | null;
  createdByEmail: string | null;
  createdAt: string;
  deletedAt: string | null;
  deletedByEmail: string | null;
};

type ImportRow = {
  id: string;
  account_id: string;
  source: "file" | "akahu" | "simplefin" | "stripe" | "paypal" | "wise";
  file_name: string | null;
  file_format: StatementFormat | "akahu" | "simplefin" | "stripe" | "paypal" | "wise";
  file_feed: "folder" | "mailbox" | null;
  line_count: number;
  duplicate_count: number;
  possible_duplicate_count: number;
  status: "active" | "deleted";
  reconciled_count: string;
  first_date: string | null;
  last_date: string | null;
  created_by_email: string | null;
  created_at: string;
  deleted_at: string | null;
  deleted_by_email: string | null;
};

const IMPORT_SELECT = `
  select i.id, i.account_id, i.source, i.file_name, i.file_format, i.file_feed, i.line_count, i.duplicate_count,
         i.possible_duplicate_count, i.status, i.created_by_email, i.created_at, i.deleted_at, i.deleted_by_email,
         (select count(*) from bank_statement_lines b where b.import_id = i.id and b.status = 'reconciled')::text
           as reconciled_count,
         (select min(line_date)::text from bank_statement_lines b where b.import_id = i.id) as first_date,
         (select max(line_date)::text from bank_statement_lines b where b.import_id = i.id) as last_date
    from bank_statement_imports i`;

function toImport(row: ImportRow): StatementImport {
  return {
    id: row.id,
    accountId: row.account_id,
    source: row.source,
    fileName: row.file_name,
    fileFormat: row.file_format,
    fileFeed: row.file_feed,
    lineCount: row.line_count,
    duplicateCount: row.duplicate_count,
    possibleDuplicateCount: row.possible_duplicate_count,
    status: row.status,
    reconciledCount: Number(row.reconciled_count),
    firstDate: row.first_date,
    lastDate: row.last_date,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    deletedByEmail: row.deleted_by_email,
  };
}

export async function getImport(tx: OrgTx, importId: string): Promise<StatementImport> {
  const result = await tx.query<ImportRow>(`${IMPORT_SELECT} where i.id = $1`, [importId]);
  if (!result.rows[0]) throw new NotFoundError("Import not found.");
  return toImport(result.rows[0]);
}

/** An account's imports and feed syncs, newest first. */
export async function listImports(tx: OrgTx, accountIdInput: unknown): Promise<StatementImport[]> {
  const accountId = requireId(accountIdInput, "accountId");
  const result = await tx.query<ImportRow>(`${IMPORT_SELECT} where i.account_id = $1 order by i.id desc limit 200`, [accountId]);
  return result.rows.map(toImport);
}

export type FileUpload = { fileName: string; bytes: Buffer };

/** Checks an uploaded file sent as base64 in a JSON body. */
export function parseUpload(input: { fileName: unknown; fileBase64: unknown }): FileUpload {
  const fileName = requireString(input.fileName, "fileName", { maxLength: 255 });
  if (typeof input.fileBase64 !== "string" || input.fileBase64.length === 0) {
    throw new ValidationError("Choose a file to import.");
  }
  if (input.fileBase64.length > Math.ceil((MAX_STATEMENT_FILE_BYTES * 4) / 3) + 4) {
    throw new ValidationError("The file is larger than 10 MB. Split it into smaller date ranges.");
  }
  return { fileName, bytes: Buffer.from(input.fileBase64, "base64") };
}

function readFile(upload: FileUpload, layoutInput: unknown): StatementFile {
  try {
    return readStatementFile(upload.fileName, upload.bytes, parseLayout(layoutInput));
  } catch (error) {
    if (error instanceof RowError) throw new ValidationError(error.message);
    throw error;
  }
}

async function savedLayout(tx: OrgTx, accountId: string): Promise<unknown> {
  const result = await tx.query<{ import_layout: unknown }>("select import_layout from bank_account_settings where account_id = $1", [
    accountId,
  ]);
  return result.rows[0]?.import_layout ?? null;
}

/**
 * The account's saved CSV/Excel layout when the file still fits it (its
 * columns are all there), otherwise a freshly detected one. A saved layout
 * that can't be read any more is ignored.
 */
function readWithSavedLayout(upload: FileUpload, saved: unknown): StatementFile {
  if (saved != null) {
    try {
      const withSaved = readFile(upload, saved);
      if (!withSaved.table || withSaved.lines.length > 0) return withSaved;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
    }
  }
  return readFile(upload, null);
}

export type ImportPreview = {
  format: StatementFormat;
  lineCount: number;
  newCount: number;
  duplicateCount: number;
  possibleDuplicateCount: number;
  errors: string[];
  firstDate: string | null;
  lastDate: string | null;
  moneyIn: string;
  moneyOut: string;
  closingBalance: StatementFile["closingBalance"];
  accountNumber: string | null;
  table: StatementFile["table"];
  sample: ParsedStatementLine[];
};

function totals(lines: readonly ParsedStatementLine[]): { moneyIn: string; moneyOut: string } {
  let moneyIn = BigInt(0);
  let moneyOut = BigInt(0);
  for (const line of lines) {
    const cents = BigInt(line.amount.replace(".", ""));
    if (cents > BigInt(0)) moneyIn += cents;
    else moneyOut -= cents;
  }
  const format = (cents: bigint) => {
    const text = cents.toString().padStart(3, "0");
    return `${text.slice(0, -2)}.${text.slice(-2)}`;
  };
  return { moneyIn: format(moneyIn), moneyOut: format(moneyOut) };
}

/** Reads a file and works out what an import would add, changing nothing. */
export async function previewImport(
  tx: OrgTx,
  accountIdInput: unknown,
  input: { fileName: unknown; fileBase64: unknown; layout?: unknown },
): Promise<ImportPreview> {
  const accountId = requireId(accountIdInput, "accountId");
  const upload = parseUpload(input);
  const account = await lockStatementAccount(tx, accountId);
  const file = input.layout == null ? readWithSavedLayout(upload, await savedLayout(tx, accountId)) : readFile(upload, input.layout);
  assertFileCurrency(file, account);
  const counts: AddLinesResult = await addStatementLines(tx, accountId, null, file.lines, { dryRun: true });
  const dates = file.lines.map((line) => line.date).sort();
  return {
    format: file.format,
    lineCount: file.lines.length,
    newCount: counts.added,
    duplicateCount: counts.duplicates,
    possibleDuplicateCount: counts.possibleDuplicates,
    errors: file.errors,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    ...totals(file.lines),
    closingBalance: file.closingBalance,
    accountNumber: file.accountNumber,
    table: file.table,
    sample: file.lines.slice(0, 20),
  };
}

/**
 * A file that says it's in another currency than the account is refused
 * (FXB10); a file that doesn't say is taken to be in the account's currency.
 */
function assertFileCurrency(file: StatementFile, account: { code: string; name: string; currencyCode: string }): void {
  const others = file.currencies.filter((code) => code !== account.currencyCode);
  if (others.length > 0) {
    throw new ValidationError(
      `This file is in ${file.currencies.join(" and ")}, but ${account.code} (${account.name}) is in ${account.currencyCode}. Nothing was imported.`,
    );
  }
}

type ImportResult = { created: boolean; import: StatementImport };

async function findImportByKey(tx: OrgTx, source: string, key: string): Promise<{ id: string; request_hash: string } | null> {
  const result = await tx.query<{ id: string; request_hash: string }>(
    "select id, request_hash from bank_statement_imports where command_source = $1 and idempotency_key = $2",
    [source, key],
  );
  return result.rows[0] ?? null;
}

/**
 * Imports a statement file (examples BK1-BK3): adds the lines that aren't
 * already on the account and saves a CSV or Excel layout for next time. A
 * file with lines that can't be read is refused as a whole, so nothing is
 * half imported. Nothing is posted to the ledger.
 */
export async function importStatementFile(
  tx: OrgTx,
  accountIdInput: unknown,
  input: { source?: unknown; idempotencyKey: unknown; fileName: unknown; fileBase64: unknown; layout?: unknown },
): Promise<ImportResult> {
  const accountId = requireId(accountIdInput, "accountId");
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const upload = parseUpload(input);
  const layout: TableLayout | null = (() => {
    try {
      return parseLayout(input.layout);
    } catch (error) {
      if (error instanceof RowError) throw new ValidationError(error.message);
      throw error;
    }
  })();
  const hash = requestHash("statement_import", {
    accountId,
    fileName: upload.fileName,
    file: createHash("sha256").update(upload.bytes).digest("hex"),
    layout,
  });
  const earlier = await findImportByKey(tx, source, idempotencyKey);
  if (earlier) {
    assertSameRequest(earlier.request_hash, hash, "statement import");
    return { created: false, import: await getImport(tx, earlier.id) };
  }
  const file = readFile(upload, layout);
  if (file.errors.length > 0) {
    throw new ValidationError(
      `The file has ${file.errors.length} problem${file.errors.length === 1 ? "" : "s"}, so nothing was imported: ${file.errors
        .slice(0, 5)
        .join(" ")}${file.errors.length > 5 ? " …" : ""}`,
    );
  }
  if (file.lines.length === 0) throw new ValidationError("The file has no transactions to import.");
  const account = await lockStatementAccount(tx, accountId);
  assertFileCurrency(file, account);
  const committedMeanwhile = await findImportByKey(tx, source, idempotencyKey);
  if (committedMeanwhile) {
    assertSameRequest(committedMeanwhile.request_hash, hash, "statement import");
    return { created: false, import: await getImport(tx, committedMeanwhile.id) };
  }
  const counts = await addStatementLines(tx, accountId, null, file.lines, { dryRun: true });
  let inserted;
  try {
    inserted = await tx.query<{ id: string }>(
      `insert into bank_statement_imports (
         command_source, idempotency_key, request_hash, account_id, source, file_name, file_format, line_count,
         duplicate_count, possible_duplicate_count, created_by_user_id, created_by_email
       ) values ($1, $2, $3, $4, 'file', $5, $6, $7, $8, $9, $10, $11) returning id`,
      [
        source,
        idempotencyKey,
        hash,
        accountId,
        upload.fileName,
        file.format,
        counts.added,
        counts.duplicates,
        counts.possibleDuplicates,
        tx.actor.userId,
        tx.actor.email,
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ConflictError("That idempotency key was already used for a different statement import.");
    }
    throw error;
  }
  const importId = inserted.rows[0].id;
  await addStatementLines(tx, accountId, importId, file.lines);
  if (file.table) {
    await tx.query("update bank_account_settings set import_layout = $2::jsonb, updated_at = now() where account_id = $1", [
      accountId,
      JSON.stringify(file.table.layout),
    ]);
  }
  await writeAuditEvent(tx, {
    eventType: "statement.imported",
    entityType: "bank_statement_import",
    entityId: importId,
    details: {
      accountCode: account.code,
      fileName: upload.fileName,
      format: file.format,
      added: counts.added,
      duplicates: counts.duplicates,
      possibleDuplicates: counts.possibleDuplicates,
    },
  });
  return { created: true, import: await getImport(tx, importId) };
}

/**
 * Deletes an import (example BK12): its lines are marked deleted and no longer
 * count. Refused while any of its lines is reconciled. Deleting twice is fine.
 */
export async function deleteImport(tx: OrgTx, importIdInput: unknown): Promise<StatementImport> {
  const importId = requireId(importIdInput, "importId");
  const current = await getImport(tx, importId);
  await lockStatementAccount(tx, current.accountId, "delete");
  const statement = await getImport(tx, importId);
  if (statement.status === "deleted") return statement;
  if (statement.reconciledCount > 0) {
    throw new ConflictError(
      `${statement.reconciledCount} of this import's lines ${statement.reconciledCount === 1 ? "is" : "are"} reconciled. Unreconcile ${
        statement.reconciledCount === 1 ? "it" : "them"
      } before deleting the import.`,
    );
  }
  await tx.query(
    "update bank_statement_lines set status = 'deleted', updated_at = now() where import_id = $1 and status <> 'deleted'",
    [importId],
  );
  await tx.query(
    "update bank_statement_imports set status = 'deleted', deleted_at = now(), deleted_by_email = $2 where id = $1",
    [importId, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "statement.import_deleted",
    entityType: "bank_statement_import",
    entityId: importId,
    details: { accountId: statement.accountId, fileName: statement.fileName, lineCount: statement.lineCount },
  });
  return getImport(tx, importId);
}

export type FeedImportResult = {
  result: "imported" | "no_new" | "failed";
  /** Why a file wasn't imported, as the feed lists it (BF4, BF5). */
  reason: string | null;
  linesAdded: number;
  importId: string | null;
};

export const COLUMNS_DONT_MATCH = "Columns don't match the last file imported by hand.";

/**
 * A statement file brought in by a feed (BF1-BF10): the same reading and
 * duplicate rules as an import by hand, but CSV and Excel files must fit the
 * account's saved column layout (BF4, decision 387): Tohyee doesn't guess an
 * automatic file's columns. A file that can't be imported says why instead
 * of throwing, so one bad file doesn't stop the rest. A file with no new
 * lines adds no import (BF2).
 */
export async function importStatementFromFeed(
  tx: OrgTx,
  accountId: string,
  input: { fileName: string; bytes: Buffer; feed: "folder" | "mailbox"; key: string },
): Promise<FeedImportResult> {
  const failed = (reason: string): FeedImportResult => ({ result: "failed", reason, linesAdded: 0, importId: null });
  let file: StatementFile;
  try {
    const format = detectFormat(input.fileName, input.bytes);
    if (format === "csv" || format === "xlsx") {
      const saved = await savedLayout(tx, accountId);
      if (saved == null) return failed("Import one file of this kind by hand first, so Tohyee knows its columns.");
      let layout: TableLayout | null;
      try {
        layout = parseLayout(saved);
      } catch {
        return failed(COLUMNS_DONT_MATCH);
      }
      file = readStatementFile(input.fileName, input.bytes, layout);
      if (file.errors.some((error) => /^The file has no ".*" column|^Choose the/.test(error))) return failed(COLUMNS_DONT_MATCH);
    } else {
      file = readStatementFile(input.fileName, input.bytes);
    }
  } catch (error) {
    if (error instanceof RowError || error instanceof ValidationError) return failed(error.message);
    throw error;
  }
  if (file.errors.length > 0) {
    return failed(
      `The file has ${file.errors.length} problem${file.errors.length === 1 ? "" : "s"}: ${file.errors.slice(0, 3).join(" ")}${file.errors.length > 3 ? " …" : ""}`,
    );
  }
  if (file.lines.length === 0) return failed("The file has no transactions to import.");
  const account = await lockStatementAccount(tx, accountId);
  try {
    assertFileCurrency(file, account);
  } catch (error) {
    if (error instanceof ValidationError) return failed(error.message);
    throw error;
  }
  const counts = await addStatementLines(tx, accountId, null, file.lines, { dryRun: true });
  if (counts.added === 0) return { result: "no_new", reason: null, linesAdded: 0, importId: null };
  const inserted = await tx.query<{ id: string }>(
    `insert into bank_statement_imports (
       command_source, idempotency_key, request_hash, account_id, source, file_name, file_format, line_count,
       duplicate_count, possible_duplicate_count, created_by_user_id, created_by_email, file_feed
     ) values ('feed', $1, $2, $3, 'file', $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
    [
      input.key,
      createHash("sha256").update(input.bytes).digest("hex"),
      accountId,
      input.fileName.slice(0, 255),
      file.format,
      counts.added,
      counts.duplicates,
      counts.possibleDuplicates,
      tx.actor.userId,
      tx.actor.email,
      input.feed,
    ],
  );
  const importId = inserted.rows[0].id;
  await addStatementLines(tx, accountId, importId, file.lines);
  await writeAuditEvent(tx, {
    eventType: "statement.imported",
    entityType: "bank_statement_import",
    entityId: importId,
    details: {
      accountCode: account.code,
      fileName: input.fileName,
      format: file.format,
      feed: input.feed,
      added: counts.added,
      duplicates: counts.duplicates,
      possibleDuplicates: counts.possibleDuplicates,
    },
  });
  return { result: "imported", reason: null, linesAdded: counts.added, importId };
}
