import { describe, expect, it } from "vitest";
import { headerText, isEmailAddress, optionalAddress, requireAddresses, splitAddresses } from "@/lib/email/addresses";
import { emailSummary, escapeHtml, paragraphs, renderEmailHtml } from "@/lib/email/html";
import { explainGraphError, GraphSendError, graphMessage, sendViaGraph } from "@/lib/email/microsoft";
import { explainSmtpError } from "@/lib/email/smtp";
import { fitLogo, imageSize } from "@/lib/organisations/logo";
import { checkTemplate, DEFAULT_TEMPLATES, EMAIL_DOCUMENT_KINDS, fillTemplate, unknownPlaceholders } from "@/lib/email/templates";
import { safeFileName } from "@/lib/pdf/documents";

describe("email addresses", () => {
  it("accepts plain addresses and splits lists on commas, semicolons, spaces and new lines", () => {
    expect(isEmailAddress("accounts@kobe.co.nz")).toBe(true);
    expect(isEmailAddress("first.last+invoices@sub.example.com")).toBe(true);
    expect(splitAddresses("Accounts@Kobe.co.nz; mia@kobe.co.nz,\nACCOUNTS@kobe.co.nz  jess@glimmers.nz")).toEqual({
      addresses: ["accounts@kobe.co.nz", "mia@kobe.co.nz", "jess@glimmers.nz"],
      invalid: [],
    });
    expect(splitAddresses(["a@b.nz", "", "c@d.nz"]).addresses).toEqual(["a@b.nz", "c@d.nz"]);
  });

  it("refuses anything that could add a header or a hidden recipient", () => {
    for (const bad of ['"Kobe" <accounts@kobe.nz>', "accounts@kobe.nz>", "no-at-sign", "a@localhost", "a@b..nz", ".a@b.nz", "a..b@c.nz", "a@-b.nz"]) {
      expect(isEmailAddress(bad), bad).toBe(false);
    }
    // A line break splits the text, so "Bcc:" shows up as not an address.
    expect(splitAddresses("a@b.nz\r\nBcc: spy@evil.nz").invalid).toEqual(["Bcc:"]);
    expect(() => requireAddresses("a@b.nz\r\nBcc: spy@evil.nz", "To", { required: true })).toThrow(`To: "Bcc:" isn't an email address.`);
    expect(() => requireAddresses("", "To", { required: true })).toThrow("To: enter at least one email address.");
    expect(requireAddresses("", "Cc", { required: false })).toEqual([]);
    expect(() => requireAddresses(Array.from({ length: 21 }, (_, i) => `p${i}@x.nz`), "To", { required: true })).toThrow("at most 20");
    expect(optionalAddress(" Jess@Glimmers.nz ", "Reply-to")).toBe("jess@glimmers.nz");
    expect(() => optionalAddress("jess@glimmers.nz, spy@evil.nz", "Reply-to")).toThrow("must be one email address");
  });

  it("takes line breaks and control characters out of header text", () => {
    expect(headerText("Invoice\r\nBcc: spy@evil.nz", 250)).toBe("Invoice Bcc: spy@evil.nz");
    expect(headerText("A\u2028B\tC\u0000D   E", 250)).toBe("A B C D E");
    expect(headerText("x".repeat(300), 250)).toHaveLength(250);
  });
});

describe("email templates", () => {
  it("fills placeholders, ignoring case and extra spaces; blanks ones with no value; leaves unknown ones", () => {
    const text = "Hi {contact}, invoice {Number} for ${total} is due {due  date}. Ref: {reference}. {mystery}";
    expect(fillTemplate(text, { contact: "Kobe Cafe", number: "INV-0001", total: "316.25", "due date": "20 Aug 2026", reference: null })).toBe(
      "Hi Kobe Cafe, invoice INV-0001 for $316.25 is due 20 Aug 2026. Ref: . {mystery}",
    );
  });

  it("every default template only uses its own placeholders", () => {
    for (const kind of EMAIL_DOCUMENT_KINDS) {
      expect(() => checkTemplate(kind, DEFAULT_TEMPLATES[kind].subject, DEFAULT_TEMPLATES[kind].body)).not.toThrow();
    }
  });

  it("names placeholders a document type doesn't have", () => {
    expect(unknownPlaceholders("statement", "Hi {contact}, invoice {number} {due date}")).toEqual(["{number}", "{due date}"]);
    expect(unknownPlaceholders("invoice", "{amount due} {Due Date}")).toEqual([]);
    expect(() => checkTemplate("quote", "Quote {number}", "Due {due date}")).toThrow(/\{due date\} isn't something Tohyee can fill in for quotes/);
    expect(() => checkTemplate("invoice", " ", "x")).toThrow("The subject can't be blank.");
    expect(() => checkTemplate("invoice", "x", "")).toThrow("The message can't be blank.");
  });
});

describe("SMTP errors in plain English", () => {
  const account = { host: "smtp.gmail.com", port: 465, security: "ssl" as const };
  const error = (props: Record<string, unknown>, message = "failed") => Object.assign(new Error(message), props);

  it("a wrong password isn't retried and explains app passwords", () => {
    const result = explainSmtpError(error({ code: "EAUTH", responseCode: 535, response: "535-5.7.8 Username and Password not accepted." }), account);
    expect(result.retryable).toBe(false);
    expect(result.message).toMatch(/^The email server didn't accept the username and password\. For Gmail, use an app password/);
    expect(result.message).toContain('(The server said: "535-5.7.8 Username and Password not accepted.")');
  });

  it("busy servers and lost connections are retried; refusals aren't", () => {
    expect(explainSmtpError(error({ code: "EMESSAGE", responseCode: 421, response: "421 Try again later" }), account).retryable).toBe(true);
    expect(explainSmtpError(error({ code: "ECONNECTION" }, "connect ECONNREFUSED 1.2.3.4:465"), account)).toMatchObject({
      retryable: true,
      message: expect.stringMatching(/^Tohyee couldn't connect to the email server smtp\.gmail\.com:465/),
    });
    expect(explainSmtpError(error({ code: "ETIMEDOUT" }, "Connection timeout"), account).retryable).toBe(true);
    expect(explainSmtpError(error({ code: "ETIMEDOUT" }, "Greeting never received"), account).retryable).toBe(true);
    // Once the session started, a timeout or dropped connection may have come after the message went: not retried (#146).
    expect(explainSmtpError(error({ code: "ETIMEDOUT" }, "Timeout"), account)).toMatchObject({
      retryable: false,
      message: expect.stringMatching(/^It isn't clear whether the email was sent: .* Check the Sent folder of the mailbox on smtp\.gmail\.com:465/),
    });
    expect(explainSmtpError(error({ code: "ECONNECTION" }, "Connection closed unexpectedly"), account).retryable).toBe(false);
    expect(explainSmtpError(error({ code: "EDNS" }, "getaddrinfo ENOTFOUND smtp.gmial.com"), account).message).toMatch(/couldn't find the email server/);
    expect(explainSmtpError(error({ code: "EENVELOPE", responseCode: 550 }), account)).toMatchObject({ retryable: false, message: expect.stringMatching(/refused the sender or recipient/) });
    expect(explainSmtpError(error({ code: "EMESSAGE", responseCode: 552, response: "552 Message too big" }), account)).toMatchObject({ retryable: false });
    expect(explainSmtpError(error({ code: "ESOCKET" }, "ssl3_get_record:wrong version number"), account).message).toMatch(/SSL\/TLS goes with port 465, STARTTLS with port 587/);
  });
});

describe("attachment names", () => {
  it("keep only characters every computer accepts", () => {
    expect(safeFileName("Invoice INV-0001")).toBe("Invoice INV-0001.pdf");
    expect(safeFileName('Statement A/B: "Cafe" 2026-07-31')).toBe("Statement A B Cafe 2026-07-31.pdf");
    expect(safeFileName("Statement Ōtepoti Café")).toBe("Statement Ōtepoti Café.pdf");
    expect(safeFileName("   ")).toBe("Document.pdf");
  });
});

describe("HTML emails", () => {
  const organisation = { name: "Glimmers & Co <NZ>", postalAddress: "PO Box 5\nDunedin", gstNumber: "123-456-789", email: "jess@glimmers.nz" };

  it("escapes everything typed, keeps paragraphs and line breaks, and shows the summary and contact details", () => {
    const html = renderEmailHtml({
      subject: 'Invoice "1" <x>',
      body: "Hi <script>alert(1)</script>,\n\nLine one\nLine two\n\n\nBye",
      organisation,
      summary: emailSummary("invoice", { number: "INV-0001", total: "316.25", "amount due": "100.00", "due date": "20 Aug 2026" }),
      logo: { cid: "logo-abc@tohyee", width: 120, height: 40 },
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("Hi &lt;script&gt;alert(1)&lt;/script&gt;,");
    expect(html).toContain("Line one<br>Line two");
    expect(html.match(/<p /g)).toHaveLength(3);
    expect(html).toContain("<title>Invoice &quot;1&quot; &lt;x&gt;</title>");
    expect(html).toContain('src="cid:logo-abc@tohyee" width="120" height="40" alt="Glimmers &amp; Co &lt;NZ&gt;"');
    expect(html).toContain("PO Box 5<br>Dunedin");
    expect(html).toContain("GST number 123-456-789");
    expect(html).not.toMatch(/https?:\/\//);
    expect(emailSummary("invoice", { number: "INV-0001", total: "316.25", "amount due": "100.00", "due date": "20 Aug 2026" })).toEqual([
      { label: "Invoice number", value: "INV-0001" },
      { label: "Total", value: "$316.25" },
      { label: "Amount due", value: "$100.00" },
      { label: "Due date", value: "20 Aug 2026" },
    ]);
    expect(emailSummary("statement", { "statement date": "31 Jul 2026", balance: "316.25" })).toEqual([
      { label: "Statement date", value: "31 Jul 2026" },
      { label: "Balance owing", value: "$316.25" },
    ]);
    expect(paragraphs("  \n\n")).toEqual([]);
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("without a logo the header is the organisation's name", () => {
    const html = renderEmailHtml({ subject: "s", body: "b", organisation: { ...organisation, postalAddress: null, gstNumber: null, email: null }, summary: [], logo: null });
    expect(html).not.toContain("<img");
    expect(html).toContain("Glimmers &amp; Co &lt;NZ&gt;</div>");
  });
});

describe("the organisation's logo", () => {
  it("reads the size of PNG and JPEG images from their headers, and fits them in a box", () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    expect(imageSize(png)).toEqual({ contentType: "image/png", width: 1, height: 1 });
    // SOI, an APP0 segment, then SOF0 with height 40 and width 300.
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x28, 0x01, 0x2c, 0x03, 0, 0, 0, 0, 0, 0]);
    expect(imageSize(jpeg)).toEqual({ contentType: "image/jpeg", width: 300, height: 40 });
    expect(imageSize(Buffer.from("GIF89a..........."))).toBeNull();
    expect(fitLogo({ width: 800, height: 200 }, { width: 200, height: 64 })).toEqual({ width: 200, height: 50 });
    expect(fitLogo({ width: 100, height: 40 }, { width: 200, height: 64 })).toEqual({ width: 100, height: 40 });
  });
});

describe("sending through Microsoft Graph", () => {
  it("refuses attachments over the 3 MB Graph takes in one request, and explains Graph's answers", async () => {
    const message = {
      to: ["a@b.nz"],
      cc: [],
      subject: "s",
      text: "t",
      html: null,
      attachment: { fileName: "big.pdf", bytes: new Uint8Array(3 * 1024 * 1024 + 1) },
      inline: [],
      messageId: "<x@y>",
    };
    await expect(sendViaGraph("token", { fromAddress: "a@b.nz", replyTo: null }, message)).rejects.toThrow("more than the 3 MB Microsoft takes in one email");
    expect(explainGraphError(new GraphSendError(429, "ApplicationThrottled: slow down")).retryable).toBe(true);
    expect(explainGraphError(new GraphSendError(503, "busy")).retryable).toBe(true);
    expect(explainGraphError(new GraphSendError(403, "ErrorAccessDenied: no")).message).toMatch(/Mail\.Send permission/);
    expect(explainGraphError(new GraphSendError(400, "ErrorInvalidRecipients: bad")).retryable).toBe(false);
    const body = graphMessage({ fromAddress: "a@b.nz", replyTo: null }, { ...message, attachment: null, text: "Plain" });
    expect(body.message.body).toEqual({ contentType: "Text", content: "Plain" });
    expect(body.message.replyTo).toEqual([{ emailAddress: { address: "a@b.nz" } }]);
  });
});
