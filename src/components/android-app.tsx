"use client";

import { useEffect, useState } from "react";
import { useNativeFeatures } from "@/components/native-app";
import { Button, Notice, ui } from "@/components/ui";
import { callNative } from "@/lib/native/bridge";
import { DEVICE_REMINDER_KINDS, DEVICE_REMINDER_LABELS } from "@/lib/native/reminders-shared";
import { askNotificationPermission, cancelReminders, notificationPermission, refreshDeviceReminders, remindersOn, setRemindersOn } from "@/lib/native/notifications";
import styles from "./get-tohyee.module.css";

/*
 * The Android app on Get Tohyee on this device (#502, decisions 1150-1151):
 * in a browser, how to download and install it; inside the app, its
 * settings (the Tohyee address, and reminders on this phone).
 */

/** Where the APK is published: each release's files on GitHub (attached by .github/workflows/android-app.yml). */
export const ANDROID_RELEASES_URL = "https://github.com/Willy-nz/Tohyee/releases/latest";

/** How to install the APK, in a browser. Shown beside the home-screen web app, never instead of it. */
export function AndroidDownload({ origin }: { origin: string }) {
  return (
    <section className={styles.section} aria-labelledby="android-app">
      <h2 id="android-app" className={styles.heading}>
        Android: download the app (optional)
      </h2>
      <p className={styles.text}>
        The Tohyee app for Android opens your own Tohyee server, like the home-screen web app, and adds three things a browser can&apos;t: <strong>tractor mode keeps recording with the screen locked</strong>, <strong>reminders as notifications</strong> on the phone (shift the pods, read the pond, safety actions due, the aerial photos key), and the phone&apos;s own <strong>camera and photo picker</strong>. It isn&apos;t on the Play Store yet: it&apos;s a file (an APK) you download from Tohyee&apos;s releases on GitHub.
      </p>
      <p className={styles.text}>
        <a className={`${ui.button} ${ui.primary} ${styles.big}`} href={ANDROID_RELEASES_URL} target="_blank" rel="noreferrer">
          Download the app (Tohyee&apos;s releases on GitHub)
        </a>
      </p>
      <ol className={styles.steps}>
        <li>
          On the Android phone, open the link above and, under <strong>Assets</strong>, tap <strong>Tohyee-</strong>
          <em>version</em>
          <strong>.apk</strong>. (A file ending <strong>-test.apk</strong> is a test build: see below.)
        </li>
        <li>
          When it&apos;s downloaded, tap <strong>Open</strong> (or find it in <strong>Files</strong> › <strong>Downloads</strong>).
        </li>
        <li>
          Android says something like <em>&quot;For your security, your phone currently isn&apos;t allowed to install unknown apps from this source&quot;</em>. Tap <strong>Settings</strong>, turn on <strong>Allow from this source</strong>, then go back and tap <strong>Install</strong>.
        </li>
        <li>
          If <strong>Google Play Protect</strong> warns about an app it doesn&apos;t know, tap <strong>More details</strong> › <strong>Install anyway</strong>, once you&apos;re sure the file came from Tohyee&apos;s GitHub releases.
        </li>
        <li>
          Open Tohyee, type your Tohyee address{origin ? (
            <>
              {" "}
              (<strong>{origin}</strong>)
            </>
          ) : null}{" "}
          and tap <strong>Check</strong>, then <strong>Open Tohyee</strong> and sign in.
        </li>
        <li>
          Afterwards you can turn <strong>Allow from this source</strong> off again for the browser (Settings › Apps › Special app access › Install unknown apps).
        </li>
      </ol>
      <details className={styles.section}>
        <summary className={styles.summary}>What Android&apos;s warnings mean</summary>
        <ul className={styles.facts}>
          <li>&quot;Unknown apps&quot; means any app that doesn&apos;t come from the Play Store. Android asks you to allow each app that installs them (here, your browser), so a website can&apos;t install something without you saying so.</li>
          <li>Play Protect&apos;s warning means Google hasn&apos;t checked this app, because it isn&apos;t on the Play Store. It doesn&apos;t mean Google found something wrong with it. Tohyee is open source: anyone can read the code it&apos;s built from.</li>
          <li>Each release lists a <strong>.sha256</strong> file next to the app: the fingerprint of the exact file, if you want to check your download wasn&apos;t changed.</li>
          <li>A <strong>-test.apk</strong> is built without Tohyee&apos;s signing key, for trying things out. It installs as &quot;Tohyee (test)&quot; beside the real app and can&apos;t be updated to it.</li>
          <li>To update, download the newer APK and install it over the old one. Your address and what&apos;s saved on the phone stay.</li>
        </ul>
      </details>
      <p className={styles.text}>The app needs an HTTPS address, like the web app. Not yet tried on a real Android phone: it was built and checked automatically.</p>
    </section>
  );
}

type Session = { organisations?: Array<{ id: string }> };

/** Inside the app: the address it opens, changing it, and reminders on this phone. */
export function AndroidAppSettings() {
  const native = useNativeFeatures();
  const [on, setOn] = useState(false);
  const [permission, setPermission] = useState<"granted" | "denied" | "prompt" | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "warning" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!native.app) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from this phone
    setOn(remindersOn());
    void notificationPermission().then(setPermission);
  }, [native.app]);

  if (!native.app) return null;

  const refresh = async (): Promise<number | null> => {
    const session = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<Session>) : null))
      .catch(() => null);
    if (!session?.organisations) return null;
    return refreshDeviceReminders(session.organisations.map((organisation) => organisation.id));
  };

  const turnOn = async () => {
    setExplaining(false);
    setBusy(true);
    try {
      const allowed = (await notificationPermission()) === "granted" || (await askNotificationPermission());
      setPermission(await notificationPermission());
      if (!allowed) {
        setMessage({ tone: "warning", text: "Notifications aren't allowed for Tohyee, so reminders can't show. Allow them in the phone's Settings › Apps › Tohyee › Notifications, then turn this on again." });
        return;
      }
      setRemindersOn(true);
      setOn(true);
      const count = await refresh();
      setMessage(count === null ? { tone: "warning", text: "Reminders are on. Tohyee couldn't be reached just now: they're set up next time it opens with a connection." } : { tone: "success", text: count ? `Reminders are on: ${count} coming up in the next two weeks are set on this phone.` : "Reminders are on. Nothing's due in the next two weeks yet; new ones are added each time Tohyee opens." });
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setRemindersOn(false);
    setOn(false);
    await cancelReminders();
    setMessage({ tone: "success", text: "Reminders are off. None are left on this phone." });
  };

  return (
    <section className={styles.section} aria-labelledby="this-app">
      <h2 id="this-app" className={styles.heading}>
        The Tohyee app on this phone
      </h2>
      <p className={styles.text}>
        This app opens <strong>{typeof window !== "undefined" ? window.location.origin : "your Tohyee server"}</strong>. Links to other websites open in the phone&apos;s browser.
      </p>
      {native.changeAddress ? (
        <p className={styles.text}>
          <Button type="button" variant="secondary" onClick={() => void callNative("TohyeeServer", "clear")}>
            Change Tohyee address
          </Button>{" "}
          Goes back to the first screen. What&apos;s saved on the phone for this address stays, for when you come back to it.
        </p>
      ) : null}
      {native.notifications ? (
        <div>
          <h3 className={styles.subheading}>Reminders on this phone</h3>
          <p className={styles.text}>Notifications from your reminders, worked out by Tohyee and set on this phone each time it opens. No push server; they come without a signal too.</p>
          <ul className={styles.facts}>
            {DEVICE_REMINDER_KINDS.map((kind) => (
              <li key={kind}>{DEVICE_REMINDER_LABELS[kind]}</li>
            ))}
          </ul>
          <p className={styles.text}>Times are when the run says to shift; days are told at 7 am. What&apos;s already due is on Today rather than notified. They&apos;re taken off the phone when you sign out.</p>
          {permission === "denied" ? <Notice tone="warning">Notifications are blocked for Tohyee. Allow them in the phone&apos;s Settings › Apps › Tohyee › Notifications.</Notice> : null}
          {explaining ? (
            <Notice tone="info">
              Android will ask whether Tohyee may send notifications. Tohyee uses them only for these reminders and the tractor recording notice.{" "}
              <Button type="button" size="small" disabled={busy} onClick={() => void turnOn()}>
                Continue
              </Button>{" "}
              <Button type="button" size="small" variant="secondary" onClick={() => setExplaining(false)}>
                Not now
              </Button>
            </Notice>
          ) : (
            <Button type="button" variant={on ? "secondary" : undefined} disabled={busy} aria-pressed={on} onClick={() => (on ? void turnOff() : permission === "granted" ? void turnOn() : setExplaining(true))}>
              {on ? "Turn reminders off" : "Turn reminders on"}
            </Button>
          )}
          {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        </div>
      ) : null}
    </section>
  );
}
