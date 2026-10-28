import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { todayIsoDate } from "@/lib/dates";
import { ValidationError } from "@/lib/errors";
import { listFarms } from "@/lib/farming/paddocks";
import { EXTRA_PACK_MONTHS, NEVER_IN_A_PACK, PACK_MONTHS, PACK_SECTIONS, type SectionKey } from "@/lib/offline/pack-inventory";
import { buildSection } from "@/lib/offline/pack-server";

/**
 * Offline farm packs (#472 stage 3, decisions 999-1007).
 *
 * GET `?organisationId=`: what this person's device should keep: the
 * active farms they can see, the sections and the history kept.
 * GET `?organisationId=&section=&farmId=&months=`: one section for one
 * farm, built from the same reads as the farm screens, as this person, with
 * restricted details and mail text taken out.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const organisationId = params.get("organisationId");
  const section = params.get("section");
  if (!section) {
    const farms = await withFarmWork(request, organisationId, "read", (tx) => listFarms(tx));
    return json({
      farms: farms.filter((farm) => farm.isActive).map((farm) => ({ id: farm.id, name: farm.name })),
      sections: PACK_SECTIONS,
      months: PACK_MONTHS,
      neverIncluded: NEVER_IN_A_PACK,
      today: todayIsoDate(),
    });
  }
  const info = PACK_SECTIONS.find((entry) => entry.key === section);
  if (!info) throw new ValidationError("That isn't a part of an offline farm pack.");
  const monthsText = params.get("months");
  const months = monthsText === String(EXTRA_PACK_MONTHS) ? EXTRA_PACK_MONTHS : PACK_MONTHS;
  // The farm must be one this person can see: the index's own check, before anything is read.
  const farmId = info.perFarm ? params.get("farmId") : null;
  if (info.perFarm) {
    const farms = await withFarmWork(request, organisationId, "read", (tx) => listFarms(tx));
    if (!farms.some((farm) => farm.id === farmId && farm.isActive)) return json({ error: "Farm not found.", code: "not_found" }, { status: 404 });
  }
  const built = await buildSection(request, { organisationId: String(organisationId ?? ""), farmId, section: section as SectionKey, months, today: todayIsoDate() });
  return json(built);
});
