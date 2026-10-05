/**
 * When it isn't known whether an email went (#146): the request reached the
 * provider but no clear answer came back (a timeout after the message was
 * handed over, Google's 200 without the message's id, an SMTP connection
 * that dropped after the message's data was sent). Trying again could send
 * it twice, so it isn't retried: the person is told to check the mailbox's
 * Sent folder first.
 */
export class EmailMaybeSentError extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

export function maybeSentMessage(where: string, detail: string): string {
  return `It isn't clear whether the email was sent: ${detail} Check the Sent folder of ${where} before sending it again.`;
}

/** Network errors that mean the request never reached the provider, so trying again can't send it twice. */
const NEVER_CONNECTED = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|CERT_|self.signed|unable to verify/i;

/** Whether a failed fetch might have delivered the request (a timeout or a dropped connection), rather than never connecting. */
export function fetchMayHaveDelivered(error: unknown): boolean {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const value = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    parts.push(String(value.name ?? ""), String(value.message ?? ""), String(value.code ?? ""));
    current = value.cause;
  }
  const text = parts.join(" ");
  if (NEVER_CONNECTED.test(text)) return false;
  return true;
}
