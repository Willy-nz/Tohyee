"use client";

import { type FormEvent, useState } from "react";
import { memberName, useBusy, useTeam } from "@/components/crm";
import { useApiData } from "@/components/hooks";
import { Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api } from "@/lib/client/api";
import type { SalesTeam } from "@/lib/crm/teams";

type TeamForm = { name: string; managerUserId: string; memberUserIds: string[] };

function TeamEditor({
  organisationId,
  team,
  onDone,
}: {
  organisationId: string;
  team: SalesTeam | null;
  onDone: () => void;
}) {
  const people = useTeam(organisationId).data?.team ?? [];
  const [form, setForm] = useState<TeamForm>({
    name: team?.name ?? "",
    managerUserId: team?.managerUserId ?? "",
    memberUserIds: team?.memberUserIds ?? [],
  });
  const { busy, error, run } = useBusy();
  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const body = { organisationId, ...form };
      if (team) await api(`/api/crm/teams/${team.id}`, { method: "PATCH", body });
      else await api("/api/crm/teams", { method: "POST", body });
      onDone();
    });
  }
  const toggle = (userId: string) =>
    setForm((now) => ({
      ...now,
      memberUserIds: now.memberUserIds.includes(userId) ? now.memberUserIds.filter((id) => id !== userId) : [...now.memberUserIds, userId],
    }));
  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Name">
        <input value={form.name} maxLength={100} required onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </Field>
      <Field label="Manager" hint="Sees the deals, tasks and forecasts of everyone in the team.">
        <select value={form.managerUserId} required onChange={(event) => setForm({ ...form, managerUserId: event.target.value })}>
          <option value="">Choose…</option>
          {people.map((person) => (
            <option key={person.userId} value={person.userId}>
              {person.displayName}
            </option>
          ))}
        </select>
      </Field>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 4 }}>
        <legend className={ui.muted}>Members (each person can be in one team)</legend>
        {people
          .filter((person) => person.userId !== form.managerUserId)
          .map((person) => (
            <label key={person.userId}>
              <input type="checkbox" checked={form.memberUserIds.includes(person.userId)} onChange={() => toggle(person.userId)} /> {person.displayName}
            </label>
          ))}
      </fieldset>
      <span style={{ display: "flex", gap: 8 }}>
        <Button type="submit" disabled={busy}>
          {team ? "Save team" : "Add team"}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

/** CRM › Teams (decision 491): sales teams, each with a manager who sees its members' deals, tasks and forecasts. */
export function TeamsPage({ organisationId }: { organisationId: string }) {
  const { canCrm } = useWorkspace();
  const teams = useApiData<{ teams: SalesTeam[] }>("/api/crm/teams", { organisationId });
  const people = useTeam(organisationId).data?.team;
  const [editing, setEditing] = useState<SalesTeam | "new" | null>(null);
  const { busy, error, run } = useBusy();
  const admin = canCrm("admin");
  const done = () => {
    setEditing(null);
    teams.reload();
  };
  return (
    <>
      {teams.error ? <Notice tone="error">{teams.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Card
        title="Sales teams"
        description="A sales rep sees their own deals and tasks; a team's manager also sees everyone's in the team. Everyone sees every company and person."
        actions={
          admin && editing === null ? (
            <Button size="small" onClick={() => setEditing("new")}>
              Add team
            </Button>
          ) : null
        }
      >
        {editing === "new" ? <TeamEditor organisationId={organisationId} team={null} onDone={done} /> : null}
        {teams.data && teams.data.teams.length === 0 && editing !== "new" ? (
          <Empty>No teams yet.{admin ? " Add one to give a sales manager their team." : ""}</Empty>
        ) : null}
        {(teams.data?.teams ?? []).map((team) =>
          editing !== "new" && editing?.id === team.id ? (
            <TeamEditor key={team.id} organisationId={organisationId} team={team} onDone={done} />
          ) : (
            <div key={team.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderTop: "1px solid var(--line, #e5e5e5)" }}>
              <div>
                <strong>{team.name}</strong>
                <div className={ui.muted}>
                  Manager: {memberName(people, team.managerUserId)}
                  {team.memberUserIds.length > 0 ? ` · ${team.memberUserIds.map((id) => memberName(people, id)).join(", ")}` : " · no members yet"}
                </div>
              </div>
              {admin ? (
                <span style={{ display: "flex", gap: 8 }}>
                  <Button size="small" variant="secondary" disabled={busy || editing !== null} onClick={() => setEditing(team)}>
                    Edit
                  </Button>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={busy || editing !== null}
                    onClick={() =>
                      void run(async () => {
                        await api(`/api/crm/teams/${team.id}`, { method: "DELETE", query: { organisationId } });
                        teams.reload();
                      })
                    }
                  >
                    Remove
                  </Button>
                </span>
              ) : null}
            </div>
          ),
        )}
      </Card>
    </>
  );
}
