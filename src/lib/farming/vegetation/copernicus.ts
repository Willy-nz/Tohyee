import type { ConnectionCheck, FetchedPicture, SceneCandidate, VegetationProvider } from "@/lib/farming/vegetation/provider";
import { CONNECTION_PROBLEM_WORDS, ProviderError } from "@/lib/farming/vegetation/provider";
import { gridBox, type Grid } from "@/lib/farming/vegetation/raster";

/*
 * The Copernicus Data Space Ecosystem (#612, decision 1522): the STAC
 * catalogue to find dates, and the Sentinel Hub Process API to clip the
 * farm's area out of one date, with an OAuth client (client credentials)
 * the organisation makes in its own Copernicus account. Server-only. The
 * secret is passed in by the caller after decrypting it and is never
 * logged, stored here or sent anywhere but the token endpoint.
 *
 * NOT YET TRIED AGAINST THE LIVE SERVICE. Tohyee's build machine can't reach
 * dataspace.copernicus.eu and has no account, so this was written from the
 * public documentation and forum answers, and tested only with a pretend
 * fetch. Before relying on it, run the pilot checklist in
 * docs/SATELLITE-VEGETATION.md ("Test one farm"). What's unverified is
 * marked "unverified" below.
 */

/** Endpoints (decision 1522). Unverified: confirmed from the documentation and forum answers, not by calling them. */
export const COPERNICUS = {
  tokenUrl: "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token",
  stacSearchUrl: "https://stac.dataspace.copernicus.eu/v1/search",
  processUrl: "https://sh.dataspace.copernicus.eu/api/v1/process",
  collection: "sentinel-2-l2a",
} as const;

/** Most pages of search results followed: 5 × 100 dates is far more than a year over one farm. */
const MAX_PAGES = 5;
const TIMEOUT_MS = 60_000;

/**
 * Red, near-infrared, scene classification and the data mask, as 16-bit
 * digital numbers (decision 1526). With harmonizeValues (the documented
 * default, set anyway) DN = 10000 × reflectance with the baseline 04.00
 * offset taken off, so the offset passed on is 0. Where there's no data
 * every band is 0. Unverified against the live service.
 */
export const EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B08", "SCL", "dataMask"], units: "DN" }],
    output: { bands: 4, sampleType: "UINT16" }
  };
}
function evaluatePixel(s) {
  return s.dataMask === 1 ? [s.B04, s.B08, s.SCL, 1] : [0, 0, 0, 0];
}`;

type Fetcher = typeof fetch;

type Token = { value: string; expiresAt: number };

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function retryAfter(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1, Math.min(3600, Math.round(seconds)));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(1, Math.min(3600, Math.round((at - Date.now()) / 1000))) : null;
}

/** A failed answer as a ProviderError, without echoing anything secret (the body is the provider's, trimmed). */
async function failure(response: Response, what: string): Promise<ProviderError> {
  let text = "";
  try {
    text = (await response.text()).slice(0, 300);
  } catch {
    text = "";
  }
  // Unverified: the wording of the provider's out-of-units answer.
  if (/insufficient|processing units|quota/i.test(text) && (response.status === 402 || response.status === 403 || response.status === 429)) {
    return new ProviderError("quota", `${what}: the Copernicus account has no processing units or requests left this month.`);
  }
  if (response.status === 401 || response.status === 403) return new ProviderError("auth", `${what}: Copernicus refused the account (${response.status}). Connect it again.`);
  if (response.status === 429) return new ProviderError("rate_limited", `${what}: Copernicus asked Tohyee to slow down.`, retryAfter(response) ?? 60);
  if (response.status >= 500) return new ProviderError("unavailable", `${what}: Copernicus isn't answering properly (${response.status}).`, retryAfter(response));
  return new ProviderError("bad_request", `${what}: Copernicus said ${response.status}${text ? `: ${text.replace(/\s+/g, " ")}` : ""}`);
}

function networkFailure(error: unknown, what: string): ProviderError {
  if (error instanceof ProviderError) return error;
  const name = error instanceof Error ? error.name : "";
  return new ProviderError("unavailable", `${what}: ${name === "TimeoutError" || name === "AbortError" ? "no answer in time" : "Copernicus couldn't be reached"}.`);
}

type StacItem = { id?: unknown; properties?: Record<string, unknown> };
type StacPage = { features?: StacItem[]; links?: Array<{ rel?: string; href?: string; method?: string; body?: unknown }> };

/**
 * Groups catalogue items into satellite passes: items whose times are
 * within 10 minutes are one pass (a farm on two tiles has two products).
 * Item property names are unverified; both STAC extension spellings are read.
 */
export function passesFromItems(items: StacItem[], maxSceneCloudPct: number): SceneCandidate[] {
  const passes: SceneCandidate[] = [];
  const sorted = items
    .map((item) => ({ item, at: typeof item.properties?.datetime === "string" ? Date.parse(item.properties.datetime) : Number.NaN }))
    .filter((entry) => Number.isFinite(entry.at) && typeof entry.item.id === "string")
    .sort((a, b) => a.at - b.at);
  for (const { item, at } of sorted) {
    const properties = item.properties ?? {};
    const cloud = typeof properties["eo:cloud_cover"] === "number" ? (properties["eo:cloud_cover"] as number) : null;
    const baseline = typeof properties["processing:version"] === "string" ? (properties["processing:version"] as string) : typeof properties["s2:processing_baseline"] === "string" ? (properties["s2:processing_baseline"] as string) : null;
    const platform = typeof properties.platform === "string" ? properties.platform : null;
    const last = passes.at(-1);
    if (last && at - Date.parse(last.acquiredAt) <= 10 * 60_000) {
      last.productIds.push(item.id as string);
      if (cloud !== null) last.sceneCloudPct = last.sceneCloudPct === null ? cloud : Math.min(last.sceneCloudPct, cloud);
      continue;
    }
    passes.push({ acquiredAt: `${new Date(at).toISOString().slice(0, 19)}Z`, productIds: [item.id as string], sceneCloudPct: cloud, processingBaseline: baseline, platform });
  }
  return passes.filter((pass) => pass.sceneCloudPct === null || pass.sceneCloudPct <= maxSceneCloudPct);
}

/** The Process API request for one pass over a grid (decision 1524). Unverified against the live service. */
export function processRequest(grid: Grid, candidate: SceneCandidate): Record<string, unknown> {
  const at = Date.parse(candidate.acquiredAt);
  return {
    input: {
      bounds: { bbox: gridBox(grid), properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/3857" } },
      data: [
        {
          type: COPERNICUS.collection,
          dataFilter: { timeRange: { from: new Date(at - 15 * 60_000).toISOString(), to: new Date(at + 15 * 60_000).toISOString() }, mosaickingOrder: "leastCC" },
          processing: { harmonizeValues: true, upsampling: "NEAREST", downsampling: "NEAREST" },
        },
      ],
    },
    output: { width: grid.width, height: grid.height, responses: [{ identifier: "default", format: { type: "image/png" } }] },
    evalscript: EVALSCRIPT,
  };
}

/**
 * The Copernicus provider for one organisation's OAuth client. Tokens are
 * kept in memory for this provider object only, until a minute before
 * they run out.
 */
export function createCopernicusProvider(credentials: { clientId: string; clientSecret: string }, options: { fetcher?: Fetcher } = {}): VegetationProvider {
  const fetcher = options.fetcher ?? fetch;
  let token: Token | null = null;

  async function getToken(signal?: AbortSignal): Promise<string> {
    if (token && token.expiresAt > Date.now()) return token.value;
    let response: Response;
    try {
      response = await fetcher(COPERNICUS.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: credentials.clientId, client_secret: credentials.clientSecret }).toString(),
        signal: withTimeout(signal),
      });
    } catch (error) {
      throw networkFailure(error, "Signing in to Copernicus");
    }
    if (response.status === 400 || response.status === 401) {
      // OAuth's own error codes (RFC 6749). Unverified: which one Copernicus gives for an account that isn't activated.
      let code = "";
      try {
        const body = (await response.json()) as { error?: unknown; error_description?: unknown };
        code = `${typeof body.error === "string" ? body.error : ""} ${typeof body.error_description === "string" ? body.error_description : ""}`;
      } catch {
        code = "";
      }
      if (/unauthorized_client|disabled|not fully set up|inactive|not activated|verify/i.test(code)) throw new ProviderError("auth", CONNECTION_PROBLEM_WORDS.not_activated, null, "not_activated");
      throw new ProviderError("auth", CONNECTION_PROBLEM_WORDS.wrong_credentials, null, "wrong_credentials");
    }
    if (!response.ok) throw await failure(response, "Signing in to Copernicus");
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string") throw new ProviderError("unavailable", "Copernicus sent no token.");
    const lifetime = typeof body.expires_in === "number" ? body.expires_in : 300;
    token = { value: body.access_token, expiresAt: Date.now() + Math.max(30, lifetime - 60) * 1000 };
    return token.value;
  }

  return {
    id: "copernicus",
    /**
     * Signs in, then asks for a tiny 4 × 4 picture of central Wellington
     * from the last 30 days, so a used-up allowance or an account that
     * can't use processing shows now, not on the first real fetch. It uses
     * the smallest charge the provider makes (unverified: about 0.01 units).
     */
    async checkConnection(): Promise<ConnectionCheck> {
      try {
        token = null;
        const bearer = await getToken();
        const now = Date.now();
        const body = processRequest(
          { crs: "EPSG:3857", pixel: 14, minX: 19455900, maxY: -5056600, width: 4, height: 4 },
          { acquiredAt: new Date(now - 15 * 86_400_000).toISOString(), productIds: [], sceneCloudPct: null, processingBaseline: null, platform: null },
        ) as { input: { data: Array<{ dataFilter: { timeRange: { from: string; to: string } } }> } };
        body.input.data[0].dataFilter.timeRange = { from: new Date(now - 30 * 86_400_000).toISOString(), to: new Date(now).toISOString() };
        let response: Response;
        try {
          response = await fetcher(COPERNICUS.processUrl, { method: "POST", headers: { "content-type": "application/json", accept: "image/png", authorization: `Bearer ${bearer}` }, body: JSON.stringify(body), signal: withTimeout() });
        } catch (error) {
          throw networkFailure(error, "Testing the connection");
        }
        if (!response.ok) {
          const error = await failure(response, "Testing the connection");
          if (error.kind === "auth") throw new ProviderError("auth", CONNECTION_PROBLEM_WORDS.not_activated, null, "not_activated");
          throw error;
        }
        await response.arrayBuffer();
        return { ok: true };
      } catch (error) {
        if (!(error instanceof ProviderError)) return { ok: false, reason: "failed", message: CONNECTION_PROBLEM_WORDS.failed };
        if (error.problem) return { ok: false, reason: error.problem, message: error.message };
        if (error.kind === "quota") return { ok: false, reason: "quota", message: CONNECTION_PROBLEM_WORDS.quota };
        if (error.kind === "unavailable" || error.kind === "rate_limited") return { ok: false, reason: "unreachable", message: CONNECTION_PROBLEM_WORDS.unreachable };
        return { ok: false, reason: "failed", message: `${CONNECTION_PROBLEM_WORDS.failed} ${error.message}` };
      }
    },
    async search({ box, from, to, maxSceneCloudPct }) {
      // The public catalogue needs no sign-in (unverified). CQL2 JSON filter on cloud cover; filtered here too.
      let request: { url: string; body: unknown } | null = {
        url: COPERNICUS.stacSearchUrl,
        body: {
          collections: [COPERNICUS.collection],
          bbox: box,
          datetime: `${from}/${to}`,
          limit: 100,
          "filter-lang": "cql2-json",
          filter: { op: "<=", args: [{ property: "eo:cloud_cover" }, maxSceneCloudPct] },
        },
      };
      const items: StacItem[] = [];
      for (let page = 0; request && page < MAX_PAGES; page += 1) {
        let response: Response;
        try {
          response = await fetcher(request.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/geo+json" }, body: JSON.stringify(request.body), signal: withTimeout() });
        } catch (error) {
          throw networkFailure(error, "Searching the Copernicus catalogue");
        }
        if (!response.ok) throw await failure(response, "Searching the Copernicus catalogue");
        const body = (await response.json()) as StacPage;
        items.push(...(body.features ?? []));
        const next = body.links?.find((link) => link.rel === "next" && typeof link.href === "string");
        // Only follow the catalogue's own address.
        request = next && next.href!.startsWith("https://stac.dataspace.copernicus.eu/") ? { url: next.href!, body: next.body ?? request.body } : null;
      }
      return passesFromItems(items, maxSceneCloudPct);
    },
    async fetch({ grid, candidate, signal }): Promise<FetchedPicture> {
      const bearer = await getToken(signal);
      let response: Response;
      try {
        response = await fetcher(COPERNICUS.processUrl, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "image/png", authorization: `Bearer ${bearer}` },
          body: JSON.stringify(processRequest(grid, candidate)),
          signal: withTimeout(signal),
        });
      } catch (error) {
        throw networkFailure(error, "Fetching the picture");
      }
      if (response.status === 401) token = null;
      if (!response.ok) throw await failure(response, "Fetching the picture");
      const spent = Number(response.headers.get("x-processingunits-spent"));
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { png: bytes, dnOffset: 0, unitsSpent: Number.isFinite(spent) && response.headers.has("x-processingunits-spent") ? spent : null, requests: 1 };
    },
  };
}
