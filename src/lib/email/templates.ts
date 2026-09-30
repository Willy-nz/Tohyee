import { ValidationError } from "@/lib/errors";

/**
 * Email templates per document type (browser-safe): the subject and message
 * the email dialog starts with, editable by admins in Settings > Email, with
 * placeholders in braces like Xero's ({contact}, {number}, {total},
 * {due date}, {organisation}). Filled when the dialog opens; the person
 * sending can still change the text.
 */

export const EMAIL_DOCUMENT_KINDS = ["invoice", "credit_note", "quote", "purchase_order", "statement"] as const;
export type EmailDocumentKind = (typeof EMAIL_DOCUMENT_KINDS)[number];

export const EMAIL_KIND_LABELS: Record<EmailDocumentKind, string> = {
  invoice: "Invoices",
  credit_note: "Credit notes",
  quote: "Quotes",
  purchase_order: "Purchase orders",
  statement: "Customer statements",
};

export const EMAIL_KIND_NOUNS: Record<EmailDocumentKind, string> = {
  invoice: "invoice",
  credit_note: "credit note",
  quote: "quote",
  purchase_order: "purchase order",
  statement: "statement",
};

export const PLACEHOLDERS: Record<EmailDocumentKind, readonly string[]> = {
  invoice: ["contact", "organisation", "number", "date", "due date", "total", "amount due", "reference"],
  credit_note: ["contact", "organisation", "number", "date", "total", "reference"],
  quote: ["contact", "organisation", "number", "date", "expiry date", "total", "reference"],
  purchase_order: ["contact", "organisation", "number", "date", "delivery date", "total", "reference"],
  statement: ["contact", "organisation", "statement date", "balance"],
};

export type EmailTemplate = { kind: EmailDocumentKind; subject: string; body: string; isDefault: boolean };

export const DEFAULT_TEMPLATES: Record<EmailDocumentKind, { subject: string; body: string }> = {
  invoice: {
    subject: "Invoice {number} from {organisation}",
    body: "Hi {contact},\n\nHere's invoice {number} for ${total}.\n\nThe amount due is ${amount due}, due on {due date}.\n\nIf you have any questions, just reply to this email.\n\nThanks,\n{organisation}",
  },
  credit_note: {
    subject: "Credit note {number} from {organisation}",
    body: "Hi {contact},\n\nHere's credit note {number} for ${total}.\n\nIf you have any questions, just reply to this email.\n\nThanks,\n{organisation}",
  },
  quote: {
    subject: "Quote {number} from {organisation}",
    body: "Hi {contact},\n\nHere's quote {number} for ${total}.\n\nIf you'd like to go ahead, or have any questions, just reply to this email.\n\nThanks,\n{organisation}",
  },
  purchase_order: {
    subject: "Purchase order {number} from {organisation}",
    body: "Hi {contact},\n\nPlease find our purchase order {number} attached.\n\nPlease reply to confirm you can supply it.\n\nThanks,\n{organisation}",
  },
  statement: {
    subject: "Statement from {organisation}",
    body: "Hi {contact},\n\nHere's your statement as at {statement date}. The balance owing is ${balance}.\n\nIf you have any questions, just reply to this email.\n\nThanks,\n{organisation}",
  },
};

export const MAX_SUBJECT_LENGTH = 250;
export const MAX_BODY_LENGTH = 10_000;

const PLACEHOLDER = /\{([^{}\n]{1,40})\}/g;

function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Placeholders in the text that this document type doesn't have. */
export function unknownPlaceholders(kind: EmailDocumentKind, text: string): string[] {
  const allowed = PLACEHOLDERS[kind];
  const unknown: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = normalise(match[1]);
    if (!allowed.includes(name) && !unknown.includes(`{${match[1]}}`)) unknown.push(`{${match[1]}}`);
  }
  return unknown;
}

/** Checks a template before it's saved: not blank, not too long, only known placeholders. */
export function checkTemplate(kind: EmailDocumentKind, subject: string, body: string): void {
  if (!subject.trim()) throw new ValidationError("The subject can't be blank.");
  if (!body.trim()) throw new ValidationError("The message can't be blank.");
  if (subject.length > MAX_SUBJECT_LENGTH) throw new ValidationError(`The subject can be at most ${MAX_SUBJECT_LENGTH} characters.`);
  if (body.length > MAX_BODY_LENGTH) throw new ValidationError(`The message can be at most ${MAX_BODY_LENGTH.toLocaleString("en-NZ")} characters.`);
  const unknown = [...new Set([...unknownPlaceholders(kind, subject), ...unknownPlaceholders(kind, body)])];
  if (unknown.length > 0) {
    throw new ValidationError(
      `${unknown.join(", ")} isn't something Tohyee can fill in for ${EMAIL_KIND_LABELS[kind].toLowerCase()}. Use ${PLACEHOLDERS[kind].map((name) => `{${name}}`).join(", ")}.`,
    );
  }
}

/**
 * Fills the placeholders. A placeholder with no value (e.g. {reference} on
 * an invoice without one) becomes blank; unknown ones are left as typed.
 */
export function fillTemplate(text: string, values: Partial<Record<string, string | null>>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const key = normalise(name);
    if (!(key in values)) return whole;
    return values[key] ?? "";
  });
}
