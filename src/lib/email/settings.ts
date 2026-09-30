import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { headerText, optionalAddress } from "@/lib/email/addresses";
import {
  checkTemplate,
  DEFAULT_TEMPLATES,
  EMAIL_DOCUMENT_KINDS,
  type EmailDocumentKind,
  type EmailTemplate,
} from "@/lib/email/templates";
import { microsoftApp } from "@/lib/crm/mail/service";
import type { ProviderApp } from "@/lib/crm/mail/providers";
import { UnavailableError, ValidationError } from "@/lib/errors";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";
import { optionalString, requireOneOf, requireString } from "@/lib/validation";

/**
 * An organisation's own email account for sending its documents (Settings >
 * Email, admins only), kept in the organisation's database: an SMTP account
 * with a password, or a Microsoft 365 / Outlook mailbox an admin signed in
 * to (`microsoft.ts`). The password and tokens are encrypted with
 * TOHYEE_SECRET_KEY like the server's other secrets, only decrypted to send,
 * and never returned to the browser: screens only learn whether one is saved.
 */

export const SMTP_SECURITY = ["ssl", "starttls", "none"] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY)[number];

/** Plain connections (no TLS) are only allowed to a mail relay on the server computer itself. */
export const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];

/** How documents are sent: SMTP (with a password), or a Microsoft 365 / Outlook mailbox an admin signed in to. */
export const SENDING_METHODS = ["smtp", "microsoft"] as const;
export type SendingMethod = (typeof SENDING_METHODS)[number];

export type OrganisationEmailSettings = {
  /** Emails can be sent with the chosen method. */
  configured: boolean;
  sendingMethod: SendingMethod;
  /** SMTP details are saved (whether or not SMTP is the method in use). */
  smtpSaved: boolean;
  /** The Microsoft mailbox connected for sending, if any (tokens are never returned). */
  microsoft: {
    email: string;
    connectedAt: string;
    connectedByEmail: string | null;
    /** False when the saved tokens can't be decrypted (the server's key changed): connect again. */
    tokensReadable: boolean;
  } | null;
  /** The organisation's Microsoft app (shared with the CRM's mail sync). */
  microsoftApp: { clientId: string | null; secretSaved: boolean; tenant: string };
  fromName: string | null;
  fromAddress: string | null;
  replyTo: string | null;
  host: string | null;
  port: number | null;
  security: SmtpSecurity | null;
  username: string | null;
  hasPassword: boolean;
  /** False when the saved password can't be decrypted (the server's key changed): it must be entered again. */
  passwordReadable: boolean;
  /** Whether the server has TOHYEE_SECRET_KEY, without which nothing can be saved. */
  secretsAvailable: boolean;
  updatedAt: string | null;
  updatedByEmail: string | null;
  lastTest: { at: string; ok: boolean; error: string | null } | null;
};

type SettingsRow = {
  from_name: string;
  from_address: string;
  reply_to: string | null;
  sending_method: SendingMethod;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: SmtpSecurity | null;
  smtp_username: string | null;
  smtp_password_ciphertext: string | null;
  microsoft_email: string | null;
  microsoft_refresh_token_ciphertext: string | null;
  microsoft_access_token_ciphertext: string | null;
  microsoft_access_token_expires_at: string | Date | null;
  microsoft_connected_by_email: string | null;
  microsoft_connected_at: string | Date | null;
  updated_by_email: string;
  updated_at: string;
  last_test_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
};

async function readRow(tx: OrgTx): Promise<SettingsRow | null> {
  const result = await tx.query<SettingsRow>("select * from organisation_email_settings where id = true");
  return result.rows[0] ?? null;
}

async function microsoftAppSettings(tx: OrgTx): Promise<OrganisationEmailSettings["microsoftApp"]> {
  const result = await tx.query<{ microsoft_client_id: string | null; microsoft_client_secret_ciphertext: string | null; microsoft_tenant: string }>(
    "select microsoft_client_id, microsoft_client_secret_ciphertext, microsoft_tenant from crm_mail_settings where id = true",
  );
  const row = result.rows[0];
  return { clientId: row?.microsoft_client_id ?? null, secretSaved: Boolean(row?.microsoft_client_secret_ciphertext), tenant: row?.microsoft_tenant ?? "common" };
}

function passwordReadable(ciphertext: string | null): boolean {
  if (!ciphertext || !secretsAvailable()) return false;
  try {
    decryptSecret(ciphertext);
    return true;
  } catch {
    return false;
  }
}

export async function getOrganisationEmailSettings(tx: OrgTx): Promise<OrganisationEmailSettings> {
  const row = await readRow(tx);
  const microsoftApp = await microsoftAppSettings(tx);
  if (!row) {
    return {
      configured: false,
      sendingMethod: "smtp",
      smtpSaved: false,
      microsoft: null,
      microsoftApp,
      fromName: null,
      fromAddress: null,
      replyTo: null,
      host: null,
      port: null,
      security: null,
      username: null,
      hasPassword: false,
      passwordReadable: false,
      secretsAvailable: secretsAvailable(),
      updatedAt: null,
      updatedByEmail: null,
      lastTest: null,
    };
  }
  const readable = passwordReadable(row.smtp_password_ciphertext);
  const tokensReadable = passwordReadable(row.microsoft_refresh_token_ciphertext);
  const microsoftReady = tokensReadable && Boolean(microsoftApp.clientId) && microsoftApp.secretSaved;
  return {
    configured: row.sending_method === "microsoft" ? microsoftReady : readable,
    sendingMethod: row.sending_method,
    smtpSaved: row.smtp_host !== null,
    microsoft:
      row.microsoft_email && row.microsoft_connected_at
        ? {
            email: row.microsoft_email,
            connectedAt: new Date(row.microsoft_connected_at).toISOString(),
            connectedByEmail: row.microsoft_connected_by_email,
            tokensReadable,
          }
        : null,
    microsoftApp,
    fromName: row.from_name,
    fromAddress: row.sending_method === "microsoft" && row.microsoft_email ? row.microsoft_email : row.from_address,
    replyTo: row.reply_to,
    host: row.smtp_host,
    port: row.smtp_port,
    security: row.smtp_security,
    username: row.smtp_username,
    hasPassword: row.smtp_password_ciphertext !== null,
    passwordReadable: readable,
    secretsAvailable: secretsAvailable(),
    updatedAt: row.updated_at,
    updatedByEmail: row.updated_by_email,
    lastTest: row.last_test_at ? { at: row.last_test_at, ok: row.last_test_ok === true, error: row.last_test_error } : null,
  };
}

function parseHost(input: unknown): string {
  const host = requireString(input, "SMTP server", { maxLength: 200 }).toLowerCase();
  if (host !== "::1" && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
    throw new ValidationError("The SMTP server should be a name like smtp.gmail.com.");
  }
  return host;
}

function parsePort(input: unknown): number {
  const port = typeof input === "string" && /^\d{1,5}$/.test(input.trim()) ? Number(input.trim()) : input;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError("The port must be a number such as 465 or 587.");
  }
  return port;
}

/**
 * Saves the account (admins). A blank password keeps the saved one;
 * `clear: true` removes the whole setup.
 */
export async function updateOrganisationEmailSettings(
  tx: OrgTx,
  input: {
    fromName?: unknown;
    fromAddress?: unknown;
    replyTo?: unknown;
    host?: unknown;
    port?: unknown;
    security?: unknown;
    username?: unknown;
    password?: unknown;
    clear?: unknown;
    sendingMethod?: unknown;
  },
): Promise<OrganisationEmailSettings> {
  if (input.clear === true) {
    await tx.query("delete from organisation_email_settings");
    await writeAuditEvent(tx, { eventType: "email_settings.cleared", entityType: "email_settings", entityId: "email" });
    return getOrganisationEmailSettings(tx);
  }
  if (input.sendingMethod !== undefined) {
    // Switching between the saved SMTP account and the connected Microsoft mailbox (and the from name and reply-to they share).
    const method = requireOneOf(input.sendingMethod, "sending method", SENDING_METHODS);
    const current = await readRow(tx);
    if (method === "microsoft" && !current?.microsoft_email) throw new ValidationError("Connect a Microsoft 365 or Outlook mailbox first.");
    if (method === "smtp" && !current?.smtp_host) throw new ValidationError("Save the SMTP account's details first.");
    const fromName = input.fromName === undefined ? current!.from_name : headerText(requireString(input.fromName, "from name", { maxLength: 100 }).replace(/["<>]/g, ""), 100);
    if (!fromName) throw new ValidationError("Enter the from name, usually the organisation's name.");
    const replyTo = input.replyTo === undefined ? current!.reply_to : optionalAddress(input.replyTo, "The reply-to address");
    await tx.query(
      `update organisation_email_settings set sending_method = $1, from_name = $2, reply_to = $3, updated_by_email = $4, updated_at = now(),
              last_test_at = null, last_test_ok = null, last_test_error = null`,
      [method, fromName, replyTo, tx.actor.email],
    );
    await writeAuditEvent(tx, { eventType: "email_settings.method_changed", entityType: "email_settings", entityId: "email", details: { sendingMethod: method, fromName, replyTo } });
    return getOrganisationEmailSettings(tx);
  }
  if (!secretsAvailable()) {
    throw new UnavailableError(
      "This server has no TOHYEE_SECRET_KEY, so it can't store an email password safely. A server admin needs to set it (the Windows installer does) and restart Tohyee.",
    );
  }
  const host = parseHost(input.host);
  const port = parsePort(input.port);
  const security = requireOneOf(input.security, "security", SMTP_SECURITY);
  if (security === "none" && !LOCAL_HOSTS.includes(host)) {
    throw new ValidationError(
      "Connections without encryption are only allowed to a mail server on this computer (localhost). Choose SSL/TLS (usually port 465) or STARTTLS (usually port 587).",
    );
  }
  const username = requireString(input.username, "username", { maxLength: 254 });
  const fromAddress = optionalAddress(input.fromAddress, "The from address") ?? optionalAddress(username, "The from address");
  if (!fromAddress) throw new ValidationError("Enter the from address: the email address customers will see.");
  const replyTo = optionalAddress(input.replyTo, "The reply-to address");
  const fromName = headerText(requireString(input.fromName, "from name", { maxLength: 100 }).replace(/["<>]/g, ""), 100);
  if (!fromName) throw new ValidationError("Enter the from name, usually the organisation's name.");
  const current = await readRow(tx);
  const typed = optionalString(input.password, "password", { maxLength: 500 });
  // Google shows app passwords in groups of four ("abcd efgh ijkl mnop"); the spaces aren't part of it.
  const password = typed && host === "smtp.gmail.com" ? typed.replace(/\s+/g, "") : typed;
  if (!password && !current) throw new ValidationError("Enter the email account's password (for Gmail, an app password).");
  if (!password && !current?.smtp_password_ciphertext) throw new ValidationError("Enter the email account's password (for Gmail, an app password).");
  if (!password && current && !passwordReadable(current.smtp_password_ciphertext)) {
    throw new ValidationError("The saved password can't be read on this server any more. Enter it again.");
  }
  const ciphertext = password ? encryptSecret(password) : current!.smtp_password_ciphertext;
  // Saving the SMTP account makes it the way documents are sent.
  await tx.query(
    `insert into organisation_email_settings (id, from_name, from_address, reply_to, sending_method, smtp_host, smtp_port, smtp_security, smtp_username,
                                              smtp_password_ciphertext, updated_by_email, updated_at)
     values (true, $1, $2, $3, 'smtp', $4, $5, $6, $7, $8, $9, now())
     on conflict (id) do update set from_name = excluded.from_name, from_address = excluded.from_address, reply_to = excluded.reply_to,
       sending_method = 'smtp', smtp_host = excluded.smtp_host, smtp_port = excluded.smtp_port, smtp_security = excluded.smtp_security,
       smtp_username = excluded.smtp_username, smtp_password_ciphertext = excluded.smtp_password_ciphertext,
       updated_by_email = excluded.updated_by_email, updated_at = now(),
       last_test_at = null, last_test_ok = null, last_test_error = null`,
    [fromName, fromAddress, replyTo, host, port, security, username, ciphertext, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "email_settings.updated",
    entityType: "email_settings",
    entityId: "email",
    details: { fromName, fromAddress, replyTo, host, port, security, username, passwordChanged: Boolean(password) },
  });
  return getOrganisationEmailSettings(tx);
}

/** What the sending code needs, password or tokens included. Server-side only; never returned by an API route. */
export type SmtpAccount = {
  method: "smtp";
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
};

export type MicrosoftAccount = {
  method: "microsoft";
  fromName: string;
  /** The connected mailbox: Microsoft sends from it. */
  fromAddress: string;
  replyTo: string | null;
  refreshToken: string;
  accessToken: string | null;
  accessTokenExpiresAt: string | null;
  app: ProviderApp;
};

export type SendingAccount = SmtpAccount | MicrosoftAccount;

export const NOT_SET_UP =
  "Email isn't set up for this organisation yet. An admin can set it up in Settings > Email with the organisation's own Gmail, Microsoft 365 or other email account.";

export async function readSendingAccount(tx: OrgTx): Promise<SendingAccount> {
  const row = await readRow(tx);
  if (!row) throw new UnavailableError(NOT_SET_UP);
  if (row.sending_method === "microsoft") {
    let refreshToken: string;
    let accessToken: string | null;
    try {
      refreshToken = decryptSecret(row.microsoft_refresh_token_ciphertext!);
      accessToken = row.microsoft_access_token_ciphertext ? decryptSecret(row.microsoft_access_token_ciphertext) : null;
    } catch {
      throw new UnavailableError("The Microsoft mailbox's sign-in can't be read on this server (was TOHYEE_SECRET_KEY changed?). An admin needs to connect it again in Settings > Email.");
    }
    let app: ProviderApp;
    try {
      app = await microsoftApp(tx);
    } catch {
      throw new UnavailableError("The organisation's Microsoft app isn't set up (or its secret can't be read). An admin needs to enter it in Settings > Email.");
    }
    return {
      method: "microsoft",
      fromName: row.from_name,
      fromAddress: row.microsoft_email!,
      replyTo: row.reply_to,
      refreshToken,
      accessToken,
      accessTokenExpiresAt: row.microsoft_access_token_expires_at ? new Date(row.microsoft_access_token_expires_at).toISOString() : null,
      app,
    };
  }
  let password: string;
  try {
    password = decryptSecret(row.smtp_password_ciphertext!);
  } catch {
    throw new UnavailableError("The saved email password can't be read on this server (was TOHYEE_SECRET_KEY changed?). An admin needs to enter it again in Settings > Email.");
  }
  return {
    method: "smtp",
    fromName: row.from_name,
    fromAddress: row.from_address,
    replyTo: row.reply_to,
    host: row.smtp_host!,
    port: row.smtp_port!,
    security: row.smtp_security!,
    username: row.smtp_username!,
    password,
  };
}

export async function recordTestResult(tx: OrgTx, result: { ok: boolean; error: string | null; to: string }): Promise<OrganisationEmailSettings> {
  await tx.query("update organisation_email_settings set last_test_at = now(), last_test_ok = $1, last_test_error = $2", [result.ok, result.error]);
  await writeAuditEvent(tx, {
    eventType: result.ok ? "email_settings.test_sent" : "email_settings.test_failed",
    entityType: "email_settings",
    entityId: "email",
    details: { to: result.to, error: result.error },
  });
  return getOrganisationEmailSettings(tx);
}

// ---------------------------------------------------------------- templates

export async function listEmailTemplates(tx: OrgTx): Promise<EmailTemplate[]> {
  const saved = await tx.query<{ document_kind: EmailDocumentKind; subject: string; body: string }>(
    "select document_kind, subject, body from email_templates",
  );
  const byKind = new Map(saved.rows.map((row) => [row.document_kind, row]));
  return EMAIL_DOCUMENT_KINDS.map((kind) => {
    const row = byKind.get(kind);
    return row ? { kind, subject: row.subject, body: row.body, isDefault: false } : { kind, ...DEFAULT_TEMPLATES[kind], isDefault: true };
  });
}

export async function getEmailTemplate(tx: OrgTx, kind: EmailDocumentKind): Promise<EmailTemplate> {
  return (await listEmailTemplates(tx)).find((template) => template.kind === kind)!;
}

/** Saves one document type's template (admins); `reset: true` goes back to Tohyee's default. */
export async function updateEmailTemplate(
  tx: OrgTx,
  input: { kind?: unknown; subject?: unknown; body?: unknown; reset?: unknown },
): Promise<EmailTemplate[]> {
  const kind = requireOneOf(input.kind, "kind", EMAIL_DOCUMENT_KINDS);
  if (input.reset === true) {
    await tx.query("delete from email_templates where document_kind = $1", [kind]);
    await writeAuditEvent(tx, { eventType: "email_template.reset", entityType: "email_template", entityId: kind });
    return listEmailTemplates(tx);
  }
  const subject = headerText(typeof input.subject === "string" ? input.subject : "", 1000);
  const body = typeof input.body === "string" ? input.body.replace(/\r\n?/g, "\n").trim() : "";
  checkTemplate(kind, subject, body);
  await tx.query(
    `insert into email_templates (document_kind, subject, body, updated_by_email, updated_at) values ($1, $2, $3, $4, now())
     on conflict (document_kind) do update set subject = excluded.subject, body = excluded.body,
       updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [kind, subject, body, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "email_template.updated", entityType: "email_template", entityId: kind, details: { subject, body } });
  return listEmailTemplates(tx);
}
