/*
 * The council pack's map of applied areas (#487, decision 1099b): an SVG of
 * the farm's paddocks shaded by how many effluent applications each had in
 * the range, the no-apply zones in red and the recorded positions as dots.
 * A picture from the farm's own paddock shapes, not a survey. Pure.
 */

type Ring = Array<[number, number]>;
type Geometry = { type: "Polygon"; coordinates: Ring[] } | { type: "MultiPolygon"; coordinates: Ring[][] };

export type MapPaddock = { name: string; geometry: Geometry | null; applications: number };
export type MapZone = { name: string; ring: Ring | null; point: [number, number] | null };

const WIDTH = 800;
const HEIGHT = 600;
const SHADES = ["#f2f5ef", "#c6dbef", "#9ecae1", "#6baed6", "#3182bd", "#08519c"];

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function rings(geometry: Geometry): Ring[] {
  return geometry.type === "Polygon" ? [geometry.coordinates[0]] : geometry.coordinates.map((polygon) => polygon[0]);
}

/** The shade for a count: none is pale, five or more the darkest. */
export function shadeFor(count: number): string {
  return SHADES[Math.max(0, Math.min(SHADES.length - 1, count))];
}

export function appliedAreasSvg(input: { title: string; paddocks: MapPaddock[]; zones: MapZone[]; points: Array<[number, number]> }): string {
  const all: Array<[number, number]> = [...input.paddocks.flatMap((paddock) => (paddock.geometry ? rings(paddock.geometry).flat() : [])), ...input.zones.flatMap((zone) => [...(zone.ring ?? []), ...(zone.point ? [zone.point] : [])]), ...input.points];
  const header = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT + 76}" width="${WIDTH}" height="${HEIGHT + 76}" font-family="sans-serif">`;
  const title = `<text x="10" y="${HEIGHT + 22}" font-size="14" font-weight="700">${escape(input.title)}</text><text x="10" y="${HEIGHT + 42}" font-size="11">Shade: effluent applications recorded on each paddock (darkest 5 or more). Red: no-apply zones. Dots: positions recorded.</text><text x="10" y="${HEIGHT + 60}" font-size="11">From the farm's own paddock shapes; not a survey.</text>`;
  if (!all.length) return `${header}<text x="10" y="30" font-size="14">No paddock shapes to draw.</text>${title}</svg>`;
  const lons = all.map((point) => point[0]);
  const lats = all.map((point) => point[1]);
  const [west, east, south, north] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  const midLat = ((south + north) / 2) * (Math.PI / 180);
  const spanX = Math.max((east - west) * Math.cos(midLat), 1e-9);
  const spanY = Math.max(north - south, 1e-9);
  const scale = Math.min((WIDTH - 20) / spanX, (HEIGHT - 20) / spanY);
  const xy = ([lon, lat]: [number, number]) => [10 + (lon - west) * Math.cos(midLat) * scale, 10 + (north - lat) * scale].map((value) => value.toFixed(1)).join(",");
  const path = (ring: Ring) => `M${ring.map(xy).join("L")}Z`;
  const parts: string[] = [header, `<rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>`];
  for (const paddock of input.paddocks) {
    if (!paddock.geometry) continue;
    for (const ring of rings(paddock.geometry)) parts.push(`<path d="${path(ring)}" fill="${shadeFor(paddock.applications)}" stroke="#4f6b3a" stroke-width="1"><title>${escape(`${paddock.name}: ${paddock.applications} applications`)}</title></path>`);
    const ring = rings(paddock.geometry)[0];
    const centre: [number, number] = [ring.reduce((sum, point) => sum + point[0], 0) / ring.length, ring.reduce((sum, point) => sum + point[1], 0) / ring.length];
    const [cx, cy] = xy(centre).split(",");
    parts.push(`<text x="${cx}" y="${cy}" font-size="11" text-anchor="middle" fill="#1d2733">${escape(paddock.name)}${paddock.applications ? ` (${paddock.applications})` : ""}</text>`);
  }
  for (const zone of input.zones) {
    if (zone.ring) parts.push(`<path d="${path(zone.ring)}" fill="rgba(200,30,30,0.25)" stroke="#c81e1e" stroke-dasharray="6 3"><title>${escape(zone.name)}</title></path>`);
    if (zone.point) {
      const [x, y] = xy(zone.point).split(",");
      parts.push(`<path d="M${x},${Number(y) - 9}l8,14h-16z" fill="#c81e1e"><title>${escape(zone.name)}</title></path>`);
    }
  }
  for (const point of input.points) {
    const [x, y] = xy(point).split(",");
    parts.push(`<circle cx="${x}" cy="${y}" r="3.5" fill="#1d5fae" stroke="#ffffff" stroke-width="1"/>`);
  }
  parts.push(title, "</svg>");
  return parts.join("");
}
