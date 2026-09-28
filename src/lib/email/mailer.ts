import nodemailer from "nodemailer";
import { writeAdminAuditEvent } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/guard";
import { withCoreTransaction } from "@/lib/db/transactions";
import { ForbiddenError, UnavailableError, ValidationError } from "@/lib/errors";
import { deleteServerSetting, readServerSetting, writeServerSetting } from "@/lib/server-settings";
import { secretsAvailable } from "@/lib/secrets";
import { optionalString, requireString } from "@/lib/validation";

/**
 * Email the server sends: security alerts and two-step sign-in reset links.
 * A server admin enters an email account's SMTP details (e.g. Gmail with an
 * app password). The password is encrypted with TOHYEE_SECRET_KEY.
 */
type EmailValue = { host: string; port: number; secure: boolean; username: string; fromAddress: string; fromName: string };
type EmailSecrets = { password: string };

export type EmailSettings = {
  configured: boolean;
  host: string | null;
  port: number | null;
  secure: boolean;
  username: string | null;
  fromAddress: string | null;
  fromName: string | null;
  hasPassword: boolean;
  secretsAvailable: boolean;
  updatedAt: string | null;
  updatedByEmail: string | null;
};

export type OutgoingEmail = { to: string; subject: string; text: string };

type Sender = (message: OutgoingEmail & { from: string }) => Promise<void>;
let senderForTests: Sender | null = null;
/** Lets tests capture email instead of sending it. */
export function setEmailSenderForTests(sender: Sender | null): void {
  senderForTests = sender;
}

export async function getEmailSettings(): Promise<EmailSettings> {
  const stored = await readServerSetting<EmailValue, EmailSecrets>("email");
  const value = stored.value;
  return {
    configured: Boolean(value.host && stored.secrets.password),
    host: value.host ?? null,
    port: value.port ?? null,
    secure: value.secure ?? false,
    username: value.username ?? null,
    fromAddress: value.fromAddress ?? null,
    fromName: value.fromName ?? null,
    hasPassword: Boolean(stored.secrets.password),
    secretsAvailable: secretsAvailable(),
    updatedAt: stored.updatedAt,
    updatedByEmail: stored.updatedByEmail,
  };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Saves the SMTP details (server admins only). A blank password keeps the saved one; `clear: true` removes everything. */
export async function updateEmailSettings(
  auth: AuthContext,
  input: {
    host?: unknown;
    port?: unknown;
    secure?: unknown;
    username?: unknown;
    password?: unknown;
    fromAddress?: unknown;
    fromName?: unknown;
    clear?: unknown;
  },
): Promise<EmailSettings> {
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can set up email.");
  const actor = { userId: auth.user.id, email: auth.user.email };
  if (input.clear === true) {
    await withCoreTransaction(async (client) => {
      await deleteServerSetting(client, "email");
      await writeAdminAuditEvent(client, actor, { eventType: "server.email_cleared", entityType: "server_setting", entityId: "email" });
    });
    return getEmailSettings();
  }
  if (!secretsAvailable()) {
    throw new UnavailableError("Set TOHYEE_SECRET_KEY on the server first, so the email password can be stored encrypted.");
  }
  const host = requireString(input.host, "host", { maxLength: 200 }).toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) throw new ValidationError("The SMTP server should look like smtp.gmail.com.");
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ValidationError("The port must be a number such as 465 or 587.");
  const username = requireString(input.username, "username", { maxLength: 254 });
  const fromAddress = (optionalString(input.fromAddress, "fromAddress", { maxLength: 254 }) ?? username).toLowerCase();
  if (!EMAIL_PATTERN.test(fromAddress)) throw new ValidationError("The from address must be an email address.");
  const fromName = optionalString(input.fromName, "fromName", { maxLength: 100 }) ?? "Tohyee";
  const stored = await readServerSetting<EmailValue, EmailSecrets>("email");
  const password = optionalString(input.password, "password", { maxLength: 500 }) ?? stored.secrets.password;
  if (!password) throw new ValidationError("Enter the email account's password (for Gmail, an app password).");
  const value: EmailValue = { host, port, secure: input.secure === true || port === 465, username, fromAddress, fromName };
  await withCoreTransaction(async (client) => {
    await writeServerSetting(client, "email", value, { password }, auth.user.email);
    await writeAdminAuditEvent(client, actor, {
      eventType: "server.email_updated",
      entityType: "server_setting",
      entityId: "email",
      details: { host, port, username, fromAddress, passwordChanged: Boolean(input.password) },
    });
  });
  return getEmailSettings();
}

async function sender(): Promise<{ send: Sender; from: string } | null> {
  const stored = await readServerSetting<EmailValue, EmailSecrets>("email");
  const value = stored.value;
  if (!value.host || !value.port || !value.username || !stored.secrets.password) return null;
  const from = `"${(value.fromName ?? "Tohyee").replace(/"/g, "")}" <${value.fromAddress ?? value.username}>`;
  if (senderForTests) return { send: senderForTests, from };
  const transport = nodemailer.createTransport({
    host: value.host,
    port: value.port,
    secure: value.secure ?? value.port === 465,
    requireTLS: !(value.secure ?? value.port === 465),
    auth: { user: value.username, pass: stored.secrets.password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    tls: { minVersion: "TLSv1.2" },
  });
  return {
    from,
    send: async (message) => {
      await transport.sendMail({ from: message.from, to: message.to, subject: message.subject, text: message.text });
    },
  };
}

/** Whether the server can send email. */
export async function emailConfigured(): Promise<boolean> {
  return (await sender()) !== null;
}

/** Sends one email. Throws if email isn't set up or the server refuses it. */
export async function sendEmail(message: OutgoingEmail): Promise<void> {
  const configured = await sender();
  if (!configured) throw new UnavailableError("This server can't send email yet. A server admin can set it up under Server → Email.");
  try {
    await configured.send({ ...message, from: configured.from });
  } catch (error) {
    throw new UnavailableError(`The email couldn't be sent: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Sends a security alert if email is set up. Never throws: an alert that
 * can't be sent mustn't stop someone signing in or changing their security.
 */
export async function sendSecurityAlert(to: string, subject: string, lines: string[]): Promise<boolean> {
  try {
    if (!(await emailConfigured())) return false;
    await sendEmail({
      to,
      subject: `Tohyee: ${subject}`,
      text: [
        ...lines,
        "",
        "If this wasn't you, sign in and change your password, or ask your Tohyee server admin for help.",
      ].join("\n"),
    });
    return true;
  } catch (error) {
    console.warn(`[tohyee] Security alert email to ${to} failed: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}
