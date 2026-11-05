import { deflateSync, inflateSync } from "node:zlib";

/*
 * A small PNG reader and writer (#612, decision 1523): enough for the
 * pictures Tohyee asks the provider for (16-bit, 4 channels) and the map
 * pictures it makes (8-bit RGBA). Node's own zlib, so nothing to install on
 * Windows or Linux and no GDAL. Tested in tests/unit/vegetation-png.test.ts.
 * Not for interlaced or palette PNGs, which aren't asked for.
 */

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export class PngError extends Error {}

/** A decoded picture: `channels` values a pixel, row by row; 16-bit values are 0-65535. */
export type DecodedPng = { width: number; height: number; channels: number; bitDepth: 8 | 16; data: Uint16Array };

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reads a non-interlaced greyscale, RGB or RGBA PNG of 8 or 16 bits. `maxPixels` refuses anything bigger before it's unpacked. */
export function decodePng(input: Uint8Array, options: { maxPixels?: number } = {}): DecodedPng {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new PngError("That isn't a PNG picture.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = -1;
  const parts: Buffer[] = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) throw new PngError("The PNG picture is cut short.");
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
      if (data[12] !== 0) throw new PngError("Interlaced PNG pictures aren't read.");
    } else if (type === "IDAT") {
      parts.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const channels = CHANNELS[colourType];
  if (!channels || (bitDepth !== 8 && bitDepth !== 16) || width === 0 || height === 0) throw new PngError("That PNG picture isn't a kind Tohyee reads.");
  if (options.maxPixels && width * height > options.maxPixels) throw new PngError("The picture is bigger than expected.");
  const bytesPerPixel = (channels * bitDepth) / 8;
  const stride = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(parts), { maxOutputLength: (stride + 1) * height });
  if (raw.length < (stride + 1) * height) throw new PngError("The PNG picture is cut short.");
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bytesPerPixel ? out[x - bytesPerPixel] : 0;
      const b = prior ? prior[x] : 0;
      const c = prior && x >= bytesPerPixel ? prior[x - bytesPerPixel] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      else if (filter !== 0) throw new PngError("The PNG picture is damaged.");
      out[x] = value & 0xff;
    }
  }
  const data = new Uint16Array(width * height * channels);
  if (bitDepth === 8) for (let i = 0; i < data.length; i += 1) data[i] = rows[i];
  else for (let i = 0; i < data.length; i += 1) data[i] = rows.readUInt16BE(i * 2);
  return { width, height, channels, bitDepth: bitDepth as 8 | 16, data };
}

/** Writes an RGBA PNG (4 channels) of 8 or 16 bits, each row "sub" filtered, which suits smooth pictures. */
export function encodePng(width: number, height: number, data: Uint8Array | Uint16Array, bitDepth: 8 | 16 = 8): Buffer {
  if (data.length !== width * height * 4) throw new PngError("The picture's size doesn't match its pixels.");
  const bytesPerPixel = bitDepth === 8 ? 4 : 8;
  const stride = width * bytesPerPixel;
  const raw = Buffer.alloc((stride + 1) * height);
  const row = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    for (let i = 0; i < width * 4; i += 1) {
      const value = data[y * width * 4 + i];
      if (bitDepth === 8) row[i] = value;
      else row.writeUInt16BE(value, i * 2);
    }
    const start = y * (stride + 1);
    raw[start] = 1;
    for (let x = 0; x < stride; x += 1) raw[start + 1 + x] = (row[x] - (x >= bytesPerPixel ? row[x - bytesPerPixel] : 0)) & 0xff;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = 6;
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}
