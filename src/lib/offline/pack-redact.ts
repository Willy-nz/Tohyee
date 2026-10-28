/*
 * What never leaves the server in an offline farm pack (#472, decision
 * 1001), and which files a pack's records name. Pure, so it's tested on
 * its own (tests/unit/offline-packs.test.ts).
 */

import type { PackEntry } from "./pack-inventory";

/** A photo or document the page fetches separately (as a small copy) for the photos section. */
export type PackFileRef = { id: string; name: string; contentType: string | null; sizeBytes: number | null };

export type Item = Record<string, unknown>;

export function isRecord(value: unknown): value is Item {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * What never goes into a pack (decision 1001), whatever the person may see
 * online: restricted (injury and medical) details and photos, and the email
 * text behind calendar items.
 */
export function redact(path: string, body: unknown): unknown {
  if (!isRecord(body)) return body;
  if (path === "/api/farming/safety/reports") {
    const reports = Array.isArray(body.reports) ? body.reports : [];
    return {
      ...body,
      reports: reports.map((report: Item) => ({
        ...report,
        details: null,
        detailsHidden: Boolean(report.details) || Boolean(report.detailsHidden),
        files: Array.isArray(report.files) ? report.files.filter((file: Item) => !file.restricted) : report.files,
      })),
      access: isRecord(body.access) ? { ...body.access, canSeeRestricted: false } : body.access,
    };
  }
  if (path === "/api/farming/safety") {
    return { ...body, access: isRecord(body.access) ? { ...body.access, canSeeRestricted: false } : body.access };
  }
  if (path === "/api/farming/calendar" && Array.isArray(body.items)) {
    return {
      ...body,
      items: body.items.map((item: Item) => (item.source === "email" ? { ...item, senderEmail: null, senderName: null, subject: null, excerpt: null, webLink: null } : item)),
    };
  }
  return body;
}

/** Ids of files (photos, safety data sheets) named in a section's answers that aren't restricted. */
export function fileRefs(entries: PackEntry[]): PackFileRef[] {
  const found = new Map<string, PackFileRef>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.id === "string" && typeof value.sha256 === "string" && value.restricted !== true) {
      found.set(value.id, {
        id: value.id,
        name: typeof value.name === "string" ? value.name : "file",
        contentType: typeof value.contentType === "string" ? value.contentType : null,
        sizeBytes: typeof value.sizeBytes === "number" ? value.sizeBytes : null,
      });
    }
    Object.values(value).forEach(walk);
  };
  entries.forEach((entry) => walk(entry.body));
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

