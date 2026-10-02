import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/*
 * The @bazlama/* packages are not published yet: they are used from source in the sibling
 * repo (both repos must sit in the same parent folder). See docs/architecture.md.
 */
const components = r("../../Bazlama.Web.Component/next/packages")

export const alias = {
  "@bazlama/core": `${components}/core/src/index.ts`,
  "@bazlama/headless": `${components}/headless/src/index.ts`,
  "@bazlama/icons": `${components}/icons/src/index.ts`,
  "@bazlama/router": `${components}/router/src/index.ts`,
  "@bazlama/themes/builder": `${components}/themes/src/builder/index.ts`,
  "@bazlama/themes.css": `${components}/themes/src/index.css`,
  "@bazlama/ui.css": `${components}/ui/src/index.css`,
}

/** Bazlama.Host listens here in development (src/Bazlama.Host/Properties/launchSettings.json). */
const HOST = "http://localhost:5400"

export default defineConfig({
  resolve: { alias },
  server: {
    port: 5401,
    strictPort: true,
    fs: { allow: [r("."), components] },
    proxy: { "/api": HOST },
  },
  // The host serves the built UI from its wwwroot.
  build: {
    outDir: r("../src/Bazlama.Host/wwwroot"),
    emptyOutDir: true,
    // Monaco (the Development editor) is one ~4 MB chunk, loaded only there.
    chunkSizeWarningLimit: 4500,
    // The platform, and a draft's preview in a tab of its own.
    rollupOptions: { input: { main: r("index.html"), preview: r("preview.html") } },
  },
  test: { environment: "jsdom" },
})
