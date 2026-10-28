import type { MetadataRoute } from "next";

/**
 * The web app manifest (#472, decision 990): what a phone or tablet needs
 * to put Tohyee on its Home Screen. It opens on the server it was added
 * from (start_url and scope are this server's), in its own window, with
 * the app icon. Served at /manifest.webmanifest.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Tohyee",
    short_name: "Tohyee",
    description: "Tohyee on this device: your farm, safety and books, with farm pages that open offline.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f5f7fa",
    theme_color: "#2563eb",
    lang: "en-NZ",
    icons: [
      { src: "/icons/tohyee-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/tohyee-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/tohyee-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
