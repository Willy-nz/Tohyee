import { roleAtLeast } from "@/lib/auth/roles";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { effluentCare } from "@/lib/effluent/care";
import { effluentLog } from "@/lib/effluent/log";
import { addDaysIso } from "@/lib/effluent/reminders";
import { effluentSetup } from "@/lib/effluent/setup";
import { keyAge } from "@/lib/farming/imagery";
import { getFarmingSettings, listFarms } from "@/lib/farming/paddocks";
import type { DeviceReminder } from "@/lib/native/reminders-shared";
import { openActions } from "@/lib/safety/reports";

/*
 * The signed-in person's reminders for the Android app to put on the phone
 * (#502, decisions 1146-1148), from the same records Today uses, worked
 * out each time and never stored:
 *
 * - shift the pods or irrigator, at the time the run says it's due;
 * - read the pond, each morning until it's read;
 * - Effluent's weekly checks, servicing and Effluent WoF, on their days;
 * - the person's own open safety actions, on the day they're due;
 * - the LINZ aerial photos key, the day the reminder starts and the day it
 *   runs out (admins, who are the ones who can renew it).
 *
 * Only farms the person works on (decision 744). Farm mail, injury
 * details and other people's actions are never in it.
 */

const effluentPath = (farmId: string) => `/operations/farm/effluent?farm=${encodeURIComponent(farmId)}`;
const safetyPath = (farmId: string | null) => (farmId ? `/operations/farm/safety?farm=${encodeURIComponent(farmId)}` : "/operations/farm/safety");

function timeText(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit", timeZone: process.env.TOHYEE_TIME_ZONE?.trim() || "Pacific/Auckland" });
}

export async function deviceReminders(tx: OrgTx, organisationId: string): Promise<DeviceReminder[]> {
  const settings = await getFarmingSettings(tx);
  if (!settings.enabled) return [];
  const today = todayIsoDate();
  const reminders: DeviceReminder[] = [];
  const farms = (await listFarms(tx)).filter((farm) => farm.isActive);
  const names = new Map(farms.map((farm) => [farm.id, farm.name]));

  for (const farm of farms) {
    const setup = await effluentSetup(tx, farm.id);
    const hasEffluent = setup.systems.some((system) => system.change !== "withdrawn" && !system.data.retired) || setup.ponds.length > 0;
    if (!hasEffluent) continue;
    const log = await effluentLog(tx, farm.id);
    for (const moved of log.lastMoved) {
      if (!moved.running || !moved.shiftDue) continue;
      reminders.push({ key: `shift-${moved.systemId}-${moved.applicationId}`, kind: "shift", organisationId, title: `Shift ${moved.systemName}`, body: `${farm.name}: due at ${timeText(moved.shiftDue)}.`, farmId: farm.id, path: effluentPath(farm.id), at: moved.shiftDue, date: null });
    }
    for (const pond of log.ponds) {
      if (pond.change === "withdrawn") continue;
      reminders.push({ key: `pond-${pond.recordId}`, kind: "pond", organisationId, title: `Read ${pond.data.name}`, body: `${farm.name}: today's pond reading.`, farmId: farm.id, path: effluentPath(farm.id), at: null, date: pond.readToday ? addDaysIso(today, 1) : today, daily: true });
    }
    const care = await effluentCare(tx, farm.id);
    for (const system of care.systems) {
      if (system.change === "withdrawn" || system.data.retired) continue;
      if (system.data.checkEvery === "week") {
        const last = system.lastCheckedAt ? system.lastCheckedAt.slice(0, 10) : null;
        const due = last ? addDaysIso(last, 7) : today;
        reminders.push({ key: `check-${system.recordId}`, kind: "check", organisationId, title: `Weekly check: ${system.data.name}`, body: `${farm.name}: the effluent system's weekly check is due.`, farmId: farm.id, path: effluentPath(farm.id), at: null, date: due < today ? today : due });
      }
      if (system.nextService) reminders.push({ key: `service-${system.recordId}`, kind: "service", organisationId, title: `Service ${system.data.name}`, body: `${farm.name}: servicing is due.`, farmId: farm.id, path: effluentPath(farm.id), at: null, date: system.nextService });
      if (system.nextWof) reminders.push({ key: `wof-${system.recordId}`, kind: "wof", organisationId, title: `Effluent WoF: ${system.data.name}`, body: `${farm.name}: the Effluent Warrant of Fitness is due.`, farmId: farm.id, path: effluentPath(farm.id), at: null, date: system.nextWof });
    }
  }

  // Only the person's own actions, on farms they work on.
  for (const action of await openActions(tx, { mine: true })) {
    if (action.state === "done" || !action.data.due || (action.farmId && !names.has(action.farmId))) continue;
    const farmName = action.farmId ? names.get(action.farmId) : null;
    reminders.push({ key: `action-${action.recordId}`, kind: "action", organisationId, title: `Safety action due: ${action.data.title}`, body: `${farmName ? `${farmName}: ` : ""}due ${action.data.due}.`, farmId: action.farmId ?? null, path: safetyPath(action.farmId ?? null), at: null, date: action.data.due < today ? today : action.data.due });
  }

  const role = tx.actor.role;
  if (settings.imageryKey && role && roleAtLeast(role, "admin")) {
    const age = keyAge(settings.imageryKeySavedOn, today);
    if (age) {
      reminders.push({ key: "linz-remind", kind: "linz_key", organisationId, title: "Aerial photos key runs out soon", body: `The LINZ key for farm map photos runs out on ${age.expiresOn}. Get a new one under Farming.`, farmId: null, path: "/operations/farming", at: null, date: age.remindOn });
      reminders.push({ key: "linz-expired", kind: "linz_key", organisationId, title: "Aerial photos key has run out", body: "A standard LINZ key lasts 90 days. Check it, or get a new one under Farming.", farmId: null, path: "/operations/farming", at: null, date: age.expiresOn });
    }
  }
  return reminders;
}
