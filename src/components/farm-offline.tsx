"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { refreshFarmPacks, useOnline, usePackProgress } from "@/components/offline-support";
import { Badge, Button, Card, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { offlineServedSnapshot, subscribeOfflineServed } from "@/lib/client/api";
import { EXTRA_PACK_MONTHS, NEVER_IN_A_PACK, PACK_MONTHS, PACK_SECTIONS } from "@/lib/offline/pack-inventory";
import { type FarmReadiness, ORGANISATION_KEY, packsVersion, readiness, removePacks, setExtras, subscribePacks } from "@/lib/offline/packs";
import { openQueue } from "@/lib/offline/queue";
import styles from "./farm-offline.module.css";

/*
 * Offline farm information on the screen (#472 stage 3, decisions
 * 999-1007): the farm bar's readiness line, the "last known" notice when a
 * screen is showing what's kept on the device, and the Offline page
 * (what's kept, when, how big, extras and removal).
 */

export const OFFLINE_PAGE = "/operations/farm/offline";

function when(iso: string | null): string {
  if (!iso) return "not yet";
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? `today ${date.toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit" })}` : date.toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const READINESS_LABEL: Record<FarmReadiness["state"], string> = { ready: "Ready offline", partial: "Partly ready offline", preparing: "Preparing for offline use" };

function useReadiness(organisationId: string) {
  const { user } = useWorkspace();
  const version = useSyncExternalStore(subscribePacks, packsVersion, () => 0);
  const [rows, setRows] = useState<FarmReadiness[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    readiness({ server: window.location.origin, userId: user.id, organisationId }).then(
      (next) => {
        if (!cancelled) setRows(next);
      },
      () => {
        if (!cancelled) setRows([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [organisationId, user.id, version]);
  return rows;
}

/**
 * Under the farm bar: whether this farm is ready offline, and, when a
 * screen is showing what's kept on the device, that it's the last known
 * information and how old it is.
 */
export function FarmOfflineStatus({ organisationId, farmId }: { organisationId: string; farmId: string }) {
  const served = useSyncExternalStore(subscribeOfflineServed, offlineServedSnapshot, () => new Map<string, string>());
  const rows = useReadiness(organisationId);
  const running = usePackProgress();
  const farm = rows?.find((row) => row.farmId === farmId) ?? null;
  const times = [...served.values()].sort();
  if (times.length) {
    return (
      <Notice tone="warning">
        <strong>Last known information, kept on this device</strong> (oldest part kept {when(times[0])}). Mobs, machinery, actions and who&apos;s on site may have changed since. Lists and searches only cover what&apos;s kept here. <Link href={OFFLINE_PAGE}>What&apos;s kept</Link>
      </Notice>
    );
  }
  if (running?.running && running.total) {
    return (
      <p className={styles.status} role="status">
        Getting this farm ready to use offline: {running.done} of {running.total}…
      </p>
    );
  }
  if (!farm) return null;
  return (
    <p className={styles.status}>
      <Link href={OFFLINE_PAGE}>
        {READINESS_LABEL[farm.state]}
        {farm.oldestSavedAt ? ` · updated ${when(farm.oldestSavedAt)}` : ""}
      </Link>
    </p>
  );
}

/** The Offline page: what's kept on this device, per farm and part, with extras and removal (decisions 1003-1006). */
export function FarmOfflinePage({ organisationId }: { organisationId: string }) {
  const { user } = useWorkspace();
  const confirm = useConfirm();
  const online = useOnline();
  const rows = useReadiness(organisationId);
  const running = usePackProgress();
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [unsent, setUnsent] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const scope = { server: typeof window === "undefined" ? "" : window.location.origin, userId: user.id, organisationId };
  const version = useSyncExternalStore(subscribePacks, packsVersion, () => 0);

  const loadStorage = useCallback(async () => {
    try {
      const value = await navigator.storage?.estimate?.();
      if (value) setEstimate({ usage: value.usage ?? 0, quota: value.quota ?? 0 });
      setPersisted((await navigator.storage?.persisted?.()) ?? null);
    } catch {
      setEstimate(null);
    }
    const queue = await openQueue({ server: window.location.origin, userId: user.id, organisationId }).catch(() => null);
    setUnsent(queue ? queue.unsentCount() : null);
  }, [organisationId, user.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the browser's storage figures after each change
    void loadStorage();
  }, [loadStorage, version]);

  async function refresh(farmId?: string) {
    setMessage(null);
    const result = await refreshFarmPacks(user.id, organisationId, { force: true, farmId });
    if (!result) setMessage(online ? "Another update is already running." : "No connection: what's kept stays as it is.");
    else if (result.outcome === "unreachable") setMessage("Tohyee couldn't be reached part way through. What arrived is kept; the rest is tried next time.");
    else if (result.outcome === "sign_in") setMessage("Sign in again to update what's kept.");
    else if (result.outcome === "locked") setMessage("Sign in with a connection first.");
    else setMessage(result.failed ? `Updated ${result.updated} part${result.updated === 1 ? "" : "s"}; ${result.failed} couldn't be updated (see below). Their previous copies are kept.` : `Updated ${result.updated} part${result.updated === 1 ? "" : "s"}.`);
  }

  async function extras(farmId: string, change: { months?: number; originals?: boolean }) {
    await setExtras(scope, farmId, change);
    if (online) await refresh(farmId);
  }

  async function remove(farmId: string | null, name: string) {
    const ok = await confirm(farmId ? `Remove ${name}'s information from this device? It's kept again automatically next time Tohyee opens with a connection.` : "Remove all farm information kept on this device? It's kept again automatically next time Tohyee opens with a connection.", {
      title: "Remove from this device",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    await removePacks(scope, farmId);
    setMessage(`Removed. Work waiting to be sent is never removed here${unsent ? ` (${unsent} waiting)` : ""}.`);
  }

  async function keepStorage() {
    try {
      setPersisted(await navigator.storage.persist());
    } catch {
      setPersisted(false);
    }
  }

  const farms = (rows ?? []).filter((row) => row.farmId !== ORGANISATION_KEY);
  const organisation = (rows ?? []).find((row) => row.farmId === ORGANISATION_KEY);
  return (
    <div className={styles.page}>
      <p className={ui.muted}>
        Tohyee keeps every farm you can see on this device, with the last {PACK_MONTHS} months of records and small copies of photos, so the farm pages work without a signal. It updates by itself whenever Tohyee is open with a connection. It&apos;s a copy for working away from a signal, not a backup.
      </p>
      {message ? <Notice>{message}</Notice> : null}
      {running?.running && running.total ? (
        <Notice>
          Updating: {running.done} of {running.total}
          {running.farmName ? ` (${running.farmName}, ${running.section})` : running.section ? ` (${running.section})` : ""}…
        </Notice>
      ) : null}

      <Card title="This device">
        <ul className={styles.facts}>
          <li>
            Waiting to be sent: <strong>{unsent ?? "…"}</strong>. Work waiting to be sent is never removed from this page.
          </li>
          {estimate ? (
            <li>
              Storage used by this browser for Tohyee: <strong>{sizeText(estimate.usage)}</strong>
              {estimate.quota ? ` of about ${sizeText(estimate.quota)} it allows` : ""}.
            </li>
          ) : (
            <li>This browser doesn&apos;t say how much storage it allows.</li>
          )}
          <li>
            {persisted ? (
              "This browser has agreed to keep Tohyee's storage unless you clear it."
            ) : (
              <>
                The browser may clear Tohyee&apos;s storage if the device runs short of space.{" "}
                <Button type="button" variant="secondary" onClick={() => void keepStorage()}>
                  Ask to keep it
                </Button>
              </>
            )}
          </li>
        </ul>
        <div className={styles.actions}>
          <Button type="button" onClick={() => void refresh()} disabled={!online || Boolean(running?.running)}>
            Update now
          </Button>
          <Button type="button" variant="secondary" onClick={() => void remove(null, "")} disabled={!rows?.length}>
            Remove everything kept
          </Button>
        </div>
        {!online ? <p className={ui.muted}>No connection: updating waits until there is one.</p> : null}
      </Card>

      {rows === null ? <p className={ui.muted}>Loading…</p> : null}
      {rows && rows.length === 0 ? <Notice>Nothing is kept on this device yet. It starts by itself when Tohyee is open with a connection.</Notice> : null}

      {[...(organisation ? [organisation] : []), ...farms].map((farm) => {
        const isOrganisation = farm.farmId === ORGANISATION_KEY;
        return (
          <Card
            key={farm.farmId}
            title={isOrganisation ? "Farms, settings and notebook" : farm.farmName}
            description={`${sizeText(farm.bytes)}${farm.oldestSavedAt ? ` · updated ${when(farm.oldestSavedAt)}` : ""}`}
            actions={<Badge tone={farm.state === "ready" ? "green" : farm.state === "partial" ? "amber" : "neutral"}>{READINESS_LABEL[farm.state]}</Badge>}
          >
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Part</th>
                  <th scope="col">Kept</th>
                  <th scope="col" className={styles.size}>
                    Size
                  </th>
                </tr>
              </thead>
              <tbody>
                {farm.sections.map((section) => (
                  <tr key={section.key}>
                    <th scope="row">
                      {section.label}
                      <span className={styles.includes}>{PACK_SECTIONS.find((info) => info.key === section.key)?.includes}</span>
                    </th>
                    <td className={styles.kept}>
                      {section.savedAt ? when(section.savedAt) : "Not yet"}
                      {section.error ? <span className={styles.problem}>Didn&apos;t update: {section.error}</span> : null}
                      {section.skipped ? <span className={styles.includes}>{section.skipped} item{section.skipped === 1 ? "" : "s"} not kept (not for your role, or too big)</span> : null}
                    </td>
                    <td className={styles.size}>{section.bytes ? sizeText(section.bytes) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {isOrganisation ? null : (
              <div className={styles.actions}>
                <Button type="button" variant="secondary" onClick={() => void extras(farm.farmId, { months: farm.months === EXTRA_PACK_MONTHS ? PACK_MONTHS : EXTRA_PACK_MONTHS })}>
                  {farm.months === EXTRA_PACK_MONTHS ? `Back to ${PACK_MONTHS} months` : `Keep ${EXTRA_PACK_MONTHS / 12} years of history`}
                </Button>
                <Button type="button" variant="secondary" onClick={() => void extras(farm.farmId, { originals: !farm.originals })}>
                  {farm.originals ? "Small copies of photos only" : "Keep original photos and large files"}
                </Button>
                <Button type="button" variant="secondary" onClick={() => void refresh(farm.farmId)} disabled={!online || Boolean(running?.running)}>
                  Update this farm
                </Button>
                <Button type="button" variant="secondary" onClick={() => void remove(farm.farmId, farm.farmName)}>
                  Remove from this device
                </Button>
              </div>
            )}
          </Card>
        );
      })}

      <Card title="Never kept on a device">
        <ul className={styles.facts}>
          {NEVER_IN_A_PACK.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
