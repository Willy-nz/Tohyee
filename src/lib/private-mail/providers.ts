import { type MailProvider, parseAddressList, type Participant, ProviderError } from "@/lib/crm/mail/providers";
import { getJson, htmlToText, listMailFolders, type MailFolder } from "@/lib/farming/mail-providers";

/*
 * Reading a mailbox for its owner's private copy (#250; PM2-PM5, decision
 * 614): Gmail's API or Microsoft Graph with the farm calendar's read-only
 * scopes (gmail.readonly, Mail.Read). Only GETs: nothing is sent, marked
 * read, moved or deleted. Called outside database transactions.
 */

/** Text kept for an email's body, at most. */
export const MAX_BODY_CHARS = 500_000;
/** Attachments bigger than this keep their name and size only (PM5). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Attachments kept per email, at most. */
export const MAX_ATTACHMENTS = 50;

/** Gmail's system labels the private copy can be told to copy too (never the farm calendar). */
export const GMAIL_PRIVATE_ONLY_LABELS: Array<{ id: string; name: string }> = [
  { id: "SENT", name: "Sent" },
  { id: "DRAFT", name: "Drafts" },
  { id: "SPAM", name: "Spam" },
  { id: "TRASH", name: "Trash" },
];

/**
 * The folders My mail offers: the farm calendar's list (the same one
 * choice, #340) and, for Gmail, Sent, Drafts, Spam and Trash marked as the
 * private copy's only. Outlook's Sent Items, Drafts, Junk Email and Deleted
 * Items are ordinary folders there already.
 */
export async function listPrivateFolders(provider: MailProvider, token: string): Promise<MailFolder[]> {
  const folders = await listMailFolders(provider, token);
  if (provider !== "google") return folders;
  return [...folders, ...GMAIL_PRIVATE_ONLY_LABELS.map((label) => ({ id: label.id, name: label.name, path: label.name, parentId: null, depth: 0, privateOnly: true }))];
}

export type PrivateAttachment = {
  externalId: string;
  name: string;
  contentType: string;
  size: number;
  inline: boolean;
  /** Why the file itself isn't kept (too big, a linked item), or null. */
  notKept: "too_big" | "linked" | null;
};

export type PrivateMail = {
  externalId: string;
  threadId: string;
  sentAt: string;
  from: Participant | null;
  to: Participant[];
  cc: Participant[];
  bcc: Participant[];
  subject: string | null;
  text: string;
  webLink: string | null;
  size: number;
  attachments: PrivateAttachment[];
  /** A Gmail draft (only copied when Drafts is ticked, decision 615). */
  draft: boolean;
};

type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
};

function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function gmailBody(payload: GmailPart | undefined): { text: string; attachments: Array<PrivateAttachment & { data?: string }> } {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: Array<PrivateAttachment & { data?: string }> = [];
  const walk = (node: GmailPart | undefined) => {
    if (!node) return;
    if (node.filename && (node.body?.attachmentId || node.body?.data)) {
      const size = node.body?.size ?? 0;
      const disposition = node.headers?.find((header) => header.name.toLowerCase() === "content-disposition")?.value ?? "";
      attachments.push({
        externalId: node.body?.attachmentId ?? `part-${node.partId ?? attachments.length}`,
        name: node.filename.slice(0, 300),
        contentType: (node.mimeType ?? "application/octet-stream").slice(0, 200),
        size,
        inline: /^\s*inline/i.test(disposition),
        notKept: size > MAX_ATTACHMENT_BYTES ? "too_big" : null,
        data: node.body?.attachmentId ? undefined : node.body?.data,
      });
    } else if (node.mimeType === "text/plain" && node.body?.data) plain.push(decodeBase64Url(node.body.data).toString("utf8"));
    else if (node.mimeType === "text/html" && node.body?.data) html.push(decodeBase64Url(node.body.data).toString("utf8"));
    for (const child of node.parts ?? []) walk(child);
  };
  walk(payload);
  const text = plain.length > 0 ? plain.join("\n") : htmlToText(html.join("\n"));
  return { text: text.slice(0, MAX_BODY_CHARS), attachments: attachments.slice(0, MAX_ATTACHMENTS) };
}

/** One email, whole: headers, its text and its attachments' details (not the files). */
export async function fetchPrivateMail(provider: MailProvider, token: string, id: string, mailbox: string): Promise<PrivateMail & { inlineData: Map<string, string> }> {
  if (provider === "google") {
    type GmailMessage = { id: string; threadId?: string; labelIds?: string[]; internalDate?: string; sizeEstimate?: number; payload?: GmailPart };
    const message = await getJson<GmailMessage>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, token);
    const header = (name: string) => message.payload?.headers?.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value;
    const date = Number(message.internalDate);
    const { text, attachments } = gmailBody(message.payload);
    const inlineData = new Map<string, string>();
    for (const attachment of attachments) if (attachment.data) inlineData.set(attachment.externalId, attachment.data);
    return {
      externalId: message.id,
      threadId: message.threadId ?? message.id,
      sentAt: new Date(Number.isFinite(date) ? date : Date.parse(header("Date") ?? "") || Date.now()).toISOString(),
      from: parseAddressList(header("From"))[0] ?? null,
      to: parseAddressList(header("To")),
      cc: parseAddressList(header("Cc")),
      bcc: parseAddressList(header("Bcc")),
      subject: header("Subject")?.slice(0, 1000) ?? null,
      text,
      webLink: `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#all/${encodeURIComponent(message.id)}`,
      size: message.sizeEstimate ?? 0,
      attachments: attachments.map((attachment) => ({ externalId: attachment.externalId, name: attachment.name, contentType: attachment.contentType, size: attachment.size, inline: attachment.inline, notKept: attachment.notKept })),
      draft: (message.labelIds ?? []).includes("DRAFT"),
      inlineData,
    };
  }
  type Address = { emailAddress?: { address?: string; name?: string } };
  type GraphMessage = {
    id: string;
    conversationId?: string;
    subject?: string | null;
    from?: Address | null;
    toRecipients?: Address[];
    ccRecipients?: Address[];
    bccRecipients?: Address[];
    sentDateTime?: string | null;
    receivedDateTime?: string | null;
    webLink?: string | null;
    hasAttachments?: boolean;
    body?: { contentType?: string; content?: string } | null;
  };
  const params = new URLSearchParams({ $select: "id,conversationId,subject,from,toRecipients,ccRecipients,bccRecipients,sentDateTime,receivedDateTime,webLink,hasAttachments,body" });
  const message = await getJson<GraphMessage>(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}?${params}`, token, { Prefer: 'outlook.body-content-type="text"' });
  const people = (list: Address[] | undefined): Participant[] =>
    (list ?? []).filter((entry) => entry.emailAddress?.address).map((entry) => ({ email: entry.emailAddress!.address!.toLowerCase(), name: entry.emailAddress?.name ?? null }));
  const content = message.body?.content ?? "";
  const attachments: PrivateAttachment[] = [];
  if (message.hasAttachments) {
    type GraphAttachment = { id: string; name?: string; contentType?: string; size?: number; isInline?: boolean; "@odata.type"?: string };
    const listed = await getJson<{ value?: GraphAttachment[] }>(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}/attachments?${new URLSearchParams({ $select: "id,name,contentType,size,isInline" })}`,
      token,
    );
    for (const attachment of (listed?.value ?? []).slice(0, MAX_ATTACHMENTS)) {
      const file = !attachment["@odata.type"] || attachment["@odata.type"] === "#microsoft.graph.fileAttachment";
      const size = attachment.size ?? 0;
      attachments.push({
        externalId: attachment.id,
        name: (attachment.name ?? "attachment").slice(0, 300),
        contentType: (attachment.contentType ?? "application/octet-stream").slice(0, 200),
        size,
        inline: attachment.isInline === true,
        notKept: !file ? "linked" : size > MAX_ATTACHMENT_BYTES ? "too_big" : null,
      });
    }
  }
  return {
    externalId: message.id,
    threadId: message.conversationId ?? message.id,
    sentAt: new Date(message.sentDateTime ?? message.receivedDateTime ?? Date.now()).toISOString(),
    from: people(message.from ? [message.from] : [])[0] ?? null,
    to: people(message.toRecipients),
    cc: people(message.ccRecipients),
    bcc: people(message.bccRecipients),
    subject: message.subject?.slice(0, 1000) ?? null,
    text: (message.body?.contentType?.toLowerCase() === "html" ? htmlToText(content) : content).slice(0, MAX_BODY_CHARS),
    webLink: message.webLink ?? null,
    size: content.length,
    attachments,
    draft: false,
    inlineData: new Map(),
  };
}

/**
 * Where an email that's no longer in the ticked folders went (decision
 * 616): "deleted" when the mailbox no longer has it or it's in the bin
 * (Gmail's Trash, Outlook's Deleted Items), else "elsewhere" (moved to a
 * folder that isn't ticked). Only a GET of the email's ids; nothing changes.
 */
export async function privateMailWhereabouts(provider: MailProvider, token: string, id: string, deletedItemsId: string | null): Promise<"deleted" | "elsewhere"> {
  try {
    if (provider === "google") {
      const found = await getJson<{ labelIds?: string[] }>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=minimal`, token);
      return (found?.labelIds ?? []).includes("TRASH") ? "deleted" : "elsewhere";
    }
    const found = await getJson<{ parentFolderId?: string }>(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}?${new URLSearchParams({ $select: "id,parentFolderId" })}`, token);
    return deletedItemsId && found?.parentFolderId === deletedItemsId ? "deleted" : "elsewhere";
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404) return "deleted";
    throw error;
  }
}

/** Outlook's Deleted Items folder's id, or null (Gmail has no such folder). */
export async function deletedItemsFolderId(provider: MailProvider, token: string): Promise<string | null> {
  if (provider !== "microsoft") return null;
  try {
    return (await getJson<{ id?: string }>(`https://graph.microsoft.com/v1.0/me/mailFolders/deleteditems?${new URLSearchParams({ $select: "id" })}`, token))?.id ?? null;
  } catch {
    return null;
  }
}

/** One attachment's file (only when it's kept: not too big, not a linked item). */
export async function fetchPrivateAttachment(provider: MailProvider, token: string, messageId: string, attachmentId: string): Promise<Buffer> {
  if (provider === "google") {
    const found = await getJson<{ data?: string }>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      token,
    );
    return decodeBase64Url(found?.data ?? "");
  }
  const found = await getJson<{ contentBytes?: string }>(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    token,
  );
  return Buffer.from(found?.contentBytes ?? "", "base64");
}

export { decodeBase64Url };
