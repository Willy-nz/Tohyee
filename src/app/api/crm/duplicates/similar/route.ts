import { json, readJson, route, withCrm } from "@/lib/api/http";
import { similarRecords } from "@/lib/crm/duplicates";

/**
 * Companies, people and open leads like one being added (decision 494):
 * `name`, `email`, `phone`. A POST so email addresses stay out of URLs and
 * logs; it changes nothing.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withCrm(request, body.organisationId, "read", (tx, { scope }) =>
    similarRecords(tx, { name: body.name, email: body.email, phone: body.phone }, scope),
  );
  return json(result);
});
