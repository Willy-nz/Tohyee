import { MAX_FILE_JSON_BYTES, json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { importStatementFile, listImports } from "@/lib/bank/imports";

type Context = { params: Promise<{ accountId: string }> };

/** GET: the account's file imports and bank feed syncs, newest first. */
export const GET = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const imports = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) =>
    listImports(tx, accountId),
  );
  return json({ imports });
});

/** Imports a statement file (`fileName`, `fileBase64`, optional CSV/Excel `layout`). Adds only lines not already there; posts nothing. */
export const POST = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES });
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    importStatementFile(tx, accountId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      fileName: body.fileName,
      fileBase64: body.fileBase64,
      layout: body.layout,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
