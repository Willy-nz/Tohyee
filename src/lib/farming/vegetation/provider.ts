import type { BandRaster, Grid } from "@/lib/farming/vegetation/raster";
import { decodePng } from "@/lib/farming/vegetation/png";

/*
 * Where pictures come from (#612, decision 1522): one interface, two
 * providers. "copernicus" asks the Copernicus Data Space Ecosystem
 * (copernicus.ts); "demo" makes up pictures for tests and the demo farm
 * (fake-provider.ts) and never claims to be satellite data. Server-only.
 */

export type ProviderId = "copernicus" | "demo";

/** A satellite date found for a farm's area. */
export type SceneCandidate = {
  /** The satellite's acquisition time (ISO, UTC), never when Tohyee fetched it. */
  acquiredAt: string;
  /** The products seen on that pass (the farm can straddle two tiles). */
  productIds: string[];
  /** Cloud over the whole product (not the farm), as the catalogue says; null if it doesn't. */
  sceneCloudPct: number | null;
  processingBaseline: string | null;
  platform: string | null;
};

/** What a fetch gives back: the picture as the provider sent it, and what it cost. */
export type FetchedPicture = {
  /** A 16-bit RGBA PNG: red (B04), near-infrared (B08), scene class (SCL), data mask. */
  png: Uint8Array;
  /** Added to the digital numbers before dividing by 10000 (0 for harmonised values, decision 1526). */
  dnOffset: number;
  /** The provider's own count of processing units, when its answer says. */
  unitsSpent: number | null;
  requests: number;
};

/**
 * "Test connection" (decision 1539), in plain words: the ID or secret is
 * wrong; the account isn't activated (or can't use the processing service
 * yet); this month's allowance is used up; Copernicus can't be reached; or
 * something else, with the provider's words.
 */
export type ConnectionProblem = "wrong_credentials" | "not_activated" | "quota" | "unreachable" | "failed";
export type ConnectionCheck = { ok: true } | { ok: false; reason: ConnectionProblem; message: string };

export const CONNECTION_PROBLEM_WORDS: Record<ConnectionProblem, string> = {
  wrong_credentials: "Copernicus didn't accept that client ID and secret. Check you copied the whole secret: it's only shown once, when you make the OAuth client. If you've lost it, make a new client.",
  not_activated: "Copernicus knows the client, but the account can't use the processing service yet. Open the email Copernicus sent when you signed up and confirm it, then try again in a few minutes.",
  quota: "The account is connected, but this month's free allowance is used up. It starts again next month.",
  unreachable: "Tohyee couldn't reach Copernicus from this server. Check the server has internet access, then try again.",
  failed: "Copernicus gave an answer Tohyee didn't expect.",
};

export interface VegetationProvider {
  id: ProviderId;
  /** Asks for a token (or the like) to see the credentials work; fetches no pictures. */
  checkConnection(): Promise<ConnectionCheck>;
  /** Dates with pictures over the box between two times, least cloudy over `maxSceneCloudPct` left out. */
  search(input: { box: [number, number, number, number]; from: string; to: string; maxSceneCloudPct: number }): Promise<SceneCandidate[]>;
  /** The bands for one date, on the farm's grid, clipped to it by the provider. */
  fetch(input: { grid: Grid; candidate: SceneCandidate; signal?: AbortSignal }): Promise<FetchedPicture>;
}

/**
 * Why a provider call failed (decision 1534): "auth" needs reconnecting,
 * "quota" pauses until the budget allows, "rate_limited" waits and tries
 * again, "unavailable" tries again later, "bad_request" doesn't.
 */
export class ProviderError extends Error {
  constructor(
    readonly kind: "auth" | "quota" | "rate_limited" | "unavailable" | "bad_request",
    message: string,
    readonly retryAfterSeconds: number | null = null,
    /** For "Test connection": which plain-words problem it is, when known. */
    readonly problem: ConnectionProblem | null = null,
  ) {
    super(message);
  }
}

/** The provider's 16-bit picture as bands; the data mask turns a pixel's class to 0 (no data). */
export function bandsFromPicture(png: Uint8Array, grid: Grid): BandRaster {
  const decoded = decodePng(png, { maxPixels: grid.width * grid.height });
  if (decoded.width !== grid.width || decoded.height !== grid.height || decoded.channels !== 4) {
    throw new ProviderError("bad_request", `The picture came back ${decoded.width} × ${decoded.height} with ${decoded.channels} bands, not ${grid.width} × ${grid.height} with 4.`);
  }
  const count = grid.width * grid.height;
  const red = new Uint16Array(count);
  const nir = new Uint16Array(count);
  const scl = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    const mask = decoded.data[i * 4 + 3];
    red[i] = decoded.data[i * 4];
    nir[i] = decoded.data[i * 4 + 1];
    scl[i] = mask ? Math.min(255, decoded.data[i * 4 + 2]) : 0;
  }
  return { width: grid.width, height: grid.height, red, nir, scl };
}
