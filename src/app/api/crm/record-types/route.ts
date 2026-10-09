import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { createRecordType, listRecordTypes } from "@/lib/crm/record-types/service";

/** The CRM's record types with their page layouts (CRT1), for companies, people and opportunities, or one of them with `record`. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const recordTypes = await withCrm(request, params.get("organisationId"), "read", (tx) => listRecordTypes(tx, { record: params.get("record") }));
  return json({ recordTypes });
});

/** Adds a record type (CRT2), copying another type's layout or the default's. Admins and owners only. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const recordType = await withCrm(request, body.organisationId, "admin", (tx) =>
    createRecordType(tx, {
      record: body.record,
      name: body.name,
      description: body.description,
      copyFromId: body.copyFromId,
      isDefault: body.isDefault,
    }),
  );
  return json({ recordType }, { status: 201 });
});
