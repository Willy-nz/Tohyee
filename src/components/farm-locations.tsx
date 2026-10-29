"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { MapPersonMarker } from "@/components/farming";
import { Button, Card, Field, Notice, ui } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { dismissEnded, loadSharing, sendFromHere, serverSnapshot, sharingSnapshot, startSharing, stopSharing, subscribeSharing } from "@/lib/client/location-sharing";
import {
  accuracyText,
  avatarColour,
  DEFAULT_SHARE_HOURS,
  initialsOf,
  isPrecise,
  positionLabel,
  positionState,
  REFRESH_EVERY_SECONDS,
  SHARE_HOUR_CHOICES,
  SHARING_NOTICE,
  type SharingPerson,
  timeAgo,
  untilText,
} from "@/lib/farming/locations-shared";
import type { Farm } from "@/lib/farming/paddocks";
import styles from "./farm-locations.module.css";

/*
 * Farm members on the map (#498 item 7, decisions 1125-1134; not yet
 * reviewed by Jess): the Sharing banner on every farm page, "Share my
 * location" with its privacy notice, and who's sharing on the farm map.
 * Tohyee has no profile photos yet, so everyone is an initials avatar in
 * their own colour (decision 1129).
 */

export function useLocationSharing() {
  return useSyncExternalStore(subscribeSharing, sharingSnapshot, serverSnapshot);
}

/** A clock that ticks, so "updated 2 min ago" and recent → last known change without a reload. */
function useNow(everyMs = 15_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

const GPS_WORDS: Record<string, string | null> = {
  off: null,
  waiting: "Waiting for GPS…",
  ok: null,
  denied: "This browser has been told not to share your location with Tohyee, so nothing is being sent. Allow location for this site in the browser's settings, then press Send from this phone.",
  unavailable: "GPS can't find where you are just now. Tohyee will keep trying while this page is open.",
  timeout: "GPS is taking a while to find where you are. Tohyee will keep trying while this page is open.",
  unsupported: "This browser can't share its location, so nothing is being sent.",
};

/** On every farm page while you share: who sees it, until when, and Stop sharing (decision 1128). */
export function LocationSharingBanner({ organisationId }: { organisationId: string }) {
  const sharing = useLocationSharing();
  const now = useNow();
  useEffect(() => {
    void loadSharing(organisationId);
  }, [organisationId]);
  const [stopping, setStopping] = useState(false);
  if (sharing.organisationId !== organisationId) return null;
  if (!sharing.mine) {
    if (!sharing.ended) return null;
    return (
      <div className={styles.banner} data-tone="ended" role="status">
        <span>{sharing.ended}</span>
        <Button variant="secondary" size="small" onClick={() => dismissEnded()}>
          OK
        </Button>
      </div>
    );
  }
  const { mine } = sharing;
  const gps = sharing.thisDevice ? GPS_WORDS[sharing.gps] : null;
  const sent = sharing.lastSentAt ? `Last sent ${timeAgo(sharing.lastSentAt, now)}.` : null;
  return (
    <section className={styles.banner} data-tone="on" aria-label="Location sharing" role="region">
      <div className={styles.bannerText}>
        <strong>
          <span aria-hidden="true">● </span>Sharing your location with {mine.farmName} until {untilText(mine.endsAt)}
        </strong>
        <span className={styles.bannerDetail}>
          {sharing.thisDevice
            ? sharing.offline
              ? "No connection: your position isn't reaching Tohyee, so others see your last known one, marked not live."
              : `People who work on this farm can see it. Only while Tohyee is open here. ${sent ?? ""}`
            : "Started on another device, or before this page was reloaded elsewhere. This phone isn't sending."}
        </span>
        {gps ? <span className={styles.bannerDetail}>{gps}</span> : null}
        {sharing.problem ? <span className={styles.bannerDetail}>{sharing.problem}</span> : null}
      </div>
      <div className={styles.bannerActions}>
        {!sharing.thisDevice || sharing.gps === "denied" ? (
          <Button variant="secondary" size="small" onClick={() => sendFromHere()}>
            Send from this phone
          </Button>
        ) : null}
        <Button
          variant="danger"
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            void stopSharing().finally(() => setStopping(false));
          }}
        >
          {stopping ? "Stopping…" : "Stop sharing"}
        </Button>
      </div>
    </section>
  );
}

/** Everyone sharing with this farm, refreshed every 30 seconds while the map is open and showing. */
export function useFarmPeople(organisationId: string, farmId: string) {
  const [data, setData] = useState<{ people: SharingPerson[]; fetchedAt: string } | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const result = await api<{ now: string; people: SharingPerson[] }>(`/api/farming/farms/${farmId}/locations`, { query: { organisationId } });
      setData({ people: result.people, fetchedAt: new Date().toISOString() });
      setOffline(false);
      setError(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 0) setOffline(true);
      else setError(caught instanceof Error ? caught.message : "Who's sharing couldn't be loaded.");
    }
  }, [organisationId, farmId]);
  const sharing = useLocationSharing();
  const mineKey = sharing.mine ? `${sharing.mine.shareId}:${sharing.mine.farmId}` : "";
  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, REFRESH_EVERY_SECONDS * 1000);
    const goneOffline = () => setOffline(true);
    const back = () => void reload();
    window.addEventListener("offline", goneOffline);
    window.addEventListener("online", back);
    return () => {
      clearInterval(timer);
      window.removeEventListener("offline", goneOffline);
      window.removeEventListener("online", back);
    };
  }, [reload, mineKey]);
  return { people: data?.people ?? null, fetchedAt: data?.fetchedAt ?? null, offline, error, reload };
}

/** The markers for the map: people with a position only; old ones and an offline viewer's are grey and dashed. */
export function peopleMarkers(people: SharingPerson[], now: Date, offline: boolean, selected: string | null, onSelect: (shareId: string) => void): MapPersonMarker[] {
  return people.flatMap((person) => {
    if (!person.position) return [];
    const state = offline ? "stale" : positionState(person.position, now) === "recent" ? "recent" : "stale";
    return [
      {
        id: person.shareId,
        label: `${person.name}${person.isMe ? " (you)" : ""}: ${positionLabel(person.position, now, offline)}, accurate to ${accuracyText(person.position.accuracyMetres)}`,
        initials: initialsOf(person.name),
        colour: avatarColour(person.userId),
        point: [person.position.longitude, person.position.latitude] as [number, number],
        accuracyMetres: person.position.accuracyMetres,
        state,
        precise: isPrecise(person.position.accuracyMetres),
        selected: person.shareId === selected,
        onSelect: () => onSelect(person.shareId),
      },
    ];
  });
}

function Avatar({ person, live }: { person: SharingPerson; live: boolean }) {
  return (
    <span className={styles.avatar} data-live={live ? "yes" : "no"} style={{ background: live ? avatarColour(person.userId) : undefined }} aria-hidden="true">
      {initialsOf(person.name)}
    </span>
  );
}

/** One person's card, as a tap on their marker opens it: name, accuracy and when it was updated. */
function PersonDetails({ person, now, offline }: { person: SharingPerson; now: Date; offline: boolean }) {
  const state = positionState(person.position, now);
  const live = !offline && state === "recent";
  return (
    <div className={styles.person} data-state={offline && state !== "unavailable" ? "stale" : state}>
      <Avatar person={person} live={live} />
      <div className={styles.personText}>
        <strong>
          {person.name}
          {person.isMe ? " (you)" : ""}
        </strong>
        <span>{positionLabel(person.position, now, offline)}</span>
        {person.position ? (
          <span className={ui.muted}>
            {isPrecise(person.position.accuracyMetres) ? `Accurate to ${accuracyText(person.position.accuracyMetres)}` : `Rough position: somewhere within ${accuracyText(person.position.accuracyMetres)} (the circle)`}
          </span>
        ) : null}
        <span className={ui.muted}>Sharing until {untilText(person.endsAt)}</span>
      </div>
    </div>
  );
}

/** The map's "People" card: who's sharing, the selected person's details, and Share my location. */
export function FarmPeopleCard({
  organisationId,
  farm,
  people,
  selected,
  onSelect,
}: {
  organisationId: string;
  farm: Farm;
  people: ReturnType<typeof useFarmPeople>;
  selected: string | null;
  onSelect: (shareId: string | null) => void;
}) {
  const now = useNow();
  const sharing = useLocationSharing();
  const list = people.people ?? [];
  const offline = people.offline;
  const chosen = list.find((person) => person.shareId === selected) ?? null;
  const sharingHere = sharing.mine?.farmId === farm.id;
  return (
    <Card title="People on the map" description="Only people who chose to share their location with this farm. Sharing is never on unless the person turns it on.">
      {offline ? (
        <Notice tone="warning">
          Not live: this device can't reach Tohyee.{people.fetchedAt ? ` What's shown was last checked ${timeAgo(people.fetchedAt, now)}, and people may have moved or stopped sharing.` : ""}
        </Notice>
      ) : null}
      {people.error ? <Notice tone="error">{people.error}</Notice> : null}
      {chosen ? (
        <div className={styles.chosen}>
          <PersonDetails person={chosen} now={now} offline={offline} />
          <Button variant="secondary" size="small" onClick={() => onSelect(null)}>
            Close
          </Button>
        </div>
      ) : null}
      {people.people === null && !offline ? <p className={ui.muted}>Loading…</p> : null}
      {people.people && list.length === 0 ? <p className={ui.muted}>No one is sharing their location with {farm.name} now.</p> : null}
      {list.length ? (
        <ul className={styles.list} aria-label="People sharing their location">
          {list.map((person) => {
            const state = positionState(person.position, now);
            return (
              <li key={person.shareId}>
                <button type="button" className={styles.listButton} aria-pressed={person.shareId === selected} onClick={() => onSelect(person.shareId === selected ? null : person.shareId)}>
                  <Avatar person={person} live={!offline && state === "recent"} />
                  <span className={styles.personText}>
                    <strong>
                      {person.name}
                      {person.isMe ? " (you)" : ""}
                    </strong>
                    <span className={styles.stateLine} data-state={offline && state !== "unavailable" ? "stale" : state}>
                      {positionLabel(person.position, now, offline)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className={ui.muted}>Solid avatars were updated in the last 5 minutes. Grey, dashed ones are last known positions, not live. A dashed circle is a rough position.</p>
      {sharingHere ? null : <ShareMyLocation organisationId={organisationId} farm={farm} otherFarm={sharing.mine && !sharingHere ? sharing.mine.farmName : null} onStarted={() => void people.reload()} />}
    </Card>
  );
}

/** "Share my location with <farm> until <time>", with the privacy notice above the button (decision 1133). */
function ShareMyLocation({ organisationId, farm, otherFarm, onStarted }: { organisationId: string; farm: Farm; otherFarm: string | null; onStarted: () => void }) {
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState(DEFAULT_SHARE_HOURS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(30_000);
  const until = untilText(new Date(now.getTime() + hours * 3_600_000));
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Share my location…
      </Button>
    );
  }
  return (
    <div className={styles.share}>
      <h3 className={styles.shareTitle}>Share my location with {farm.name}</h3>
      <div className={styles.notice} role="note" aria-label="Privacy notice">
        <strong>Before you share</strong>
        <ul>
          {SHARING_NOTICE.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      {otherFarm ? <Notice tone="info">You&apos;re sharing with {otherFarm} now. Sharing here stops that.</Notice> : null}
      <Field label="Share for" hint={`Until ${until}. The most is 12 hours.`}>
        <select value={hours} onChange={(event) => setHours(Number(event.target.value))}>
          {SHARE_HOUR_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {choice === 1 ? "1 hour" : `${choice} hours`}
            </option>
          ))}
        </select>
      </Field>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={styles.shareActions}>
        <Button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            startSharing(organisationId, farm.id, hours)
              .then(() => {
                setOpen(false);
                onStarted();
              })
              .catch((caught) => setError(caught instanceof Error ? caught.message : "Sharing didn't start."))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Starting…" : `Share my location until ${until}`}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Not now
        </Button>
      </div>
    </div>
  );
}
