import { createHash, randomUUID } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { addInboxItem, checkInboxFile } from "@/lib/bills/inbox";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, HttpError, NotFoundError, ValidationError } from "@/lib/errors";
import { importApplications, previewApplicationImport } from "@/lib/farming/fertiliser";
import { getFarmingSettings } from "@/lib/farming/paddocks";
import { importReadings, previewReadingImport } from "@/lib/farming/pasture";
import { PASTURE_METHOD_LABELS, PASTURE_METHODS, type PastureMethod } from "@/lib/farming/pasture-rules";
import { importSource, importSoilTests, previewSoilImport } from "@/lib/farming/soil";
import { accountingEnabled } from "@/lib/organisations/accounting-switch";
import { type MailOwner, notFound } from "@/lib/private-mail/access";
import { type CopyKeys, copyKeys, open, openJson, sealJson } from "@/lib/private-mail/crypto";
import {
  FILING_KINDS,
  FILING_RECORD_TYPES,
  type FiledItem,
  filedName,
  type FilingDestination,
  type FilingKind,
  type FilingOptions,
  type FilingOverview,
  type FilingPreview,
  type FilingRecordHit,
  type FilingRecordType,
  type FilingResult,
  type MailRule,
  normaliseSender,
  ruleMatches,
  ruleText,
  type SharedField,
  type SharedTable,
  type ToFileEntry,
} from "@/lib/private-mail/filing-types";
import type { AttachmentMeta, Envelope } from "@/lib/private-mail/store";
import { addAttachment, addNote } from "@/lib/records/extras";
import { checkAttachment, formatFileSize } from "@/lib/records/file-types";
import { RECORD_TYPE_SLUGS } from "@/lib/records/types";
import { parseIsoDate } from "@/lib/dates";

/*
 * Filing an attachment from My mail into shared data (#250; examples
 * PM20-PM29, decisions 720-726). Jess, 13 Oct 2026: "Nothing from email
 * reaches shared data automatically. The owner files an attachment ... or
 * sets up a rule they've approved ... Before anything is shared, the owner
 * sees a preview of exactly what will become visible to others. Filed items
 * are copies; the email itself stays private."
 *
 * Everything here takes a MailOwner (access.ts), so only the copy's own
 * Owner can preview, file, make rules or see what's waiting. Filing goes
 * through each feature's own path (the bills inbox, the soil test, pasture
 * reading and fertiliser application imports, a record's files), so the
 * same checks apply as for an upload. What's shared is the file (or the rows
 * read from it), its name, who filed it, an optional note the owner typed,
 * and that it was filed from a private email: never the email's subject,
 * sender, recipients, date, text or other attachments.
 */

type Attachment = {
  id: string;
  copyId: string;
  messageId: string;
  name: string;
  contentType: string;
  inline: boolean;
  content: Buffer;
  /** The email's other attachments (counted for "not shared", never shared). */
  others: number;
};

function idOf(input: unknown): string {
  const id = typeof input === "string" || typeof input === "number" ? String(input) : "";
  if (!/^[1-9][0-9]{0,18}$/.test(id)) throw notFound();
  return id;
}

async function ownCopyKeys(tx: OrgTx, owner: MailOwner, copyId: string): Promise<{ keys: CopyKeys; email: string }> {
  const found = await tx.query<{ data_key_ciphertext: string; mailbox_email: string }>(
    "select data_key_ciphertext, mailbox_email from private_mail_copies where id = $1 and owner_user_id = $2",
    [copyId, owner.userId],
  );
  if (!found.rows[0]) throw notFound();
  return { keys: copyKeys(copyId, found.rows[0].data_key_ciphertext), email: found.rows[0].mailbox_email };
}

/** The owner's own attachment, decrypted, or "not found". */
async function ownAttachment(tx: OrgTx, owner: MailOwner, input: unknown): Promise<Attachment> {
  owner.check(tx);
  const id = idOf(input);
  const found = await tx.query<{ copy_id: string; message_id: string; external_id: string; meta: Buffer; content: Buffer | null; message_external_id: string; attachment_count: number }>(
    `select a.copy_id::text, a.message_id::text, a.external_id, a.meta, a.content, m.external_id as message_external_id, m.attachment_count
       from private_mail_attachments a join private_mail_messages m on m.id = a.message_id join private_mail_copies c on c.id = a.copy_id
      where a.id = $1 and a.owner_user_id = $2 and m.owner_user_id = $2 and c.owner_user_id = $2`,
    [id, owner.userId],
  );
  const row = found.rows[0];
  if (!row) throw notFound();
  const { keys } = await ownCopyKeys(tx, owner, row.copy_id);
  const external = `${row.message_external_id}/${row.external_id}`;
  const meta = openJson<AttachmentMeta>(keys, "attachment-meta", external, row.meta);
  if (!row.content) throw new ValidationError(meta.notKept === "linked" ? "That's a linked Outlook item, so there's no file to file." : "That attachment was too big to keep, so there's no file to file.");
  return {
    id,
    copyId: row.copy_id,
    messageId: row.message_id,
    name: meta.name,
    contentType: meta.contentType,
    inline: meta.inline,
    content: open(keys, "attachment", external, row.content),
    others: Math.max(0, row.attachment_count - 1),
  };
}

// Destinations --------------------------------------------------------------------------------------

function text(input: unknown, label: string, max: number): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string") throw new ValidationError(`${label} must be text.`);
  const value = input.trim();
  if (!value) return null;
  if (value.length > max) throw new ValidationError(`${label} can be at most ${max} characters.`);
  return value;
}

/** A destination from the request, checked for shape (not yet whether its farm or record exists). */
export function parseDestination(input: unknown, options: { forRule?: boolean } = {}): FilingDestination {
  const raw = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const kind = raw.kind as FilingKind;
  if (!FILING_KINDS.includes(kind)) throw new ValidationError("Choose where to file it.");
  switch (kind) {
    case "bills_inbox":
      return { kind };
    case "soil_tests": {
      // A rule files many files, so a date for the whole file isn't part of it.
      const sampledOn = options.forRule ? null : raw.sampledOn ? parseIsoDate(raw.sampledOn, "Date sampled") : null;
      return { kind, farmId: idOrRefuse(raw.farmId, "Choose the farm."), sampledOn, lab: text(raw.lab, "The lab", 100) };
    }
    case "pasture_readings": {
      const method = raw.method === undefined || raw.method === null || raw.method === "" ? null : String(raw.method);
      if (method !== null && !PASTURE_METHODS.includes(method as PastureMethod)) throw new ValidationError("Choose a method Tohyee knows.");
      return { kind, farmId: idOrRefuse(raw.farmId, "Choose the farm."), method };
    }
    case "fertiliser_applications":
      return { kind, planId: idOrRefuse(raw.planId, "Choose the fertiliser plan.") };
    case "record": {
      const recordType = String(raw.recordType ?? "");
      if (!FILING_RECORD_TYPES.some((entry) => entry.type === recordType)) throw new ValidationError("Choose the kind of record.");
      return { kind, recordType, recordId: idOrRefuse(raw.recordId, "Choose the record.") };
    }
  }
}

function idOrRefuse(input: unknown, message: string): string {
  const id = typeof input === "string" || typeof input === "number" ? String(input) : "";
  if (!/^[1-9][0-9]{0,18}$/.test(id)) throw new ValidationError(message);
  return id;
}

type RecordSearch = { from: string; label: string; text: string; order: string; where?: string };

/** How each record type is found and named (the same names its own pages use). */
const RECORD_SEARCH: Record<FilingRecordType, RecordSearch> = {
  bill: {
    from: "bills r join contacts c on c.id = r.contact_id",
    label: "'Bill ' || r.supplier_invoice_number || ' · ' || c.name || ' · ' || to_char(r.bill_date, 'DD Mon YYYY') || case when r.status = 'draft' then ' (draft)' when r.status = 'voided' then ' (voided)' else '' end",
    text: "r.supplier_invoice_number || ' ' || c.name",
    order: "r.id desc",
  },
  sales_invoice: {
    from: "sales_invoices r join contacts c on c.id = r.contact_id",
    label: "coalesce('Invoice ' || r.invoice_number, 'Draft invoice #' || r.id) || ' · ' || c.name || case when r.status = 'voided' then ' (voided)' else '' end",
    text: "coalesce(r.invoice_number, '') || ' ' || coalesce(r.reference, '') || ' ' || c.name",
    order: "r.id desc",
  },
  contact: { from: "contacts r", label: "r.name", text: "r.name", order: "lower(r.name), r.id" },
  fixed_asset: { from: "fixed_assets r", label: "r.asset_number || ' · ' || r.name", text: "r.asset_number || ' ' || r.name", order: "r.asset_number" },
  soil_test: {
    from: "soil_tests r join paddocks p on p.id = r.paddock_id join farms f on f.id = r.farm_id",
    label: "'Soil test · ' || p.name || ' · ' || to_char(r.sampled_on, 'DD Mon YYYY') || ' · ' || f.name",
    text: "p.name || ' ' || f.name || ' ' || to_char(r.sampled_on, 'YYYY-MM-DD')",
    order: "r.sampled_on desc, r.id desc",
    where: "r.status = 'active'",
  },
  coop_shareholding: {
    from: "coop_shareholdings r",
    label: "r.coop_name || ' · ' || r.share_class",
    text: "r.coop_name || ' ' || r.share_class",
    order: "lower(r.coop_name), r.id",
    where: "r.status = 'active'",
  },
};

const RECORD_LINKS: Partial<Record<FilingRecordType, (id: string) => string>> = {
  bill: (id) => `/operations/bills/${id}`,
  sales_invoice: (id) => `/operations/invoices/${id}`,
  contact: () => "/operations/contacts",
  fixed_asset: (id) => `/operations/fixed-assets/${id}`,
  soil_test: () => "/operations/farming/soil",
  coop_shareholding: () => "/operations/farming/co-op-shares",
};

/** Records to attach a filed attachment to (the owner's own choice: they're an Owner, so they can see them all). */
export async function searchFilingRecords(tx: OrgTx, owner: MailOwner, input: { type?: unknown; query?: unknown }): Promise<FilingRecordHit[]> {
  owner.check(tx);
  const type = String(input.type ?? "") as FilingRecordType;
  const search = RECORD_SEARCH[type];
  if (!search) throw new ValidationError("Choose the kind of record.");
  if ((type === "soil_test" || type === "coop_shareholding") && !(await getFarmingSettings(tx)).enabled) return [];
  const query = typeof input.query === "string" ? input.query.trim().slice(0, 100) : "";
  const where = [search.where ?? "true"];
  const params: unknown[] = [];
  if (query) {
    params.push(`%${query.replace(/[\\%_]/g, "\\$&")}%`);
    where.push(`(${search.text}) ilike $1`);
  }
  const rows = await tx.query<{ id: string; label: string }>(`select r.id::text, ${search.label} as label from ${search.from} where ${where.join(" and ")} order by ${search.order} limit 20`, params);
  return rows.rows;
}

async function recordLabel(tx: OrgTx, type: FilingRecordType, id: string): Promise<string> {
  const search = RECORD_SEARCH[type];
  const found = await tx.query<{ label: string }>(`select ${search.label} as label from ${search.from} where r.id = $1 and ${search.where ?? "true"}`, [id]);
  if (!found.rows[0]) throw new NotFoundError(`That ${FILING_RECORD_TYPES.find((entry) => entry.type === type)!.label.toLowerCase()} wasn't found.`);
  return found.rows[0].label;
}

async function farmName(tx: OrgTx, farmId: string): Promise<string> {
  if (!(await getFarmingSettings(tx)).enabled) throw new ValidationError("Farming is off. An admin can turn it on under Settings, Modules.");
  const found = await tx.query<{ name: string }>("select name from farms where id = $1", [farmId]);
  if (!found.rows[0]) throw new NotFoundError("That farm wasn't found.");
  return found.rows[0].name;
}

/** The destination in words, checking it's there (and its module is on). */
export async function destinationLabel(tx: OrgTx, destination: FilingDestination): Promise<string> {
  switch (destination.kind) {
    case "bills_inbox":
      if (!(await accountingEnabled(tx))) throw new ValidationError("Accounting is off, so there's no bills inbox.");
      return "The bills inbox";
    case "soil_tests":
      return `Soil tests on ${await farmName(tx, destination.farmId)}`;
    case "pasture_readings":
      return `Pasture readings on ${await farmName(tx, destination.farmId)}`;
    case "fertiliser_applications": {
      if (!(await getFarmingSettings(tx)).enabled) throw new ValidationError("Farming is off. An admin can turn it on under Settings, Modules.");
      const found = await tx.query<{ name: string; farm: string }>("select p.name, f.name as farm from fertiliser_plans p join farms f on f.id = p.farm_id where p.id = $1", [destination.planId]);
      if (!found.rows[0]) throw new NotFoundError("That fertiliser plan wasn't found.");
      return `Applications in the fertiliser plan ${found.rows[0].name} (${found.rows[0].farm})`;
    }
    case "record":
      return `${(await recordLabel(tx, destination.recordType as FilingRecordType, destination.recordId))}`;
  }
}

function destinationLink(destination: FilingDestination): string | null {
  switch (destination.kind) {
    case "bills_inbox":
      return "/operations/bills/inbox";
    case "soil_tests":
      return "/operations/farming/soil";
    case "pasture_readings":
      return "/operations/farming/pasture";
    case "fertiliser_applications":
      return "/operations/farming/fertiliser";
    case "record":
      return RECORD_LINKS[destination.recordType as FilingRecordType]?.(destination.recordId) ?? null;
  }
}

// The preview ---------------------------------------------------------------------------------------

/** The file as an import reads it: CSV text, or an Excel workbook (base64) where the import takes one. */
function importContent(fileName: string, content: Buffer, allowXlsx: boolean): { content?: string; contentBase64?: string } {
  if (/\.xlsx$/i.test(fileName)) {
    if (!allowXlsx) throw new ValidationError("This import reads CSV files only. To keep the file, attach it to a record instead.");
    return { contentBase64: content.toString("base64") };
  }
  if (!/\.(csv|txt)$/i.test(fileName)) {
    throw new ValidationError(`Only ${allowXlsx ? "CSV or Excel (.xlsx)" : "CSV"} files can be imported. To keep a PDF or picture, attach it to a record instead.`);
  }
  return { content: content.toString("utf8").replace(/^﻿/, "") };
}

type ImportPayload = { fileName: string; content?: string; contentBase64?: string; sampledOn?: string; lab?: string; method?: string };
type Built = Omit<FilingPreview, "confirmation"> & { importInput: ImportPayload | null };

/** A refusal shown in the preview rather than as an error: the owner sees why, and can change it. */
function asProblem(error: unknown): string {
  if (error instanceof HttpError && error.status !== 500 && error.status !== 503) return error.message;
  if (error instanceof RangeError) return error.message;
  throw error;
}

async function build(tx: OrgTx, owner: MailOwner, attachment: Attachment, destination: FilingDestination, input: { fileName?: unknown; note?: unknown }): Promise<Built> {
  const warnings: string[] = [];
  let problem: string | null = null;
  let label = "";
  try {
    label = await destinationLabel(tx, destination);
  } catch (error) {
    problem = asProblem(error);
  }
  let fileName = attachment.name;
  try {
    fileName = filedName(attachment.name, typeof input.fileName === "string" ? input.fileName : null);
  } catch (error) {
    problem ??= asProblem(error);
  }
  const sharesFile = destination.kind === "bills_inbox" || destination.kind === "record";
  const noteAllowed = sharesFile;
  let note: string | null = null;
  try {
    note = text(input.note, "The note", 1000);
    if (note && !noteAllowed) throw new ValidationError("A note can't go with an import. Add one on the records afterwards.");
  } catch (error) {
    problem ??= asProblem(error);
  }
  const shared: SharedField[] = [];
  const by = tx.actor.email;
  const fromWords = "Filed from a private email by you (nothing of the email is shared)";
  let table: SharedTable | null = null;
  let importInput: ImportPayload | null = null;
  let contentType = attachment.contentType;
  if (!problem) {
    try {
      switch (destination.kind) {
        case "bills_inbox": {
          contentType = checkInboxFile(fileName, attachment.content).contentType;
          const sha256 = createHash("sha256").update(attachment.content).digest("hex");
          const same = await tx.query<{ id: string; bill_id: string | null }>("select id::text, bill_id::text from bill_inbox_items where sha256 = $1 and removed_at is null order by bill_inbox_items.id", [sha256]);
          for (const row of same.rows) warnings.push(row.bill_id ? `This file was already made into a bill from inbox item ${row.id}.` : `This file is already in the bills inbox (item ${row.id}).`);
          shared.push({ label: "File", value: `${fileName} (${formatFileSize(attachment.content.length)})` }, { label: "Where", value: "The bills inbox, waiting for a bill to be made from it" }, { label: "Added by", value: by }, { label: "How it arrived", value: fromWords });
          break;
        }
        case "record": {
          // The same check as attaching a file to the record by hand.
          contentType = checkAttachment(fileName, attachment.content).contentType;
          const sha256 = createHash("sha256").update(attachment.content).digest("hex");
          const same = await tx.query("select 1 from record_attachments where record_type = $1 and record_id = $2 and sha256 = $3 and removed_at is null", [destination.recordType, destination.recordId, sha256]);
          if (same.rowCount) warnings.push("This record already has the same file.");
          shared.push({ label: "File", value: `${fileName} (${formatFileSize(attachment.content.length)})` }, { label: "On", value: label }, { label: "Added by", value: by }, { label: "How it arrived", value: "Filed from a private email (shown on the file and in the record's history)" });
          if (note) shared.push({ label: "Note on the record, by you", value: note });
          break;
        }
        case "soil_tests": {
          importInput = { fileName, ...importContent(fileName, attachment.content, true), sampledOn: destination.sampledOn ?? undefined, lab: destination.lab ?? undefined };
          const preview = await previewSoilImport(tx, destination.farmId, importInput);
          if (preview.alreadyImportedOn) problem = `This file was already imported into this farm's soil tests on ${preview.alreadyImportedOn.slice(0, 10)}.`;
          else if (!preview.counts.tests) problem = "None of its rows can be imported. Check the file with Import on the soil tests page.";
          const measures = preview.columns.filter((column) => column.role === "measure").map((column) => `${column.measure}${column.unit ? ` (${column.unit})` : ""}`);
          shared.push(
            { label: "Where", value: label },
            { label: "Soil tests added", value: `${preview.counts.tests}${preview.counts.errors ? ` (${preview.counts.errors} ${preview.counts.errors === 1 ? "row" : "rows"} with problems left out)` : ""}` },
            { label: "Results read from", value: measures.join(", ") || "(no result columns)" },
            ...(destination.lab ? [{ label: "Lab", value: destination.lab }] : []),
            ...(destination.sampledOn ? [{ label: "Date sampled (for rows without one)", value: destination.sampledOn }] : []),
            { label: "Source on each test", value: importSource(fileName, { filedFromPrivateMail: true }) },
            { label: "Added by", value: by },
          );
          table = { headings: ["Line", "Paddock", "Sampled", "Sample", "Results"], rows: preview.rows.map((row) => ({ cells: [String(row.line), row.paddock ?? "", row.sampledOn ?? "", row.sampleName ?? "", String(row.results)], error: row.error })) };
          break;
        }
        case "pasture_readings": {
          importInput = { fileName, ...importContent(fileName, attachment.content, true), method: destination.method ?? undefined };
          const preview = await previewReadingImport(tx, destination.farmId, importInput);
          if (preview.alreadyImportedOn) problem = `This file was already imported into this farm's pasture readings on ${preview.alreadyImportedOn.slice(0, 10)}.`;
          else if (!preview.counts.readings) problem = "None of its rows can be imported. Check the file with Import on the pasture page.";
          shared.push(
            { label: "Where", value: label },
            { label: "Readings added", value: `${preview.counts.readings}${preview.counts.errors ? ` (${preview.counts.errors} ${preview.counts.errors === 1 ? "row" : "rows"} with problems left out)` : ""}` },
            ...(destination.method ? [{ label: "Method (for rows without one)", value: PASTURE_METHOD_LABELS[destination.method as PastureMethod] }] : []),
            { label: "Source on each reading", value: importSource(fileName, { filedFromPrivateMail: true }) },
            { label: "Added by", value: by },
          );
          table = {
            headings: ["Line", "Paddock", "Measured", "Cover (kg DM/ha)", "Method"],
            rows: preview.rows.map((row) => ({ cells: [String(row.line), row.paddockText, row.measuredOn ?? "", row.cover === null ? "" : String(row.cover), row.method ? PASTURE_METHOD_LABELS[row.method] : ""], error: row.error })),
          };
          break;
        }
        case "fertiliser_applications": {
          importInput = { fileName, ...importContent(fileName, attachment.content, false) };
          const preview = await previewApplicationImport(tx, destination.planId, { fileName: importInput.fileName, content: importInput.content });
          if (preview.alreadyImportedOn) problem = `This file was already imported on ${preview.alreadyImportedOn.slice(0, 10)}.`;
          else if (!preview.valid) problem = "None of its rows can be imported. Check the file with Import on the fertiliser page.";
          shared.push(
            { label: "Where", value: label },
            { label: "Applications added", value: `${preview.valid}${preview.errors ? ` (${preview.errors} ${preview.errors === 1 ? "row" : "rows"} with problems left out)` : ""}` },
            { label: "Source on each application", value: importSource(fileName, { filedFromPrivateMail: true }) },
            { label: "Added by", value: by },
          );
          table = {
            headings: ["Line", "Paddock", "Product", "Applied", "Tonnes", "Treated ha"],
            rows: preview.rows.map((row) => ({ cells: [String(row.line), row.paddock, row.product, row.appliedOn ?? "", row.tonnes ?? "", row.treatedHa ?? ""], error: row.error })),
          };
          break;
        }
      }
    } catch (error) {
      problem = asProblem(error);
    }
  }
  if (destination.kind === "bills_inbox" && note) shared.push({ label: "Note, by you", value: note });
  const notShared = [
    "The email's subject, sender, recipients, date and text",
    ...(attachment.others ? [`The email's other ${attachment.others === 1 ? "attachment" : `${attachment.others} attachments`}`] : []),
    "Which mailbox and folder it came from",
    ...(fileName !== attachment.name ? [`The attachment's own name (${attachment.name})`] : []),
    ...(sharesFile ? [] : ["The file itself: only the rows below are added"]),
  ];
  if (attachment.inline) warnings.push("This is a picture shown in the email's text (a logo or signature, say), not an attachment as such.");
  return {
    attachmentId: attachment.id,
    originalName: attachment.name,
    destination,
    destinationLabel: label,
    fileName,
    contentType,
    size: attachment.content.length,
    shared,
    table,
    sharesFile,
    noteAllowed,
    notShared,
    warnings,
    problem,
    importInput: problem ? null : importInput,
  };
}

/** What "File it" will be held to: everything the preview showed, and the file's contents. */
function withoutImport(built: Built): Omit<FilingPreview, "confirmation"> {
  const shown: Partial<Built> = { ...built };
  delete shown.importInput;
  return shown as Omit<FilingPreview, "confirmation">;
}

function confirmationOf(built: Built, content: Buffer, note: string | null): string {
  const shown = withoutImport(built);
  return createHash("sha256")
    .update(JSON.stringify({ shown, note, file: createHash("sha256").update(content).digest("hex") }))
    .digest("hex");
}

/**
 * PM20-PM24: a preview of exactly what filing this attachment would make
 * visible to others, from the destination's own import preview and checks.
 * Nothing is saved.
 */
export async function previewFiling(tx: OrgTx, owner: MailOwner, input: { attachmentId: unknown; destination: unknown; fileName?: unknown; note?: unknown }): Promise<FilingPreview> {
  const attachment = await ownAttachment(tx, owner, input.attachmentId);
  const destination = parseDestination(input.destination);
  const built = await build(tx, owner, attachment, destination, input);
  return { ...withoutImport(built), confirmation: confirmationOf(built, attachment.content, noteOf(input.note)) };
}

function noteOf(input: unknown): string | null {
  return typeof input === "string" && input.trim() ? input.trim() : null;
}

/**
 * PM20-PM25: files a copy of the attachment, as previewed: refused if
 * anything the preview showed has changed (`confirmation`), or if the
 * preview had a problem. From "To file", `toFileId` marks that entry filed.
 */
export async function fileAttachment(
  tx: OrgTx,
  owner: MailOwner,
  input: { attachmentId: unknown; destination: unknown; fileName?: unknown; note?: unknown; confirmation: unknown; toFileId?: unknown },
): Promise<FilingResult> {
  if (owner.via !== "screen") throw notFound();
  const attachment = await ownAttachment(tx, owner, input.attachmentId);
  const destination = parseDestination(input.destination);
  let toFile: { id: string; rule_id: string } | null = null;
  if (input.toFileId !== undefined && input.toFileId !== null && input.toFileId !== "") {
    const found = await tx.query<{ id: string; rule_id: string; attachment_id: string; status: string }>(
      "select id::text, rule_id::text, attachment_id::text, status from private_mail_to_file where id = $1 and owner_user_id = $2 for update",
      [idOf(input.toFileId), owner.userId],
    );
    const row = found.rows[0];
    if (!row || row.attachment_id !== attachment.id) throw notFound();
    if (row.status !== "waiting") throw new ConflictError(row.status === "filed" ? "That one has already been filed." : "That one was dismissed.");
    toFile = row;
  }
  const built = await build(tx, owner, attachment, destination, input);
  if (built.problem) throw new ValidationError(built.problem);
  const note = noteOf(input.note);
  if (typeof input.confirmation !== "string" || input.confirmation !== confirmationOf(built, attachment.content, note)) {
    throw new ConflictError("What would be filed has changed since the preview. Check the preview again before filing.");
  }
  const key = `my-mail-${String(input.confirmation).slice(0, 40)}`;
  const origin = { filedFromPrivateMail: true };
  let summary = "";
  const ids: Record<string, string | number> = {};
  switch (destination.kind) {
    case "bills_inbox": {
      const result = await addInboxItem(tx, { source: "my_mail", idempotencyKey: key, fileName: built.fileName, content: attachment.content, via: "my_mail", note });
      if (!result.created) throw new ConflictError("This was filed already.");
      ids.inboxItemId = result.item.id;
      summary = `In the bills inbox as item ${result.item.id}`;
      break;
    }
    case "record": {
      const slug = RECORD_TYPE_SLUGS[destination.recordType as FilingRecordType];
      const result = await addAttachment(tx, "owner", slug, destination.recordId, { source: "my_mail", idempotencyKey: key, fileName: built.fileName, content: attachment.content, ...origin });
      if (!result.created) throw new ConflictError("This was filed already.");
      if (note) await addNote(tx, "owner", slug, destination.recordId, { source: "my_mail", idempotencyKey: `${key}-note`, body: note });
      ids.recordType = destination.recordType;
      ids.recordId = destination.recordId;
      ids.attachmentId = result.attachment.id;
      summary = `Attached to ${built.destinationLabel}`;
      break;
    }
    case "soil_tests": {
      const tests = await importSoilTests(tx, destination.farmId, built.importInput!, origin);
      ids.farmId = destination.farmId;
      ids.added = tests.length;
      summary = `${tests.length} soil test${tests.length === 1 ? "" : "s"} added`;
      break;
    }
    case "pasture_readings": {
      const result = await importReadings(tx, destination.farmId, built.importInput!, origin);
      ids.farmId = destination.farmId;
      ids.added = result.imported;
      summary = `${result.imported} pasture reading${result.imported === 1 ? "" : "s"} added`;
      break;
    }
    case "fertiliser_applications": {
      const before = built.table?.rows.filter((row) => !row.error).length ?? 0;
      await importApplications(tx, destination.planId, { fileName: built.importInput!.fileName, content: built.importInput!.content }, origin);
      ids.planId = destination.planId;
      ids.added = before;
      summary = `${before} application${before === 1 ? "" : "s"} added`;
      break;
    }
  }
  const filed = {
    destination,
    destinationLabel: built.destinationLabel,
    fileName: built.fileName,
    size: built.size,
    sha256: createHash("sha256").update(attachment.content).digest("hex"),
    note,
    summary,
    link: destinationLink(destination),
    ids,
  };
  const inserted = await tx.query<{ id: string }>(
    "insert into private_mail_filings (copy_id, owner_user_id, attachment_id, rule_id, destination, filed) values ($1, $2, $3, $4, $5, $6::jsonb) returning id::text",
    [attachment.copyId, owner.userId, attachment.id, toFile?.rule_id ?? null, destination.kind, JSON.stringify(filed)],
  );
  const filingId = inserted.rows[0].id;
  if (toFile) await tx.query("update private_mail_to_file set status = 'filed', filing_id = $2, decided_at = now() where id = $1", [toFile.id, filingId]);
  // That something was filed, and where to: never the email or its attachment's own name (decision 724).
  await writeAuditEvent(tx, { eventType: "private_mail.attachment_filed", entityType: "private_mail_copy", entityId: attachment.copyId, details: { destination: destination.kind } });
  return { filingId, destinationLabel: built.destinationLabel, link: filed.link, summary };
}

// What's been filed, rules and "To file" -----------------------------------------------------------

/** PM25: what the owner has filed, newest first (their own record; it goes with the copy if that's deleted). */
async function listFiled(tx: OrgTx, owner: MailOwner): Promise<FiledItem[]> {
  const rows = await tx.query<{ id: string; filed_at: string; destination: FilingKind; filed: { destinationLabel: string; fileName: string; summary: string; link: string | null }; rule_id: string | null }>(
    "select id::text, filed_at::text, destination, filed, rule_id::text from private_mail_filings where owner_user_id = $1 order by filed_at desc, private_mail_filings.id desc limit 50",
    [owner.userId],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    filedAt: new Date(row.filed_at.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")).toISOString(),
    kind: row.destination,
    destinationLabel: row.filed.destinationLabel,
    fileName: row.filed.fileName,
    summary: row.filed.summary,
    link: row.filed.link,
    byRule: row.rule_id !== null,
  }));
}

type RuleCriteria = { sender: string | null; fileName: string | null };

async function labelOrMissing(tx: OrgTx, destination: FilingDestination): Promise<string> {
  try {
    return await destinationLabel(tx, destination);
  } catch (error) {
    return `${asProblem(error)} (change the rule)`;
  }
}

async function listRules(tx: OrgTx, owner: MailOwner): Promise<MailRule[]> {
  const rows = await tx.query<{ id: string; copy_id: string; seal_ref: string; criteria: Buffer; destination: FilingDestination; created_at: string; data_key_ciphertext: string; mailbox_email: string; waiting: number }>(
    `select r.id::text, r.copy_id::text, r.seal_ref, r.criteria, r.destination, r.created_at::text, c.data_key_ciphertext, c.mailbox_email,
            (select count(*)::int from private_mail_to_file t where t.rule_id = r.id and t.status = 'waiting') as waiting
       from private_mail_rules r join private_mail_copies c on c.id = r.copy_id
      where r.owner_user_id = $1 and c.owner_user_id = $1 order by r.id`,
    [owner.userId],
  );
  const result: MailRule[] = [];
  for (const row of rows.rows) {
    const criteria = openJson<RuleCriteria>(copyKeys(row.copy_id, row.data_key_ciphertext), "rule", row.seal_ref, row.criteria);
    result.push({
      id: row.id,
      copyId: row.copy_id,
      mailbox: row.mailbox_email,
      sender: criteria.sender,
      fileName: criteria.fileName,
      destination: row.destination,
      destinationLabel: await labelOrMissing(tx, row.destination),
      waiting: row.waiting,
      createdAt: new Date(row.created_at.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")).toISOString(),
    });
  }
  return result;
}

async function listToFile(tx: OrgTx, owner: MailOwner): Promise<ToFileEntry[]> {
  const rows = await tx.query<{
    id: string;
    rule_id: string;
    attachment_id: string;
    copy_id: string;
    data_key_ciphertext: string;
    a_external: string;
    meta: Buffer;
    size_bytes: number;
    message_id: string;
    m_external: string;
    envelope: Buffer;
    sent_at: string;
    seal_ref: string;
    criteria: Buffer;
    destination: FilingDestination;
  }>(
    `select t.id::text, t.rule_id::text, t.attachment_id::text, t.copy_id::text, c.data_key_ciphertext, a.external_id as a_external, a.meta, a.size_bytes,
            m.id::text as message_id, m.external_id as m_external, m.envelope, m.sent_at::text, r.seal_ref, r.criteria, r.destination
       from private_mail_to_file t
       join private_mail_rules r on r.id = t.rule_id
       join private_mail_attachments a on a.id = t.attachment_id
       join private_mail_messages m on m.id = a.message_id
       join private_mail_copies c on c.id = t.copy_id
      where t.owner_user_id = $1 and c.owner_user_id = $1 and t.status = 'waiting'
      order by m.sent_at desc, t.id desc limit 200`,
    [owner.userId],
  );
  const cache = new Map<string, CopyKeys>();
  const labels = new Map<string, string>();
  const result: ToFileEntry[] = [];
  for (const row of rows.rows) {
    let keys = cache.get(row.copy_id);
    if (!keys) cache.set(row.copy_id, (keys = copyKeys(row.copy_id, row.data_key_ciphertext)));
    const meta = openJson<AttachmentMeta>(keys, "attachment-meta", `${row.m_external}/${row.a_external}`, row.meta);
    const envelope = openJson<Envelope>(keys, "envelope", row.m_external, row.envelope);
    const criteria = openJson<RuleCriteria>(keys, "rule", row.seal_ref, row.criteria);
    if (!labels.has(row.rule_id)) labels.set(row.rule_id, await labelOrMissing(tx, row.destination));
    result.push({
      id: row.id,
      ruleId: row.rule_id,
      ruleText: ruleText(criteria),
      attachmentId: row.attachment_id,
      fileName: meta.name,
      size: row.size_bytes,
      messageId: row.message_id,
      subject: envelope.subject,
      from: envelope.from ? (envelope.from.name ? `${envelope.from.name} <${envelope.from.email}>` : envelope.from.email) : null,
      sentAt: new Date(row.sent_at.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")).toISOString(),
      destination: row.destination,
      destinationLabel: labels.get(row.rule_id)!,
    });
  }
  return result;
}

async function filingOptions(tx: OrgTx): Promise<FilingOptions> {
  const farming = (await getFarmingSettings(tx)).enabled;
  const farms = farming
    ? (await tx.query<{ id: string; name: string }>("select id::text, name from farms where is_active order by lower(name), farms.id")).rows
    : [];
  const plans = farming
    ? (await tx.query<{ id: string; farm_id: string; name: string }>("select id::text, farm_id::text, name from fertiliser_plans order by lower(name), fertiliser_plans.id")).rows
    : [];
  return {
    accounting: await accountingEnabled(tx),
    farming,
    farms: farms.map((farm) => ({ ...farm, plans: plans.filter((plan) => plan.farm_id === farm.id).map(({ id, name }) => ({ id, name })) })),
  };
}

/** PM25-PM27: what My mail's Filing card shows its owner: where things can go, what's filed, the rules and what's waiting. */
export async function filingOverview(tx: OrgTx, owner: MailOwner): Promise<FilingOverview> {
  owner.check(tx);
  return { options: await filingOptions(tx), filed: await listFiled(tx, owner), rules: await listRules(tx, owner), toFile: await listToFile(tx, owner) };
}

export const MAX_RULES = 50;

/**
 * PM26: a rule the owner approves once: attachments from a sender (or
 * anyone at a domain) and/or with a file name pattern wait in "To file"
 * for a destination, until the owner confirms each one (decision 723).
 * `includeExisting` also looks at emails already copied.
 */
export async function createRule(tx: OrgTx, owner: MailOwner, input: { copyId: unknown; sender?: unknown; fileName?: unknown; destination: unknown; includeExisting?: unknown }): Promise<MailRule[]> {
  owner.check(tx);
  if (owner.via !== "screen") throw notFound();
  const copyId = idOf(input.copyId);
  const { keys } = await ownCopyKeys(tx, owner, copyId);
  let sender: string | null;
  try {
    sender = normaliseSender(typeof input.sender === "string" ? input.sender : "");
  } catch (error) {
    throw new ValidationError(asProblem(error));
  }
  const fileName = text(input.fileName, "The file name pattern", 100);
  if (!sender && !fileName) throw new ValidationError("A rule needs a sender, a file name pattern, or both.");
  const destination = parseDestination(input.destination, { forRule: true });
  await destinationLabel(tx, destination);
  const count = await tx.query<{ count: number }>("select count(*)::int as count from private_mail_rules where owner_user_id = $1", [owner.userId]);
  if (count.rows[0].count >= MAX_RULES) throw new ValidationError(`You can have at most ${MAX_RULES} rules. Delete one first.`);
  const ref = randomUUID();
  const through =
    input.includeExisting === true ? 0 : Number((await tx.query<{ max: string | null }>("select max(id)::text as max from private_mail_attachments where copy_id = $1", [copyId])).rows[0].max ?? 0);
  await tx.query("insert into private_mail_rules (copy_id, owner_user_id, seal_ref, criteria, destination, checked_through) values ($1, $2, $3, $4, $5::jsonb, $6)", [
    copyId,
    owner.userId,
    ref,
    sealJson(keys, "rule", ref, { sender, fileName } satisfies RuleCriteria),
    JSON.stringify(destination),
    through,
  ]);
  await writeAuditEvent(tx, { eventType: "private_mail.rule_added", entityType: "private_mail_copy", entityId: copyId, details: {} });
  await matchRules(tx, { id: copyId, ownerUserId: owner.userId, keys });
  return listRules(tx, owner);
}

/** Deleting a rule drops what's waiting from it; what was filed stays filed. */
export async function deleteRule(tx: OrgTx, owner: MailOwner, ruleInput: unknown): Promise<void> {
  owner.check(tx);
  const id = idOf(ruleInput);
  const found = await tx.query<{ copy_id: string }>("delete from private_mail_rules where id = $1 and owner_user_id = $2 returning copy_id::text", [id, owner.userId]);
  if (!found.rows[0]) throw notFound();
  await writeAuditEvent(tx, { eventType: "private_mail.rule_deleted", entityType: "private_mail_copy", entityId: found.rows[0].copy_id, details: {} });
}

/** "Not this one": takes an attachment off "To file" without filing it. */
export async function dismissToFile(tx: OrgTx, owner: MailOwner, entryInput: unknown): Promise<void> {
  owner.check(tx);
  const id = idOf(entryInput);
  const found = await tx.query("update private_mail_to_file set status = 'dismissed', decided_at = now() where id = $1 and owner_user_id = $2 and status = 'waiting'", [id, owner.userId]);
  if (!found.rowCount) throw notFound();
}

export const MAX_RULE_CHECKS = 2000;

/**
 * PM27: checks the copy's attachments not yet checked against its rules,
 * and puts each match in "To file". Nothing is filed: the owner confirms
 * each one. Run after each sync (in its transaction) and when a rule is made.
 */
export async function matchRules(tx: OrgTx, copy: { id: string; ownerUserId: string; keys: CopyKeys }): Promise<number> {
  const rules = await tx.query<{ id: string; seal_ref: string; criteria: Buffer; checked_through: string }>(
    "select id::text, seal_ref, criteria, checked_through::text from private_mail_rules where copy_id = $1 and owner_user_id = $2 order by private_mail_rules.id for update",
    [copy.id, copy.ownerUserId],
  );
  if (!rules.rows.length) return 0;
  const from = rules.rows.reduce((least, rule) => (Number(rule.checked_through) < least ? Number(rule.checked_through) : least), Number.MAX_SAFE_INTEGER);
  const attachments = await tx.query<{ id: string; a_external: string; meta: Buffer; m_external: string; envelope: Buffer }>(
    `select a.id::text, a.external_id as a_external, a.meta, m.external_id as m_external, m.envelope
       from private_mail_attachments a join private_mail_messages m on m.id = a.message_id
      where a.copy_id = $1 and a.owner_user_id = $2 and a.id > $3 and a.content is not null
      order by a.id limit $4`,
    [copy.id, copy.ownerUserId, from, MAX_RULE_CHECKS],
  );
  const criteria = rules.rows.map((rule) => ({ ...rule, ...openJson<RuleCriteria>(copy.keys, "rule", rule.seal_ref, rule.criteria) }));
  let added = 0;
  const senders = new Map<string, string | null>();
  for (const attachment of attachments.rows) {
    const meta = openJson<AttachmentMeta>(copy.keys, "attachment-meta", `${attachment.m_external}/${attachment.a_external}`, attachment.meta);
    if (meta.inline) continue;
    if (!senders.has(attachment.m_external)) senders.set(attachment.m_external, openJson<Envelope>(copy.keys, "envelope", attachment.m_external, attachment.envelope).from?.email ?? null);
    for (const rule of criteria) {
      if (Number(attachment.id) <= Number(rule.checked_through)) continue;
      if (!ruleMatches(rule, { sender: senders.get(attachment.m_external) ?? null, fileName: meta.name })) continue;
      const inserted = await tx.query(
        "insert into private_mail_to_file (copy_id, owner_user_id, rule_id, attachment_id) values ($1, $2, $3, $4) on conflict (rule_id, attachment_id) do nothing",
        [copy.id, copy.ownerUserId, rule.id, attachment.id],
      );
      added += inserted.rowCount ?? 0;
    }
  }
  const last = attachments.rows[attachments.rows.length - 1]?.id;
  // Checked up to the last attachment looked at (or everything there is, when none were left).
  const through = attachments.rows.length === MAX_RULE_CHECKS ? last : (await tx.query<{ max: string | null }>("select max(id)::text as max from private_mail_attachments where copy_id = $1", [copy.id])).rows[0].max;
  if (through) await tx.query("update private_mail_rules set checked_through = greatest(checked_through, $2::bigint) where copy_id = $1", [copy.id, through]);
  return added;
}
