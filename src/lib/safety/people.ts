import { roleAtLeast } from "@/lib/auth/roles";
import { listMembers } from "@/lib/organisations/members";

/**
 * The organisation's members who can be made responsible for a safety
 * action (#446): active, with a farm role (viewer and above), by id and
 * name only. Read from the core database before or beside the
 * organisation's own transaction.
 */
export async function safetyPeople(organisationId: string): Promise<Array<{ userId: string; name: string; role: string }>> {
  const members = await listMembers(organisationId);
  return members.filter((member) => member.isActive && roleAtLeast(member.role, "viewer")).map((member) => ({ userId: member.userId, name: member.displayName || member.email, role: member.role }));
}

export async function safetyPeopleMap(organisationId: string): Promise<Map<string, string>> {
  return new Map((await safetyPeople(organisationId)).map((person) => [person.userId, person.name]));
}
