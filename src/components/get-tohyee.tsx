"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { BrandMark } from "@/components/brand-mark";
import { useHydrated } from "@/components/hooks";
import { Button, Notice } from "@/components/ui";
import { addressKind, type AddressKind, isInstalled, isIosSafari, OFFLINE_SESSION_DAYS, type Platform, platformOf, registerServiceWorker, tellServiceWorker } from "@/lib/offline/device";
import styles from "./get-tohyee.module.css";

/*
 * Get Tohyee on this device (#472, decisions 990-994): plain steps for
 * each kind of device, served by the Tohyee server itself, what works
 * offline, and why a home-network or Tailscale address needs HTTPS.
 */

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

type WorkerStatus = { context: { userId: string; verifiedAt: string | null } | null; pages: string[]; session: { open: boolean; expiresAt: string | null } | null };

const PLATFORM_NAMES: Record<Platform, string> = { iphone: "iPhone", ipad: "iPad", android: "Android phone or tablet", desktop: "Computer" };

function Steps({ children }: { children: ReactNode }) {
  return <ol className={styles.steps}>{children}</ol>;
}

function IosSteps({ device, safari }: { device: "iPhone" | "iPad"; safari: boolean }) {
  return (
    <>
      {safari ? null : <p className={styles.text}>Open this page in Safari first (copy the address into Safari). Other browsers on the {device} can do it too from iOS 16.4, through their own Share button.</p>}
      <Steps>
        <li>
          Tap the <strong>Share</strong> button (a square with an arrow pointing up){device === "iPhone" ? " at the bottom of the screen" : " at the top of the screen"}.
        </li>
        <li>
          Scroll down and tap <strong>Add to Home Screen</strong>.
        </li>
        <li>
          Leave the name as Tohyee and tap <strong>Add</strong>.
        </li>
        <li>Open Tohyee from its icon on the Home Screen and sign in. The {device} keeps the icon&apos;s sign-in separate from Safari&apos;s, so you sign in once more there.</li>
      </Steps>
    </>
  );
}

function AndroidSteps() {
  return (
    <Steps>
      <li>
        In Chrome, tap <strong>Install</strong> when it&apos;s offered, or tap the <strong>⋮</strong> menu and choose <strong>Install app</strong> (some phones say <strong>Add to Home screen</strong>).
      </li>
      <li>
        Tap <strong>Install</strong> to confirm.
      </li>
      <li>Open Tohyee from its icon and sign in if asked.</li>
    </Steps>
  );
}

function DesktopSteps() {
  return (
    <Steps>
      <li>
        In Chrome or Edge, click the install icon at the right of the address bar, or open the browser menu and choose <strong>Install Tohyee</strong> (Edge: <strong>Apps › Install this site as an app</strong>).
      </li>
      <li>Tohyee opens in its own window, and it&apos;s in your Start menu, dock or app list.</li>
    </Steps>
  );
}

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
  const farmPages = status.pages.filter((path) => path.startsWith("/operations/farm")).length;
  const allFarmPages = 6;
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

  const platform = hydrated ? platformOf(navigator.userAgent, navigator.maxTouchPoints) : null;
  const kind = hydrated ? addressKind(window.location.href, window.isSecureContext) : "secure";
  const installed = hydrated && (installedNow || isInstalled());
  const origin = hydrated ? window.location.origin : "";
  const host = hydrated ? window.location.host : "";
  const safari = hydrated ? isIosSafari(navigator.userAgent) : true;
  const others = (["iphone", "android", "desktop"] as const).filter((entry) => entry !== platform && !(platform === "ipad" && entry === "iphone"));

  async function install() {
    if (!prompt) return;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === "accepted") setInstalledNow(true);
    setPrompt(null);
  }

  function stepsFor(entry: Platform) {
    if (entry === "iphone") return <IosSteps device="iPhone" safari={platform === "iphone" ? safari : true} />;
    if (entry === "ipad") return <IosSteps device="iPad" safari={platform === "ipad" ? safari : true} />;
    if (entry === "android") return <AndroidSteps />;
    return <DesktopSteps />;
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
          Put Tohyee on your phone or tablet&apos;s Home Screen. It opens this Tohyee server, {origin ? <strong>{origin}</strong> : "this server"}, with your usual sign-in and what your role lets you use. No app store.
        </p>

        <AddressHelp kind={kind} host={host} />

        {installed ? <Notice tone="success">Tohyee is on this device. Open it from its icon.</Notice> : null}

        {platform && !installed && kind === "secure" ? (
          <section className={styles.section} aria-labelledby="this-device">
            <h2 id="this-device" className={styles.heading}>
              On this {platform === "desktop" ? "computer" : PLATFORM_NAMES[platform]}
            </h2>
            {prompt ? (
              <Button type="button" onClick={() => void install()} className={styles.big}>
                Install Tohyee
              </Button>
            ) : null}
            {stepsFor(platform)}
          </section>
        ) : null}

        <section className={styles.section} aria-labelledby="offline">
          <h2 id="offline" className={styles.heading}>
            What works without a connection
          </h2>
          <ul className={styles.facts}>
            <li>The farm pages (Today, Map, Log, Safety and More) open once you&apos;ve signed in with a connection.</li>
            <li>Every farm you can see is kept on the device by itself, with the last 12 months of records and small copies of photos. Injury and medical details, mail, the books and payroll never are.</li>
            <li>Everything else, including the books, needs a connection to Tohyee.</li>
            <li>
              After {OFFLINE_SESSION_DAYS} days without signing in with a connection, what&apos;s saved on the device is locked until you do. Work waiting to be sent isn&apos;t lost.
            </li>
            <li>Signing out removes the saved pages from this device. Anything not sent yet stays until it&apos;s sent, and you&apos;re asked first.</li>
            <li>What&apos;s on the device is a copy for working away from a signal, not a backup of Tohyee.</li>
          </ul>
          {hydrated && kind === "secure" ? <OfflineStatus status={status} /> : null}
        </section>

        {platform ? (
          <details className={styles.section}>
            <summary className={styles.summary}>Steps for other devices</summary>
            {others.map((entry) => (
              <div key={entry}>
                <h3 className={styles.subheading}>{PLATFORM_NAMES[entry]}</h3>
                {stepsFor(entry)}
              </div>
            ))}
          </details>
        ) : null}

        <p className={styles.text}>
          <Link href="/operations">Open Tohyee</Link> · <Link href="/login">Sign in</Link>
        </p>
      </main>
    </div>
  );
}
