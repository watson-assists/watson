import type { MetadataRoute } from "next";

export const dynamic = "force-static"; // written once at build: the site is static files

// Watson on a phone's home screen, as an app (owner, 17 Nov: "tomorrow we might turn it into an app").
// No start_url: it opens where it was added from, the doctor's Home or the patient's own link.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Watson",
    short_name: "Watson",
    description: "Ayurveda and integrative care by video: the call, the notes and the form.",
    display: "standalone",
    background_color: "#eef0f2",
    theme_color: "#182e5a",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
