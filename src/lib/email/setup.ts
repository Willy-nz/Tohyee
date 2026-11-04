import type { OrganisationEmailSettings, SendingMethod } from "@/lib/email/settings";
import { type EmailDocumentKind, fillTemplate, PLACEHOLDERS } from "@/lib/email/templates";

/**
 * The guided Settings › Email setup and template editor (decisions
 * 1391-1395), browser-safe: the steps, what the connected summary says, the
 * sample a template preview is filled with, and putting a placeholder where
 * the cursor is.
 */

export type EmailSetupStep = "provider" | "details" | "mailbox" | "test" | "done";

export const EMAIL_SETUP_STEPS: EmailSetupStep[] = ["provider", "details", "mailbox", "test", "done"];

/** The step names in the step bar: a sign-in provider has app details and a sign-in, SMTP a server and an account. */
export function emailStepNames(provider: SendingMethod): Record<EmailSetupStep, string> {
  return {
    provider: "Provider",
    details: provider === "smtp" ? "Server" : "App details",
    mailbox: provider === "smtp" ? "Account" : "Sign in",
    test: "Test",
    done: "Done",
  };
}

export const PROVIDER_NAMES: Record<SendingMethod, string> = { microsoft: "Microsoft 365", google: "Google", smtp: "SMTP" };

/** The provider's app (client ID and secret) is saved, so its mailbox can be signed in to. */
export function appSaved(settings: OrganisationEmailSettings, provider: "microsoft" | "google"): boolean {
  const app = provider === "microsoft" ? settings.microsoftApp : settings.googleApp;
  return Boolean(app.clientId) && app.secretSaved;
}

/** The address documents are sent from with this method, if it's set up. */
export function sendingAddress(settings: OrganisationEmailSettings, method: SendingMethod = settings.sendingMethod): string | null {
  if (method === "microsoft") return settings.microsoft?.email ?? null;
  if (method === "google") return settings.google?.email ?? null;
  return settings.smtpSaved ? (settings.fromAddress ?? settings.username) : null;
}

/** What needs fixing on the account in use, if anything: a sign-in or password the server can't read, or a failed last test. */
export function accountProblem(settings: OrganisationEmailSettings): string | null {
  const method = settings.sendingMethod;
  const mailbox = method === "microsoft" ? settings.microsoft : method === "google" ? settings.google : null;
  if (mailbox && !mailbox.tokensReadable) return "The sign-in can't be read on this server any more. Choose Change and sign in again.";
  if (method === "smtp" && settings.hasPassword && !settings.passwordReadable) return "The saved password can't be read on this server any more. Choose Change and enter it again.";
  if (settings.lastTest && !settings.lastTest.ok) return `The last test failed. ${settings.lastTest.error ?? ""}`.trim();
  return null;
}

/** Where the setup opens: a fresh account at the start; coming back from signing in, at the sign-in step to confirm the from name. */
export function firstSetupStep(
  settings: OrganisationEmailSettings,
  returned: "connected" | "error" | null,
  /** The provider the browser went to sign in with, if it remembered. */
  remembered: "microsoft" | "google" | null,
): { step: EmailSetupStep; provider: SendingMethod } {
  if (returned === "connected" && settings.sendingMethod !== "smtp") return { step: "mailbox", provider: settings.sendingMethod };
  if (returned) return { step: "mailbox", provider: remembered ?? guessProvider(settings) };
  return { step: "provider", provider: settings.configured ? settings.sendingMethod : "microsoft" };
}

function guessProvider(settings: OrganisationEmailSettings): "microsoft" | "google" {
  // A failed sign-in leaves the method as it was; the app that's saved says which provider it was.
  if (appSaved(settings, "google") && !appSaved(settings, "microsoft")) return "google";
  return "microsoft";
}

/** Made-up values for a template's preview (no real business). The organisation is the one being set up. */
export function sampleValues(kind: EmailDocumentKind, organisation: string): Record<string, string> {
  const numbers: Record<EmailDocumentKind, string> = {
    invoice: "INV-0042",
    credit_note: "CN-0007",
    quote: "QU-0015",
    purchase_order: "PO-0023",
    statement: "",
  };
  const all: Record<string, string> = {
    contact: "Sam Taylor",
    organisation: organisation || "Your organisation",
    number: numbers[kind],
    date: "3 Nov 2026",
    "due date": "20 Nov 2026",
    "expiry date": "3 Dec 2026",
    "delivery date": "10 Nov 2026",
    total: "1,150.00",
    "amount due": "1,150.00",
    reference: "Order 1234",
    "statement date": "31 Oct 2026",
    balance: "2,300.00",
  };
  // Only this document type's placeholders: any other is left as typed, as when it's emailed.
  return Object.fromEntries(PLACEHOLDERS[kind].map((name) => [name, all[name]]));
}

export function previewTemplate(kind: EmailDocumentKind, template: { subject: string; body: string }, organisation: string): { subject: string; body: string } {
  const values = sampleValues(kind, organisation);
  return { subject: fillTemplate(template.subject, values), body: fillTemplate(template.body, values) };
}

/** Puts `{name}` in place of the selection (or at the cursor), and says where the cursor goes after it. */
export function insertPlaceholder(text: string, start: number, end: number, name: string, maxLength = Infinity): { text: string; cursor: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  const token = `{${name}}`;
  const next = text.slice(0, from) + token + text.slice(to);
  if (next.length > maxLength) return { text, cursor: to };
  return { text: next, cursor: from + token.length };
}
