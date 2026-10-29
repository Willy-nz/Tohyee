"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { BrandMark } from "@/components/brand-mark";
import { useHydrated } from "@/components/hooks";
import { Button, Notice } from "@/components/ui";
import { OFFLINE_SCREENS, screensMissing } from "@/lib/offline/screens";
import { ALL_INSTALL_GUIDES, BROWSER_NAMES, browserInfo, INSTALL_GUIDE_NAMES, INSTALL_SUPPORT, type InstallGuide, installGuide } from "@/lib/offline/browser";
import { addressKind, type AddressKind, isInstalled, OFFLINE_SESSION_DAYS, registerServiceWorker, tellServiceWorker } from "@/lib/offline/device";
import { AndroidAppSettings, AndroidDownload } from "@/components/android-app";
import { useNativeFeatures } from "@/components/native-app";
import styles from "./get-tohyee.module.css";

/*
 * Get Tohyee on this device (#472, decisions 990-994; #498, decisions
 * 1112-1114): plain steps for the browser and device it's opened on, and
 * for every other one, served by the Tohyee server itself, what works
 * offline, and why a home-network or Tailscale address needs HTTPS.
 */

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

type WorkerStatus = { context: { userId: string; verifiedAt: string | null } | null; pages: string[]; session: { open: boolean; expiresAt: string | null } | null };

function Steps({ children }: { children: ReactNode }) {
  return <ol className={styles.steps}>{children}</ol>;
}

const OPEN_IT = <li>Open Tohyee from its new icon and sign in if asked.</li>;

/**
 * The steps for each browser (#498 item 5, decision 1112). Each one adds
 * Tohyee to the Home Screen (or the computer's app list) as a web app from
 * this server. The Android app (an APK, #502) is offered beside them.
 */
const GUIDES: Record<InstallGuide, () => ReactNode> = {
  "ios-safari": () => (
    <Steps>
      <li>
        Tap the <strong>Share</strong> button (a square with an arrow pointing up), at the bottom of the screen on an iPhone or the top on an iPad. On iOS 26 it&apos;s in the <strong>⋯</strong> menu.
      </li>
      <li>
        Scroll down and tap <strong>Add to Home Screen</strong>. Leave <strong>Open as Web App</strong> on if it&apos;s shown.
      </li>
      <li>
        Leave the name as Tohyee and tap <strong>Add</strong>.
      </li>
      <li>Open Tohyee from its icon and sign in. The icon keeps its sign-in separate from Safari&apos;s, so you sign in once more there.</li>
    </Steps>
  ),
  "ios-other": () => (
    <>
      <p className={styles.text}>From iOS 16.4, Chrome, Edge and Firefox can add Tohyee to the Home Screen too. If you don&apos;t see the option, copy this address into Safari and use the Safari steps.</p>
      <Steps>
        <li>
          Chrome or Edge: tap the <strong>Share</strong> button in the address bar. Firefox: tap the menu (<strong>☰</strong>) › <strong>Share</strong>.
        </li>
        <li>
          Tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
        </li>
        {OPEN_IT}
      </Steps>
    </>
  ),
  "android-chrome": () => (
    <Steps>
      <li>
        Tap <strong>Install</strong> if Chrome offers it, or tap the <strong>⋮</strong> menu › <strong>Add to Home screen</strong> › <strong>Install</strong> (some versions say <strong>Install app</strong>).
      </li>
      <li>
        Tap <strong>Install</strong> to confirm.
      </li>
      {OPEN_IT}
    </Steps>
  ),
  "android-edge": () => (
    <Steps>
      <li>
        Tap the <strong>⋯</strong> menu at the bottom › <strong>Add to phone</strong> (or the install icon in the address bar).
      </li>
      <li>
        Tap <strong>Install</strong> to confirm.
      </li>
      {OPEN_IT}
    </Steps>
  ),
  "android-samsung": () => (
    <Steps>
      <li>
        Tap the install icon in the address bar if it&apos;s shown, or tap the menu (<strong>☰</strong>) › <strong>Add page to</strong> › <strong>Home screen</strong>.
      </li>
      <li>
        Tap <strong>Install</strong> or <strong>Add</strong> to confirm.
      </li>
      {OPEN_IT}
    </Steps>
  ),
  "android-firefox": () => (
    <Steps>
      <li>
        Tap the <strong>⋮</strong> menu (three dots).
      </li>
      <li>
        Tap <strong>Install</strong> (some versions say <strong>Add app to Home screen</strong>). The Add to Home screen panel opens.
      </li>
      <li>
        Drag the icon to where you want it, or tap <strong>Add automatically</strong>.
      </li>
      {OPEN_IT}
    </Steps>
  ),
  "android-opera": () => (
    <Steps>
      <li>
        Tap the menu › <strong>Add to</strong> › <strong>Home screen</strong> (or <strong>Install</strong> if it&apos;s offered).
      </li>
      <li>If there&apos;s no such option, open this address in Chrome or Firefox and use their steps.</li>
    </Steps>
  ),
  "android-other": () => (
    <Steps>
      <li>
        Look in the browser&apos;s menu for <strong>Install</strong>, <strong>Add to Home screen</strong> or <strong>Add page to</strong>.
      </li>
      <li>If there isn&apos;t one, this browser can&apos;t install web apps. Open this address in Chrome, Firefox, Edge or Samsung Internet instead.</li>
    </Steps>
  ),
  "in-app": () => (
    <Steps>
      <li>
        You&apos;re in another app&apos;s built-in browser (a link opened from Facebook, Messenger, Instagram or an email app). It can&apos;t install anything.
      </li>
      <li>
        Use its menu (<strong>⋯</strong> or <strong>⋮</strong>) › <strong>Open in browser</strong> (or <strong>Open in Safari</strong>, <strong>Open in Chrome</strong>), then follow the steps there.
      </li>
    </Steps>
  ),
  "desktop-chromium": () => (
    <Steps>
      <li>
        Click the install icon at the right of the address bar, or open the browser menu › <strong>Cast, save and share</strong> › <strong>Install page as app</strong> (Chrome), or <strong>Apps</strong> › <strong>Install this site as an app</strong> (Edge).
      </li>
      <li>Tohyee opens in its own window, and it&apos;s in your Start menu, Launchpad or app list.</li>
    </Steps>
  ),
  "desktop-firefox-windows": () => (
    <>
      <p className={styles.text}>Firefox on Windows can keep a site on the taskbar from version 143. Not every copy of Firefox has it yet (it isn&apos;t in the Microsoft Store version).</p>
      <Steps>
        <li>
          Click <strong>Add tab to taskbar</strong> at the right of the address bar, if it&apos;s there.
        </li>
        <li>If it isn&apos;t, keep using Tohyee in this tab (everything works), or install it from Chrome or Edge.</li>
      </Steps>
    </>
  ),
  "desktop-firefox": () => (
    <p className={styles.text}>
      Firefox on a Mac or Linux can&apos;t install web apps. That&apos;s a limit of Firefox, not a fault in Tohyee: everything works in this tab. Bookmark it, or install it from Chrome or Edge if you&apos;d like its own window.
    </p>
  ),
  "mac-safari": () => (
    <>
      <p className={styles.text}>Safari on macOS Sonoma (14) or later can add Tohyee to the Dock. Older Safari can&apos;t install web apps: keep using it in the browser, or use Chrome or Edge.</p>
      <Steps>
        <li>
          Choose <strong>File</strong> › <strong>Add to Dock</strong> (or click <strong>Share</strong> › <strong>Add to Dock</strong>).
        </li>
        <li>
          Click <strong>Add</strong>. Tohyee opens from the Dock in its own window.
        </li>
      </Steps>
    </>
  ),
  "desktop-other": () => (
    <Steps>
      <li>
        Look in the browser&apos;s menu for <strong>Install</strong> or <strong>Install app</strong>.
      </li>
      <li>If there isn&apos;t one, this browser can&apos;t install web apps. Tohyee still works in the browser; Chrome and Edge can install it.</li>
    </Steps>
  ),
};

function AddressHelp({ kind, host }: { kind: AddressKind; host: string }) {
  if (kind === "secure") return null;
  return (
    <Notice tone="warning">
      {kind === "tailscale" ? (
        <>
          <strong>{host}</strong> is a Tailscale address without HTTPS. Phones only install Tohyee and keep pages offline on an HTTPS address. Ask whoever looks after the Tohyee computer to turn on HTTPS certificates in Tailscale (admin console › DNS › HTTPS Certificates) and share Tohyee with <code>tailscale serve</code>, then open its <strong>https://….ts.net</strong> address here. It stays private to your tailnet.
        </>
      ) : kind === "lan" ? (
        <>
          <strong>{host}</strong> is a home-network address without HTTPS. Tohyee works here in the browser, but phones only install it and keep pages offline on an HTTPS address. Use your Tohyee web address (Server settings › Remote access) or a Tailscale HTTPS address instead.
        </>
      ) : (
        <>This address doesn&apos;t use HTTPS, so phones won&apos;t install Tohyee from it or keep pages offline. Use your Tohyee web address (it starts with https://).</>
      )}
    </Notice>
  );
}

function OfflineStatus({ status }: { status: WorkerStatus | null }) {
  if (!status?.context) return <p className={styles.text}>Nothing is saved on this device yet. Sign in and open the farm pages once with a connection.</p>;
  const allFarmPages = OFFLINE_SCREENS.length;
  const farmPages = allFarmPages - screensMissing(status.pages).length;
  return (
    <ul className={styles.facts}>
      <li>
        Farm pages saved on this device: <strong>{farmPages}</strong> of {allFarmPages}
      </li>
      {status.context.verifiedAt ? (
        <li>
          Last signed in with a connection: <strong>{new Date(status.context.verifiedAt).toLocaleString("en-NZ", { dateStyle: "medium", timeStyle: "short" })}</strong>
        </li>
      ) : null}
      {status.session?.expiresAt ? (
        <li>
          {status.session.open ? "Opens offline until" : "Locked since"} <strong>{new Date(status.session.expiresAt).toLocaleDateString("en-NZ", { dateStyle: "medium" })}</strong>
          {status.session.open ? "" : ". Sign in with a connection to open it again."}
        </li>
      ) : null}
    </ul>
  );
}

export function GetTohyee() {
  const hydrated = useHydrated();
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installedNow, setInstalledNow] = useState(false);
  const [status, setStatus] = useState<WorkerStatus | null>(null);

  useEffect(() => {
    // Only Chromium browsers fire this. It adds a button; the written steps are always shown too (decision 1112).
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    const onInstalled = () => setInstalledNow(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    void registerServiceWorker().then(() => tellServiceWorker<WorkerStatus>({ type: "status" }).then(setStatus));
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const info = hydrated ? browserInfo(navigator.userAgent, navigator.maxTouchPoints) : null;
  const guide = info ? installGuide(info) : null;
  const kind = hydrated ? addressKind(window.location.href, window.isSecureContext) : "secure";
  const installed = hydrated && (installedNow || isInstalled());
  const origin = hydrated ? window.location.origin : "";
  const host = hydrated ? window.location.host : "";
  const support = guide ? INSTALL_SUPPORT[guide] : null;
  // Inside the Android app (#502): its own settings instead of the install steps.
  const native = useNativeFeatures();

  async function install() {
    if (!prompt) return;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === "accepted") setInstalledNow(true);
    setPrompt(null);
  }

  return (
    <div className={styles.screen}>
      <main className={styles.panel}>
        <div className={styles.brand}>
          <BrandMark size={30} />
          <span>Tohyee</span>
        </div>
        <h1 className={styles.title}>Get Tohyee on this device</h1>
        <p className={styles.text}>
          Put Tohyee on your phone or tablet&apos;s Home Screen as a <strong>web app</strong>. It opens this Tohyee server, {origin ? <strong>{origin}</strong> : "this server"}, with your usual sign-in and what your role lets you use. It isn&apos;t an app-store app: your browser adds it. On Android there&apos;s also an app to download, below.
        </p>

        <AddressHelp kind={kind} host={host} />

        {native.app ? <AndroidAppSettings /> : null}

        {installed && !native.app ? <Notice tone="success">Tohyee is on this device. Open it from its icon.</Notice> : null}

        {info && guide && !installed && !native.app && kind === "secure" ? (
          <section className={styles.section} aria-labelledby="this-device" data-guide={guide}>
            <h2 id="this-device" className={styles.heading}>
              {INSTALL_GUIDE_NAMES[guide]}
            </h2>
            <p className={styles.text}>
              {guide === "in-app" ? "This looks like a link opened inside another app." : `This looks like ${BROWSER_NAMES[info.browser]}${info.os === "ios" ? " on an iPhone or iPad" : info.os === "android" ? " on Android" : " on a computer"}.`} If that&apos;s wrong, the steps for every browser are below.
            </p>
            {prompt ? (
              <Button type="button" onClick={() => void install()} className={styles.big}>
                Install Tohyee
              </Button>
            ) : null}
            {GUIDES[guide]()}
            {support === "no" ? <Notice tone="info">This browser can&apos;t install Tohyee. That&apos;s the browser, not a fault: everything works here in the browser.</Notice> : null}
            {support === "maybe" ? <p className={styles.text}>If you can&apos;t find the option, this browser or its version can&apos;t install web apps. Tohyee still works fully in the browser.</p> : null}
          </section>
        ) : null}

        <section className={styles.section} aria-labelledby="offline">
          <h2 id="offline" className={styles.heading}>
            What works without a connection
          </h2>
          <ul className={styles.facts}>
            <li>The farm pages (Today, Map, Log, Safety, More, tractor mode, and pasture, soil tests, calendar, fertiliser and the notebook) open once you&apos;ve signed in with a connection.</li>
            <li>Every farm you can see is kept on the device by itself, with the last 12 months of records and small copies of photos. Injury and medical details, mail, the books and payroll never are.</li>
            <li>Everything else, including the books, needs a connection to Tohyee.</li>
            <li>
              After {OFFLINE_SESSION_DAYS} days without signing in with a connection, what&apos;s saved on the device is locked until you do. Work waiting to be sent isn&apos;t lost.
            </li>
            <li>Signing out removes the saved pages from this device. Anything not sent yet stays until it&apos;s sent, and you&apos;re asked first.</li>
            <li>What&apos;s on the device is a copy for working away from a signal, not a backup of Tohyee.</li>
            <li>Browsers differ in what a web app can do in the background. None of them records tractor GPS with the screen locked or another app open; the Android app does.</li>
          </ul>
          {hydrated && kind === "secure" ? <OfflineStatus status={status} /> : null}
        </section>

        <details className={styles.section}>
          <summary className={styles.summary}>Why the address must use HTTPS (home network and Tailscale)</summary>
          <ul className={styles.facts}>
            <li>Browsers only install a web app, keep pages for offline use or give a page your location on an HTTPS address (or on the Tohyee computer itself). It&apos;s a browser rule for every website, not a Tohyee setting.</li>
            <li>A home-network address like http://192.168.1.20:3000 works in the browser, but can&apos;t be installed or used offline.</li>
            <li>Tailscale: turn on HTTPS certificates (Tailscale admin console › DNS › HTTPS Certificates) and share Tohyee with <code>tailscale serve</code>. Its https://….ts.net address stays private to your tailnet: nothing is opened to the internet.</li>
            <li>Remote access (a Tohyee web address, or your own Cloudflare tunnel) is already HTTPS.</li>
          </ul>
        </details>

        {native.app ? null : <AndroidDownload origin={kind === "secure" ? origin : ""} />}

        <details className={styles.section} hidden={native.app}>
          <summary className={styles.summary}>Steps for other browsers and devices</summary>
          {ALL_INSTALL_GUIDES.filter((entry) => entry !== guide).map((entry) => (
            <div key={entry}>
              <h3 className={styles.subheading}>{INSTALL_GUIDE_NAMES[entry]}</h3>
              {GUIDES[entry]()}
            </div>
          ))}
        </details>

        <p className={styles.text}>
          <Link href="/operations">Open Tohyee</Link> · <Link href="/login">Sign in</Link>
        </p>
      </main>
    </div>
  );
}
