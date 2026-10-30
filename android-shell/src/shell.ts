/*
 * The Android app's first screen, "Your Tohyee address" (#502, decisions
 * 1140-1142). Bundled into android-shell/www/app.js by
 * scripts/build-android-shell.mjs; the checks themselves are
 * src/lib/native/server-address.ts (tested). The address is kept by the
 * app (TohyeeServerPlugin, in Android's own storage for the app), which
 * then opens it.
 */

import { checkServerAddress } from "../../src/lib/native/server-address";

type ServerPlugin = { get: () => Promise<{ url?: string | null; previous?: string | null }>; set: (options: { url: string }) => Promise<void> };

function serverPlugin(): ServerPlugin | null {
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
  const plugin = cap?.Plugins?.TohyeeServer as ServerPlugin | undefined;
  return plugin && typeof plugin.set === "function" ? plugin : null;
}

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function say(text: string, tone: "ok" | "bad" | "info") {
  const status = element<HTMLDivElement>("status");
  status.textContent = text;
  status.dataset.tone = tone;
}

let found: string | null = null;

async function check(event: Event) {
  event.preventDefault();
  const input = element<HTMLInputElement>("address");
  const button = element<HTMLButtonElement>("check");
  element<HTMLDivElement>("found").hidden = true;
  found = null;
  button.disabled = true;
  say("Checking…", "info");
  try {
    const result = await checkServerAddress(input.value, window.fetch.bind(window), { online: navigator.onLine });
    if (!result.ok) {
      say(result.problem, "bad");
      input.focus();
      return;
    }
    found = result.origin;
    input.value = result.origin;
    say(`Found Tohyee at ${result.origin}${result.identity.version ? ` (version ${result.identity.version})` : ""}.`, "ok");
    element<HTMLDivElement>("found").hidden = false;
    element<HTMLButtonElement>("open").focus();
  } finally {
    button.disabled = false;
  }
}

async function open() {
  if (!found) return;
  const plugin = serverPlugin();
  if (!plugin) {
    say("This page is part of the Tohyee app for Android. In a browser, just open the address.", "bad");
    return;
  }
  element<HTMLButtonElement>("open").disabled = true;
  say("Opening Tohyee…", "info");
  try {
    await plugin.set({ url: found });
  } catch (error) {
    element<HTMLButtonElement>("open").disabled = false;
    say(`The address couldn't be kept: ${error instanceof Error ? error.message : String(error)}`, "bad");
  }
}

function start() {
  element<HTMLFormElement>("address-form").addEventListener("submit", (event) => void check(event));
  element<HTMLButtonElement>("open").addEventListener("click", () => void open());
  element<HTMLButtonElement>("again").addEventListener("click", () => {
    element<HTMLDivElement>("found").hidden = true;
    found = null;
    const input = element<HTMLInputElement>("address");
    input.value = "";
    input.focus();
    say("", "info");
  });
  // Changing the address: the last one is filled in.
  void serverPlugin()
    ?.get()
    .then((saved) => {
      const last = saved?.url ?? saved?.previous;
      if (last) element<HTMLInputElement>("address").value = last;
    })
    .catch(() => undefined);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
