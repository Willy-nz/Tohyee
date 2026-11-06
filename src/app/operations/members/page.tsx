"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useRef, useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { ROLE_LABELS, ROLES, type Role } from "@/lib/auth/roles";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import { invitationMessage, type InvitationOutcome } from "@/lib/organisations/invite-messages";
import type { Handover } from "@/lib/organisations/handover";
import type { Member } from "@/lib/organisations/members";
import { useConfirm } from "@/components/confirm-dialog";
import { MemberCameraAccess } from "@/components/farm-security";
import { MemberFarms } from "@/components/member-farms";
import {
  AccessDateFields,
  type AccessFilter,
  type AccessFormValue,
  AccessHelp,
  AccessLabel,
  AccessQuickActions,
  accessBody,
  accessFormFrom,
  matchesAccessFilter,
  NO_ACCESS_LIMIT,
} from "@/components/member-access";

const isoOrEmpty = (value: string | null) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "");

const ROLE_HELP: Record<Role, string> = {
  farm_worker: "Records field work (cover readings, grazings, feed, soil samples) on the farms you choose for them, and sees their paddocks and farm calendar. Nothing of the books.",
  sales_rep: "Uses the CRM only: every company and person, and their own deals, tasks and forecast. Nothing of the books.",
  sales_manager: "Uses the CRM only, like a sales rep, and also sees the deals, tasks and forecasts of the sales teams they manage.",
  report_viewer: "Sees only the Analytics dashboards shared with them (for example a client). Nothing of the books.",
  viewer: "Can read journals, stock, contacts and reports.",
  bookkeeper: "Can also post journals, corrections, stock movements and FX revaluations, and manage contacts.",
  admin: "Can also manage the chart of accounts, tax codes, period locks, settings and people.",
  owner: "Can also manage other owners.",
};

function Members({ organisationId }: { organisationId: string }) {
  const confirm = useConfirm();
  const { user, current, can } = useWorkspace();
  const members = useApiData<{ members: Member[] }>(`/api/organisations/${organisationId}/members`);
  const handover = useApiData<{ handover: Handover | null }>(can("admin") ? `/api/organisations/${organisationId}/handover` : null);
  const [status, setStatus] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const [shownLink, setShownLink] = useState<{ email: string; url: string; expiresAt: string; localOnly: boolean } | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const params = useSearchParams();
  // "Invite them" from Hire help (decision 1479) fills in the role and dates.
  const prefilled = params.get("invite") === "1";
  const [role, setRole] = useState<Role>(() => {
    const asked = params.get("role");
    return prefilled && (asked === "viewer" || asked === "bookkeeper" || asked === "admin") ? asked : "bookkeeper";
  });
  const isOwner = current?.role === "owner";
  // Time-limited access (decisions 1466-1474).
  const [limitInvite, setLimitInvite] = useState(() => prefilled && Boolean(params.get("from") || params.get("until")));
  const [inviteAccess, setInviteAccess] = useState<AccessFormValue>(() =>
    prefilled ? { ...NO_ACCESS_LIMIT, from: isoOrEmpty(params.get("from")), until: isoOrEmpty(params.get("until")) } : NO_ACCESS_LIMIT,
  );
  const [filter, setFilter] = useState<AccessFilter>(() => {
    const asked = params.get("access");
    return asked === "ending" || asked === "ended" || asked === "limited" ? asked : "all";
  });
  const [editing, setEditing] = useState<{ member: Member; value: AccessFormValue } | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  function chooseDates(member: Member) {
    setEditing({ member, value: accessFormFrom(member.accessFrom, member.accessUntil) });
    setTimeout(() => editorRef.current?.querySelector("input")?.focus(), 0);
  }

  async function accessAction(member: Member, action: "extend_week" | "extend_month" | "end_now") {
    if (action === "end_now" && !(await confirm(`End ${member.displayName}'s access now? Their keys and AI apps stop too. Nothing they did is removed, and you can give access again later.`))) return;
    const done = { extend_week: "extended by a week", extend_month: "extended by a month", end_now: "ended" }[action];
    await run(() => api(`/api/organisations/${organisationId}/members/${member.userId}/access`, { method: "POST", body: { action } }), `${member.displayName}'s access is ${done}.`);
  }

  async function saveDates(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const { member, value } = editing;
    try {
      await api(`/api/organisations/${organisationId}/members/${member.userId}/access`, { method: "PUT", body: accessBody(value) });
      setStatus({ tone: "success", text: `Saved ${member.displayName}'s access dates.` });
      setEditing(null);
      members.reload();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    }
  }

  async function run(action: () => Promise<unknown>, success: string) {
    try {
      await action();
      setStatus({ tone: "success", text: success });
      members.reload();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    }
  }

  function showInvitation(action: "invite" | "resend", to: string, toRole: Role | null, invitation: InvitationOutcome | null) {
    setStatus(invitationMessage(action, to, toRole, invitation));
    setShownLink(invitation?.url ? { email: to, url: invitation.url, expiresAt: invitation.expiresAt, localOnly: invitation.localOnly } : null);
    members.reload();
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const to = email.trim();
    try {
      const result = await api<{ invitation: InvitationOutcome | null }>(`/api/organisations/${organisationId}/members`, {
        method: "POST",
        body: { email: to, displayName: name, role, ...(limitInvite ? accessBody(inviteAccess) : {}) },
      });
      showInvitation("invite", to, role, result.invitation);
      setEmail("");
      setName("");
      setInviteAccess(NO_ACCESS_LIMIT);
      setLimitInvite(false);
    } catch (caught) {
      setShownLink(null);
      setStatus({ tone: "error", text: errorMessage(caught) });
    }
  }

  async function resend(member: Member) {
    try {
      const result = await api<{ invitation: InvitationOutcome }>(`/api/organisations/${organisationId}/members/${member.userId}/invitation`, { method: "POST" });
      showInvitation("resend", member.email, null, result.invitation);
    } catch (caught) {
      setShownLink(null);
      setStatus({ tone: "error", text: errorMessage(caught) });
    }
  }

  if (!can("admin")) {
    return <Notice tone="warning">Only organisation admins and owners can manage people.</Notice>;
  }

  const waiting = handover.data?.handover ?? null;
  const shown = (members.data?.members ?? []).filter((member) => matchesAccessFilter(member.accessState, filter));
  return (
    <>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {waiting ? (
        <Card title="A server admin is handing this organisation over">
          <Notice tone="warning">
            {waiting.requestedByEmail} asked to make {waiting.toName} ({waiting.toEmail}) an owner. It happens on{" "}
            {new Date(waiting.takesEffectAt).toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" })} unless an owner or
            admin cancels it. Their reason: &ldquo;{waiting.reason}&rdquo;
          </Notice>
          <Button
            variant="danger"
            onClick={async () => {
              if (await confirm(`Cancel the handover to ${waiting.toEmail}? The server admin who asked is told.`)) {
                await run(() => api(`/api/organisations/${organisationId}/handover`, { method: "DELETE" }), "The handover is cancelled.");
                handover.reload();
              }
            }}
          >
            Cancel the handover
          </Button>
        </Card>
      ) : null}
      {shownLink ? (
        <Card title={`Invitation link for ${shownLink.email}`} description={`It works once, until ${formatDateTime(shownLink.expiresAt)}. Resending makes a new one and stops this one.`}>
          <p style={{ overflowWrap: "anywhere" }}>
            <code>{shownLink.url}</code>
          </p>
          {shownLink.localOnly ? (
            <Notice tone="warning">Remote access is off, so this link only works on the same network as this server.</Notice>
          ) : null}
          <div>
            <Button variant="secondary" size="small" onClick={() => void navigator.clipboard.writeText(shownLink.url)}>
              Copy link
            </Button>
          </div>
        </Card>
      ) : null}
      <Card
        title="Invite someone"
        description="If they don't have a login yet, Tohyee makes one that only opens this organisation, and emails them a link to set it up."
        actions={<Link href="/operations/members/hire">Hire help: write a job brief</Link>}
      >
        {prefilled ? <Notice tone="success">The role and dates from your brief are filled in. Add their name and email, then press Invite.</Notice> : null}
        <form className={ui.inlineForm} onSubmit={(event) => void invite(event)}>
          <Field label="Name">
            <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" required />
          </Field>
          <Field label="Email">
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </Field>
          <Field label="Role" hint={ROLE_HELP[role]}>
            <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
              {ROLES.filter((entry) => entry !== "owner" || isOwner).map((entry) => (
                <option key={entry} value={entry}>
                  {ROLE_LABELS[entry]}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit">Invite</Button>
        </form>
        <p>
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={limitInvite} onChange={(event) => setLimitInvite(event.target.checked)} />
            Only for certain dates
          </label>{" "}
          <AccessHelp />
        </p>
        {limitInvite ? <AccessDateFields idPrefix="invite-access" value={inviteAccess} onChange={setInviteAccess} /> : null}
      </Card>
      {editing ? (
        <div ref={editorRef}>
          <Card title={`Access dates for ${editing.member.displayName}`} description="Leave a date empty for no limit. An end in the past ends their access now.">
            <form onSubmit={(event) => void saveDates(event)}>
              <AccessDateFields idPrefix="edit-access" value={editing.value} onChange={(value) => setEditing({ ...editing, value })} />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button type="submit">Save dates</Button>
                <Button variant="secondary" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          </Card>
        </div>
      ) : null}
      <Card
        title="People with access"
        actions={
          <Field label="Show">
            <select value={filter} onChange={(event) => setFilter(event.target.value as AccessFilter)}>
              <option value="all">Everyone</option>
              <option value="ending">Access ending in 3 days</option>
              <option value="limited">Access with dates</option>
              <option value="ended">Access ended</option>
            </select>
          </Field>
        }
      >
        {members.error ? <Notice tone="error">{members.error}</Notice> : null}
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Access</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && members.data ? (
                <tr>
                  <td colSpan={5} className={ui.muted}>
                    Nobody matches this filter.
                  </td>
                </tr>
              ) : null}
              {shown.map((member) => {
                const locked = member.role === "owner" && !isOwner;
                const ended = member.accessState === "ended";
                return (
                  <tr key={member.userId} style={ended ? { opacity: 0.6 } : undefined}>
                    <td data-label="Name">
                      {member.displayName} {member.userId === user.id ? <Badge tone="blue">You</Badge> : null}{" "}
                      {member.invited ? <Badge tone="amber">Invited</Badge> : null}{" "}
                      {!member.isActive ? <Badge tone="red">Login disabled</Badge> : null}
                      {member.invited && member.invitationSentAt ? (
                        <div className={ui.muted}>Sent {formatDateTime(member.invitationSentAt)}</div>
                      ) : null}
                      <div>
                        <Link href={`/operations/members/activity?user=${member.userId}`} aria-label={`What ${member.displayName} did`}>
                          What they did
                        </Link>
                      </div>
                    </td>
                    <td data-label="Email" style={{ overflowWrap: "anywhere" }}>{member.email}</td>
                    <td data-label="Role">
                      <select
                        aria-label={`Role for ${member.email}`}
                        value={member.role}
                        disabled={locked}
                        onChange={(event) =>
                          void run(
                            () =>
                              api(`/api/organisations/${organisationId}/members/${member.userId}`, {
                                method: "PATCH",
                                body: { role: event.target.value },
                              }),
                            `${member.email} is now ${ROLE_LABELS[event.target.value as Role].toLowerCase()}.`,
                          )
                        }
                      >
                        {ROLES.filter((entry) => entry !== "owner" || isOwner || member.role === "owner").map((entry) => (
                          <option key={entry} value={entry}>
                            {ROLE_LABELS[entry]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td data-label="Access">
                      <AccessLabel state={member.accessState} from={member.accessFrom} until={member.accessUntil} />
                      <div style={{ marginTop: 6 }}>
                        <AccessQuickActions
                          name={member.displayName}
                          state={member.accessState}
                          disabled={locked}
                          onAction={(action) => void accessAction(member, action)}
                          onChooseDates={() => chooseDates(member)}
                        />
                      </div>
                    </td>
                    <td className={ui.num}>
                      {member.invited ? (
                        <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                          <Button variant="secondary" size="small" disabled={locked} onClick={() => void resend(member)} aria-label={`Resend invitation to ${member.email}`}>
                            Resend
                          </Button>
                          <Button
                            variant="danger"
                            size="small"
                            disabled={locked}
                            aria-label={`Cancel invitation to ${member.email}`}
                            onClick={async () => {
                              if (await confirm(`Cancel the invitation to ${member.email}? Their link stops working.`)) {
                                void run(
                                  () => api(`/api/organisations/${organisationId}/members/${member.userId}/invitation`, { method: "DELETE" }),
                                  `Cancelled the invitation to ${member.email}.`,
                                );
                              }
                            }}
                          >
                            Cancel
                          </Button>
                        </span>
                      ) : (
                      <Button
                        variant="danger"
                        size="small"
                        disabled={locked}
                        onClick={async () => {
                          if (await confirm(`Remove ${member.email} from this organisation?`)) {
                            void run(
                              () => api(`/api/organisations/${organisationId}/members/${member.userId}`, { method: "DELETE" }),
                              `Removed ${member.email}.`,
                            );
                          }
                        }}
                      >
                        Remove
                      </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {members.data ? <MemberFarms organisationId={organisationId} members={members.data.members} /> : null}
      {members.data ? <MemberCameraAccess organisationId={organisationId} members={members.data.members} /> : null}
    </>
  );
}

export default function MembersPage() {
  return (
    <Page>
      <PageHeader title="People and roles" />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <Members key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
