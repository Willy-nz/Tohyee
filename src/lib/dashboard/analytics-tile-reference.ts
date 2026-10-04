export type AnalyticsTileReference = { dashboardId: string; tileId: string };

const REFERENCE = /^analytics:(\d{1,18}):([a-z0-9-]{1,40})$/;

export function analyticsTileReference(dashboardId: string, tileId: string): string {
  return `analytics:${dashboardId}:${tileId}`;
}

export function parseAnalyticsTileReference(value: string): AnalyticsTileReference | null {
  const match = REFERENCE.exec(value);
  return match ? { dashboardId: match[1], tileId: match[2] } : null;
}
