import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateCustomField } from "@/lib/custom-fields/service";

type Context = { params: Promise<{ fieldId: string }> };

/**
 * Changes a custom field, puts it in a section (`sectionId`) or moves it
 * (`move`: "up" or "down"), or archives or restores it (`isActive`). Its type
 * and what it's on can't change (CF1, CRMF6).
 */
export const PATCH = route<Context>(async (request, context) => {
  const { fieldId } = await context.params;
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updateCustomField(tx, fieldId, {
      label: body.label,
      help: body.help,
      usedOn: body.usedOn,
      isRequired: body.isRequired,
      defaultValue: body.defaultValue,
      showInList: body.showInList,
      isActive: body.isActive,
      record: body.record,
      type: body.type,
      sectionId: body.sectionId,
      move: body.move,
    }),
  );
  return json(setup);
});
