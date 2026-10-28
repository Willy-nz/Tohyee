"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, todayInBrowser } from "@/lib/format";
import type { FarmingSettings } from "@/lib/farming/paddocks";
import { keyAge, LINZ_BASEMAPS_URL, OFFLINE_MAX_BYTES, OFFLINE_MAX_TILES, OFFLINE_MAX_ZOOM, OFFLINE_MIN_ZOOM, STANDARD_KEY_DAYS } from "@/lib/farming/imagery";
import { checkImageryKey, type KeyCheck, keepFarmTiles, readTileSummary, removeFarmTiles, subscribeTiles, tilesProgress, tilesVersion, type TileSummary } from "@/lib/farming/imagery-device";
import styles from "./farm-imagery.module.css";

/*
 * Aerial photos on the farm maps (#485, decisions 1060-1066): the guided
 * key setup, the 80-day reminder, the map's notes when there's no key or
 * the photos stop loading, and the photos kept on this device.
 */

/** Where the key is pasted: the Settings card. */
export const AERIAL_PHOTOS_SETTINGS = "/operations/settings#aerial-photos";

/** The organisation's farming settings (the key and when it was saved). */
export function useFarmingSettings(organisationId: string, enabled = true) {
  return useApiData<{ settings: FarmingSettings }>(enabled ? "/api/farming/settings" : null, { organisationId });
}

/** The three steps, in the Settings card and wherever the photos stop loading (decision 1060). */
export function KeySteps({ pasteHere }: { pasteHere: React.ReactNode }) {
  return (
    <ol className={styles.steps}>
      <li>
        <strong>Open LINZ Basemaps</strong> in a new tab. It&apos;s free and needs no sign-up.
        <span className={styles.open}>
          <a href={LINZ_BASEMAPS_URL} target="_blank" rel="noreferrer" className={`${ui.button} ${ui.secondary}`}>
            Open LINZ Basemaps<span className={styles.visuallyHidden}> (opens in a new tab)</span>
          </a>
        </span>
      </li>
      <li>
        <strong>Copy the &quot;API Key&quot; box.</strong> On the LINZ Basemaps page, open its menu and find the box labelled <em>API Key</em>: a long line of letters and numbers. Copy all of it (the copy button beside it does that).
      </li>
      <li>
        <strong>Paste it here.</strong> {pasteHere}
      </li>
    </ol>
  );
}

function checkMessage(check: KeyCheck): string {
  if (check.ok) return "Aerial photos are on.";
  if (check.reason === "offline") return "This device has no connection, so the key couldn't be checked.";
  if (check.reason === "refused") return "LINZ didn't accept that key. Check you copied all of it, or copy a new one from LINZ Basemaps.";
  return "The test photo from LINZ didn't load. Check you copied the whole key and that this device can reach basemaps.linz.govt.nz.";
}

/** The key's age in words, with the reminder from day 80 (decision 1061). */
function KeyAgeNotice({ savedOn, check }: { savedOn: string | null; check: KeyCheck | null }) {
  const age = keyAge(savedOn, todayInBrowser());
  if (!age) return null;
  if (age.stage === "fine") return <p className={ui.muted}>Saved {formatDate(age.savedOn)}. A standard LINZ key lasts {STANDARD_KEY_DAYS} days: Tohyee reminds you from {formatDate(age.remindOn)}.</p>;
  if (age.stage === "expired" && check?.ok) return <p className={ui.muted}>Saved {formatDate(age.savedOn)}, more than {STANDARD_KEY_DAYS} days ago, and it still works (it may be a developer key, which doesn&apos;t run out).</p>;
  return (
    <Notice tone="warning">
      {age.stage === "remind"
        ? `This key was saved on ${formatDate(age.savedOn)}. A standard LINZ key lasts ${STANDARD_KEY_DAYS} days, so it runs out about ${formatDate(age.expiresOn)} (${age.daysLeft} day${age.daysLeft === 1 ? "" : "s"} left). Get a new one with the steps below.`
        : `This key was saved on ${formatDate(age.savedOn)}, more than ${STANDARD_KEY_DAYS} days ago, so a standard key has run out. Get a new one with the steps below.`}{" "}
      A developer key doesn&apos;t run out: if yours is one, you can ignore this.
    </Notice>
  );
}

/**
 * The guided key setup (#485): the three steps, then Tohyee checks the key
 * in this browser by loading one photo before saving it. Admins.
 */
export function AerialPhotosCard({ organisationId, settings, onSaved }: { organisationId: string; settings: FarmingSettings; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ check: KeyCheck; saved: boolean } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [current, setCurrent] = useState<KeyCheck | null>(null);
  const { user } = useWorkspace();
  const imageryKey = settings.imageryKey;
  const stage = keyAge(settings.imageryKeySavedOn, todayInBrowser())?.stage ?? null;

  // From day 80 the saved key is checked once here, so a key that still works past 90 days isn't nagged about.
  useEffect(() => {
    if (!imageryKey || stage === "fine") return;
    let cancelled = false;
    void checkImageryKey(imageryKey).then((check) => {
      if (!cancelled) setCurrent(check);
    });
    return () => {
      cancelled = true;
    };
  }, [imageryKey, stage]);

  async function save(value: string | null) {
    setBusy("save");
    setError(null);
    try {
      await api("/api/farming/settings", { method: "PATCH", body: { organisationId, imageryKey: value } });
      if (value === null) await removeFarmTiles({ server: window.location.origin, userId: user.id, organisationId }).catch(() => undefined);
      setKey("");
      setPending(null);
      onSaved();
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function checkAndSave() {
    const value = key.trim();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
      setError("That doesn't look like a LINZ key: it's one long line of letters and numbers, with no spaces. Copy the whole API Key box again.");
      return;
    }
    setBusy("check");
    setError(null);
    setResult(null);
    const check = await checkImageryKey(value);
    setBusy(null);
    if (check.ok) {
      const saved = await save(value);
      setResult({ check, saved });
      if (saved) setCurrent(check);
    } else {
      setResult({ check, saved: false });
      setPending(value);
    }
  }

  return (
    <div id="aerial-photos" className={styles.anchor}>
      <Card
        title="Aerial photos for farm maps"
        description="Free aerial photos from LINZ (Toitū Te Whenua) behind your paddocks. Each organisation uses its own free key from LINZ Basemaps: it takes about a minute."
        actions={imageryKey ? <Badge tone={current && !current.ok ? "amber" : "green"}>{current && !current.ok ? "Not loading" : "On"}</Badge> : <Badge tone="neutral">Off</Badge>}
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        {result ? <Notice tone={result.check.ok && result.saved ? "success" : "warning"}>{checkMessage(result.check)}</Notice> : null}
        {pending ? (
          <div className={ui.actions}>
            <Button variant="secondary" disabled={busy !== null} onClick={() => void save(pending).then((saved) => saved && setResult({ check: { ok: false, reason: "failed" }, saved: true }))}>
              Save it anyway
            </Button>
            <span className={ui.muted}>Only if you&apos;re sure it&apos;s right: the maps will say if the photos don&apos;t load.</span>
          </div>
        ) : null}
        {imageryKey ? (
          <>
            <p>
              Aerial photos are set up with a key ending <strong>{imageryKey.slice(-4)}</strong>.
            </p>
            {current && !current.ok ? <Notice tone="warning">{checkMessage(current)}</Notice> : null}
            <KeyAgeNotice savedOn={settings.imageryKeySavedOn} check={current} />
          </>
        ) : null}
        <KeySteps
          pasteHere={
            <span className={styles.paste}>
              <Field label={imageryKey ? "New LINZ API key" : "LINZ API key"}>
                <input value={key} autoComplete="off" spellCheck={false} maxLength={200} onChange={(event) => setKey(event.target.value)} onPaste={() => setResult(null)} />
              </Field>
              <Button disabled={busy !== null || !key.trim()} onClick={() => void checkAndSave()}>
                {busy === "check" ? "Checking with LINZ…" : busy === "save" ? "Saving…" : "Check and save"}
              </Button>
            </span>
          }
        />
        {imageryKey ? (
          <div className={ui.actions}>
            <Button variant="secondary" disabled={busy !== null} onClick={() => void save(null)}>
              Turn aerial photos off
            </Button>
          </div>
        ) : null}
        <p className={ui.muted}>
          Photos load in each person&apos;s browser straight from LINZ, so anyone who can see the map can see the key. Tohyee&apos;s server doesn&apos;t fetch or keep them. Phones keep the farm&apos;s area for use without a signal. LINZ&apos;s{" "}
          <a href="https://www.linz.govt.nz/guidance/data-service/linz-basemaps-guide/linz-basemaps-terms-use" target="_blank" rel="noreferrer">
            terms of use
          </a>{" "}
          apply.
        </p>
      </Card>
    </div>
  );
}

/** The Settings page's card, shown when Farming is on. */
export function AerialPhotosSettings({ organisationId }: { organisationId: string }) {
  const settings = useFarmingSettings(organisationId);
  if (!settings.data?.settings.enabled) return null;
  return <AerialPhotosCard organisationId={organisationId} settings={settings.data.settings} onSaved={() => settings.reload()} />;
}

/** On Farm Home, for owners and admins, from day 80 of a key's 90 (decision 1061). */
export function ImageryKeyReminder({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const admin = can("admin");
  const settings = useFarmingSettings(organisationId, admin);
  const value = settings.data?.settings;
  const age = keyAge(value?.imageryKey ? value.imageryKeySavedOn : null, todayInBrowser());
  const [stillWorks, setStillWorks] = useState<boolean | null>(null);
  const key = value?.imageryKey ?? null;
  const expired = age?.stage === "expired";
  useEffect(() => {
    if (!key || !expired) return;
    let cancelled = false;
    void checkImageryKey(key).then((check) => {
      if (!cancelled) setStillWorks(check.ok);
    });
    return () => {
      cancelled = true;
    };
  }, [key, expired]);
  if (!admin || !age || age.stage === "fine" || (expired && stillWorks !== false)) return null;
  return (
    <Notice tone="warning">
      {age.stage === "remind"
        ? `The LINZ key for aerial photos runs out about ${formatDate(age.expiresOn)} (standard keys last ${STANDARD_KEY_DAYS} days). `
        : "The aerial photos have stopped loading: the LINZ key has probably run out. "}
      <Link href={AERIAL_PHOTOS_SETTINGS}>Get a new key (1 minute)</Link>
    </Notice>
  );
}

/** Under a map with no key: outlines show on a plain background (decision 1060). */
export function AddAerialPhotos() {
  const { can } = useWorkspace();
  return can("admin") ? (
    <p className={styles.note}>
      <Link href={AERIAL_PHOTOS_SETTINGS}>Add aerial photos (free, 1 minute)</Link>
    </p>
  ) : (
    <p className={`${styles.note} ${ui.muted}`}>Aerial photos (free, 1 minute) can be added by an owner or admin in Settings.</p>
  );
}

/** Above a map whose photos didn't load: plain words and the same three steps (decision 1060). */
export function AerialPhotosFailed({ all, online }: { all: boolean; online: boolean }) {
  const { can } = useWorkspace();
  const [open, setOpen] = useState(false);
  if (!online) return <Notice tone="warning">No connection: only aerial photos kept on this device show.</Notice>;
  return (
    <Notice tone="warning">
      {all ? "The aerial photos didn't load." : "Some aerial photos didn't load."} Most often the LINZ key has run out (standard keys last {STANDARD_KEY_DAYS} days); LINZ may also be down, or have no photos this close.{" "}
      {can("admin") ? (
        <>
          <button type="button" className={styles.linkish} aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide the steps" : "Get a new key (1 minute)"}
          </button>
          {open ? <KeySteps pasteHere={<Link href={AERIAL_PHOTOS_SETTINGS}>Paste it in Settings, Aerial photos.</Link>} /> : null}
        </>
      ) : (
        "Ask an owner or admin to get a new key: it takes a minute."
      )}
    </Notice>
  );
}

function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The Offline page's card: the farm's area of aerial photos on this device (decision 1063). */
export function FarmPhotosOffline({ organisationId, online }: { organisationId: string; online: boolean }) {
  const { user } = useWorkspace();
  const settings = useFarmingSettings(organisationId);
  const version = useSyncExternalStore(subscribeTiles, tilesVersion, () => 0);
  const progress = useSyncExternalStore(subscribeTiles, tilesProgress, () => null);
  const [summary, setSummary] = useState<TileSummary | null | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);
  const scope = { server: typeof window === "undefined" ? "" : window.location.origin, userId: user.id, organisationId };
  useEffect(() => {
    let cancelled = false;
    void readTileSummary({ server: window.location.origin, userId: user.id, organisationId }).then((next) => {
      if (!cancelled) setSummary(next);
    });
    return () => {
      cancelled = true;
    };
  }, [organisationId, user.id, version]);
  const hasKey = Boolean(settings.data?.settings.imageryKey);
  async function keepNow() {
    setMessage(null);
    const result = await keepFarmTiles(scope, { force: true });
    if (result.outcome === "busy") setMessage("Already keeping photos.");
    else if (result.outcome === "offline") setMessage("Tohyee couldn't be reached. What's kept stays as it is.");
    else if (result.outcome === "unavailable") setMessage("This browser can't keep photos.");
    else if (result.outcome === "no_key") setMessage("Aerial photos are off for this organisation.");
  }
  return (
    <Card title="Aerial photos" description={summary ? `${summary.tiles.toLocaleString("en-NZ")} photos · ${sizeText(summary.bytes)} · updated ${formatDate(summary.savedAt.slice(0, 10))}` : undefined}>
      {!hasKey ? (
        <p className={ui.muted}>Aerial photos are off, so the maps show paddock outlines only.</p>
      ) : (
        <>
          <p className={ui.muted}>
            Phones and tablets keep LINZ&apos;s aerial photos for each farm&apos;s area (the paddocks plus 300 m around them), zoom {OFFLINE_MIN_ZOOM} to {OFFLINE_MAX_ZOOM}, by themselves. At most {OFFLINE_MAX_TILES.toLocaleString("en-NZ")} photos and {OFFLINE_MAX_BYTES / 1024 / 1024} MB on a device; a big farm keeps fewer close-up zooms. Imagery © LINZ CC BY 4.0.
          </p>
          {message ? <Notice>{message}</Notice> : null}
          {progress ? <Notice>Keeping aerial photos: {progress.done.toLocaleString("en-NZ")} of {progress.total.toLocaleString("en-NZ")}…</Notice> : null}
          {summary?.problem ? <Notice tone="warning">The last update stopped early: {summary.problem} What arrived is kept.</Notice> : null}
          {summary ? (
            <ul className={styles.list}>
              {summary.farms.map((farm) => (
                <li key={farm.farmId}>
                  <strong>{farm.farmName}</strong>:{" "}
                  {farm.zooms.length
                    ? `${farm.tiles.toLocaleString("en-NZ")} photos, zoom ${farm.zooms[0]} to ${farm.zooms[farm.zooms.length - 1]}${farm.leftOut.length ? ` (closer zooms left out to save space)` : ""}`
                    : farm.leftOut.length
                      ? "not kept: over the space set aside on this device"
                      : "no paddock shapes yet"}
                </li>
              ))}
            </ul>
          ) : summary === null ? (
            <p className={ui.muted}>None kept on this device yet.</p>
          ) : null}
          <div className={ui.actions}>
            <Button variant="secondary" disabled={!online || Boolean(progress)} onClick={() => void keepNow()}>
              {summary ? "Update aerial photos" : "Keep aerial photos on this device"}
            </Button>
            {summary ? (
              <Button variant="secondary" disabled={Boolean(progress)} onClick={() => void removeFarmTiles(scope)}>
                Remove aerial photos
              </Button>
            ) : null}
          </div>
        </>
      )}
    </Card>
  );
}
