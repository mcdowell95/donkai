import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "preact",
  },
  server: {
    proxy: {
      "/api": "http://localhost:8346",
      "/healthz": "http://localhost:8346",
    },
  },
  build: {
    target: "es2020",
  },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "script",
      includeAssets: ["icons/icon.svg", "icons/apple-touch-icon.png"],
      manifest: {
        name: "Donkai",
        short_name: "Donkai",
        description: "Donkey-work AI — autonomous Linear-ticket dev orchestrator",
        display: "standalone",
        start_url: "/",
        scope: "/",
        theme_color: "#0d1117",
        background_color: "#0d1117",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      workbox: {
        // Push handling lives in public/push-sw.js and is pulled into the
        // generated service worker at build time.
        importScripts: ["push-sw.js"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/healthz/, /^\/classic/],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
