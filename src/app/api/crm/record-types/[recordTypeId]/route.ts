import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateRecordType } from "@/lib/crm/record-types/service";

type Context = { params: Promise<{ recordTypeId: string }> };

/** Renames, describes, archives, restores, makes default, moves or re-lays out a record type (CRT2-CRT4). Admins and owners only. */
export const PATCH = route<Context>(async (request, context) => {
  const { recordTypeId } = await context.params;
  const body = await readJson(request);
  const recordType = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updateRecordType(tx, recordTypeId, {
      name: body.name,
      description: body.description,
      isActive: body.isActive,
      isDefault: body.isDefault,
      layout: body.layout,
      move: body.move,
    }),
  );
  return json({ recordType });
});
