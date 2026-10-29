"use client";

import Link from "next/link";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useHydrated } from "@/components/hooks";
import { Button } from "@/components/ui";
import { accuracyQuality, canAsk, GPS_PRIVATE_NOTE, GPS_START, GPS_TIMEOUT_MS, type GpsFix, gpsMessage, gpsReducer, type GpsState, restoreSteps } from "@/lib/location/gps";
import { BROWSER_NAMES, browserInfo, type BrowserInfo } from "@/lib/offline/browser";
import { isInstalled } from "@/lib/offline/device";
import styles from "./gps-control.module.css";

/*
 * Use my location (#498 item 6, decisions 1115-1118), for every map: one
 * button that's always there, what the location is up to (not asked,
 * allowed, blocked, unavailable, timed out), the accuracy, and after a
 * block the steps for this browser and Check again. The map works without
 * it. It only moves the map on this device: nothing is sent.
 *
 * Reusable: `useGps()` holds the state; `GpsButton` and `GpsStatus` show it
 * (a map puts the button in its own controls), or `GpsControl` shows both.
 */

export type Gps = {
  state: GpsState;
  /** Ask the browser for one position (does nothing while blocked: see `checkAgain`). */
  locate: () => void;
  /** After a block: ask the Permissions API again, and locate if it's now allowed. */
  checkAgain: () => void;
  browser: BrowserInfo | null;
  /** True after Check again found it still blocked. */
  stillBlocked: boolean;
};

type Permissions = { query: (descriptor: { name: "geolocation" }) => Promise<PermissionStatus> };

function permissionsApi(): Permissions | null {
  const permissions = (typeof navigator !== "undefined" ? navigator.permissions : undefined) as Permissions | undefined;
  return permissions && typeof permissions.query === "function" ? permissions : null;
}

/** `onFix` runs with each new position (a map centres on it). `initial` is what's already known (tractor mode knows it was blocked). */
export function useGps(onFix?: (fix: GpsFix) => void, initial: GpsState = GPS_START): Gps {
  const [state, dispatch] = useReducer(gpsReducer, initial);
  const [stillBlocked, setStillBlocked] = useState(false);
  const hydrated = useHydrated();
  const fixHandler = useRef(onFix);
  useEffect(() => {
    fixHandler.current = onFix;
  }, [onFix]);

  // What the browser can do, and the permission it already has (so a block shows straight away, not only after a tap).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.isSecureContext) return dispatch({ type: "unsupported", reason: "insecure" });
    if (!("geolocation" in navigator)) return dispatch({ type: "unsupported", reason: "no_api" });
    const permissions = permissionsApi();
    if (!permissions) return;
    let status: PermissionStatus | null = null;
    let cancelled = false;
    const changed = () => {
      if (status) dispatch({ type: "permission", state: status.state, at: Date.now() });
    };
    permissions
      .query({ name: "geolocation" })
      .then((result) => {
        if (cancelled) return;
        status = result;
        // "prompt" on first load says nothing new; only "granted" and "denied" change what's shown.
        if (result.state !== "prompt") changed();
        result.addEventListener("change", changed);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      status?.removeEventListener("change", changed);
    };
  }, []);

  const ask = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return dispatch({ type: "unsupported", reason: "no_api" });
    dispatch({ type: "ask" });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const fix: GpsFix = { lon: position.coords.longitude, lat: position.coords.latitude, accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null, at: position.timestamp || Date.now() };
        setStillBlocked(false);
        dispatch({ type: "fix", fix });
        fixHandler.current?.(fix);
      },
      (error) => dispatch({ type: "error", code: error.code, at: Date.now() }),
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 10_000 },
    );
  }, []);

  const locate = useCallback(() => {
    if (canAsk(state)) ask();
  }, [state, ask]);

  const checkAgain = useCallback(() => {
    const permissions = permissionsApi();
    if (!permissions) {
      // No Permissions API (older Safari): one quiet try. A browser that still blocks it answers "denied" at once, without asking.
      setStillBlocked(true);
      ask();
      return;
    }
    permissions
      .query({ name: "geolocation" })
      .then((result) => {
        dispatch({ type: "permission", state: result.state, at: Date.now() });
        if (result.state === "denied") return setStillBlocked(true);
        setStillBlocked(false);
        ask();
      })
      .catch(() => ask());
  }, [ask]);

  const browser = hydrated ? browserInfo(navigator.userAgent, navigator.maxTouchPoints) : null;
  return { state, locate, checkAgain, browser, stillBlocked };
}

function Crosshair() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden focusable="false">
      <circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
      <path d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** The button. Always shown, whatever the state: blocked, it opens the steps instead of asking. */
export function GpsButton({ gps, className, label = "Use my location", onShowHelp }: { gps: Gps; className?: string; label?: string; onShowHelp?: () => void }) {
  const { state } = gps;
  const asking = state.status === "asking";
  const blocked = state.status === "denied";
  return (
    <button
      type="button"
      className={className ?? styles.button}
      aria-busy={asking || undefined}
      data-gps={state.status}
      onClick={() => {
        if (blocked || (state.status === "unavailable" && state.reason !== "no_fix")) onShowHelp?.();
        else gps.locate();
      }}
    >
      <Crosshair />
      <span>{asking ? "Finding you…" : blocked ? "Location blocked: how to fix" : state.status === "granted" && state.fix ? "Centre on me" : label}</span>
    </button>
  );
}

/** What the location is up to, under the map. Blocked: this browser's steps to allow it, and Check again. */
export function GpsStatus({ gps, id, showWhenIdle = false }: { gps: Gps; id?: string; showWhenIdle?: boolean }) {
  const { state, browser } = gps;
  const [now, setNow] = useState(() => Date.now());
  const fix = state.status === "granted" ? state.fix : null;
  // The age of the fix keeps counting, so an old position never reads as "just now".
  useEffect(() => {
    if (!fix) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [fix]);
  if (state.status === "not_asked" && !showWhenIdle) return null;
  const tone = state.status === "denied" || state.status === "timed_out" || state.status === "unavailable" ? "warning" : "info";
  const shownAt = fix ? Math.max(now, fix.at) : now;
  return (
    <div id={id} className={styles.status} data-tone={tone} role="status" aria-live="polite">
      <p className={styles.message}>
        {fix ? <span className={styles.dot} data-quality={accuracyQuality(fix.accuracy)} aria-hidden /> : null}
        {gpsMessage(state, shownAt)}
      </p>
      {state.status === "granted" || state.status === "asking" ? <p className={styles.note}>{GPS_PRIVATE_NOTE}</p> : null}
      {state.status === "denied" ? (
        <div className={styles.help}>
          <p className={styles.helpTitle}>To let Tohyee use your location{browser ? ` in ${browserLabel(browser)}` : ""}:</p>
          <ol className={styles.steps}>
            {restoreSteps(browser ?? { os: "other", browser: "other" }, typeof window !== "undefined" && isInstalled()).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <div className={styles.row}>
            <Button type="button" variant="secondary" size="small" onClick={gps.checkAgain}>
              Check again
            </Button>
            {gps.stillBlocked ? <span className={styles.note}>Still blocked. Change the setting above first; some browsers need the page reloaded.</span> : null}
          </div>
          <p className={styles.note}>Tohyee doesn&apos;t ask again by itself: once it&apos;s blocked, the browser says no without asking.</p>
        </div>
      ) : null}
      {state.status === "unavailable" && state.reason === "insecure" ? (
        <p className={styles.note}>
          <Link href="/get-tohyee">Why an HTTPS address is needed</Link>
        </p>
      ) : null}
      {state.status === "timed_out" || (state.status === "unavailable" && state.reason === "no_fix") ? (
        <div className={styles.row}>
          <Button type="button" variant="secondary" size="small" onClick={gps.locate}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function browserLabel(info: BrowserInfo): string {
  const where = info.os === "ios" ? " on iPhone or iPad" : info.os === "android" ? " on Android" : "";
  return `${BROWSER_NAMES[info.browser]}${where}`;
}

/** The button and the status together, for a screen without its own map controls (tractor mode's start). */
export function GpsControl({ gps, label, idleText }: { gps: Gps; label?: string; idleText?: string }) {
  const statusId = "gps-status";
  return (
    <div className={styles.control}>
      <GpsButton gps={gps} label={label} onShowHelp={() => document.getElementById(statusId)?.scrollIntoView({ block: "nearest" })} />
      {gps.state.status === "not_asked" && idleText ? <p className={styles.note}>{idleText}</p> : null}
      <GpsStatus gps={gps} id={statusId} />
    </div>
  );
}
