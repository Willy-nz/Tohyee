/*
 * E-signatures (decisions 1396-1410, docs/E-SIGNATURES.md): words, types and
 * pure rules shared by the screens, the signer's page and the server.
 * Browser-safe: no server imports.
 */

/** The consent each signer ticks before signing, kept word for word with their signature. */
export const CONSENT_TEXT = "I agree to sign electronically";

export const SOURCE_KINDS = ["quote", "year_end", "employment", "induction", "upload"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_LABELS: Record<SourceKind, string> = {
  quote: "Quote",
  year_end: "Financial statements",
  employment: "Employment agreement",
  induction: "Safety induction",
  upload: "Document",
};

export const REQUEST_STATUSES = ["sent", "completed", "declined", "voided"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
/** What a request shows as: "expired" is worked out from its expiry, never stored. */
export type RequestState = RequestStatus | "expired";

export const STATE_LABELS: Record<RequestState, string> = {
  sent: "Waiting for signatures",
  completed: "Signed",
  declined: "Declined",
  voided: "Voided",
  expired: "Expired",
};

export const SIGNER_STATUSES = ["waiting", "ready", "signed", "declined"] as const;
export type SignerStatus = (typeof SIGNER_STATUSES)[number];

export const SIGNER_STATUS_LABELS: Record<SignerStatus, string> = {
  waiting: "Not their turn yet",
  ready: "Asked to sign",
  signed: "Signed",
  declined: "Declined",
};

export const SIGNING_ORDERS = ["in_order", "any_order"] as const;
export type SigningOrder = (typeof SIGNING_ORDERS)[number];

export const METHODS = ["typed", "drawn"] as const;
export type SignatureMethod = (typeof METHODS)[number];
export const METHOD_LABELS: Record<SignatureMethod, string> = { typed: "Typed name", drawn: "Drawn signature" };

/** How long a request stays open, and the most people on one. */
export const DEFAULT_EXPIRY_DAYS = 30;
export const MAX_EXPIRY_DAYS = 90;
export const MAX_SIGNERS = 20;
export const MAX_SIGNING_PDF_BYTES = 25 * 1024 * 1024;

/** A link's and a session's token: 32 random bytes, base64url (43 characters). */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** The email code: 6 digits. */
export const CODE_PATTERN = /^[0-9]{6}$/;

export const CODE_MINUTES = 15;
export const CODE_MAX_ATTEMPTS = 5;
export const CODES_PER_LINK = 5;
export const SESSION_MINUTES = 60;

export type SignerView = {
  id: string;
  position: number;
  name: string;
  email: string;
  userId: string | null;
  roleLabel: string | null;
  status: SignerStatus;
  linkSentAt: string | null;
  viewedAt: string | null;
  verifiedAt: string | null;
  verifiedBy: "email_code" | "tohyee_sign_in" | null;
  signedAt: string | null;
  method: SignatureMethod | null;
  typedName: string | null;
  declineReason: string | null;
  declinedAt: string | null;
};

export type SigningEventView = { id: string; event: string; at: string; signerId: string | null; actorEmail: string | null; ipAddress: string | null; details: Record<string, unknown> };

export type SigningRequestView = {
  id: string;
  title: string;
  sourceKind: SourceKind;
  sourceId: string | null;
  status: RequestStatus;
  state: RequestState;
  signingOrder: SigningOrder;
  message: string | null;
  documentFileId: string;
  documentName: string;
  documentSha256: string;
  documentBytes: number;
  signedFileId: string | null;
  signedSha256: string | null;
  expiresAt: string;
  remindEveryDays: number | null;
  lastRemindedAt: string | null;
  replacesRequestId: string | null;
  completedAt: string | null;
  declinedAt: string | null;
  voidedAt: string | null;
  voidedByEmail: string | null;
  voidReason: string | null;
  createdByEmail: string;
  createdAt: string;
  signers: SignerView[];
  emails: Array<{ purpose: string; toEmail: string; status: string; lastError: string | null; createdAt: string }>;
  events: SigningEventView[];
};

/** A request's state now: open past its expiry shows as expired. */
export function requestState(status: RequestStatus, expiresAt: string, now = new Date()): RequestState {
  if (status === "sent" && new Date(expiresAt).getTime() <= now.getTime()) return "expired";
  return status;
}

/**
 * Who should be asked next. In order: the first signer who hasn't signed
 * (only once everyone before them has). Any order: everyone who hasn't
 * signed. Nobody once someone has declined.
 */
export function signersToAsk(order: SigningOrder, signers: ReadonlyArray<{ position: number; status: SignerStatus }>): number[] {
  if (signers.some((signer) => signer.status === "declined")) return [];
  const open = [...signers].sort((a, b) => a.position - b.position).filter((signer) => signer.status !== "signed");
  if (order === "any_order") return open.map((signer) => signer.position);
  return open.length ? [open[0].position] : [];
}

/** Whether a reminder is due (decision 1410): open, not expired, reminders on, and that many days since it was sent or last reminded. */
export function reminderDue(request: { status: RequestStatus; expiresAt: string; remindEveryDays: number | null; lastRemindedAt: string | null; createdAt: string }, now = new Date()): boolean {
  if (request.status !== "sent" || !request.remindEveryDays) return false;
  if (new Date(request.expiresAt).getTime() <= now.getTime()) return false;
  const from = new Date(request.lastRemindedAt ?? request.createdAt).getTime();
  return now.getTime() - from >= request.remindEveryDays * 86_400_000;
}

/** Whether everyone has signed. */
export function allSigned(signers: ReadonlyArray<{ status: SignerStatus }>): boolean {
  return signers.length > 0 && signers.every((signer) => signer.status === "signed");
}

/** An email address shown on the signer's page before they've proved it's theirs: a***@example.com. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** A fingerprint broken into groups of 8, so people can compare it by eye. */
export function groupedFingerprint(sha256: string): string {
  return (sha256.match(/.{1,8}/g) ?? []).join(" ");
}

/** The general information shown beside signing (not legal advice); the detail is in docs/E-SIGNATURES.md. */
export const LEGAL_NOTE =
  "General information, not legal advice. In New Zealand, Part 4 of the Contract and Commercial Law Act 2017 lets an electronic signature meet a legal need for a signature when it identifies the signer, shows they approve the document, and is as reliable as is appropriate. Some documents are left out of that or need more, such as wills, most powers of attorney, affidavits, statutory declarations and negotiable instruments like cheques. Tohyee doesn't do witnessed signing: anything that must be witnessed needs to be signed another way. If you're unsure, ask a lawyer.";
