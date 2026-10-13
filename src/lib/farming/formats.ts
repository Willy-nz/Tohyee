import { createHash } from "node:crypto";
import { SaxesParser } from "saxes";
import yauzl from "yauzl";
import { ValidationError } from "@/lib/errors";

/*
 * Reading paddock shapes from the files farmers have (#249): GeoJSON, KML or
 * KMZ (Google Earth and most farm mapping apps), and zipped shapefiles (GIS
 * and fertiliser companies). Everything comes out as GeoJSON features in
 * longitude and latitude, which the boundary import checks as before.
 * Shapefiles and GeoJSON in NZTM2000 (EPSG:2193) are converted here; other
 * projections are refused with a plain message rather than guessed.
 */

export type ShapeFeature = { properties: Record<string, unknown>; geometry: unknown };
export type ShapeFile = { format: "GeoJSON" | "KML" | "KMZ" | "Shapefile"; features: ShapeFeature[]; sha256: string; note: string | null };

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;
const MAX_FEATURES = 2000;

// NZTM2000 (EPSG:2193) ------------------------------------------------------------------------------

/*
 * Transverse Mercator on GRS80, as LINZ defines NZTM2000: central meridian
 * 173°E, scale 0.9996, false easting 1,600,000 m and northing 10,000,000 m.
 * Krüger's series to n⁴ (Karney 2011), accurate to well under a millimetre
 * across New Zealand. NZGD2000 is treated as WGS84: the two differ by about
 * a metre, which doesn't matter for paddock areas or the map.
 */
const A_AXIS = 6378137;
const FLATTENING = 1 / 298.257222101;
const N = FLATTENING / (2 - FLATTENING);
const K0 = 0.9996;
const LON0 = (173 * Math.PI) / 180;
const FALSE_EASTING = 1_600_000;
const FALSE_NORTHING = 10_000_000;
const RECTIFYING_RADIUS = (A_AXIS / (1 + N)) * (1 + N ** 2 / 4 + N ** 4 / 64);
const ALPHA = [
  N / 2 - (2 * N ** 2) / 3 + (5 * N ** 3) / 16 + (41 * N ** 4) / 180,
  (13 * N ** 2) / 48 - (3 * N ** 3) / 5 + (557 * N ** 4) / 1440,
  (61 * N ** 3) / 240 - (103 * N ** 4) / 140,
  (49561 * N ** 4) / 161280,
];
const BETA = [N / 2 - (2 * N ** 2) / 3 + (37 * N ** 3) / 96 - N ** 4 / 360, N ** 2 / 48 + N ** 3 / 15 - (437 * N ** 4) / 1440, (17 * N ** 3) / 480 - (37 * N ** 4) / 840, (4397 * N ** 4) / 161280];
const DELTA = [2 * N - (2 * N ** 2) / 3 - 2 * N ** 3 + (116 * N ** 4) / 45, (7 * N ** 2) / 3 - (8 * N ** 3) / 5 - (227 * N ** 4) / 45, (56 * N ** 3) / 15 - (136 * N ** 4) / 35, (4279 * N ** 4) / 630];

/** NZTM2000 easting and northing (metres) to longitude and latitude (degrees). */
export function nztmToLonLat(easting: number, northing: number): [number, number] {
  const xi = (northing - FALSE_NORTHING) / (K0 * RECTIFYING_RADIUS);
  const eta = (easting - FALSE_EASTING) / (K0 * RECTIFYING_RADIUS);
  let xiPrime = xi;
  let etaPrime = eta;
  BETA.forEach((beta, index) => {
    const j = 2 * (index + 1);
    xiPrime -= beta * Math.sin(j * xi) * Math.cosh(j * eta);
    etaPrime -= beta * Math.cos(j * xi) * Math.sinh(j * eta);
  });
  const chi = Math.asin(Math.sin(xiPrime) / Math.cosh(etaPrime));
  let latitude = chi;
  DELTA.forEach((delta, index) => {
    latitude += delta * Math.sin(2 * (index + 1) * chi);
  });
  const longitude = LON0 + Math.atan2(Math.sinh(etaPrime), Math.cos(xiPrime));
  return [(longitude * 180) / Math.PI, (latitude * 180) / Math.PI];
}

/** Longitude and latitude (degrees) to NZTM2000 easting and northing (metres). */
export function lonLatToNztm(longitude: number, latitude: number): [number, number] {
  const phi = (latitude * Math.PI) / 180;
  const lambda = (longitude * Math.PI) / 180 - LON0;
  const e = (2 * Math.sqrt(N)) / (1 + N);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)));
  const xiPrime = Math.atan2(t, Math.cos(lambda));
  const etaPrime = Math.atanh(Math.sin(lambda) / Math.sqrt(1 + t * t));
  let xi = xiPrime;
  let eta = etaPrime;
  ALPHA.forEach((alpha, index) => {
    const j = 2 * (index + 1);
    xi += alpha * Math.sin(j * xiPrime) * Math.cosh(j * etaPrime);
    eta += alpha * Math.cos(j * xiPrime) * Math.sinh(j * etaPrime);
  });
  return [FALSE_EASTING + K0 * RECTIFYING_RADIUS * eta, FALSE_NORTHING + K0 * RECTIFYING_RADIUS * xi];
}

type Projection = "lonlat" | "nztm";

/** Which projection a .prj file (WKT) describes: longitude/latitude, NZTM2000, or anything else (refused). */
export function projectionFromWkt(wkt: string): Projection {
  const text = wkt.trim();
  if (/^GEOGCS\[/i.test(text) || /^GEOGCRS\[/i.test(text)) return "lonlat";
  if (/New[ _]Zealand[ _]Transverse[ _]Mercator|NZTM|NZGD2000[ _/]+New[ _]Zealand[ _]Transverse/i.test(text)) return "nztm";
  const name = /^(?:PROJCS|PROJCRS)\["([^"]+)"/i.exec(text)?.[1] ?? "an unrecognised projection";
  throw new ValidationError(`The shapes are in ${name.replace(/_/g, " ")}, which Tohyee can't convert. Export them in WGS84 (longitude and latitude) or NZTM2000 instead.`);
}

function reproject(geometry: { type: string; coordinates: unknown }, projection: Projection): { type: string; coordinates: unknown } {
  if (projection === "lonlat") return geometry;
  const convert = (value: unknown): unknown => {
    if (Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number") return nztmToLonLat(value[0], value[1]);
    return Array.isArray(value) ? value.map(convert) : value;
  };
  return { type: geometry.type, coordinates: convert(geometry.coordinates) };
}

// Zips ------------------------------------------------------------------------------------------------

/** The files in a zip, by name, refusing zips that unpack to more than 100 MB. */
async function unzip(bytes: Buffer, wanted: (name: string) => boolean): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(new ValidationError("The zip file can't be opened."));
      const files = new Map<string, Buffer>();
      let total = 0;
      let entries = 0;
      zip.on("error", () => reject(new ValidationError("The zip file is damaged.")));
      zip.on("end", () => resolve(files));
      zip.on("entry", (entry: yauzl.Entry) => {
        entries += 1;
        total += entry.uncompressedSize;
        if (entries > 200 || total > MAX_UNZIPPED_BYTES) {
          zip.close();
          return reject(new ValidationError("The zip file has too many files, or unpacks to more than 100 MB."));
        }
        if (entry.fileName.endsWith("/") || !wanted(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(new ValidationError("A file in the zip can't be read."));
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", () => reject(new ValidationError("A file in the zip can't be read.")));
          stream.on("end", () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

// KML ---------------------------------------------------------------------------------------------------

function kmlRing(text: string): number[][] {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tuple) => {
      const [lon, lat] = tuple.split(",").map(Number);
      return [lon, lat];
    });
}

/** Placemarks with polygons from KML: their name, description-free data fields and shapes. Points and lines are skipped. */
export function readKml(text: string): { features: ShapeFeature[]; skipped: number } {
  const parser = new SaxesParser({ xmlns: false });
  const features: ShapeFeature[] = [];
  let skipped = 0;
  const stack: string[] = [];
  let placemark: { name: string | null; data: Record<string, unknown>; polygons: number[][][][]; other: boolean } | null = null;
  let polygon: number[][][] | null = null;
  let ringKind: "outer" | "inner" | null = null;
  let text_ = "";
  let dataName: string | null = null;
  const local = (name: string) => name.replace(/^.*:/, "");
  parser.on("opentag", (tag) => {
    const name = local(tag.name);
    stack.push(name);
    text_ = "";
    if (name === "Placemark") placemark = { name: null, data: {}, polygons: [], other: false };
    else if (placemark && name === "Polygon") polygon = [];
    else if (placemark && (name === "Point" || name === "LineString")) placemark.other = true;
    else if (name === "outerBoundaryIs") ringKind = "outer";
    else if (name === "innerBoundaryIs") ringKind = "inner";
    else if (name === "Data" || name === "SimpleData") dataName = typeof tag.attributes.name === "string" ? tag.attributes.name : null;
  });
  parser.on("text", (value) => {
    text_ += value;
  });
  parser.on("cdata", (value) => {
    text_ += value;
  });
  parser.on("closetag", (tag) => {
    const name = local(tag.name);
    stack.pop();
    const current = placemark as { name: string | null; data: Record<string, unknown>; polygons: number[][][][]; other: boolean } | null;
    if (!current) return;
    const parent = stack[stack.length - 1];
    if (name === "name" && parent === "Placemark") current.name = text_.trim() || null;
    else if (name === "coordinates" && polygon && ringKind) {
      const ring = kmlRing(text_);
      if (ringKind === "outer") polygon.unshift(ring);
      else polygon.push(ring);
    } else if (name === "outerBoundaryIs" || name === "innerBoundaryIs") ringKind = null;
    else if (name === "Polygon" && polygon) {
      current.polygons.push(polygon);
      polygon = null;
    } else if ((name === "value" && dataName) || (name === "SimpleData" && dataName)) {
      current.data[dataName] = text_.trim();
      if (name === "SimpleData") dataName = null;
    } else if (name === "Data") dataName = null;
    else if (name === "Placemark") {
      if (current.polygons.length === 0) skipped += 1;
      else {
        if (features.length >= MAX_FEATURES) throw new ValidationError(`The file has more than ${MAX_FEATURES.toLocaleString("en-NZ")} shapes.`);
        const geometry = current.polygons.length === 1 ? { type: "Polygon", coordinates: current.polygons[0] } : { type: "MultiPolygon", coordinates: current.polygons };
        features.push({ properties: { ...current.data, ...(current.name ? { name: current.name } : {}) }, geometry });
      }
      placemark = null;
    }
    text_ = "";
  });
  try {
    parser.write(text).close();
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("That KML file can't be read: it isn't well-formed XML.");
  }
  return { features, skipped };
}

// Shapefiles -----------------------------------------------------------------------------------------------

/** dBase attribute records, as text (numbers as numbers), in file order. */
export function readDbf(bytes: Buffer, encoding: BufferEncoding): Array<Record<string, unknown>> {
  if (bytes.length < 32) throw new ValidationError("The shapefile's .dbf file is too short.");
  const count = bytes.readUInt32LE(4);
  const headerLength = bytes.readUInt16LE(8);
  const recordLength = bytes.readUInt16LE(10);
  const fields: Array<{ name: string; type: string; length: number }> = [];
  for (let offset = 32; offset + 32 <= headerLength && bytes[offset] !== 0x0d; offset += 32) {
    const name = bytes.toString("latin1", offset, offset + 11).replace(/\0.*$/, "").trim();
    fields.push({ name, type: String.fromCharCode(bytes[offset + 11]), length: bytes[offset + 16] });
  }
  const records: Array<Record<string, unknown>> = [];
  for (let index = 0; index < count; index += 1) {
    const start = headerLength + index * recordLength;
    if (start + recordLength > bytes.length) break;
    const record: Record<string, unknown> = {};
    let position = start + 1;
    for (const field of fields) {
      const raw = bytes.toString(encoding, position, position + field.length).trim();
      position += field.length;
      record[field.name] = (field.type === "N" || field.type === "F") && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw || null;
    }
    // A deleted record still holds its place, so shapes and records stay paired.
    records.push(bytes[start] === 0x2a ? { __deleted: true } : record);
  }
  return records;
}

function signedArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return sum / 2;
}

function inside(point: number[], ring: number[][]): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) result = !result;
  }
  return result;
}

/** Polygon records from a .shp file, in order (null for empty shapes). Outer rings are clockwise, holes anticlockwise. */
export function readShp(bytes: Buffer): Array<{ type: string; coordinates: number[][][] | number[][][][] } | null> {
  if (bytes.length < 100 || bytes.readInt32BE(0) !== 9994) throw new ValidationError("The .shp file isn't a shapefile.");
  const shapeType = bytes.readInt32LE(32);
  if (![0, 5, 15, 25].includes(shapeType)) throw new ValidationError("The shapefile holds points or lines, not paddock polygons.");
  const shapes: Array<{ type: string; coordinates: number[][][] | number[][][][] } | null> = [];
  let offset = 100;
  while (offset + 8 <= bytes.length) {
    const contentLength = bytes.readInt32BE(offset + 4) * 2;
    const start = offset + 8;
    offset = start + contentLength;
    if (offset > bytes.length) throw new ValidationError("The .shp file is cut short.");
    const type = bytes.readInt32LE(start);
    if (type === 0) {
      shapes.push(null);
      continue;
    }
    if (![5, 15, 25].includes(type)) throw new ValidationError("The shapefile holds a shape that isn't a polygon.");
    if (shapes.length >= MAX_FEATURES) throw new ValidationError(`The file has more than ${MAX_FEATURES.toLocaleString("en-NZ")} shapes.`);
    const parts = bytes.readInt32LE(start + 36);
    const points = bytes.readInt32LE(start + 40);
    if (parts < 1 || points < 4 || parts > points || start + 44 + parts * 4 + points * 16 > offset) throw new ValidationError("A shape in the .shp file is damaged.");
    const starts = Array.from({ length: parts }, (_, index) => bytes.readInt32LE(start + 44 + index * 4));
    const base = start + 44 + parts * 4;
    const rings = starts.map((first, index) => {
      const last = index + 1 < parts ? starts[index + 1] : points;
      return Array.from({ length: last - first }, (_, k) => [bytes.readDoubleLE(base + (first + k) * 16), bytes.readDoubleLE(base + (first + k) * 16 + 8)]);
    });
    // Clockwise rings are outlines; each anticlockwise ring is a hole in the outline that holds it.
    const outlines = rings.filter((ring) => signedArea(ring) < 0).map((ring) => [ring]);
    if (outlines.length === 0) throw new ValidationError("A shape in the .shp file has no outline.");
    for (const hole of rings.filter((ring) => signedArea(ring) >= 0)) {
      const owner = outlines.find((polygon) => inside(hole[0], polygon[0])) ?? outlines[0];
      owner.push(hole);
    }
    shapes.push(outlines.length === 1 ? { type: "Polygon", coordinates: outlines[0] } : { type: "MultiPolygon", coordinates: outlines });
  }
  return shapes;
}

async function readShapefileZip(bytes: Buffer): Promise<{ features: ShapeFeature[]; note: string | null }> {
  const files = await unzip(bytes, (name) => /\.(shp|dbf|prj|cpg)$/i.test(name) && !/(^|\/)__MACOSX\//.test(name));
  const shps = [...files.keys()].filter((name) => /\.shp$/i.test(name));
  if (shps.length === 0) throw new ValidationError("The zip has no .shp file. A shapefile is several files (.shp, .dbf, .prj): zip them together.");
  if (shps.length > 1) throw new ValidationError(`The zip holds ${shps.length} shapefiles. Zip just the paddock layer.`);
  const stem = shps[0].slice(0, -4);
  const sibling = (extension: string) => [...files.entries()].find(([name]) => name.toLowerCase() === `${stem}.${extension}`.toLowerCase())?.[1] ?? null;
  const dbf = sibling("dbf");
  const prj = sibling("prj");
  const cpg = sibling("cpg");
  if (!prj) throw new ValidationError("The zip has no .prj file, so the shapes' projection isn't known. Include the .prj file the shapefile came with.");
  const projection = projectionFromWkt(prj.toString("latin1"));
  const shapes = readShp(files.get(shps[0])!);
  const encoding: BufferEncoding = cpg && /utf-?8/i.test(cpg.toString("latin1")) ? "utf8" : "latin1";
  const records = dbf ? readDbf(dbf, encoding) : [];
  const features: ShapeFeature[] = [];
  shapes.forEach((shape, index) => {
    const properties = records[index] ?? {};
    if (!shape || properties.__deleted) return;
    features.push({ properties, geometry: reproject(shape, projection) });
  });
  return { features, note: projection === "nztm" ? "Converted from NZTM2000 to longitude and latitude." : null };
}

// GeoJSON ------------------------------------------------------------------------------------------------

function readGeoJson(text: string): { features: ShapeFeature[]; note: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError("That isn't a GeoJSON file (it isn't valid JSON).");
  }
  const collection = parsed as { type?: unknown; features?: unknown; crs?: { properties?: { name?: unknown } } };
  const list = collection.type === "FeatureCollection" && Array.isArray(collection.features) ? collection.features : collection.type === "Feature" ? [parsed] : null;
  if (!list) throw new ValidationError("The file should be a GeoJSON FeatureCollection of paddock shapes.");
  if (list.length > MAX_FEATURES) throw new ValidationError(`The file has more than ${MAX_FEATURES.toLocaleString("en-NZ")} shapes.`);
  // Older GeoJSON names its projection in "crs"; NZTM2000 (EPSG:2193) is converted, anything else other than WGS84 refused.
  const crs = typeof collection.crs?.properties?.name === "string" ? collection.crs.properties.name : null;
  let projection: Projection = "lonlat";
  if (crs && /2193\b/.test(crs)) projection = "nztm";
  else if (crs && !/(4326|CRS84|4167)\b/i.test(crs)) throw new ValidationError(`The file's shapes are in ${crs}, which Tohyee can't convert. Export them in WGS84 (longitude and latitude) or NZTM2000 instead.`);
  const features = list.map((feature) => {
    const record = (feature ?? {}) as { properties?: unknown; geometry?: unknown };
    const geometry = record.geometry as { type: string; coordinates: unknown } | null | undefined;
    return {
      properties: (record.properties && typeof record.properties === "object" ? record.properties : {}) as Record<string, unknown>,
      geometry: geometry && typeof geometry === "object" && projection === "nztm" ? reproject(geometry, projection) : geometry,
    };
  });
  return { features, note: projection === "nztm" ? "Converted from NZTM2000 to longitude and latitude." : null };
}

/**
 * Reads a file of paddock shapes: GeoJSON or KML as text (`content`), or a
 * KMZ or zipped shapefile as base64 (`contentBase64`), chosen by its name.
 */
export async function readShapeFile(fileName: string, input: { content?: unknown; contentBase64?: unknown }): Promise<ShapeFile> {
  const lower = fileName.toLowerCase();
  if (typeof input.contentBase64 === "string" && input.contentBase64) {
    const bytes = Buffer.from(input.contentBase64, "base64");
    if (bytes.length === 0) throw new ValidationError("The file is empty.");
    if (bytes.length > MAX_BYTES) throw new ValidationError("The file is larger than 20 MB. Split it or simplify the shapes first.");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (lower.endsWith(".kmz")) {
      const files = await unzip(bytes, (name) => /\.kml$/i.test(name));
      const kml = [...files.entries()].sort(([a], [b]) => (a === "doc.kml" ? -1 : b === "doc.kml" ? 1 : a.localeCompare(b)))[0];
      if (!kml) throw new ValidationError("The KMZ file has no KML inside it.");
      const read = readKml(kml[1].toString("utf8"));
      return { format: "KMZ", features: read.features, sha256, note: read.skipped ? `${read.skipped} placemark${read.skipped === 1 ? "" : "s"} without a polygon (points or lines) skipped.` : null };
    }
    if (lower.endsWith(".zip")) return { format: "Shapefile", sha256, ...(await readShapefileZip(bytes)) };
    if (lower.endsWith(".shp")) throw new ValidationError("A shapefile is several files (.shp, .dbf, .prj). Zip them together and choose the zip.");
    throw new ValidationError("Choose a GeoJSON, KML, KMZ or zipped shapefile.");
  }
  if (typeof input.content !== "string" || input.content.length === 0) throw new ValidationError("Choose a GeoJSON, KML, KMZ or zipped shapefile.");
  if (input.content.length > MAX_BYTES) throw new ValidationError("The file is larger than 20 MB. Split it or simplify the shapes first.");
  const sha256 = createHash("sha256").update(input.content).digest("hex");
  if (lower.endsWith(".kml") || /^\s*(<\?xml[^>]*>\s*)?<kml\b/i.test(input.content)) {
    const read = readKml(input.content);
    return { format: "KML", features: read.features, sha256, note: read.skipped ? `${read.skipped} placemark${read.skipped === 1 ? "" : "s"} without a polygon (points or lines) skipped.` : null };
  }
  return { format: "GeoJSON", sha256, ...readGeoJson(input.content) };
}
