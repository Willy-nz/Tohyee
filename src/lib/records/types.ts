/**
 * The records that have notes, files and a history (examples NF1-NF14), and
 * the names they go by in URLs. Shared with the browser, so no server imports.
 */
export const RECORD_TYPES = [
  "ledger_journal",
  "sales_invoice",
  "bill",
  "sales_credit_note",
  "supplier_credit_note",
  "contact",
  "expense_claim",
  "fixed_asset",
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const RECORD_TYPE_SLUGS: Readonly<Record<RecordType, string>> = {
  ledger_journal: "journal",
  sales_invoice: "invoice",
  bill: "bill",
  sales_credit_note: "credit-note",
  supplier_credit_note: "supplier-credit-note",
  contact: "contact",
  expense_claim: "expense-claim",
  fixed_asset: "fixed-asset",
};

export function recordTypeFromSlug(slug: string): RecordType | null {
  const entry = Object.entries(RECORD_TYPE_SLUGS).find(([, value]) => value === slug);
  return entry ? (entry[0] as RecordType) : null;
}

export type RecordNote = {
  id: string;
  body: string;
  version: number;
  createdByEmail: string;
  createdAt: string;
  updatedByEmail: string | null;
  updatedAt: string | null;
  /** Whether the signed-in person may edit or delete it (its author, or an admin). */
  canChange: boolean;
};

export type RecordAttachment = {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  createdByEmail: string;
  createdAt: string;
  /** Whether the signed-in person may remove it (who added it, or an admin). */
  canRemove: boolean;
};

export type RecordHistoryEntry = {
  id: string;
  at: string;
  actorEmail: string | null;
  eventType: string;
  summary: string;
  /** For an edited or deleted note: the text before and after. */
  noteBefore: string | null;
  noteAfter: string | null;
};

export type RecordExtras = {
  recordType: RecordType;
  recordId: string;
  notes: RecordNote[];
  attachments: RecordAttachment[];
  history: RecordHistoryEntry[];
  /** Whether the signed-in person may add notes and files (bookkeeper or above). */
  canAdd: boolean;
};
