import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (...p: string[]) => path.join(here, "src", ...p);
const server = (...p: string[]) => path.join(here, "..", "server", "src", ...p);
const same = (a: string, b: string) => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

/**
 * The Android build (`vite build --mode native`): the same app, with the backend swapped. lib/api.ts (HTTP to the
 * Musike server) becomes native/api.ts (the server's own code, running in the app), and the two server modules that
 * only make sense on a computer (paths/environment, yt-dlp) are replaced by small stand-ins.
 */
function nativeBackend(): Plugin {
  const swaps: [from: string, to: string][] = [
    [src("lib", "api.ts"), src("native", "api.ts")],
    [server("config.ts"), src("native", "shims", "config.ts")],
    [server("ytdlp.ts"), src("native", "shims", "ytdlp.ts")],
  ];
  return {
    name: "musike-native-backend",
    enforce: "pre",
    async resolveId(source, importer, options) {
      // No service worker inside the app: it would only risk serving an old version after an update.
      if (source === "virtual:pwa-register") return "\0musike-no-pwa";
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const id = resolved.id.split("?")[0]!;
      for (const [from, to] of swaps) {
        // The replacement may import the original (native/api.ts re-exports lib/apiTypes, not lib/api).
        if (same(id, from) && !(importer && same(importer, to))) return to;
      }
      return null;
    },
    load(id) {
      if (id === "\0musike-no-pwa") return "export const registerSW = () => () => {};";
      return null;
    },
  };
}

/**
 * Writes the real install size into the bundle: the files the service worker precaches are exactly what an install
 * downloads, so the button can say how much it costs before the user commits to it.
 */
function appSize(): Plugin {
  const PLACEHOLDER = "__APP_SIZE__";
  return {
    name: "musike-app-size",
    apply: "build",
    // Must run after VitePWA: the service worker it generates is what says which files an install downloads.
    enforce: "post",
    // closeBundle order follows the workbox build, which VitePWA triggers at the end of its own closeBundle.
    closeBundle: { order: "post", sequential: true, handler() {
      const dist = path.join(here, "dist");
      let urls: string[];
      try {
        urls = [...readFileSync(path.join(dist, "sw.js"), "utf8").matchAll(/url:"([^"]+)"/g)].map((m) => m[1]!);
      } catch {
        return; // no service worker (native build): nothing to measure
      }
      let bytes = 0;
      for (const url of urls) {
        try {
          bytes += statSync(path.join(dist, url)).size;
        } catch {
          /* entry generated at runtime: not part of the initial install */
        }
      }
      // Decimal MB with one decimal, the way stores quote download sizes.
      const mb = Math.max(0.1, bytes / 1_000_000).toFixed(1);
      const assets = path.join(dist, "assets");
      for (const name of readdirSync(assets)) {
        const file = path.join(assets, name);
        const code = readFileSync(file, "utf8");
        if (code.includes(PLACEHOLDER)) writeFileSync(file, code.replaceAll(PLACEHOLDER, mb));
      }
    } },
  };
}

export default defineConfig(({ mode }) => {
  const native = mode === "native";
  return {
    define: { __APP_VERSION__: JSON.stringify(version) },
    build: native ? { outDir: "dist-native", emptyOutDir: true } : undefined,
    plugins: [
      react(),
      tailwindcss(),
      appSize(),
      native
        ? nativeBackend()
        : VitePWA({
            registerType: "autoUpdate",
            includeAssets: ["favicon.svg", "apple-touch-icon.png"],
            manifest: {
              name: "Iskan Music",
              short_name: "Iskan Music",
              description: "Your music, uninterrupted.",
              lang: "en",
              theme_color: "#0B0C0F",
              background_color: "#0B0C0F",
              display: "standalone",
              start_url: "/",
              icons: [
                { src: "icon-192.png", sizes: "192x192", type: "image/png" },
                { src: "icon-512.png", sizes: "512x512", type: "image/png" },
                { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
              ],
            },
            workbox: {
              navigateFallbackDenylist: [/^\/api\//],
              runtimeCaching: [
                {
                  // Artwork only. Streams and API responses are never cached by the service worker.
                  urlPattern: ({ url }) => /(^|\.)ytimg\.com$|googleusercontent\.com$|ggpht\.com$/.test(url.hostname),
                  handler: "CacheFirst",
                  options: {
                    cacheName: "artwork",
                    expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 30 },
                    cacheableResponse: { statuses: [0, 200] },
                  },
                },
              ],
            },
          }),
    ],
    server: {
      proxy: native ? undefined : { "/api": "http://127.0.0.1:4180" },
    },
    preview: {
      proxy: native ? undefined : { "/api": "http://127.0.0.1:4180" },
    },
  };
});
