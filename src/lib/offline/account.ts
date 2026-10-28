/*
 * Which account the device's offline work belongs to (#478, #481,
 * decisions 1050-1053). Browser- and server-safe: no imports.
 *
 * Work saved on a phone belongs to the server, account and organisation
 * that made it. A browser shares one sign-in cookie between its tabs, so
 * an old tab can still hold work made by someone who has since signed out
 * and let someone else sign in. Every request the device sends for
 * offline work says which account it's for, and the server refuses it
 * when the signed-in account is a different one: the work stays held for
 * its own account and is never recorded as someone else.
 */

/** The request header naming the account offline work (or a farm pack) is for. */
export const EXPECTED_ACCOUNT_HEADER = "x-tohyee-expected-user";

/** The error code the server answers with when the signed-in account isn't the one named. */
export const ACCOUNT_CHANGED_CODE = "account_changed";

export const ACCOUNT_CHANGED_MESSAGE = "Tohyee is signed in as a different account now, so this wasn't recorded. It stays on this device for the account that made it.";

/** Headers for a request made for `userId`'s offline work. */
export function expectedAccountHeaders(userId: string): Record<string, string> {
  return { [EXPECTED_ACCOUNT_HEADER]: userId };
}

/** Whether a refused answer's body says the signed-in account changed. */
export function isAccountChanged(status: number | null, payload: unknown): boolean {
  return status === 401 && Boolean(payload && typeof payload === "object" && (payload as { code?: unknown }).code === ACCOUNT_CHANGED_CODE);
}

export type SessionCheck =
  /** Signed in online as this account just now. */
  | "verified"
  /** Signed in, but as someone else (another tab signed in as them). */
  | "other_account"
  /** Not signed in (expired, signed out or revoked). */
  | "signed_out"
  /** Tohyee couldn't be reached, or answered with something else. */
  | "unreachable";

/**
 * What an answer from /api/auth/session says about `userId`. Only a
 * signed-in answer for this same account renews the device's offline
 * session (decision 1052); the service worker has the same rule in
 * public/sw-rules.js (`sessionCheck`).
 */
export function sessionCheck(status: number | null, body: unknown, userId: string): SessionCheck {
  if (status === 401 || status === 403) return "signed_out";
  if (status !== 200 || !body || typeof body !== "object") return "unreachable";
  const user = (body as { user?: unknown }).user;
  const id = user && typeof user === "object" ? (user as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || !id) return "unreachable";
  return id === userId ? "verified" : "other_account";
}
