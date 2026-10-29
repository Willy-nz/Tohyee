import { nativeFeatures, tryNative } from "@/lib/native/bridge";
import type { PhotoPlace } from "@/lib/offline/photos";

/*
 * Photos in the Android app (#502, decision 1149): Android's own camera
 * and photo picker through @capacitor/camera (MIT), handed to the same
 * upload path as a browser's file (pickSafetyFile in offline-queue.tsx),
 * so photos are kept on the phone and sent the same way. The capture time
 * goes as the photo's phone file time; where it was taken goes only when
 * the person ticked "Add where I am", as in a browser. `photoFacts` is
 * pure (tests/unit/native-camera.test.ts).
 */

/** The longest side the app's camera saves at: the size the web app keeps (PHOTO_MAX_PIXELS). */
export const NATIVE_PHOTO_PIXELS = 1600;

export type NativeMetadata = { format?: string; creationDate?: string; exif?: string | Record<string, unknown> | null; size?: number };
export type NativeMedia = { webPath?: string; uri?: string; metadata?: NativeMetadata };

function exifObject(exif: NativeMetadata["exif"]): Record<string, unknown> {
  if (!exif) return {};
  if (typeof exif === "object") return exif;
  try {
    const parsed = JSON.parse(exif) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function pick(exif: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const found = Object.keys(exif).find((key) => key.toLowerCase() === name.toLowerCase());
    if (found !== undefined && exif[found] !== null && exif[found] !== "") return exif[found];
  }
  return undefined;
}

/** "45/1,52/1,2850/100", "45,52,28.5", [45, 52, 28.5] or 45.8746 as degrees. */
export function exifDegrees(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parts = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/[,\s]+/).filter(Boolean) : [];
  if (!parts.length || parts.length > 3) return null;
  const numbers = parts.map((part) => {
    const [top, bottom] = part.split("/");
    const n = Number(top) / (bottom === undefined ? 1 : Number(bottom));
    return Number.isFinite(n) ? n : NaN;
  });
  if (numbers.some(Number.isNaN)) return null;
  const [degrees, minutes = 0, seconds = 0] = numbers;
  return degrees + minutes / 60 + seconds / 3600;
}

/** "2026:10:30 14:05:09" (the camera's clock, the phone's time zone) as milliseconds. */
export function exifTime(value: unknown, offset?: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  if (typeof offset === "string" && /^[+-]\d{2}:\d{2}$/.test(offset.trim())) {
    const sign = offset.trim().startsWith("-") ? -1 : 1;
    const [oh, om] = offset.trim().slice(1).split(":").map(Number);
    return Date.UTC(y, mo - 1, d, h, mi, s) - sign * (oh * 60 + om) * 60_000;
  }
  const time = new Date(y, mo - 1, d, h, mi, s).getTime();
  return Number.isFinite(time) ? time : null;
}

/** When the photo was taken and, if the camera wrote one, where. */
export function photoFacts(metadata: NativeMetadata | null | undefined): { takenAt: number | null; place: PhotoPlace | null } {
  const exif = exifObject(metadata?.exif);
  const fromExif = exifTime(pick(exif, "DateTimeOriginal", "DateTimeDigitized", "DateTime"), pick(exif, "OffsetTimeOriginal", "OffsetTime"));
  const created = metadata?.creationDate ? Date.parse(metadata.creationDate) : NaN;
  const takenAt = fromExif ?? (Number.isFinite(created) ? created : null);
  const latitude = exifDegrees(pick(exif, "GPSLatitude"));
  const longitude = exifDegrees(pick(exif, "GPSLongitude"));
  let place: PhotoPlace | null = null;
  if (latitude !== null && longitude !== null) {
    const lat = String(pick(exif, "GPSLatitudeRef") ?? "N").toUpperCase().startsWith("S") ? -Math.abs(latitude) : latitude;
    const lon = String(pick(exif, "GPSLongitudeRef") ?? "E").toUpperCase().startsWith("W") ? -Math.abs(longitude) : longitude;
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) {
      const accuracy = Number(pick(exif, "GPSHPositioningError"));
      place = { latitude: lat, longitude: lon, accuracyM: Number.isFinite(accuracy) && accuracy > 0 ? Math.round(accuracy) : null, at: takenAt === null ? null : new Date(takenAt).toISOString() };
    }
  }
  return { takenAt, place };
}

export function nativeCameraAvailable(): boolean {
  return nativeFeatures().camera;
}

export type NativePhoto = { file: File; takenAt: number | null; exifPlace: PhotoPlace | null };

/**
 * Takes a photo with Android's camera, or chooses one from the phone. Null
 * when the person cancelled; throws with words when it couldn't (camera
 * refused, the photo couldn't be read).
 */
export async function nativePhoto(source: "camera" | "gallery", fetcher: typeof fetch = fetch): Promise<NativePhoto | null> {
  const common = { quality: 85, targetWidth: NATIVE_PHOTO_PIXELS, targetHeight: NATIVE_PHOTO_PIXELS, correctOrientation: true, includeMetadata: true, editable: "no" };
  const result =
    source === "camera"
      ? await tryNative<NativeMedia>("Camera", "takePhoto", { ...common, saveToGallery: false, encodingType: 0 })
      : await tryNative<{ results?: NativeMedia[] }>("Camera", "chooseFromGallery", { ...common, mediaType: 0, allowMultipleSelection: false });
  if (!result.ok) {
    // The camera library words a cancel in several ways ("cancelled", "No picture captured"); none of them is a fault.
    if (/cancel|no (picture|image|photo|media)/i.test(result.error.message) || /cancel/i.test(result.error.code ?? "")) return null;
    if (/permission|denied/i.test(result.error.message)) throw new Error(source === "camera" ? "Tohyee isn't allowed to use the camera. Allow it in the phone's Settings › Apps › Tohyee › Permissions › Camera, then try again." : "Tohyee isn't allowed to open your photos. Allow it in the phone's Settings › Apps › Tohyee › Permissions, then try again.");
    throw new Error(`The photo couldn't be taken: ${result.error.message}`);
  }
  const media = source === "camera" ? (result.value as NativeMedia) : (result.value as { results?: NativeMedia[] }).results?.[0];
  if (!media?.webPath) return null;
  const response = await fetcher(media.webPath);
  if (!response.ok) throw new Error("The photo couldn't be read from the phone. Try again.");
  const blob = await response.blob();
  const facts = photoFacts(media.metadata);
  const format = (media.metadata?.format ?? "").toLowerCase();
  const type = blob.type && blob.type.startsWith("image/") ? blob.type : format === "png" ? "image/png" : "image/jpeg";
  const extension = type === "image/png" ? "png" : "jpg";
  const stamp = new Date(facts.takenAt ?? Date.now()).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const file = new File([blob], `photo-${stamp}.${extension}`, { type, lastModified: facts.takenAt ?? Date.now() });
  return { file, takenAt: facts.takenAt, exifPlace: facts.place };
}
