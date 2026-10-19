import { type MailProvider, parseAddressList, type Participant, ProviderError, providerFetch } from "@/lib/crm/mail/providers";
import { UnavailableError } from "@/lib/errors";

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

async function getJson<T>(url: string, token: string, headers: Record<string, string> = {}): Promise<T> {
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

/**
 * Email ids from `after` up to `before` (null: now), newest first, at most
 * `max`. `complete` says whether that's every email in the window.
 */
export async function listFarmMailIds(provider: MailProvider, token: string, after: Date, before: Date | null, max: number): Promise<{ ids: string[]; complete: boolean }> {
  const ids: string[] = [];
  if (provider === "google") {
    let pageToken: string | undefined;
    const q = `after:${Math.floor(after.getTime() / 1000)}${before ? ` before:${Math.floor(before.getTime() / 1000)}` : ""}`;
    do {
      const params = new URLSearchParams({ q, maxResults: "100", includeSpamTrash: "false" });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await getJson<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, token);
      ids.push(...(page?.messages ?? []).map((message) => message.id));
      pageToken = page?.nextPageToken;
    } while (pageToken && ids.length < max);
    return { ids: ids.slice(0, max), complete: !pageToken && ids.length <= max };
  }
  const filter = `receivedDateTime ge ${after.toISOString()}${before ? ` and receivedDateTime lt ${before.toISOString()}` : ""}`;
  let next: string | undefined = `https://graph.microsoft.com/v1.0/me/messages?${new URLSearchParams({ $filter: filter, $select: "id", $orderby: "receivedDateTime desc", $top: "100" })}`;
  while (next && ids.length < max) {
    const page: { value?: Array<{ id: string }>; "@odata.nextLink"?: string } = await getJson(next, token);
    ids.push(...(page?.value ?? []).map((message) => message.id));
    next = page?.["@odata.nextLink"];
  }
  return { ids: ids.slice(0, max), complete: !next && ids.length <= max };
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
