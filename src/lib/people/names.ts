import { coreQuery } from "@/lib/db/transactions";

/**
 * People's names for screens. Organisation databases record who did
 * something by email (e.g. `created_by_email`), because users live in the
 * core database. Names are looked up from the core `users` table when data is
 * read, rather than copied into organisation databases, so a renamed person
 * shows their current name everywhere and posted history is never rewritten.
 * Anyone who can't be found (a deleted user, `cli`, a scheduled job) shows as
 * the email that was recorded.
 */

/** Lower-cased email -> display name. */
export type PeopleNames = ReadonlyMap<string, string>;

export const NO_PEOPLE: PeopleNames = new Map();

/** Every member of the organisation, in one query. */
export async function loadMemberNames(organisationId: string): Promise<PeopleNames> {
  const result = await coreQuery<{ email: string; display_name: string }>(
    `select u.email, u.display_name
       from organisation_members m join users u on u.id = m.user_id
      where m.organisation_id = $1`,
    [organisationId],
  );
  return new Map(result.rows.map((row) => [row.email.toLowerCase(), row.display_name]));
}

/** Any users with these emails (members or not), in one query. */
export async function lookupUserNames(emails: readonly string[]): Promise<PeopleNames> {
  if (emails.length === 0) return NO_PEOPLE;
  const result = await coreQuery<{ email: string; display_name: string }>(
    "select email, display_name from users where email = any($1::text[])",
    [emails.map((email) => email.toLowerCase())],
  );
  return new Map(result.rows.map((row) => [row.email.toLowerCase(), row.display_name]));
}

/** The person's name, or the email itself if they can't be found. */
export function nameOf(people: PeopleNames, email: string): string {
  return people.get(email.toLowerCase()) ?? email;
}

/**
 * Keys in API responses that hold the email of a person who did something:
 * `createdByEmail`, `voidedByEmail`, ..., `userEmail`, `claimantEmail`,
 * `actorEmail`, `operatorEmail`. Contact and CRM addresses (`email`,
 * `fromEmail`, `toEmails`) aren't people in Tohyee, so they're left alone.
 */
const PERSON_EMAIL_KEY = /^(?:[a-z][A-Za-z]*By|user|claimant|actor|operator)Email$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function walk(value: unknown, visit: (record: Record<string, unknown>, key: string, email: string) => void, depth = 0): void {
  if (depth > 20) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, depth + 1);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && PERSON_EMAIL_KEY.test(key)) {
      visit(value, key, child);
    } else if (child !== null && typeof child === "object") {
      walk(child, visit, depth + 1);
    }
  }
}

/**
 * Adds a name beside every person's email in a response: `createdByEmail`
 * gets `createdByName`, `userEmail` gets `userName`, and so on. Names come
 * from `known` (the organisation's members), and anyone else from one more
 * query for just those emails. The emails stay, since screens use them to
 * tell who's who.
 */
export async function addPersonNames<T>(value: T, known: PeopleNames = NO_PEOPLE): Promise<T> {
  const unknown = new Set<string>();
  walk(value, (_record, _key, email) => {
    if (!known.has(email.toLowerCase())) unknown.add(email.toLowerCase());
  });
  const found = await lookupUserNames([...unknown]);
  walk(value, (record, key, email) => {
    const lower = email.toLowerCase();
    record[`${key.slice(0, -"Email".length)}Name`] = known.get(lower) ?? found.get(lower) ?? email;
  });
  return value;
}

/** The name of a person recorded by email in the organisation's data, inside a transaction. */
export function personName(tx: { people: PeopleNames }, email: string): string {
  return nameOf(tx.people, email);
}
