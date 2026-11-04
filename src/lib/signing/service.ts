import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { roleAtLeast } from "@/lib/auth/roles";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getOrganisationEmailSettings } from "@/lib/email/settings";
import { isEmailAddress } from "@/lib/email/addresses";
import { ConflictError, ForbiddenError, NotFoundError, PayloadTooLargeError, UnavailableError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { getOrganisation } from "@/lib/organisations/registry";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { hasPayrollAccess } from "@/lib/payroll/access";
import { buildSignedPdf, checkSignablePdf, sha256Hex } from "@/lib/signing/pdf";
import {
  allSigned,
  CODE_MAX_ATTEMPTS,
  CODE_MINUTES,
  CODE_PATTERN,
  CODES_PER_LINK,
  CONSENT_TEXT,
  DEFAULT_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  MAX_SIGNERS,
  MAX_SIGNING_PDF_BYTES,
  maskEmail,
  METHODS,
  type RequestStatus,
  requestState,
  SESSION_MINUTES,
  type SignatureMethod,
  type SignerStatus,
  type SignerView,
  signersToAsk,
  type SigningOrder,
  SIGNING_ORDERS,
  type SigningRequestView,
  SOURCE_KINDS,
  SOURCE_LABELS,
  type SourceKind,
} from "@/lib/signing/shared";
import { optionalString, requireArray, requireIdempotencyKey, requireOneOf, requireString, optionalSource } from "@/lib/validation";

/*
 * Signing requests (decisions 1396-1410, docs/E-SIGNATURES.md).
 *
 * - A request keeps the exact PDF bytes people are shown and their SHA-256
 *   (the fingerprint), worked out by the database. Nothing about the
 *   document or who signs changes after it's sent: a new version is a new
 *   request (the old one is voided).
 * - Each signer gets a one-time link (a long random token; only its hash is
 *   kept) that works until the request expires, while it's their turn. They
 *   prove they get email at their address with a 6-digit code before they
 *   can open the document or sign. A member named as a signer can instead
 *   sign in Tohyee, where their sign-in is the check.
 * - Signing is a typed name or a drawn signature, with "I agree to sign
 *   electronically" ticked, and records the time, IP address and browser.
 * - When the last person signs, the signed copy (signature page and audit
 *   certificate) is kept, and what the request was for is told (a quote is
 *   accepted, QT9).
 * - Emails go through the organisation's own email (Settings › Email). None
 *   are sent when it isn't set up, and the sender is told.
 */

export const LINK_PATH = "/sign";

export const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
const codeHash = (signerId: string, code: string) => createHash("sha256").update(`signing-code:${signerId}:${code}`, "utf8").digest("hex");

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

// Who may see and send ----------------------------------------------------------------------------

/**
 * Who may see a kind of request (decision 1403): quotes and financial
 * statements, viewers and up; employment agreements, people with payroll
 * access; inductions, those who keep safety records; other documents,
 * bookkeepers and up. A member named as a signer always sees their own.
 * Work Tohyee does itself (no person) sees everything.
 */
export async function canSeeKind(tx: OrgTx, kind: SourceKind): Promise<boolean> {
  if (!tx.actor.userId && !tx.actor.role) return true;
  const role = tx.actor.role;
  if (!role) return false;
  if (kind === "quote" || kind === "year_end") return roleAtLeast(role, "viewer");
  if (kind === "employment") return roleAtLeast(role, "bookkeeper") && (await hasPayrollAccess(tx));
  return roleAtLeast(role, "bookkeeper");
}

/** Who may send or void: bookkeepers and up, with payroll access for employment agreements. */
export async function canSendKind(tx: OrgTx, kind: SourceKind): Promise<boolean> {
  const role = tx.actor.role;
  if (!role || !tx.actor.userId) return false;
  if (!roleAtLeast(role, "bookkeeper")) return false;
  if (kind === "employment") return hasPayrollAccess(tx);
  return true;
}

async function requireSend(tx: OrgTx, kind: SourceKind): Promise<void> {
  if (!(await canSendKind(tx, kind))) {
    throw new ForbiddenError(kind === "employment" ? "Sending employment agreements needs payroll access." : "Sending documents to sign needs the bookkeeper role or higher.");
  }
}

// Email ---------------------------------------------------------------------------------------------

export type EmailReadiness = { ready: boolean; reason: string | null };

/** Whether signing emails can be sent: the organisation's email is set up (and it isn't the demo farm). */
export async function signingEmailReadiness(tx: OrgTx): Promise<EmailReadiness> {
  const organisation = await getOrganisation(tx.organisationId);
  if (organisation?.demo) return { ready: false, reason: "The demo farm doesn't send email, so no links or codes are sent." };
  const settings = await getOrganisationEmailSettings(tx);
  if (!settings.configured) return { ready: false, reason: "Email isn't set up for this organisation (Settings › Email), so Tohyee can't email links or codes." };
  return { ready: true, reason: null };
}

type EmailPurpose = "link" | "code" | "reminder" | "completed" | "declined" | "voided";

async function queueEmail(tx: OrgTx, email: { requestId: string; signerId: string | null; purpose: EmailPurpose; to: string; subject: string; body: string }): Promise<void> {
  await tx.query(
    "insert into signing_emails (request_id, signer_id, purpose, to_email, subject, body) values ($1, $2, $3, $4, $5, $6)",
    [email.requestId, email.signerId, email.purpose, email.to, email.subject.slice(0, 250), email.body.slice(0, 5000)],
  );
}

// Rows ------------------------------------------------------------------------------------------------

type RequestRow = {
  id: string;
  title: string;
  source_kind: SourceKind;
  source_id: string | null;
  status: RequestStatus;
  signing_order: SigningOrder;
  message: string | null;
  document_file_id: string;
  document_name: string;
  document_sha256: string;
  document_bytes: number;
  signed_file_id: string | null;
  signed_sha256: string | null;
  expires_at: Date;
  remind_every_days: number | null;
  last_reminded_at: Date | null;
  replaces_request_id: string | null;
  completed_at: Date | null;
  declined_at: Date | null;
  voided_at: Date | null;
  voided_by_email: string | null;
  void_reason: string | null;
  created_by_email: string;
  created_by_user_id: string | null;
  created_at: Date;
};

const REQUEST_SQL = `select r.id::text, r.title, r.source_kind, r.source_id, r.status, r.signing_order, r.message, r.document_file_id::text,
       d.file_name as document_name, r.document_sha256, d.size_bytes as document_bytes, r.signed_file_id::text, s.sha256 as signed_sha256,
       r.expires_at, r.remind_every_days, r.last_reminded_at, r.replaces_request_id::text, r.completed_at, r.declined_at, r.voided_at,
       r.voided_by_email, r.void_reason, r.created_by_email, r.created_by_user_id::text, r.created_at
  from signing_requests r
  join signing_files d on d.id = r.document_file_id
  left join signing_files s on s.id = r.signed_file_id`;

type SignerRow = {
  id: string;
  request_id: string;
  position: number;
  name: string;
  email: string;
  user_id: string | null;
  role_label: string | null;
  status: SignerStatus;
  link_sent_at: Date | null;
  viewed_at: Date | null;
  verified_at: Date | null;
  verified_by: "email_code" | "tohyee_sign_in" | null;
  signed_at: Date | null;
  method: SignatureMethod | null;
  typed_name: string | null;
  decline_reason: string | null;
  declined_at: Date | null;
};

const SIGNER_SQL = `select id::text, request_id::text, position, name, email, user_id::text, role_label, status, link_sent_at, viewed_at, verified_at,
       verified_by, signed_at, method, typed_name, decline_reason, declined_at from signing_signers`;

const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());

function toSigner(row: SignerRow): SignerView {
  return {
    id: row.id,
    position: row.position,
    name: row.name,
    email: row.email,
    userId: row.user_id,
    roleLabel: row.role_label,
    status: row.status,
    linkSentAt: iso(row.link_sent_at),
    viewedAt: iso(row.viewed_at),
    verifiedAt: iso(row.verified_at),
    verifiedBy: row.verified_by,
    signedAt: iso(row.signed_at),
    method: row.method,
    typedName: row.typed_name,
    declineReason: row.decline_reason,
    declinedAt: iso(row.declined_at),
  };
}

async function loadSigners(tx: OrgTx, requestIds: string[]): Promise<Map<string, SignerView[]>> {
  const map = new Map<string, SignerView[]>();
  if (!requestIds.length) return map;
  const rows = await tx.query<SignerRow>(`${SIGNER_SQL} where request_id = any($1::bigint[]) order by request_id, position`, [requestIds]);
  for (const row of rows.rows) {
    const list = map.get(row.request_id) ?? [];
    list.push(toSigner(row));
    map.set(row.request_id, list);
  }
  return map;
}

function toView(row: RequestRow, signers: SignerView[], now = new Date()): SigningRequestView {
  return {
    id: row.id,
    title: row.title,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    status: row.status,
    state: requestState(row.status, iso(row.expires_at)!, now),
    signingOrder: row.signing_order,
    message: row.message,
    documentFileId: row.document_file_id,
    documentName: row.document_name,
    documentSha256: row.document_sha256,
    documentBytes: row.document_bytes,
    signedFileId: row.signed_file_id,
    signedSha256: row.signed_sha256,
    expiresAt: iso(row.expires_at)!,
    remindEveryDays: row.remind_every_days,
    lastRemindedAt: iso(row.last_reminded_at),
    replacesRequestId: row.replaces_request_id,
    completedAt: iso(row.completed_at),
    declinedAt: iso(row.declined_at),
    voidedAt: iso(row.voided_at),
    voidedByEmail: row.voided_by_email,
    voidReason: row.void_reason,
    createdByEmail: row.created_by_email,
    createdAt: iso(row.created_at)!,
    signers,
    emails: [],
    events: [],
  };
}

async function visible(tx: OrgTx, row: Pick<RequestRow, "id" | "source_kind">, signers: SignerView[] | undefined): Promise<boolean> {
  if (await canSeeKind(tx, row.source_kind)) return true;
  return Boolean(tx.actor.userId && signers?.some((signer) => signer.userId === tx.actor.userId));
}

export type SigningListFilter = { sourceKind?: unknown; sourceId?: unknown; state?: unknown; limit?: unknown };

/** Signing requests the person may see, newest first, optionally for one source (a quote, a year). */
export async function listSigningRequests(tx: OrgTx, filter: SigningListFilter = {}): Promise<SigningRequestView[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.sourceKind !== undefined && filter.sourceKind !== null && filter.sourceKind !== "") {
    params.push(requireOneOf(filter.sourceKind, "sourceKind", SOURCE_KINDS));
    where.push(`r.source_kind = $${params.length}`);
  }
  if (filter.sourceId !== undefined && filter.sourceId !== null && filter.sourceId !== "") {
    params.push(String(filter.sourceId).slice(0, 100));
    where.push(`r.source_id = $${params.length}`);
  }
  const limit = Math.min(Math.max(Number.parseInt(String(filter.limit ?? "200"), 10) || 200, 1), 500);
  const rows = await tx.query<RequestRow>(`${REQUEST_SQL} ${where.length ? `where ${where.join(" and ")}` : ""} order by r.id desc limit ${limit}`, params);
  const signers = await loadSigners(tx, rows.rows.map((row) => row.id));
  const now = new Date();
  const views: SigningRequestView[] = [];
  for (const row of rows.rows) {
    if (!(await visible(tx, row, signers.get(row.id)))) continue;
    const view = toView(row, signers.get(row.id) ?? [], now);
    if (filter.state && view.state !== filter.state) continue;
    views.push(view);
  }
  return views;
}

async function requestRow(tx: OrgTx, idInput: unknown, lock = false): Promise<RequestRow> {
  const id = typeof idInput === "string" || typeof idInput === "number" ? String(idInput) : "";
  if (!/^[1-9][0-9]{0,17}$/.test(id)) throw new NotFoundError("Signing request not found.");
  if (lock) await tx.query("select id from signing_requests where id = $1 for update", [id]);
  const row = (await tx.query<RequestRow>(`${REQUEST_SQL} where r.id = $1`, [id])).rows[0];
  if (!row) throw new NotFoundError("Signing request not found.");
  return row;
}

/** One request with its signers, emails and history, if the person may see it. */
export async function getSigningRequest(tx: OrgTx, idInput: unknown): Promise<SigningRequestView> {
  const row = await requestRow(tx, idInput);
  const signers = (await loadSigners(tx, [row.id])).get(row.id) ?? [];
  if (!(await visible(tx, row, signers))) throw new NotFoundError("Signing request not found.");
  const view = toView(row, signers);
  const emails = await tx.query<{ purpose: string; to_email: string; status: string; last_error: string | null; created_at: Date }>(
    "select purpose, to_email, status, last_error, created_at from signing_emails where request_id = $1 order by signing_emails.id",
    [row.id],
  );
  view.emails = emails.rows.map((email) => ({ purpose: email.purpose, toEmail: email.to_email, status: email.status, lastError: email.last_error, createdAt: iso(email.created_at)! }));
  const events = await tx.query<{ id: string; event: string; at: Date; signer_id: string | null; actor_email: string | null; ip_address: string | null; details: Record<string, unknown> }>(
    "select id::text, event, at, signer_id::text, actor_email, ip_address, details from signing_events where request_id = $1 order by signing_events.id",
    [row.id],
  );
  view.events = events.rows.map((event) => ({ id: event.id, event: event.event, at: iso(event.at)!, signerId: event.signer_id, actorEmail: event.actor_email, ipAddress: event.ip_address, details: event.details ?? {} }));
  return view;
}

async function addEvent(tx: OrgTx, event: { requestId: string; signerId?: string | null; event: string; actorEmail?: string | null; ip?: string | null; userAgent?: string | null; details?: Record<string, unknown> }) {
  await tx.query(
    "insert into signing_events (request_id, signer_id, event, actor_email, ip_address, user_agent, details) values ($1, $2, $3, $4, $5, $6, $7::jsonb)",
    [event.requestId, event.signerId ?? null, event.event, event.actorEmail ?? null, event.ip?.slice(0, 100) ?? null, event.userAgent?.slice(0, 500) ?? null, JSON.stringify(event.details ?? {})],
  );
}

// Members -----------------------------------------------------------------------------------------------

/** The organisation's members by lower-cased email (read from the core database before the transaction opens). */
export type MemberDirectory = ReadonlyMap<string, { userId: string; name: string }>;

export async function loadMemberDirectory(organisationId: string): Promise<MemberDirectory> {
  const rows = await coreQuery<{ user_id: string; email: string; display_name: string }>(
    "select m.user_id::text, u.email, u.display_name from organisation_members m join users u on u.id = m.user_id where m.organisation_id = $1",
    [organisationId],
  );
  return new Map(rows.rows.map((row) => [row.email.toLowerCase(), { userId: row.user_id, name: row.display_name }]));
}

// Sending ------------------------------------------------------------------------------------------------

export type SignerInput = { name: string; email: string; userId: string | null; roleLabel: string | null };

/** The signer list: 1-20 people, each with a name and an email address, no address twice. A member is matched by their email. */
export function parseSigners(input: unknown, members: MemberDirectory): SignerInput[] {
  const list = requireArray(input, "Signers", MAX_SIGNERS);
  if (!list.length) throw new ValidationError("Add at least one person to sign.");
  const seen = new Set<string>();
  return list.map((value, index) => {
    const item = (value ?? {}) as Record<string, unknown>;
    const label = `Signer ${index + 1}`;
    const name = requireString(item.name, `${label}'s name`, { maxLength: 150 });
    const email = requireString(item.email, `${label}'s email`, { maxLength: 320 }).toLowerCase();
    if (!isEmailAddress(email)) throw new ValidationError(`${label}'s email isn't an email address.`);
    if (seen.has(email)) throw new ValidationError(`${email} is on the list twice. Each person signs once.`);
    seen.add(email);
    const member = members.get(email);
    if (item.userId && (!member || member.userId !== item.userId)) throw new ValidationError(`${label} isn't a member of this organisation with that email.`);
    return { name, email, userId: member?.userId ?? null, roleLabel: optionalString(item.roleLabel, `${label}'s role`, { maxLength: 100 }) };
  });
}

export type CreateSigningInput = {
  source?: unknown;
  idempotencyKey: unknown;
  title: unknown;
  sourceKind: SourceKind;
  sourceId: string | null;
  fileName: string;
  bytes: Uint8Array;
  signers: unknown;
  signingOrder?: unknown;
  message?: unknown;
  expiresInDays?: unknown;
  remindEveryDays?: unknown;
  replacesRequestId?: unknown;
};

export type SendContext = { origin: string; members: MemberDirectory };

export type SendResult = { created: boolean; request: SigningRequestView; emailNote: string | null };

/**
 * Sends a PDF to sign. The bytes are kept exactly as given and their
 * fingerprint worked out by the database. People who aren't members need
 * email to be set up (for their link and code); members can sign in Tohyee
 * without it. `replacesRequestId` voids an earlier request for the same
 * thing (a new version).
 */
export async function createSigningRequest(tx: OrgTx, input: CreateSigningInput, context: SendContext): Promise<SendResult> {
  await requireSend(tx, input.sourceKind);
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const title = requireString(input.title, "Title", { maxLength: 200 });
  const signers = parseSigners(input.signers, context.members);
  const signingOrder = requireOneOf(input.signingOrder ?? "in_order", "Signing order", SIGNING_ORDERS);
  const message = optionalString(input.message, "Message", { maxLength: 2000 });
  const expiresInDays = input.expiresInDays === undefined || input.expiresInDays === null || input.expiresInDays === "" ? DEFAULT_EXPIRY_DAYS : Number(input.expiresInDays);
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > MAX_EXPIRY_DAYS) throw new ValidationError(`Choose how long the links work: 1 to ${MAX_EXPIRY_DAYS} days.`);
  const remindEveryDays = input.remindEveryDays === undefined || input.remindEveryDays === null || input.remindEveryDays === "" || input.remindEveryDays === 0 ? null : Number(input.remindEveryDays);
  if (remindEveryDays !== null && (!Number.isInteger(remindEveryDays) || remindEveryDays < 1 || remindEveryDays > 30)) throw new ValidationError("Reminders can be every 1 to 30 days, or off.");
  if (input.bytes.length > MAX_SIGNING_PDF_BYTES) throw new PayloadTooLargeError("A PDF to sign can be at most 25 MB.");
  await checkSignablePdf(input.bytes);
  const fileName = (input.fileName.trim() || "document.pdf").replace(/[\\/\0\r\n]+/g, "_").slice(0, 200);
  const documentSha256 = sha256Hex(input.bytes);
  const replacesRequestId = input.replacesRequestId ? String(input.replacesRequestId) : null;
  const hash = requestHash("signing_request", { title, sourceKind: input.sourceKind, sourceId: input.sourceId, documentSha256, signers, signingOrder, message, expiresInDays, remindEveryDays, replacesRequestId });

  const earlier = await tx.query<{ id: string; request_hash: string }>("select id::text, request_hash from signing_requests where command_source = $1 and idempotency_key = $2", [source, idempotencyKey]);
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "signing request");
    return { created: false, request: await getSigningRequest(tx, earlier.rows[0].id), emailNote: null };
  }

  const email = await signingEmailReadiness(tx);
  const outsiders = signers.filter((signer) => !signer.userId);
  if (!email.ready && outsiders.length) {
    throw new UnavailableError(`${email.reason} People without a Tohyee login (${outsiders.map((signer) => signer.name).join(", ")}) need an emailed link and code, so it can't be sent yet.`);
  }

  if (replacesRequestId) {
    const old = await requestRow(tx, replacesRequestId, true);
    if (old.source_kind !== input.sourceKind || old.source_id !== input.sourceId) throw new ValidationError("A new version must be for the same thing as the request it replaces.");
  }

  const fileId = randomUUID();
  await tx.query(
    "insert into signing_files (id, kind, file_name, content_type, size_bytes, sha256, content, created_by_user_id, created_by_email) values ($1, 'document', $2, 'application/pdf', 1, $3, $4, $5, $6)",
    [fileId, fileName, "0".repeat(64), Buffer.from(input.bytes), tx.actor.userId, tx.actor.email],
  );
  const inserted = await tx.query<{ id: string }>(
    `insert into signing_requests (command_source, idempotency_key, request_hash, title, source_kind, source_id, document_file_id, document_sha256,
                                   signing_order, message, expires_at, remind_every_days, replaces_request_id, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(days => $11), $12, $13, $14, $15)
     on conflict (command_source, idempotency_key) do nothing
     returning id::text`,
    [source, idempotencyKey, hash, title, input.sourceKind, input.sourceId, fileId, documentSha256, signingOrder, message, expiresInDays, remindEveryDays, replacesRequestId, tx.actor.userId, tx.actor.email],
  );
  if (!inserted.rows[0]) throw new ConflictError("That request is being sent by another request. Try again.");
  const requestId = inserted.rows[0].id;
  for (const [index, signer] of signers.entries()) {
    await tx.query("insert into signing_signers (request_id, position, name, email, user_id, role_label) values ($1, $2, $3, $4, $5, $6)", [
      requestId,
      index + 1,
      signer.name,
      signer.email,
      signer.userId,
      signer.roleLabel,
    ]);
  }
  await addEvent(tx, { requestId, event: "sent", actorEmail: tx.actor.email, details: { documentSha256, signers: signers.length, signingOrder } });
  await writeAuditEvent(tx, { eventType: "signing.sent", entityType: "signing_request", entityId: requestId, details: { sourceKind: input.sourceKind, sourceId: input.sourceId, documentSha256, signers: signers.length } });
  if (replacesRequestId) await voidRequest(tx, replacesRequestId, `Replaced by a new version (request ${requestId}).`, { quiet: false, newRequestId: requestId });
  await askNext(tx, requestId, context.origin, email);
  return {
    created: true,
    request: await getSigningRequest(tx, requestId),
    emailNote: email.ready ? null : `${email.reason} Members on the list can sign in Tohyee (Signing).`,
  };
}

function linkFor(origin: string, organisationId: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}${LINK_PATH}/${organisationId}/${token}`;
}

async function organisationName(tx: OrgTx): Promise<string> {
  return (await getOrganisationSettings(tx)).displayName;
}

/** Gives each signer whose turn it is a link (a new token) and emails it, if email is set up. */
async function askNext(tx: OrgTx, requestId: string, origin: string, email: EmailReadiness, purpose: "link" | "reminder" = "link"): Promise<void> {
  const request = await requestRow(tx, requestId);
  const signers = (await tx.query<SignerRow>(`${SIGNER_SQL} where request_id = $1 order by position`, [requestId])).rows;
  const toAsk = signersToAsk(request.signing_order, signers);
  const name = await organisationName(tx);
  for (const signer of signers) {
    if (!toAsk.includes(signer.position)) continue;
    if (purpose === "link" && signer.status === "ready") continue;
    await sendLink(tx, request, signer, origin, email, name, purpose);
  }
}

async function sendLink(tx: OrgTx, request: RequestRow, signer: SignerRow, origin: string, email: EmailReadiness, name: string, purpose: "link" | "reminder"): Promise<void> {
  const token = newToken();
  await tx.query("update signing_signers set status = 'ready', token_hash = $2, link_sent_at = now() where id = $1", [signer.id, hashToken(token)]);
  if (!email.ready) return;
  const expires = new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", day: "numeric", month: "long", year: "numeric" }).format(new Date(request.expires_at));
  const lines = [
    `Kia ora ${signer.name},`,
    "",
    `${name} has asked you to sign ${request.title}.`,
    ...(request.message ? ["", request.message] : []),
    "",
    `Open it here: ${linkFor(origin, tx.organisationId, token)}`,
    "",
    `The link works until ${expires}. Before you sign, Tohyee emails you a code to check it's you. ${purpose === "reminder" ? "This reminder has a new link: earlier links no longer work." : ""}`.trim(),
    "",
    "If you weren't expecting this, you can ignore it or reply to this email.",
  ];
  await queueEmail(tx, { requestId: request.id, signerId: signer.id, purpose, to: signer.email, subject: `${purpose === "reminder" ? "Reminder: " : ""}Please sign: ${request.title}`, body: lines.join("\n") });
  await addEvent(tx, { requestId: request.id, signerId: signer.id, event: purpose === "reminder" ? "reminded" : "link_emailed", details: { to: signer.email } });
}

/** Sends a signer a new link (the old one stops working). */
export async function resendSigningLink(tx: OrgTx, requestIdInput: unknown, signerIdInput: unknown, origin: string): Promise<SigningRequestView> {
  const request = await requestRow(tx, requestIdInput, true);
  await requireSend(tx, request.source_kind);
  if (requestState(request.status, iso(request.expires_at)!) !== "sent") throw new ConflictError("This request isn't waiting for signatures any more.");
  const signer = (await tx.query<SignerRow>(`${SIGNER_SQL} where request_id = $1 and id = $2`, [request.id, String(signerIdInput ?? "")])).rows[0];
  if (!signer) throw new NotFoundError("That signer wasn't found.");
  if (signer.status !== "ready") throw new ConflictError(signer.status === "waiting" ? "It isn't their turn yet." : `They've already ${signer.status}.`);
  const email = await signingEmailReadiness(tx);
  if (!email.ready) throw new UnavailableError(email.reason!);
  await sendLink(tx, request, signer, origin, email, await organisationName(tx), "link");
  await addEvent(tx, { requestId: request.id, signerId: signer.id, event: "link_resent", actorEmail: tx.actor.email });
  return getSigningRequest(tx, request.id);
}

// Voiding --------------------------------------------------------------------------------------------------

async function voidRequest(tx: OrgTx, requestId: string, reason: string, options: { quiet: boolean; newRequestId?: string }): Promise<void> {
  const request = await requestRow(tx, requestId, true);
  if (request.status !== "sent") throw new ConflictError(`This request is already ${request.status === "completed" ? "signed" : request.status}.`);
  await tx.query(
    "update signing_requests set status = 'voided', voided_at = now(), voided_by_user_id = $2, voided_by_email = $3, void_reason = $4 where id = $1",
    [request.id, tx.actor.userId, tx.actor.email, reason],
  );
  await tx.query("update signing_signers set token_hash = null, session_hash = null, session_expires_at = null where request_id = $1", [request.id]);
  await addEvent(tx, { requestId: request.id, event: "voided", actorEmail: tx.actor.email, details: { reason, ...(options.newRequestId ? { newRequestId: options.newRequestId } : {}) } });
  await writeAuditEvent(tx, { eventType: "signing.voided", entityType: "signing_request", entityId: request.id, details: { reason } });
  if (options.quiet) return;
  const email = await signingEmailReadiness(tx);
  if (!email.ready) return;
  const asked = (await tx.query<SignerRow>(`${SIGNER_SQL} where request_id = $1 and link_sent_at is not null order by position`, [request.id])).rows;
  const name = await organisationName(tx);
  for (const signer of asked) {
    await queueEmail(tx, {
      requestId: request.id,
      signerId: signer.id,
      purpose: "voided",
      to: signer.email,
      subject: `No longer needed: ${request.title}`,
      body: [`Kia ora ${signer.name},`, "", `${name} has withdrawn ${request.title}, so you don't need to sign it. The link no longer works.`, "", `Why: ${reason}`].join("\n"),
    });
  }
}

/** Voids an open request (the sender gives a reason). Signatures already given stay in its history. */
export async function voidSigningRequest(tx: OrgTx, requestIdInput: unknown, input: { reason?: unknown }): Promise<SigningRequestView> {
  const request = await requestRow(tx, requestIdInput, true);
  await requireSend(tx, request.source_kind);
  const reason = requireString(input.reason, "Why it's voided", { maxLength: 1000 });
  await voidRequest(tx, request.id, reason, { quiet: false });
  return getSigningRequest(tx, request.id);
}

/** Voids every open request for a source (a quote accepted in Tohyee, QT11). */
export async function voidOpenRequestsFor(tx: OrgTx, kind: SourceKind, sourceId: string, reason: string): Promise<void> {
  const open = await tx.query<{ id: string }>("select id::text from signing_requests where source_kind = $1 and source_id = $2 and status = 'sent'", [kind, sourceId]);
  for (const row of open.rows) await voidRequest(tx, row.id, reason, { quiet: false });
}

// Signing ----------------------------------------------------------------------------------------------------

export type SignInput = { method?: unknown; typedName?: unknown; signaturePng?: unknown; consent?: unknown; documentSha256?: unknown };
export type SignMeta = { ip: string | null; userAgent: string | null; origin: string };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Checks what a signer sends: consent ticked, the fingerprint they were shown, a name, and for a drawing a small PNG. */
export function parseSignature(input: SignInput, documentSha256: string): { method: SignatureMethod; typedName: string; png: Buffer | null } {
  if (input.consent !== true) throw new ValidationError(`Tick "${CONSENT_TEXT}" to sign.`);
  if (typeof input.documentSha256 !== "string" || input.documentSha256.toLowerCase() !== documentSha256) {
    throw new ConflictError("The document you were shown isn't the one on this request. Reload the page and read it again.");
  }
  const method = requireOneOf(input.method, "How you sign", METHODS);
  const typedName = requireString(input.typedName, "Your full name", { maxLength: 150 });
  if (method === "typed") return { method, typedName, png: null };
  const raw = typeof input.signaturePng === "string" ? input.signaturePng.replace(/^data:image\/png;base64,/, "") : "";
  if (!raw) throw new ValidationError("Draw your signature in the box, or type your name instead.");
  const png = Buffer.from(raw, "base64");
  if (png.length < 67 || png.length > 262144 || !png.subarray(0, 8).equals(PNG_MAGIC)) throw new ValidationError("The drawn signature couldn't be read. Clear it and draw it again, or type your name instead.");
  return { method, typedName, png };
}

type FullSigner = SignerRow & { session_hash: string | null; session_expires_at: Date | null };

async function recordSignature(tx: OrgTx, request: RequestRow, signer: FullSigner, input: SignInput, meta: SignMeta, verifiedBy: "email_code" | "tohyee_sign_in"): Promise<void> {
  await tx.query("select id from signing_requests where id = $1 for update", [request.id]);
  const signature = parseSignature(input, request.document_sha256);
  if (!signer.viewed_at) throw new ValidationError("Open the document and read it before you sign.");
  await tx.query(
    `update signing_signers set status = 'signed', signed_at = now(), method = $2, typed_name = $3, signature_png = $4, consent_text = $5, signed_sha256 = $6,
            ip_address = $7, user_agent = $8, token_hash = null, session_hash = null, session_expires_at = null,
            verified_at = coalesce(verified_at, now()), verified_by = coalesce(verified_by, $9)
      where id = $1`,
    [signer.id, signature.method, signature.typedName, signature.png, CONSENT_TEXT, request.document_sha256, meta.ip?.slice(0, 100) ?? null, meta.userAgent?.slice(0, 500) ?? null, verifiedBy],
  );
  await addEvent(tx, { requestId: request.id, signerId: signer.id, event: "signed", actorEmail: signer.email, ip: meta.ip, userAgent: meta.userAgent, details: { method: signature.method, typedName: signature.typedName, documentSha256: request.document_sha256, verifiedBy } });
  await writeAuditEvent(tx, { eventType: "signing.signed", entityType: "signing_request", entityId: request.id, details: { signer: signer.email, method: signature.method } });
  const signers = (await tx.query<SignerRow>(`${SIGNER_SQL} where request_id = $1 order by position`, [request.id])).rows;
  if (allSigned(signers)) await completeRequest(tx, request, meta.origin);
  else await askNext(tx, request.id, meta.origin, await signingEmailReadiness(tx));
}

async function completeRequest(tx: OrgTx, request: RequestRow, origin: string): Promise<void> {
  const original = (await tx.query<{ content: Buffer }>("select content from signing_files where id = $1", [request.document_file_id])).rows[0].content;
  const signers = (
    await tx.query<SignerRow & { signature_png: Buffer | null; ip_address: string | null; user_agent: string | null; signed_sha256: string; consent_text: string }>(
      `select id::text, request_id::text, position, name, email, user_id::text, role_label, status, link_sent_at, viewed_at, verified_at, verified_by, signed_at,
              method, typed_name, decline_reason, declined_at, signature_png, ip_address, user_agent, signed_sha256, consent_text
         from signing_signers where request_id = $1 order by position`,
      [request.id],
    )
  ).rows;
  const completedAt = new Date().toISOString();
  const name = await organisationName(tx);
  const bytes = await buildSignedPdf(new Uint8Array(original), {
    requestId: request.id,
    title: request.title,
    organisationName: name,
    documentName: request.document_name,
    documentSha256: request.document_sha256,
    sentAt: iso(request.created_at)!,
    sentByEmail: request.created_by_email,
    completedAt,
    consentText: CONSENT_TEXT,
    signers: signers.map((signer) => ({
      position: signer.position,
      name: signer.name,
      email: signer.email,
      roleLabel: signer.role_label,
      signedAt: iso(signer.signed_at)!,
      method: signer.method!,
      typedName: signer.typed_name!,
      signaturePng: signer.signature_png ? new Uint8Array(signer.signature_png) : null,
      verifiedBy: signer.verified_by ?? "email_code",
      verifiedAt: iso(signer.verified_at)!,
      ipAddress: signer.ip_address,
      userAgent: signer.user_agent,
      signedSha256: signer.signed_sha256,
    })),
  });
  const fileId = randomUUID();
  const signedName = request.document_name.replace(/\.pdf$/i, "").slice(0, 180) + " (signed).pdf";
  await tx.query(
    "insert into signing_files (id, kind, file_name, content_type, size_bytes, sha256, content, created_by_user_id, created_by_email) values ($1, 'signed', $2, 'application/pdf', 1, $3, $4, null, 'signing')",
    [fileId, signedName, "0".repeat(64), Buffer.from(bytes)],
  );
  await tx.query("update signing_requests set status = 'completed', signed_file_id = $2, completed_at = $3 where id = $1", [request.id, fileId, completedAt]);
  const sha = (await tx.query<{ sha256: string }>("select sha256 from signing_files where id = $1", [fileId])).rows[0].sha256;
  await addEvent(tx, { requestId: request.id, event: "completed", details: { signedSha256: sha } });
  await writeAuditEvent(tx, { eventType: "signing.completed", entityType: "signing_request", entityId: request.id, details: { signedSha256: sha } });
  await sourceHooks(request.source_kind).completed?.(tx, request, signers);
  const email = await signingEmailReadiness(tx);
  if (!email.ready) return;
  for (const signer of signers) {
    const copyToken = newToken();
    await tx.query("update signing_signers set copy_token_hash = $2, copy_expires_at = now() + interval '30 days' where id = $1", [signer.id, hashToken(copyToken)]);
    await queueEmail(tx, {
      requestId: request.id,
      signerId: signer.id,
      purpose: "completed",
      to: signer.email,
      subject: `Signed: ${request.title}`,
      body: [
        `Kia ora ${signer.name},`,
        "",
        `Everyone has signed ${request.title}.`,
        "",
        `Download the signed copy (for 30 days): ${linkFor(origin, tx.organisationId, copyToken)}/copy`,
        "",
        `It ends with a signing certificate. Its document fingerprint (SHA-256) is ${request.document_sha256}.`,
      ].join("\n"),
    });
  }
  if (!signers.some((signer) => signer.email === request.created_by_email.toLowerCase()) && isEmailAddress(request.created_by_email)) {
    await queueEmail(tx, { requestId: request.id, signerId: null, purpose: "completed", to: request.created_by_email, subject: `Signed: ${request.title}`, body: `Everyone has signed ${request.title}. The signed copy is kept in Tohyee with the request.` });
  }
}

async function recordDecline(tx: OrgTx, request: RequestRow, signer: SignerRow, reasonInput: unknown, meta: SignMeta): Promise<void> {
  const reason = requireString(reasonInput, "Why you're declining", { maxLength: 1000 });
  await tx.query("update signing_signers set status = 'declined', declined_at = now(), decline_reason = $2, token_hash = null, session_hash = null, session_expires_at = null, ip_address = $3, user_agent = $4 where id = $1", [
    signer.id,
    reason,
    meta.ip?.slice(0, 100) ?? null,
    meta.userAgent?.slice(0, 500) ?? null,
  ]);
  await tx.query("update signing_requests set status = 'declined', declined_at = now() where id = $1", [request.id]);
  await tx.query("update signing_signers set token_hash = null, session_hash = null, session_expires_at = null where request_id = $1", [request.id]);
  await addEvent(tx, { requestId: request.id, signerId: signer.id, event: "declined", actorEmail: signer.email, ip: meta.ip, userAgent: meta.userAgent, details: { reason } });
  await writeAuditEvent(tx, { eventType: "signing.declined", entityType: "signing_request", entityId: request.id, details: { signer: signer.email, reason } });
  await sourceHooks(request.source_kind).declined?.(tx, request, signer, reason);
  const email = await signingEmailReadiness(tx);
  if (email.ready && isEmailAddress(request.created_by_email)) {
    await queueEmail(tx, { requestId: request.id, signerId: signer.id, purpose: "declined", to: request.created_by_email, subject: `Declined: ${request.title}`, body: `${signer.name} (${signer.email}) declined to sign ${request.title}.\n\nTheir reason: ${reason}` });
  }
}

// What each source does when its request finishes ----------------------------------------------------------

type Hooks = {
  completed?: (tx: OrgTx, request: RequestRow, signers: SignerRow[]) => Promise<void>;
  declined?: (tx: OrgTx, request: RequestRow, signer: SignerRow, reason: string) => Promise<void>;
};

function sourceHooks(kind: SourceKind): Hooks {
  if (kind === "quote") {
    return {
      async completed(tx, request, signers) {
        const { acceptQuoteBySigning } = await import("@/lib/quotes/service");
        await acceptQuoteBySigning(tx, request.source_id!, { requestId: request.id, signerName: signers[0].name, signerEmail: signers[0].email });
      },
      async declined(tx, request, signer, reason) {
        const { declineQuoteBySigning } = await import("@/lib/quotes/service");
        await declineQuoteBySigning(tx, request.source_id!, { requestId: request.id, signerEmail: signer.email, reason });
      },
    };
  }
  return {};
}

// A member signing in Tohyee --------------------------------------------------------------------------------

async function ownSigner(tx: OrgTx, request: RequestRow): Promise<FullSigner> {
  if (!tx.actor.userId) throw new ForbiddenError("Sign in to Tohyee to sign.");
  const signer = (await tx.query<FullSigner>(`select s.*, s.id::text, s.request_id::text, s.user_id::text from signing_signers s where request_id = $1 and user_id = $2`, [request.id, tx.actor.userId])).rows[0];
  if (!signer) throw new NotFoundError("You're not one of the people asked to sign this.");
  if (requestState(request.status, iso(request.expires_at)!) !== "sent") throw new ConflictError("This request isn't waiting for signatures any more.");
  if (signer.status !== "ready") throw new ConflictError(signer.status === "waiting" ? "It isn't your turn to sign yet." : `You've already ${signer.status}.`);
  return signer;
}

/** A member named as a signer signs in Tohyee: their sign-in is the identity check. */
export async function signAsMember(tx: OrgTx, requestIdInput: unknown, input: SignInput, meta: SignMeta): Promise<SigningRequestView> {
  const request = await requestRow(tx, requestIdInput, true);
  const signer = await ownSigner(tx, request);
  await tx.query("update signing_signers set verified_at = coalesce(verified_at, now()), verified_by = coalesce(verified_by, 'tohyee_sign_in') where id = $1", [signer.id]);
  await recordSignature(tx, request, signer, input, meta, "tohyee_sign_in");
  return getSigningRequest(tx, request.id);
}

/** A member named as a signer declines in Tohyee. */
export async function declineAsMember(tx: OrgTx, requestIdInput: unknown, input: { reason?: unknown }, meta: SignMeta): Promise<SigningRequestView> {
  const request = await requestRow(tx, requestIdInput, true);
  const signer = await ownSigner(tx, request);
  await recordDecline(tx, request, signer, input.reason, meta);
  return getSigningRequest(tx, request.id);
}

// Files ------------------------------------------------------------------------------------------------------

/** A request's document or signed copy, for a person who may see the request. A signer opening the document counts as viewing it. */
export async function readSigningFile(tx: OrgTx, requestIdInput: unknown, which: "document" | "signed"): Promise<{ fileName: string; content: Buffer; sha256: string }> {
  const view = await getSigningRequest(tx, requestIdInput);
  const fileId = which === "document" ? view.documentFileId : view.signedFileId;
  if (!fileId) throw new NotFoundError("There's no signed copy yet.");
  const row = (await tx.query<{ file_name: string; content: Buffer; sha256: string }>("select file_name, content, sha256 from signing_files where id = $1", [fileId])).rows[0];
  if (which === "document" && tx.actor.userId) {
    const own = view.signers.find((signer) => signer.userId === tx.actor.userId && signer.status === "ready" && !signer.viewedAt);
    if (own) {
      await tx.query("update signing_signers set viewed_at = now() where id = $1 and viewed_at is null", [own.id]);
      await addEvent(tx, { requestId: view.id, signerId: own.id, event: "viewed", actorEmail: tx.actor.email });
    }
  }
  return { fileName: row.file_name, content: row.content, sha256: row.sha256 };
}

export type CopyCheck = { sha256: string; result: "signed" | "document" | "changed"; requestId: string | null; title: string | null; completedAt: string | null };

/**
 * Checks a copy (decision 1402): works out its SHA-256 and looks for a
 * signed copy, or a document as it was sent, that Tohyee kept with the same
 * fingerprint, among the requests the person may see.
 */
export async function checkSigningCopy(tx: OrgTx, bytes: Uint8Array, requestIdInput?: unknown): Promise<CopyCheck> {
  const sha256 = sha256Hex(bytes);
  const rows = await tx.query<{ id: string; source_kind: SourceKind; kind: "document" | "signed"; title: string; completed_at: Date | null }>(
    `select r.id::text, r.source_kind, f.kind, r.title, r.completed_at from signing_files f
       join signing_requests r on r.document_file_id = f.id or r.signed_file_id = f.id
      where f.sha256 = $1 order by f.kind desc, r.id desc`,
    [sha256],
  );
  for (const row of rows.rows) {
    if (requestIdInput && row.id !== String(requestIdInput)) continue;
    const signers = (await loadSigners(tx, [row.id])).get(row.id);
    if (!(await visible(tx, row, signers))) continue;
    return { sha256, result: row.kind, requestId: row.id, title: row.title, completedAt: iso(row.completed_at) };
  }
  return { sha256, result: "changed", requestId: requestIdInput ? String(requestIdInput) : null, title: null, completedAt: null };
}

// The signer's link (no Tohyee login) -------------------------------------------------------------------------

export type LinkSigner = FullSigner & {
  code_hash: string | null;
  code_expires_at: Date | null;
  code_attempts: number;
  codes_sent: number;
  code_sent_at: Date | null;
};

/** The open request and signer a link token belongs to, or null (wrong, used, voided, expired or not their turn: all the same). */
export async function signerForToken(tx: OrgTx, token: string): Promise<{ request: RequestRow; signer: LinkSigner } | null> {
  const signer = (
    await tx.query<LinkSigner>(
      `select s.*, s.id::text, s.request_id::text, s.user_id::text from signing_signers s join signing_requests r on r.id = s.request_id
        where s.token_hash = $1 and s.status = 'ready' and r.status = 'sent' and r.expires_at > now() for update of s`,
      [hashToken(token)],
    )
  ).rows[0];
  if (!signer) return null;
  return { request: await requestRow(tx, signer.request_id), signer };
}

function sessionValid(signer: LinkSigner, session: string | null): boolean {
  if (!session || !signer.session_hash || !signer.session_expires_at) return false;
  if (new Date(signer.session_expires_at).getTime() <= Date.now()) return false;
  return sameHash(hashToken(session), signer.session_hash);
}

export type PublicSigningView = {
  organisationName: string;
  title: string;
  message: string | null;
  sourceLabel: string;
  signerName: string;
  maskedEmail: string;
  roleLabel: string | null;
  verified: boolean;
  emailReady: boolean;
  documentName: string;
  documentSha256: string;
  documentBytes: number;
  viewed: boolean;
  expiresAt: string;
  sentBy: string;
  consentText: string;
  codeSentAt: string | null;
};

export async function publicSigningView(tx: OrgTx, found: { request: RequestRow; signer: LinkSigner }, session: string | null, meta: SignMeta): Promise<PublicSigningView> {
  const { request, signer } = found;
  const verified = sessionValid(signer, session);
  const opened = await tx.query("select 1 from signing_events where signer_id = $1 and event = 'link_opened' limit 1", [signer.id]);
  if (!opened.rowCount) await addEvent(tx, { requestId: request.id, signerId: signer.id, event: "link_opened", ip: meta.ip, userAgent: meta.userAgent });
  return {
    organisationName: await organisationName(tx),
    title: request.title,
    message: request.message,
    sourceLabel: SOURCE_LABELS[request.source_kind],
    signerName: signer.name,
    maskedEmail: verified ? signer.email : maskEmail(signer.email),
    roleLabel: signer.role_label,
    verified,
    emailReady: (await signingEmailReadiness(tx)).ready,
    documentName: request.document_name,
    documentSha256: request.document_sha256,
    documentBytes: request.document_bytes,
    viewed: Boolean(signer.viewed_at),
    expiresAt: iso(request.expires_at)!,
    sentBy: tx.people.get(request.created_by_email.toLowerCase()) ?? request.created_by_email,
    consentText: CONSENT_TEXT,
    codeSentAt: iso(signer.code_sent_at),
  };
}

/** Emails the signer a 6-digit code (at most 5 per link, one a minute). */
export async function publicSendCode(tx: OrgTx, found: { request: RequestRow; signer: LinkSigner }, meta: SignMeta): Promise<{ sentTo: string }> {
  const { request, signer } = found;
  const email = await signingEmailReadiness(tx);
  if (!email.ready) throw new UnavailableError(`${await organisationName(tx)} can't send email from Tohyee at the moment, so a code can't be sent. Ask them to check their email setup.`);
  if (signer.codes_sent >= CODES_PER_LINK) throw new ConflictError("Too many codes have been sent for this link. Ask for a new link.");
  if (signer.code_sent_at && Date.now() - new Date(signer.code_sent_at).getTime() < 60_000) throw new ConflictError("A code was sent less than a minute ago. Check your email (and junk folder), or wait a minute.");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await tx.query(
    "update signing_signers set code_hash = $2, code_expires_at = now() + make_interval(mins => $3), code_attempts = 0, codes_sent = codes_sent + 1, code_sent_at = now() where id = $1",
    [signer.id, codeHash(signer.id, code), CODE_MINUTES],
  );
  await queueEmail(tx, {
    requestId: request.id,
    signerId: signer.id,
    purpose: "code",
    to: signer.email,
    subject: `Your code to sign: ${code}`,
    body: [`Your code to sign ${request.title} is ${code}.`, "", `It works for ${CODE_MINUTES} minutes. Don't share it: anyone with it and your link could sign as you.`].join("\n"),
  });
  await addEvent(tx, { requestId: request.id, signerId: signer.id, event: "code_sent", ip: meta.ip, userAgent: meta.userAgent, details: { to: signer.email } });
  return { sentTo: maskEmail(signer.email) };
}

/**
 * Checks the code. A wrong code counts against the 5 tries and is
 * returned (not thrown) so the count is kept. A right one starts a signing
 * session (an hour) for this browser.
 */
export async function publicVerifyCode(tx: OrgTx, found: { request: RequestRow; signer: LinkSigner }, codeInput: unknown, meta: SignMeta): Promise<{ ok: true; session: string } | { ok: false; message: string }> {
  const { request, signer } = found;
  const code = typeof codeInput === "string" ? codeInput.replace(/\s+/g, "") : "";
  if (!signer.code_hash || !signer.code_expires_at) return { ok: false, message: "Ask for a code first." };
  if (signer.code_attempts >= CODE_MAX_ATTEMPTS) return { ok: false, message: "Too many wrong codes. Ask for a new code." };
  if (new Date(signer.code_expires_at).getTime() <= Date.now()) return { ok: false, message: "That code has expired. Ask for a new one." };
  if (!CODE_PATTERN.test(code) || !sameHash(codeHash(signer.id, code), signer.code_hash)) {
    await tx.query("update signing_signers set code_attempts = code_attempts + 1 where id = $1", [signer.id]);
    const left = CODE_MAX_ATTEMPTS - signer.code_attempts - 1;
    return { ok: false, message: left > 0 ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "That code isn't right. Ask for a new code." };
  }
  const session = newToken();
  await tx.query(
    "update signing_signers set code_hash = null, code_expires_at = null, verified_at = now(), verified_by = 'email_code', session_hash = $2, session_expires_at = now() + make_interval(mins => $3) where id = $1",
    [signer.id, hashToken(session), SESSION_MINUTES],
  );
  await addEvent(tx, { requestId: request.id, signerId: signer.id, event: "verified", ip: meta.ip, userAgent: meta.userAgent, details: { by: "email_code" } });
  return { ok: true, session };
}

function requireSession(signer: LinkSigner, session: string | null): void {
  if (!sessionValid(signer, session)) throw new ForbiddenError("Enter the code we emailed you first. If it's been more than an hour, ask for a new code.");
}

/** The document's exact bytes, for a signer who has entered their code. The first time counts as viewing it. */
export async function publicDocument(tx: OrgTx, found: { request: RequestRow; signer: LinkSigner }, session: string | null, meta: SignMeta): Promise<{ fileName: string; content: Buffer }> {
  const { request, signer } = found;
  requireSession(signer, session);
  const row = (await tx.query<{ file_name: string; content: Buffer }>("select file_name, content from signing_files where id = $1", [request.document_file_id])).rows[0];
  if (!signer.viewed_at) {
    await tx.query("update signing_signers set viewed_at = now() where id = $1", [signer.id]);
    await addEvent(tx, { requestId: request.id, signerId: signer.id, event: "viewed", ip: meta.ip, userAgent: meta.userAgent });
  }
  return { fileName: row.file_name, content: row.content };
}

export async function publicSign(tx: OrgTx, found: { request: RequestRow; signer: LinkSigner }, session: string | null, input: SignInput, meta: SignMeta): Promise<{ signed: true; complete: boolean }> {
  requireSession(found.signer, session);
  await recordSignature(tx, found.request, found.signer, input, meta, "email_code");
  const after = await requestRow(tx, found.request.id);
  return { signed: true, complete: after.status === "completed" };
}

export async function publicDecline(tx: OrgTx, found: { request: RequestRow; signer: LinkSigner }, session: string | null, reason: unknown, meta: SignMeta): Promise<{ declined: true }> {
  requireSession(found.signer, session);
  await recordDecline(tx, found.request, found.signer, reason, meta);
  return { declined: true };
}

/** The signed copy for a "download the signed copy" link (30 days from completion). */
export async function signedCopyForToken(tx: OrgTx, token: string): Promise<{ fileName: string; content: Buffer } | null> {
  const row = (
    await tx.query<{ file_name: string; content: Buffer }>(
      `select f.file_name, f.content from signing_signers s join signing_requests r on r.id = s.request_id join signing_files f on f.id = r.signed_file_id
        where s.copy_token_hash = $1 and s.copy_expires_at > now() and r.status = 'completed'`,
      [hashToken(token)],
    )
  ).rows[0];
  return row ? { fileName: row.file_name, content: row.content } : null;
}

export { requestRow as _requestRowForTests };
export type { RequestRow };
