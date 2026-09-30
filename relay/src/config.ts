/** Bindings and settings from wrangler.jsonc (vars), `wrangler secret put` (secrets) and D1. */
export interface Env {
  DB: D1Database;
  DOMAIN: string;
  ACCOUNT_ID: string;
  ZONE_ID: string;
  ABUSE_CONTACT: string;
  NEW_PER_IP_PER_DAY?: string | number;
  REQUESTS_PER_IP_PER_DAY?: string | number;
  NEW_PER_DAY?: string | number;
  MAX_ACTIVE?: string | number;
  /** Secret. Cloudflare API token: Account > Cloudflare Tunnel > Edit, Zone > DNS > Edit. */
  CF_API_TOKEN?: string;
  /** Secret. Password for the /v1/admin endpoints (switching addresses off). */
  ADMIN_TOKEN?: string;
}

export type Settings = {
  domain: string;
  accountId: string;
  zoneId: string;
  abuseContact: string;
  newPerIpPerDay: number;
  requestsPerIpPerDay: number;
  newPerDay: number;
  maxActive: number;
};

function whole(value: string | number | undefined, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function settings(env: Env): Settings {
  return {
    domain: (env.DOMAIN ?? "").trim().toLowerCase().replace(/\.$/, ""),
    accountId: (env.ACCOUNT_ID ?? "").trim(),
    zoneId: (env.ZONE_ID ?? "").trim(),
    abuseContact: (env.ABUSE_CONTACT ?? "").trim(),
    newPerIpPerDay: whole(env.NEW_PER_IP_PER_DAY, 3),
    requestsPerIpPerDay: whole(env.REQUESTS_PER_IP_PER_DAY, 30),
    newPerDay: whole(env.NEW_PER_DAY, 100),
    // Cloudflare's limit is 1,000 tunnels per account.
    maxActive: Math.min(whole(env.MAX_ACTIVE, 900), 1000),
  };
}

/** True when everything needed to create tunnels has been filled in. */
export function isSetUp(env: Env, s: Settings): boolean {
  return Boolean(env.CF_API_TOKEN && s.domain && s.accountId && s.zoneId);
}
