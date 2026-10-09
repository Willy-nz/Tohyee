import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { listMembers } from "@/lib/organisations/members";
import { requireArray, requireId, requireString } from "@/lib/validation";

/**
 * Sales teams (decision 491, #216): an admin or owner makes them. Each has
 * one manager, who sees its members' deals, tasks and forecasts; a person is
 * a member of one team at most. A team's manager is usually a Sales manager,
 * but can be anyone in the organisation.
 */
export type SalesTeam = {
  id: string;
  name: string;
  managerUserId: string;
  memberUserIds: string[];
  createdAt: string;
};

export async function listSalesTeams(tx: OrgTx): Promise<SalesTeam[]> {
  const result = await tx.query<{ id: string; name: string; manager_user_id: string; members: string[]; created_at: string }>(
    `select t.id::text, t.name, t.manager_user_id, t.created_at,
            coalesce((select array_agg(m.user_id order by m.user_id) from crm_team_members m where m.team_id = t.id), '{}') as members
       from crm_teams t
      order by lower(t.name), t.id`,
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name, managerUserId: row.manager_user_id, memberUserIds: row.members, createdAt: row.created_at }));
}

async function getSalesTeam(tx: OrgTx, id: string): Promise<SalesTeam> {
  const team = (await listSalesTeams(tx)).find((entry) => entry.id === id);
  if (!team) throw new NotFoundError("Sales team not found.");
  return team;
}

type TeamInput = { name?: unknown; managerUserId?: unknown; memberUserIds?: unknown };

async function teamValues(tx: OrgTx, input: TeamInput, current: SalesTeam | null) {
  const members = new Set((await listMembers(tx.organisationId)).map((member) => member.userId));
  const name = input.name === undefined && current ? current.name : requireString(input.name, "name", { maxLength: 100 });
  const managerUserId = input.managerUserId === undefined && current ? current.managerUserId : requireString(input.managerUserId, "managerUserId", { maxLength: 100 });
  if (!members.has(managerUserId)) throw new ValidationError("The manager must be a member of the organisation.");
  const memberUserIds =
    input.memberUserIds === undefined && current
      ? current.memberUserIds
      : [...new Set(requireArray(input.memberUserIds ?? [], "memberUserIds", 200).map((id, index) => requireString(id, `memberUserIds[${index}]`, { maxLength: 100 })))];
  for (const id of memberUserIds) if (!members.has(id)) throw new ValidationError("Every member must be a member of the organisation.");
  return { name, managerUserId, memberUserIds: memberUserIds.filter((id) => id !== managerUserId).sort() };
}

/** Members already in another team are refused: a person is in one team at most. */
async function setMembers(tx: OrgTx, teamId: string, memberUserIds: string[]): Promise<void> {
  const taken = await tx.query<{ user_id: string; name: string }>(
    `select m.user_id, t.name from crm_team_members m join crm_teams t on t.id = m.team_id
      where m.user_id = any($1::text[]) and m.team_id <> $2`,
    [memberUserIds, teamId],
  );
  if (taken.rows[0]) {
    const people = new Map((await listMembers(tx.organisationId)).map((member) => [member.userId, member.displayName]));
    throw new ConflictError(`${people.get(taken.rows[0].user_id) ?? "Someone"} is already in the team ${taken.rows[0].name}. Take them out of it first.`);
  }
  await tx.query("delete from crm_team_members where team_id = $1 and not (user_id = any($2::text[]))", [teamId, memberUserIds]);
  for (const userId of memberUserIds) {
    await tx.query(
      `insert into crm_team_members (user_id, team_id, added_by_email) values ($1, $2, $3) on conflict (user_id) do nothing`,
      [userId, teamId, tx.actor.email],
    );
  }
}

function nameTaken(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

export async function createSalesTeam(tx: OrgTx, input: TeamInput): Promise<SalesTeam> {
  const values = await teamValues(tx, input, null);
  let id: string;
  try {
    id = (
      await tx.query<{ id: string }>("insert into crm_teams (name, manager_user_id, created_by_email) values ($1, $2, $3) returning id::text", [
        values.name,
        values.managerUserId,
        tx.actor.email,
      ])
    ).rows[0].id;
  } catch (error) {
    if (nameTaken(error)) throw new ConflictError(`There's already a team called ${values.name}.`);
    throw error;
  }
  await setMembers(tx, id, values.memberUserIds);
  await writeAuditEvent(tx, { eventType: "crm.team_created", entityType: "crm_team", entityId: id, details: values });
  return getSalesTeam(tx, id);
}

export async function updateSalesTeam(tx: OrgTx, idInput: unknown, input: TeamInput): Promise<SalesTeam> {
  const current = await getSalesTeam(tx, requireId(idInput, "teamId"));
  const values = await teamValues(tx, input, current);
  try {
    await tx.query("update crm_teams set name = $2, manager_user_id = $3, updated_at = now() where id = $1", [current.id, values.name, values.managerUserId]);
  } catch (error) {
    if (nameTaken(error)) throw new ConflictError(`There's already a team called ${values.name}.`);
    throw error;
  }
  await setMembers(tx, current.id, values.memberUserIds);
  await writeAuditEvent(tx, { eventType: "crm.team_updated", entityType: "crm_team", entityId: current.id, details: values });
  return getSalesTeam(tx, current.id);
}

/** A team can be removed: its members' deals and tasks stay theirs; only the manager stops seeing them. */
export async function removeSalesTeam(tx: OrgTx, idInput: unknown): Promise<void> {
  const current = await getSalesTeam(tx, requireId(idInput, "teamId"));
  await tx.query("delete from crm_teams where id = $1", [current.id]);
  await writeAuditEvent(tx, { eventType: "crm.team_removed", entityType: "crm_team", entityId: current.id, details: { name: current.name } });
}
