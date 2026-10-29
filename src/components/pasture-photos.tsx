"use client";

import Link from "next/link";
import { useState } from "react";
import { submitThroughQueue, useOfflineQueue } from "@/components/offline-queue";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import type { AiConnection } from "@/lib/ai/photo-tools";
import { api, errorMessage } from "@/lib/client/api";
import { coverText, shortDate } from "@/lib/farming/farm-words";
import type { Farm } from "@/lib/farming/paddocks";
import type { PastureReading } from "@/lib/farming/pasture";
import type { PasturePhoto, PhotoCalibration, PhotoEstimate } from "@/lib/farming/pasture-photos";
import { ESTIMATE_CONFIDENCE_LABELS, ESTIMATE_LABEL, ESTIMATE_STATUS_LABELS } from "@/lib/farming/pasture-photos-shared";
import { CALIBRATION_WINDOWS, DEFAULT_CALIBRATION_WINDOW, PASTURE_METHOD_LABELS, parseCover } from "@/lib/farming/pasture-rules";
import { formatDate, formatDateTime, todayInBrowser } from "@/lib/format";
import { compressPhoto, type PhotoPlace, photoPlace, placeText } from "@/lib/offline/photos";
import { newOperationId, type OfflineQueue } from "@/lib/offline/queue";
import styles from "./pasture-photos.module.css";

/*
 * Paddock photos with cover readings, the photo diary, and AI estimates
 * from photos (#503, decisions 1160-1169). Photos go through the device's
 * queue like safety photos (decision 1012): a compressed copy, the phone's
 * time, and where the phone was if asked. This is the web photo path; a
 * native camera can hand its file to `pickPasturePhoto` the same way.
 */

/** A photo just taken: kept by Tohyee, or still on this device. */
export type PickedPhoto = { id: string; name: string; pending: boolean; phoneFileTime: string; place: PhotoPlace | null };

/**
 * Keeps a photo of a paddock (decision 1160). Its operation id becomes the
 * photo's id on Tohyee; `readingOperationId` names the Log reading it was
 * taken with, so they're linked whichever reaches Tohyee first.
 */
export async function pickPasturePhoto(queue: OfflineQueue | null, input: { farm: { id: string; name: string }; paddock: { id: string; name: string }; file: Blob & { name?: string; lastModified?: number }; place?: boolean; readingOperationId?: string | null }): Promise<PickedPhoto> {
  const operationId = newOperationId();
  const blob = input.file.type.startsWith("image/") ? await compressPhoto(input.file) : input.file;
  const contentType = blob.type || input.file.type;
  const place = input.place ? await photoPlace() : null;
  const phoneFileTime = input.file.lastModified ? new Date(input.file.lastModified).toISOString() : new Date().toISOString();
  const original = input.file.name || "paddock";
  const name = contentType === "image/jpeg" && !/\.jpe?g$/i.test(original) ? `${original.replace(/\.[^.]+$/, "") || "paddock"}.jpg` : original;
  const outcome = await submitThroughQueue(queue, {
    operationId,
    kind: "pasture.photo",
    label: `Photo: paddock ${input.paddock.name}`,
    farmId: input.farm.id,
    farmName: input.farm.name,
    request: {
      method: "POST",
      path: "/api/farming/pasture-photos",
      body: { farmId: input.farm.id, paddockId: input.paddock.id, fileName: name, contentType, phoneFileTime, place, readingOperationId: input.readingOperationId ?? null },
      files: [{ blob: "file", field: "contentBase64" }],
    },
    blobs: { file: blob },
  });
  return { id: operationId, name, pending: outcome.state !== "synced", phoneFileTime, place };
}

export function photoHref(organisationId: string, photoId: string): string {
  return `/api/farming/pasture-photos/${photoId}?organisationId=${encodeURIComponent(organisationId)}`;
}

/** Take or choose photos of a paddock; each is kept as soon as it's chosen. */
export function PasturePhotoPicker({ organisationId, farm, paddock, readingOperationId = null, photos, onChange, label = "Add a photo of the paddock" }: { organisationId: string; farm: { id: string; name: string }; paddock: { id: string; name: string }; readingOperationId?: string | null; photos: PickedPhoto[]; onChange: (photos: PickedPhoto[]) => void; label?: string }) {
  const { queue } = useOfflineQueue(organisationId);
  const [withPlace, setWithPlace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = photos.filter((photo) => photo.pending).length;
  return (
    <div className={styles.picker}>
      <label className={styles.pickerButton}>
        {busy ? "Keeping the photo…" : label}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          disabled={busy}
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            event.target.value = "";
            if (!chosen) return;
            setBusy(true);
            setError(null);
            pickPasturePhoto(queue, { farm, paddock, file: chosen, place: withPlace, readingOperationId })
              .then((photo) => onChange([...photos, photo]))
              .catch((caught) => setError(errorMessage(caught)))
              .finally(() => setBusy(false));
          }}
        />
      </label>
      <label className={styles.check}>
        <input type="checkbox" checked={withPlace} onChange={(event) => setWithPlace(event.target.checked)} /> Add where I am to the photo
      </label>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {photos.length ? (
        <>
          <PickedThumbs organisationId={organisationId} photos={photos} />
          <p className={ui.muted}>
            {photos.length} photo{photos.length === 1 ? "" : "s"} kept{pending ? ` (${pending} on this device, sent when there's a signal)` : ""}.
          </p>
        </>
      ) : null}
    </div>
  );
}

function PickedThumbs({ organisationId, photos }: { organisationId: string; photos: PickedPhoto[] }) {
  return (
    <div className={styles.thumbs}>
      {photos.map((photo) =>
        photo.pending ? (
          <span key={photo.id} className={styles.pending}>
            Photo on this device
          </span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- a private, signed-in file; next/image would cache it
          <img key={photo.id} className={styles.thumb} src={photoHref(organisationId, photo.id)} alt={`Paddock photo ${photo.name}`} />
        ),
      )}
    </div>
  );
}

function photoTitle(photo: PasturePhoto): string {
  return [`Taken ${formatDate(photo.takenOn)} (the phone's clock)`, photo.photoTaken ? `camera date ${photo.photoTaken}` : null, `reached Tohyee ${formatDateTime(photo.receivedAt)}`, photo.place ? `where the phone said: ${placeText(photo.place)}` : null, `by ${photo.uploadedByEmail}`].filter(Boolean).join("; ");
}

function estimateWords(estimate: PhotoEstimate): string {
  if (estimate.status === "waiting") return `${ESTIMATE_LABEL}: ${coverText(estimate.cover)}, waiting for a person`;
  if (estimate.status === "accepted") return `AI estimate ${coverText(estimate.cover)}, accepted`;
  if (estimate.status === "changed") return `AI estimate ${coverText(estimate.cover)}, changed to ${coverText(estimate.decidedCover ?? estimate.cover)}`;
  if (estimate.status === "compared") return `AI estimate ${coverText(estimate.cover)}, kept for comparison`;
  return `AI estimate ${coverText(estimate.cover)}, declined`;
}

/**
 * A paddock's photo diary (decision 1168): its photos through the season,
 * by the day taken, beside that day's readings. Each says whether its
 * cover was measured, or is an AI estimate from the photo.
 */
export function PaddockPhotoDiary({ organisationId, paddockId, readings, addHref }: { organisationId: string; paddockId: string; readings: PastureReading[]; addHref?: string | null }) {
  const today = todayInBrowser();
  const photos = useApiData<{ photos: PasturePhoto[] }>(`/api/farming/paddocks/${paddockId}/photos`, { organisationId, limit: 60 });
  const [all, setAll] = useState(false);
  if (photos.error) return <Notice tone="error">{photos.error}</Notice>;
  if (!photos.data) return <p className={ui.muted}>Loading photos…</p>;
  const days = [...new Set(photos.data.photos.map((photo) => photo.takenOn))].sort((a, b) => b.localeCompare(a));
  const shown = all ? days : days.slice(0, 4);
  return (
    <div>
      {!days.length ? <p className={ui.muted}>No photos of this paddock yet.{addHref ? " Take one with a cover reading, or on its own." : ""}</p> : null}
      <ul className={styles.diary} aria-label="Photo diary">
        {shown.map((day) => {
          const dayPhotos = photos.data!.photos.filter((photo) => photo.takenOn === day);
          const dayReadings = readings.filter((reading) => reading.measuredOn === day);
          return (
            <li key={day}>
              <span className={styles.day}>{shortDate(day, today)}</span>
              <div className={styles.thumbs}>
                {dayPhotos.map((photo) => (
                  <a key={photo.id} href={photoHref(organisationId, photo.id)} target="_blank" rel="noreferrer" title={photoTitle(photo)}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- a private, signed-in file; next/image would cache it */}
                    <img className={styles.thumb} src={photoHref(organisationId, photo.id)} alt={`Paddock photo, ${formatDate(photo.takenOn)}`} loading="lazy" />
                  </a>
                ))}
              </div>
              {dayReadings.map((reading) => (
                <span key={reading.id}>
                  Cover {coverText(reading.cover)} · {PASTURE_METHOD_LABELS[reading.method]} {reading.estimate ? <Badge tone="amber">Estimate</Badge> : <Badge tone="green">Measured</Badge>}
                </span>
              ))}
              {dayPhotos
                .filter((photo) => photo.estimate)
                .map((photo) => (
                  <span key={`e${photo.id}`} className={ui.muted}>
                    {estimateWords(photo.estimate!)}
                  </span>
                ))}
            </li>
          );
        })}
      </ul>
      {days.length > shown.length ? (
        <Button variant="secondary" onClick={() => setAll(true)}>
          Show all {days.length} days
        </Button>
      ) : null}
      {addHref ? (
        <p>
          <Link href={addHref}>Add a photo</Link>
        </p>
      ) : null}
    </div>
  );
}

/** What to say when no AI can propose estimates for this person (decision 1167). */
function AiStatus({ ai }: { ai: AiConnection }) {
  if (ai.canPropose) {
    return <p className={ui.muted}>Your AI is connected. Ask it to estimate the cover in the paddock photos waiting here; its estimates show below for you to accept, change or decline. Tohyee sends photos only to the AI you connected, when it asks.</p>;
  }
  if (!ai.roleCanConnect) {
    return <Notice tone="info">No AI is connected for you. Your role can&apos;t connect one, so enter covers by hand. Someone with the bookkeeper role or higher can connect their own AI to estimate covers from these photos.</Notice>;
  }
  if (ai.connected && !ai.roleCanPropose) {
    return <Notice tone="info">Your AI can look at the photos but your role can&apos;t let it propose covers. Enter covers by hand, or ask someone with the bookkeeper role or higher.</Notice>;
  }
  return (
    <Notice tone="info">
      {ai.connected ? "Your AI is connected at Look only, so it can't propose covers." : "No AI is connected, so photos wait here and covers are entered by hand."} To have your own AI estimate covers from photos, connect it (or make a key) at <strong>Make drafts</strong> on the <Link href="/operations/ai">AI page</Link>. Tohyee doesn&apos;t send photos anywhere itself.
    </Notice>
  );
}

function EstimateRow({ organisationId, estimate, canDecide, onDecided }: { organisationId: string; estimate: PhotoEstimate; canDecide: boolean; onDecided: () => void }) {
  const [mode, setMode] = useState<"idle" | "change" | "decline">("idle");
  const [cover, setCover] = useState(String(estimate.cover));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/farming/pasture-estimates/${estimate.id}`, { method: "POST", body: { organisationId, ...body } });
      onDecided();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const typed = parseCover(cover);
  return (
    <li className={styles.estimate}>
      <a href={photoHref(organisationId, estimate.photoId)} target="_blank" rel="noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element -- a private, signed-in file; next/image would cache it */}
        <img src={photoHref(organisationId, estimate.photoId)} alt={`Photo of paddock ${estimate.paddockName}, ${formatDate(estimate.takenOn)}`} loading="lazy" />
      </a>
      <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
        <span>
          <strong>Paddock {estimate.paddockName}</strong> · photo {formatDate(estimate.takenOn)}
        </span>
        <span className={styles.figure}>{coverText(estimate.cover)}</span>
        <span>
          <Badge tone="amber">{ESTIMATE_LABEL}</Badge> <span className={ui.muted}>{ESTIMATE_CONFIDENCE_LABELS[estimate.confidence]} (the AI&apos;s own words)</span>
        </span>
        <span>&ldquo;{estimate.reasoning}&rdquo;</span>
        <span className={ui.muted}>
          From {estimate.aiKeyName ?? "an AI"} for {estimate.proposedByEmail}, {formatDateTime(estimate.createdAt)}.
        </span>
        {estimate.photoReading ? (
          <span className={ui.muted}>
            Taken with a reading of {coverText(estimate.photoReading.cover)} ({PASTURE_METHOD_LABELS[estimate.photoReading.method]}), so it can only be kept beside it for comparison.
          </span>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {canDecide && mode === "idle" ? (
          <div className={styles.actions}>
            {estimate.photoReading ? null : (
              <>
                <Button disabled={busy} onClick={() => void decide({ action: "accept" })}>
                  Accept as a reading
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => setMode("change")}>
                  Change it
                </Button>
              </>
            )}
            <Button variant="secondary" disabled={busy} onClick={() => void decide({ action: "compare" })}>
              Keep for comparison
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setMode("decline")}>
              Decline
            </Button>
          </div>
        ) : null}
        {canDecide && mode === "change" ? (
          <form
            className={styles.actions}
            onSubmit={(event) => {
              event.preventDefault();
              if (typed !== null) void decide({ action: "accept", cover: typed });
            }}
          >
            <Field label="Cover (kg DM/ha)">
              <input className={styles.coverInput} inputMode="numeric" value={cover} onChange={(event) => setCover(event.target.value)} />
            </Field>
            <Button type="submit" disabled={busy || typed === null}>
              Save as a reading
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </form>
        ) : null}
        {canDecide && mode === "decline" ? (
          <form
            className={styles.actions}
            onSubmit={(event) => {
              event.preventDefault();
              void decide({ action: "decline", reason });
            }}
          >
            <Field label="Why (optional)">
              <input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Wrong paddock" />
            </Field>
            <Button type="submit" variant="danger" disabled={busy}>
              Decline
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </form>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Covers estimated from photos by the person's own AI (decisions
 * 1162-1167): each waits for a person, who accepts it as a reading, changes
 * it first, keeps it for comparison or declines it. The decided ones stay
 * listed with who decided and what was saved.
 */
export function PhotoEstimates({ organisationId, farm, canDecide, onDecided }: { organisationId: string; farm: Farm; canDecide: boolean; onDecided?: () => void }) {
  const data = useApiData<{ waiting: PhotoEstimate[]; decided: PhotoEstimate[]; ai: AiConnection }>(`/api/farming/farms/${farm.id}/pasture/estimates`, { organisationId });
  const photos = useApiData<{ photos: PasturePhoto[] }>(`/api/farming/farms/${farm.id}/pasture/photos`, { organisationId, limit: 200 });
  const awaiting = (photos.data?.photos ?? []).filter((photo) => !photo.estimate).length;
  const reload = () => {
    data.reload();
    photos.reload();
    onDecided?.();
  };
  return (
    <Card title="Covers from photos" description="An AI's estimate from a photo is a rough guess, not a measurement. It isn't a reading until a person accepts or changes it.">
      {data.error ? <Notice tone="error">{data.error}</Notice> : null}
      {data.data ? <AiStatus ai={data.data.ai} /> : <p className={ui.muted}>Loading…</p>}
      {photos.data ? (
        <p className={ui.muted}>
          {awaiting ? `${awaiting} photo${awaiting === 1 ? "" : "s"} of ${farm.name} without an estimate.` : `Every photo of ${farm.name} has an estimate.`} Photos are taken on the Log (a cover reading, a farm walk, or a paddock photo).
        </p>
      ) : null}
      {data.data?.waiting.length ? (
        <>
          <h3>Waiting for a person ({data.data.waiting.length})</h3>
          <ul className={styles.estimates}>
            {data.data.waiting.map((estimate) => (
              <EstimateRow key={estimate.id} organisationId={organisationId} estimate={estimate} canDecide={canDecide} onDecided={reload} />
            ))}
          </ul>
        </>
      ) : null}
      {data.data?.decided.length ? (
        <>
          <h3>Decided</h3>
          <ul className={styles.history} aria-label="Decided estimates">
            {data.data.decided.map((estimate) => (
              <li key={estimate.id}>
                Paddock {estimate.paddockName}, photo {formatDate(estimate.takenOn)}: {estimateWords(estimate)}. <span className={ui.muted}>{ESTIMATE_STATUS_LABELS[estimate.status]} by {estimate.decidedByEmail} {formatDateTime(estimate.decidedAt)}{estimate.declineReason ? `: ${estimate.declineReason}` : ""}.</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}

/**
 * Photo estimates beside other readings (decision 1166): the average and
 * spread of the differences on this farm, in neutral words. Tohyee never
 * adjusts an estimate by them.
 */
export function PhotoCalibrationCard({ organisationId, farm }: { organisationId: string; farm: Farm }) {
  const [windowDays, setWindowDays] = useState(DEFAULT_CALIBRATION_WINDOW);
  const data = useApiData<{ calibration: PhotoCalibration }>(`/api/farming/farms/${farm.id}/pasture/calibration`, { organisationId, windowDays });
  const calibration = data.data?.calibration;
  return (
    <Card title="Photo estimates beside other readings" description="How far the AI's photo estimates were from other readings of the same paddock close in time, over the last year. For your judgement only: Tohyee never adjusts an estimate.">
      <div className={ui.inlineForm}>
        <Field label="Close in time means within">
          <select value={windowDays} onChange={(event) => setWindowDays(Number(event.target.value))}>
            {CALIBRATION_WINDOWS.map((days) => (
              <option key={days} value={days}>
                {days === 0 ? "The same day" : `${days} day${days === 1 ? "" : "s"}`}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {data.error ? <Notice tone="error">{data.error}</Notice> : null}
      {calibration ? (
        calibration.groups.length ? (
          calibration.groups.map((group) => (
            <div key={group.method}>
              <h3>Against {PASTURE_METHOD_LABELS[group.method].toLowerCase()} readings</h3>
              <p>{group.text}</p>
              <details>
                <summary>The {group.count} check{group.count === 1 ? "" : "s"}</summary>
                <ul className={styles.history}>
                  {group.pairs.map((pair) => (
                    <li key={`${pair.estimateId}-${pair.readingId}`}>
                      Paddock {pair.paddockName}: photo {formatDate(pair.takenOn)} {coverText(pair.estimate)}; reading {formatDate(pair.measuredOn)} {coverText(pair.reading)} ({pair.difference > 0 ? "+" : ""}
                      {pair.difference.toLocaleString("en-NZ")})
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          ))
        ) : (
          <p className={ui.muted}>
            {calibration.estimates ? `None of the ${calibration.estimates} photo estimate${calibration.estimates === 1 ? "" : "s"} had another reading of the same paddock within that time.` : "No photo estimates yet."} To compare, take a photo when you read a paddock with a plate meter, or when a satellite or imported reading is made.
          </p>
        )
      ) : (
        <p className={ui.muted}>Loading…</p>
      )}
    </Card>
  );
}
