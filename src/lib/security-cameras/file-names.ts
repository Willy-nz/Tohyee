/*
 * What a Reolink camera's uploaded file name says (#508, decision 1217).
 * Pure; tested in tests/unit/security-camera-files.test.ts.
 *
 * What we found (docs/FARM-SECURITY.md has the sources): Reolink's own
 * help pages don't document the file name. Names reported by people using
 * Reolink's FTP upload look like
 *
 *   K3TA_00_20220307125142.mp4      (a camera; clip)
 *   K3TA_00_20220307125217.jpg      (the same camera; snapshot)
 *   Driveway_01_20180510115044.mp4  (a camera named Driveway)
 *   NVR_00_20251002011659.mp4       (an NVR's channel)
 *
 * that is: the device's name, a two-digit channel, the camera clock's local
 * date and time (YYYYMMDDHHMMSS, no time zone), and the extension. Nothing
 * in the name says person, vehicle or animal, so Tohyee never says so
 * either. The folder (Reolink's "Directory" and "Generate subfolder by"
 * settings) isn't used: only the file's own name.
 *
 * Not checked against a Go PT Plus: no camera was available when this was
 * written. A name that doesn't fit still arrives, with no camera time.
 */

export type ParsedFileName = {
  /** The camera's local wall-clock time, "YYYY-MM-DDTHH:MM:SS", or null if the name has none. */
  cameraLocalTime: string | null;
  /** "reolink" when the name is device_channel_stamp.ext; "stamp" when only a 14-digit date and time was found; "none" otherwise. */
  pattern: "reolink" | "stamp" | "none";
  /** The device name and channel from a Reolink-style name, as written. */
  deviceName: string | null;
  channel: string | null;
  /** What the extension says (the content is checked separately and wins). */
  extensionKind: "snapshot" | "clip" | null;
};

const REOLINK = /^(.+)_(\d{2})_(\d{14})\.([A-Za-z0-9]{1,5})$/;
const STAMP = /(?:^|[^0-9])(\d{14})(?:[^0-9]|$)/;

/** The last part of a path, whichever slash the camera used. Never a folder. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/** "20220307125142" as "2022-03-07T12:51:42", or null when it isn't a real date and time. */
export function stampToLocal(stamp: string): string | null {
  if (!/^\d{14}$/.test(stamp)) return null;
  const year = Number(stamp.slice(0, 4));
  const month = Number(stamp.slice(4, 6));
  const day = Number(stamp.slice(6, 8));
  const hour = Number(stamp.slice(8, 10));
  const minute = Number(stamp.slice(10, 12));
  const second = Number(stamp.slice(12, 14));
  if (year < 2000 || year > 2099 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}`;
}

function kindOfExtension(name: string): ParsedFileName["extensionKind"] {
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (extension === "jpg" || extension === "jpeg") return "snapshot";
  if (extension === "mp4") return "clip";
  return null;
}

export function parseCameraFileName(path: string): ParsedFileName {
  const name = baseName(path);
  const extensionKind = kindOfExtension(name);
  const reolink = REOLINK.exec(name);
  if (reolink) {
    const local = stampToLocal(reolink[3]);
    if (local) return { cameraLocalTime: local, pattern: "reolink", deviceName: reolink[1], channel: reolink[2], extensionKind };
  }
  const stamp = STAMP.exec(name);
  const local = stamp ? stampToLocal(stamp[1]) : null;
  if (local) return { cameraLocalTime: local, pattern: "stamp", deviceName: null, channel: null, extensionKind };
  return { cameraLocalTime: null, pattern: "none", deviceName: null, channel: null, extensionKind };
}

// What the file really is --------------------------------------------------------------------

export type MediaKind = { kind: "snapshot"; contentType: "image/jpeg"; extension: "jpg" } | { kind: "clip"; contentType: "video/mp4"; extension: "mp4" };

/** How many bytes `sniffMedia` needs to decide. */
export const SNIFF_BYTES = 12;

/**
 * What the first bytes say the file is: a JPEG (FF D8 FF) or an MP4 (an
 * ISO media file: bytes 4-7 are "ftyp"). Anything else is refused,
 * whatever its name says.
 */
export function sniffMedia(head: Uint8Array): MediaKind | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: "snapshot", contentType: "image/jpeg", extension: "jpg" };
  if (head.length >= 12 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
    // The box's size (bytes 0-3) is at least the 8-byte header and the 4-byte brand.
    const size = ((head[0] << 24) >>> 0) + (head[1] << 16) + (head[2] << 8) + head[3];
    if (size >= 12) return { kind: "clip", contentType: "video/mp4", extension: "mp4" };
  }
  return null;
}
