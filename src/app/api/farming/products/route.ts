import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listProducts, saveProduct } from "@/lib/farming/fertiliser";

/** GET: fertiliser products and their nutrient content (% by weight). */
export const GET = route(async (request) => {
  const products = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listProducts(tx));
  return json({ products });
});

/** Adds a product, or changes one (`id`). Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const products = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    saveProduct(tx, { id: body.id, name: body.name, nPct: body.nPct, pPct: body.pPct, kPct: body.kPct, sPct: body.sPct, isActive: body.isActive }),
  );
  return json({ products });
});
