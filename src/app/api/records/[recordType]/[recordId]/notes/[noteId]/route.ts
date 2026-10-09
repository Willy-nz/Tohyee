import { json, readJson, route, withRecord } from "@/lib/api/http";
import { deleteNote, editNote } from "@/lib/records/extras";

type Context = { params: Promise<{ recordType: string; recordId: string; noteId: string }> };

/** PATCH: edits a note (`body`, `version`). Its author or an admin (NF4, NF5). */
export const PATCH = route<Context>(async (request, context) => {
  const { recordType, recordId, noteId } = await context.params;
  const body = await readJson(request);
  const result = await withRecord(request, body.organisationId, recordType, "write", (tx, { membership }) =>
    editNote(tx, membership.role, recordType, recordId, noteId, { body: body.body, version: body.version }),
  );
  return json(result);
});

/** DELETE: deletes a note (`version`). Its text stays in the history (NF6). */
export const DELETE = route<Context>(async (request, context) => {
  const { recordType, recordId, noteId } = await context.params;
  const body = await readJson(request);
  await withRecord(request, body.organisationId, recordType, "write", (tx, { membership }) =>
    deleteNote(tx, membership.role, recordType, recordId, noteId, { version: body.version }),
  );
  return json({ deleted: true });
});
