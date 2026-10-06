import type { Tokens } from "@/lib/crm/mail/providers";
import type { OrgTx } from "@/lib/db/org-transaction";
import { explainGmailError, googleAccessToken, saveGoogleRefreshedTokens, sendViaGmail } from "@/lib/email/google";
import { explainGraphError, microsoftAccessToken, saveRefreshedTokens, sendViaGraph } from "@/lib/email/microsoft";
import type { SendingAccount } from "@/lib/email/settings";
import { explainSmtpError, openAccountTransport, type OutgoingMessage, sendMessage, type SendResult } from "@/lib/email/smtp";

/**
 * One way of sending for the outbox and the test email, whichever the
 * organisation chose: its SMTP account, its Microsoft mailbox through
 * Graph, or its Google mailbox through the Gmail API. Opening a Microsoft or
 * Google sender may refresh the access token (network), so it's never called
 * inside a database transaction; `saveTokens` stores what the provider
 * issued, in a transaction of its own.
 */
export type SendingVia = "smtp" | "microsoft" | "google";

export type Sender = {
  via: SendingVia;
  send(message: OutgoingMessage): Promise<SendResult>;
  explain(error: unknown): { message: string; retryable: boolean };
  close(): void;
};

export async function openSender(account: SendingAccount, saveTokens: (tokens: Tokens) => Promise<void>): Promise<Sender> {
  if (account.method === "microsoft") {
    const accessToken = await microsoftAccessToken(account, saveTokens);
    return {
      via: "microsoft",
      send: (message) => sendViaGraph(accessToken, account, message),
      explain: explainGraphError,
      close: () => undefined,
    };
  }
  if (account.method === "google") {
    const accessToken = await googleAccessToken(account, saveTokens);
    return {
      via: "google",
      send: (message) => sendViaGmail(accessToken, account, message),
      explain: explainGmailError,
      close: () => undefined,
    };
  }
  // Checks the SMTP server first (#145): a refused server is an open error, explained like any other.
  const transport = await openAccountTransport(account);
  return {
    via: "smtp",
    send: (message) => sendMessage(transport, account, message),
    explain: (error) => explainSmtpError(error, account),
    close: () => transport.close(),
  };
}

/** Stores tokens a Microsoft or Google sign-in renewed, for the mailbox the account was read for. */
export async function saveSenderTokens(tx: OrgTx, account: SendingAccount, tokens: Tokens): Promise<void> {
  if (account.method === "microsoft") await saveRefreshedTokens(tx, account.fromAddress, tokens);
  else if (account.method === "google") await saveGoogleRefreshedTokens(tx, account.fromAddress, tokens);
}

/** Why a sender couldn't be opened (a sign-in that needs renewing, or the provider unreachable). */
export function explainOpenError(account: SendingAccount, error: unknown): { message: string; retryable: boolean } {
  if (account.method === "microsoft") return explainGraphError(error);
  if (account.method === "google") return explainGmailError(error);
  return explainSmtpError(error, account);
}
