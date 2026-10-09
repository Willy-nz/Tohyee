import { ImapFlow, type ImapFlowOptions, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import type { Readable } from "node:stream";
import { providerFetch, type MailProvider } from "@/lib/crm/mail/providers";
import { UnavailableError, ValidationError } from "@/lib/errors";
import { MAX_ATTACHMENT_BYTES } from "./report-email-files";

export type MailFolder = { id: string; name: string };
export type ReportAttachment = { name: string; size: number; read: () => Promise<Buffer> };
/**
 * A message in the report folder. `problem` is set, with no attachments, when
 * this one message can't be read (too big, malformed): the check notes it and
 * carries on. A network failure still stops the whole check, to try again later.
 */
export type ReportMessage = {
  id: string;
  receivedAt: string | null;
  attachments: ReportAttachment[];
  problem?: string;
  /** The sender and subject, when the mailbox gave them (the bills inbox shows them, BI2). */
  from?: string | null;
  subject?: string | null;
  /** The start of the message's text, when the mailbox gives it (Gmail's snippet, Microsoft's body preview); leads from email use it (decision 493). */
  preview?: string | null;
};

/** A header value cut to a sensible length, without control characters. */
function headerText(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}
/** Messages already dealt with, skipped before they're downloaded. */
export type SkipMessage = (messageId: string) => boolean;
export type ImapCredentials = { host: string; port: number; username: string; password: string };
const GOOGLE = "https://gmail.googleapis.com/gmail/v1/users/me";
const GRAPH = "https://graph.microsoft.com/v1.0/me";
const TIMEOUT_MS = 30_000;
// The folder-listing connection waits while each page of messages is saved.
const IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ENCODED_PART_BYTES = MAX_ATTACHMENT_BYTES * 4;
const MAX_ENCODED_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + MAX_JSON_BYTES;

function id(value: string): string {
  if (!value || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) throw new ValidationError("Choose a valid report mailbox folder.");
  return encodeURIComponent(value);
}

function received(value: string | number | Date): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ValidationError("The report email has no valid received date.");
  return date.toISOString();
}

function sizeLimit(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) {
    throw new ValidationError("The report attachment exceeds the size limit.");
  }
}

function decode(data: string | undefined, size: number): Buffer {
  sizeLimit(size);
  if (typeof data !== "string" || data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/_-]*={0,2}$/.test(data) || data.replace(/=+$/, "").length % 4 === 1) {
    throw new ValidationError("The report attachment could not be decoded safely.");
  }
  const bytes = Buffer.from(data, "base64url");
  sizeLimit(bytes.length);
  if (bytes.length !== size) throw new ValidationError("The report attachment has an incorrect size.");
  return bytes;
}

async function request<T>(url: string, token: string, limit = MAX_JSON_BYTES): Promise<T> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      void reader?.cancel().catch(() => {});
      reject(new UnavailableError("The report mailbox took too long to respond. Try checking it again."));
    }, TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([providerFetch(url, {
      method: "GET", headers: { Authorization: ["Bearer", token].join(" "), Accept: "application/json" },
      redirect: "error", signal: controller.signal,
    }), expired]);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new UnavailableError("The report mailbox could not be read. Check its connection and permissions.");
    }
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
      void response.body?.cancel().catch(() => {});
      throw new ValidationError("The report mailbox response exceeds the size limit.");
    }
    if (!response.body) throw new ValidationError("The report mailbox returned an empty response.");
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done) break;
      total += value.length;
      if (total > limit) throw new ValidationError("The report mailbox response exceeds the size limit.");
      chunks.push(Buffer.from(value));
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("The report mailbox returned an invalid response.");
    return value as T;
  } catch (error) {
    if (error instanceof ValidationError || error instanceof UnavailableError) throw error;
    throw new UnavailableError("The report mailbox could not be read. Check its connection and try again.");
  } finally {
    clearTimeout(timeout);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}

function nextLink(next: string, original: string, seen: Set<string>): string {
  let url: URL;
  try { url = new URL(next); } catch { throw new ValidationError("The report mailbox returned an invalid next page."); }
  const base = new URL(original);
  if (url.origin !== base.origin || url.pathname !== base.pathname || url.username || url.password || url.hash || seen.has(url.href)) {
    throw new ValidationError("The report mailbox returned an unsafe or repeated next page.");
  }
  seen.add(url.href);
  return url.href;
}

async function* graphPages<T>(url: string, token: string): AsyncGenerator<T[]> {
  const original = url;
  const seen = new Set([url]);
  while (url) {
    const page = await request<{ value?: T[]; "@odata.nextLink"?: string }>(url, token);
    if (!Array.isArray(page.value)) throw new ValidationError("The report mailbox returned an invalid list.");
    yield page.value;
    url = page["@odata.nextLink"] ? nextLink(page["@odata.nextLink"], original, seen) : "";
  }
}

export async function listReportFolders(provider: MailProvider, token: string): Promise<MailFolder[]> {
  if (provider === "google") {
    const result = await request<{ labels?: { id: string; name: string }[] }>(`${GOOGLE}/labels`, token);
    return (result.labels ?? []).map((label) => ({ id: label.id, name: label.name }));
  }
  const folders: MailFolder[] = [];
  const pending = [`${GRAPH}/mailFolders?$top=100&$select=id,displayName,childFolderCount`];
  const visited = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    for await (const page of graphPages<{ id: string; displayName: string; childFolderCount: number }>(pending[index], token)) {
      for (const folder of page) {
        id(folder.id);
        if (visited.has(folder.id)) continue;
        visited.add(folder.id);
        if (visited.size > 10_000) throw new ValidationError("The report mailbox contains too many folders.");
        folders.push({ id: folder.id, name: folder.displayName });
        if (folder.childFolderCount > 0) pending.push(`${GRAPH}/mailFolders/${id(folder.id)}/childFolders?$top=100&$select=id,displayName,childFolderCount`);
      }
    }
  }
  return folders;
}

type GmailPart = {
  filename?: string;
  body?: { size?: number; attachmentId?: string; data?: string };
  parts?: GmailPart[];
  headers?: { name?: string; value?: string }[];
};

function gmailHeader(part: GmailPart | undefined, name: string): string | null {
  return headerText(part?.headers?.find((header) => header.name?.toLowerCase() === name)?.value, name === "subject" ? 1000 : 500);
}
function gmailAttachments(part: GmailPart | undefined, messageId: string, token: string): ReportAttachment[] {
  const attachments: ReportAttachment[] = [];
  let nodes = 0;
  function visit(node: GmailPart, depth: number) {
    if (++nodes > 1000 || depth > 20) throw new ValidationError("The report email has too many MIME parts.");
    if (node.filename && node.body) {
      const body = node.body;
      const size = body.size ?? 0;
      attachments.push({
        name: node.filename, size,
        read: async () => {
          sizeLimit(size);
          if (!body.attachmentId) return decode(body.data, size);
          const result = await request<{ data?: string; size: number }>(
            `${GOOGLE}/messages/${id(messageId)}/attachments/${id(body.attachmentId)}`, token, MAX_ENCODED_BYTES,
          );
          return decode(result.data, result.size);
        },
      });
    }
    for (const child of node.parts ?? []) visit(child, depth + 1);
  }
  if (part) visit(part, 0);
  return attachments;
}

/** One message's own problem (a ValidationError) becomes `problem`; anything else stops the check. */
async function oneMessage(messageId: string, read: () => Promise<Omit<ReportMessage, "id">>): Promise<ReportMessage> {
  try {
    return { id: messageId, ...(await read()) };
  } catch (error) {
    if (error instanceof ValidationError) return { id: messageId, receivedAt: null, attachments: [], problem: error.message };
    throw error;
  }
}

type GraphAttachment = { id: string; name: string; size: number; contentBytes?: string; "@odata.type"?: string };
export async function* reportMessages(provider: MailProvider, token: string, folderId: string, skip: SkipMessage = () => false): AsyncGenerator<ReportMessage> {
  id(folderId);
  if (provider === "google") {
    let pageToken = "";
    const seen = new Set<string>();
    do {
      const query = new URLSearchParams({ labelIds: folderId, maxResults: "100" });
      if (pageToken) query.set("pageToken", pageToken);
      const page = await request<{ messages?: { id: string }[]; nextPageToken?: string }>(`${GOOGLE}/messages?${query}`, token);
      for (const listed of page.messages ?? []) {
        if (skip(listed.id)) continue;
        yield await oneMessage(listed.id, async () => {
          const message = await request<{ internalDate: string; payload?: GmailPart; snippet?: string }>(
            `${GOOGLE}/messages/${id(listed.id)}?format=full`, token, MAX_ENCODED_BYTES,
          );
          return {
            receivedAt: received(Number(message.internalDate)),
            attachments: gmailAttachments(message.payload, listed.id, token),
            from: gmailHeader(message.payload, "from"),
            subject: gmailHeader(message.payload, "subject"),
            preview: headerText(message.snippet, 2000),
          };
        });
      }
      pageToken = page.nextPageToken ?? "";
      if (pageToken && (pageToken.length > 4096 || seen.has(pageToken))) throw new ValidationError("The report mailbox returned a repeated or invalid next page.");
      seen.add(pageToken);
    } while (pageToken);
    return;
  }
  const folder = `${GRAPH}/mailFolders/${id(folderId)}`;
  for await (const page of graphPages<{
    id: string;
    receivedDateTime: string;
    hasAttachments: boolean;
    subject?: string;
    bodyPreview?: string;
    from?: { emailAddress?: { name?: string; address?: string } };
  }>(
    `${folder}/messages?$top=100&$select=id,receivedDateTime,hasAttachments,subject,from,bodyPreview&$orderby=receivedDateTime%20asc`, token,
  )) {
    for (const message of page) {
      if (skip(message.id)) continue;
      yield await oneMessage(message.id, async () => {
      const attachments: ReportAttachment[] = [];
      const endpoint = `${folder}/messages/${id(message.id)}/attachments`;
      if (message.hasAttachments) {
        for await (const attachmentPage of graphPages<GraphAttachment>(`${endpoint}?$top=100&$select=id,name,size`, token)) {
          for (const attachment of attachmentPage) {
            if (attachment["@odata.type"] !== "#microsoft.graph.fileAttachment") continue;
            if (attachments.length >= 1000) throw new ValidationError("The report email has too many attachments.");
            attachments.push({
              name: attachment.name, size: attachment.size,
              read: async () => {
                sizeLimit(attachment.size);
                const result = await request<GraphAttachment>(`${endpoint}/${id(attachment.id)}`, token, MAX_ENCODED_BYTES);
                if (result["@odata.type"] !== "#microsoft.graph.fileAttachment") throw new ValidationError("The report attachment is not a data file.");
                return decode(result.contentBytes, result.size);
              },
            });
          }
        }
      }
      const sender = message.from?.emailAddress;
      return {
        receivedAt: received(message.receivedDateTime),
        attachments,
        from: headerText(sender?.name && sender.address ? `${sender.name} <${sender.address}>` : (sender?.address ?? sender?.name)),
        subject: headerText(message.subject, 1000),
        preview: headerText(message.bodyPreview, 2000),
      };
      });
    }
  }
}

type ImapClient = {
  connect: () => Promise<unknown>;
  logout: () => Promise<unknown>;
  close: () => unknown;
  on?: (event: string, handler: (...args: unknown[]) => void) => unknown;
  list: () => Promise<{ path: string; name: string; flags: Set<string> }[]>;
  mailbox: false | { uidValidity: bigint; exists: number };
  getMailboxLock: (folder: string, options: { readOnly: boolean; acquireTimeout: number }) => Promise<{ release: () => void }>;
  fetch: (range: string, query: { uid: boolean; internalDate: boolean; size: boolean; bodyStructure: boolean; envelope?: boolean }) => AsyncIterable<FetchMessageObject>;
  download: (uid: string, part: string, options: { uid: boolean; maxBytes: number }) => Promise<{ content?: Readable; meta?: { encoding?: string } }>;
};
type ImapFactory = (options: ImapFlowOptions) => ImapClient;
let imapFactory: ImapFactory = (options) => new ImapFlow(options);
export function setImapFactoryForTests(factory: ImapFactory | null): void {
  imapFactory = factory ?? ((options) => new ImapFlow(options));
}

function imapClient(credentials: ImapCredentials): ImapClient {
  if (credentials.port !== 993 || !credentials.host || credentials.host.length > 253 ||
      !/^[a-zA-Z0-9.-]+$/.test(credentials.host) || credentials.host.startsWith(".") ||
      credentials.host.endsWith(".") || credentials.host.includes("..") ||
      !credentials.username || credentials.username.length > 320 || /[\u0000-\u001f\u007f]/.test(credentials.username) ||
      !credentials.password || credentials.password.length > 4096 || /[\r\n\u0000]/.test(credentials.password)) {
    throw new ValidationError("Use a valid IMAP host, username and app password with TLS on port 993.");
  }
  const client = imapFactory({
    host: credentials.host, port: 993, secure: true,
    auth: { user: credentials.username, pass: credentials.password },
    tls: { rejectUnauthorized: true }, logger: false, emitLogs: false,
    connectionTimeout: TIMEOUT_MS, greetingTimeout: TIMEOUT_MS, socketTimeout: IDLE_TIMEOUT_MS,
    maxLiteralSize: MAX_ENCODED_PART_BYTES + 1, maxResponseSize: MAX_ENCODED_PART_BYTES + MAX_JSON_BYTES,
    disableAutoIdle: true,
  });
  client.on?.("error", () => {});
  return client;
}

async function disconnect(client: ImapClient): Promise<void> {
  try { await client.logout(); } catch { client.close(); }
}
function imapError(error: unknown): Error {
  return error instanceof ValidationError || error instanceof UnavailableError
    ? error : new UnavailableError("The IMAP report mailbox could not be read. Check the host and app password.");
}
export async function listImapFolders(credentials: ImapCredentials): Promise<MailFolder[]> {
  const client = imapClient(credentials);
  try {
    await client.connect();
    return (await client.list()).filter((folder) => !folder.flags.has("\\Noselect")).map((folder) => ({ id: folder.path, name: folder.name }));
  } catch (error) { throw imapError(error); }
  finally { await disconnect(client); }
}

type ImapPart = { name: string; size: number; part: string; encodedSize: number; decodedUpperBound: number; encoding: string; exactSize: boolean };
/** The attachments Tohyee saves from an IMAP message (exported for tests). */
export function mimeParts(structure: MessageStructureObject | undefined): ImapPart[] {
  const parts: ImapPart[] = [];
  let nodes = 0;
  function visit(node: MessageStructureObject, depth: number, path: number[]) {
    if (++nodes > 1000 || depth > 20) throw new ValidationError("The report email has too many MIME parts.");
    const name = node.dispositionParameters?.filename ?? node.parameters?.name;
    if (name && /\.(csv|tsv|txt|zip|xlsx)$/i.test(name) && !node.childNodes?.length) {
      const encodedSize = node.size ?? -1;
      const encoding = node.encoding?.toLowerCase() ?? "7bit";
      const transformedText = ["text/plain", "text/html", "text/x-amp-html"].includes(node.type) &&
        (!node.disposition || node.disposition === "inline") &&
        (node.parameters?.format?.toLowerCase() === "flowed" ||
         (node.parameters?.charset && !/^(?:ascii|us-ascii|utf-?8)$/i.test(node.parameters.charset)));
      const decodedUpperBound = (encoding === "base64" ? Math.floor(encodedSize * 3 / 4) : encodedSize) * (transformedText ? 4 : 1);
      const exactSize = !transformedText && !["base64", "quoted-printable"].includes(encoding);
      const part = node.part ?? (path.length ? path.join(".") : "1");
      if (!/^[1-9]\d*(?:\.[1-9]\d*)*$/.test(part) || part.length > 128) throw new ValidationError("The report email has an invalid MIME part.");
      // Encoded BODYSTRUCTURE sizes include wrapping and padding. The SDK decodes
      // only this part, and read() applies the exact attachment cap to its output.
      parts.push({ name, size: exactSize ? encodedSize : Math.min(MAX_ATTACHMENT_BYTES, decodedUpperBound), part, encodedSize, decodedUpperBound, encoding, exactSize });
    }
    for (const [index, child] of (node.childNodes ?? []).entries()) visit(child, depth + 1, path.concat(index + 1));
  }
  if (structure) visit(structure, 0, []);
  return parts;
}

async function readImapAttachment(
  credentials: ImapCredentials, folderId: string, validity: bigint, uid: number, part: ImapPart,
): Promise<Buffer> {
  if (!Number.isSafeInteger(part.encodedSize) || part.encodedSize < 0 || part.encodedSize > MAX_ENCODED_PART_BYTES ||
      !["7bit", "8bit", "binary", "base64", "quoted-printable"].includes(part.encoding)) {
    throw new ValidationError("The report attachment has an invalid declared size or encoding.");
  }
  sizeLimit(part.size);
  const client = imapClient(credentials);
  let lock: { release: () => void } | undefined;
  let content: Readable | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.connect();
    lock = await client.getMailboxLock(folderId, { readOnly: true, acquireTimeout: TIMEOUT_MS });
    if (!client.mailbox || client.mailbox.uidValidity !== validity) throw new ValidationError("The IMAP folder changed. Check the mailbox again before saving reports.");
    const download = await client.download(String(uid), part.part, { uid: true, maxBytes: MAX_ATTACHMENT_BYTES + 1 });
    content = download.content;
    if (!content) throw new ValidationError("The report attachment is no longer in the selected folder.");
    if (download.meta?.encoding && download.meta.encoding.toLowerCase() !== part.encoding) {
      throw new ValidationError("The report attachment encoding changed.");
    }
    timeout = setTimeout(() => content?.destroy(new UnavailableError("The IMAP report download took too long. Try checking it again.")), TIMEOUT_MS);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of content) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      sizeLimit(size);
      if (size > part.decodedUpperBound) throw new ValidationError("The report attachment exceeds its declared size.");
      chunks.push(buffer);
    }
    if (part.exactSize && size !== part.encodedSize) throw new ValidationError("The report attachment has an incorrect size.");
    return Buffer.concat(chunks, size);
  } catch (error) { throw imapError(error); }
  finally { clearTimeout(timeout); content?.destroy(); lock?.release(); await disconnect(client); }
}

export async function* imapReportMessages(credentials: ImapCredentials, folderId: string, skip: SkipMessage = () => false): AsyncGenerator<ReportMessage> {
  id(folderId);
  const client = imapClient(credentials);
  let lock: { release: () => void } | undefined;
  try {
    await client.connect();
    lock = await client.getMailboxLock(folderId, { readOnly: true, acquireTimeout: TIMEOUT_MS });
    if (!client.mailbox) throw new ValidationError("Choose an existing IMAP report folder.");
    const validity = client.mailbox.uidValidity;
    const count = client.mailbox.exists;
    for (let start = 1; start <= count; start += 100) {
      // Finish each FETCH before yielding: ImapFlow cannot issue a download while FETCH is active.
      const page: FetchMessageObject[] = [];
      for await (const message of client.fetch(`${start}:${Math.min(start + 99, count)}`, { uid: true, internalDate: true, size: true, bodyStructure: true, envelope: true })) {
        if (page.length >= 100) throw new ValidationError("The IMAP mailbox returned too many messages in one page.");
        page.push(message);
      }
      for (const message of page) {
        const messageId = `${validity}:${message.uid}`;
        if (skip(messageId)) continue;
        yield await oneMessage(messageId, async () => {
          const attachments = mimeParts(message.bodyStructure).map((part) => ({
            name: part.name, size: part.size, read: () => readImapAttachment(credentials, folderId, validity, message.uid, part),
          }));
          const sender = message.envelope?.from?.[0];
          return {
            receivedAt: received(message.internalDate ?? ""),
            attachments,
            from: headerText(sender?.name && sender.address ? `${sender.name} <${sender.address}>` : (sender?.address ?? sender?.name)),
            subject: headerText(message.envelope?.subject, 1000),
          };
        });
      }
    }
  } catch (error) { throw imapError(error); }
  finally { lock?.release(); await disconnect(client); }
}
