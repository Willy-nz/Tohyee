/**
 * Fixed messages for when an AI app's sign-in can't go ahead (#427). Only
 * a short code travels in the address, so a link can't make Tohyee's page
 * show words someone else wrote. Browser-safe.
 */
export const CONNECT_PROBLEMS = {
  off: "AI apps can only sign in to Tohyee through Remote access, and it's off (or has no https address). A server admin can turn it on in the Tohyee server app. Until then, use an AI key from the AI page.",
  unknown_client: "Tohyee doesn't know the app that sent you here. Go back to your AI app and try connecting again.",
  client_details: "Tohyee couldn't read or check the details of the app that sent you here, so it can't connect. Go back to your AI app and try again; if it keeps happening, the app may not support signing in to Tohyee yet.",
  redirect: "The app that sent you here asked to be sent back to an address it didn't register. Nothing was connected. If you didn't just start connecting an AI app, close this page.",
  bad_request: "The app that sent you here sent a sign-in request Tohyee can't use. Nothing was connected. Go back to your AI app and try again.",
  expired: "This connection request has expired, was already used, or was started in another browser. Go back to your AI app and start connecting again.",
  busy: "Too many connection requests from this address. Wait a minute, then try again.",
} as const;

export type ConnectProblem = keyof typeof CONNECT_PROBLEMS;

export function connectProblemMessage(code: unknown): string {
  return typeof code === "string" && Object.hasOwn(CONNECT_PROBLEMS, code) ? CONNECT_PROBLEMS[code as ConnectProblem] : CONNECT_PROBLEMS.bad_request;
}

/** Shown on every consent screen (decision 818). */
export const APP_NAME_WARNING =
  "Tohyee can't check an app's name: any app can call itself “Claude” or “ChatGPT”. Only allow this if you started connecting this app yourself just now, and the address it sends you back to is one you expect (claude.ai for Claude, chatgpt.com for ChatGPT).";

/** Shown when the app can only send people back to this computer (decision 818). */
export const LOOPBACK_WARNING =
  "This app sends you back to an address on this computer (localhost). Any program running on your computer can use such an address, so only allow it if you're connecting an app on this computer, such as Claude Code, right now.";
