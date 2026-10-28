/*
 * Photos taken on the device for offline work (#472 stage 4, decision
 * 1012): a compressed copy to keep and send (the phone's storage is small,
 * and the signal on a farm is often poor), and, only when the person asks,
 * where the phone says it was. Browser-only.
 */

/** Photos are kept and sent at most this size on their longest side. */
export const PHOTO_MAX_PIXELS = 1600;
export const PHOTO_QUALITY = 0.8;

export type PhotoPlace = { latitude: number; longitude: number; accuracyM: number | null; at: string | null };

/** The size to draw a photo at: no larger than PHOTO_MAX_PIXELS on its longest side, never enlarged. */
export function fitWithin(width: number, height: number, max = PHOTO_MAX_PIXELS): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * A JPEG copy no larger than 1600 pixels on its longest side. The original
 * when the browser can't make one, or when the copy would be bigger. (A
 * copy loses the camera's EXIF date; the phone's file time is kept and sent
 * separately.)
 */
export async function compressPhoto(file: Blob): Promise<Blob> {
  try {
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const size = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close();
    const copy = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY));
    return copy && copy.size < file.size ? copy : file;
  } catch {
    return file;
  }
}

/** Where the phone says it is, with its accuracy and the fix's time; null if it can't tell, or isn't allowed to, within 10 seconds. */
export function photoPlace(timeoutMs = 10_000): Promise<PhotoPlace | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracyM: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null, at: new Date(position.timestamp).toISOString() }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}

/** "−45.874512, 170.503906 (± 8 m)", for a photo's caption. */
export function placeText(place: PhotoPlace): string {
  return `${place.latitude.toFixed(6)}, ${place.longitude.toFixed(6)}${place.accuracyM === null ? "" : ` (± ${place.accuracyM} m)`}`;
}
