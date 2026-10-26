import { rm } from "node:fs/promises";
import { writeAdminAuditEvent } from "@/lib/audit";
import { closeAnalytics } from "@/lib/analytics/engine";
import { analyticsFilePath, analyticsWorkFolder } from "@/lib/analytics/paths";
import { todayIsoDate } from "@/lib/dates";
import { closeOrganisationPool, getAdminPool } from "@/lib/db/pools";
import { quoteSqlIdentifier } from "@/lib/db/sql";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { normaliseEmail } from "@/lib/auth/service";
import { ConflictError, NotFoundError, UnavailableError, ValidationError } from "@/lib/errors";
import { databaseNameFor } from "@/lib/organisations/admin";
import { provisionOrganisation } from "@/lib/organisations/provisioning";
import { getOrganisation } from "@/lib/organisations/registry";
import { buildDemoFarm } from "@/lib/demo/build";
import { DEMO_FARM_NAME, demoFarmEnabled, DEMO_JOBS_PAUSED_REASON, DEMO_OFF_MESSAGE } from "@/lib/demo/switch";

/*
 * Adding, resetting and deleting the demo farm (#437, decisions 855-869).
 * The registry row is made first (one per person, enforced by the database),
 * with the organisation's automatic jobs paused for good; the database is
 * then set up and filled in the background, and the progress kept on the
 * row for the page to show. It joins the person's organisation list when
 * it's done.
 */

export type DemoPerson = { id: string; email: string };

/**
 * Who asked, when it isn't the person themselves (#445): a server admin adding,
 * resetting or deleting someone's demo farm from the server settings. It's
 * kept in the audit log; the farm is still made as its person.
 */
type DemoOptions = { actor?: DemoPerson };

/** "You" for the person themselves, otherwise their email, so a server admin's messages say whose demo farm it is. */
function who(person: DemoPerson, actor: DemoPerson | undefined): { self: boolean; subject: string; has: string } {
  if (!actor || actor.id === person.id) return { self: true, subject: "You", has: "have" };
  return { self: false, subject: person.email, has: "has" };
}

export type DemoFarm = {
  organisationId: string;
  displayName: string;
  status: "building" | "ready" | "failed";
  step: string | null;
  percent: number;
  error: string | null;
  startedAt: string | null;
  /** How long the last build took, in seconds. */
  buildSeconds: number | null;
};

/** A build that hasn't moved for this long was cut off (the server stopped): it shows as failed. */
const STALLED_MINUTES = 15;
/** How many demo farms one server makes at the same time. */
const MAX_BUILDS_AT_ONCE = 2;
const building = new Set<string>();

type Row = {
  id: string;
  display_name: string;
  demo_status: DemoFarm["status"];
  demo_step: string | null;
  demo_percent: number | null;
  demo_error: string | null;
  demo_started_at: Date | null;
  demo_build_ms: number | null;
  stalled: boolean;
};

function toDemo(row: Row): DemoFarm {
  const stalled = row.demo_status === "building" && row.stalled;
  return {
    organisationId: row.id,
    displayName: row.display_name,
    status: stalled ? "failed" : row.demo_status,
    step: row.demo_step,
    percent: row.demo_percent ?? 0,
    error: stalled ? "Making the demo farm stopped part way (the server may have restarted). Reset it to start again." : row.demo_error,
    startedAt: row.demo_started_at ? new Date(row.demo_started_at).toISOString() : null,
    buildSeconds: row.demo_build_ms === null ? null : Math.round(row.demo_build_ms / 100) / 10,
  };
}

/** The person's demo farm, if they have one. */
export async function getDemoFarm(userId: string): Promise<DemoFarm | null> {
  const result = await coreQuery<Row>(
    `select id, display_name, demo_status, demo_step, demo_percent, demo_error, demo_started_at, demo_build_ms,
            coalesce(demo_updated_at, demo_started_at) < now() - make_interval(mins => $2) as stalled
       from organisations where demo_for_user_id = $1`,
    [userId, STALLED_MINUTES],
  );
  return result.rows[0] ? toDemo(result.rows[0]) : null;
}

/** A short, fixed ID for a person's demo farm, e.g. demo-farm-1a2b3c4d. */
export function demoOrganisationId(userId: string): string {
  return `demo-farm-${userId.replace(/-/g, "").slice(0, 8)}`;
}

function requireOn(): void {
  if (!demoFarmEnabled()) throw new NotFoundError(DEMO_OFF_MESSAGE);
}

/**
 * Starts making the person's demo farm and returns straight away; the build
 * runs in the background (`wait` runs it in the foreground, for the command
 * line and tests). With `reset`, an existing one is deleted first.
 */
export async function addDemoFarm(person: DemoPerson, options: DemoOptions & { reset?: boolean; today?: string; wait?: boolean } = {}): Promise<DemoFarm> {
  requireOn();
  const them = who(person, options.actor);
  const existing = await getDemoFarm(person.id);
  if (existing) {
    if (!options.reset) throw new ConflictError(`${them.subject} already ${them.has} the demo farm. Reset it to start it again, or delete it.`);
    if (existing.status === "building") throw new ConflictError("The demo farm is still being made. Wait for it to finish, then reset it.");
    await deleteDemoFarm(person, { actor: options.actor });
  }
  if (building.size >= MAX_BUILDS_AT_ONCE) throw new UnavailableError("This server is making other demo farms just now. Try again in a few minutes.");
  const id = demoOrganisationId(person.id);
  const databaseName = databaseNameFor(id);
  const taken = await getAdminPool().query("select 1 from pg_database where datname = $1", [databaseName]);
  if (taken.rowCount) await dropDatabase(databaseName);
  try {
    await withCoreTransaction(async (client) => {
      // Jobs paused for good (decision 857): the demo farm never sends, imports or connects to anything.
      await client.query(
        `insert into organisations (id, display_name, database_name, base_currency, created_by, jobs_paused_at, jobs_paused_reason,
                                    demo_for_user_id, demo_status, demo_step, demo_percent, demo_started_at, demo_updated_at)
         values ($1, $2, $3, 'NZD', $4, now(), $5, $4, 'building', 'Starting', 0, now(), now())`,
        [id, DEMO_FARM_NAME, databaseName, person.id, DEMO_JOBS_PAUSED_REASON],
      );
      await client.query("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'owner')", [id, person.id]);
      const actor = options.actor ?? person;
      await writeAdminAuditEvent(client, { userId: actor.id, email: actor.email }, {
        eventType: options.reset ? "demo_farm.reset" : "demo_farm.added",
        entityType: "organisation",
        entityId: id,
        details: { displayName: DEMO_FARM_NAME, forEmail: person.email },
      });
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new ConflictError(`${them.subject} already ${them.has} the demo farm.`);
    throw error;
  }
  // TOHYEE_DEMO_FARM_TODAY is for tests: the farm as made on a fixed day, so its figures don't change.
  const today = options.today ?? process.env.TOHYEE_DEMO_FARM_TODAY?.trim() ?? todayIsoDate("Pacific/Auckland");
  building.add(id);
  const run = runBuild(id, person, today).finally(() => building.delete(id));
  if (options.wait) await run;
  else void run;
  return (await getDemoFarm(person.id))!;
}

async function runBuild(id: string, person: DemoPerson, today: string): Promise<void> {
  const started = performance.now();
  const progress = async (step: string, percent: number) => {
    await coreQuery("update organisations set demo_step = $2, demo_percent = $3, demo_updated_at = now() where id = $1 and demo_status = 'building'", [id, step.slice(0, 200), percent]);
  };
  try {
    await progress("Setting up the database", 1);
    await provisionOrganisation(id);
    const organisation = await getOrganisation(id);
    if (!organisation || organisation.provisioningStatus !== "ready") throw new Error(organisation?.provisioningError ?? "The demo farm's database couldn't be set up.");
    await buildDemoFarm(organisation, { userId: person.id, email: person.email, role: "owner" }, today, progress);
    await coreQuery("update organisations set demo_status = 'ready', demo_step = null, demo_percent = 100, demo_error = null, demo_updated_at = now(), demo_build_ms = $2 where id = $1", [
      id,
      Math.round(performance.now() - started),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tohyee] making the demo farm ${id} failed:`, error);
    await coreQuery("update organisations set demo_status = 'failed', demo_error = $2, demo_updated_at = now(), demo_build_ms = $3 where id = $1", [
      id,
      `Making the demo farm failed: ${message}`.slice(0, 2000),
      Math.round(performance.now() - started),
    ]).catch(() => undefined);
  }
}

async function dropDatabase(databaseName: string): Promise<void> {
  await closeOrganisationPool(databaseName);
  await getAdminPool().query(`drop database if exists ${quoteSqlIdentifier(databaseName)} with (force)`);
}

/** Deletes the person's demo farm: its database, its Analytics file and the registry row. Nothing in it is real, so nothing is kept. */
export async function deleteDemoFarm(person: DemoPerson, options: DemoOptions = {}): Promise<void> {
  const them = who(person, options.actor);
  const missing = them.self ? "You don't have the demo farm." : `${person.email} doesn't have the demo farm.`;
  const demo = await getDemoFarm(person.id);
  if (!demo) throw new NotFoundError(missing);
  if (demo.status === "building" && building.has(demo.organisationId)) throw new ConflictError("The demo farm is still being made. Wait for it to finish, then delete it.");
  const organisation = await getOrganisation(demo.organisationId);
  if (!organisation?.demo) throw new NotFoundError(missing);
  await closeAnalytics(organisation.id);
  await rm(analyticsFilePath(organisation.id), { force: true });
  await rm(`${analyticsFilePath(organisation.id)}.wal`, { force: true });
  await rm(analyticsWorkFolder(organisation.id), { recursive: true, force: true });
  await dropDatabase(organisation.databaseName);
  await withCoreTransaction(async (client) => {
    await client.query("delete from organisations where id = $1 and demo_for_user_id = $2", [organisation.id, person.id]);
    const actor = options.actor ?? person;
    await writeAdminAuditEvent(client, { userId: actor.id, email: actor.email }, {
      eventType: "demo_farm.deleted",
      entityType: "organisation",
      entityId: organisation.id,
      details: { forEmail: person.email },
    });
  });
}

/** A demo farm with whose it is, for the server settings and the command line. */
export type DemoFarmListing = DemoFarm & { userId: string; email: string; userDisplayName: string };

/** Every demo farm on the server, for the server settings (#445) and the command line. */
export async function listDemoFarms(): Promise<DemoFarmListing[]> {
  const result = await coreQuery<Row & { user_id: string; email: string; user_display_name: string }>(
    `select o.id, o.display_name, o.demo_status, o.demo_step, o.demo_percent, o.demo_error, o.demo_started_at, o.demo_build_ms,
            u.id as user_id, u.email, u.display_name as user_display_name,
            coalesce(o.demo_updated_at, o.demo_started_at) < now() - make_interval(mins => $1) as stalled
       from organisations o join users u on u.id = o.demo_for_user_id order by u.email`,
    [STALLED_MINUTES],
  );
  return result.rows.map((row) => ({ ...toDemo(row), userId: row.user_id, email: row.email, userDisplayName: row.user_display_name }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whose demo farm a server admin means (#445): the login with this email, or
 * with this ID (from the list). Blank means the admin themselves. Only an
 * active login can be given one.
 */
export async function findDemoPerson(actor: DemoPerson, input: { email?: unknown; userId?: string }): Promise<DemoPerson> {
  if (input.userId !== undefined) {
    if (!UUID.test(input.userId)) throw new NotFoundError("There's no login with that ID.");
    const found = await coreQuery<{ id: string; email: string }>("select id, email from users where id = $1", [input.userId]);
    if (!found.rows[0]) throw new NotFoundError("There's no login with that ID.");
    return found.rows[0];
  }
  if (input.email == null || input.email === "") return actor;
  const email = normaliseEmail(input.email);
  const found = await coreQuery<{ id: string; email: string }>("select id, email from users where email = $1 and is_active", [email]);
  if (!found.rows[0]) throw new ValidationError(`There's no active login with the email ${email}. Add it under Users first.`);
  return found.rows[0];
}
