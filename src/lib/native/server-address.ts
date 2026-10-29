/*
 * The Android app's "Your Tohyee address" screen (#502, decisions
 * 1140-1142): what the person types, turned into the server's HTTPS origin,
 * and whether that address answers as a Tohyee server. Pure and
 * browser-safe: the app's bundled first-run page (android-shell/) is built
 * from this file, and tests/unit/native-server-address.test.ts tests it.
 *
 * The app only opens HTTPS addresses. Android blocks plain http by default,
 * a phone keeps nothing offline on it, and the person's sign-in would cross
 * the network unprotected. A home-network address needs Tailscale's HTTPS
 * or Remote access first, as for the web app (docs/MOBILE-APP.md).
 */

/** What /api/app/identify answers. `api` changes only when the app and server stop understanding each other. */
export type ServerIdentity = {
  app: "tohyee";
  /** The app protocol's version: 1 is the first. */
  api: number;
  name: string;
  /** Only on the server's own network: through Remote access the version isn't given out (#208 item 8). */
  version: string | null;
};

/** The highest app protocol this build of the app understands. */
export const APP_API = 1;

export type AddressResult = { ok: true; origin: string } | { ok: false; problem: string };

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The server's origin from what was typed: "farm.example.nz",
 * "https://farm.example.nz/operations/farm" and "farm.example.nz:8443" all
 * work; "https://" is added when it's left off. Anything after the address
 * (a page, a query) is dropped: the app always opens the server's start.
 */
export function normaliseServerAddress(input: string): AddressResult {
  const typed = input.trim().replace(/\s+/g, "");
  if (!typed) return { ok: false, problem: "Type your Tohyee address, for example tohyee.example.nz." };
  if (/^http:\/\//i.test(typed)) return { ok: false, problem: "That address starts with http://, which isn't secure. The app only opens HTTPS addresses (https://…). Use your Remote access or Tailscale HTTPS address." };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, problem: "That doesn't look like a web address. Check it and try again." };
  }
  if (url.protocol !== "https:") return { ok: false, problem: "The app only opens HTTPS addresses (https://…)." };
  if (url.username || url.password) return { ok: false, problem: "Leave out any name or password: type just the address." };
  const host = url.hostname.toLowerCase();
  const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  if (!ipv4 && !host.startsWith("[") && !HOST.test(host)) return { ok: false, problem: "That doesn't look like a web address. Check it and try again." };
  if (host === "localhost" || host.endsWith(".localhost")) return { ok: false, problem: "localhost is the phone itself, not your Tohyee server. Use the server's web address." };
  if (!host.includes(".") && !host.startsWith("[")) return { ok: false, problem: "Type the whole address, for example tohyee.example.nz or yourcomputer.yourtailnet.ts.net." };
  return { ok: true, origin: url.origin };
}

/** Where the app asks whether an address is a Tohyee server. */
export function identifyUrl(origin: string): string {
  return `${origin}/api/app/identify`;
}

export type IdentifyResult = { ok: true; identity: ServerIdentity } | { ok: false; problem: string };

/** Reads /api/app/identify's answer. Anything else (another website, a login page, an old Tohyee) says so in words. */
export function readIdentity(status: number, body: unknown): IdentifyResult {
  const notTohyee = "Something answered at that address, but it isn't a Tohyee server (or it's an older Tohyee, from before the Android app). Check the address, or ask whoever looks after Tohyee to update it.";
  if (status === 404) return { ok: false, problem: notTohyee };
  if (status < 200 || status >= 300) return { ok: false, problem: `The server answered with an error (${status}). Try again later, or check the address.` };
  if (!body || typeof body !== "object") return { ok: false, problem: notTohyee };
  const value = body as Record<string, unknown>;
  if (value.app !== "tohyee" || typeof value.api !== "number" || !Number.isInteger(value.api) || value.api < 1) return { ok: false, problem: notTohyee };
  if (value.api > APP_API) return { ok: false, problem: "This Tohyee server is newer than this copy of the app. Update the app (Get Tohyee on this device on the server has the latest), then try again." };
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, 80) : "Tohyee";
  const version = typeof value.version === "string" && /^\d+\.\d+\.\d+/.test(value.version) ? value.version.slice(0, 40) : null;
  return { ok: true, identity: { app: "tohyee", api: value.api, name, version } };
}

/** What a failed fetch means to the person (no signal, a wrong name, a certificate the phone doesn't trust, a timeout). */
export function unreachableText(error: unknown, online: boolean): string {
  if (!online) return "This phone has no connection. Connect to Wi-Fi or mobile data, then try again.";
  if (error instanceof Error && error.name === "AbortError") return "The server didn't answer within 15 seconds. Check the address, and that the Tohyee computer is on.";
  return "Couldn't reach that address. Check it's typed right, that the Tohyee computer is on, and that the phone trusts its HTTPS certificate (a Tailscale address needs the Tailscale app on and connected).";
}

/** Checks an address end to end: normalise, ask /api/app/identify (15 seconds at most), read the answer. `fetcher` is the browser's fetch. */
export async function checkServerAddress(input: string, fetcher: typeof fetch, options: { online?: boolean; timeoutMs?: number } = {}): Promise<{ ok: true; origin: string; identity: ServerIdentity } | { ok: false; problem: string }> {
  const address = normaliseServerAddress(input);
  if (!address.ok) return address;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000) : null;
  try {
    const response = await fetcher(identifyUrl(address.origin), { method: "GET", headers: { accept: "application/json" }, credentials: "omit", cache: "no-store", redirect: "error", signal: controller?.signal });
    const body = await response.json().catch(() => null);
    const identity = readIdentity(response.status, body);
    return identity.ok ? { ok: true, origin: address.origin, identity: identity.identity } : identity;
  } catch (error) {
    return { ok: false, problem: unreachableText(error, options.online ?? true) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
