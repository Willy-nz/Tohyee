"use client";

import QRCode from "qrcode";
import Link from "next/link";
import { useEffect, useState } from "react";
import { DateInput } from "@/components/date-input";
import { newOperationId } from "@/components/farm-safety";
import { useApiData } from "@/components/hooks";
import { type PickedFile, pickSafetyFile, submitThroughQueue, useOfflineQueue, waitForFiles } from "@/components/offline-queue";
import { useOnline } from "@/components/offline-support";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { Farm } from "@/lib/farming/paddocks";
import { formatDate, formatDateTime, todayInBrowser } from "@/lib/format";
import type { EquipmentView } from "@/lib/safety/equipment";
import type { SafetyFile } from "@/lib/safety/files";
import type { ChemicalView, TrainingView } from "@/lib/safety/register";
import styles from "./farm-safety.module.css";
import { checksOnDevice, recordAnchor, safetyHref, sentChecks } from "@/lib/safety/screens";
import { type CheckData, type ChecklistData, type CurrentRecord, EQUIPMENT_OWNER_LABELS, EQUIPMENT_OWNERS, type EquipmentOwner, LOCKOUT_NOTE, NOBODY_MESSAGED, SDS_CHECK, sentLaterText, SDS_RULE, TRAINING_STATE_LABELS } from "@/lib/safety/shared";

/*
 * Equipment and pre-start checks, the training register and the chemicals
 * inventory on the Safety page (#446, decisions 953-957).
 */

type Person = { userId: string; name: string; role: string };
type EquipmentData = { equipment: EquipmentView[]; checklists: Array<CurrentRecord<ChecklistData>>; canRecord: boolean; canReport: boolean; canChooseReleasers: boolean; people: Person[]; fixedAssets: Array<{ id: string; name: string }> };

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(action: () => Promise<T>, done?: (result: T) => void) {
    setBusy(true);
    setError(null);
    try {
      done?.(await action());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

async function upload(organisationId: string, farmId: string, file: File) {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < buffer.length; index += 0x8000) binary += String.fromCharCode(...buffer.subarray(index, index + 0x8000));
  return (await api<{ file: SafetyFile }>("/api/farming/safety/files", { method: "POST", body: { organisationId, farmId, fileName: file.name, contentType: file.type, contentBase64: btoa(binary), phoneFileTime: new Date(file.lastModified).toISOString() } })).file;
}

// Equipment ----------------------------------------------------------------------------------------------

/**
 * Equipment and pre-start checks. With `openEquipment` (a machine's QR code,
 * or Check equipment › a machine) only that machine shows, its check open
 * (decision 981); otherwise the machines, with a search when there are more
 * than a few.
 */
export function EquipmentCard({ organisationId, farm, openEquipment }: { organisationId: string; farm: Farm; openEquipment: string | null }) {
  const data = useApiData<EquipmentData>("/api/farming/safety/equipment", { organisationId, farmId: farm.id });
  const { items: queued } = useOfflineQueue(organisationId);
  // A check sent from this device (the signal came back): read the machines again so it shows (decision 1047).
  const sent = sentChecks(queued, farm.id);
  const { reload } = data;
  useEffect(() => {
    if (sent) reload();
  }, [sent, reload]);
  const [checking, setChecking] = useState<string | null>(openEquipment);
  const [adding, setAdding] = useState<"equipment" | "checklist" | null>(null);
  const [search, setSearch] = useState("");
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return <p className={ui.muted}>Loading equipment…</p>;
  const { equipment, checklists, canRecord, canReport } = data.data;
  const live = equipment.filter((item) => item.change !== "withdrawn" && !item.data.retired);
  const out = live.filter((item) => !item.available);
  const only = openEquipment ? live.find((item) => item.recordId === openEquipment) ?? null : null;
  if (openEquipment && !only) {
    return (
      <Card title="Machine not found">
        <Notice tone="warning">That machine isn&apos;t on {farm.name}, or it has been retired. Check the farm at the top, or choose the machine from the list.</Notice>
        <Link href={safetyHref({ farmId: farm.id, screen: "equipment" })}>All equipment on {farm.name}</Link>
      </Card>
    );
  }
  const words = search.trim().toLowerCase();
  const shown = only ? [only] : words ? live.filter((item) => `${item.data.name} ${item.data.type ?? ""} ${item.data.ownerName ?? ""}`.toLowerCase().includes(words)) : live;
  return (
    <Card
      title={only ? `${only.data.name}` : `Equipment and pre-start checks${out.length ? ` (${out.length} out of use)` : ""}`}
      description={only ? `On ${farm.name}. Check it before using it.` : "Check a machine before using it. A failed critical check puts it out of use until someone allowed releases it."}
      actions={
        canRecord && !adding && !only ? (
          <>
            <Button size="small" variant="secondary" onClick={() => setAdding("equipment")}>
              Add equipment
            </Button>
            <Button size="small" variant="secondary" onClick={() => setAdding("checklist")}>
              Add a checklist
            </Button>
          </>
        ) : null
      }
    >
      {adding === "equipment" ? <EquipmentForm organisationId={organisationId} farm={farm} data={data.data} onDone={() => { setAdding(null); data.reload(); }} onCancel={() => setAdding(null)} /> : null}
      {adding === "checklist" ? <ChecklistForm organisationId={organisationId} farm={farm} onDone={() => { setAdding(null); data.reload(); }} onCancel={() => setAdding(null)} /> : null}
      {!live.length ? <Empty>No equipment yet. Add the machines people use here, ours, hired or a contractor&apos;s, with a checklist for each.</Empty> : null}
      {!only && live.length > 4 ? (
        <Field label="Find a machine">
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name or type, e.g. quad" />
        </Field>
      ) : null}
      {words && !shown.length ? <p className={ui.muted}>No machine matches &ldquo;{search.trim()}&rdquo; on {farm.name}.</p> : null}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {shown.map((item) => (
          <li key={item.recordId} id={recordAnchor("equipment", item.recordId)} style={{ borderTop: only ? 0 : "1px solid var(--border)", padding: "10px 0", scrollMarginTop: 72 }}>
            {only ? null : <strong>{item.data.name}</strong>} {item.available && !checksOnDevice(queued, farm.id, item.recordId).faults.length ? <Badge tone="green">In use</Badge> : <Badge tone="red">Out of use</Badge>} {item.data.owner !== "owned" ? <Badge>{EQUIPMENT_OWNER_LABELS[item.data.owner]}</Badge> : null}
            <div className={ui.muted} style={{ fontSize: "var(--text-sm)" }}>
              {[item.data.type, item.data.ownerName, item.checklist ? `checklist: ${item.checklist.data.title}` : "no checklist yet", item.lastCheck ? `last checked ${formatDateTime(item.lastCheck.enteredAt)} by ${item.lastCheck.enteredByName || item.lastCheck.enteredByEmail}${item.lastCheck.data.passed ? "" : " (faults)"}` : "not checked yet"].filter(Boolean).join(" · ")}
            </div>
            {checksOnDevice(queued, farm.id, item.recordId).faults.map((check) => (
              <div key={check.operationId} style={{ color: "var(--danger, #c81e1e)" }}>
                <Badge tone="red">Fault on this device</Badge> Failed a critical check here ({check.criticalFaults.join("; ")}), not sent yet: don&apos;t use it. Nobody has been told yet.
              </div>
            ))}
            {checksOnDevice(queued, farm.id, item.recordId).waiting.map((check) => (
              <div key={check.operationId}>
                <Badge tone="amber">Checked on this device</Badge> {check.status === "attention" ? "Tohyee refused this check: see Recorded on this device on Safety." : "Saved here, waiting to send. It goes by itself when Tohyee can be reached."}
              </div>
            ))}
            {item.failedCheck ? (
              <div style={{ color: "var(--danger, #c81e1e)" }}>
                Failed {formatDateTime(item.failedCheck.enteredAt)}: {item.failedCheck.data.answers.filter((answer) => answer.critical && answer.result === "fault").map((answer) => `${answer.text} (${answer.note})`).join("; ")}. {LOCKOUT_NOTE}
                {sentLaterText(item.failedCheck.data.phoneTime, item.failedCheck.firstEnteredAt, formatDateTime) ? <div className={ui.muted}>{sentLaterText(item.failedCheck.data.phoneTime, item.failedCheck.firstEnteredAt, formatDateTime)} Out of use from when it reached Tohyee.</div> : null}
              </div>
            ) : null}
            <div className={ui.actions} style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
              {canReport && item.checklist && !only ? (
                <Link className={styles.rowButton} href={safetyHref({ farmId: farm.id, screen: "equipment", equipment: item.recordId })}>
                  Check {item.data.name}
                </Link>
              ) : null}
              {canReport && item.checklist && only && checking !== item.recordId ? (
                <Button onClick={() => setChecking(item.recordId)}>Start the pre-start check</Button>
              ) : null}
              {canReport && !item.checklist ? <span className={ui.muted}>No checklist yet: someone who keeps the registers adds one.</span> : null}
              {canRecord ? <QrButton farm={farm} item={item} /> : null}
            </div>
            {checking === item.recordId && item.checklist ? <CheckForm organisationId={organisationId} farm={farm} item={item} checklist={item.checklist} onCancel={() => setChecking(null)} onDone={() => { setChecking(null); data.reload(); }} /> : null}
            {item.failedCheck && item.canRelease ? <ReleaseForm organisationId={organisationId} farm={farm} item={item} onDone={data.reload} /> : null}
            {item.failedCheck && !item.canRelease ? <p className={ui.muted}>An owner, an admin or someone named on this equipment can release it.</p> : null}
            <details>
              <summary>Checks</summary>
              <CheckHistory organisationId={organisationId} equipmentId={item.recordId} />
            </details>
          </li>
        ))}
      </ul>
      {checklists.length && canRecord && !only ? (
        <p className={ui.muted}>
          Checklists: {checklists.filter((checklist) => checklist.change !== "withdrawn").map((checklist) => `${checklist.data.title} (version ${checklist.version}, ${checklist.data.items.length} checks)`).join("; ")}. Changing a checklist never changes checks already done.
        </p>
      ) : null}
    </Card>
  );
}

function QrButton({ farm, item }: { farm: Farm; item: EquipmentView }) {
  const [svg, setSvg] = useState<string | null>(null);
  return (
    <>
      <Button
        size="small"
        variant="secondary"
        onClick={() => {
          if (svg) return setSvg(null);
          const url = `${window.location.origin}${safetyHref({ farmId: farm.id, equipment: item.recordId })}`;
          void QRCode.toString(url, { type: "svg", margin: 1 }).then(setSvg);
        }}
      >
        {svg ? "Hide QR code" : "QR code"}
      </Button>
      {svg ? (
        <div style={{ width: "100%" }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- an SVG made here, as a data address */}
          <img src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} alt={`QR code to check ${item.data.name}`} style={{ width: 160, height: 160, background: "#fff", padding: 6, borderRadius: 6 }} />
          <div className={ui.muted}>Print it and stick it on {item.data.name}: scanning it opens the pre-start check (after signing in).</div>
        </div>
      ) : null}
    </>
  );
}

/**
 * A pre-start check (decision 981): the machine and farm stay in view, each
 * check has large OK / Fault / Not applicable choices with nothing chosen
 * to start with, and a fault asks what's wrong and offers a photo.
 */
function CheckForm({ organisationId, farm, item, checklist, onDone, onCancel }: { organisationId: string; farm: Farm; item: EquipmentView; checklist: CurrentRecord<ChecklistData>; onDone: () => void; onCancel: () => void }) {
  const [answers, setAnswers] = useState<Record<string, { result: string; note: string }>>({});
  const [hours, setHours] = useState("");
  const [photos, setPhotos] = useState<PickedFile[]>([]);
  const [operationId] = useState(newOperationId);
  const [outcome, setOutcome] = useState<string | null>(null);
  const { busy, error, run } = useRun();
  const { queue } = useOfflineQueue(organisationId);
  const criticalFaults = checklist.data.items.filter((entry) => entry.critical && answers[entry.key]?.result === "fault").map((entry) => entry.text);
  const complete = checklist.data.items.every((entry) => answers[entry.key]?.result && (answers[entry.key].result !== "fault" || answers[entry.key].note.trim()));
  const answered = checklist.data.items.filter((entry) => answers[entry.key]?.result).length;
  const anyFault = Object.values(answers).some((answer) => answer.result === "fault");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // Against the checklist version shown (decision 954), kept on this device first (decision 1013).
        void run(
          () =>
            submitThroughQueue(queue, {
              operationId,
              kind: "safety.check",
              label: `Pre-start check: ${item.data.name}${criticalFaults.length ? " (critical fault)" : ""}`,
              farmId: farm.id,
              farmName: farm.name,
              meta: { equipmentId: item.recordId, criticalFaults },
              request: {
                method: "POST",
                path: "/api/farming/safety/checks",
                body: { equipmentId: item.recordId, checklistId: checklist.recordId, checklistVersion: checklist.version, phoneTime: new Date().toISOString(), hoursOrKm: hours, files: photos.map((file) => ({ id: file.id })), answers: checklist.data.items.map((entry) => ({ key: entry.key, result: answers[entry.key]?.result, note: answers[entry.key]?.note })) },
                refs: waitForFiles(photos, ["files"]),
              },
            }),
          (result) => {
            if (result.state === "synced") setOutcome((result.result as { outOfUse?: boolean }).outOfUse ? `${item.data.name} is now out of use and an action has been made to fix it. Don't use it. ${LOCKOUT_NOTE} ${NOBODY_MESSAGED}` : "Check saved.");
            else setOutcome(criticalFaults.length ? `Saved on this device: ${item.data.name} failed a critical check, so don't use it. Nobody has been told yet: tell whoever is in charge. Tohyee records it, puts it out of use and makes the action when it's sent.` : "Check saved on this device, waiting to send.");
            setTimeout(onDone, result.state === "synced" ? 1500 : 4000);
          },
        );
      }}
      className={styles.checkForm}
      aria-label={`Pre-start check of ${item.data.name} on ${farm.name}`}
    >
      <div className={styles.checkHeader}>
        <strong>{item.data.name}</strong> <span className={ui.muted}>on {farm.name}</span>
        <div className={ui.muted} style={{ fontSize: "var(--text-sm)" }}>
          {checklist.data.title}, version {checklist.version} · {answered} of {checklist.data.items.length} answered
        </div>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {outcome ? <Notice tone={outcome.startsWith("Check saved.") ? "success" : "warning"}>{outcome}</Notice> : null}
      {checklist.data.items.map((entry) => {
        const answer = answers[entry.key] ?? { result: "", note: "" };
        return (
          <fieldset key={entry.key} className={styles.checkItem}>
            <legend>
              {entry.text} {entry.critical ? <Badge tone="red">Critical</Badge> : null}
            </legend>
            <div className={styles.choices}>
              {(["ok", "fault", ...(entry.critical ? [] : ["na"])] as const).map((result) => (
                <label key={result} className={styles.choice} data-result={result}>
                  <input type="radio" name={`${item.recordId}-${entry.key}`} checked={answer.result === result} onChange={() => setAnswers({ ...answers, [entry.key]: { ...answer, result } })} />
                  <span>{result === "ok" ? "OK" : result === "fault" ? "Fault" : "Not applicable"}</span>
                </label>
              ))}
            </div>
            {answer.result === "fault" ? (
              <Field label="What's wrong">
                <input value={answer.note} maxLength={1000} required onChange={(event) => setAnswers({ ...answers, [entry.key]: { ...answer, note: event.target.value } })} />
              </Field>
            ) : null}
          </fieldset>
        );
      })}
      {anyFault ? (
        <label className={ui.fieldLabel}>
          Photo of the fault (optional)
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            style={{ display: "block", minHeight: 44 }}
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              event.target.value = "";
              if (chosen) void run(() => pickSafetyFile(queue, { farm, file: chosen }), (file) => setPhotos([...photos, file]));
            }}
          />
        </label>
      ) : null}
      {photos.length ? <p className={ui.muted}>{photos.length} photo(s) kept{photos.some((file) => file.pending) ? " (on this device until sent)" : ""}.</p> : null}
      <Field label="Hours or km (optional)">
        <input inputMode="decimal" value={hours} maxLength={30} onChange={(event) => setHours(event.target.value)} />
      </Field>
      <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
        <Button type="submit" disabled={busy || !complete || Boolean(outcome)}>
          {busy ? "Saving…" : `Save the check of ${item.data.name}`}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {!complete && !outcome ? <p className={ui.muted}>Answer every check to save. A fault needs a few words on what&apos;s wrong.</p> : null}
    </form>
  );
}

function ReleaseForm({ organisationId, farm, item, onDone }: { organisationId: string; farm: Farm; item: EquipmentView; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const online = useOnline();
  const [whatWasDone, setWhatWasDone] = useState("");
  const [photos, setPhotos] = useState<SafetyFile[]>([]);
  const { busy, error, run } = useRun();
  if (!open) {
    return (
      <Button size="small" variant="secondary" onClick={() => setOpen(true)}>
        Release it for use
      </Button>
    );
  }
  return (
    <form onSubmit={(event) => { event.preventDefault(); void run(() => api("/api/farming/safety/releases", { method: "POST", body: { organisationId, equipmentId: item.recordId, whatWasDone, files: photos.map((file) => ({ id: file.id })) } }), onDone); }} style={{ marginTop: 8 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="What was done to make it safe">
        <textarea value={whatWasDone} required rows={2} maxLength={2000} onChange={(event) => setWhatWasDone(event.target.value)} />
      </Field>
      <label className={ui.fieldLabel}>
        Photo (optional)
        <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" style={{ display: "block" }} onChange={(event) => { const chosen = event.target.files?.[0]; event.target.value = ""; if (chosen) void run(() => upload(organisationId, farm.id, chosen), (file) => setPhotos([...photos, file])); }} />
      </label>
      {!online ? <p className={ui.muted}>Releasing a machine needs a connection: Tohyee checks at the time who may release it (decision 955), so it can&apos;t wait on this device.</p> : null}
      <Button type="submit" disabled={busy || !whatWasDone.trim() || !online}>
        Release it
      </Button>
      <p className={ui.muted}>It&apos;s recorded with your name and the time. Take the tag off the machine yourself.</p>
    </form>
  );
}

function CheckHistory({ organisationId, equipmentId }: { organisationId: string; equipmentId: string }) {
  const checks = useApiData<{ checks: Array<CurrentRecord<CheckData>> }>(`/api/farming/safety/equipment/${equipmentId}/checks`, { organisationId });
  if (checks.error) return <Notice tone="error">{checks.error}</Notice>;
  if (!checks.data) return <p className={ui.muted}>Loading…</p>;
  if (!checks.data.checks.length) return <p className={ui.muted}>No checks yet.</p>;
  return (
    <ul style={{ paddingLeft: 18 }}>
      {checks.data.checks.map((check) => (
        <li key={check.recordId}>
          {formatDateTime(check.enteredAt)} by {check.enteredByName || check.enteredByEmail}: {check.data.passed ? "passed" : check.data.criticalFault ? "FAILED (critical)" : "faults"}
          {check.data.hoursOrKm ? ` · ${check.data.hoursOrKm}` : ""} <span className={ui.muted}>(checklist version {check.data.checklistVersion})</span>
          {sentLaterText(check.data.phoneTime, check.firstEnteredAt, formatDateTime) ? <div className={ui.muted}>{sentLaterText(check.data.phoneTime, check.firstEnteredAt, formatDateTime)}</div> : null}
          {check.data.passed ? null : <div className={ui.muted}>{check.data.answers.filter((answer) => answer.result === "fault").map((answer) => `${answer.text}: ${answer.note}`).join("; ")}</div>}
        </li>
      ))}
    </ul>
  );
}

function EquipmentForm({ organisationId, farm, data, onDone, onCancel }: { organisationId: string; farm: Farm; data: EquipmentData; onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState({ name: "", type: "", owner: "owned" as EquipmentOwner, ownerName: "", checklistId: data.checklists[0]?.recordId ?? "", fixedAssetId: "", responsibleUserId: "", releaserUserIds: [] as string[] });
  const [operationId] = useState(newOperationId);
  const { busy, error, run } = useRun();
  return (
    <form onSubmit={(event) => { event.preventDefault(); void run(() => api("/api/farming/safety/equipment", { method: "POST", body: { organisationId, operationId, farmId: farm.id, ...form, checklistId: form.checklistId || null, fixedAssetId: form.fixedAssetId || null, responsibleUserId: form.responsibleUserId || null } }), onDone); }} style={{ margin: "8px 0 12px", padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Name">
          <input value={form.name} required maxLength={150} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Honda quad" />
        </Field>
        <Field label="Type">
          <input value={form.type} maxLength={100} onChange={(event) => setForm({ ...form, type: event.target.value })} placeholder="Quad bike" />
        </Field>
        <Field label="Whose">
          <select value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value as EquipmentOwner })}>
            {EQUIPMENT_OWNERS.map((owner) => (
              <option key={owner} value={owner}>
                {EQUIPMENT_OWNER_LABELS[owner]}
              </option>
            ))}
          </select>
        </Field>
        {form.owner !== "owned" ? (
          <Field label="Whose (name)">
            <input value={form.ownerName} maxLength={150} onChange={(event) => setForm({ ...form, ownerName: event.target.value })} />
          </Field>
        ) : null}
      </div>
      <div className={ui.inlineForm}>
        <Field label="Checklist">
          <select value={form.checklistId} onChange={(event) => setForm({ ...form, checklistId: event.target.value })}>
            <option value="">None yet</option>
            {data.checklists.filter((checklist) => checklist.change !== "withdrawn").map((checklist) => (
              <option key={checklist.recordId} value={checklist.recordId}>
                {checklist.data.title}
              </option>
            ))}
          </select>
        </Field>
        {form.owner === "owned" && data.fixedAssets.length ? (
          <Field label="Fixed asset (optional)">
            <select value={form.fixedAssetId} onChange={(event) => setForm({ ...form, fixedAssetId: event.target.value })}>
              <option value="">Not in the books</option>
              {data.fixedAssets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Responsible">
          <select value={form.responsibleUserId} onChange={(event) => setForm({ ...form, responsibleUserId: event.target.value })}>
            <option value="">Whoever checks it</option>
            {data.people.map((person) => (
              <option key={person.userId} value={person.userId}>
                {person.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {data.canChooseReleasers && data.people.some((person) => person.role !== "owner" && person.role !== "admin") ? (
        <fieldset style={{ border: 0, padding: 0, margin: "4px 0" }}>
          <legend className={ui.fieldLabel}>Can release it after a failed check (owners and admins always can)</legend>
          {data.people.filter((person) => person.role !== "owner" && person.role !== "admin").map((person) => (
            <label key={person.userId} className={ui.checkbox} style={{ marginRight: 12 }}>
              <input type="checkbox" checked={form.releaserUserIds.includes(person.userId)} onChange={(event) => setForm({ ...form, releaserUserIds: event.target.checked ? [...form.releaserUserIds, person.userId] : form.releaserUserIds.filter((id) => id !== person.userId) })} /> {person.name}
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !form.name.trim()}>
          Add equipment
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ChecklistForm({ organisationId, farm, onDone, onCancel }: { organisationId: string; farm: Farm; onDone: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState("Pre-start check");
  const [shared, setShared] = useState(true);
  const [items, setItems] = useState([
    { text: "Brakes work", critical: true },
    { text: "Tyres and wheels look right", critical: true },
    { text: "Steering and throttle return freely", critical: true },
    { text: "Lights work", critical: false },
    { text: "Helmet and gear on hand", critical: false },
  ]);
  const { busy, error, run } = useRun();
  return (
    <form onSubmit={(event) => { event.preventDefault(); void run(() => api("/api/farming/safety/checklists", { method: "POST", body: { organisationId, farmId: shared ? null : farm.id, title, items: items.filter((entry) => entry.text.trim()) } }), onDone); }} style={{ margin: "8px 0 12px", padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Checklist name">
        <input value={title} required maxLength={150} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <label className={ui.checkbox}>
        <input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} /> Use on every farm
      </label>
      {items.map((entry, index) => (
        <div key={index} className={ui.inlineForm}>
          <Field label={`Check ${index + 1}`}>
            <input value={entry.text} maxLength={300} onChange={(event) => setItems(items.map((each, at) => (at === index ? { ...each, text: event.target.value } : each)))} />
          </Field>
          <label className={ui.checkbox}>
            <input type="checkbox" checked={entry.critical} onChange={(event) => setItems(items.map((each, at) => (at === index ? { ...each, critical: event.target.checked } : each)))} /> Critical: a fault puts it out of use
          </label>
        </div>
      ))}
      <Button size="small" variant="secondary" onClick={() => setItems([...items, { text: "", critical: false }])}>
        Add a check
      </Button>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          Add checklist
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// Training ------------------------------------------------------------------------------------------------

export function TrainingCard({ organisationId, farm }: { organisationId: string; farm: Farm }) {
  const data = useApiData<{ training: TrainingView[]; canRecord: boolean; people: Person[]; userId: string }>("/api/farming/safety/training", { organisationId });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ userId: "", name: "", company: "", what: "", provider: "", completedOn: todayInBrowser(), expiresOn: "", certificate: "", canDo: "" });
  const [file, setFile] = useState<SafetyFile | null>(null);
  const { busy, error, run } = useRun();
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return <p className={ui.muted}>Loading training…</p>;
  const live = data.data.training.filter((record) => record.state !== "withdrawn");
  const attention = live.filter((record) => record.state === "expired" || record.state === "expiring").length;
  return (
    <Card
      title={`Training and qualifications${attention ? ` (${attention} to renew)` : ""}`}
      description="Who's trained for what, and when it runs out (for every farm). WorkSafe's farm guide suggests noting which jobs each person can and can't do."
      actions={data.data.canRecord && !adding ? <Button size="small" variant="secondary" onClick={() => setAdding(true)}>Add training</Button> : null}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {adding ? (
        <form onSubmit={(event) => { event.preventDefault(); void run(() => api("/api/farming/safety/training", { method: "POST", body: { organisationId, person: form.userId ? { userId: form.userId } : { name: form.name, company: form.company }, what: form.what, provider: form.provider, completedOn: form.completedOn, expiresOn: form.expiresOn || null, certificate: form.certificate, canDo: form.canDo, files: file ? [{ id: file.id }] : [] } }), () => { setAdding(false); data.reload(); }); }} style={{ margin: "8px 0 12px", padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}>
          <div className={ui.inlineForm}>
            <Field label="Who">
              <select value={form.userId} onChange={(event) => setForm({ ...form, userId: event.target.value })}>
                <option value="">Someone without a login…</option>
                {data.data.people.map((person) => (
                  <option key={person.userId} value={person.userId}>
                    {person.name}
                  </option>
                ))}
              </select>
            </Field>
            {!form.userId ? (
              <>
                <Field label="Their name">
                  <input value={form.name} required maxLength={150} onChange={(event) => setForm({ ...form, name: event.target.value })} />
                </Field>
                <Field label="Company">
                  <input value={form.company} maxLength={150} onChange={(event) => setForm({ ...form, company: event.target.value })} />
                </Field>
              </>
            ) : null}
          </div>
          <div className={ui.inlineForm}>
            <Field label="Training or qualification">
              <input value={form.what} required maxLength={200} onChange={(event) => setForm({ ...form, what: event.target.value })} placeholder="e.g. Quad bike, First aid, Growsafe" />
            </Field>
            <Field label="Who gave it">
              <input value={form.provider} maxLength={150} onChange={(event) => setForm({ ...form, provider: event.target.value })} />
            </Field>
            <Field label="Done on">
              <DateInput value={form.completedOn} onChange={(event) => setForm({ ...form, completedOn: event.target.value })} />
            </Field>
            <Field label="Expires">
              <DateInput value={form.expiresOn} onChange={(event) => setForm({ ...form, expiresOn: event.target.value })} />
            </Field>
            <Field label="Certificate number">
              <input value={form.certificate} maxLength={100} onChange={(event) => setForm({ ...form, certificate: event.target.value })} />
            </Field>
          </div>
          <Field label="Jobs it covers, or limits">
            <input value={form.canDo} maxLength={1000} onChange={(event) => setForm({ ...form, canDo: event.target.value })} placeholder="e.g. quad on the flat; not on the hill block yet" />
          </Field>
          <label className={ui.fieldLabel}>
            Certificate (photo or PDF, optional)
            <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" style={{ display: "block" }} onChange={(event) => { const chosen = event.target.files?.[0]; event.target.value = ""; if (chosen) void run(() => upload(organisationId, farm.id, chosen), setFile); }} />
          </label>
          <div className={ui.actions}>
            <Button type="submit" disabled={busy || !form.what.trim() || (!form.userId && !form.name.trim())}>
              Add training
            </Button>
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {!live.length ? <Empty>No training recorded yet.</Empty> : null}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {live.map((record) => (
          <li key={record.recordId} id={recordAnchor("training", record.recordId)} style={{ borderTop: "1px solid var(--border)", padding: "8px 0", scrollMarginTop: 72 }}>
            <strong>{record.data.person.name}</strong>: {record.data.what}{" "}
            <Badge tone={record.state === "expired" ? "red" : record.state === "expiring" ? "amber" : "green"}>{TRAINING_STATE_LABELS[record.state]}</Badge>
            {record.data.confirmedByPerson ? <> <Badge tone="blue">Confirmed by them</Badge></> : null}
            <div className={ui.muted} style={{ fontSize: "var(--text-sm)" }}>
              {[record.happenedOn ? `done ${formatDate(record.happenedOn)}` : null, record.data.expiresOn ? `expires ${formatDate(record.data.expiresOn)}` : null, record.data.provider, record.data.canDo].filter(Boolean).join(" · ")}
            </div>
            {record.data.person.userId === data.data!.userId && !record.data.confirmedByPerson ? (
              <Button size="small" variant="secondary" disabled={busy} onClick={() => void run(() => api(`/api/farming/safety/training/${record.recordId}`, { method: "POST", body: { organisationId, step: "confirm", expectedVersion: record.version } }), data.reload)}>
                This is right: confirm it&apos;s mine
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// Chemicals ----------------------------------------------------------------------------------------------

export function ChemicalsCard({ organisationId, farm }: { organisationId: string; farm: Farm }) {
  const data = useApiData<{ chemicals: ChemicalView[]; canRecord: boolean }>("/api/farming/safety/chemicals", { organisationId, farmId: farm.id });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", unNumber: "", maxQuantity: "", unit: "L", location: "", storage: "", hazards: "", sdsDate: "", approvedHandler: false });
  const [sheet, setSheet] = useState<SafetyFile | null>(null);
  const { busy, error, run } = useRun();
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return <p className={ui.muted}>Loading chemicals…</p>;
  const list = data.data.chemicals.filter((chemical) => chemical.change !== "withdrawn");
  const needed = list.filter((chemical) => chemical.sdsNeeded).length;
  return (
    <Card
      title={`Chemicals and fuel${needed ? ` (${needed} need a safety data sheet)` : ""}`}
      description={`This farm's hazardous substances inventory: what's here, the most likely on site, where, and its safety data sheet. WorkSafe asks for it to be easy to find in an emergency. ${SDS_RULE}`}
      actions={
        <>
          <Button size="small" variant="secondary" onClick={() => window.print()}>
            Print
          </Button>
          {data.data.canRecord && !adding ? (
            <Button size="small" variant="secondary" onClick={() => setAdding(true)}>
              Add a chemical
            </Button>
          ) : null}
        </>
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {adding ? (
        <form onSubmit={(event) => { event.preventDefault(); void run(() => api("/api/farming/safety/chemicals", { method: "POST", body: { organisationId, farmId: farm.id, ...form, maxQuantity: form.maxQuantity || null, unit: form.maxQuantity ? form.unit : null, sdsDate: form.sdsDate || null, sds: sheet ? { id: sheet.id } : null } }), () => { setAdding(false); setSheet(null); data.reload(); }); }} style={{ margin: "8px 0 12px", padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}>
          <div className={ui.inlineForm}>
            <Field label="Name">
              <input value={form.name} required maxLength={150} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </Field>
            <Field label="UN number">
              <input value={form.unNumber} maxLength={10} onChange={(event) => setForm({ ...form, unNumber: event.target.value })} placeholder="1202" />
            </Field>
            <Field label="Most on site">
              <input inputMode="decimal" value={form.maxQuantity} maxLength={20} onChange={(event) => setForm({ ...form, maxQuantity: event.target.value })} />
            </Field>
            <Field label="Unit">
              <input value={form.unit} maxLength={20} onChange={(event) => setForm({ ...form, unit: event.target.value })} />
            </Field>
          </div>
          <div className={ui.inlineForm}>
            <Field label="Where it's kept">
              <input value={form.location} maxLength={200} onChange={(event) => setForm({ ...form, location: event.target.value })} />
            </Field>
            <Field label="Storage">
              <input value={form.storage} maxLength={1000} onChange={(event) => setForm({ ...form, storage: event.target.value })} placeholder="e.g. bunded, locked, away from oxidisers" />
            </Field>
            <Field label="Hazards">
              <input value={form.hazards} maxLength={1000} onChange={(event) => setForm({ ...form, hazards: event.target.value })} placeholder="e.g. flammable" />
            </Field>
          </div>
          <div className={ui.inlineForm}>
            <label className={ui.fieldLabel}>
              Safety data sheet (PDF)
              <input type="file" accept="application/pdf" style={{ display: "block" }} onChange={(event) => { const chosen = event.target.files?.[0]; event.target.value = ""; if (chosen) void run(() => upload(organisationId, farm.id, chosen), setSheet); }} />
            </label>
            <Field label="Date on the sheet">
              <DateInput value={form.sdsDate} onChange={(event) => setForm({ ...form, sdsDate: event.target.value })} />
            </Field>
          </div>
          <label className={ui.checkbox}>
            <input type="checkbox" checked={form.approvedHandler} onChange={(event) => setForm({ ...form, approvedHandler: event.target.checked })} /> Needs an approved handler
          </label>
          <div className={ui.actions}>
            <Button type="submit" disabled={busy || !form.name.trim()}>
              Add chemical
            </Button>
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {!list.length ? <Empty>Nothing listed yet. Any quantity of a hazardous substance means an inventory, WorkSafe says: fuel, sprays, dairy chemicals, gas.</Empty> : null}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {list.map((chemical) => (
          <li key={chemical.recordId} style={{ borderTop: "1px solid var(--border)", padding: "8px 0", opacity: chemical.data.removed ? 0.6 : 1 }}>
            <strong>{chemical.data.name}</strong>
            {chemical.data.unNumber ? ` (UN ${chemical.data.unNumber})` : ""}
            {chemical.data.maxQuantity ? ` · up to ${chemical.data.maxQuantity} ${chemical.data.unit ?? ""}` : ""}
            {chemical.data.removed ? " · removed" : ""}{" "}
            {chemical.sdsNeeded ? <Badge tone="amber">Safety data sheet needed</Badge> : null}
            {!chemical.data.removed && chemical.sdsStatus === "check" ? <Badge tone="blue">{SDS_CHECK}</Badge> : null}
            <div className={ui.muted} style={{ fontSize: "var(--text-sm)" }}>
              {[chemical.data.location, chemical.data.storage, chemical.data.hazards, chemical.data.approvedHandler ? "approved handler needed" : null].filter(Boolean).join(" · ")}
            </div>
            {chemical.data.sds ? (
              <a href={`/api/farming/safety/files/${chemical.data.sds.id}?organisationId=${encodeURIComponent(organisationId)}`} target="_blank" rel="noreferrer">
                Safety data sheet{chemical.data.sdsDate ? ` (${formatDate(chemical.data.sdsDate)})` : ""}
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
