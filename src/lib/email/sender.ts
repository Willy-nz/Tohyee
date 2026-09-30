import type { Tokens } from "@/lib/crm/mail/providers";
import { explainGraphError, microsoftAccessToken, sendViaGraph } from "@/lib/email/microsoft";
import type { SendingAccount } from "@/lib/email/settings";
import { createAccountTransport, explainSmtpError, type OutgoingMessage, sendMessage, type SendResult } from "@/lib/email/smtp";

/**
 * One way of sending for the outbox and the test email, whichever the
 * organisation chose: its SMTP account, or its Microsoft mailbox through
 * Graph. Opening a Microsoft sender may refresh the access token (network),
 * so it's never called inside a database transaction; `saveTokens` stores
 * what Microsoft issued, in a transaction of its own.
 */
export type Sender = {
  via: "smtp" | "microsoft";
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
  const transport = createAccountTransport(account);
  return {
    via: "smtp",
    send: (message) => sendMessage(transport, account, message),
    explain: (error) => explainSmtpError(error, account),
    close: () => transport.close(),
  };
}

/** Why a sender couldn't be opened (a Microsoft sign-in that needs renewing, or Microsoft unreachable). */
export function explainOpenError(account: SendingAccount, error: unknown): { message: string; retryable: boolean } {
  return account.method === "microsoft" ? explainGraphError(error) : explainSmtpError(error, account);
}
