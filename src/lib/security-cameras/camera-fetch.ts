/*
 * Fetching a recording from a camera's SD card on request (#508, decision
 * 1224): NOT BUILT. This is the seam for it.
 *
 * Reolink's battery 4G cameras (Go PT Plus and the Go range) have no RTSP,
 * ONVIF or HTTP API; the projects that reach them (Neolink, PyNeolink) use
 * Reolink's own protocol, are experimental, and haven't been shown to list
 * or download SD recordings over a cellular connection. Nothing was tested
 * against a camera. So nothing in Tohyee offers a fetch, and no screen
 * shows a button for it: an event is a snapshot or a clip that arrived,
 * never "clip on the camera".
 *
 * When a library is proven with a real camera, it implements this, the
 * event gets a state (queued, downloading, saved, failed, unavailable),
 * and the screens can offer it. Until then `availableFetcher()` is null.
 */

export type RecordingRequest = { cameraId: string; from: Date; to: Date };

export type RecordingFetcher = {
  /** A short name for the method, e.g. the library and version that was tested. */
  name: string;
  /** Asks the camera for the recording around a time; resolves with the file's path in the incoming folder, or rejects with a plain reason. */
  fetch(request: RecordingRequest): Promise<{ tempPath: string; fileName: string }>;
};

export function availableFetcher(): RecordingFetcher | null {
  return null;
}
