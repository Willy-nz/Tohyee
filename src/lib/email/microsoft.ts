import { randomBytes, randomUUID } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import {
  authorisationUrl,
  exchangeCode,
  MICROSOFT_SEND_SCOPES,
  mailboxAddress,
  ProviderError,
  type ProviderApp,
  providerFetch,
  refreshAccess,
  type Tokens,
} from "@/lib/crm/mail/providers";
import { microsoftApp } from "@/lib/crm/mail/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import type { MicrosoftAccount } from "@/lib/email/settings";
import type { OutgoingMessage, SendResult } from "@/lib/email/smtp";
import { ForbiddenError, UnavailableError, ValidationError } from "@/lib/errors";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { encryptSecret, secretsAvailable } from "@/lib/secrets";

/**
 * "Microsoft 365 / Outlook (sign in)" for sending documents (Settings >
 * Email), decided with Jess on 30 Sep 2026 because Microsoft is retiring
 * password (basic-auth) SMTP: an admin signs in to the mailbox once with the
 * OAuth 2.0 authorization code flow, using the organisation's own Microsoft
 * app registration (the one the CRM's mail sync uses, `crm_mail_settings`)
 * with the delegated Mail.Send permission, and Tohyee then sends as that
 * mailbox with Microsoft Graph's `POST /me/sendMail`. The refresh token is
 * encrypted like the SMTP password and replaced whenever Microsoft issues a
 * new one. Network calls are never made inside a database transaction.
 *
 * sendMail (learn.microsoft.com, "user: sendMail", v1.0): delegated
 * permission Mail.Send; body `{ message, saveToSentItems }`; `202 Accepted`
 * means accepted, not yet delivered. Attachments go in the message as
 * `#microsoft.graph.fileAttachment` with `contentBytes` (base64); inline
 * images with `isInline` and `contentId`. Microsoft's attachment guide says
 * attachments under 3 MB go in the request, and 3-150 MB need an upload
 * session on a draft, which Tohyee doesn't do yet: emails whose attachments
 * add up to more than 3 MB are refused with a plain message.
 */

export const EMAIL_CALLBACK_PATH = "/api/email/microsoft/callback";
const GRAPH = "https://graph.microsoft.com/v1.0";
const STATE_MINUTES = 15;
const TIMEOUT_MS = 60_000;
/** Attachments that can go in one sendMail request (Microsoft: "under 3 MB"). */
export const MAX_GRAPH_ATTACHMENT_BYTES = 3 * 1024 * 1024;

function redirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${EMAIL_CALLBACK_PATH}`;
}

// ---------------------------------------------------------------------------
// Connecting (admins)

/** Microsoft's sign-in address, with a one-time state tied to this admin and organisation. */
export async function startMicrosoftSending(tx: OrgTx, origin: string): Promise<{ url: string }> {
  if (!tx.actor.userId) throw new ForbiddenError("Sign in to connect a mailbox.");
  if (!secretsAvailable()) {
    throw new UnavailableError("This server has no TOHYEE_SECRET_KEY, so it can't keep the mailbox's sign-in safely. A server admin needs to set it first.");
  }
  const app = await microsoftApp(tx);
  const state = `${tx.organisationId}.${randomBytes(24).toString("base64url")}`;
  await tx.query("delete from email_oauth_states where created_at < now() - interval '1 day'");
  await tx.query("insert into email_oauth_states (state, user_id) values ($1, $2)", [state, tx.actor.userId]);
  return { url: authorisationUrl("microsoft", app, redirectUri(origin), state, MICROSOFT_SEND_SCOPES) };
}

/**
 * Checks the state (unused, under 15 minutes old, the same signed-in user)
 * and marks it used, before the code is exchanged; returns the app to
 * exchange it with.
 */
export async function claimSendingState(tx: OrgTx, state: string): Promise<ProviderApp> {
  const found = await tx.query<{ user_id: string; fresh: boolean; used_at: string | null }>(
    `select user_id, created_at > now() - make_interval(mins => $2) as fresh, used_at
       from email_oauth_states where state = $1 for update`,
    [state, STATE_MINUTES],
  );
  const row = found.rows[0];
  if (!row || row.used_at || !row.fresh || row.user_id !== tx.actor.userId) {
    throw new ValidationError("That sign-in link has expired or was already used. Start connecting again.");
  }
  await tx.query("update email_oauth_states set used_at = now() where state = $1", [state]);
  return microsoftApp(tx);
}

export type SendingConnection = { tokens: Tokens; email: string };

/** Exchanges the code and finds the mailbox's address (network, no transaction). */
export async function fetchSendingConnection(app: ProviderApp, code: string, origin: string): Promise<SendingConnection> {
  const tokens = await exchangeCode("microsoft", app, code, redirectUri(origin), MICROSOFT_SEND_SCOPES);
  if (!tokens.refreshToken) throw new ValidationError("The sign-in didn't allow offline access, so Tohyee couldn't keep sending. Try connecting again.");
  const email = (await mailboxAddress("microsoft", tokens.accessToken)).toLowerCase();
  return { tokens, email };
}

/** Stores the connected mailbox (tokens encrypted) and makes it the way documents are sent. */
export async function saveSendingConnection(tx: OrgTx, connection: SendingConnection): Promise<string> {
  const { tokens, email } = connection;
  const values = [
    email,
    encryptSecret(tokens.refreshToken!),
    encryptSecret(tokens.accessToken),
    new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(),
    tx.actor.email,
  ];
  const updated = await tx.query(
    `update organisation_email_settings
        set sending_method = 'microsoft', microsoft_email = $1, microsoft_refresh_token_ciphertext = $2,
            microsoft_access_token_ciphertext = $3, microsoft_access_token_expires_at = $4, microsoft_connected_by_email = $5,
            microsoft_connected_at = now(), updated_by_email = $5, updated_at = now(),
            last_test_at = null, last_test_ok = null, last_test_error = null
      where id = true`,
    values,
  );
  if ((updated.rowCount ?? 0) === 0) {
    const settings = await getOrganisationSettings(tx);
    await tx.query(
      `insert into organisation_email_settings (id, from_name, from_address, sending_method, microsoft_email, microsoft_refresh_token_ciphertext,
                                                microsoft_access_token_ciphertext, microsoft_access_token_expires_at,
                                                microsoft_connected_by_email, microsoft_connected_at, updated_by_email, updated_at)
       values (true, $6, $1, 'microsoft', $1, $2, $3, $4, $5, now(), $5, now())`,
      [...values, settings.displayName.replace(/["<>\r\n]/g, "").slice(0, 100) || "Accounts"],
    );
  }
  await writeAuditEvent(tx, { eventType: "email_settings.microsoft_connected", entityType: "email_settings", entityId: "email", details: { email } });
  return email;
}

/**
 * Forgets the mailbox's sign-in (Microsoft still lists Tohyee under the
 * account's app permissions until someone removes it there). If SMTP
 * details are saved they're used again; otherwise nothing is set up.
 */
export async function disconnectMicrosoftSending(tx: OrgTx): Promise<void> {
  const current = await tx.query<{ microsoft_email: string | null; smtp_host: string | null }>(
    "select microsoft_email, smtp_host from organisation_email_settings where id = true",
  );
  const row = current.rows[0];
  if (!row?.microsoft_email) return;
  if (row.smtp_host) {
    await tx.query(
      `update organisation_email_settings
          set sending_method = 'smtp', microsoft_email = null, microsoft_refresh_token_ciphertext = null, microsoft_access_token_ciphertext = null,
              microsoft_access_token_expires_at = null, microsoft_connected_by_email = null, microsoft_connected_at = null,
              updated_by_email = $1, updated_at = now(), last_test_at = null, last_test_ok = null, last_test_error = null
        where id = true`,
      [tx.actor.email],
    );
  } else {
    await tx.query("delete from organisation_email_settings");
  }
  await writeAuditEvent(tx, {
    eventType: "email_settings.microsoft_disconnected",
    entityType: "email_settings",
    entityId: "email",
    details: { email: row.microsoft_email },
  });
}

// ---------------------------------------------------------------------------
// Sending

/** Saves tokens Microsoft issued on a refresh (a new refresh token replaces the old), if the same mailbox is still connected. */
export async function saveRefreshedTokens(tx: OrgTx, email: string, tokens: Tokens): Promise<void> {
  await tx.query(
    `update organisation_email_settings
        set microsoft_access_token_ciphertext = $2, microsoft_access_token_expires_at = $3,
            microsoft_refresh_token_ciphertext = coalesce($4, microsoft_refresh_token_ciphertext)
      where id = true and microsoft_email = $1`,
    [email, encryptSecret(tokens.accessToken), new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(), tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null],
  );
}

/**
 * A current access token: the saved one if it has more than a minute left,
 * otherwise a new one from the refresh token, which `save` stores (in its
 * own transaction; this makes the network call outside any).
 */
export async function microsoftAccessToken(account: MicrosoftAccount, save: (tokens: Tokens) => Promise<void>, now = new Date()): Promise<string> {
  if (account.accessToken && account.accessTokenExpiresAt && new Date(account.accessTokenExpiresAt).getTime() > now.getTime() + 60_000) {
    return account.accessToken;
  }
  const tokens = await refreshAccess("microsoft", account.app, account.refreshToken, MICROSOFT_SEND_SCOPES);
  await save(tokens);
  return tokens.accessToken;
}

type GraphRecipient = { emailAddress: { address: string } };
const recipients = (addresses: string[]): GraphRecipient[] => addresses.map((address) => ({ emailAddress: { address } }));
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** The sendMail request body: the HTML (or text) message, the PDF, and the logo as an inline image. */
export function graphMessage(account: Pick<MicrosoftAccount, "fromAddress" | "replyTo">, message: OutgoingMessage) {
  return {
    message: {
      subject: message.subject,
      body: message.html ? { contentType: "HTML", content: message.html } : { contentType: "Text", content: message.text },
      toRecipients: recipients(message.to),
      ccRecipients: recipients(message.cc),
      replyTo: recipients([account.replyTo ?? account.fromAddress]),
      attachments: [
        ...(message.attachment
          ? [
              {
                "@odata.type": "#microsoft.graph.fileAttachment",
                name: message.attachment.fileName,
                contentType: "application/pdf",
                contentBytes: base64(message.attachment.bytes),
                isInline: false,
              },
            ]
          : []),
        ...(message.html
          ? message.inline.map((image) => ({
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: image.fileName,
              contentType: image.contentType,
              contentBytes: base64(image.bytes),
              contentId: image.cid,
              isInline: true,
            }))
          : []),
      ],
    },
    saveToSentItems: true,
  };
}

/** Sends one email as the connected mailbox. Resolves only when Microsoft accepted it (202). */
export async function sendViaGraph(accessToken: string, account: Pick<MicrosoftAccount, "fromAddress" | "replyTo">, message: OutgoingMessage): Promise<SendResult> {
  const attached = (message.attachment?.bytes.length ?? 0) + message.inline.reduce((total, image) => total + image.bytes.length, 0);
  if (attached > MAX_GRAPH_ATTACHMENT_BYTES) {
    throw new GraphSendError(
      413,
      `The attachments add up to ${(attached / (1024 * 1024)).toFixed(1)} MB, more than the 3 MB Microsoft takes in one email this way. Use a smaller logo, or send it by SMTP.`,
    );
  }
  const clientRequestId = randomUUID();
  let response: Response;
  try {
    response = await providerFetch(`${GRAPH}/me/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json", "client-request-id": clientRequestId },
      body: JSON.stringify(graphMessage(account, message)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new UnavailableError(`Couldn't reach graph.microsoft.com: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status !== 202) {
    const text = await response.text().catch(() => "");
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (parsed?.error) detail = [parsed.error.code, parsed.error.message].filter(Boolean).join(": ");
    } catch {
      // not JSON
    }
    throw new GraphSendError(response.status, detail || `status ${response.status}`, response.headers.get("retry-after"));
  }
  const requestId = response.headers.get("request-id") ?? clientRequestId;
  return { messageId: `graph:${requestId}`, response: `Accepted by Microsoft Graph (202), request ${requestId}`, rejected: [] };
}

export class GraphSendError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly retryAfter: string | null = null,
  ) {
    super(detail);
  }
}

/** What went wrong sending through Microsoft, in plain English, and whether it's worth trying again later. */
export function explainGraphError(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof GraphSendError) {
    const said = ` (Microsoft said: "${error.detail}")`;
    if (error.status === 413) return { message: error.detail, retryable: false };
    if (error.status === 401) {
      return { message: `Microsoft didn't accept the mailbox's sign-in. An admin needs to connect it again in Settings > Email.${said}`, retryable: false };
    }
    if (error.status === 403) {
      return {
        message: `Microsoft didn't allow this mailbox to send through Tohyee. Check the organisation's Microsoft app has the Mail.Send permission, then connect the mailbox again in Settings > Email.${said}`,
        retryable: false,
      };
    }
    if (error.status === 429 || error.status >= 500) {
      return { message: `Microsoft is busy or limiting how much this mailbox sends, so Tohyee will try again later.${said}`, retryable: true };
    }
    return { message: `Microsoft refused the email.${said}`, retryable: false };
  }
  if (error instanceof ProviderError) {
    // A refresh the sign-in server refused: the mailbox needs connecting again (a password change, or access removed).
    if (error.status === 400 || error.status === 401) {
      return { message: `The Microsoft mailbox's sign-in has expired or was withdrawn. An admin needs to connect it again in Settings > Email. (${error.message})`, retryable: false };
    }
    return { message: `Microsoft's sign-in server didn't answer properly, so Tohyee will try again later. (${error.message})`, retryable: error.status === 429 || error.status >= 500 };
  }
  if (error instanceof UnavailableError) return { message: `Tohyee couldn't reach Microsoft. ${error.message}`, retryable: true };
  return { message: `The email couldn't be sent: ${error instanceof Error ? error.message : String(error)}.`, retryable: false };
}

