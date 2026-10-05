import { writeAuditEvent } from "@/lib/audit";
import {
  authorisationUrl,
  exchangeCode,
  GMAIL_SEND_SCOPE,
  GOOGLE_SEND_SCOPES,
  googleAccountAddress,
  ProviderError,
  type ProviderApp,
  providerFetch,
  refreshAccess,
  type Tokens,
} from "@/lib/crm/mail/providers";
import { googleApp } from "@/lib/crm/mail/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { claimProviderState, fallbackMethod, newSendingState } from "@/lib/email/microsoft";
import type { GoogleAccount } from "@/lib/email/settings";
import { EmailMaybeSentError, fetchMayHaveDelivered, maybeSentMessage } from "@/lib/email/maybe-sent";
import { composeRawMessage, type OutgoingMessage, type SendResult } from "@/lib/email/smtp";
import { ForbiddenError, UnavailableError, ValidationError } from "@/lib/errors";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { encryptSecret, secretsAvailable } from "@/lib/secrets";

/**
 * "Google / Gmail (sign in)" for sending documents (Settings > Email), the
 * Google counterpart of `microsoft.ts`: an admin signs in to a Gmail or
 * Google Workspace mailbox once (OAuth 2.0 authorization code flow, offline
 * access) with the organisation's own Google OAuth client (the one the CRM's
 * mail sync uses, `crm_mail_settings`), asking only for gmail.send and the
 * account's address. Tohyee then sends as that mailbox through the Gmail API.
 *
 * What was checked against Google's Gmail API discovery document (revision
 * 20260727, as shipped in Google's own API client libraries):
 * - `users.messages.send`: `POST gmail/v1/users/{userId}/messages/send`
 *   ("Sends the specified message to the recipients in the To, Cc, and Bcc
 *   headers"); `userId` can be `me`. The scopes it accepts include
 *   `https://www.googleapis.com/auth/gmail.send` ("Send email on your behalf").
 * - It supports media upload at `/upload/gmail/v1/users/{userId}/messages/send`
 *   (simple upload, `uploadType=media`), accepting `message/*` up to
 *   36,700,160 bytes (35 MB). Tohyee sends the finished RFC 822 message this
 *   way, so there's no base64url step and the larger limit applies. (The
 *   metadata endpoint takes the message base64url-encoded in `raw` instead.)
 * - `users.getProfile` doesn't accept gmail.send, so the address comes from
 *   OAuth2 v2 `userinfo.get` (scopes openid / userinfo.email).
 *
 * The message itself is built by nodemailer's composer from the same options
 * as SMTP (`composeRawMessage`), so the HTML, plain text, inline logo and PDF
 * are identical whichever way it goes. Network calls are never made inside a
 * database transaction; the refresh token is stored encrypted and replaced
 * if Google ever issues a new one.
 */

export const GOOGLE_EMAIL_CALLBACK_PATH = "/api/email/google/callback";
const SEND_URL = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";
const TIMEOUT_MS = 60_000;
/** The largest message the Gmail API's media upload takes (its discovery document's maxSize). */
export const MAX_GMAIL_MESSAGE_BYTES = 36_700_160;

function redirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${GOOGLE_EMAIL_CALLBACK_PATH}`;
}

// ---------------------------------------------------------------------------
// Connecting (admins)

/** Google's sign-in address, with a one-time state tied to this admin and organisation. */
export async function startGoogleSending(tx: OrgTx, origin: string): Promise<{ url: string }> {
  if (!tx.actor.userId) throw new ForbiddenError("Sign in to connect a mailbox.");
  if (!secretsAvailable()) {
    throw new UnavailableError("This server has no TOHYEE_SECRET_KEY, so it can't keep the mailbox's sign-in safely. A server admin needs to set it first.");
  }
  const app = await googleApp(tx);
  const state = await newSendingState(tx, "google");
  return { url: authorisationUrl("google", app, redirectUri(origin), state, GOOGLE_SEND_SCOPES) };
}

/** Claims a Google sign-in state (once, 15 minutes, the same admin) and returns the app to exchange the code with. */
export async function claimGoogleState(tx: OrgTx, state: string): Promise<ProviderApp> {
  await claimProviderState(tx, state, "google");
  return googleApp(tx);
}

/** What Google's `error` on the way back means, in plain English. */
export function explainGoogleSignInError(code: string): string {
  if (code === "access_denied") {
    return "Google didn't give Tohyee access (the sign-in was cancelled, or Google refused it). Try again, and allow Tohyee to send email. If the Google app is in testing, the account must be one of its test users.";
  }
  if (code === "admin_policy_enforced") {
    return "Your Google Workspace admin doesn't allow this app to use the account. They need to allow (trust) the organisation's Google app in the Google Admin console, then connect again.";
  }
  if (code === "org_internal") {
    return "The organisation's Google app only allows accounts in its own Google Workspace. Sign in with one of those accounts, or change the app's audience.";
  }
  return `Signing in didn't finish: ${code}`;
}

export type GoogleSendingConnection = { tokens: Tokens; email: string };

/** Exchanges the code and finds the mailbox's address (network, no transaction). */
export async function fetchGoogleSendingConnection(app: ProviderApp, code: string, origin: string): Promise<GoogleSendingConnection> {
  const tokens = await exchangeCode("google", app, code, redirectUri(origin));
  // Google lets people untick permissions on the consent screen; without gmail.send nothing could be sent.
  if (tokens.scope && !tokens.scope.split(/\s+/).includes(GMAIL_SEND_SCOPE)) {
    throw new ValidationError("Google didn't give Tohyee permission to send email from this account. Connect again and tick \"Send email on your behalf\".");
  }
  if (!tokens.refreshToken) throw new ValidationError("The sign-in didn't allow offline access, so Tohyee couldn't keep sending. Try connecting again.");
  const email = (await googleAccountAddress(tokens.accessToken)).toLowerCase();
  return { tokens, email };
}

/** Stores the connected mailbox (tokens encrypted) and makes it the way documents are sent. */
export async function saveGoogleSendingConnection(tx: OrgTx, connection: GoogleSendingConnection): Promise<string> {
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
        set sending_method = 'google', google_email = $1, google_refresh_token_ciphertext = $2,
            google_access_token_ciphertext = $3, google_access_token_expires_at = $4, google_connected_by_email = $5,
            google_connected_at = now(), updated_by_email = $5, updated_at = now(),
            last_test_at = null, last_test_ok = null, last_test_error = null
      where id = true`,
    values,
  );
  if ((updated.rowCount ?? 0) === 0) {
    const settings = await getOrganisationSettings(tx);
    await tx.query(
      `insert into organisation_email_settings (id, from_name, from_address, sending_method, google_email, google_refresh_token_ciphertext,
                                                google_access_token_ciphertext, google_access_token_expires_at,
                                                google_connected_by_email, google_connected_at, updated_by_email, updated_at)
       values (true, $6, $1, 'google', $1, $2, $3, $4, $5, now(), $5, now())`,
      [...values, settings.displayName.replace(/["<>\r\n]/g, "").slice(0, 100) || "Accounts"],
    );
  }
  await writeAuditEvent(tx, { eventType: "email_settings.google_connected", entityType: "email_settings", entityId: "email", details: { email } });
  return email;
}

/**
 * Forgets the mailbox's sign-in (Google still lists Tohyee under the
 * account's third-party access until someone removes it there). Saved SMTP
 * details or a Microsoft mailbox are used instead, if any.
 */
export async function disconnectGoogleSending(tx: OrgTx): Promise<void> {
  const current = await tx.query<{ sending_method: string; microsoft_email: string | null; smtp_host: string | null; google_email: string | null }>(
    "select sending_method, microsoft_email, smtp_host, google_email from organisation_email_settings where id = true",
  );
  const row = current.rows[0];
  if (!row?.google_email) return;
  const next = fallbackMethod(row, "google");
  if (next) {
    await tx.query(
      `update organisation_email_settings
          set sending_method = $2, google_email = null, google_refresh_token_ciphertext = null, google_access_token_ciphertext = null,
              google_access_token_expires_at = null, google_connected_by_email = null, google_connected_at = null,
              updated_by_email = $1, updated_at = now(), last_test_at = null, last_test_ok = null, last_test_error = null
        where id = true`,
      [tx.actor.email, next],
    );
  } else {
    await tx.query("delete from organisation_email_settings");
  }
  await writeAuditEvent(tx, {
    eventType: "email_settings.google_disconnected",
    entityType: "email_settings",
    entityId: "email",
    details: { email: row.google_email },
  });
}

// ---------------------------------------------------------------------------
// Sending

/** Saves tokens Google issued on a refresh (a new refresh token, if any, replaces the old), if the same mailbox is still connected. */
export async function saveGoogleRefreshedTokens(tx: OrgTx, email: string, tokens: Tokens): Promise<void> {
  await tx.query(
    `update organisation_email_settings
        set google_access_token_ciphertext = $2, google_access_token_expires_at = $3,
            google_refresh_token_ciphertext = coalesce($4, google_refresh_token_ciphertext)
      where id = true and google_email = $1`,
    [email, encryptSecret(tokens.accessToken), new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(), tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null],
  );
}

/**
 * A current access token: the saved one if it has more than a minute left,
 * otherwise a new one from the refresh token, which `save` stores (in its
 * own transaction; this makes the network call outside any).
 */
export async function googleAccessToken(account: GoogleAccount, save: (tokens: Tokens) => Promise<void>, now = new Date()): Promise<string> {
  if (account.accessToken && account.accessTokenExpiresAt && new Date(account.accessTokenExpiresAt).getTime() > now.getTime() + 60_000) {
    return account.accessToken;
  }
  const tokens = await refreshAccess("google", account.app, account.refreshToken);
  await save(tokens);
  return tokens.accessToken;
}

export class GmailSendError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly reasons: string[] = [],
  ) {
    super(detail);
  }
}

/** Sends one finished message as the connected mailbox. Resolves only when Google accepted it (200 with the message's id). */
export async function sendRawViaGmail(accessToken: string, raw: Buffer): Promise<SendResult> {
  if (raw.length > MAX_GMAIL_MESSAGE_BYTES) {
    throw new GmailSendError(
      413,
      `The email comes to ${(raw.length / (1024 * 1024)).toFixed(1)} MB with its attachments, more than the 35 MB Gmail takes. Use a smaller logo, or send it another way.`,
    );
  }
  let response: Response;
  try {
    response = await providerFetch(SEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "message/rfc822", Accept: "application/json" },
      body: new Uint8Array(raw),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    // Handed over but no answer (a timeout or a dropped connection): it may have been sent (#146).
    if (fetchMayHaveDelivered(error)) throw new EmailMaybeSentError(`Google didn't answer (${said}).`);
    throw new UnavailableError(`Couldn't reach gmail.googleapis.com: ${said}`);
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    let detail = text.slice(0, 300);
    const reasons: string[] = [];
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; status?: string; errors?: Array<{ reason?: string }>; details?: Array<{ reason?: string }> } };
      if (parsed?.error) {
        detail = [parsed.error.status, parsed.error.message].filter(Boolean).join(": ");
        for (const item of [...(parsed.error.errors ?? []), ...(parsed.error.details ?? [])]) if (item.reason) reasons.push(item.reason);
      }
    } catch {
      // not JSON
    }
    throw new GmailSendError(response.status, detail || `status ${response.status}`, reasons);
  }
  let id = "";
  try {
    id = String((JSON.parse(text) as { id?: string }).id ?? "");
  } catch {
    // not JSON
  }
  // Google said yes (200) but not which message: it was most likely sent, so it isn't sent again (#146).
  if (!id) throw new EmailMaybeSentError("Google accepted it but didn't say the sent message's id.");
  return { messageId: `gmail:${id}`, response: `Accepted by the Gmail API (${response.status}), message ${id}`, rejected: [] };
}

/** Composes the email exactly as SMTP would (nodemailer) and sends it through the Gmail API. */
export async function sendViaGmail(accessToken: string, account: Pick<GoogleAccount, "fromName" | "fromAddress" | "replyTo">, message: OutgoingMessage): Promise<SendResult> {
  return sendRawViaGmail(accessToken, await composeRawMessage(account, message));
}

/** What went wrong sending through Google, in plain English, and whether it's worth trying again later. */
export function explainGmailError(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof EmailMaybeSentError) return { message: maybeSentMessage("the Gmail mailbox", error.detail), retryable: false };
  if (error instanceof GmailSendError) {
    const said = ` (Google said: "${error.detail}")`;
    const reasons = error.reasons.map((reason) => reason.toLowerCase());
    if (error.status === 413) return { message: error.detail, retryable: false };
    if (error.status === 401) {
      return { message: `Google didn't accept the mailbox's sign-in. An admin needs to connect it again in Settings > Email.${said}`, retryable: false };
    }
    if (reasons.some((reason) => reason === "insufficientpermissions" || reason === "access_token_scope_insufficient")) {
      return {
        message: `Google didn't give Tohyee permission to send from this mailbox. An admin needs to connect it again in Settings > Email and allow "Send email on your behalf".${said}`,
        retryable: false,
      };
    }
    if (reasons.some((reason) => reason === "dailylimitexceeded") || /sending limit/i.test(error.detail)) {
      return { message: `This Gmail account has reached Google's daily sending limit. Send it again tomorrow.${said}`, retryable: false };
    }
    if (error.status === 429 || error.status >= 500 || reasons.some((reason) => reason === "ratelimitexceeded" || reason === "userratelimitexceeded")) {
      return { message: `Google is busy or limiting how much this mailbox sends, so Tohyee will try again later.${said}`, retryable: true };
    }
    if (error.status === 403 || (error.status === 400 && /mail service not enabled|failedprecondition/i.test(error.detail))) {
      return {
        message: `Google didn't allow this mailbox to send through Tohyee. If it's a Google Workspace account, its admin may have turned Gmail off for it or blocked the organisation's Google app.${said}`,
        retryable: false,
      };
    }
    return { message: `Google refused the email.${said}`, retryable: false };
  }
  if (error instanceof ProviderError) {
    if (error.code === "invalid_grant") {
      return {
        message: `The Google mailbox's sign-in has expired or access was removed. An admin needs to connect it again in Settings > Email. (${error.message})`,
        retryable: false,
      };
    }
    if (error.code === "admin_policy_enforced") {
      return {
        message: `Your Google Workspace admin doesn't allow the organisation's Google app to use this account. They need to allow it in the Google Admin console, then an admin connects the mailbox again. (${error.message})`,
        retryable: false,
      };
    }
    if (error.code === "invalid_client" || error.code === "unauthorized_client") {
      return {
        message: `Google didn't accept the organisation's Google app (its client ID or secret may have changed). An admin needs to check it in Settings > Email. (${error.message})`,
        retryable: false,
      };
    }
    if (error.status === 400 || error.status === 401) {
      return { message: `The Google mailbox's sign-in didn't work. An admin needs to connect it again in Settings > Email. (${error.message})`, retryable: false };
    }
    return { message: `Google's sign-in server didn't answer properly, so Tohyee will try again later. (${error.message})`, retryable: error.status === 429 || error.status >= 500 };
  }
  if (error instanceof UnavailableError) return { message: `Tohyee couldn't reach Google. ${error.message}`, retryable: true };
  return { message: `The email couldn't be sent: ${error instanceof Error ? error.message : String(error)}.`, retryable: false };
}
