import type { MailProvider } from "@/lib/crm/mail/providers";

/*
 * What My mail shows its owner (#250). Browser-safe: no server code. Only
 * ever sent to the copy's own owner (decision 611).
 */

export type MyMailFolder = { id: string; externalId: string; name: string; includeSubfolders: boolean; missing: boolean; privateOnly: boolean };

export type CopyState = {
  id: string;
  /** The owner's switch: off keeps what was copied and stops copying. */
  copying: boolean;
  /** Stopped after failed syncs; connect the mailbox again to carry on. */
  paused: boolean;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  /** Emails in the copy. */
  copied: number;
  /** Emails the chosen folders had back to the read-back date at the last sync. */
  listed: number;
  /** A folder had more emails than are listed (10,000): only its newest are copied. */
  listingCapped: boolean;
  oldest: string | null;
  newest: string | null;
  attachments: number;
  /** Attachments whose files weren't kept (too big, or linked Outlook items). */
  attachmentsNotKept: number;
  /** Emails deleted in Gmail or Outlook since they were copied: kept here, marked (decision 616). */
  deletedAtSource: number;
};

export type MyMailbox = {
  /** The connection's id (the farm calendar's mailbox, decision 610). */
  id: string;
  provider: MailProvider;
  email: string;
  historyDays: number;
  /** Nothing older is copied (the read-back window). */
  historyFrom: string;
  status: "active" | "paused";
  folders: MyMailFolder[];
  /** The farm calendar reads the same folders (those it can, decision 615). */
  farmCalendar: boolean;
  copy: CopyState | null;
};

/** A copy whose mailbox was disconnected: kept, not copying, until its owner deletes it. */
export type DetachedCopy = CopyState & { provider: MailProvider; email: string };

export type MyMail = { mailboxes: MyMailbox[]; detached: DetachedCopy[] };

export type MailPerson = { email: string; name: string | null };

export type MailHit = {
  id: string;
  copyId: string;
  sentAt: string;
  from: MailPerson | null;
  subject: string | null;
  snippet: string;
  attachmentCount: number;
  /** Deleted (or in the bin) in Gmail or Outlook; the copy keeps it. */
  deletedInMailbox: boolean;
};

export type MailAttachmentInfo = { id: string; name: string; contentType: string; size: number; inline: boolean; kept: boolean; notKept: "too_big" | "linked" | null };

export type MailMessage = {
  id: string;
  sentAt: string;
  from: MailPerson | null;
  to: MailPerson[];
  cc: MailPerson[];
  bcc: MailPerson[];
  subject: string | null;
  text: string;
  webLink: string | null;
  attachments: MailAttachmentInfo[];
  deletedInMailbox: boolean;
};

export type MailThread = { copyId: string; mailbox: string; messages: MailMessage[] };

/** What a copy doesn't have, said plainly on My mail (PM4). */
export function copyExclusions(provider: MailProvider): string[] {
  return [
    "Folders you haven't ticked (and their subfolders, unless you ticked those too).",
    provider === "google"
      ? "Gmail's Sent, Drafts, Spam and Trash, unless you tick them; and archived mail with no label, which isn't in any label."
      : "Drafts, Junk Email, Deleted Items and Sent Items, unless you tick them.",
    "Email older than the read-back date, even if it's moved into a ticked folder.",
    "In a folder with more than 10,000 emails in the read-back window, all but the newest 10,000.",
    "The files of attachments over 20 MB (their name and size are kept) and of linked Outlook items.",
    "Pictures and formatting: each email is kept as its text.",
    "Email the mailbox never let Tohyee read: nothing is claimed beyond what was copied. Email deleted in the mailbox after it was copied stays in your copy, marked as deleted there.",
  ];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How far the first copy has got (PM3), e.g. "1,234 of 5,000 emails (25%)". */
export function copyProgress(copy: Pick<CopyState, "copied" | "listed" | "lastSuccessAt">): { text: string; percent: number | null; done: boolean } {
  if (!copy.lastSuccessAt) return { text: "Not copied yet", percent: null, done: false };
  if (copy.listed === 0) return { text: copy.copied ? `${copy.copied.toLocaleString("en-NZ")} emails` : "No emails in the ticked folders", percent: 100, done: true };
  const shown = Math.min(copy.copied, copy.listed);
  const percent = Math.floor((shown / copy.listed) * 100);
  const done = shown >= copy.listed;
  return { text: done ? `All ${copy.listed.toLocaleString("en-NZ")} emails copied` : `${shown.toLocaleString("en-NZ")} of ${copy.listed.toLocaleString("en-NZ")} emails copied (${percent}%)`, percent, done };
}
