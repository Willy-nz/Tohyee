/*
 * Filing an attachment from My mail into shared data (#250; PM20-PM29,
 * decisions 720-726). Browser-safe: no server code. Everything here is only
 * ever sent to the copy's own owner; what others see is the `shared` part of
 * a preview, and nothing else.
 */

export const FILING_KINDS = ["bills_inbox", "soil_tests", "pasture_readings", "fertiliser_applications", "record"] as const;
export type FilingKind = (typeof FILING_KINDS)[number];

/** Where a filed attachment goes. Import options are the feature's own (the soil import's lab, say). */
export type FilingDestination =
  | { kind: "bills_inbox" }
  | { kind: "soil_tests"; farmId: string; sampledOn?: string | null; lab?: string | null }
  | { kind: "pasture_readings"; farmId: string; method?: string | null }
  | { kind: "fertiliser_applications"; planId: string }
  | { kind: "record"; recordType: string; recordId: string };

/** The records an attachment can be attached to from My mail, with a search to find one. */
export const FILING_RECORD_TYPES = [
  { type: "bill", label: "Bill" },
  { type: "sales_invoice", label: "Invoice" },
  { type: "contact", label: "Contact" },
  { type: "fixed_asset", label: "Fixed asset" },
  { type: "soil_test", label: "Soil test" },
  { type: "coop_shareholding", label: "Co-op shareholding" },
] as const;
export type FilingRecordType = (typeof FILING_RECORD_TYPES)[number]["type"];

export type SharedField = { label: string; value: string };

/** The rows an import would add, as the feature's own import preview reads them. */
export type SharedTable = { headings: string[]; rows: Array<{ cells: string[]; error: string | null }> };

export type FilingPreview = {
  attachmentId: string;
  /** The attachment's own name: the owner's, not shared unless they keep it as the file name. */
  originalName: string;
  destination: FilingDestination;
  destinationLabel: string;
  fileName: string;
  contentType: string;
  size: number;
  /** Everything others will be able to see, field by field. */
  shared: SharedField[];
  /** For an import: the rows that would be added (rows with an error aren't). */
  table: SharedTable | null;
  /** Whether the file itself is shared (the bills inbox and records), or only rows read from it (imports). */
  sharesFile: boolean;
  /** Whether a note can go with it. */
  noteAllowed: boolean;
  /** What stays private. */
  notShared: string[];
  warnings: string[];
  /** Why it can't be filed as it stands; null when it can. */
  problem: string | null;
  /** Sent back with "File it": refused if anything shown here has changed since. */
  confirmation: string;
};

export type FilingResult = { filingId: string; destinationLabel: string; link: string | null; summary: string };

export type FiledItem = { id: string; filedAt: string; kind: FilingKind; destinationLabel: string; fileName: string; summary: string; link: string | null; byRule: boolean };

export type MailRule = {
  id: string;
  copyId: string;
  mailbox: string;
  sender: string | null;
  fileName: string | null;
  destination: FilingDestination;
  destinationLabel: string;
  waiting: number;
  createdAt: string;
};

export type ToFileEntry = {
  id: string;
  ruleId: string;
  ruleText: string;
  attachmentId: string;
  fileName: string;
  size: number;
  messageId: string;
  subject: string | null;
  from: string | null;
  sentAt: string;
  destination: FilingDestination;
  destinationLabel: string;
};

export type FilingFarm = { id: string; name: string; plans: Array<{ id: string; name: string }> };
export type FilingOptions = { accounting: boolean; farming: boolean; farms: FilingFarm[] };
export type FilingOverview = { options: FilingOptions; filed: FiledItem[]; rules: MailRule[]; toFile: ToFileEntry[] };
export type FilingRecordHit = { id: string; label: string };

export const KIND_LABELS: Readonly<Record<FilingKind, string>> = {
  bills_inbox: "Bills inbox",
  soil_tests: "Soil tests (import)",
  pasture_readings: "Pasture readings (import)",
  fertiliser_applications: "Fertiliser applications (import)",
  record: "Attach to a record",
};

/** A sender as a rule keeps it: a whole address, or "@domain" for anyone there. Lower case. */
export function normaliseSender(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (!value) return null;
  if (/^@?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) return value.startsWith("@") ? value : `@${value}`;
  if (/^[^\s@<>"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) return value;
  throw new RangeError("The sender must be an email address, or @ and a domain (for anyone there).");
}

/** A file name pattern: * for any characters, ? for one; case doesn't matter; the whole name must match. */
export function fileNamePattern(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .split("")
    .map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${escaped}$`, "i");
}

/** Whether an attachment matches a rule: every part the rule has (sender, file name) must match. */
export function ruleMatches(rule: { sender: string | null; fileName: string | null }, attachment: { sender: string | null; fileName: string }): boolean {
  if (!rule.sender && !rule.fileName) return false;
  if (rule.sender) {
    const sender = (attachment.sender ?? "").toLowerCase();
    if (!sender) return false;
    if (rule.sender.startsWith("@") ? !sender.endsWith(rule.sender) : sender !== rule.sender) return false;
  }
  if (rule.fileName && !fileNamePattern(rule.fileName).test(attachment.fileName)) return false;
  return true;
}

/** A rule in words, e.g. "Attachments from @soillab.example named *.csv". */
export function ruleText(rule: { sender: string | null; fileName: string | null }): string {
  const parts = ["Attachments"];
  if (rule.sender) parts.push(rule.sender.startsWith("@") ? `from anyone at ${rule.sender.slice(1)}` : `from ${rule.sender}`);
  if (rule.fileName) parts.push(`named ${rule.fileName}`);
  return parts.join(" ");
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * The name the filed copy gets (PM22): the attachment's own, or one the
 * owner types instead (an attachment's name can say more than they want
 * shared). It keeps the same kind of file, so a check of its contents
 * still applies.
 */
export function filedName(original: string, wanted: string | null | undefined): string {
  const name = (wanted ?? "").trim() || original.trim();
  if (!name || name.length > 200) throw new RangeError("The file name must be 1 to 200 characters.");
  if (/[\\/\u0000-\u001f]/.test(name)) throw new RangeError("The file name can't have slashes or control characters.");
  if (extension(name) !== extension(original)) throw new RangeError(`Keep the file's ending (.${extension(original) || "none"}), so it's still the same kind of file.`);
  return name;
}
