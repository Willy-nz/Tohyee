"use client";

import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  sendSignal,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import { api, ApiError, errorMessage } from "@/lib/client/api";

/**
 * The browser side of passkeys (#450): asks Tohyee for a challenge, lets the
 * phone or computer make or use the passkey (face, finger or PIN), and sends
 * the answer back. The face or finger never leaves the device.
 */

export { browserSupportsWebAuthn as passkeysSupported, browserSupportsWebAuthnAutofill as passkeyAutofillSupported };

/** The browser's own error, in plain words; null when the person just closed the prompt. */
function passkeyProblem(caught: unknown): string | null {
  if (caught instanceof ApiError) return caught.message;
  const name = caught instanceof Error ? caught.name : "";
  const code = (caught as { code?: string } | null)?.code ?? "";
  if (name === "AbortError" || code === "ERROR_CEREMONY_ABORTED") return null;
  if (name === "NotAllowedError") return null;
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || name === "InvalidStateError") return "This device already has a passkey for your login.";
  if (name === "SecurityError") return "This browser won't use passkeys on this address. Use Tohyee's web address, or localhost on the server computer.";
  return errorMessage(caught);
}

export type PasskeyOutcome = { ok: true } | { ok: false; message: string | null };

/** Signs in with a passkey. `autofill`: wait for the person to pick one from the email box's suggestions. */
export async function signInWithPasskey(autofill = false): Promise<PasskeyOutcome> {
  let optionsJSON: PublicKeyCredentialRequestOptionsJSON;
  try {
    optionsJSON = (await api<{ options: PublicKeyCredentialRequestOptionsJSON }>("/api/auth/passkeys/sign-in/options", { method: "POST" })).options;
  } catch (caught) {
    return { ok: false, message: errorMessage(caught) };
  }
  let response: Awaited<ReturnType<typeof startAuthentication>>;
  try {
    response = await startAuthentication({ optionsJSON, useBrowserAutofill: autofill });
  } catch (caught) {
    return { ok: false, message: passkeyProblem(caught) };
  }
  try {
    await api("/api/auth/passkeys/sign-in", { method: "POST", body: { response } });
    return { ok: true };
  } catch (caught) {
    // A passkey Tohyee no longer has: ask the phone to stop offering it.
    const unknown = caught instanceof ApiError ? (caught.details?.unknownCredential as { rpId?: string; credentialId?: string } | undefined) : undefined;
    if (unknown?.rpId && unknown.credentialId) {
      void sendSignal({ signalName: "unknownCredential", rpID: unknown.rpId, credentialID: unknown.credentialId }).catch(() => undefined);
    }
    return { ok: false, message: errorMessage(caught) };
  }
}

/** Stops a passkey prompt that's waiting (the autofill one), so another can start. */
export function cancelPasskeyPrompt(): void {
  WebAuthnAbortService.cancelCeremony();
}

/** Adds a passkey to your login: the password (or a fresh sign-in) first, then the device's prompt. */
export async function addPasskey(input: { password: string; name: string }): Promise<PasskeyOutcome> {
  let optionsJSON: PublicKeyCredentialCreationOptionsJSON;
  try {
    optionsJSON = (await api<{ options: PublicKeyCredentialCreationOptionsJSON }>("/api/auth/passkeys/options", { method: "POST", body: { password: input.password } })).options;
  } catch (caught) {
    return { ok: false, message: errorMessage(caught) };
  }
  let response: Awaited<ReturnType<typeof startRegistration>>;
  try {
    response = await startRegistration({ optionsJSON });
  } catch (caught) {
    const message = passkeyProblem(caught);
    return { ok: false, message: message ?? "The passkey wasn't made. Try again when you're ready." };
  }
  try {
    await api("/api/auth/passkeys", { method: "POST", body: { response, name: input.name } });
    return { ok: true };
  } catch (caught) {
    return { ok: false, message: errorMessage(caught) };
  }
}
