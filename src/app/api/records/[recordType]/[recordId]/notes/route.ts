import { json, readJson, route, withRecord } from "@/lib/api/http";
import { addNote } from "@/lib/records/extras";

type Context = { params: Promise<{ recordType: string; recordId: string }> };

/** POST: adds a note (`idempotencyKey`, `body`). Bookkeepers and above (NF1-NF3). */
export const POST = route<Context>(async (request, context) => {
  const { recordType, recordId } = await context.params;
  const body = await readJson(request);
  const result = await withRecord(request, body.organisationId, recordType, "write", (tx, { membership }) =>
    addNote(tx, membership.role, recordType, recordId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      body: body.body,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
