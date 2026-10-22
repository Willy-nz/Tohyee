"use client";

import { OFFICE_API_PATH, OFFICE_CLIENT_PATH, OFFICE_SIGNED_IN_PATH } from "@/lib/office/paths";
import type { OfficeDialog, OfficeGlobal } from "@/lib/office/client/office-js";

/*
 * The PowerPoint add-in's sign-in (#429, decisions 834, 842): OAuth 2.1 with
 * PKCE against Tohyee's own sign-in (#427), opened in Office's dialog
 * because Tohyee's sign-in page can't be framed. The dialog starts at
 * /oauth/authorize on this same address (Office requires the first page to
 * be on the add-in's own domain), goes through Tohyee's normal sign-in
 * (password and two-step, or Google) and the consent screen, and ends on
 * /office/powerpoint/signed-in, which hands the code back with
 * messageParent. The slide swaps it for tokens itself.
 *
 * Tokens are kept in this computer's browser storage for the add-in, never
 * in the presentation: with Office's partition key where Office gives one
 * (Office on the web), so they're only for this add-in in this place. That
 * keeps people signed in from one PowerPoint session to the next (refresh
 * tokens last 60 days while used). Refresh tokens are replaced every time
 * they're used and a reused one ends the sign-in (decision 815), so two
 * slides refreshing at once mustn't both use the same one: refreshing is
 * done under a Web Lock, re-reading storage first, so the second slide
 * picks up the first slide's new tokens instead.
 */

export type StoredTokens = { access: string; accessExpiresAt: number; refresh: string };

/** Where tokens are kept: per Office partition (when there is one) and per Tohyee server. */
export function tokenStorageKey(partitionKey: string | undefined, origin: string): string {
  return `${partitionKey ?? ""}tohyee.office.tokens:${origin}`;
}

export function parseStoredTokens(raw: string | null): StoredTokens | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.access !== "string" || typeof value.refresh !== "string" || typeof value.accessExpiresAt !== "number") return null;
    if (!/^tohyee_at_[A-Za-z0-9_-]{43}$/.test(value.access) || !/^tohyee_rt_[A-Za-z0-9_-]{43}$/.test(value.refresh)) return null;
    return { access: value.access, refresh: value.refresh, accessExpiresAt: value.accessExpiresAt };
  } catch {
    return null;
  }
}

/** An access token is renewed a minute before it runs out. */
export function accessStillGood(tokens: StoredTokens, now = Date.now()): boolean {
  return tokens.accessExpiresAt - 60_000 > now;
}

function base64Url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomText(bytes = 32): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return base64Url(values);
}

async function challengeFor(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export class SignedOutError extends Error {
  constructor(message = "Sign in to Tohyee to see live data.") {
    super(message);
  }
}

type Listener = (signedIn: boolean) => void;

export class OfficeAuth {
  private readonly origin: string;
  private readonly key: string;
  private memory: StoredTokens | null = null;
  private listeners = new Set<Listener>();

  constructor(
    private readonly office: OfficeGlobal | null,
    origin = window.location.origin,
  ) {
    this.origin = origin;
    this.key = tokenStorageKey(office?.context.partitionKey, origin);
    this.memory = this.read();
  }

  get clientId(): string {
    return `${this.origin}${OFFICE_CLIENT_PATH}`;
  }

  get redirectUri(): string {
    return `${this.origin}${OFFICE_SIGNED_IN_PATH}`;
  }

  get resource(): string {
    return `${this.origin}${OFFICE_API_PATH}`;
  }

  signedIn(): boolean {
    return this.memory !== null;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener(this.memory !== null);
  }

  private read(): StoredTokens | null {
    try {
      return parseStoredTokens(window.localStorage.getItem(this.key));
    } catch {
      return this.memory;
    }
  }

  private write(tokens: StoredTokens | null) {
    this.memory = tokens;
    try {
      if (tokens) window.localStorage.setItem(this.key, JSON.stringify(tokens));
      else window.localStorage.removeItem(this.key);
    } catch {
      // Storage refused (a private window): the sign-in lasts while the slide is open.
    }
    this.emit();
  }

  private async tokenRequest(values: Record<string, string>): Promise<StoredTokens> {
    const response = await fetch(`${this.origin}/api/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...values, client_id: this.clientId, resource: this.resource }).toString(),
      credentials: "omit",
      cache: "no-store",
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok && response.status !== 400 && response.status !== 401) throw new Error("Tohyee is busy or can't be reached. Try again in a minute.");
    if (!response.ok || typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
      throw new SignedOutError(typeof body.error_description === "string" ? body.error_description : "Signing in didn't work. Try again.");
    }
    const seconds = typeof body.expires_in === "number" ? body.expires_in : 3600;
    return { access: body.access_token, refresh: body.refresh_token, accessExpiresAt: Date.now() + seconds * 1000 };
  }

  /**
   * Opens Tohyee's sign-in in Office's dialog and waits for it. Resolves
   * when signed in; rejects with a message to show when it didn't work or
   * was closed.
   */
  async signIn(): Promise<void> {
    if (!this.office) throw new Error("Open this in PowerPoint to sign in.");
    const verifier = randomText(48);
    const state = randomText(16);
    const authorize = new URL(`${this.origin}/oauth/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", this.clientId);
    authorize.searchParams.set("redirect_uri", this.redirectUri);
    authorize.searchParams.set("code_challenge", await challengeFor(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("resource", this.resource);
    const office = this.office;
    const message = await new Promise<Record<string, unknown>>((resolve, reject) => {
      office.context.ui.displayDialogAsync(authorize.toString(), { height: 70, width: 40, promptBeforeOpen: false }, (result) => {
        if (result.status !== "succeeded") {
          reject(new Error(result.error?.code === 12009 ? "PowerPoint blocked the sign-in window. Allow pop-ups for this add-in and try again." : "PowerPoint couldn't open the sign-in window. Try again."));
          return;
        }
        const dialog: OfficeDialog = result.value;
        dialog.addEventHandler(office.EventType.DialogMessageReceived, (event) => {
          // Only our own signed-in page may answer (it's on this same address).
          if (event.origin && event.origin !== this.origin) return;
          dialog.close();
          try {
            resolve(JSON.parse(event.message ?? "{}") as Record<string, unknown>);
          } catch {
            reject(new Error("The sign-in window sent something unexpected. Try again."));
          }
        });
        dialog.addEventHandler(office.EventType.DialogEventReceived, () => reject(new Error("The sign-in window was closed before you finished signing in.")));
      });
    });
    if (message.type !== "tohyee-sign-in" || message.state !== state) throw new Error("That sign-in wasn't for this slide. Try again.");
    if (typeof message.error === "string") throw new Error(message.error === "access_denied" ? "You chose not to allow the add-in." : "Signing in didn't finish. Try again.");
    if (typeof message.code !== "string") throw new Error("Signing in didn't finish. Try again.");
    this.write(await this.tokenRequest({ grant_type: "authorization_code", code: message.code, redirect_uri: this.redirectUri, code_verifier: verifier }));
  }

  /** A working access token, refreshed when it's about to run out; SignedOutError when the sign-in has ended. */
  async accessToken(force = false): Promise<string> {
    const current = this.read() ?? this.memory;
    if (!current) {
      if (this.memory) this.write(null);
      throw new SignedOutError();
    }
    if (!force && accessStillGood(current)) return current.access;
    const refresh = async (): Promise<string> => {
      // Another slide may have refreshed while this one waited for the lock: use its tokens.
      const latest = this.read() ?? this.memory;
      if (!latest) throw new SignedOutError();
      if (latest.refresh !== current.refresh && accessStillGood(latest)) {
        this.memory = latest;
        return latest.access;
      }
      try {
        const next = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: latest.refresh });
        this.write(next);
        return next.access;
      } catch (error) {
        // Refused: the sign-in has ended. Offline or the server busy: keep it and try again later.
        if (!(error instanceof SignedOutError)) throw error;
        this.write(null);
        throw new SignedOutError("Your sign-in to Tohyee has ended. Sign in again to see live data.");
      }
    };
    const locks = (navigator as Navigator & { locks?: { request<T>(name: string, work: () => Promise<T>): Promise<T> } }).locks;
    return locks ? locks.request(`tohyee-office-refresh:${this.origin}`, refresh) : refresh();
  }

  /** A request to the Analytics API for Office with the token; one retry with a fresh token after a 401. */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const send = async (token: string) =>
      fetch(`${this.origin}${path}`, { ...init, credentials: "omit", cache: "no-store", headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });
    let response = await send(await this.accessToken());
    if (response.status === 401) {
      response = await send(await this.accessToken(true));
      if (response.status === 401) {
        this.write(null);
        throw new SignedOutError("Your sign-in to Tohyee has ended. Sign in again to see live data.");
      }
    }
    return response;
  }

  /** Signs out on this computer and ends the sign-in on the server (RFC 7009). */
  async signOut(): Promise<void> {
    const current = this.read() ?? this.memory;
    this.write(null);
    if (!current) return;
    try {
      await fetch(`${this.origin}/api/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: current.refresh, client_id: this.clientId }).toString(),
        credentials: "omit",
      });
    } catch {
      // Offline: it ends by itself after 60 days unused, or from Your account in Tohyee.
    }
  }
}
