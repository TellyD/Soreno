import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

function contentName(name: string, extension: string, bytes: Buffer | string) {
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 10);
  return `assets/${name}-${hash}.${extension}`;
}

// /assets/ is served immutable (vercel.json): home screen files get content hashed names there.
function homeScreenAssets(): Plugin {
  const icon = readFileSync(path.resolve(__dirname, "Icon.png"));
  const iconFile = contentName("icon", "png", icon);
  const manifest = JSON.stringify({
    name: "Soreno",
    short_name: "Soreno",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fbfbfa",
    theme_color: "#fbfbfa",
    icons: [
      {
        src: `/${iconFile}`,
        sizes: "1024x1024",
        type: "image/png",
        purpose: "any",
      },
    ],
  });
  const manifestFile = contentName("manifest", "webmanifest", manifest);
  return {
    name: "soreno-home-screen-assets",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: iconFile, source: icon });
      this.emitFile({
        type: "asset",
        fileName: manifestFile,
        source: manifest,
      });
    },
    transformIndexHtml: () => [
      {
        tag: "link",
        attrs: { rel: "manifest", href: `/${manifestFile}` },
        injectTo: "head",
      },
      {
        tag: "link",
        attrs: { rel: "icon", type: "image/png", href: `/${iconFile}` },
        injectTo: "head",
      },
      {
        tag: "link",
        attrs: { rel: "apple-touch-icon", href: `/${iconFile}` },
        injectTo: "head",
      },
    ],
  };
}

// Page served by Vercel at https://mobile.soreno.dev (vercel.json); the relay only carries WebSockets.
// In development (scripts/dev-mobile.sh), /relay goes to the local relay at SORENO_RELAY_DEV.
const relay = process.env.SORENO_RELAY_DEV;

export default defineConfig({
  root: path.resolve(__dirname, "src/mobile"),
  base: "/",
  publicDir: false,
  plugins: [react(), tailwindcss(), homeScreenAssets()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@tauri-apps/plugin-opener": path.resolve(
        __dirname,
        "src/mobile/opener.ts",
      ),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist/mobile"),
    emptyOutDir: true,
  },
  server: {
    proxy: relay ? { "/relay/": { target: relay, ws: true } } : undefined,
  },
});
