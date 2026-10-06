/*
 * Drives the component benchmark page (perf/bench, built with `npx vite build --config
 * perf/vite.config.ts` and served somewhere) in headless Chrome.
 *
 *   BENCH_URL=http://127.0.0.1:5420/bench/index.html node perf/bench.mjs [--throttle=4] [--json=out.json]
 *
 * Per operation, the median of RUNS runs:
 *   cpu  main-thread time (script + style + layout + paint work), from the DevTools metrics
 *   js   of that, the JavaScript of the operation itself (timed in the page)
 * "vanilla" is the same work with plain DOM calls, "react" with React on bare elements and
 * "mantine" with Mantine's components (both production builds, and only when they were
 * installed before the page was built: see README.md). Each runs in a page of its own.
 *
 *   --sections=table,components,grid,signals   (default: all)
 */
import { writeFile } from "node:fs/promises"
import { launch, median, round } from "./cdp.mjs"

const URL = process.env.BENCH_URL ?? "http://127.0.0.1:5420/bench/index.html"
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1]
const THROTTLE = Number(arg("throttle") ?? 1)
const RUNS = Number(arg("runs") ?? 10)
const SECTIONS = (arg("sections") ?? "table,components,grid,signals").split(",")
const on = (section) => SECTIONS.includes(section)
let IMPLS = (arg("impls") ?? "vanilla,bazlama,react,mantine").split(",")

const b = await launch()
const results = { chrome: b.version, throttle: THROTTLE, table: [], components: [], grid: [], signals: [] }
const js = (v) => JSON.stringify(v)
const call = (code) => b.evaluate(`(async () => { ${code} })()`)
const pad = (v, n = 8) => String(v).padStart(n)
const delta = (m0, m1) => ({
  cpu: (m1.TaskDuration - m0.TaskDuration) * 1000,
  script: (m1.ScriptDuration - m0.ScriptDuration) * 1000,
  style: (m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000,
  layout: (m1.LayoutDuration - m0.LayoutDuration) * 1000,
})
/** prepare (not timed) → run (timed), RUNS times after one warm-up; medians. */
async function measure(prepare, run, runs = RUNS) {
  const all = []
  for (let i = 0; i < runs + 1; i++) {
    await call(`await bench.reset()`)
    if (prepare) await call(prepare)
    await b.send("HeapProfiler.collectGarbage")
    await call(`await bench.frame()`)
    const m0 = await b.metrics()
    const r = await call(`return await ${run}`)
    const m1 = await b.metrics()
    if (i > 0) all.push({ ...delta(m0, m1), painted: r.painted, sync: r.sync })
  }
  return Object.fromEntries(Object.keys(all[0]).map((k) => [k, round(median(all.map((x) => x[k])), 2)]))
}

/** A page of its own for an implementation: libraries in one page change the speed of the others. */
let pages = 0
async function fresh(impl = "bazlama") {
  await b.send("Emulation.setCPUThrottlingRate", { rate: 1 })
  await b.navigate(`${URL}?impl=${impl}&page=${++pages}`)
  await call(`while (!document.documentElement.dataset.ready) await new Promise(r => setTimeout(r, 20))`)
  if (THROTTLE > 1) await b.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE })
}

try {
  await fresh()
  const info = await call(`return { tableOps: bench.tableOps, components: bench.components, signalOps: bench.signalOps }`)
  // React and Mantine are measured only when the page was built with them installed.
  const missing = []
  for (const impl of IMPLS) {
    await fresh(impl)
    if (!(await call(`return bench.available`))) missing.push(impl)
  }
  if (missing.length) {
    IMPLS = IMPLS.filter((i) => !missing.includes(i))
    console.log(`Ölçülmüyor (kurulu değil): ${missing.join(", ")}. Karşılaştırmak için README.md'deki "React ve Mantine" adımlarını izleyin.`)
  }
  results.impls = IMPLS

  // ── Table operations: vanilla, bazlama, react ──────────────────────────
  if (on("table")) {
  console.log(`\nTablo işlemleri: ana iş parçacığı ms (js ms)   ${IMPLS.map((i) => i.padStart(17)).join(" ")}`)
  const rows = Object.fromEntries(info.tableOps.map((op) => [op, { op }]))
  const memory = { 1000: { rows: 1000 }, 10000: { rows: 10000 } }
  for (const impl of IMPLS) {
    await fresh(impl)
    for (const op of info.tableOps) rows[op][impl] = await measure(`await bench.tablePrepare(${js(impl)}, ${js(op)})`, `bench.tableRun(${js(impl)}, ${js(op)})`, op.startsWith("10.000") ? 5 : RUNS)
    // Memory of 1.000 and 10.000 rows.
    for (const n of [1000, 10000]) {
      await call(`await bench.reset()`)
      const before = await b.memory()
      await call(`await bench.tablePrepare(${js(impl)}, "1.000 satır oluştur"); await bench.tableRun(${js(impl)}, ${js(n === 1000 ? "1.000 satır oluştur" : "10.000 satır oluştur")})`)
      const after = await b.memory()
      await call(`await bench.reset()`)
      const freed = await b.memory()
      memory[n][impl] = { heapKB: round((after.heapMB - before.heapMB) * 1024), perRowKB: round(((after.heapMB - before.heapMB) * 1024) / n, 2), leftKB: round((freed.heapMB - before.heapMB) * 1024), listeners: after.listeners - before.listeners }
    }
  }
  for (const op of info.tableOps) {
    const row = rows[op]
    results.table.push(row)
    console.log(`  ${op.padEnd(38)} ${IMPLS.map((i) => `${pad(row[i].cpu)} (${pad(row[i].sync, 6)})`).join(" ")}`)
  }
  for (const n of [1000, 10000]) {
    const row = memory[n]
    results.table.push({ memory: row })
    console.log(`  bellek, ${n} satır: ${IMPLS.map((i) => `${i} ${row[i].heapKB} KB (${row[i].perRowKB} KB/satır, ${row[i].listeners} dinleyici, kaldırınca kalan ${row[i].leftKB} KB)`).join(" · ")}`)
  }
  }

  // ── Components: 1.000 instances ────────────────────────────────────────
  if (on("components")) {
  console.log(`\n1.000 bileşen: ana iş parçacığı ms (js ms), bileşen başına bellek, öğe, dinleyici     ${IMPLS.join(" | ")}`)
  const countOf = (kind) => (kind === "combobox" ? 500 : 1000)
  const kinds = Object.fromEntries(info.components.map((kind) => [kind, { kind, count: countOf(kind) }]))
  for (const impl of IMPLS) {
    await fresh(impl)
    for (const kind of info.components) {
      const count = countOf(kind)
      const row = kinds[kind]
      const t = await measure(null, `bench.componentsMount(${js(impl)}, ${js(kind)}, ${count})`, 7)
      await call(`await bench.reset()`)
      const before = await b.memory()
      await call(`await bench.componentsMount(${js(impl)}, ${js(kind)}, ${count})`)
      const elements = await call(`return bench.elements()`)
      const after = await b.memory()
      await call(`await bench.componentsUnmount(); await bench.reset()`)
      const freed = await b.memory()
      row[impl] = { ...t, perMs: round(t.cpu / count, 3), kb: round(((after.heapMB - before.heapMB) * 1024) / count, 2), elements: round(elements / count, 1), listeners: round((after.listeners - before.listeners) / count, 1), leftKB: round((freed.heapMB - before.heapMB) * 1024) }
    }
  }
  for (const kind of info.components) {
    const row = kinds[kind]
    const count = row.count
    results.components.push(row)
    const f = (x) => `${pad(x.cpu)} ms (${pad(x.sync, 6)})  ${pad(x.kb, 5)} KB  ${pad(x.elements, 4)} öğe ${pad(x.listeners, 4)} dinl.`
    console.log(`  ${`${count} × ${kind}`.padEnd(16)} ${IMPLS.map((i) => f(row[i])).join("  | ")}   kaldırınca kalan KB: ${IMPLS.map((i) => `${i} ${row[i].leftKB}`).join(", ")}`)
  }
  }

  // ── Data grid ──────────────────────────────────────────────────────────
  if (on("grid")) {
  await fresh()
  console.log(`\nVeri ızgarası (8 sütun, 600 px)`)
  for (const [n, virtual] of [[100, "auto"], [1000, "auto"], [10000, "auto"], [100000, "auto"], [1000, "off"]]) {
    const prep = `bench.gridData(${n})`
    const mount = await measure(prep, `bench.gridMount(${js(virtual)})`, n >= 100000 ? 3 : 5)
    await call(`await bench.reset()`)
    const before = await b.memory()
    await call(`${prep}; await bench.gridMount(${js(virtual)})`)
    const rendered = await call(`return bench.gridRendered()`)
    const after = await b.memory()
    const m0 = await b.metrics()
    const scroll = await call(`return await bench.gridScroll(120, 240)`)
    const m1 = await b.metrics()
    const row = { rows: n, virtual, mount, rendered, heapMB: round(after.heapMB - before.heapMB, 2), scroll: { ...scroll, cpuPerFrame: round(delta(m0, m1).cpu / 120, 2), scriptPerFrame: round(delta(m0, m1).script / 120, 2) } }
    if (n >= 1000 && virtual === "auto") {
      // Client-side sort (a text and a number column), and replacing the rows.
      const sortOf = async (key) => {
        const runs = []
        for (let i = 0; i < 5; i++) {
          const a = await b.metrics()
          const r = await call(`return await bench.gridSort(${js(key)})`)
          runs.push({ ...delta(a, await b.metrics()), painted: r.painted })
        }
        return { cpu: round(median(runs.map((x) => x.cpu)), 1), script: round(median(runs.map((x) => x.script)), 1) }
      }
      row.sortText = await sortOf("musteri")
      row.sortNumber = await sortOf("tutar")
    }
    results.grid.push(row)
    console.log(`  ${`${n} satır${virtual === "off" ? " (sanal kapalı)" : ""}`.padEnd(28)} ilk çizim ${pad(mount.cpu)} ms (js ${pad(mount.sync, 6)})  DOM'da ${pad(rendered, 5)} satır  bellek ${pad(row.heapMB, 6)} MB  kaydırma: kare başına ${pad(row.scroll.cpuPerFrame, 5)} ms iş, kare aralığı medyan ${round(scroll.median, 1)} / p95 ${round(scroll.p95, 1)} ms, >20 ms: ${scroll.over20ms}/120${row.sortText ? `  sıralama metin ${row.sortText.cpu} ms, sayı ${row.sortNumber.cpu} ms` : ""}`)
  }
  }

  // ── Reactivity core ────────────────────────────────────────────────────
  if (on("signals")) {
  await fresh()
  console.log(`\nReaktivite çekirdeği (script ms)`)
  await call(`await bench.reset()`)
  for (const op of info.signalOps) {
    const runs = []
    const repeat = op.startsWith("100.000 signal") ? 1 : 5
    let heap = null
    for (let i = 0; i < repeat; i++) {
      const before = op.includes("oluştur") ? await b.memory() : null
      const r = await call(`return await bench.signalRun(${js(op)})`)
      if (before) heap = round(((await b.memory()).heapMB - before.heapMB) * 1024 / 100000, 3)
      runs.push(r.sync)
    }
    const row = { op, ms: round(median(runs), 1), heapKBPerUnit: heap }
    results.signals.push(row)
    console.log(`  ${op.padEnd(50)} ${pad(row.ms)} ms${heap !== null ? `   (signal+computed+effect başına ${heap} KB)` : ""}`)
  }
  }
  await call(`await bench.reset()`)

  if (arg("json")) await writeFile(arg("json"), JSON.stringify(results, null, 2))
} finally {
  await b.close()
}
