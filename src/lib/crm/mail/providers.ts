import { UnavailableError, ValidationError } from "@/lib/errors";

/**
 * Google (Gmail and Google Calendar) and Microsoft 365 (Graph) for CRM email
 * and calendar sync (examples MAIL1-MAIL9). Read-only: nothing here sends,
 * changes or deletes anything in a mailbox or calendar (sales emails, once a
 * member allows sending, go through `src/lib/crm/sales-email.ts`; sending documents
 * through Microsoft Graph or the Gmail API is in `src/lib/email/microsoft.ts`
 * and `src/lib/email/google.ts`, with their own sign-in and scopes). Every call has a
 * timeout, and none is made inside a database transaction.
 */
export const MAIL_PROVIDERS = ["google", "microsoft"] as const;
export type MailProvider = (typeof MAIL_PROVIDERS)[number];
export const MAIL_PROVIDER_LABELS: Record<MailProvider, string> = { google: "Gmail and Google Calendar", microsoft: "Microsoft 365" };

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];
export const MICROSOFT_SCOPES = ["offline_access", "User.Read", "Mail.Read", "Calendars.Read"];
/**
 * Sending documents from the organisation's mailbox (Settings > Email): only
 * what's needed to send as the signed-in mailbox and learn its address.
 * Mail.Send is a delegated permission, so Tohyee can only send as that one
 * mailbox, never read it.
 */
export const MICROSOFT_SEND_SCOPES = ["offline_access", "User.Read", "Mail.Send"];
/**
 * Sending documents from a Gmail or Google Workspace mailbox: gmail.send
 * ("Send email on your behalf" in Google's Gmail API discovery document; it
 * can't read the mailbox) and the address, which the Gmail profile can't give
 * with gmail.send alone, so it comes from Google's userinfo (openid and
 * userinfo.email, the scopes Google's OAuth2 v2 discovery document lists for
 * it).
 */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GOOGLE_SEND_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email", GMAIL_SEND_SCOPE];

export type ProviderApp = { clientId: string; clientSecret: string; tenant?: string };
/** `scope`: the scopes actually granted, when the provider says (Google does; people can untick some). */
export type Tokens = { accessToken: string; refreshToken: string | null; expiresInSeconds: number; scope?: string | null };

export type Participant = { email: string; name: string | null };
export type ProviderMessage = {
  externalId: string;
  threadId: string | null;
  sentAt: string;
  from: Participant;
  to: Participant[];
  subject: string | null;
  preview: string | null;
};
export type ProviderEvent = {
  externalId: string;
  title: string | null;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  attendees: Participant[];
};

/** Lets tests swap the network for canned responses. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetcher: FetchLike = (input, init) => fetch(input, init);
export function setMailFetchForTests(replacement: FetchLike | null): void {
  fetcher = replacement ?? ((input, init) => fetch(input, init));
}
/** The same fetch (swappable in tests), for calls that need the raw response, such as Graph's sendMail. */
export function providerFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetcher(input, init);
}

export class ProviderError extends Error {
  readonly status: number;
  /** The OAuth error code when there was one, such as `invalid_grant` or `admin_policy_enforced`. */
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const TIMEOUT_MS = 30_000;
const MAX_MESSAGES = 500;

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new UnavailableError(`Couldn't reach ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const detail =
      (body as { error_description?: string; error?: { message?: string } | string } | null)?.error_description ??
      (typeof (body as { error?: unknown } | null)?.error === "string"
        ? ((body as { error: string }).error)
        : ((body as { error?: { message?: string } } | null)?.error?.message ?? text.slice(0, 200)));
    const code = typeof (body as { error?: unknown } | null)?.error === "string" ? (body as { error: string }).error : null;
    throw new ProviderError(response.status, `${new URL(url).host} said ${response.status}: ${detail || "no details"}`, code);
  }
  return body as T;
}

function bearer(token: string): RequestInit {
  return { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } };
}

// ---------------------------------------------------------------------------
// Signing in (OAuth 2.0 authorization code flow)

/**
 * The provider's sign-in address. `scopes` defaults to the CRM's read-only
 * ones; sending documents asks for its own (and, for Google, only those: no
 * `include_granted_scopes`, so the sending token can't read the mailbox).
 */
export function authorisationUrl(provider: MailProvider, app: ProviderApp, redirectUri: string, state: string, scopes?: readonly string[]): string {
  if (provider === "google") {
    const params = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: (scopes ?? GOOGLE_SCOPES).join(" "),
      access_type: "offline",
      prompt: "consent",
      ...(scopes ? {} : { include_granted_scopes: "true" }),
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: (scopes ?? MICROSOFT_SCOPES).join(" "),
    state,
  });
  return `https://login.microsoftonline.com/${encodeURIComponent(app.tenant || "common")}/oauth2/v2.0/authorize?${params}`;
}

function tokenUrl(provider: MailProvider, app: ProviderApp): string {
  return provider === "google"
    ? "https://oauth2.googleapis.com/token"
    : `https://login.microsoftonline.com/${encodeURIComponent(app.tenant || "common")}/oauth2/v2.0/token`;
}

async function tokenRequest(provider: MailProvider, app: ProviderApp, fields: Record<string, string>, microsoftScopes: readonly string[]): Promise<Tokens> {
  const body = new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...fields });
  if (provider === "microsoft") body.set("scope", microsoftScopes.join(" "));
  const result = await request<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }>(tokenUrl(provider, app), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!result?.access_token) throw new ValidationError("The sign-in didn't return an access token.");
  return { accessToken: result.access_token, refreshToken: result.refresh_token ?? null, expiresInSeconds: result.expires_in ?? 3600, scope: result.scope ?? null };
}

export function exchangeCode(
  provider: MailProvider,
  app: ProviderApp,
  code: string,
  redirectUri: string,
  microsoftScopes: readonly string[] = MICROSOFT_SCOPES,
): Promise<Tokens> {
  return tokenRequest(provider, app, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, microsoftScopes);
}

export function refreshAccess(provider: MailProvider, app: ProviderApp, refreshToken: string, microsoftScopes: readonly string[] = MICROSOFT_SCOPES): Promise<Tokens> {
  return tokenRequest(provider, app, { grant_type: "refresh_token", refresh_token: refreshToken }, microsoftScopes);
}

/**
 * The Google account's address from Google's userinfo (OAuth2 v2
 * `userinfo.get`), for a sign-in that only has gmail.send, which the Gmail
 * profile doesn't accept.
 */
export async function googleAccountAddress(accessToken: string): Promise<string> {
  const info = await request<{ email?: string; verified_email?: boolean }>("https://www.googleapis.com/oauth2/v2/userinfo", bearer(accessToken));
  if (!info?.email) throw new ValidationError("Google didn't say which account this is.");
  if (info.verified_email === false) throw new ValidationError("Google says this account's email address isn't verified, so Tohyee can't send from it.");
  return info.email;
}

/** The mailbox's own address. */
export async function mailboxAddress(provider: MailProvider, accessToken: string): Promise<string> {
  if (provider === "google") {
    const profile = await request<{ emailAddress?: string }>("https://gmail.googleapis.com/gmail/v1/users/me/profile", bearer(accessToken));
    if (!profile?.emailAddress) throw new ValidationError("Google didn't say which mailbox this is.");
    return profile.emailAddress;
  }
  const me = await request<{ mail?: string | null; userPrincipalName?: string }>("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", bearer(accessToken));
  const address = me?.mail ?? me?.userPrincipalName;
  if (!address) throw new ValidationError("Microsoft didn't say which mailbox this is.");
  return address;
}

// ---------------------------------------------------------------------------
// Emails

/** "Aroha Ngata <aroha@manukavets.nz>, bob@x.nz" → participants. */
export function parseAddressList(header: string | undefined): Participant[] {
  if (!header) return [];
  const out: Participant[] = [];
  const pattern = /(?:"?([^"<,]*?)"?\s*<([^>\s]+@[^>\s]+)>|([^\s<>,;"]+@[^\s<>,;"]+))/g;
  for (const match of header.matchAll(pattern)) {
    const email = (match[2] ?? match[3] ?? "").trim().toLowerCase();
    if (!email) continue;
    const name = match[1]?.trim() || null;
    out.push({ email, name });
  }
  return out;
}

function clip(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

type GmailList = { messages?: Array<{ id: string }>; nextPageToken?: string };
type GmailMessage = {
  id: string;
  threadId?: string;
  internalDate?: string;
  snippet?: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
};

/** Emails since a time, newest first, at most 500 a sync. */
export async function listMessages(provider: MailProvider, accessToken: string, since: Date): Promise<ProviderMessage[]> {
  const messages: ProviderMessage[] = [];
  if (provider === "google") {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q: `after:${Math.floor(since.getTime() / 1000)}`, maxResults: "100" });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await request<GmailList>(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, bearer(accessToken));
      ids.push(...(page?.messages ?? []).map((m) => m.id));
      pageToken = page?.nextPageToken;
    } while (pageToken && ids.length < MAX_MESSAGES);
    for (const id of ids.slice(0, MAX_MESSAGES)) {
      const params = new URLSearchParams({ format: "metadata" });
      for (const header of ["From", "To", "Cc", "Subject", "Date"]) params.append("metadataHeaders", header);
      const message = await request<GmailMessage>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?${params}`, bearer(accessToken));
      const header = (name: string) => message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
      const from = parseAddressList(header("From"))[0];
      if (!from) continue;
      messages.push({
        externalId: message.id,
        threadId: message.threadId ?? null,
        sentAt: new Date(Number(message.internalDate ?? Date.parse(header("Date") ?? "") ?? Date.now())).toISOString(),
        from,
        to: [...parseAddressList(header("To")), ...parseAddressList(header("Cc"))],
        subject: clip(header("Subject"), 500),
        preview: clip(message.snippet, 300),
      });
    }
    return messages;
  }
  type GraphAddress = { emailAddress?: { address?: string; name?: string } };
  type GraphMessage = {
    id: string;
    conversationId?: string;
    subject?: string | null;
    bodyPreview?: string | null;
    from?: GraphAddress | null;
    toRecipients?: GraphAddress[];
    ccRecipients?: GraphAddress[];
    sentDateTime?: string | null;
    receivedDateTime?: string | null;
  };
  const person = (value: GraphAddress | null | undefined): Participant | null =>
    value?.emailAddress?.address ? { email: value.emailAddress.address.toLowerCase(), name: value.emailAddress.name ?? null } : null;
  const params = new URLSearchParams({
    $filter: `receivedDateTime ge ${since.toISOString()}`,
    $select: "id,conversationId,subject,bodyPreview,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime",
    $orderby: "receivedDateTime desc",
    $top: "50",
  });
  let next: string | undefined = `https://graph.microsoft.com/v1.0/me/messages?${params}`;
  while (next && messages.length < MAX_MESSAGES) {
    const page: { value?: GraphMessage[]; "@odata.nextLink"?: string } = await request(next, bearer(accessToken));
    for (const message of page?.value ?? []) {
      const from = person(message.from);
      if (!from) continue;
      messages.push({
        externalId: message.id,
        threadId: message.conversationId ?? null,
        sentAt: new Date(message.sentDateTime ?? message.receivedDateTime ?? Date.now()).toISOString(),
        from,
        to: [...(message.toRecipients ?? []), ...(message.ccRecipients ?? [])].map(person).filter((p): p is Participant => p !== null),
        subject: clip(message.subject, 500),
        preview: clip(message.bodyPreview, 300),
      });
    }
    next = page?.["@odata.nextLink"];
  }
  return messages.slice(0, MAX_MESSAGES);
}

// ---------------------------------------------------------------------------
// Meetings

export async function listEvents(provider: MailProvider, accessToken: string, from: Date, to: Date): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  if (provider === "google") {
    type GoogleWhen = { dateTime?: string; date?: string };
    type GoogleEvent = {
      id: string;
      status?: string;
      summary?: string;
      location?: string;
      start?: GoogleWhen;
      end?: GoogleWhen;
      attendees?: Array<{ email?: string; displayName?: string }>;
      organizer?: { email?: string; displayName?: string };
    };
    const when = (value: GoogleWhen | undefined) => (value?.dateTime ?? (value?.date ? `${value.date}T00:00:00Z` : null));
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", maxResults: "250", orderBy: "startTime" });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await request<{ items?: GoogleEvent[]; nextPageToken?: string }>(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
        bearer(accessToken),
      );
      for (const event of page?.items ?? []) {
        const start = when(event.start);
        if (event.status === "cancelled" || !start) continue;
        const people = [...(event.attendees ?? []), ...(event.organizer ? [event.organizer] : [])]
          .filter((a) => a.email)
          .map((a) => ({ email: a.email!.toLowerCase(), name: a.displayName ?? null }));
        const end = when(event.end);
        events.push({
          externalId: event.id,
          title: clip(event.summary, 500),
          startsAt: new Date(start).toISOString(),
          endsAt: end ? new Date(end).toISOString() : null,
          location: clip(event.location, 300),
          attendees: people,
        });
      }
      pageToken = page?.nextPageToken;
    } while (pageToken && events.length < MAX_MESSAGES);
    return events;
  }
  type GraphEvent = {
    id: string;
    subject?: string | null;
    isCancelled?: boolean;
    start?: { dateTime?: string };
    end?: { dateTime?: string };
    location?: { displayName?: string } | null;
    attendees?: Array<{ emailAddress?: { address?: string; name?: string } }>;
    organizer?: { emailAddress?: { address?: string; name?: string } } | null;
  };
  const utc = (value: string | undefined) => (value ? new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`).toISOString() : null);
  const params = new URLSearchParams({
    startDateTime: from.toISOString(),
    endDateTime: to.toISOString(),
    $select: "id,subject,isCancelled,start,end,location,attendees,organizer",
    $top: "100",
  });
  let next: string | undefined = `https://graph.microsoft.com/v1.0/me/calendarView?${params}`;
  while (next && events.length < MAX_MESSAGES) {
    const page: { value?: GraphEvent[]; "@odata.nextLink"?: string } = await request(next, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", Prefer: 'outlook.timezone="UTC"' },
    });
    for (const event of page?.value ?? []) {
      const start = utc(event.start?.dateTime);
      if (event.isCancelled || !start) continue;
      const people = [...(event.attendees ?? []), ...(event.organizer ? [event.organizer] : [])]
        .filter((a) => a.emailAddress?.address)
        .map((a) => ({ email: a.emailAddress!.address!.toLowerCase(), name: a.emailAddress?.name ?? null }));
      events.push({
        externalId: event.id,
        title: clip(event.subject, 500),
        startsAt: start,
        endsAt: utc(event.end?.dateTime),
        location: clip(event.location?.displayName, 300),
        attendees: people,
      });
    }
    next = page?.["@odata.nextLink"];
  }
  return events;
}
