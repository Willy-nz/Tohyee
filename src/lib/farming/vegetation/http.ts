import { ConflictError, ForbiddenError, HttpError, TooManyRequestsError, UnavailableError, ValidationError } from "@/lib/errors";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { DEMO_REFUSED_MESSAGE } from "@/lib/demo/switch";
import { ProviderError, type ProviderId } from "@/lib/farming/vegetation/provider";
import { readPicture } from "@/lib/farming/vegetation/storage";

/*
 * Shared by the satellite vegetation routes (#612): provider errors as
 * answers people can act on, which providers an organisation may use, and
 * map pictures inline (so the map, and an offline pack, need no second
 * request). Server-only.
 */

/** A provider error as an HTTP error; anything else unchanged. */
export function asHttpError(error: unknown): unknown {
  if (!(error instanceof ProviderError)) return error;
  if (error.kind === "quota") return new ConflictError(error.message);
  if (error.kind === "auth") return new ConflictError(error.message);
  if (error.kind === "rate_limited") return new TooManyRequestsError(error.message, error.retryAfterSeconds ?? 60);
  if (error.kind === "unavailable") return new UnavailableError(error.message);
  return new ValidationError(error.message);
}

export async function providerCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const mapped = asHttpError(error);
    if (mapped instanceof HttpError) throw mapped;
    throw error;
  }
}

/**
 * Made-up pictures are for the demo farm and for trying Tohyee out on a
 * test server (TOHYEE_VEGETATION_DEMO=on); Copernicus is refused on the
 * demo farm, which reaches nothing outside Tohyee (decisions 858, 1522).
 */
export function demoProviderAllowed(organisation: OrganisationRecord): boolean {
  return organisation.demo !== null || process.env.TOHYEE_VEGETATION_DEMO?.trim().toLowerCase() === "on";
}

export function requireProviderAllowed(organisation: OrganisationRecord, provider: ProviderId): void {
  if (provider === "demo" && !demoProviderAllowed(organisation)) throw new ForbiddenError("Made-up demo pictures are only for the demo farm.");
  if (provider === "copernicus" && organisation.demo !== null) throw new ForbiddenError(DEMO_REFUSED_MESSAGE);
}

/** The most an inline map picture may be; a bigger one is fetched by its address instead. */
export const INLINE_PICTURE_BYTES = 1024 * 1024;

export async function inlinePicture(organisationId: string, path: string | null): Promise<string | null> {
  if (!path) return null;
  const bytes = await readPicture(organisationId, path);
  if (!bytes || bytes.byteLength > INLINE_PICTURE_BYTES) return null;
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
