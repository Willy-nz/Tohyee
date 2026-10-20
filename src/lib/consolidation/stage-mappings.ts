import { writeAdminAuditEvent } from "@/lib/audit";
import { type GroupUser, requireGroup } from "@/lib/consolidation/groups";
import { memberRecord, withSteward } from "@/lib/consolidation/steward";
import type { ConsolidationGroup } from "@/lib/consolidation/types";
import { invalidateGroupWorkspace } from "@/lib/consolidation/workspace-cache";
import { type MemberStage, resolveStages, type StageMapping } from "@/lib/consolidation/workspace-figures";
import { crmEnabled } from "@/lib/crm/switch";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { withCoreTransaction } from "@/lib/db/transactions";
import { ValidationError } from "@/lib/errors";
import { asRecord, requireArray, requireString } from "@/lib/validation";

/**
 * Reviewed stage mappings (decision 643; Codex, delegated by owner, 20
 * October 2026): which group stage each member's opportunity stage counts
 * as in the workspace's pipeline. A person chooses them; Tohyee only
 * combines stages without one when they're the same in every organisation.
 * Kept by the group's steward. They change no organisation's own stages.
 */

export type StageMappingView = {
  /** Members with the CRM on, whose stages are compared. */
  organisationIds: string[];
  /** Members with the CRM off: their stages aren't compared. */
  crmOff: string[];
  stages: Array<MemberStage & { groupStage: string | null; how: "mapped" | "same" | "unmapped"; mappedByEmail: string | null }>;
};

export async function readMemberStages(user: GroupUser, group: ConsolidationGroup): Promise<{ stages: MemberStage[]; crmOn: string[]; crmOff: string[] }> {
  const stages: MemberStage[] = [];
  const crmOn: string[] = [];
  const crmOff: string[] = [];
  for (const member of group.members) {
    const record = await memberRecord(member.organisationId);
    const found = await withOrganisationTransaction(
      record,
      { userId: user.id, email: user.email },
      async (tx) => {
        if (!(await crmEnabled(tx))) return null;
        return (await tx.query<{ key: string; name: string; stage_type: string }>("select key, name, stage_type from crm_opportunity_stages order by sort_order, crm_opportunity_stages.id")).rows;
      },
      { readOnly: true },
    );
    if (found === null) {
      crmOff.push(member.organisationId);
      continue;
    }
    crmOn.push(member.organisationId);
    for (const row of found) stages.push({ organisationId: member.organisationId, key: row.key, name: row.name, type: row.stage_type });
  }
  return { stages, crmOn, crmOff };
}

export async function readStageMappings(user: GroupUser, group: ConsolidationGroup): Promise<Array<StageMapping & { mappedByEmail: string }>> {
  const found = await withSteward(
    user,
    group,
    (tx) =>
      tx.query<{ organisation_id: string; stage_key: string; group_stage: string; mapped_by_email: string }>(
        "select organisation_id, stage_key, group_stage, mapped_by_email from group_stage_mappings where group_id = $1 order by organisation_id, stage_key",
        [group.id],
      ),
    { readOnly: true },
  );
  return found.rows.map((row) => ({ organisationId: row.organisation_id, stageKey: row.stage_key, groupStage: row.group_stage, mappedByEmail: row.mapped_by_email }));
}

async function view(user: GroupUser, group: ConsolidationGroup): Promise<StageMappingView> {
  const { stages, crmOn, crmOff } = await readMemberStages(user, group);
  const mappings = (await readStageMappings(user, group)).filter((mapping) => crmOn.includes(mapping.organisationId));
  const { resolved } = resolveStages(stages, mappings, crmOn);
  return {
    organisationIds: crmOn,
    crmOff,
    stages: stages.map((stage) => {
      const id = `${stage.organisationId}|${stage.key}`;
      const mapping = mappings.find((item) => item.organisationId === stage.organisationId && item.stageKey === stage.key);
      return { ...stage, groupStage: resolved.get(id) ?? null, how: mapping ? "mapped" : resolved.has(id) ? "same" : "unmapped", mappedByEmail: mapping?.mappedByEmail ?? null };
    }),
  };
}

export async function listStageMappings(user: GroupUser, groupIdInput: unknown): Promise<StageMappingView> {
  return view(user, await requireGroup(user, groupIdInput));
}

/**
 * Saves mappings: `{ mappings: [{ organisationId, stageKey, groupStage }] }`,
 * a blank group stage taking the mapping away. Admins of every organisation.
 */
export async function saveStageMappings(user: GroupUser, groupIdInput: unknown, input: Record<string, unknown>): Promise<StageMappingView> {
  const group = await requireGroup(user, groupIdInput, "admin");
  const { stages } = await readMemberStages(user, group);
  const entries = requireArray(input.mappings, "mappings", 500).map((entry, index) => {
    const record = asRecord(entry, `Mapping ${index + 1}`);
    const organisationId = requireString(record.organisationId, `Mapping ${index + 1}'s organisation`);
    const stageKey = requireString(record.stageKey, `Mapping ${index + 1}'s stage`);
    if (!stages.some((stage) => stage.organisationId === organisationId && stage.key === stageKey)) {
      throw new ValidationError(`Mapping ${index + 1}: that organisation has no such stage (or its CRM is off).`);
    }
    const raw = typeof record.groupStage === "string" ? record.groupStage.trim() : "";
    if (raw.length > 60) throw new ValidationError(`Mapping ${index + 1}: the group stage can be at most 60 characters.`);
    return { organisationId, stageKey, groupStage: raw };
  });
  await withSteward(user, group, async (tx) => {
    for (const entry of entries) {
      if (entry.groupStage === "") {
        await tx.query("delete from group_stage_mappings where group_id = $1 and organisation_id = $2 and stage_key = $3", [group.id, entry.organisationId, entry.stageKey]);
      } else {
        await tx.query(
          `insert into group_stage_mappings (group_id, organisation_id, stage_key, group_stage, mapped_by_email) values ($1, $2, $3, $4, $5)
           on conflict (group_id, organisation_id, stage_key) do update set group_stage = excluded.group_stage, mapped_by_email = excluded.mapped_by_email, mapped_at = now()`,
          [group.id, entry.organisationId, entry.stageKey, entry.groupStage, user.email],
        );
      }
    }
  });
  await withCoreTransaction((client) =>
    writeAdminAuditEvent(client, { userId: user.id, email: user.email }, { eventType: "consolidation_group.stages_mapped", entityType: "consolidation_group", entityId: group.id, details: { mappings: entries } }),
  );
  invalidateGroupWorkspace(group.id);
  return view(user, group);
}
