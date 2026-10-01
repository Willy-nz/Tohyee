"use client";

import Link from "next/link";
import { type ChangeEvent, type FormEvent, type ReactNode, useState } from "react";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, ApiError, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, personName, todayInBrowser } from "@/lib/format";
import type { AssetRd, UsageEntry } from "@/lib/rd/assets";
import {
  incomeYearLabel,
  incomeYearOf,
  RD_CATEGORY_LABELS,
  RD_FLAG_LABELS,
  RD_FLAGS,
  RD_INELIGIBLE_REASON_CODES,
  RD_INELIGIBLE_REASONS,
  RD_LATE_AFTER_DAYS,
  RD_LINE_CATEGORIES,
  RD_PLACE_LABELS,
  type RdActivityKind,
  type RdFlag,
  type RdIneligibleReason,
  type RdLineCategory,
  type RdPlace,
} from "@/lib/rd/amounts";
import type { HistoryEntry, Timeliness } from "@/lib/rd/common";
import type { RdCosts, RdCostActivity } from "@/lib/rd/costs";
import type { RdFile, RdFilePurpose } from "@/lib/rd/files";
import type { RdActivity, RdActivityDetail, RdActivityRef, RdApproval } from "@/lib/rd/register";
import type { RdDocumentType, RdLine, RdTag, RdTagDetail } from "@/lib/rd/tags";

/**
 * The R&D Tax Incentive screens for stage R2 (examples RD1-RD3, RD8, RD9,
 * RD11-RD13, RD21-RD23): the activity register, approvals with their letters,
 * the tag picker used on bills, expense claims and journals, an asset's tax
 * depreciation and usage log, and tagged costs by activity and category. The
 * claim itself (limits, the minimum, the 15% credit) is in rd-claim.tsx (R3).
 */

type ActivitiesResponse = { activities: RdActivity[]; yearEndMonth: number };

const MAX_FILE_BYTES = 10 * 1024 * 1024;

const KIND_LABELS: Record<RdActivityKind, string> = { core: "Core", supporting: "Supporting" };

const FILE_PURPOSE_LABELS: Record<RdFilePurpose, string> = {
  approval_letter: "IRD approval letter",
  contractor_statement: "Contractor's statement",
  workings: "Workings",
  other: "Other",
};

const DESCRIPTION_FIELDS = [
  {
    key: "purposeAndUncertainty",
    label: "Purpose and uncertainty",
    hint: "What you set out to find out or make, and the scientific or technological uncertainty you had to resolve.",
  },
  {
    key: "whyNotPublicKnowledge",
    label: "Why it couldn't be worked out from what's publicly known",
    hint: "Why a competent professional in the field couldn't have resolved it from publicly available knowledge.",
  },
  {
    key: "systematicApproach",
    label: "Systematic approach",
    hint: "How you went about it: hypotheses, experiments or trials, observation, evaluation and conclusions.",
  },
] as const;

const WHY_REQUIRED = {
  key: "whyRequired",
  label: "Why it was required for the core activity",
  hint: "Supporting activities only: how it was required for, and integral to, the core activity.",
} as const;

export function useRdActivities(organisationId: string | null, includeArchived = false) {
  return useApiData<ActivitiesResponse>(organisationId ? "/api/rd/activities" : null, { organisationId, includeArchived: includeArchived ? "1" : null });
}

export function activityText(activity: Pick<RdActivityRef, "code" | "name">): string {
  return `${activity.code} ${activity.name}`;
}

export function fileUrl(organisationId: string, fileId: string, download = false): string {
  const query = new URLSearchParams({ organisationId });
  if (download) query.set("download", "1");
  return `/api/rd/files/${fileId}?${query.toString()}`;
}

export async function postForm<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(path, { method: "POST", body: form, credentials: "same-origin" });
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) throw new ApiError(payload?.error ?? `Upload failed (${response.status}).`, response.status);
  return payload as T;
}

export function tooBig(file: File): string | null {
  return file.size > MAX_FILE_BYTES ? `${file.name} is more than 10 MB. Files can be at most 10 MB.` : null;
}

/** "entered 3 days after the work", flagged when it's more than 14 days (decision 38). */
export function TimelinessBadge({ timeliness }: { timeliness: Timeliness }) {
  return (
    <span>
      {timeliness.enteredLate ? <Badge tone="amber">Entered late</Badge> : null} <span className={ui.muted}>{timeliness.timelinessText}</span>
    </span>
  );
}

function ActivityStatusBadges({ activity }: { activity: RdActivity }) {
  return (
    <>
      <Badge tone={activity.kind === "core" ? "blue" : "neutral"}>{KIND_LABELS[activity.kind]}</Badge>{" "}
      {activity.place === "overseas" ? <Badge tone="amber">Overseas</Badge> : null} {activity.status === "archived" ? <Badge>Archived</Badge> : null}
    </>
  );
}

function ApprovalBadge({ activity, yearEndMonth }: { activity: RdActivity; yearEndMonth: number }) {
  if (activity.approvedYears.length === 0) return <Badge tone="amber">No approval entered</Badge>;
  const first = Math.min(...activity.approvedYears);
  const last = Math.max(...activity.approvedYears);
  const years = first === last ? incomeYearLabel(first, yearEndMonth) : `${incomeYearLabel(first, yearEndMonth)} to ${incomeYearLabel(last, yearEndMonth)}`;
  return (
    <>
      <Badge tone="green">Approval entered: {years}</Badge> {activity.changedSinceApproval ? <Badge tone="amber">Changed since approval was entered</Badge> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// The register (RD1, RD2)

export function RdRegister({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const list = useRdActivities(organisationId, showArchived);
  if (list.error) return <Notice tone="error">{list.error}</Notice>;
  if (!list.data) return <p className={ui.muted}>Loading…</p>;
  const { activities, yearEndMonth } = list.data;
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      <Notice tone="info">
        Register each core and supporting R&amp;D activity here, then tag costs to it. Tohyee can&apos;t check approvals with IRD: enter IRD&apos;s approval
        letter on the activity yourself. Activities are archived, never deleted.
      </Notice>
      {adding ? (
        <Card title="Add an R&D activity">
          <ActivityForm
            organisationId={organisationId}
            activities={activities}
            yearEndMonth={yearEndMonth}
            onCancel={() => setAdding(false)}
            onSaved={(activity) => {
              setAdding(false);
              setMessage(`Added ${activityText(activity)}.`);
              list.reload();
            }}
          />
        </Card>
      ) : null}
      <Card
        title="R&D activities"
        actions={
          <>
            <label className={ui.checkbox}>
              <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived
            </label>
            {can("bookkeeper") && !adding ? <Button onClick={() => setAdding(true)}>Add an activity</Button> : null}
          </>
        }
      >
        {activities.length === 0 ? <Empty>No R&amp;D activities yet.</Empty> : null}
        {activities.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Activity</th>
                  <th>Project</th>
                  <th>Type</th>
                  <th>Income years</th>
                  <th>Approval</th>
                </tr>
              </thead>
              <tbody>
                {activities.map((activity) => (
                  <tr key={activity.id}>
                    <td data-label="Activity">
                      <Link href={`/operations/rd/${activity.id}`}>{activityText(activity)}</Link>
                    </td>
                    <td data-label="Project">{activity.projectName}</td>
                    <td data-label="Type">
                      <ActivityStatusBadges activity={activity} />
                      {activity.supports.length > 0 ? <div className={ui.muted}>Supports {activity.supports.map((core) => core.code).join(", ")}</div> : null}
                    </td>
                    <td data-label="Income years">{activity.yearsLabel}</td>
                    <td data-label="Approval">
                      <ApprovalBadge activity={activity} yearEndMonth={yearEndMonth} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </>
  );
}

type ActivityDraft = {
  code: string;
  name: string;
  projectName: string;
  kind: RdActivityKind;
  place: RdPlace;
  firstIncomeYear: string;
  lastIncomeYear: string;
  supports: string[];
  purposeAndUncertainty: string;
  whyNotPublicKnowledge: string;
  systematicApproach: string;
  whyRequired: string;
};

function draftFrom(activity: RdActivity | undefined, yearEndMonth: number): ActivityDraft {
  if (!activity) {
    return {
      code: "",
      name: "",
      projectName: "",
      kind: "core",
      place: "nz",
      firstIncomeYear: String(incomeYearOf(todayInBrowser(), yearEndMonth)),
      lastIncomeYear: "",
      supports: [],
      purposeAndUncertainty: "",
      whyNotPublicKnowledge: "",
      systematicApproach: "",
      whyRequired: "",
    };
  }
  return {
    code: activity.code,
    name: activity.name,
    projectName: activity.projectName,
    kind: activity.kind,
    place: activity.place,
    firstIncomeYear: String(activity.firstIncomeYear),
    lastIncomeYear: activity.lastIncomeYear == null ? "" : String(activity.lastIncomeYear),
    supports: activity.supports.map((core) => core.id),
    purposeAndUncertainty: activity.purposeAndUncertainty,
    whyNotPublicKnowledge: activity.whyNotPublicKnowledge,
    systematicApproach: activity.systematicApproach,
    whyRequired: activity.whyRequired,
  };
}

function ActivityForm({
  organisationId,
  activities,
  yearEndMonth,
  initial,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  activities: RdActivity[];
  yearEndMonth: number;
  initial?: RdActivity;
  onSaved: (activity: RdActivityDetail) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ActivityDraft>(() => draftFrom(initial, yearEndMonth));
  const [idempotencyKey] = useState(() => newIdempotencyKey("rd-activity"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ActivityDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const cores = activities.filter((activity) => activity.kind === "core" && activity.id !== initial?.id && (activity.status === "active" || draft.supports.includes(activity.id)));
  const yearHint = (value: string) => (/^\d{4}$/.test(value) ? `${incomeYearLabel(Number(value), yearEndMonth)} income year` : "The year the income year ends, like 2027.");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      organisationId,
      code: draft.code,
      name: draft.name,
      projectName: draft.projectName,
      kind: draft.kind,
      place: draft.kind === "core" ? "nz" : draft.place,
      firstIncomeYear: draft.firstIncomeYear,
      lastIncomeYear: draft.lastIncomeYear || null,
      supports: draft.kind === "core" ? [] : draft.supports,
      purposeAndUncertainty: draft.purposeAndUncertainty,
      whyNotPublicKnowledge: draft.whyNotPublicKnowledge,
      systematicApproach: draft.systematicApproach,
      whyRequired: draft.kind === "core" ? "" : draft.whyRequired,
    };
    try {
      const activity = initial
        ? (await api<{ activity: RdActivityDetail }>(`/api/rd/activities/${initial.id}`, { method: "PATCH", body: { ...body, version: initial.version } })).activity
        : (await api<{ activity: RdActivityDetail }>("/api/rd/activities", { method: "POST", body: { ...body, idempotencyKey } })).activity;
      onSaved(activity);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Code" hint="Short, like C1 or S2.">
          <input value={draft.code} maxLength={20} required onChange={(event) => set({ code: event.target.value })} />
        </Field>
        <Field label="Activity name">
          <input value={draft.name} maxLength={200} required onChange={(event) => set({ name: event.target.value })} />
        </Field>
        <Field label="Project" hint="IRD's grouping of related core and supporting activities.">
          <input value={draft.projectName} maxLength={200} required onChange={(event) => set({ projectName: event.target.value })} />
        </Field>
        <Field label="Type">
          <select value={draft.kind} onChange={(event) => set({ kind: event.target.value as RdActivityKind })}>
            <option value="core">Core</option>
            <option value="supporting">Supporting</option>
          </select>
        </Field>
        <Field label="Where it's performed" hint={draft.kind === "core" ? "Core R&D must be performed in New Zealand." : undefined}>
          <select value={draft.kind === "core" ? "nz" : draft.place} disabled={draft.kind === "core"} onChange={(event) => set({ place: event.target.value as RdPlace })}>
            <option value="nz">{RD_PLACE_LABELS.nz}</option>
            <option value="overseas">{RD_PLACE_LABELS.overseas}</option>
          </select>
        </Field>
        <Field label="First income year" hint={yearHint(draft.firstIncomeYear)}>
          <input inputMode="numeric" pattern="\d{4}" value={draft.firstIncomeYear} required onChange={(event) => set({ firstIncomeYear: event.target.value })} />
        </Field>
        <Field label="Last income year (optional)" hint={draft.lastIncomeYear ? yearHint(draft.lastIncomeYear) : "Leave blank while it's still going."}>
          <input inputMode="numeric" pattern="\d{4}" value={draft.lastIncomeYear} onChange={(event) => set({ lastIncomeYear: event.target.value })} />
        </Field>
      </div>
      {draft.kind === "supporting" ? (
        <fieldset className={ui.fieldSection}>
          <legend>Core activities it supports</legend>
          {cores.length === 0 ? <p className={ui.muted}>Register a core activity first.</p> : null}
          <div className={ui.choiceList}>
            {cores.map((core) => (
              <label key={core.id} className={ui.checkbox}>
                <input
                  type="checkbox"
                  checked={draft.supports.includes(core.id)}
                  onChange={(event) =>
                    set({ supports: event.target.checked ? [...draft.supports, core.id] : draft.supports.filter((id) => id !== core.id) })
                  }
                />
                {activityText(core)}
                {core.status === "archived" ? " (archived)" : ""}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <p className={ui.muted}>The descriptions IRD asks for in an approval application (IR1240). You can fill them in later.</p>
      {[...DESCRIPTION_FIELDS, ...(draft.kind === "supporting" ? [WHY_REQUIRED] : [])].map((field) => (
        <Field key={field.key} label={field.label} hint={field.hint}>
          <textarea rows={3} maxLength={10000} value={draft[field.key]} onChange={(event) => set({ [field.key]: event.target.value })} />
        </Field>
      ))}
      <p className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {initial ? "Save changes" : "Add activity"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// An activity: details, approvals, files and history (RD1-RD3, RD21-RD23)

export function RdActivityView({ organisationId, activityId }: { organisationId: string; activityId: string }) {
  const { can } = useWorkspace();
  const loaded = useApiData<{ activity: RdActivityDetail }>(`/api/rd/activities/${encodeURIComponent(activityId)}`, { organisationId });
  const list = useRdActivities(organisationId, true);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data || !list.data) return <p className={ui.muted}>Loading…</p>;
  const activity = loaded.data.activity;
  const { activities, yearEndMonth } = list.data;
  const done = (text: string) => {
    setMessage(text);
    loaded.reload();
    list.reload();
  };

  async function archive(archived: boolean) {
    const question = archived
      ? `Archive ${activity.code}? Nothing more can be tagged to it; what's already tagged stays. You can restore it later.`
      : `Restore ${activity.code}?`;
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/rd/activities/${activity.id}/archive`, { method: "POST", body: { organisationId, archived } });
      done(archived ? `Archived ${activity.code}.` : `Restored ${activity.code}.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {activity.changedSinceApproval ? (
        <Notice tone="warning">
          This activity&apos;s descriptions, type, place or links changed after its approval was entered. A material change may need IRD to be told
          (TAA 68CB(3B)).
        </Notice>
      ) : null}
      {editing ? (
        <Card title={`Change ${activity.code}`} description="The earlier version stays in the history, with who changed it and when.">
          <ActivityForm
            organisationId={organisationId}
            activities={activities}
            yearEndMonth={yearEndMonth}
            initial={activity}
            onCancel={() => setEditing(false)}
            onSaved={(next) => {
              setEditing(false);
              done(`Saved ${activityText(next)}.`);
            }}
          />
        </Card>
      ) : (
        <Card
          title={activityText(activity)}
          description={
            <>
              <ActivityStatusBadges activity={activity} /> <ApprovalBadge activity={activity} yearEndMonth={yearEndMonth} />
            </>
          }
          actions={
            <>
              {can("bookkeeper") && activity.status === "active" ? (
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              ) : null}
              {can("admin") ? (
                <Button variant="secondary" disabled={busy} onClick={() => void archive(activity.status === "active")}>
                  {activity.status === "active" ? "Archive" : "Restore"}
                </Button>
              ) : null}
            </>
          }
        >
          <div className={ui.statRow}>
            <Stat label="Project" value={activity.projectName} />
            <Stat label="Where it's performed" value={RD_PLACE_LABELS[activity.place]} />
            <Stat label="Income years" value={activity.yearsLabel} />
          </div>
          {activity.supports.length > 0 ? (
            <p>
              Supports: <ActivityLinks activities={activity.supports} />
            </p>
          ) : null}
          {activity.supportedBy.length > 0 ? (
            <p>
              Supported by: <ActivityLinks activities={activity.supportedBy} />
            </p>
          ) : null}
          {[...DESCRIPTION_FIELDS, ...(activity.kind === "supporting" ? [WHY_REQUIRED] : [])].map((field) => (
            <div key={field.key}>
              <h3 className={ui.fieldLabel}>{field.label}</h3>
              <p style={{ whiteSpace: "pre-wrap" }}>{activity[field.key] || <span className={ui.muted}>Not filled in yet.</span>}</p>
            </div>
          ))}
          <p className={ui.muted}>
            Added by {personName(activity, "createdBy")} on {formatDateTime(activity.createdAt)}; last changed by {personName(activity, "updatedBy")} on{" "}
            {formatDateTime(activity.updatedAt)}.
            {activity.archivedAt ? ` Archived by ${personName(activity, "archivedBy")} on ${formatDateTime(activity.archivedAt)}.` : ""}
          </p>
        </Card>
      )}
      <ApprovalsCard organisationId={organisationId} activity={activity} activities={activities} yearEndMonth={yearEndMonth} onChanged={done} />
      <RdFilesCard
        organisationId={organisationId}
        recordType="activity"
        recordId={activity.id}
        files={activity.files}
        title="Files"
        description="Records of the work: plans, results, workings. Kept for 7 years; replace a file with a new version, the old one is kept."
        onChanged={done}
      />
      <HistoryCard history={activity.history} />
      <p>
        <Link href="/operations/rd">Back to R&amp;D activities</Link>
      </p>
    </>
  );
}

function ActivityLinks({ activities }: { activities: RdActivityRef[] }) {
  return (
    <>
      {activities.map((linked, index) => (
        <span key={linked.id}>
          {index > 0 ? ", " : ""}
          <Link href={`/operations/rd/${linked.id}`}>{activityText(linked)}</Link>
          {linked.status === "archived" ? " (archived)" : ""}
        </span>
      ))}
    </>
  );
}

const ACTION_LABELS: Record<HistoryEntry["action"], string> = {
  created: "Added",
  changed: "Changed",
  archived: "Archived",
  restored: "Restored",
  withdrawn: "Withdrawn",
  removed: "Removed",
  replaced: "Replaced",
  ended: "Ended",
  exported: "Exported",
};

function HistoryCard({ history, title = "History" }: { history: HistoryEntry[]; title?: string }) {
  return (
    <Card title={title} description="Every change, with who made it and when (the server's time).">
      {history.length === 0 ? <Empty>No history.</Empty> : null}
      <ul>
        {history.map((entry) => (
          <li key={entry.version}>
            {ACTION_LABELS[entry.action]} by {personName(entry, "changedBy")} on {formatDateTime(entry.changedAt)}
            {Array.isArray(entry.snapshot.changed) && entry.snapshot.changed.length > 0 ? (
              <span className={ui.muted}> ({(entry.snapshot.changed as string[]).join(", ")})</span>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ApprovalsCard({
  organisationId,
  activity,
  activities,
  yearEndMonth,
  onChanged,
}: {
  organisationId: string;
  activity: RdActivityDetail;
  activities: RdActivity[];
  yearEndMonth: number;
  onChanged: (message: string) => void;
}) {
  const { can } = useWorkspace();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function withdraw(approval: RdApproval) {
    const reason = window.prompt(`Why is approval ${approval.reference} being withdrawn? It's kept, marked withdrawn.`);
    if (!reason) return;
    setError(null);
    try {
      await api(`/api/rd/approvals/${approval.id}/withdraw`, { method: "POST", body: { organisationId, reason } });
      onChanged(`Withdrew approval ${approval.reference}.`);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Card
      title="Approvals"
      description="IRD's general approval, with its letter. Tohyee can't check approvals with IRD, so each one shows “not checked with IRD”."
      actions={can("bookkeeper") && !adding && activity.status === "active" ? <Button onClick={() => setAdding(true)}>Enter an approval</Button> : null}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {adding ? (
        <ApprovalForm
          organisationId={organisationId}
          activity={activity}
          activities={activities}
          yearEndMonth={yearEndMonth}
          onCancel={() => setAdding(false)}
          onSaved={(approval) => {
            setAdding(false);
            onChanged(`Entered approval ${approval.reference} for ${approval.yearsLabel}.`);
          }}
        />
      ) : null}
      {activity.approvals.length === 0 ? <Empty>No approval entered. Costs can still be tagged, with a warning.</Empty> : null}
      {activity.approvals.map((approval) => (
        <section key={approval.id} className={ui.fieldSection}>
          <p>
            <strong>General approval {approval.reference}</strong> · letter dated {formatDate(approval.letterDate)} · {approval.yearsLabel}{" "}
            {approval.status === "withdrawn" ? <Badge tone="red">Withdrawn</Badge> : <Badge tone="green">Entered</Badge>} <Badge>Not checked with IRD</Badge>
          </p>
          <p className={ui.muted}>
            Covers <ActivityLinks activities={approval.activities} />. Entered by {personName(approval, "createdBy")} on {formatDateTime(approval.createdAt)}.
            {approval.withdrawnAt ? ` Withdrawn by ${personName(approval, "withdrawnBy")} on ${formatDateTime(approval.withdrawnAt)}: ${approval.withdrawnReason}` : ""}
          </p>
          {approval.note ? <p>{approval.note}</p> : null}
          <RdFileList organisationId={organisationId} files={approval.letters} onChanged={onChanged} />
          {approval.status === "active" && can("admin") ? (
            <Button size="small" variant="secondary" onClick={() => void withdraw(approval)}>
              Withdraw
            </Button>
          ) : null}
        </section>
      ))}
    </Card>
  );
}

function ApprovalForm({
  organisationId,
  activity,
  activities,
  yearEndMonth,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  activity: RdActivity;
  activities: RdActivity[];
  yearEndMonth: number;
  onSaved: (approval: RdApproval) => void;
  onCancel: () => void;
}) {
  const [idempotencyKey] = useState(() => newIdempotencyKey("rd-approval"));
  const [reference, setReference] = useState("");
  const [letterDate, setLetterDate] = useState("");
  const [firstYear, setFirstYear] = useState(String(activity.firstIncomeYear));
  const [lastYear, setLastYear] = useState(String(activity.firstIncomeYear + 2));
  const [covered, setCovered] = useState<string[]>([activity.id]);
  const [note, setNote] = useState("");
  const [letter, setLetter] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = activities.filter((item) => item.status === "active");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!letter) {
      setError("Attach IRD's approval letter. Approval details can't be saved without it.");
      return;
    }
    const problem = tooBig(letter);
    if (problem) {
      setError(problem);
      return;
    }
    const form = new FormData();
    form.set("organisationId", organisationId);
    form.set("idempotencyKey", idempotencyKey);
    form.set("kind", "general");
    form.set("reference", reference);
    form.set("letterDate", letterDate);
    form.set("firstIncomeYear", firstYear);
    form.set("lastIncomeYear", lastYear);
    form.set("activityIds", covered.join(","));
    form.set("note", note);
    form.set("file", letter, letter.name);
    setBusy(true);
    setError(null);
    try {
      onSaved((await postForm<{ approval: RdApproval }>("/api/rd/approvals", form)).approval);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const yearHint = (value: string) => (/^\d{4}$/.test(value) ? `${incomeYearLabel(Number(value), yearEndMonth)} income year` : "Like 2027.");
  return (
    <form onSubmit={(event) => void submit(event)} className={ui.fieldSection}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className={ui.muted}>
        Only general approvals are entered here; criteria and methodologies approvals aren&apos;t supported yet. A general approval covers up to 3 income
        years (TAA 68CB(2)).
      </p>
      <div className={ui.grid3}>
        <Field label="IRD's reference">
          <input value={reference} maxLength={100} required onChange={(event) => setReference(event.target.value)} />
        </Field>
        <Field label="Date of IRD's letter">
          <input type="date" value={letterDate} required onChange={(event) => setLetterDate(event.target.value)} />
        </Field>
        <Field label="First income year" hint={yearHint(firstYear)}>
          <input inputMode="numeric" pattern="\d{4}" value={firstYear} required onChange={(event) => setFirstYear(event.target.value)} />
        </Field>
        <Field label="Last income year" hint={yearHint(lastYear)}>
          <input inputMode="numeric" pattern="\d{4}" value={lastYear} required onChange={(event) => setLastYear(event.target.value)} />
        </Field>
        <Field label="IRD's approval letter" hint="Required. PDF or image, up to 10 MB.">
          <input type="file" required onChange={(event) => setLetter(event.target.files?.[0] ?? null)} />
        </Field>
      </div>
      <fieldset className={ui.fieldSection}>
        <legend>Activities the letter approves</legend>
        <div className={ui.choiceList}>
          {active.map((item) => (
            <label key={item.id} className={ui.checkbox}>
              <input
                type="checkbox"
                checked={covered.includes(item.id)}
                onChange={(event) => setCovered(event.target.checked ? [...covered, item.id] : covered.filter((id) => id !== item.id))}
              />
              {activityText(item)}
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="Note (optional)">
        <textarea rows={2} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
      </Field>
      <p className={ui.actions}>
        <Button type="submit" disabled={busy}>
          Save approval
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Files: kept for 7 years, replaced with a new version, never deleted (decision 45)

function RdFileList({ organisationId, files, onChanged }: { organisationId: string; files: RdFile[]; onChanged: (message: string) => void }) {
  const { can } = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function replace(file: RdFile, event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0];
    event.target.value = "";
    if (!next) return;
    const problem = tooBig(next);
    if (problem) {
      setError(problem);
      return;
    }
    const form = new FormData();
    form.set("organisationId", organisationId);
    form.set("idempotencyKey", newIdempotencyKey("rd-file"));
    form.set("file", next, next.name);
    setBusy(true);
    setError(null);
    try {
      await postForm(`/api/rd/files/${file.id}/replace`, form);
      onChanged(`Replaced ${file.fileName} with ${next.name}. The earlier version is kept.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (files.length === 0) return null;
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ul>
        {files.map((file) => (
          <li key={file.id}>
            <a href={fileUrl(organisationId, file.id)} target="_blank" rel="noreferrer">
              {file.fileName}
            </a>{" "}
            <span className={ui.muted}>
              {FILE_PURPOSE_LABELS[file.purpose]} · added by {personName(file, "createdBy")} on {formatDateTime(file.createdAt)}
            </span>{" "}
            {can("bookkeeper") ? (
              <label className={ui.linkButton}>
                Replace
                <input type="file" hidden disabled={busy} onChange={(event) => void replace(file, event)} />
              </label>
            ) : null}
            {file.replaced.length > 0 ? (
              <details>
                <summary className={ui.muted}>Earlier versions ({file.replaced.length})</summary>
                <ul>
                  {file.replaced.map((version) => (
                    <li key={version.id}>
                      <a href={fileUrl(organisationId, version.id)} target="_blank" rel="noreferrer">
                        {version.fileName}
                      </a>{" "}
                      <span className={ui.muted}>
                        added by {personName(version, "createdBy")} on {formatDateTime(version.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

function RdFilesCard({
  organisationId,
  recordType,
  recordId,
  files,
  title,
  description,
  onChanged,
}: {
  organisationId: string;
  recordType: "activity" | "tag" | "asset";
  recordId: string;
  files: RdFile[];
  title: string;
  description: ReactNode;
  onChanged: (message: string) => void;
}) {
  const { can } = useWorkspace();
  const [purpose, setPurpose] = useState<RdFilePurpose>(recordType === "tag" ? "contractor_statement" : "workings");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const problem = tooBig(file);
    if (problem) {
      setError(problem);
      return;
    }
    const form = new FormData();
    form.set("organisationId", organisationId);
    form.set("idempotencyKey", newIdempotencyKey("rd-file"));
    form.set("recordType", recordType);
    form.set("recordId", recordId);
    form.set("purpose", purpose);
    form.set("file", file, file.name);
    setBusy(true);
    setError(null);
    try {
      await postForm("/api/rd/files", form);
      onChanged(`Attached ${file.name}.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={title} description={description}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {files.length === 0 ? <Empty>No files yet.</Empty> : <RdFileList organisationId={organisationId} files={files} onChanged={onChanged} />}
      {can("bookkeeper") ? (
        <div className={ui.inlineForm}>
          <Field label="What it is">
            <select value={purpose} onChange={(event) => setPurpose(event.target.value as RdFilePurpose)}>
              {(["workings", "contractor_statement", "other"] as const).map((value) => (
                <option key={value} value={value}>
                  {FILE_PURPOSE_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Attach a file">
            <input type="file" disabled={busy} onChange={(event) => void add(event)} />
          </Field>
        </div>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Tagging lines (RD8, RD9, RD12, RD13)

type TagDraft = {
  activityId: string;
  percentage: string;
  eligibility: "eligible" | "ineligible";
  category: RdLineCategory | "";
  ineligibleReason: RdIneligibleReason | "";
  flags: Record<RdFlag, boolean>;
  contractorIneligibleAmount: string;
  unusedAmount: string;
  note: string;
};

function tagDraft(tag: RdTag | null, ineligibleOnly: boolean): TagDraft {
  return {
    activityId: tag?.activity.id ?? "",
    percentage: tag?.percentage ?? "100",
    eligibility: tag?.eligibility ?? (ineligibleOnly ? "ineligible" : "eligible"),
    category: tag?.category ?? "",
    ineligibleReason: tag?.ineligibleReason ?? "",
    flags: {
      overseas: tag?.overseas ?? false,
      commercialProduction: tag?.commercialProduction ?? false,
      internalSoftware: tag?.internalSoftware ?? false,
      feedstock: tag?.feedstock ?? false,
    },
    contractorIneligibleAmount: tag && tag.contractorIneligibleAmount !== "0.00" ? tag.contractorIneligibleAmount : "",
    unusedAmount: tag && tag.unusedAmount !== "0.00" ? tag.unusedAmount : "",
    note: tag?.note ?? "",
  };
}

/** Tags a line, or changes its tag. */
function TagForm({
  organisationId,
  line,
  tag,
  activities,
  yearEndMonth,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  line: Pick<RdLine, "sourceType" | "lineId" | "amount" | "postedOn" | "ineligibleOnly">;
  tag: RdTag | null;
  activities: RdActivity[];
  yearEndMonth: number;
  onSaved: (tag: RdTagDetail) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<TagDraft>(() => tagDraft(tag, line.ineligibleOnly));
  const [idempotencyKey] = useState(() => newIdempotencyKey("rd-tag"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<TagDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const year = incomeYearOf(line.postedOn, yearEndMonth);
  const choices = activities.filter((activity) => activity.status === "active" || activity.id === draft.activityId);
  const chosen = activities.find((activity) => activity.id === draft.activityId);
  const contractor = draft.category === "contract" || draft.category === "approved_research_provider";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const eligible = draft.eligibility === "eligible";
    const body = {
      organisationId,
      activityId: draft.activityId,
      percentage: draft.percentage,
      eligibility: draft.eligibility,
      category: eligible ? draft.category : null,
      ineligibleReason: eligible ? null : draft.ineligibleReason,
      ...draft.flags,
      contractorIneligibleAmount: eligible && contractor ? draft.contractorIneligibleAmount || "0" : "0",
      unusedAmount: eligible ? draft.unusedAmount || "0" : "0",
      note: draft.note || null,
    };
    try {
      const saved = tag
        ? (await api<{ tag: RdTagDetail }>(`/api/rd/tags/${tag.id}`, { method: "PATCH", body: { ...body, version: tag.version } })).tag
        : (await api<{ tag: RdTagDetail }>("/api/rd/tags", { method: "POST", body: { ...body, idempotencyKey, sourceType: line.sourceType, lineId: line.lineId } }))
            .tag;
      onSaved(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className={ui.fieldSection}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className={ui.muted}>
        Line amount <Money value={line.amount} /> excluding GST, {incomeYearLabel(year, yearEndMonth)} income year. GST is never part of an R&amp;D amount.
      </p>
      {line.ineligibleOnly ? <p className={ui.muted}>Buying an asset isn&apos;t eligible; its tax depreciation is entered on the fixed asset instead.</p> : null}
      <div className={ui.grid3}>
        <Field label="R&D activity">
          <select value={draft.activityId} required onChange={(event) => set({ activityId: event.target.value })}>
            <option value="">Choose…</option>
            {choices.map((activity) => (
              <option key={activity.id} value={activity.id}>
                {activityText(activity)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="R&D share (%)" hint="Rounded down to the cent.">
          <input inputMode="decimal" value={draft.percentage} required onChange={(event) => set({ percentage: event.target.value })} />
        </Field>
        <Field label="Eligible?">
          <select value={draft.eligibility} disabled={line.ineligibleOnly} onChange={(event) => set({ eligibility: event.target.value as TagDraft["eligibility"] })}>
            <option value="eligible">Eligible</option>
            <option value="ineligible">Ineligible</option>
          </select>
        </Field>
        {draft.eligibility === "eligible" ? (
          <Field label="Category (IR1240)">
            <select value={draft.category} required onChange={(event) => set({ category: event.target.value as RdLineCategory })}>
              <option value="">Choose…</option>
              {RD_LINE_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {RD_CATEGORY_LABELS[category]}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="Why it's ineligible (IR1240)">
            <select value={draft.ineligibleReason} required onChange={(event) => set({ ineligibleReason: event.target.value as RdIneligibleReason })}>
              <option value="">Choose…</option>
              {RD_INELIGIBLE_REASON_CODES.map((code) => (
                <option key={code} value={code}>
                  {RD_INELIGIBLE_REASONS[code].label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {draft.eligibility === "eligible" ? (
          <Field label="Not used by the end of the income year" hint="Goods still unused at year end don't count for this year.">
            <input inputMode="decimal" placeholder="0.00" value={draft.unusedAmount} onChange={(event) => set({ unusedAmount: event.target.value })} />
          </Field>
        ) : null}
        {draft.eligibility === "eligible" && contractor ? (
          <Field label="Contractor's own ineligible costs" hint="From the contractor's statement; attach it to the tag.">
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={draft.contractorIneligibleAmount}
              onChange={(event) => set({ contractorIneligibleAmount: event.target.value })}
            />
          </Field>
        ) : null}
      </div>
      <div className={ui.choiceList}>
        {RD_FLAGS.map((flag) => (
          <label key={flag} className={ui.checkbox}>
            <input
              type="checkbox"
              checked={draft.flags[flag] || (flag === "overseas" && chosen?.place === "overseas")}
              disabled={flag === "overseas" && chosen?.place === "overseas"}
              onChange={(event) => set({ flags: { ...draft.flags, [flag]: event.target.checked } })}
            />
            {RD_FLAG_LABELS[flag]}
          </label>
        ))}
      </div>
      <Field label="Note (optional)" hint={draft.ineligibleReason === "other" ? "Say why it's ineligible." : undefined}>
        <textarea rows={2} maxLength={2000} value={draft.note} onChange={(event) => set({ note: event.target.value })} />
      </Field>
      {chosen && !chosen.approvedYears.includes(year) ? (
        <Notice tone="warning">
          No approval entered for {incomeYearLabel(year, yearEndMonth)} on {chosen.code}. You can still tag it; it&apos;s flagged until an approval is entered.
        </Notice>
      ) : null}
      <p className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {tag ? "Save tag" : "Tag to R&D"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </p>
    </form>
  );
}

function TagSummary({ tag }: { tag: RdTag }) {
  return (
    <>
      <div>
        <Link href={`/operations/rd/${tag.activity.id}`}>{activityText(tag.activity)}</Link> · {tag.percentage}% ·{" "}
        {tag.eligibility === "eligible" ? tag.categoryLabel : <Badge tone="red">Ineligible: {tag.ineligibleReasonLabel}</Badge>}
      </div>
      <div className={ui.muted}>
        R&amp;D share <Money value={tag.amount} />
        {tag.unusedAmount !== "0.00" ? (
          <>
            {" "}
            · not used by year end <Money value={tag.unusedAmount} />
          </>
        ) : null}
        {tag.contractorIneligibleAmount !== "0.00" ? (
          <>
            {" "}
            · contractor&apos;s ineligible <Money value={tag.contractorIneligibleAmount} />
          </>
        ) : null}{" "}
        · counts <Money value={tag.countedAmount} />
      </div>
      <div className={ui.muted}>
        Tagged by {personName(tag, "createdBy")} on {formatDateTime(tag.createdAt)} · <TimelinessBadge timeliness={tag.timeliness} />
        {tag.version > 1 ? ` · changed by ${personName(tag, "updatedBy")} on ${formatDateTime(tag.updatedAt)}` : ""}
      </div>
      {tag.warnings.map((warning) => (
        <div key={warning}>
          <Badge tone="amber">{warning}</Badge>
        </div>
      ))}
    </>
  );
}

function LineRow({
  organisationId,
  line,
  activities,
  yearEndMonth,
  onChanged,
}: {
  organisationId: string;
  line: RdLine;
  activities: RdActivity[];
  yearEndMonth: number;
  onChanged: (message: string) => void;
}) {
  const { can } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(tag: RdTag) {
    const reason = window.prompt("Why remove this tag? It's kept in the history and stops counting.");
    if (!reason) return;
    setError(null);
    try {
      await api(`/api/rd/tags/${tag.id}/remove`, { method: "POST", body: { organisationId, reason } });
      onChanged(`Removed the R&D tag on “${line.description}”.`);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <tr>
      <td data-label="Line">
        {line.description}
        <div className={ui.muted}>
          {line.documentLabel} · {formatDate(line.postedOn)} · {line.accountCode} {line.accountName}
        </div>
      </td>
      <td data-label="Excl. GST" className={ui.num}>
        <Money value={line.amount} />
        {line.currencyCode ? (
          <div className={ui.muted}>
            {line.currencyCode} {line.documentAmount} at {line.exchangeRate}
          </div>
        ) : null}
      </td>
      <td data-label="R&D">
        {error ? <Notice tone="error">{error}</Notice> : null}
        {line.tag ? <TagSummary tag={line.tag} /> : null}
        {!line.tag && !line.taggable ? <span className={ui.muted}>{line.reason}</span> : null}
        {editing ? (
          <TagForm
            organisationId={organisationId}
            line={line}
            tag={line.tag}
            activities={activities}
            yearEndMonth={yearEndMonth}
            onCancel={() => setEditing(false)}
            onSaved={(tag) => {
              setEditing(false);
              onChanged(`${line.tag ? "Changed the tag on" : "Tagged"} “${line.description}” to ${tag.activity.code}.`);
            }}
          />
        ) : null}
        {!editing && can("bookkeeper") && (line.tag || line.taggable) ? (
          <span className={ui.rowButtons}>
            <Button size="small" variant="secondary" onClick={() => setEditing(true)}>
              {line.tag ? "Change tag" : "Tag to R&D"}
            </Button>
            {line.tag ? (
              <Button size="small" variant="secondary" onClick={() => void remove(line.tag!)}>
                Remove tag
              </Button>
            ) : null}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

function LinesTable({
  organisationId,
  lines,
  activities,
  yearEndMonth,
  onChanged,
}: {
  organisationId: string;
  lines: RdLine[];
  activities: RdActivity[];
  yearEndMonth: number;
  onChanged: (message: string) => void;
}) {
  return (
    <div className={ui.tableWrap}>
      <table className={`${ui.table} ${ui.stackOnPhone}`}>
        <thead>
          <tr>
            <th>Line</th>
            <th className={ui.num}>Excl. GST</th>
            <th>R&amp;D</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <LineRow
              key={`${line.sourceType}-${line.lineId}`}
              organisationId={organisationId}
              line={line}
              activities={activities}
              yearEndMonth={yearEndMonth}
              onChanged={onChanged}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The R&D tag picker on a posted bill, expense claim, spend money or journal.
 * Shows nothing until the organisation has registered an R&D activity (or
 * the document already has a tag), so it stays out of the way otherwise.
 */
export function RdLineTags({ organisationId, documentType, documentId }: { organisationId: string; documentType: RdDocumentType; documentId: string }) {
  const lines = useApiData<{ lines: RdLine[] }>("/api/rd/lines", { organisationId, documentType, documentId });
  const list = useRdActivities(organisationId, true);
  const [message, setMessage] = useState<string | null>(null);
  if (!lines.data || !list.data) return null;
  const hasTags = lines.data.lines.some((line) => line.tag);
  if (list.data.activities.length === 0 && !hasTags) return null;
  if (lines.data.lines.length === 0) return null;
  return (
    <Card
      title="R&D Tax Incentive"
      description={
        <>
          Tag lines to an R&amp;D activity. Amounts exclude GST; foreign currency is at the document&apos;s rate. See{" "}
          <Link href="/operations/rd/costs">tagged R&amp;D costs</Link>.
        </>
      }
    >
      {message ? <Notice tone="success">{message}</Notice> : null}
      <LinesTable
        organisationId={organisationId}
        lines={lines.data.lines}
        activities={list.data.activities}
        yearEndMonth={list.data.yearEndMonth}
        onChanged={(text) => {
          setMessage(text);
          lines.reload();
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Tagged costs by activity and category, and untagged lines to tag

function CostActivityCard({ item }: { item: RdCostActivity }) {
  return (
    <Card
      title={activityText(item.activity)}
      description={
        <>
          <Badge tone={item.activity.kind === "core" ? "blue" : "neutral"}>{KIND_LABELS[item.activity.kind]}</Badge>{" "}
          {item.approved ? <Badge tone="green">Approval entered</Badge> : <Badge tone="amber">No approval entered for this year</Badge>}
        </>
      }
    >
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Category</th>
              <th className={ui.num}>R&amp;D share</th>
              <th className={ui.num}>Not used by year end</th>
              <th className={ui.num}>Contractor&apos;s ineligible</th>
              <th className={ui.num}>Counts</th>
            </tr>
          </thead>
          <tbody>
            {item.groups.map((group) => (
              <tr key={`${group.eligibility}-${group.category ?? group.ineligibleReason}`}>
                <td data-label="Category">
                  {group.eligibility === "ineligible" ? <Badge tone="red">Ineligible</Badge> : null} {group.label}
                  <details>
                    <summary className={ui.muted}>{group.tags.length + group.assets.length} items</summary>
                    <ul>
                      {group.tags.map((tag) => (
                        <li key={tag.id}>
                          {formatDate(tag.timeliness.workDate)} {tag.documentLabel}: {tag.description} · <Money value={tag.amount} />{" "}
                          {tag.timeliness.enteredLate ? <Badge tone="amber">Entered late</Badge> : null}
                        </li>
                      ))}
                      {group.assets.map((asset) => (
                        <li key={asset.assetId}>
                          <Link href={`/operations/fixed-assets/${asset.assetId}`}>
                            {asset.assetNumber} {asset.assetName}
                          </Link>
                          : {asset.hours} of {asset.totalHours} hours · <Money value={asset.amount} />
                        </li>
                      ))}
                    </ul>
                  </details>
                </td>
                <td data-label="R&D share" className={ui.num}>
                  <Money value={group.amount} />
                </td>
                <td data-label="Not used by year end" className={ui.num}>
                  <Money value={group.unusedAmount} blankZero />
                </td>
                <td data-label="Contractor's ineligible" className={ui.num}>
                  <Money value={group.contractorIneligibleAmount} blankZero />
                </td>
                <td data-label="Counts" className={ui.num}>
                  <Money value={group.countedAmount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={ui.statRow}>
        <Stat label="Counts" value={<Money value={item.countedAmount} />} />
        <Stat label="Ineligible" value={<Money value={item.ineligibleAmount} />} />
      </div>
    </Card>
  );
}

export function RdCostsView({ organisationId }: { organisationId: string }) {
  const [incomeYear, setIncomeYear] = useState<string>("");
  const costs = useApiData<{ costs: RdCosts }>("/api/rd/costs", { organisationId, incomeYear: incomeYear || null });
  if (costs.error) return <Notice tone="error">{costs.error}</Notice>;
  if (!costs.data) return <p className={ui.muted}>Loading…</p>;
  const data = costs.data.costs;
  const years = data.years.some((year) => year.incomeYear === data.incomeYear) ? data.years : [{ incomeYear: data.incomeYear, label: data.incomeYearLabel }, ...data.years];
  return (
    <>
      <Notice tone="info">
        This lists what&apos;s tagged; it isn&apos;t the claim. The <Link href="/operations/rd/claim">R&amp;D claim report</Link> adds pay, overhead
        rules, approvals, the overseas limit, the minimum and maximum, and the 15% credit.
      </Notice>
      <Card
        title={`Tagged R&D costs, ${data.incomeYearLabel} income year`}
        description={`${formatDate(data.start)} to ${formatDate(data.end)}. Excludes GST. Records entered more than ${RD_LATE_AFTER_DAYS} days after the work are flagged “entered late”.`}
        actions={
          <Field label="Income year">
            <select value={String(data.incomeYear)} onChange={(event) => setIncomeYear(event.target.value)}>
              {years.map((year) => (
                <option key={year.incomeYear} value={year.incomeYear}>
                  {year.label}
                </option>
              ))}
            </select>
          </Field>
        }
      >
        <div className={ui.statRow}>
          <Stat label="Counts" value={<Money value={data.countedAmount} />} />
          <Stat label="Ineligible" value={<Money value={data.ineligibleAmount} />} />
          <Stat label="Entered late" value={data.lateCount} />
          <Stat label="Changed after entry" value={data.changedCount} />
          <Stat label="No approval entered" value={data.noApprovalCount} />
        </div>
        {data.assetWarnings.map((warning) => (
          <Notice key={`${warning.assetId}-${warning.warning}`} tone="warning">
            <Link href={`/operations/fixed-assets/${warning.assetId}`}>{warning.assetNumber}</Link>: {warning.warning}
          </Notice>
        ))}
        {data.activities.length === 0 ? <Empty>Nothing tagged for this income year.</Empty> : null}
      </Card>
      {data.activities.map((item) => (
        <CostActivityCard key={item.activity.id} item={item} />
      ))}
      {data.voidedTags.length > 0 ? (
        <Card title="Not counted: document voided or reversed" description="These lines were tagged, then their document was voided or reversed.">
          <ul>
            {data.voidedTags.map((tag) => (
              <li key={tag.id}>
                {tag.documentLabel}: {tag.description} · {tag.activity.code} · <Money value={tag.amount} />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <UntaggedLines organisationId={organisationId} onChanged={costs.reload} />
    </>
  );
}

function UntaggedLines({ organisationId, onChanged }: { organisationId: string; onChanged: () => void }) {
  const [filters, setFilters] = useState({ search: "", from: "", to: "" });
  const [applied, setApplied] = useState(filters);
  const lines = useApiData<{ lines: RdLine[] }>("/api/rd/lines", { organisationId, ...applied });
  const list = useRdActivities(organisationId, true);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <Card title="Lines to tag" description="Posted cost lines (bills, expense claims, spend money and journals) not tagged yet, newest first.">
      <form
        className={ui.inlineForm}
        onSubmit={(event) => {
          event.preventDefault();
          setApplied(filters);
        }}
      >
        <Field label="Search">
          <input value={filters.search} maxLength={100} onChange={(event) => setFilters({ ...filters, search: event.target.value })} />
        </Field>
        <Field label="From">
          <input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} />
        </Field>
        <Field label="To">
          <input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} />
        </Field>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {lines.error ? <Notice tone="error">{lines.error}</Notice> : null}
      {!lines.data || !list.data ? <p className={ui.muted}>Loading…</p> : null}
      {lines.data && list.data && lines.data.lines.length === 0 ? <Empty>No untagged cost lines.</Empty> : null}
      {lines.data && list.data && lines.data.lines.length > 0 ? (
        <LinesTable
          organisationId={organisationId}
          lines={lines.data.lines}
          activities={list.data.activities}
          yearEndMonth={list.data.yearEndMonth}
          onChanged={(text) => {
            setMessage(text);
            lines.reload();
            onChanged();
          }}
        />
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A fixed asset's R&D tax depreciation and usage log (RD11, RD21-RD23)

export function RdAssetPanel({ organisationId, assetId }: { organisationId: string; assetId: string }) {
  const { can } = useWorkspace();
  const loaded = useApiData<{ asset: AssetRd }>(`/api/rd/assets/${encodeURIComponent(assetId)}`, { organisationId });
  const list = useRdActivities(organisationId, true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<AssetRd | null>(null);
  if (!loaded.data || !list.data) return null;
  const data = current ?? loaded.data.asset;
  const { activities, yearEndMonth } = list.data;
  if (activities.length === 0 && data.years.length === 0 && data.usage.length === 0) return null;
  const saved = (next: AssetRd, text: string) => {
    setCurrent(next);
    setMessage(text);
    setError(null);
  };

  async function removeEntry(entry: UsageEntry) {
    const reason = window.prompt("Why remove this usage entry? It's kept in the history and drops out of the split.");
    if (!reason) return;
    try {
      saved((await api<{ asset: AssetRd }>(`/api/rd/usage/${entry.id}/remove`, { method: "POST", body: { organisationId, reason } })).asset, "Removed the usage entry.");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function changeHours(entry: UsageEntry) {
    const hours = window.prompt("Hours (the earlier figure stays in the history):", entry.hours);
    if (!hours || hours === entry.hours) return;
    try {
      saved(
        (await api<{ asset: AssetRd }>(`/api/rd/usage/${entry.id}`, { method: "PATCH", body: { organisationId, version: entry.version, hours } })).asset,
        `Changed ${formatDate(entry.workDate)} to ${hours} hours.`,
      );
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Card
      title="R&D Tax Incentive"
      description="Enter the asset's tax depreciation (and any Investment Boost) for each income year, and log its use. The year's figure is split between R&D activities and other work by hours used."
    >
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {data.years.map((year) => (
        <section key={year.incomeYear} className={ui.fieldSection}>
          <h3 className={ui.cardTitle}>{year.incomeYearLabel} income year</h3>
          {year.entry ? (
            <p>
              Tax depreciation <Money value={year.entry.taxDepreciation} />
              {year.entry.investmentBoost !== "0.00" ? (
                <>
                  {" "}
                  + Investment Boost <Money value={year.entry.investmentBoost} />
                </>
              ) : null}{" "}
              = <Money value={year.entry.total} />{" "}
              <span className={ui.muted}>
                entered by {personName(year.entry, "createdBy")} on {formatDateTime(year.entry.createdAt)}
              </span>
              {year.entry.ineligibleReasonLabel ? <Badge tone="red">Ineligible: {year.entry.ineligibleReasonLabel}</Badge> : null}
            </p>
          ) : (
            <p className={ui.muted}>No tax depreciation entered for this year yet.</p>
          )}
          {year.earlierEntries.length > 0 ? (
            <details>
              <summary className={ui.muted}>Earlier figures ({year.earlierEntries.length})</summary>
              <ul>
                {year.earlierEntries.map((entry) => (
                  <li key={entry.id}>
                    <Money value={entry.total} /> entered by {personName(entry, "createdBy")} on {formatDateTime(entry.createdAt)}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <ul>
            {year.shares.map((share) => (
              <li key={share.activity.id}>
                {activityText(share.activity)}: {share.hours} hours · <Money value={share.amount} />
              </li>
            ))}
            {year.otherHours !== "0.00" ? (
              <li>
                Other work: {year.otherHours} hours · <Money value={year.other} />
              </li>
            ) : null}
          </ul>
          {year.warnings.map((warning) => (
            <Notice key={warning} tone="warning">
              {warning}
            </Notice>
          ))}
        </section>
      ))}
      {can("bookkeeper") ? <TaxDepreciationForm organisationId={organisationId} assetId={assetId} yearEndMonth={yearEndMonth} onSaved={saved} /> : null}
      <h3 className={ui.cardTitle}>Usage log</h3>
      {data.usage.length === 0 ? <Empty>No use logged yet.</Empty> : null}
      {data.usage.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Used for</th>
                <th className={ui.num}>Hours</th>
                <th>Entered</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.usage.map((entry) => (
                <tr key={entry.id}>
                  <td data-label="Date">{formatDate(entry.workDate)}</td>
                  <td data-label="Used for">
                    {entry.activity ? activityText(entry.activity) : "Other work"}
                    {entry.description ? <div className={ui.muted}>{entry.description}</div> : null}
                    {entry.status === "removed" ? <Badge tone="red">Removed: {entry.removedReason}</Badge> : null}
                  </td>
                  <td data-label="Hours" className={ui.num}>
                    {entry.hours}
                  </td>
                  <td data-label="Entered">
                    {personName(entry, "createdBy")}, {formatDateTime(entry.createdAt)} <TimelinessBadge timeliness={entry.timeliness} />
                    {entry.version > 1 ? (
                      <div className={ui.muted}>
                        Changed by {personName(entry, "updatedBy")} on {formatDateTime(entry.updatedAt)}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {entry.status === "active" && can("bookkeeper") ? (
                      <span className={ui.rowButtons}>
                        <Button size="small" variant="secondary" onClick={() => void changeHours(entry)}>
                          Change hours
                        </Button>
                        <Button size="small" variant="secondary" onClick={() => void removeEntry(entry)}>
                          Remove
                        </Button>
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {can("bookkeeper") ? <UsageForm organisationId={organisationId} assetId={assetId} activities={activities} onSaved={saved} /> : null}
    </Card>
  );
}

function TaxDepreciationForm({
  organisationId,
  assetId,
  yearEndMonth,
  onSaved,
}: {
  organisationId: string;
  assetId: string;
  yearEndMonth: number;
  onSaved: (asset: AssetRd, message: string) => void;
}) {
  const [key, setKey] = useState(() => newIdempotencyKey("rd-taxdep"));
  const [incomeYear, setIncomeYear] = useState(() => String(incomeYearOf(todayInBrowser(), yearEndMonth)));
  const [taxDepreciation, setTaxDepreciation] = useState("");
  const [investmentBoost, setInvestmentBoost] = useState("");
  const [ineligibleReason, setIneligibleReason] = useState<RdIneligibleReason | "">("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ asset: AssetRd }>(`/api/rd/assets/${assetId}/tax-depreciation`, {
        method: "POST",
        body: { organisationId, idempotencyKey: key, incomeYear, taxDepreciation, investmentBoost: investmentBoost || "0", ineligibleReason: ineligibleReason || null, note: note || null },
      });
      onSaved(result.asset, `Entered tax depreciation for ${incomeYearLabel(Number(incomeYear), yearEndMonth)}.`);
      setKey(newIdempotencyKey("rd-taxdep"));
      setTaxDepreciation("");
      setInvestmentBoost("");
      setIneligibleReason("");
      setNote("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details>
      <summary>Enter tax depreciation for an income year</summary>
      <form onSubmit={(event) => void submit(event)} className={ui.fieldSection}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <p className={ui.muted}>
          From the tax fixed asset register (not the book depreciation). Entering a year again replaces its figure; the earlier one is kept.
        </p>
        <div className={ui.grid3}>
          <Field label="Income year" hint={/^\d{4}$/.test(incomeYear) ? `${incomeYearLabel(Number(incomeYear), yearEndMonth)} income year` : "Like 2027."}>
            <input inputMode="numeric" pattern="\d{4}" value={incomeYear} required onChange={(event) => setIncomeYear(event.target.value)} />
          </Field>
          <Field label="Tax depreciation">
            <input inputMode="decimal" value={taxDepreciation} required onChange={(event) => setTaxDepreciation(event.target.value)} />
          </Field>
          <Field label="Investment Boost (optional)" hint="Counted as depreciation.">
            <input inputMode="decimal" placeholder="0.00" value={investmentBoost} onChange={(event) => setInvestmentBoost(event.target.value)} />
          </Field>
          <Field label="Ineligible? (optional)">
            <select value={ineligibleReason} onChange={(event) => setIneligibleReason(event.target.value as RdIneligibleReason | "")}>
              <option value="">No, eligible</option>
              {RD_INELIGIBLE_REASON_CODES.map((code) => (
                <option key={code} value={code}>
                  {RD_INELIGIBLE_REASONS[code].label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Note (optional)">
          <textarea rows={2} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <Button type="submit" disabled={busy}>
          Save
        </Button>
      </form>
    </details>
  );
}

function UsageForm({
  organisationId,
  assetId,
  activities,
  onSaved,
}: {
  organisationId: string;
  assetId: string;
  activities: RdActivity[];
  onSaved: (asset: AssetRd, message: string) => void;
}) {
  const [key, setKey] = useState(() => newIdempotencyKey("rd-usage"));
  const [workDate, setWorkDate] = useState(() => todayInBrowser());
  const [activityId, setActivityId] = useState("");
  const [hours, setHours] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ asset: AssetRd }>(`/api/rd/assets/${assetId}/usage`, {
        method: "POST",
        body: { organisationId, idempotencyKey: key, workDate, activityId: activityId || null, hours, description: description || null },
      });
      onSaved(result.asset, `Logged ${hours} hours on ${formatDate(workDate)}.`);
      setKey(newIdempotencyKey("rd-usage"));
      setHours("");
      setDescription("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className={ui.inlineForm}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Date used">
        <input type="date" value={workDate} max={todayInBrowser()} required onChange={(event) => setWorkDate(event.target.value)} />
      </Field>
      <Field label="Used for">
        <select value={activityId} onChange={(event) => setActivityId(event.target.value)}>
          <option value="">Other work (not R&amp;D)</option>
          {activities
            .filter((activity) => activity.status === "active")
            .map((activity) => (
              <option key={activity.id} value={activity.id}>
                {activityText(activity)}
              </option>
            ))}
        </select>
      </Field>
      <Field label="Hours">
        <input inputMode="decimal" value={hours} required onChange={(event) => setHours(event.target.value)} />
      </Field>
      <Field label="What it was used for (optional)">
        <input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} />
      </Field>
      <Button type="submit" disabled={busy}>
        Log use
      </Button>
    </form>
  );
}
