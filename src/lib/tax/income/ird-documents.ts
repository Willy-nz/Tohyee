import { createHash } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { checkInboxFile } from "@/lib/bills/inbox";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { cmp, dec, parseDecimalInput } from "@/lib/money/decimal";
import { addPayment, getIncomeTaxYear, type IncomeTaxYear, listPayments, requireIncomeYear, saveIncomeTaxYear, type TaxPayment } from "@/lib/tax/income/service";
import { optionalId, optionalString, requireArray, requireId, requireIdempotencyKey, requireString } from "@/lib/validation";

/*
 * IRD documents, and figures the organisation's own connected AI proposes
 * from them (examples ITX30-ITX35, decision 549). Tohyee calls no AI and
 * never touches myIR. A proposal changes nothing until a person accepts it.
 * Owners and admins only (the routes and AI tools check).
 */

export type IrdDocument = {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  incomeYear: number | null;
  note: string | null;
  createdByEmail: string | null;
  createdAt: string;
  removed: { at: string; byEmail: string | null; reason: string } | null;
};

type DocumentRow = {
  id: string;
  request_hash: string;
  file_name: string;
  content_type: string;
  byte_size: number;
  income_year: number | null;
  note: string | null;
  created_by_email: string | null;
  created_at: string;
  removed_at: string | null;
  removed_by_email: string | null;
  removed_reason: string | null;
};

const DOCUMENT_COLUMNS = "id::text, request_hash, file_name, content_type, byte_size, income_year, note, created_by_email, created_at, removed_at, removed_by_email, removed_reason";

function toDocument(row: DocumentRow): IrdDocument {
  return {
    id: row.id,
    fileName: row.file_name,
    contentType: row.content_type,
    byteSize: row.byte_size,
    incomeYear: row.income_year,
    note: row.note,
    createdByEmail: row.created_by_email,
    createdAt: new Date(row.created_at).toISOString(),
    removed: row.removed_at ? { at: new Date(row.removed_at).toISOString(), byEmail: row.removed_by_email, reason: row.removed_reason! } : null,
  };
}

function optionalYear(input: unknown): number | null {
  return input == null || input === "" ? null : requireIncomeYear(input);
}

export async function listIrdDocuments(tx: OrgTx, options: { includeRemoved?: boolean } = {}): Promise<IrdDocument[]> {
  const result = await tx.query<DocumentRow>(
    `select ${DOCUMENT_COLUMNS} from ird_documents ${options.includeRemoved ? "" : "where removed_at is null"} order by created_at desc, ird_documents.id desc`,
  );
  return result.rows.map(toDocument);
}

/** Adds an IRD file (ITX30). Changes no figure. */
export async function addIrdDocument(
  tx: OrgTx,
  input: { idempotencyKey: unknown; fileName: unknown; content: Uint8Array; incomeYear?: unknown; note?: unknown },
): Promise<{ created: boolean; document: IrdDocument }> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  if (typeof input.fileName !== "string") throw new ValidationError("Choose a file.");
  let checked: { fileName: string; contentType: string };
  try {
    checked = checkInboxFile(input.fileName, input.content);
  } catch {
    throw new ValidationError(`${input.fileName} can't be added: only PDF, JPG, PNG and HEIC files up to 10 MB can.`);
  }
  const incomeYear = optionalYear(input.incomeYear);
  const note = optionalString(input.note, "note", { maxLength: 200 });
  const sha256 = createHash("sha256").update(input.content).digest("hex");
  const hash = requestHash("ird_document", { fileName: checked.fileName, sha256, incomeYear, note });
  const existing = await tx.query<DocumentRow>(`select ${DOCUMENT_COLUMNS} from ird_documents where idempotency_key = $1`, [idempotencyKey]);
  if (existing.rows[0]) {
    assertSameRequest(existing.rows[0].request_hash, hash, "IRD document");
    return { created: false, document: toDocument(existing.rows[0]) };
  }
  const inserted = await tx.query<DocumentRow>(
    `insert into ird_documents (idempotency_key, request_hash, file_name, content_type, byte_size, sha256, content, income_year, note, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${DOCUMENT_COLUMNS}`,
    [idempotencyKey, hash, checked.fileName, checked.contentType, input.content.length, sha256, Buffer.from(input.content.buffer, input.content.byteOffset, input.content.byteLength), incomeYear, note, tx.actor.email],
  );
  const document = toDocument(inserted.rows[0]);
  await writeAuditEvent(tx, { eventType: "income_tax.ird_document_added", entityType: "ird_document", entityId: document.id, details: { fileName: document.fileName, byteSize: document.byteSize, sha256, incomeYear, note } });
  return { created: true, document };
}

export async function getIrdDocument(tx: OrgTx, idInput: unknown): Promise<IrdDocument> {
  const id = requireId(idInput, "documentId");
  const found = await tx.query<DocumentRow>(`select ${DOCUMENT_COLUMNS} from ird_documents where id = $1`, [id]);
  if (!found.rows[0]) throw new NotFoundError("IRD document not found.");
  return toDocument(found.rows[0]);
}

export async function getIrdDocumentContent(tx: OrgTx, idInput: unknown): Promise<{ fileName: string; contentType: string; content: Buffer }> {
  const id = requireId(idInput, "documentId");
  const found = await tx.query<{ file_name: string; content_type: string; content: Buffer | null }>("select file_name, content_type, content from ird_documents where id = $1", [id]);
  const row = found.rows[0];
  if (!row) throw new NotFoundError("IRD document not found.");
  if (!row.content) throw new NotFoundError("This document was removed, so its file is gone.");
  return { fileName: row.file_name, contentType: row.content_type, content: row.content };
}

/** Removes an IRD document with a reason; the file is gone and the history keeps who, when and why (ITX30). */
export async function removeIrdDocument(tx: OrgTx, idInput: unknown, input: { reason: unknown }): Promise<IrdDocument> {
  const id = requireId(idInput, "documentId");
  const reason = requireString(input.reason, "reason", { maxLength: 500 });
  const updated = await tx.query<DocumentRow>(
    `update ird_documents set content = null, removed_at = now(), removed_by_email = $2, removed_reason = $3
      where id = $1 and removed_at is null returning ${DOCUMENT_COLUMNS}`,
    [id, tx.actor.email, reason],
  );
  if (!updated.rows[0]) throw new NotFoundError("IRD document not found, or already removed.");
  await writeAuditEvent(tx, { eventType: "income_tax.ird_document_removed", entityType: "ird_document", entityId: id, details: { fileName: updated.rows[0].file_name, reason } });
  return toDocument(updated.rows[0]);
}

// --- Proposals -----------------------------------------------------------------

export type ProposedFigures = {
  assessedRit?: string;
  returnFiledOn?: string;
  lossesBroughtForward?: string;
  taxCredits?: string;
  otherIncome?: string;
  payments?: Array<{ paidOn: string; amount: string; note: string | null }>;
};

export type IrdProposal = {
  id: string;
  documentId: string | null;
  documentName: string | null;
  incomeYear: number;
  figures: ProposedFigures;
  note: string | null;
  aiKeyName: string | null;
  proposedByEmail: string | null;
  createdAt: string;
  status: "waiting" | "accepted" | "declined";
  decidedByEmail: string | null;
  decidedAt: string | null;
  declineReason: string | null;
  /** The year's figures now, to compare with (ITX35). */
  current: IncomeTaxYear;
  /** Proposed payments, each marked when the same payment is already typed (ITX33). */
  payments: Array<{ paidOn: string; amount: string; note: string | null; alreadyTyped: boolean }>;
};

type ProposalRow = {
  id: string;
  request_hash: string;
  document_id: string | null;
  document_name: string | null;
  income_year: number;
  figures: ProposedFigures;
  note: string | null;
  ai_key_name: string | null;
  proposed_by_email: string | null;
  created_at: string;
  status: IrdProposal["status"];
  decided_by_email: string | null;
  decided_at: string | null;
  decline_reason: string | null;
};

const PROPOSAL_SELECT = `select p.id::text, p.request_hash, p.document_id::text, d.file_name as document_name, p.income_year, p.figures, p.note, p.ai_key_name,
       p.proposed_by_email, p.created_at, p.status, p.decided_by_email, p.decided_at, p.decline_reason
  from ird_figure_proposals p left join ird_documents d on d.id = p.document_id`;

function sameTyped(payments: TaxPayment[], paidOn: string, amount: string): boolean {
  return payments.some((payment) => payment.paidOn === paidOn && cmp(dec(payment.amount), dec(amount)) === 0);
}

async function toProposal(tx: OrgTx, row: ProposalRow): Promise<IrdProposal> {
  const typed = await listPayments(tx, row.income_year);
  return {
    id: row.id,
    documentId: row.document_id,
    documentName: row.document_name,
    incomeYear: row.income_year,
    figures: row.figures,
    note: row.note,
    aiKeyName: row.ai_key_name,
    proposedByEmail: row.proposed_by_email,
    createdAt: new Date(row.created_at).toISOString(),
    status: row.status,
    decidedByEmail: row.decided_by_email,
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    declineReason: row.decline_reason,
    current: await getIncomeTaxYear(tx, row.income_year),
    payments: (row.figures.payments ?? []).map((payment) => ({ ...payment, alreadyTyped: sameTyped(typed, payment.paidOn, payment.amount) })),
  };
}

export async function listProposals(tx: OrgTx, options: { status?: "waiting" | "all" } = {}): Promise<IrdProposal[]> {
  const result = await tx.query<ProposalRow>(`${PROPOSAL_SELECT} ${options.status === "all" ? "" : "where p.status = 'waiting'"} order by p.created_at, p.id`);
  return Promise.all(result.rows.map((row) => toProposal(tx, row)));
}

function amount(input: unknown, field: string, options: { allowNegative?: boolean; allowZero?: boolean } = {}): string | undefined {
  if (input == null || input === "") return undefined;
  return parseDecimalInput(input, field, { maxScale: 2, allowZero: options.allowZero ?? true, allowNegative: options.allowNegative ?? false });
}

/** Saves figures proposed from an IRD document (ITX32). Changes nothing until a person accepts them. */
export async function proposeIrdFigures(
  tx: OrgTx,
  input: {
    idempotencyKey: unknown;
    incomeYear: unknown;
    documentId?: unknown;
    assessedRit?: unknown;
    returnFiledOn?: unknown;
    lossesBroughtForward?: unknown;
    taxCredits?: unknown;
    otherIncome?: unknown;
    payments?: unknown;
    note?: unknown;
  },
): Promise<{ created: boolean; proposal: IrdProposal }> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const incomeYear = requireIncomeYear(input.incomeYear);
  const documentId = optionalId(input.documentId, "documentId");
  if (documentId) {
    const document = await getIrdDocument(tx, documentId);
    if (document.removed) throw new ValidationError(`${document.fileName} was removed, so figures can't be proposed from it.`);
  }
  const figures: ProposedFigures = {};
  const rit = amount(input.assessedRit, "assessedRit");
  const filed = input.returnFiledOn == null || input.returnFiledOn === "" ? undefined : parseIsoDate(input.returnFiledOn, "returnFiledOn");
  if ((rit === undefined) !== (filed === undefined)) throw new ValidationError("Propose both the assessed RIT and the date the return was filed, or neither.");
  if (rit !== undefined) {
    figures.assessedRit = rit;
    figures.returnFiledOn = filed;
  }
  const losses = amount(input.lossesBroughtForward, "lossesBroughtForward");
  if (losses !== undefined) figures.lossesBroughtForward = losses;
  const credits = amount(input.taxCredits, "taxCredits");
  if (credits !== undefined) figures.taxCredits = credits;
  const other = amount(input.otherIncome, "otherIncome", { allowNegative: true });
  if (other !== undefined) figures.otherIncome = other;
  if (input.payments != null) {
    figures.payments = requireArray(input.payments, "payments", 50).map((entry, index) => {
      const item = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
      return {
        paidOn: parseIsoDate(item.paidOn, `Payment ${index + 1}'s paidOn`),
        amount: parseDecimalInput(item.amount, `Payment ${index + 1}'s amount`, { maxScale: 2 }),
        note: optionalString(item.note, `Payment ${index + 1}'s note`, { maxLength: 150 }),
      };
    });
  }
  if (Object.keys(figures).length === 0 || (figures.payments?.length === 0 && Object.keys(figures).length === 1)) {
    throw new ValidationError("Propose at least one figure or payment.");
  }
  const note = optionalString(input.note, "note", { maxLength: 1000 });
  const hash = requestHash("ird_figure_proposal", { incomeYear, documentId, figures, note });
  const existing = await tx.query<ProposalRow>(`${PROPOSAL_SELECT} where p.idempotency_key = $1`, [idempotencyKey]);
  if (existing.rows[0]) {
    assertSameRequest(existing.rows[0].request_hash, hash, "IRD figures proposal");
    return { created: false, proposal: await toProposal(tx, existing.rows[0]) };
  }
  const inserted = await tx.query<{ id: string }>(
    `insert into ird_figure_proposals (idempotency_key, request_hash, document_id, income_year, figures, note, ai_key_name, proposed_by_email)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) returning id::text`,
    [idempotencyKey, hash, documentId, incomeYear, JSON.stringify(figures), note, tx.actor.via ?? null, tx.actor.email],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, { eventType: "income_tax.figures_proposed", entityType: "ird_figure_proposal", entityId: id, details: { incomeYear, documentId, figures, note } });
  const row = (await tx.query<ProposalRow>(`${PROPOSAL_SELECT} where p.id = $1`, [id])).rows[0];
  return { created: true, proposal: await toProposal(tx, row) };
}

async function lockWaiting(tx: OrgTx, idInput: unknown): Promise<ProposalRow> {
  const id = requireId(idInput, "proposalId");
  await tx.query("select 1 from ird_figure_proposals where id = $1 for update", [id]);
  const found = await tx.query<ProposalRow>(`${PROPOSAL_SELECT} where p.id = $1`, [id]);
  const row = found.rows[0];
  if (!row) throw new NotFoundError("Proposal not found.");
  if (row.status !== "waiting") throw new ConflictError(`This proposal was already ${row.status}.`);
  return row;
}

/** A person accepts a proposal: its figures are saved as if they typed them, and its payments added unless already typed (ITX33). */
export async function acceptProposal(tx: OrgTx, idInput: unknown): Promise<IrdProposal> {
  if (tx.actor.via) throw new ValidationError("Only a person can accept proposed IRD figures, in Tohyee.");
  const row = await lockWaiting(tx, idInput);
  const figures = row.figures;
  const current = await getIncomeTaxYear(tx, row.income_year);
  const changesYear = figures.assessedRit !== undefined || figures.lossesBroughtForward !== undefined || figures.taxCredits !== undefined || figures.otherIncome !== undefined;
  if (changesYear) {
    await saveIncomeTaxYear(tx, {
      incomeYear: row.income_year,
      assessedRit: figures.assessedRit ?? current.assessedRit,
      returnFiledOn: figures.returnFiledOn ?? current.returnFiledOn,
      lossesBroughtForward: figures.lossesBroughtForward ?? current.lossesBroughtForward,
      taxCredits: figures.taxCredits ?? current.taxCredits,
      otherIncome: figures.otherIncome ?? current.otherIncome,
      multipleActivity: current.multipleActivity,
      version: current.version,
    });
  }
  const typed = await listPayments(tx, row.income_year);
  const from = `from an IRD document, proposed by ${row.ai_key_name ?? row.proposed_by_email ?? "someone"}, accepted by ${tx.actor.email}`;
  for (const [index, payment] of (figures.payments ?? []).entries()) {
    if (sameTyped(typed, payment.paidOn, payment.amount)) continue;
    const note = `${payment.note ? `${payment.note}; ` : ""}${from}`.slice(0, 200);
    await addPayment(tx, { idempotencyKey: `ird-proposal-${row.id}-${index}`, incomeYear: row.income_year, paidOn: payment.paidOn, amount: payment.amount, note });
  }
  await tx.query("update ird_figure_proposals set status = 'accepted', decided_by_email = $2, decided_at = now() where id = $1", [row.id, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "income_tax.figures_accepted", entityType: "ird_figure_proposal", entityId: row.id, details: { incomeYear: row.income_year, figures } });
  return toProposal(tx, (await tx.query<ProposalRow>(`${PROPOSAL_SELECT} where p.id = $1`, [row.id])).rows[0]);
}

/** A person declines a proposal, with a reason (ITX33). */
export async function declineProposal(tx: OrgTx, idInput: unknown, input: { reason: unknown }): Promise<IrdProposal> {
  if (tx.actor.via) throw new ValidationError("Only a person can decline proposed IRD figures, in Tohyee.");
  const reason = requireString(input.reason, "reason", { maxLength: 500 });
  const row = await lockWaiting(tx, idInput);
  await tx.query("update ird_figure_proposals set status = 'declined', decided_by_email = $2, decided_at = now(), decline_reason = $3 where id = $1", [row.id, tx.actor.email, reason]);
  await writeAuditEvent(tx, { eventType: "income_tax.figures_declined", entityType: "ird_figure_proposal", entityId: row.id, details: { incomeYear: row.income_year, reason } });
  return toProposal(tx, (await tx.query<ProposalRow>(`${PROPOSAL_SELECT} where p.id = $1`, [row.id])).rows[0]);
}
