import { businessTimeZone } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { canSeeFarm } from "@/lib/farming/access";
import type { PdfWriter } from "@/lib/pdf/writer";
import { loadPackData, type PackData, renderPack } from "@/lib/safety/pack";
import { currentRecords } from "@/lib/safety/records";
import { effluentCare } from "@/lib/effluent/care";
import { effluentLog } from "@/lib/effluent/log";
import { appliedAreasSvg } from "@/lib/effluent/pack-map";
import { COMPARISON_NOTE, DEFERRAL_LABELS, depthForComparison, summaryLines } from "@/lib/effluent/rules";
import { activeConsent, CHECK_YOUR_CONSENT, INCIDENT_TYPE_LABELS, type SystemData } from "@/lib/effluent/shared";
import { requireId } from "@/lib/validation";

/*
 * The council pack (#487, decision 1099): a farm's effluent records
 * for a date range, ready to hand to the regional council if it asks. The
 * same zip as the WorkSafe pack (records with every version, entries and
 * their hashes, the whole chain's numbers and hashes, photos with their
 * camera time, the phone's time and place, and verify.mjs), with:
 * - a summary that compares the records with the consent's entered limits
 *   in neutral counts (never "complies"), pond levels, days not applied,
 *   checks, servicing and incidents;
 * - applied-areas.svg: the paddocks shaded by applications;
 * - the systems' Safety checks, faults and releases and the incidents'
 *   actions, beside the effluent records themselves.
 * Tohyee doesn't send it anywhere: the person downloads it (decision 1092).
 */

export type CouncilPack = { data: PackData; summary: string[]; svg: string; farmName: string };

/** Viewers and above may make it; farm staff can't (like the WorkSafe pack, decision 961). */
function requirePackMaker(tx: OrgTx) {
  if (tx.actor.role === "farm_worker") throw new ForbiddenError("The council pack is for the people who keep the farm's records. Ask the farm manager.");
}

export async function loadCouncilPack(tx: OrgTx, input: { farmId: unknown; from: unknown; to: unknown }): Promise<CouncilPack> {
  requirePackMaker(tx);
  const farmId = requireId(input.farmId, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const systems = (await currentRecords<SystemData>(tx, "effluent_system", { farmId, includeWithdrawn: true })).filter((system) => system.farmId === farmId);
  const machines = systems.map((system) => system.data.equipmentId);
  const data = await loadPackData(tx, {
    farmId,
    from: input.from,
    to: input.to,
    kinds: "effluent",
    // The systems' machines and checklists, their checks and releases, and incidents' actions (decision 1099a).
    extraRecordIds: async (inner, range) => {
      const rows = await inner.query<{ record_id: string }>(
        `select distinct e.record_id::text from safety_entries e
          where e.farm_id = $1 and e.seq <= $5::bigint
            and (
              (e.kind = 'equipment' and e.record_id = any($2::uuid[]))
              or (e.kind = 'checklist' and e.record_id::text in (select f.body::jsonb->>'checklistId' from safety_entries f where f.kind = 'equipment' and f.record_id = any($2::uuid[])))
              or (e.kind in ('check', 'equipment_release') and e.body::jsonb->>'equipmentId' = any($2::text[])
                  and (e.entered_at at time zone $6)::date between $3 and $4)
              or (e.kind = 'action' and e.body::jsonb ? 'effluentIncidentId' and e.body::jsonb->>'effluentIncidentId' is not null
                  and ((e.entered_at at time zone $6)::date between $3 and $4 or e.record_id in (select g.record_id from safety_entries g where g.kind = 'action' and g.version = 1 and (g.entered_at at time zone $6)::date between $3 and $4)))
            )`,
        [farmId, machines, range.from, range.to, range.upTo, businessTimeZone()],
      );
      return rows.rows.map((row) => row.record_id);
    },
  });
  const log = await effluentLog(tx, farmId, { from: data.from, to: data.to });
  const care = await effluentCare(tx, farmId);
  const consent = activeConsent(log.setup.consents)?.data ?? null;
  const inRange = (date: string) => date >= data.from && date <= data.to;
  const farmName = data.farms.find((farm) => farm.id === farmId)?.name ?? "";
  const applications = log.applications.filter((application) => application.change !== "withdrawn" && application.happenedOn && inRange(application.happenedOn));
  const readings = log.readings.filter((reading) => reading.change !== "withdrawn");
  const levels = readings.map((reading) => Number(reading.data.levelMm));
  const incidents = care.incidents.filter((incident) => incident.change !== "withdrawn" && inRange(incident.data.occurredAt.slice(0, 10)));
  const deferrals = log.deferrals.filter((deferral) => deferral.change !== "withdrawn");
  const summary = [
    `Scope: ${farmName}, effluent records entered or dated ${data.from} to ${data.to}, each with every version, and the effluent systems' Safety checks, faults and releases and the incidents' actions. Other safety records aren't included. Corrections: ${data.entries.filter((entry) => entry.change === "corrected").length} corrected versions (the earlier versions are kept); withdrawn as entered by mistake: ${data.entries.filter((entry) => entry.change === "withdrawn").length} (included, marked).`,
    consent ? `Consent conditions as entered: ${consent.title}${consent.consentNumber ? `, ${consent.consentNumber}` : ""}${consent.expiresOn ? `, expires ${consent.expiresOn}` : ""}.${consent.fromTemplate.length ? ` Some conditions are still as the starting template had them. ${CHECK_YOUR_CONSENT}` : ""}` : "No consent conditions entered, so nothing is compared with limits.",
    ...summaryLines(log.summary, consent),
    COMPARISON_NOTE,
    `Pond readings: ${readings.length}${levels.length ? `, from ${Math.min(...levels)} to ${Math.max(...levels)} mm on the gauge` : ""}; high readings: ${readings.filter((reading) => reading.state?.warning === "high").length}.`,
    `Days effluent wasn't applied: ${deferrals.length}${deferrals.length ? ` (${[...new Set(deferrals.map((deferral) => DEFERRAL_LABELS[deferral.data.reason]))].join(", ")})` : ""}.`,
    `Incidents: ${incidents.length}${incidents.length ? ` (${incidents.map((incident) => `${INCIDENT_TYPE_LABELS[incident.data.type]}${incident.data.checked ? ", checked" : ", reported, not yet checked"}${incident.data.councilTold ? ", council told (as recorded)" : ""}${incident.data.closed ? ", closed" : ""}`).join("; ")})` : ""}.`,
    "Tohyee doesn't send this pack, or anything else, to the council.",
  ];
  // Applied areas: each paddock's applications in the range, and the positions recorded.
  const counts = new Map<string, number>();
  for (const application of applications) for (const paddockId of application.data.paddockIds) counts.set(paddockId, (counts.get(paddockId) ?? 0) + 1);
  const shapes = await tx.query<{ id: string; name: string; geometry: never }>(
    `select p.id::text, p.name, b.geometry from paddocks p
       left join lateral (select geometry from paddock_boundaries where paddock_id = p.id order by paddock_boundaries.id desc limit 1) b on true
      where p.farm_id = $1 order by p.name`,
    [farmId],
  );
  const svg = appliedAreasSvg({
    title: `Effluent applied, ${farmName}, ${data.from} to ${data.to}`,
    paddocks: shapes.rows.map((row) => ({ name: row.name, geometry: row.geometry, applications: counts.get(row.id) ?? 0 })),
    zones: log.setup.zones.filter((zone) => zone.change !== "withdrawn" && !zone.data.removed).map((zone) => ({ name: zone.data.name, ring: zone.data.zone?.coordinates[0] ?? null, point: zone.data.point })),
    points: applications.flatMap((application) => application.data.positions.flatMap((position) => (position.point ? [position.point] : []))),
  });
  const names = new Map(shapes.rows.map((row) => [row.id, row.name]));
  summary.push(
    `Applications by paddock: ${[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id, count]) => `paddock ${names.get(id) ?? id}: ${count}`).join(", ") || "none"}.`,
    `Depth: ${applications.filter((application) => application.data.depthEnteredMm).length} with depth as entered by the person (measured or declared), ${applications.filter((application) => !application.data.depthEnteredMm && depthForComparison(application.data)).length} with only an estimate from the system's settings. Tractor mode areas are phone GPS estimates.`,
  );
  return { data, summary, svg, farmName };
}

const README = (pack: CouncilPack) => (data: PackData) => `Farm dairy effluent records: ${data.organisationName}
Farm: ${pack.farmName}
Records entered or dated ${data.from} to ${data.to}, each with its full history.
Made ${data.generatedAt} by ${data.generatedBy}, from Tohyee (open source).

What's here
- pack.pdf             the summary, then every record with each version: when it was
                       entered (set by the database) and who entered it.
- applied-areas.svg    the paddocks shaded by effluent applications in the range.
- summary.txt          the summary on its own.
- entries.json         the versions exactly as stored, with their hashes.
- chain.json           every entry's number and hash in the farm records' history.
- files.json, files/   photos and documents, with their hashes, the camera's date, the
                       phone's time and place (when it gave them) and when they arrived.
- verify.mjs           checks all of this on any computer with Node.js: node verify.mjs

The summary counts the records against the consent conditions as entered in Tohyee.
It doesn't say whether the farm complies: the consent and the council decide that.
Depth is shown as entered by the person (measured or declared) and as an estimate from the
system's settings, labelled. Positions and tractor mode areas are phone GPS estimates: a
position near a waterway or buffer is not a finding that effluent reached it.
Corrected records show every version, the earlier ones and why; withdrawn records are
included and marked. The hashes show records weren't changed after they were saved; they
don't show that what was entered is true, and don't make the records privileged.

Effluent records are kept in the same history as the farm's safety records, so
chain.json lists those entries too (numbers and hashes only, no details).

Tohyee doesn't send this to anyone: the person who made it gives it to the council.
`;

export async function renderCouncilPack(pack: CouncilPack) {
  return renderPack(pack.data, {
    title: "Farm dairy effluent records",
    fileStem: "effluent-records",
    readme: README(pack),
    before: (pdf: PdfWriter) => {
      pdf.text("Summary", { bold: true, size: 13, gap: 4 });
      for (const line of pack.summary) pdf.text(line, { size: 9, gap: 3 });
      pdf.text("The map of applied areas is applied-areas.svg in this zip.", { size: 9, muted: true, gap: 12 });
    },
    extraFiles: [
      { name: "applied-areas.svg", data: pack.svg },
      { name: "summary.txt", data: `${pack.summary.join("\n")}\n` },
    ],
  });
}
