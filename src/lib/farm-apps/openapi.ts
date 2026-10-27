import { API_VERSION } from "@/lib/farm-apps/api";
import { FARM_APP_SCOPE_LABELS, FARM_APP_SCOPES } from "@/lib/farm-apps/scopes";

/*
 * The Farming API v1 contract (example FA8, decision 561), OpenAPI 3.1. Kept
 * by hand beside the routes; tests/integration/farm-apps.test.ts checks every
 * path here answers.
 */

const id = { type: "string", pattern: "^[0-9]+$" };
const date = { type: "string", format: "date" };
const farmIdParam = { name: "farmId", in: "query", required: false, description: "Leave out when the organisation has one farm.", schema: id };
const paddockIdParam = { name: "paddockId", in: "query", required: false, schema: id };
const errorResponse = { description: "An error, with a message to show the person.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
const common = { "401": errorResponse, "403": errorResponse, "404": errorResponse, "422": errorResponse, "429": errorResponse };
const ok = (description: string) => ({ "200": { description, content: { "application/json": { schema: { type: "object" } } } }, ...common });
const created = (description: string) => ({ "201": { description, content: { "application/json": { schema: { type: "object" } } } }, ...common });
const secured = (scope: string | null) => ({ security: [{ appKey: [] }], ...(scope ? { "x-tohyee-scope": scope } : {}) });

export function farmAppsOpenApi(serverUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Tohyee Farming API",
      version: API_VERSION,
      description:
        "Read farm data and record field work from your own apps. Authorise with `Authorization: Bearer tohyee_app_…` (make a key under Farming › Apps, choosing its scopes). Nothing here posts to the books. Scopes: " +
        FARM_APP_SCOPES.map((scope) => `${scope} (${FARM_APP_SCOPE_LABELS[scope]})`).join("; ") +
        ".",
    },
    servers: [{ url: `${serverUrl}/api/farm-apps/v1` }],
    components: {
      securitySchemes: { appKey: { type: "http", scheme: "bearer", description: "A Tohyee app key, tohyee_app_…" } },
      schemas: {
        Error: { type: "object", properties: { error: { type: "string" }, code: { type: "string" } }, required: ["error"] },
        SoilSampleInput: {
          type: "object",
          required: ["paddockId", "takenOn"],
          properties: {
            paddockId: id,
            takenOn: date,
            sampleName: { type: "string", maxLength: 100 },
            depth: { type: "string", maxLength: 40, examples: ["0-75 mm"] },
            latitude: { type: "number", minimum: -90, maximum: 90, description: "With longitude, or neither." },
            longitude: { type: "number", minimum: -180, maximum: 180 },
            note: { type: "string", maxLength: 500 },
          },
        },
        PastureReadingInput: {
          type: "object",
          required: ["paddockId", "measuredOn", "cover", "method"],
          properties: {
            paddockId: id,
            measuredOn: date,
            cover: { type: "integer", minimum: 0, maximum: 20000, description: "kg DM/ha" },
            method: { type: "string", enum: ["plate_meter", "visual", "measured_other", "satellite", "model"] },
            note: { type: "string", maxLength: 200 },
          },
        },
      },
    },
    paths: {
      "/me": { get: { summary: "This key: organisation, person, key name and the scopes it may use now", ...secured(null), responses: ok("Who the key is") } },
      "/farms": { get: { summary: "Active farms with their paddocks, areas and shapes (GeoJSON)", ...secured("read_farm"), responses: ok("Farms") } },
      "/soil/paddocks": { get: { summary: "Each paddock's latest soil test, oldest first; never tested first. Your app decides what's due.", ...secured("read_soil"), parameters: [farmIdParam], responses: ok("Paddocks") } },
      "/soil/tests": { get: { summary: "Soil tests with results as the lab reported them", ...secured("read_soil"), parameters: [farmIdParam, paddockIdParam], responses: ok("Tests") } },
      "/soil/samples": {
        get: { summary: "Soil samples taken in the field", ...secured("read_soil"), parameters: [farmIdParam, paddockIdParam], responses: ok("Samples") },
        post: { summary: "Record a soil sample taken in the field", ...secured("record_soil_samples"), requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SoilSampleInput" } } } }, responses: created("The sample") },
      },
      "/pasture/cover": { get: { summary: "The farm's pasture cover, feed wedge and growth on a date", ...secured("read_pasture"), parameters: [farmIdParam, { name: "onDate", in: "query", required: false, schema: date }], responses: ok("Cover") } },
      "/pasture/readings": {
        get: {
          summary: "Pasture cover readings, newest first, a page at a time (up to 1,000). `next` is the cursor for the next page, or null.",
          ...secured("read_pasture"),
          parameters: [
            farmIdParam,
            paddockIdParam,
            { name: "from", in: "query", required: false, schema: date },
            { name: "to", in: "query", required: false, schema: date },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 1000 } },
            { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: ok("Readings"),
        },
        post: { summary: "Record a pasture cover reading", ...secured("record_pasture"), requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PastureReadingInput" } } } }, responses: created("The reading") },
      },
    },
  };
}
