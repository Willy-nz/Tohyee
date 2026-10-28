import { createHash, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { writeAuditEvent } from "@/lib/audit";
import { RequestLimiter } from "@/lib/ai/limits";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import { type Actor, assertOrganisationUsable, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { canSeeFarm } from "@/lib/farming/access";
import { getOrganisation, parseOrganisationId } from "@/lib/organisations/registry";
import { personName } from "@/lib/people/names";
import { getEmergency } from "@/lib/safety/hazards";
import { appendEntry, currentRecord, currentRecords, requireSafetyRecorder } from "@/lib/safety/records";
import {
  type Audience,
  AUDIENCES,
  type CurrentRecord,
  type EmergencyData,
  type HazardData,
  hazardState,
  type InductionData,
  type InductionSection,
  type SafetyPerson,
  type SafetyVersion,
  SIGN_STATEMENT,
  type SignedHow,
  type SignoffData,
  type VisitData,
} from "@/lib/safety/shared";
import { optionalString, requireId, requireString } from "@/lib/validation";

/*
 * Inductions, sign-offs and signing in on site (#446, decisions 948-952).
 *
 * - An induction is a safety record (versions). Shared ones (no farm) suit
 *   every farm; each farm's own hazards and emergency details are shown
 *   with it, so local details stay local (William's review).
 * - A sign-off records which induction version and which hazards (id and
 *   version) the person was shown, and how they signed: on their own login,
 *   recorded by someone else for them, or through the farm's sign-in link.
 * - They need to sign again when a version marked "people must sign again"
 *   comes out, or a high or no-go hazard is added or changed after they
 *   signed (decision 949).
 * - Signing in on site is a reported presence, not a tracked location; a
 *   missed sign-out is corrected as a new version, with when they say they
 *   left (decision 951).
 */

// Inductions ---------------------------------------------------------------------------------------

function inductionData(input: Record<string, unknown>): InductionData {
  const audiences = Array.isArray(input.audiences) ? [...new Set(input.audiences.map(String))] : [];
  if (!audiences.length || !audiences.every((each) => AUDIENCES.includes(each as Audience))) throw new ValidationError("Choose who it's for: workers, contractors or visitors.");
  if (!Array.isArray(input.sections) || !input.sections.length || input.sections.length > 30) throw new ValidationError("Add between 1 and 30 sections.");
  const sections: InductionSection[] = input.sections.map((section, index) => {
    const value = (section ?? {}) as Record<string, unknown>;
    return { heading: requireString(value.heading, `Section ${index + 1}'s heading`, { maxLength: 150 }), text: requireString(value.text, `Section ${index + 1}'s text`, { maxLength: 5000 }) };
  });
  const data: InductionData = { title: requireString(input.title, "Induction name", { maxLength: 150 }), audiences: AUDIENCES.filter((each) => audiences.includes(each)), sections, needsResign: input.needsResign === true };
  const why = optionalString(input.why, "Why", { maxLength: 1000 });
  if (why) data.why = why;
  return data;
}

export async function addInduction(tx: OrgTx, input: Record<string, unknown>) {
  requireSafetyRecorder(tx);
  const farmId = input.farmId ? requireId(input.farmId, "Farm") : null;
  return appendEntry<InductionData>(tx, { kind: "induction", change: "created", farmId, data: { ...inductionData(input), needsResign: false }, operationId: input.operationId });
}

/** A new version. `needsResign` asks everyone who signed an earlier version to sign again. */
export async function changeInduction(tx: OrgTx, recordId: unknown, input: Record<string, unknown>) {
  requireSafetyRecorder(tx);
  const current = await currentRecord<InductionData>(tx, "induction", recordId);
  const change = input.change === "corrected" ? "corrected" : input.change === "withdrawn" ? "withdrawn" : "updated";
  const data = change === "withdrawn" ? { ...current.data, needsResign: false, why: optionalString(input.why, "Why", { maxLength: 1000 }) } : inductionData({ ...current.data, why: undefined, ...input });
  return appendEntry<InductionData>(tx, { kind: "induction", recordId: current.recordId, expectedVersion: input.expectedVersion, change, farmId: current.farmId, data: { ...data }, operationId: input.operationId });
}

/** The version people must have signed: the latest marked "sign again", or the first. */
async function signVersions(tx: OrgTx): Promise<Map<string, number>> {
  const rows = await tx.query<{ record_id: string; version: number }>(
    `select record_id::text, max(version) filter (where version = 1 or (body::jsonb->>'needsResign')::boolean) as version
       from safety_entries where kind = 'induction' group by record_id`,
  );
  return new Map(rows.rows.map((row) => [row.record_id, row.version]));
}

export type InductionView = CurrentRecord<InductionData> & { signVersion: number };

/** The inductions for a farm: its own and the shared ones. */
export async function listInductions(tx: OrgTx, farmIdInput: unknown): Promise<InductionView[]> {
  const farmId = requireId(farmIdInput, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const versions = await signVersions(tx);
  const records = await currentRecords<InductionData>(tx, "induction", { farmId });
  return records.map((record) => ({ ...record, signVersion: versions.get(record.recordId) ?? 1 }));
}

type ActiveHazard = { id: string; version: number; title: string; level: HazardData["level"]; noGo: boolean; controls: string | null; paddockIds: string[]; enteredAt: string };

async function activeHazards(tx: OrgTx, farmId: string): Promise<ActiveHazard[]> {
  const hazards = await currentRecords<HazardData>(tx, "hazard", { farmId });
  return hazards
    .filter((hazard) => hazard.farmId === farmId && hazardState(hazard) === "active")
    .map((hazard) => ({ id: hazard.recordId, version: hazard.version, title: hazard.data.title, level: hazard.data.level, noGo: hazard.data.noGo, controls: hazard.data.controls, paddockIds: hazard.data.paddockIds, enteredAt: hazard.enteredAt }));
}

export type InductionToRead = { induction: InductionView; farm: { id: string; name: string }; hazards: ActiveHazard[]; emergency: (SafetyVersion<EmergencyData> & { version: number }) | null };

/** What someone reads before signing: the induction with the farm's hazards and emergency details. */
export async function inductionToRead(tx: OrgTx, inductionIdInput: unknown, farmIdInput: unknown): Promise<InductionToRead> {
  const farmId = requireId(farmIdInput, "Farm");
  const inductions = await listInductions(tx, farmId);
  const induction = inductions.find((each) => each.recordId === inductionIdInput && each.change !== "withdrawn");
  if (!induction) throw new NotFoundError("That induction wasn't found for this farm.");
  const farm = await tx.query<{ name: string }>("select name from farms where id = $1", [farmId]);
  return { induction, farm: { id: farmId, name: farm.rows[0].name }, hazards: await activeHazards(tx, farmId), emergency: await getEmergency(tx, farmId) };
}

function personInput(input: unknown): SafetyPerson {
  const value = (input ?? {}) as Record<string, unknown>;
  return {
    userId: null,
    name: requireString(value.name, "Their name", { maxLength: 150 }),
    company: optionalString(value.company, "Company", { maxLength: 150 }),
    phone: optionalString(value.phone, "Phone", { maxLength: 40 }),
  };
}

function audienceOf(input: unknown, allowed: readonly Audience[]): Audience {
  const audience = (input ?? allowed[0]) as Audience;
  if (!allowed.includes(audience)) throw new ValidationError("Choose worker, contractor or visitor, as the induction is for.");
  return audience;
}

/**
 * Signs an induction for a farm. With no `person`, the signed-in member
 * signs for themselves; with `person`, they record it for someone without
 * a login (shown as recorded, not signed by them). The version read must
 * be the latest; `acknowledged` must be true.
 */
export async function signInduction(tx: OrgTx, input: Record<string, unknown>, how: SignedHow | null = null) {
  const toRead = await inductionToRead(tx, input.inductionId, input.farmId);
  if (input.acknowledged !== true) throw new ValidationError("Tick to say it's been read and understood.");
  if (String(input.inductionVersion ?? "") !== String(toRead.induction.version)) throw new ConflictError("The induction has changed since it was opened. Read it again, then sign.");
  let person: SafetyPerson;
  let signedHow: SignedHow;
  if (how === "link") {
    person = personInput(input.person);
    signedHow = "link";
  } else if (input.person) {
    requireSafetyRecorder(tx);
    person = personInput(input.person);
    signedHow = "recorded";
  } else {
    if (!tx.actor.userId) throw new ValidationError("Sign in to sign for yourself.");
    person = { userId: tx.actor.userId, name: personName(tx, tx.actor.email), company: null, phone: null };
    signedHow = "self";
  }
  const data: SignoffData = {
    inductionId: toRead.induction.recordId,
    inductionVersion: toRead.induction.version,
    person,
    audience: audienceOf(input.audience, toRead.induction.data.audiences),
    signedHow,
    statement: SIGN_STATEMENT,
    hazards: toRead.hazards.map((hazard) => ({ id: hazard.id, version: hazard.version })),
    emergencyVersion: toRead.emergency?.version ?? null,
  };
  return appendEntry<SignoffData>(tx, { kind: "induction_signoff", change: "created", farmId: toRead.farm.id, happenedOn: todayIsoDate(), data: { ...data }, operationId: input.operationId });
}

export type SignoffView = CurrentRecord<SignoffData> & { current: boolean; reasons: string[] };

const personKey = (person: SafetyPerson) => (person.userId ? `user:${person.userId}` : `name:${person.name.trim().toLowerCase()}|${(person.company ?? "").trim().toLowerCase()}`);

/**
 * Each person's latest sign-off of each induction on a farm, and whether it
 * still stands: not if the induction has a "sign again" version after it,
 * or a high or no-go hazard was added or changed since (decision 949).
 */
export async function listSignoffs(tx: OrgTx, farmIdInput: unknown): Promise<SignoffView[]> {
  const farmId = requireId(farmIdInput, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const versions = await signVersions(tx);
  const hazards = await activeHazards(tx, farmId);
  const signoffs = await currentRecords<SignoffData>(tx, "induction_signoff", { farmId });
  const latest = new Map<string, CurrentRecord<SignoffData>>();
  for (const signoff of signoffs) latest.set(`${signoff.data.inductionId}|${personKey(signoff.data.person)}`, signoff);
  return [...latest.values()]
    .map((signoff) => {
      const reasons: string[] = [];
      if ((versions.get(signoff.data.inductionId) ?? 1) > signoff.data.inductionVersion) reasons.push("The induction has changed and needs signing again.");
      const seen = new Map(signoff.data.hazards.map((hazard) => [hazard.id, hazard.version]));
      for (const hazard of hazards) {
        if (!(hazard.level === "high" || hazard.noGo)) continue;
        const was = seen.get(hazard.id);
        if (was === undefined) reasons.push(`New since they signed: ${hazard.title}.`);
        else if (was < hazard.version) reasons.push(`Changed since they signed: ${hazard.title}.`);
      }
      return { ...signoff, current: reasons.length === 0, reasons };
    })
    .sort((a, b) => a.data.person.name.localeCompare(b.data.person.name));
}

// Signing in on site --------------------------------------------------------------------------------

export async function signIn(tx: OrgTx, input: Record<string, unknown>, how: SignedHow | null = null) {
  const farmId = requireId(input.farmId, "Farm");
  let person: SafetyPerson;
  let signedHow: SignedHow;
  if (how === "link") {
    person = personInput(input.person);
    signedHow = "link";
  } else if (input.person) {
    requireSafetyRecorder(tx);
    person = personInput(input.person);
    signedHow = "recorded";
  } else {
    if (!tx.actor.userId) throw new ValidationError("Sign in to Tohyee first.");
    person = { userId: tx.actor.userId, name: personName(tx, tx.actor.email), company: null, phone: null };
    signedHow = "self";
  }
  const audience = audienceOf(input.audience ?? (person.userId ? "worker" : "visitor"), AUDIENCES);
  const phoneTime = how === "link" ? null : phoneTimeOf(input.phoneTime);
  const data: VisitData = { person, audience, purpose: optionalString(input.purpose, "What for", { maxLength: 300 }), signedOut: false, leftAt: null, signedHow, ...(phoneTime ? { phoneTime } : {}) };
  return appendEntry<VisitData>(tx, { kind: "visit", change: "created", farmId, happenedOn: todayIsoDate(), data: { ...data }, operationId: input.operationId });
}

/**
 * The phone's time for a sign-in or sign-out recorded without a connection
 * and sent later (#472, decision 1014): kept as the phone's, shown as such,
 * never in the future, and no more than 7 days back.
 */
export function phoneTimeOf(input: unknown, now = Date.now()): string | null {
  if (input === undefined || input === null || input === "") return null;
  const time = new Date(String(input));
  if (Number.isNaN(time.getTime())) throw new ValidationError("The phone's time isn't a date and time.");
  if (time.getTime() > now + 5 * 60_000) throw new ValidationError("The phone's time is in the future. Check the phone's clock.");
  if (time.getTime() < now - 7 * 86_400_000) throw new ValidationError("This was recorded on the phone more than 7 days ago. Ask whoever keeps the registers to record it with when it happened.");
  return time.toISOString();
}

/**
 * Signs someone out (the entry time is when). A sign-out missed earlier is
 * fixed with `leftAt` (when they say they left) and why, as a correction.
 */
export async function signOut(tx: OrgTx, recordId: unknown, input: Record<string, unknown> = {}) {
  // A sign-out sent again from the phone's queue (a dropped connection) finds the first (#472).
  if (input.operationId) {
    const again = await tx.query<{ record_id: string }>("select record_id::text from safety_entries where operation_id = $1 and kind = 'visit'", [String(input.operationId).slice(0, 100)]);
    if (again.rows[0]) {
      if (again.rows[0].record_id !== String(recordId)) throw new ConflictError("This save was already sent with different details. Reload and check the record.");
      return currentRecord<VisitData>(tx, "visit", recordId);
    }
  }
  const current = await currentRecord<VisitData>(tx, "visit", recordId);
  if (current.data.signedOut) throw new ValidationError("They're already signed out.");
  const own = current.data.person.userId !== null && current.data.person.userId === tx.actor.userId;
  if (!own && tx.actor.userId) requireSafetyRecorder(tx);
  if (input.leftAt) {
    const leftAt = new Date(String(input.leftAt));
    if (Number.isNaN(leftAt.getTime())) throw new ValidationError("When they left isn't a date and time.");
    if (leftAt.getTime() > Date.now()) throw new ValidationError("When they left can't be in the future.");
    if (leftAt.getTime() < new Date(current.enteredAt).getTime()) throw new ValidationError("When they left is before they signed in.");
    const why = requireString(input.why, "Why it's corrected (e.g. forgot to sign out)", { maxLength: 1000 });
    return appendEntry<VisitData>(tx, { kind: "visit", recordId: current.recordId, expectedVersion: current.version, change: "corrected", farmId: current.farmId, happenedOn: current.happenedOn, data: { ...current.data, signedOut: true, leftAt: leftAt.toISOString(), why } });
  }
  // Signed out on a phone with no connection: when they left is the phone's time (decision 1014).
  const phoneTime = phoneTimeOf(input.phoneTime);
  const signedInAt = current.data.phoneTime ?? current.enteredAt;
  if (phoneTime && phoneTime < new Date(signedInAt).toISOString()) throw new ValidationError("The phone's sign-out time is before they signed in. Check the phone's clock.");
  return appendEntry<VisitData>(tx, { kind: "visit", recordId: current.recordId, expectedVersion: current.version, change: "updated", farmId: current.farmId, happenedOn: current.happenedOn, data: { ...current.data, signedOut: true, leftAt: phoneTime, ...(phoneTime ? { phoneTime } : {}) }, operationId: input.operationId });
}

/** Who has signed in and not out (any day), and today's sign-outs: a reported presence, with when each was last updated. */
export async function onSite(tx: OrgTx, farmIdInput: unknown) {
  const farmId = requireId(farmIdInput, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const today = todayIsoDate();
  const visits = await currentRecords<VisitData>(tx, "visit", { farmId });
  return {
    here: visits.filter((visit) => !visit.data.signedOut),
    leftToday: visits.filter((visit) => visit.data.signedOut && visit.happenedOn === today),
  };
}

// The farm's sign-in link ----------------------------------------------------------------------------

export const SITE_PATH = "/site";
const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const siteLimiter = new RequestLimiter(30, 10 * 60 * 1000);
const SITE_ACTOR: Actor = { userId: null, email: "site sign-in link", via: "farm sign-in link" };

export type SiteLink = { id: string; farmId: string; createdByEmail: string; createdAt: string; expiresOn: string | null; on: boolean; lastUsedAt: string | null };

export async function listSiteLinks(tx: OrgTx, farmIdInput: unknown): Promise<SiteLink[]> {
  const farmId = requireId(farmIdInput, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const rows = await tx.query<{ id: string; farm_id: string; created_by_email: string; created_at: string; expires_on: string | null; turned_off_at: string | null; last_used_at: string | null }>(
    "select id::text, farm_id::text, created_by_email, created_at, expires_on, turned_off_at, last_used_at from safety_site_links where farm_id = $1 order by safety_site_links.created_at desc",
    [farmId],
  );
  const today = todayIsoDate();
  return rows.rows.map((row) => ({ id: row.id, farmId: row.farm_id, createdByEmail: row.created_by_email, createdAt: row.created_at, expiresOn: row.expires_on, on: !row.turned_off_at && (!row.expires_on || row.expires_on >= today), lastUsedAt: row.last_used_at }));
}

/** A new sign-in link for a farm (shown once, with its QR code). */
export async function makeSiteLink(tx: OrgTx, input: { farmId?: unknown; expiresOn?: unknown }, origin: string) {
  requireSafetyRecorder(tx);
  const farmId = requireId(input.farmId, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const expiresOn = input.expiresOn ? parseIsoDate(input.expiresOn, "Works until") : null;
  if (expiresOn && expiresOn < todayIsoDate()) throw new ValidationError("Works until is in the past.");
  const token = randomBytes(32).toString("base64url");
  const row = await tx.query<{ id: string }>("insert into safety_site_links (farm_id, token_hash, expires_on, created_by_email) values ($1, $2, $3, $4) returning id::text", [farmId, hashToken(token), expiresOn, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "safety.site_link_made", entityType: "safety_site_link", entityId: row.rows[0].id, details: { farmId, expiresOn } });
  const url = `${origin.replace(/\/+$/, "")}${SITE_PATH}/${tx.organisationId}/${token}`;
  return { url, qrSvg: await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" }), links: await listSiteLinks(tx, farmId) };
}

export async function turnOffSiteLink(tx: OrgTx, idInput: unknown) {
  requireSafetyRecorder(tx);
  const id = requireId(idInput, "Link");
  const row = await tx.query<{ farm_id: string }>("select farm_id::text from safety_site_links where id = $1", [id]);
  if (!row.rows[0] || !(await canSeeFarm(tx, row.rows[0].farm_id))) throw new NotFoundError("That link wasn't found.");
  await tx.query("update safety_site_links set turned_off_at = coalesce(turned_off_at, now()), turned_off_by_email = coalesce(turned_off_by_email, $2) where id = $1", [id, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "safety.site_link_off", entityType: "safety_site_link", entityId: id });
  return listSiteLinks(tx, row.rows[0].farm_id);
}

/**
 * Runs `work` for a sign-in link, or returns null ("not found") alike for a
 * wrong, turned-off or expired link, Farming off, an organisation that
 * isn't usable, or too many requests.
 */
async function withSiteLink<T>(organisationInput: string, token: string, work: (tx: OrgTx, farmId: string) => Promise<T>): Promise<T | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  let organisationId: string;
  try {
    organisationId = parseOrganisationId(organisationInput);
  } catch {
    return null;
  }
  const organisation = await getOrganisation(organisationId);
  if (!organisation) return null;
  try {
    assertOrganisationUsable(organisation);
  } catch {
    return null;
  }
  const hash = hashToken(token);
  if (!siteLimiter.take(`${organisationId}:${hash}`)) return null;
  return withOrganisationTransaction(organisation, SITE_ACTOR, async (tx) => {
    const on = await tx.query<{ enabled: boolean }>("select enabled from farming_settings where id = true");
    if (on.rows[0]?.enabled !== true) return null;
    const link = await tx.query<{ farm_id: string }>(
      `select l.farm_id::text from safety_site_links l join farms f on f.id = l.farm_id
        where l.token_hash = $1 and l.turned_off_at is null and (l.expires_on is null or l.expires_on >= $2) and f.is_active`,
      [hash, todayIsoDate()],
    );
    if (!link.rows[0]) return null;
    await tx.query("update safety_site_links set last_used_at = now() where token_hash = $1", [hash]);
    return work(tx, link.rows[0].farm_id);
  });
}

/** What the gate page shows: the farm's name, the organisation's name and address (privacy notice), emergency details, hazards and its visitor and contractor inductions. Never people or reports. */
export async function publicSite(organisationInput: string, token: string) {
  return withSiteLink(organisationInput, token, async (tx, farmId) => {
    const farm = await tx.query<{ name: string }>("select name from farms where id = $1", [farmId]);
    const organisation = await tx.query<{ display_name: string; postal_address: string | null }>("select display_name, postal_address from organisation_settings where id = true");
    const paddocks = await tx.query<{ id: string; name: string }>("select id::text, name from paddocks where farm_id = $1", [farmId]);
    const names = new Map(paddocks.rows.map((row) => [row.id, row.name]));
    const inductions = (await listInductions(tx, farmId)).filter((induction) => induction.data.audiences.some((audience) => audience !== "worker"));
    const emergency = await getEmergency(tx, farmId);
    return {
      farmName: farm.rows[0].name,
      // For the privacy notice (decision 966): the organisation's name and address from its settings.
      organisation: { name: organisation.rows[0].display_name, postalAddress: organisation.rows[0].postal_address },
      emergency: emergency ? { data: emergency.data, version: emergency.version, enteredAt: emergency.enteredAt } : null,
      hazards: (await activeHazards(tx, farmId)).map((hazard) => ({ ...hazard, paddocks: hazard.paddockIds.map((id) => names.get(id) ?? id) })),
      inductions: inductions.map((induction) => ({ id: induction.recordId, version: induction.version, title: induction.data.title, audiences: induction.data.audiences.filter((audience) => audience !== "worker"), sections: induction.data.sections })),
    };
  });
}

/** Signs someone in through the link (and signs the induction they read). Returns their own sign-out token. */
export async function publicSignIn(organisationInput: string, token: string, input: Record<string, unknown>) {
  return withSiteLink(organisationInput, token, async (tx, farmId) => {
    const person = personInput(input.person);
    const audience = input.audience === "contractor" ? "contractor" : "visitor";
    if (input.inductionId) {
      await signInduction(tx, { inductionId: input.inductionId, inductionVersion: input.inductionVersion, farmId, acknowledged: input.acknowledged, person, audience, operationId: input.operationId ? `${String(input.operationId).slice(0, 100)}-i` : undefined }, "link");
    }
    const visit = await signIn(tx, { farmId, person, audience, purpose: input.purpose, operationId: input.operationId }, "link");
    const signOutToken = randomBytes(32).toString("base64url");
    await tx.query("insert into safety_site_checkouts (visit_record_id, token_hash) values ($1, $2) on conflict (visit_record_id) do update set token_hash = excluded.token_hash", [visit.recordId, hashToken(signOutToken)]);
    return { signedInAt: visit.enteredAt, signOutToken };
  });
}

/** Signs out the person who signed in on this phone (their own sign-out token, used once). */
export async function publicSignOut(organisationInput: string, token: string, signOutToken: unknown) {
  return withSiteLink(organisationInput, token, async (tx) => {
    if (typeof signOutToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(signOutToken)) throw new NotFoundError("That sign-in wasn't found.");
    const row = await tx.query<{ visit_record_id: string }>("update safety_site_checkouts set used_at = now() where token_hash = $1 and used_at is null returning visit_record_id::text", [hashToken(signOutToken)]);
    if (!row.rows[0]) throw new NotFoundError("That sign-in wasn't found, or you've already signed out.");
    const visit = await signOut(tx, row.rows[0].visit_record_id);
    return { signedOutAt: visit.enteredAt };
  });
}
