import { describe, expect, it } from "vitest";
import {
  accountProblem,
  appSaved,
  emailStepNames,
  firstSetupStep,
  insertPlaceholder,
  previewTemplate,
  sampleValues,
  sendingAddress,
} from "@/lib/email/setup";
import type { OrganisationEmailSettings } from "@/lib/email/settings";
import { DEFAULT_TEMPLATES, EMAIL_DOCUMENT_KINDS, PLACEHOLDERS } from "@/lib/email/templates";

// Made-up settings: nothing set up.
const blank: OrganisationEmailSettings = {
  configured: false,
  sendingMethod: "smtp",
  smtpSaved: false,
  microsoft: null,
  microsoftApp: { clientId: null, secretSaved: false, tenant: "common" },
  google: null,
  googleApp: { clientId: null, secretSaved: false },
  fromName: null,
  fromAddress: null,
  replyTo: null,
  host: null,
  port: null,
  security: null,
  username: null,
  hasPassword: false,
  passwordReadable: true,
  secretsAvailable: true,
  updatedAt: null,
  updatedByEmail: null,
  lastTest: null,
};

const mailbox = { email: "accounts@example.co.nz", connectedAt: "2026-11-04T00:00:00.000Z", connectedByEmail: "admin@example.co.nz", tokensReadable: true };

describe("email setup steps", () => {
  it("names the steps for the provider", () => {
    expect(emailStepNames("microsoft")).toMatchObject({ details: "App details", mailbox: "Sign in" });
    expect(emailStepNames("smtp")).toMatchObject({ details: "Server", mailbox: "Account" });
  });

  it("starts a fresh account at choosing the provider", () => {
    expect(firstSetupStep(blank, null, null)).toEqual({ step: "provider", provider: "microsoft" });
  });

  it("starts a change from the provider in use", () => {
    const google = { ...blank, configured: true, sendingMethod: "google" as const, google: mailbox };
    expect(firstSetupStep(google, null, null)).toEqual({ step: "provider", provider: "google" });
  });

  it("comes back from signing in at the sign-in step, with the provider", () => {
    const microsoft = { ...blank, configured: true, sendingMethod: "microsoft" as const, microsoft: mailbox };
    expect(firstSetupStep(microsoft, "connected", null)).toEqual({ step: "mailbox", provider: "microsoft" });
    expect(firstSetupStep(blank, "error", "google")).toEqual({ step: "mailbox", provider: "google" });
    // Not remembered: the saved app says which it was.
    expect(firstSetupStep({ ...blank, googleApp: { clientId: "id", secretSaved: true } }, "error", null).provider).toBe("google");
    expect(firstSetupStep(blank, "error", null).provider).toBe("microsoft");
  });

  it("needs the app's client ID and secret before signing in", () => {
    expect(appSaved(blank, "microsoft")).toBe(false);
    expect(appSaved({ ...blank, microsoftApp: { clientId: "id", secretSaved: false, tenant: "common" } }, "microsoft")).toBe(false);
    expect(appSaved({ ...blank, microsoftApp: { clientId: "id", secretSaved: true, tenant: "common" } }, "microsoft")).toBe(true);
  });
});

describe("the connected summary", () => {
  it("shows the address documents are sent from", () => {
    expect(sendingAddress({ ...blank, sendingMethod: "microsoft", microsoft: mailbox })).toBe("accounts@example.co.nz");
    expect(sendingAddress({ ...blank, smtpSaved: true, username: "login@example.co.nz", fromAddress: "hello@example.co.nz" })).toBe("hello@example.co.nz");
    expect(sendingAddress(blank)).toBeNull();
  });

  it("says what needs fixing", () => {
    expect(accountProblem({ ...blank, sendingMethod: "google", google: { ...mailbox, tokensReadable: false } })).toMatch(/sign in again/);
    expect(accountProblem({ ...blank, hasPassword: true, passwordReadable: false })).toMatch(/enter it again/);
    expect(accountProblem({ ...blank, lastTest: { at: "2026-11-04T00:00:00.000Z", ok: false, error: "Wrong password." } })).toBe("The last test failed. Wrong password.");
    expect(accountProblem({ ...blank, lastTest: { at: "2026-11-04T00:00:00.000Z", ok: true, error: null } })).toBeNull();
  });
});

describe("template preview and placeholders", () => {
  it("has a sample value for every placeholder", () => {
    for (const kind of EMAIL_DOCUMENT_KINDS) {
      const values = sampleValues(kind, "Example Ltd");
      for (const name of PLACEHOLDERS[kind]) expect(values[name], `${kind} {${name}}`).toBeTruthy();
    }
  });

  it("fills Tohyee's invoice template with the sample", () => {
    const preview = previewTemplate("invoice", DEFAULT_TEMPLATES.invoice, "Example Ltd");
    expect(preview.subject).toBe("Invoice INV-0042 from Example Ltd");
    expect(preview.body).toContain("Hi Sam Taylor,");
    expect(preview.body).toContain("The amount due is $1,150.00, due on 20 Nov 2026.");
    expect(preview.body).not.toMatch(/[{}]/);
  });

  it("leaves a placeholder the document type doesn't have as typed", () => {
    expect(previewTemplate("statement", { subject: "{number}", body: "{balance}" }, "Example Ltd")).toEqual({ subject: "{number}", body: "2,300.00" });
  });

  it("inserts at the cursor, or over the selection", () => {
    expect(insertPlaceholder("Hi ,", 3, 3, "contact")).toEqual({ text: "Hi {contact},", cursor: 12 });
    expect(insertPlaceholder("Hi there,", 3, 8, "contact")).toEqual({ text: "Hi {contact},", cursor: 12 });
    expect(insertPlaceholder("Hi", 99, 99, "contact")).toEqual({ text: "Hi{contact}", cursor: 11 });
  });

  it("doesn't insert past the field's limit", () => {
    expect(insertPlaceholder("abc", 3, 3, "contact", 5)).toEqual({ text: "abc", cursor: 3 });
  });
});
