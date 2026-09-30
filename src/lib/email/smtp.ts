import nodemailer from "nodemailer";
import type { SendingAccount, SmtpAccount } from "@/lib/email/settings";

/**
 * Sending through an organisation's own SMTP account (nodemailer), and
 * turning what the SMTP server said into plain English. No database here:
 * callers read the account in one transaction, send outside it, and record
 * the result in another.
 */

export type OutgoingMessage = {
  to: string[];
  cc: string[];
  subject: string;
  /** The plain-text version, for mail clients that want it. */
  text: string;
  /** The HTML version (`html.ts`), when there is one. */
  html: string | null;
  /** The document's own PDF; the only file Tohyee ever attaches. */
  attachment: { fileName: string; bytes: Uint8Array } | null;
  /** Images the HTML shows by Content-ID (the organisation's logo), never remote images. */
  inline: InlineImage[];
  messageId: string;
};

export type InlineImage = { cid: string; fileName: string; contentType: "image/png" | "image/jpeg"; bytes: Uint8Array };

export type SendResult = { messageId: string; response: string; rejected: string[] };

export function createAccountTransport(account: SmtpAccount) {
  return nodemailer.createTransport({
    host: account.host,
    port: account.port,
    secure: account.security === "ssl",
    requireTLS: account.security === "starttls",
    ignoreTLS: account.security === "none",
    auth: { user: account.username, pass: account.password },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
    tls: { minVersion: "TLSv1.2", servername: account.host },
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

export type AccountTransport = ReturnType<typeof createAccountTransport>;

/** `"Name" <address>`, with the name made safe for a header. */
export function fromHeader(account: Pick<SendingAccount, "fromName" | "fromAddress">): { name: string; address: string } {
  return { name: account.fromName.replace(/["\r\n<>]/g, "").trim(), address: account.fromAddress };
}

/** A Message-ID in the from address's domain, so replies thread and the id can be quoted to the mail provider. */
export function newMessageId(account: Pick<SendingAccount, "fromAddress">, organisationId: string, emailId: string): string {
  const domain = account.fromAddress.split("@")[1] ?? "tohyee.local";
  const random = Math.random().toString(36).slice(2, 10);
  return `<tohyee.${organisationId.replace(/[^A-Za-z0-9-]/g, "")}.${emailId}.${Date.now().toString(36)}${random}@${domain}>`;
}

/**
 * What nodemailer composes the email from: the same for SMTP and for the
 * Gmail API (which is given the finished message), so both send identical
 * HTML, plain text, inline logo and PDF.
 */
export function mailOptions(account: Pick<SendingAccount, "fromName" | "fromAddress" | "replyTo">, message: OutgoingMessage) {
  return {
    from: fromHeader(account),
    sender: account.fromAddress,
    replyTo: account.replyTo ?? account.fromAddress,
    to: message.to,
    cc: message.cc.length > 0 ? message.cc : undefined,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
    messageId: message.messageId,
    envelope: { from: account.fromAddress, to: [...message.to, ...message.cc] },
    attachments: [
      ...(message.attachment
        ? [{ filename: message.attachment.fileName, content: Buffer.from(message.attachment.bytes), contentType: "application/pdf" }]
        : []),
      // Inline images go in a multipart/related part with the HTML, shown by Content-ID.
      ...(message.html
        ? message.inline.map((image) => ({
            filename: image.fileName,
            content: Buffer.from(image.bytes),
            contentType: image.contentType,
            cid: image.cid,
            contentDisposition: "inline" as const,
          }))
        : []),
    ],
  };
}

export async function sendMessage(transport: AccountTransport, account: SmtpAccount, message: OutgoingMessage): Promise<SendResult> {
  const info = await transport.sendMail(mailOptions(account, message));
  const rejected = ((info.rejected ?? []) as Array<string | { address: string }>).map((entry) => (typeof entry === "string" ? entry : entry.address));
  return { messageId: info.messageId ?? message.messageId, response: String(info.response ?? ""), rejected };
}

/**
 * The finished RFC 822 message (CRLF line endings), built by nodemailer's
 * own composer from the same options as SMTP, for the Gmail API. No
 * network: nodemailer's stream transport only writes the message.
 */
export async function composeRawMessage(account: Pick<SendingAccount, "fromName" | "fromAddress" | "replyTo">, message: OutgoingMessage): Promise<Buffer> {
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows", disableFileAccess: true, disableUrlAccess: true });
  const info = await composer.sendMail(mailOptions(account, message));
  return info.message as Buffer;
}

type SmtpError = Error & { code?: string; responseCode?: number; response?: string; command?: string; rejected?: unknown[] };

/**
 * What went wrong, for people rather than programmers, with what the SMTP
 * server actually said kept at the end. `retryable` is true for problems
 * that usually go away (the server was busy or couldn't be reached); a
 * wrong password or a refused address won't fix itself, so it isn't retried.
 */
export function explainSmtpError(error: unknown, account: Pick<SmtpAccount, "host" | "port" | "security">): { message: string; retryable: boolean } {
  const err = (error instanceof Error ? error : new Error(String(error))) as SmtpError;
  const code = err.code ?? "";
  const said = (err.response ?? err.message ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const saidPart = said ? ` (The server said: "${said}")` : "";
  const status = err.responseCode ?? 0;
  const where = `${account.host}:${account.port}`;
  if (code === "EAUTH" || status === 535 || status === 534 || code === "ENOAUTH") {
    return {
      message: `The email server didn't accept the username and password. For Gmail, use an app password (Google Account > Security > App passwords), not your normal password. For Microsoft 365, an admin must turn on "Authenticated SMTP" for this mailbox.${saidPart}`,
      retryable: false,
    };
  }
  if (code === "EENVELOPE" || status === 550 || status === 551 || status === 553 || status === 501) {
    return { message: `The email server refused the sender or recipient address. Check the addresses and the from address in Settings > Email.${saidPart}`, retryable: false };
  }
  if (code === "ETLS" || (code === "ESOCKET" && /wrong version number|ssl3_get_record|tls/i.test(err.message))) {
    return {
      message: `Tohyee couldn't start a secure connection to ${where}. The security setting may not match the port: SSL/TLS goes with port 465, STARTTLS with port 587.${saidPart}`,
      retryable: false,
    };
  }
  if (code === "EDNS" || /ENOTFOUND|EAI_AGAIN/.test(err.message)) {
    return { message: `Tohyee couldn't find the email server ${account.host}. Check its name in Settings > Email, and that this server can reach the internet.${saidPart}`, retryable: true };
  }
  if (code === "ETIMEDOUT") {
    return { message: `The email server ${where} didn't answer in time.${saidPart}`, retryable: true };
  }
  if (code === "ECONNECTION" || code === "ESOCKET" || /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/.test(err.message)) {
    return { message: `Tohyee couldn't connect to the email server ${where}. Check the server name and port, and that this server can reach the internet.${saidPart}`, retryable: true };
  }
  if (status >= 400 && status < 500) {
    return { message: `The email server is busy or is limiting how much this account sends, so it asked Tohyee to try again later.${saidPart}`, retryable: true };
  }
  if (status >= 500) {
    return { message: `The email server refused the message.${saidPart}`, retryable: false };
  }
  return { message: `The email couldn't be sent: ${said || "unknown error"}.`, retryable: false };
}
