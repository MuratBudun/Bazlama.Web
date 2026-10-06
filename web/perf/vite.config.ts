import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { defineConfig, type Plugin } from "vite"
import { alias } from "../vite.config"

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/*
 * Builds the component benchmark page (perf/bench) on its own: it is not part of the app.
 * Serve perf/dist from any static host, e.g. copy it into an installation's wwwroot/bench.
 *
 * React and Mantine are compared only on request and are in no package.json: install them for
 * a run with `npm install --no-save react react-dom @mantine/core @mantine/hooks` (see
 * README.md). Without them the page builds all the same; their two implementations are then
 * left out and the driver measures vanilla and bazlama only.
 */
const require = createRequire(import.meta.url)
const installed = (name: string) => {
  try {
    require.resolve(name)
    return true
  } catch {
    return false
  }
}
const FRAMEWORKS: Record<string, string[]> = {
  "react-impl": ["react", "react-dom"],
  "mantine-impl": ["react", "react-dom", "@mantine/core", "@mantine/hooks"],
}
const optionalFrameworks = (): Plugin => ({
  name: "bazlama-perf-optional-frameworks",
  enforce: "pre",
  resolveId(source) {
    const name = source.split("/").pop() ?? ""
    const needs = FRAMEWORKS[name]
    if (needs && !needs.every(installed)) return `\0missing:${name}`
    return null
  },
  load(id) {
    return id.startsWith("\0missing:") ? "export const available = false" : null
  },
})

export default defineConfig({
  root: r("./bench"),
  base: "./",
  resolve: { alias },
  plugins: [optionalFrameworks()],
  build: { outDir: r("./dist"), emptyOutDir: true },
})
