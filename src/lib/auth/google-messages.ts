/**
 * Sign in with Google's plain-English messages (#424), shared by the server
 * and the browser (no Node modules here).
 */

/** Where to go after signing in: only Tohyee's own pages, never another site (the login page's rule). */
export function safeNextPath(value: unknown): string {
  const next = typeof value === "string" ? value : "";
  return /^\/(operations|server)(\/[A-Za-z0-9_\-/]*)?$/.test(next) ? next : "/operations";
}

/**
 * Messages for the codes the callback sends the browser back with. Only
 * codes travel in the address, so a link can't make the sign-in page show
 * text someone else wrote.
 */
export const GOOGLE_SIGN_IN_MESSAGES = {
  not_linked:
    "That Google account isn't linked to a Tohyee login. Sign in with your password and link it from Your account, or ask your server admin for an invitation.",
  cancelled: "Signing in with Google was cancelled.",
  expired: "That Google sign-in had expired or was started in another browser. Try again.",
  off: "Sign in with Google isn't turned on on this server.",
  disabled: "Your login is turned off. Ask your server admin.",
  wrong_account: "That Google account isn't the one the invitation was sent to. Choose the Google account with the invited email address, or choose a password instead.",
  taken: "That Google account is already linked to another Tohyee login.",
  link_used: "This setup link has expired or was already used. Ask your server admin for a new one.",
  server_admin: "Server admins always keep a password, so this login can't be set up with Google. Choose a password instead.",
  other_session: "You're signed in as someone else in this browser now, so the Google account wasn't linked. Sign in again and try once more.",
  failed: "Signing in with Google didn't work. Try again.",
  remote: "Tohyee can't be reached this way right now. Try on the local network.",
  linked: "Your Google account is linked. You can now sign in either way.",
  unverified: "Google says this account's email address isn't verified, so it can't be used to sign in.",
  busy: "Too many sign-in attempts from this address. Wait a minute, then try again.",
} as const;

export type GoogleSignInCode = keyof typeof GOOGLE_SIGN_IN_MESSAGES;

export function googleSignInMessage(code: unknown): string | null {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(GOOGLE_SIGN_IN_MESSAGES, code) ? GOOGLE_SIGN_IN_MESSAGES[code as GoogleSignInCode] : null;
}
