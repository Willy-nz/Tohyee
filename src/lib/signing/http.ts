import { publicOrigin } from "@/lib/auth/origin";
import { clientAddress } from "@/lib/auth/sessions";
import type { SignMeta } from "@/lib/signing/service";

/** Who is signing, as the request shows it: IP address, browser and the address links are built on. */
export async function signMeta(request: Request): Promise<SignMeta> {
  return { ip: clientAddress(request.headers), userAgent: request.headers.get("user-agent")?.slice(0, 500) ?? null, origin: await publicOrigin(request) };
}

/** A PDF response. `download` asks the browser to save it. */
export function pdfResponse(file: { fileName: string; content: Buffer | Uint8Array }, download: boolean): Response {
  const name = file.fileName;
  const ascii = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new Response(new Uint8Array(file.content), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
