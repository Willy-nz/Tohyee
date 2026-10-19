import { type MailProvider, parseAddressList, type Participant, ProviderError, providerFetch } from "@/lib/crm/mail/providers";import { UnavailableError } from "@/lib/errors";

/*
 * Reading a farm mailbox (#319; FC1, FC9, decision 570): Gmail's API or
 * Microsoft Graph, read-only. Lists emails in a time window, then fetches
 * one at a time with its plain text, which is read and thrown away: only
 * what an arrangement needs is kept (decision 571). No call is made inside a
 * database transaction.
 */

export const FARM_GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"];
export const FARM_MICROSOFT_SCOPES = ["offline_access", "User.Read", "Mail.Read"];

export type FarmMail = {
  externalId: string;
  threadId: string | null;
  sentAt: string;
  from: Participant;
  subject: string | null;
  /** The plain text, at most 20,000 characters. */
  text: string;
  webLink: string | null;
};

const TIMEOUT_MS = 30_000;
const MAX_TEXT = 20_000;

/** A GET to Gmail or Graph with the mailbox's token (also used by the private copy, src/lib/private-mail). */
export async function getJson<T>(url: string, token: string, headers: Record<string, string> = {}): Promise<T> {
  let response: Response;
  try {
    response = await providerFetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new UnavailableError(`Couldn't reach ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  if (!response.ok) throw new ProviderError(response.status, `${new URL(url).host} said ${response.status}: ${text.slice(0, 200) || "no details"}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** Text from HTML: tags dropped, line breaks kept, common entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    // Last, so "&amp;lt;" stays "&lt;" rather than becoming "<".
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ");
}

type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] };

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** The plain text of a Gmail message: its text/plain part, else its HTML as text. */
export function gmailText(part: GmailPart | undefined): string {
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (node: GmailPart | undefined) => {
    if (!node) return;
    if (node.mimeType === "text/plain" && node.body?.data) plain.push(decodeBase64Url(node.body.data));
    else if (node.mimeType === "text/html" && node.body?.data) html.push(decodeBase64Url(node.body.data));
    for (const child of node.parts ?? []) walk(child);
  };
  walk(part);
  const text = plain.length > 0 ? plain.join("\n") : htmlToText(html.join("\n"));
  return text.slice(0, MAX_TEXT);
}

// Folders and labels (#340; FC25-FC30, decisions 584-586) ------------------------------------

/**
 * A folder (Outlook) or label (Gmail) the member can choose to be read.
 * Folder names are the member's private metadata, like the mailbox itself
 * (decision 571).
 */
export type MailFolder = {
  id: string;
  /** Its own name ("Farm"). */
  name: string;
  /** Its name with its parents' ("Inbox › Farm"; Gmail's own "Farm/LIC"). */
  path: string;
  parentId: string | null;
  /** How many folders deep (0 at the top). */
  depth: number;
  /** Gmail's Sent, Drafts, Spam and Trash: offered for the private copy only, never read for the farm calendar (#250, decision 615). */
  privateOnly?: boolean;
};

/** At most this many folders are listed (more are left out, deepest first). */
export const MAX_FOLDERS = 500;
const MAX_FOLDER_DEPTH = 6;

/**
 * Gmail's labels as folders: the Inbox and the member's own labels (not
 * Sent, Spam, Trash, Drafts, categories or the like). A nested label is
 * named "Farm/LIC" by Gmail, so its parent is the label named "Farm".
 */
export function gmailFolders(labels: Array<{ id: string; name: string; type?: string }>): MailFolder[] {
  const usable = labels.filter((label) => label.id === "INBOX" || label.type === "user");
  const byName = new Map(usable.map((label) => [label.id === "INBOX" ? "Inbox" : label.name, label.id]));
  const folders = usable.map((label) => {
    const path = label.id === "INBOX" ? "Inbox" : label.name;
    const parts = path.split("/");
    let parentId: string | null = null;
    for (let cut = parts.length - 1; cut > 0 && !parentId; cut -= 1) parentId = byName.get(parts.slice(0, cut).join("/")) ?? null;
    return { id: label.id, name: parts[parts.length - 1] || path, path, parentId, depth: 0 };
  });
  return orderFolders(folders);
}

/** Folders as a tree, parents before their children, each level by name; depth worked out from the parents. */
export function orderFolders(folders: MailFolder[]): MailFolder[] {
  const ids = new Set(folders.map((folder) => folder.id));
  const children = new Map<string | null, MailFolder[]>();
  for (const folder of folders) {
    const parent = folder.parentId && ids.has(folder.parentId) ? folder.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), folder]);
  }
  // The Inbox first, then by name, as Gmail and Outlook list them.
  const rank = (folder: MailFolder) => (folder.id === "INBOX" || folder.path.toLowerCase() === "inbox" ? 0 : 1);
  const ordered: MailFolder[] = [];
  const walk = (parent: string | null, depth: number) => {
    const level = [...(children.get(parent) ?? [])].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "en-NZ", { sensitivity: "base" }));
    for (const folder of level) {
      ordered.push({ ...folder, parentId: parent, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return ordered;
}

/** A folder's subfolders, all the way down. */
export function subfolderIds(folders: MailFolder[], id: string): string[] {
  const found: string[] = [];
  const walk = (parent: string) => {
    for (const folder of folders) {
      if (folder.parentId === parent && !found.includes(folder.id)) {
        found.push(folder.id);
        walk(folder.id);
      }
    }
  };
  walk(id);
  return found;
}

type GraphFolder = { id: string; displayName?: string; parentFolderId?: string; childFolderCount?: number };
const GRAPH_FOLDER_SELECT = "id,displayName,parentFolderId,childFolderCount";

async function graphFolderPages(url: string, token: string): Promise<GraphFolder[]> {
  const found: GraphFolder[] = [];
  let next: string | undefined = url;
  while (next && found.length < MAX_FOLDERS) {
    const page: { value?: GraphFolder[]; "@odata.nextLink"?: string } = await getJson(next, token);
    found.push(...(page?.value ?? []));
    next = page?.["@odata.nextLink"];
  }
  return found;
}

/** Outlook folders under `parentId`, all the way down (at most MAX_FOLDERS). */
async function graphChildFolders(token: string, parentId: string, parentPath: string, depth: number, into: MailFolder[]): Promise<void> {
  if (depth > MAX_FOLDER_DEPTH || into.length >= MAX_FOLDERS) return;
  const params = new URLSearchParams({ $select: GRAPH_FOLDER_SELECT, $top: "100" });
  const children = await graphFolderPages(`https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(parentId)}/childFolders?${params}`, token);
  for (const child of children) {
    if (into.length >= MAX_FOLDERS) return;
    const name = child.displayName ?? "(no name)";
    const path = `${parentPath} › ${name}`;
    into.push({ id: child.id, name, path, parentId, depth });
    if ((child.childFolderCount ?? 0) > 0) await graphChildFolders(token, child.id, path, depth + 1, into);
  }
}

/** The mailbox's folders (Outlook) or labels (Gmail), parents first. Only names and ids: no email is read. */
export async function listMailFolders(provider: MailProvider, token: string): Promise<MailFolder[]> {
  if (provider === "google") {
    const page = await getJson<{ labels?: Array<{ id: string; name: string; type?: string }> }>("https://gmail.googleapis.com/gmail/v1/users/me/labels", token);
    return gmailFolders(page?.labels ?? []).slice(0, MAX_FOLDERS);
  }
  const params = new URLSearchParams({ $select: GRAPH_FOLDER_SELECT, $top: "100" });
  const top = await graphFolderPages(`https://graph.microsoft.com/v1.0/me/mailFolders?${params}`, token);
  const folders: MailFolder[] = [];
  for (const folder of top) {
    if (folders.length >= MAX_FOLDERS) break;
    const name = folder.displayName ?? "(no name)";
    folders.push({ id: folder.id, name, path: name, parentId: null, depth: 0 });
    if ((folder.childFolderCount ?? 0) > 0) await graphChildFolders(token, folder.id, name, 1, folders);
  }
  return orderFolders(folders);
}

/** One chosen folder's emails: newest first, at most `max`. `missing` when the folder no longer exists. */
export type FolderListing = { ids: string[]; complete: boolean; missing: boolean };

/**
 * Email ids in a chosen folder (and, when asked, its subfolders) received
 * from `after`, newest first, at most `max` for the folder. For Gmail,
 * `labels` is the mailbox's current labels (subfolders and whether the
 * label still exists come from it).
 */
export async function listFolderMailIds(
  provider: MailProvider,
  token: string,
  folder: { externalId: string; includeSubfolders: boolean },
  after: Date,
  max: number,
  labels: MailFolder[] | null = null,
  options: { includeSpamTrash?: boolean; graphPageSize?: number } = {},
): Promise<FolderListing> {
  const ids: string[] = [];
  let complete = true;
  if (provider === "google") {
    const current = labels ?? (await listMailFolders(provider, token));
    if (!current.some((label) => label.id === folder.externalId)) return { ids: [], complete: true, missing: true };
    const labelIds = [folder.externalId, ...(folder.includeSubfolders ? subfolderIds(current, folder.externalId) : [])];
    for (const labelId of labelIds) {
      const before = ids.length;
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ q: `after:${Math.floor(after.getTime() / 1000)}`, labelIds: labelId, maxResults: "500", includeSpamTrash: options.includeSpamTrash ? "true" : "false" });
        if (pageToken) params.set("pageToken", pageToken);
        const page = await getJson<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, token);
        for (const message of page?.messages ?? []) if (!ids.includes(message.id)) ids.push(message.id);
        pageToken = page?.nextPageToken;
      } while (pageToken && ids.length - before < max);
      if (pageToken) complete = false;
    }
    return { ids, complete, missing: false };
  }
  let folderIds = [folder.externalId];
  if (folder.includeSubfolders) {
    const below: MailFolder[] = [];
    try {
      await graphChildFolders(token, folder.externalId, "", 1, below);
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return { ids: [], complete: true, missing: true };
      throw error;
    }
    folderIds = [folder.externalId, ...below.map((entry) => entry.id)];
  }
  for (const folderId of folderIds) {
    const before = ids.length;
    const params = new URLSearchParams({ $filter: `receivedDateTime ge ${after.toISOString()}`, $select: "id", $orderby: "receivedDateTime desc", $top: String(options.graphPageSize ?? 100) });
    let next: string | undefined = `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(folderId)}/messages?${params}`;
    try {
      while (next && ids.length - before < max) {
        const page: { value?: Array<{ id: string }>; "@odata.nextLink"?: string } = await getJson(next, token);
        for (const message of page?.value ?? []) if (!ids.includes(message.id)) ids.push(message.id);
        next = page?.["@odata.nextLink"];
      }
    } catch (error) {
      // The chosen folder was deleted (or moved out of reach) in Outlook.
      if (error instanceof ProviderError && error.status === 404) {
        if (folderId === folder.externalId) return { ids: [], complete: true, missing: true };
        continue;
      }
      throw error;
    }
    if (next) complete = false;
  }
  return { ids, complete, missing: false };
}

/** One email with its plain text, or null when it has no sender. */
export async function fetchFarmMail(provider: MailProvider, token: string, id: string, mailbox: string): Promise<FarmMail | null> {
  if (provider === "google") {
    type GmailMessage = { id: string; threadId?: string; internalDate?: string; payload?: GmailPart & { headers?: Array<{ name: string; value: string }> } };
    const message = await getJson<GmailMessage>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, token);
    const header = (name: string) => message.payload?.headers?.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value;
    const from = parseAddressList(header("From"))[0];
    if (!from) return null;
    const date = Number(message.internalDate);
    return {
      externalId: message.id,
      threadId: message.threadId ?? null,
      sentAt: new Date(Number.isFinite(date) ? date : Date.parse(header("Date") ?? "") || Date.now()).toISOString(),
      from,
      subject: header("Subject")?.slice(0, 500) ?? null,
      text: gmailText(message.payload),
      webLink: `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#all/${encodeURIComponent(message.id)}`,
    };
  }
  type GraphMessage = {
    id: string;
    conversationId?: string;
    subject?: string | null;
    from?: { emailAddress?: { address?: string; name?: string } } | null;
    sentDateTime?: string | null;
    receivedDateTime?: string | null;
    webLink?: string | null;
    body?: { contentType?: string; content?: string } | null;
  };
  const params = new URLSearchParams({ $select: "id,conversationId,subject,from,sentDateTime,receivedDateTime,webLink,body" });
  const message = await getJson<GraphMessage>(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}?${params}`, token, { Prefer: 'outlook.body-content-type="text"' });
  const address = message.from?.emailAddress?.address;
  if (!address) return null;
  const content = message.body?.content ?? "";
  return {
    externalId: message.id,
    threadId: message.conversationId ?? null,
    sentAt: new Date(message.sentDateTime ?? message.receivedDateTime ?? Date.now()).toISOString(),
    from: { email: address.toLowerCase(), name: message.from?.emailAddress?.name ?? null },
    subject: message.subject?.slice(0, 500) ?? null,
    text: (message.body?.contentType?.toLowerCase() === "html" ? htmlToText(content) : content).slice(0, MAX_TEXT),
    webLink: message.webLink ?? null,
  };
}
