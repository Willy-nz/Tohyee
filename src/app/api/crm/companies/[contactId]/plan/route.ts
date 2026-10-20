import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { getAccountPlan, saveAccountPlan } from "@/lib/crm/account-plans";

type Context = { params: Promise<{ contactId: string }> };

/** A company's account plan (decision 653), with the deals, renewals and tasks this person sees. */
export const GET = route<Context>(async (request, context) => {
  const { contactId } = await context.params;
  const plan = await withCrm(request, searchParams(request).get("organisationId"), "read", (tx, { scope }) => getAccountPlan(tx, contactId, scope));
  return json({ plan });
});

/** Saves the plan: `summary`, `goals` [{ title, targetDate, status }] and `people` [{ personId, role, note }]. */
export const PUT = route<Context>(async (request, context) => {
  const { contactId } = await context.params;
  const body = await readJson(request);
  const plan = await withCrm(request, body.organisationId, "write", (tx, { scope }) =>
    saveAccountPlan(tx, contactId, { summary: body.summary, goals: body.goals, people: body.people }, scope),
  );
  return json({ plan });
});
