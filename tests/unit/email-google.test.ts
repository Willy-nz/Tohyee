import { simpleParser } from "mailparser";
import { afterEach, describe, expect, it } from "vitest";
import { GOOGLE_SEND_SCOPES, ProviderError, setMailFetchForTests } from "@/lib/crm/mail/providers";
import { explainGmailError, explainGoogleSignInError, GmailSendError, MAX_GMAIL_MESSAGE_BYTES, sendRawViaGmail } from "@/lib/email/google";
import { fallbackMethod } from "@/lib/email/microsoft";
import { composeRawMessage } from "@/lib/email/smtp";
import { UnavailableError } from "@/lib/errors";

/** Sending through a Gmail or Google Workspace mailbox with the Gmail API (Settings > Email). */

afterEach(() => setMailFetchForTests(null));

const account = { fromName: 'Glimmers "by" <Jess>', fromAddress: "accounts@glimmers.co.nz", replyTo: "jess@glimmers.co.nz" };

describe("sending through the Gmail API", () => {
  it("asks for gmail.send and the account's address, and nothing that reads the mailbox", () => {
    expect(GOOGLE_SEND_SCOPES).toEqual(["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/gmail.send"]);
    expect(GOOGLE_SEND_SCOPES.some((scope) => /readonly|modify|mail\.google\.com/.test(scope))).toBe(false);
  });

  it("builds the whole RFC 822 message with nodemailer, as SMTP does: HTML, plain text, inline logo and PDF", async () => {
    const raw = await composeRawMessage(account, {
      to: ["accounts@kobe.test"],
      cc: ["mia@kobe.test"],
      subject: "Invoice INV-0001 from Glimmers",
      text: "Hi Kobe,\n\nHere's the invoice.",
      html: '<p>Hi Kobe,</p><img src="cid:logo-1@tohyee">',
      attachment: { fileName: "Invoice INV-0001.pdf", bytes: new TextEncoder().encode("%PDF-1.7 test") },
      inline: [{ cid: "logo-1@tohyee", fileName: "logo.png", contentType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) }],
      messageId: "<tohyee.test.1@glimmers.co.nz>",
    });
    expect(raw.toString("latin1")).toContain("\r\n");
    expect(raw.toString("latin1")).not.toMatch(/[^\r]\n/);
    const mail = await simpleParser(raw, { keepCidLinks: true });
    expect(mail.from?.value).toEqual([{ address: "accounts@glimmers.co.nz", name: "Glimmers by Jess" }]);
    expect(mail.replyTo?.value[0].address).toBe("jess@glimmers.co.nz");
    expect(mail.subject).toBe("Invoice INV-0001 from Glimmers");
    expect(mail.messageId).toBe("<tohyee.test.1@glimmers.co.nz>");
    expect(mail.text?.trim()).toBe("Hi Kobe,\n\nHere's the invoice.");
    expect(String(mail.html)).toContain('src="cid:logo-1@tohyee"');
    // The logo sits with the HTML in multipart/related, so it comes first.
    expect(mail.attachments.map((file) => [file.filename, file.contentType, file.contentDisposition, file.cid ?? null])).toEqual([
      ["logo.png", "image/png", "inline", "logo-1@tohyee"],
      ["Invoice INV-0001.pdf", "application/pdf", "attachment", null],
    ]);
    // No Bcc header: every recipient is in To or Cc.
    expect(raw.toString("latin1")).not.toMatch(/^Bcc:/im);
  });

  it("refuses a message over Gmail's 35 MB upload limit without calling Google", async () => {
    let calls = 0;
    setMailFetchForTests(async () => {
      calls += 1;
      return Response.json({ id: "never" });
    });
    const error = await sendRawViaGmail("token", Buffer.alloc(MAX_GMAIL_MESSAGE_BYTES + 1)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GmailSendError);
    expect(calls).toBe(0);
    expect(explainGmailError(error)).toEqual({
      message: "The email comes to 35.0 MB with its attachments, more than the 35 MB Gmail takes. Use a smaller logo, or send it another way.",
      retryable: false,
    });
  });

  it("uploads the message as message/rfc822 and keeps Google's message id", async () => {
    const seen: Array<{ url: string; type: string | null; auth: string | null; body: string }> = [];
    setMailFetchForTests(async (url, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ url, type: headers.get("content-type"), auth: headers.get("authorization"), body: Buffer.from(init?.body as Uint8Array).toString() });
      return Response.json({ id: "18c0ffee", threadId: "18c0ffee", labelIds: ["SENT"] });
    });
    const result = await sendRawViaGmail("access-1", Buffer.from("From: a@b.nz\r\n\r\nHi"));
    expect(seen).toEqual([
      { url: "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media", type: "message/rfc822", auth: "Bearer access-1", body: "From: a@b.nz\r\n\r\nHi" },
    ]);
    expect(result).toEqual({ messageId: "gmail:18c0ffee", response: "Accepted by the Gmail API (200), message 18c0ffee", rejected: [] });
  });

  it("explains Google's refusals in plain English, and retries only what goes away by itself", () => {
    const google = (status: number, reason: string, message = "Request had insufficient authentication scopes.") => new GmailSendError(status, `STATUS: ${message}`, [reason]);
    expect(explainGmailError(new GmailSendError(401, "UNAUTHENTICATED: Invalid Credentials", ["authError"]))).toMatchObject({
      message: expect.stringMatching(/^Google didn't accept the mailbox's sign-in\. An admin needs to connect it again in Settings > Email\./),
      retryable: false,
    });
    expect(explainGmailError(google(403, "ACCESS_TOKEN_SCOPE_INSUFFICIENT"))).toMatchObject({
      message: expect.stringMatching(/^Google didn't give Tohyee permission to send from this mailbox\./),
      retryable: false,
    });
    expect(explainGmailError(google(403, "insufficientPermissions")).retryable).toBe(false);
    expect(explainGmailError(google(429, "rateLimitExceeded", "Too many requests"))).toMatchObject({ retryable: true, message: expect.stringContaining("try again later") });
    expect(explainGmailError(google(403, "userRateLimitExceeded", "User-rate limit exceeded")).retryable).toBe(true);
    expect(explainGmailError(google(503, "backendError", "Backend Error")).retryable).toBe(true);
    expect(explainGmailError(google(403, "dailyLimitExceeded", "Daily user sending limit exceeded"))).toMatchObject({
      message: expect.stringMatching(/^This Gmail account has reached Google's daily sending limit\./),
      retryable: false,
    });
    expect(explainGmailError(google(400, "failedPrecondition", "Mail service not enabled"))).toMatchObject({
      message: expect.stringMatching(/Google Workspace account, its admin may have turned Gmail off/),
      retryable: false,
    });
    expect(explainGmailError(google(400, "invalidArgument", "Invalid To header")).message).toMatch(/^Google refused the email\. \(Google said: "STATUS: Invalid To header"\)$/);
    // Renewing the sign-in: withdrawn access, a Workspace admin's block, a changed client secret.
    expect(explainGmailError(new ProviderError(400, "oauth2.googleapis.com said 400: Token has been expired or revoked.", "invalid_grant"))).toEqual({
      message:
        "The Google mailbox's sign-in has expired or access was removed. An admin needs to connect it again in Settings > Email. (oauth2.googleapis.com said 400: Token has been expired or revoked.)",
      retryable: false,
    });
    expect(explainGmailError(new ProviderError(400, "x", "admin_policy_enforced")).message).toMatch(/^Your Google Workspace admin doesn't allow/);
    expect(explainGmailError(new ProviderError(401, "x", "invalid_client")).message).toMatch(/client ID or secret may have changed/);
    expect(explainGmailError(new ProviderError(503, "x")).retryable).toBe(true);
    expect(explainGmailError(new UnavailableError("Couldn't reach gmail.googleapis.com: timeout"))).toEqual({
      message: "Tohyee couldn't reach Google. Couldn't reach gmail.googleapis.com: timeout",
      retryable: true,
    });
  });

  it("explains what Google says when signing in doesn't finish", () => {
    expect(explainGoogleSignInError("access_denied")).toMatch(/^Google didn't give Tohyee access/);
    expect(explainGoogleSignInError("admin_policy_enforced")).toMatch(/Google Workspace admin/);
    expect(explainGoogleSignInError("something_else")).toBe("Signing in didn't finish: something_else");
  });

  it("disconnecting one mailbox falls back to what else is saved", () => {
    const row = (sending_method: string, smtp: boolean, microsoft: boolean, google: boolean) => ({
      sending_method,
      smtp_host: smtp ? "smtp.gmail.com" : null,
      microsoft_email: microsoft ? "a@b.nz" : null,
      google_email: google ? "c@d.nz" : null,
    });
    expect(fallbackMethod(row("google", true, true, true), "google")).toBe("smtp");
    expect(fallbackMethod(row("google", false, true, true), "google")).toBe("microsoft");
    expect(fallbackMethod(row("google", false, false, true), "google")).toBeNull();
    expect(fallbackMethod(row("microsoft", false, true, true), "google")).toBe("microsoft");
    expect(fallbackMethod(row("microsoft", false, true, true), "microsoft")).toBe("google");
    expect(fallbackMethod(row("smtp", true, true, false), "microsoft")).toBe("smtp");
  });
});
