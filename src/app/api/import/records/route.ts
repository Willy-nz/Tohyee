import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { importMasterRecords } from "@/lib/import/service";

/**
 * Checks (`commit` false) or imports (`commit` true) a file of accounts,
 * contacts or products and services, already mapped to fields. Any row
 * refused means nothing is imported; the rows and reasons come back. Admins.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "admin", (tx, { membership }) =>
    importMasterRecords(
      tx,
      {
        kind: body.kind,
        records: body.records,
        options: body.options,
        idempotencyKey: body.idempotencyKey,
        commit: body.commit === true,
        mapping: body.mapping,
      },
      { role: membership.role },
    ),
  );
  return json({ result });
});
