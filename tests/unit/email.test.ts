import { describe, expect, it } from "vitest";
import { headerText, isEmailAddress, optionalAddress, requireAddresses, splitAddresses } from "@/lib/email/addresses";
import { explainSmtpError } from "@/lib/email/smtp";
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
    expect(explainSmtpError(error({ code: "ETIMEDOUT" }), account).retryable).toBe(true);
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
