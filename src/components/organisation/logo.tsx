"use client";

import { useApiData } from "@/components/hooks";
import type { LogoInfo } from "@/lib/organisations/logo";

/**
 * The organisation's logo, top left on printed documents and statements,
 * at most 200 x 64 pixels on screen (and in print). Nothing when there's no
 * logo, or while it loads.
 */
export function OrganisationLogo({ organisationId }: { organisationId: string }) {
  const loaded = useApiData<{ logo: LogoInfo | null }>(`/api/organisations/${organisationId}/logo`, { info: "1" });
  const logo = loaded.data?.logo;
  if (!logo) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- the image comes from the organisation's own database through an authenticated route, not a static file next/image could optimise.
    <img
      src={`/api/organisations/${encodeURIComponent(organisationId)}/logo?v=${logo.sha256.slice(0, 16)}`}
      alt=""
      style={{ display: "block", maxWidth: 200, maxHeight: 64, width: "auto", height: "auto", marginBottom: 10 }}
    />
  );
}
