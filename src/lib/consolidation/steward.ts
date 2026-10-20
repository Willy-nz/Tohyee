import type { GroupUser } from "@/lib/consolidation/groups";
import type { ConsolidationGroup } from "@/lib/consolidation/types";
import { type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { NotFoundError } from "@/lib/errors";
import { getOrganisation, type OrganisationRecord } from "@/lib/organisations/registry";

/**
 * The steward (decision 641; Codex, delegated by owner, 20 October 2026):
 * the member organisation whose own database holds a group's business
 * records (customer links, stage mappings, saved reports), so they're
 * backed up and moved with an organisation like everything else and the
 * core database stays a registry. Work runs as the signed-in person, who
 * the caller has already checked can see the whole group.
 */
export async function withSteward<T>(user: GroupUser, group: ConsolidationGroup, work: (tx: OrgTx) => Promise<T>, options: { readOnly?: boolean } = {}): Promise<T> {
  const record = await getOrganisation(group.stewardOrganisationId);
  if (!record || !record.isActive) throw new NotFoundError("The organisation that keeps this group's records isn't on this server.");
  return withOrganisationTransaction(record, { userId: user.id, email: user.email }, work, { readOnly: options.readOnly ?? false });
}

/** A member's registry record, for reading its own database. */
export async function memberRecord(organisationId: string): Promise<OrganisationRecord> {
  const record = await getOrganisation(organisationId);
  if (!record || !record.isActive) throw new NotFoundError("That organisation isn't on this server.");
  return record;
}
