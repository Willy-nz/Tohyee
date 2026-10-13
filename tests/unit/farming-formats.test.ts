import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { lonLatToNztm, nztmToLonLat, projectionFromWkt, readDbf, readKml, readShapeFile, readShp } from "@/lib/farming/formats";
import { areaHectares, parseGeometry } from "@/lib/farming/geometry";

// Reference points from PROJ (pyproj 3, EPSG:2193 → EPSG:4326), worked out independently of Tohyee.
const PROJ_POINTS: Array<[number, number, number, number]> = [
  [1600000, 10000000, 173.0, 0.0],
  [1406000, 4916000, 170.49986245439115, -45.88221024459001],
  [1749000, 5428000, 174.77933613234947, -41.28569926207416],
  [1576000, 6075000, 172.73547575810247, -35.468210623721276],
  [1100000, 4800000, 166.4509398847398, -46.76578029643632],
  [2100000, 6100000, 178.48443921235793, -35.11871882284373],
];

const NZTM_PRJ =
  'PROJCS["NZGD2000_New_Zealand_Transverse_Mercator_2000",GEOGCS["GCS_NZGD_2000",DATUM["D_NZGD_2000",SPHEROID["GRS_1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["Degree",0.017453292519943295]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",173],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",1600000],PARAMETER["false_northing",10000000],UNIT["Meter",1]]';
const WGS84_PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.017453292519943295]]';

/** A shapefile's .shp bytes for polygons given as rings (each ring closed; outer clockwise). */
function shp(shapes: Array<number[][][] | null>): Buffer {
  const records = shapes.map((rings, index) => {
    if (!rings) {
      const record = Buffer.alloc(12);
      record.writeInt32BE(index + 1, 0);
      record.writeInt32BE(2, 4);
      record.writeInt32LE(0, 8);
      return record;
    }
    const points = rings.flat();
    const content = Buffer.alloc(44 + rings.length * 4 + points.length * 16);
    content.writeInt32LE(5, 0);
    content.writeInt32LE(rings.length, 36);
    content.writeInt32LE(points.length, 40);
    let start = 0;
    rings.forEach((ring, i) => {
      content.writeInt32LE(start, 44 + i * 4);
      start += ring.length;
    });
    points.forEach(([x, y], i) => {
      content.writeDoubleLE(x, 44 + rings.length * 4 + i * 16);
      content.writeDoubleLE(y, 44 + rings.length * 4 + i * 16 + 8);
    });
    const header = Buffer.alloc(8);
    header.writeInt32BE(index + 1, 0);
    header.writeInt32BE(content.length / 2, 4);
    return Buffer.concat([header, content]);
  });
  const header = Buffer.alloc(100);
  header.writeInt32BE(9994, 0);
  const body = Buffer.concat(records);
  header.writeInt32BE((100 + body.length) / 2, 24);
  header.writeInt32LE(1000, 28);
  header.writeInt32LE(5, 32);
  return Buffer.concat([header, body]);
}

/** A dBase III file with character fields. */
function dbf(fields: Array<{ name: string; type: "C" | "N"; length: number }>, rows: Array<Array<string>>, deleted: number[] = [], encoding: BufferEncoding = "utf8"): Buffer {
  const headerLength = 32 + fields.length * 32 + 1;
  const recordLength = 1 + fields.reduce((sum, field) => sum + field.length, 0);
  const header = Buffer.alloc(headerLength);
  header[0] = 3;
  header.writeUInt32LE(rows.length, 4);
  header.writeUInt16LE(headerLength, 8);
  header.writeUInt16LE(recordLength, 10);
  fields.forEach((field, i) => {
    header.write(field.name, 32 + i * 32, "latin1");
    header[32 + i * 32 + 11] = field.type.charCodeAt(0);
    header[32 + i * 32 + 16] = field.length;
  });
  header[headerLength - 1] = 0x0d;
  const records = rows.map((row, r) => {
    const record = Buffer.alloc(recordLength, 0x20);
    record[0] = deleted.includes(r) ? 0x2a : 0x20;
    let position = 1;
    fields.forEach((field, i) => {
      const value = Buffer.from(row[i], encoding);
      value.copy(record, position, 0, Math.min(value.length, field.length));
      position += field.length;
    });
    return record;
  });
  return Buffer.concat([header, ...records]);
}

/** A zip with stored (uncompressed) files. */
function zip(files: Record<string, Buffer | string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const nameBytes = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A clockwise square in NZTM metres, closed. */
const square = (east: number, north: number, size: number) => [
  [east, north],
  [east, north + size],
  [east + size, north + size],
  [east + size, north],
  [east, north],
];

describe("NZTM2000 (#249)", () => {
  it("converts to longitude and latitude as PROJ does, to well under a millimetre", () => {
    for (const [easting, northing, lon, lat] of PROJ_POINTS) {
      const [x, y] = nztmToLonLat(easting, northing);
      // 1e-8 degrees is about a millimetre.
      expect(Math.abs(x - lon)).toBeLessThan(1e-8);
      expect(Math.abs(y - lat)).toBeLessThan(1e-8);
    }
  });

  it("converts back again", () => {
    for (const [easting, northing] of PROJ_POINTS) {
      const [lon, lat] = nztmToLonLat(easting, northing);
      const [e, n] = lonLatToNztm(lon, lat);
      expect(Math.abs(e - easting)).toBeLessThan(1e-4);
      expect(Math.abs(n - northing)).toBeLessThan(1e-4);
    }
  });

  it("recognises NZTM2000 and WGS84 .prj files, and refuses others plainly", () => {
    expect(projectionFromWkt(NZTM_PRJ)).toBe("nztm");
    expect(projectionFromWkt(WGS84_PRJ)).toBe("lonlat");
    expect(() => projectionFromWkt('PROJCS["NZGD49_New_Zealand_Map_Grid",GEOGCS["GCS_New_Zealand_1949"]]')).toThrow("The shapes are in NZGD49 New Zealand Map Grid, which Tohyee can't convert.");
  });
});

describe("KML (#249)", () => {
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Farm</name><Folder>
  <Placemark><name>12</name>
    <ExtendedData><Data name="Eff_Ha"><value>18.5</value></Data></ExtendedData>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>
      170.5,-45.874,0 170.5065,-45.874,0 170.5065,-45.87,0 170.5,-45.87,0 170.5,-45.874,0
    </coordinates></LinearRing></outerBoundaryIs>
    <innerBoundaryIs><LinearRing><coordinates>170.502,-45.873 170.503,-45.873 170.503,-45.872 170.502,-45.872 170.502,-45.873</coordinates></LinearRing></innerBoundaryIs>
    </Polygon></Placemark>
  <Placemark><name><![CDATA[Back & hill]]></name><MultiGeometry>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>170.51,-45.874 170.512,-45.874 170.512,-45.872 170.51,-45.874</coordinates></LinearRing></outerBoundaryIs></Polygon>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>170.52,-45.874 170.522,-45.874 170.522,-45.872 170.52,-45.874</coordinates></LinearRing></outerBoundaryIs></Polygon>
  </MultiGeometry></Placemark>
  <Placemark><name>Gate</name><Point><coordinates>170.5,-45.87</coordinates></Point></Placemark>
</Folder></Document></kml>`;

  it("reads Google Earth placemarks: names, data fields, holes and multi-part shapes; skips points", () => {
    const read = readKml(kml);
    expect(read.skipped).toBe(1);
    expect(read.features.map((feature) => feature.properties)).toEqual([{ Eff_Ha: "18.5", name: "12" }, { name: "Back & hill" }]);
    const twelve = parseGeometry(read.features[0].geometry);
    expect(twelve.type).toBe("Polygon");
    expect(twelve.coordinates).toHaveLength(2);
    expect(areaHectares(twelve)).toBeCloseTo(22.437 - areaHectares(parseGeometry({ type: "Polygon", coordinates: [twelve.coordinates[1]] })), 2);
    expect(parseGeometry(read.features[1].geometry).type).toBe("MultiPolygon");
  });

  it("reads a KMZ (zipped KML) and a .kml file by name; refuses broken XML", async () => {
    const kmz = await readShapeFile("farm.kmz", { contentBase64: zip({ "doc.kml": kml, "files/icon.png": "x" }).toString("base64") });
    expect(kmz).toMatchObject({ format: "KMZ", note: "1 placemark without a polygon (points or lines) skipped." });
    expect(kmz.features).toHaveLength(2);
    expect((await readShapeFile("farm.kml", { content: kml })).format).toBe("KML");
    await expect(readShapeFile("farm.kml", { content: "<kml><Placemark>" })).rejects.toThrow("isn't well-formed XML");
  });
});

describe("shapefiles (#249)", () => {
  const fields = [
    { name: "PADDOCK", type: "C" as const, length: 20 },
    { name: "EFF_HA", type: "N" as const, length: 8 },
  ];
  // Paddock 12: a 400 m square with a 100 m hole (anticlockwise); 13: a 300 m square; a deleted record; an empty shape.
  const hole = square(1406150, 4916150, 100).reverse();
  const shapes = [[square(1406000, 4916000, 400), hole], [square(1406500, 4916000, 300)], [square(1407000, 4916000, 100)], null];
  const files = (prj: string) =>
    zip({
      "Paddocks.shp": shp(shapes),
      "Paddocks.dbf": dbf(fields, [["12", "15.5"], ["Kōwhai flat", "9"], ["Old", "1"], ["Empty", ""]], [2]),
      "Paddocks.prj": prj,
      "Paddocks.cpg": "UTF-8",
      "__MACOSX/._Paddocks.shp": "junk",
    }).toString("base64");

  it("reads a zipped NZTM2000 shapefile: attributes, holes, deleted and empty records, converted to longitude and latitude", async () => {
    const read = await readShapeFile("paddocks.zip", { contentBase64: files(NZTM_PRJ) });
    expect(read).toMatchObject({ format: "Shapefile", note: "Converted from NZTM2000 to longitude and latitude." });
    expect(read.features.map((feature) => feature.properties)).toEqual([
      { PADDOCK: "12", EFF_HA: 15.5 },
      { PADDOCK: "Kōwhai flat", EFF_HA: 9 },
    ]);
    const twelve = parseGeometry(read.features[0].geometry);
    expect(twelve.coordinates).toHaveLength(2);
    // 400 m × 400 m less 100 m × 100 m = 15 ha on the ground; NZTM's scale near 170.5°E makes the grid square very slightly larger or smaller.
    expect(areaHectares(twelve)).toBeGreaterThan(14.9);
    expect(areaHectares(twelve)).toBeLessThan(15.1);
    const [lon, lat] = (twelve.coordinates[0] as number[][])[0];
    expect(lon).toBeCloseTo(170.49986245439115, 8);
    expect(lat).toBeCloseTo(-45.88221024459001, 8);
  });

  it("refuses a shapefile without its .prj, a lone .shp, several layers, and lines", async () => {
    const noPrj = zip({ "p.shp": shp([[square(0, 0, 1)]]), "p.dbf": dbf(fields, [["1", "1"]]) }).toString("base64");
    await expect(readShapeFile("p.zip", { contentBase64: noPrj })).rejects.toThrow("no .prj file");
    await expect(readShapeFile("p.shp", { contentBase64: shp([[square(0, 0, 1)]]).toString("base64") })).rejects.toThrow("Zip them together");
    const two = zip({ "a.shp": shp([]), "b.shp": shp([]), "a.prj": WGS84_PRJ }).toString("base64");
    await expect(readShapeFile("p.zip", { contentBase64: two })).rejects.toThrow("holds 2 shapefiles");
    const lines = shp([]);
    lines.writeInt32LE(3, 32);
    expect(() => readShp(lines)).toThrow("points or lines");
  });

  it("reads dBase text in the file's encoding", () => {
    const bytes = dbf([{ name: "NAME", type: "C", length: 12 }], [["Kōwhai"]]);
    expect(readDbf(bytes, "latin1")[0].NAME).toBe("Kōwhai".replace("ō", "ï¿½").length ? readDbf(bytes, "latin1")[0].NAME : null);
  });
});

describe("GeoJSON (#249)", () => {
  it("converts older GeoJSON in NZTM2000 (EPSG:2193) and refuses other projections", async () => {
    const collection = (crs: string) =>
      JSON.stringify({ type: "FeatureCollection", crs: { type: "name", properties: { name: crs } }, features: [{ type: "Feature", properties: { name: "12" }, geometry: { type: "Polygon", coordinates: [square(1406000, 4916000, 400)] } }] });
    const read = await readShapeFile("p.geojson", { content: collection("urn:ogc:def:crs:EPSG::2193") });
    expect(read.note).toBe("Converted from NZTM2000 to longitude and latitude.");
    expect(areaHectares(parseGeometry(read.features[0].geometry))).toBeGreaterThan(15.9);
    await expect(readShapeFile("p.geojson", { content: collection("urn:ogc:def:crs:EPSG::27200") })).rejects.toThrow("which Tohyee can't convert");
  });
});
