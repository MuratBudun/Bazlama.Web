/*
 * Performance run of the web UI in a real Chrome (headless, DevTools protocol):
 * page loads, page renders in Runtime, typing, the Development workbench, memory and leaks.
 *
 *   BASE=http://127.0.0.1:5420 PERF_USER=admin PERF_PASSWORD=… node perf/app.mjs [--sections=…] [--throttle=4] [--only=…] [--identity] [--json=out.json]
 *
 * Needs the data of perf/seed.mjs. Times are medians in milliseconds:
 *   painted  from the action to the first frame after the UI reached its state (what the user waits)
 *   api      of that, time inside /api requests (server + network)
 *   script   main-thread JavaScript, style+layout: main-thread rendering work (CPU time)
 */
import { writeFile } from "node:fs/promises"
import { launch, median, PAGE_HELPERS, round } from "./cdp.mjs"

const BASE = process.env.BASE ?? "http://127.0.0.1:5420"
const USER = process.env.PERF_USER ?? "admin"
const PASSWORD = process.env.PERF_PASSWORD
if (!PASSWORD) throw new Error("PERF_PASSWORD gerekli.")
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1]
const THROTTLE = Number(arg("throttle") ?? 1)
const REPEAT = Number(arg("repeat") ?? 7)
/** --sections=loads,actions,typing,dev,memory,leaks,css (default: all but css) */
const SECTIONS = (arg("sections") ?? "loads,actions,typing,dev,memory,leaks").split(",")
const on = (section) => SECTIONS.includes(section)

const b = await launch()
const results = { chrome: b.version, base: BASE, throttle: THROTTLE, loads: [], actions: [], typing: null, memory: [], leaks: [] }
const log = (...a) => console.log(...a)

const js = (v) => JSON.stringify(v)
/** Main-thread CPU time between two metric readings, in ms. */
const cpu = (m0, m1) => ({
  script: (m1.ScriptDuration - m0.ScriptDuration) * 1000,
  style: (m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000,
  layout: (m1.LayoutDuration - m0.LayoutDuration) * 1000,
})
const pad = (v, n = 6) => String(v).padStart(n)
const ev = async (code) => {
  try {
    return await b.evaluate(`(async () => { ${code} })()`)
  } catch (e) {
    // What the page looks like when a step does not get where it should.
    const state = await b.evaluate(`({ hash: location.hash, title: document.title, h1: [...document.querySelectorAll('h1')].map(h => h.textContent.trim()).join(' | '), rows: __perf.rows(), dialog: document.querySelector('dialog[open]')?.textContent.replace(/\s+/g, ' ').slice(0, 200) ?? null, alerts: [...document.querySelectorAll('bz-alert')].map(a => a.textContent.trim().slice(0, 120)) })`).catch(() => null)
    console.error("sayfa durumu:", JSON.stringify(state, null, 2))
    throw e
  }
}
const until = (test) => ev(`await __perf.until(() => ${test}); await __perf.frame()`)
/*
 * Chrome drops navigations beyond ~200 in 10 s (flood protection), and the router issues two
 * per route change (it cancels, prepares the page, then re-issues). So every step that
 * navigates is followed by a short pause; the pauses are outside the measured times.
 */
const PAUSE = 150
const go = async (hash, test) => {
  await ev(`__perf.go(${js(hash)})`)
  await until(test)
  await new Promise((r) => setTimeout(r, PAUSE))
}

try {
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS })
  await b.navigate(`${BASE}/`)
  const status = await ev(`return (await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bazlama-Request': '1' }, body: ${js(JSON.stringify({ userName: USER, password: PASSWORD }))} })).status`)
  if (status !== 200) throw new Error(`giriş başarısız: ${status}`)
  if (THROTTLE > 1) await b.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE })
  // --identity: ask for uncompressed files (what compression costs or brings on this link).
  if (process.argv.includes("--identity")) await b.send("Network.setExtraHTTPHeaders", { headers: { "Accept-Encoding": "identity" } })

  const orders = await ev(`const r = await (await fetch('/api/runtime/data/siparis/siparis?q=S-&sort=siparis_no&take=10')).json(); return Object.fromEntries(r.items.map(o => [o.siparis_no, o.id]))`)
  const year = Object.keys(orders)[0].split("-")[1]
  const BIG = orders[`S-${year}-0001`]
  const MEDIUM = orders[`S-${year}-0002`]
  const SMALL = orders[`S-${year}-0005`] // 7 lines
  if (!BIG || !MEDIUM || !SMALL) throw new Error("Veri yok: önce perf/seed.mjs çalıştırın.")

  const HOME = `__perf.visible(document.querySelector('.rt-home .app-card'))`
  const APP_START = `__perf.visible(document.querySelector('.rt-page .cards .card-link'))`
  const LIST = (n = 50) => `!document.querySelector('.rt-page form.record-form') && __perf.rows(document.querySelector('.rt-page')) >= ${n} && !document.querySelector('.rt-page bz-data-grid[loading]')`
  const RECORD = (lines) => `document.querySelector('.rt-page form.record-form bz-input') && __perf.rows(document.querySelector('.rt-page')) >= ${lines}`
  const record = (id) => `/apps/siparis/siparis/${id}?list=siparis`
  const WB = `document.querySelector('bazlama-workbench bz-tree [data-id]')`
  const editorIn = (id) => `document.querySelector('bz-tab-panel[value=${js(id)}] .monaco-editor .view-line')`
  const fromList = () => go("/apps/siparis/siparis?list=siparis", LIST(50))
  const wait = (test) => `await __perf.until(() => ${test}); await __perf.frame(); await new Promise(r => setTimeout(r, ${PAUSE}));`

  // ── Page loads ─────────────────────────────────────────────────────────
  const load = async (name, hash, test, { cache }) => {
    const runs = []
    for (let i = 0; i < 5; i++) {
      await b.send("Network.setCacheDisabled", { cacheDisabled: !cache })
      await b.navigate("about:blank")
      const m0 = await b.metrics()
      await b.navigate(`${BASE}/?run=${Date.now()}#${hash}`)
      const r = await ev(`
        const ready = await __perf.until(() => ${test})
        const painted = await __perf.frame()
        await new Promise(r => setTimeout(r, 100)) // paint entries arrive after the frame
        const res = performance.getEntriesByType('resource')
        const nav = performance.getEntriesByType('navigation')[0]
        const fcp = performance.getEntriesByType('paint').find(p => p.name === 'first-contentful-paint')?.startTime ?? null
        const assets = res.filter(e => !e.name.includes('/api/'))
        return {
          painted, fcp,
          requests: res.length + 1,
          transferKB: (assets.reduce((s, e) => s + e.transferSize, nav.transferSize)) / 1024,
          jsKB: assets.filter(e => e.name.endsWith('.js')).reduce((s, e) => s + e.decodedBodySize, 0) / 1024,
          api: res.filter(e => e.name.includes('/api/')).reduce((s, e) => s + e.duration, 0),
        }`)
      const m1 = await b.metrics()
      runs.push({ ...r, ...cpu(m0, m1) })
    }
    const row = { name, ...Object.fromEntries(Object.keys(runs[0]).map((k) => [k, round(median(runs.map((r) => r[k] ?? 0)))])) }
    results.loads.push(row)
    log(`yükleme  ${name.padEnd(46)} painted ${pad(row.painted, 7)}  fcp ${pad(row.fcp)}  script ${pad(row.script)}  stil ${pad(row.style)}  yerleşim ${pad(row.layout)}  api ${pad(row.api)}  ${row.requests} istek  ${row.transferKB} KB`)
  }
  if (on("loads")) {
  await load("Ana sayfa, soğuk (önbellek yok)", "/", HOME, { cache: false })
  await load("Ana sayfa, sıcak (önbellekten)", "/", HOME, { cache: true })
  await load("Doğrudan liste linki, sıcak (50 satır)", "/apps/siparis/musteri?list=musteri", LIST(50), { cache: true })
  await load(`Doğrudan kayıt linki, sıcak (400 kalem)`, record(BIG), RECORD(10), { cache: true })
  await b.send("Network.setCacheDisabled", { cacheDisabled: false })
  }

  // ── Actions inside the running app ─────────────────────────────────────
  await b.navigate(`${BASE}/?run=actions#/`)
  await until(HOME)
  await ev(`performance.setResourceTimingBufferSize(20000)`)

  /** setup → (measure) action → until test; the median of REPEAT runs after one warm-up. */
  const ONLY = arg("only")
  const action = async (name, { setup, act, test, repeat = REPEAT }) => {
    if (ONLY && !ONLY.split(",").some((t) => name.includes(t))) return
    const runs = []
    for (let i = 0; i < repeat + 1; i++) {
      if (setup) await setup()
      await ev(`performance.clearResourceTimings(); await new Promise(r => setTimeout(r, ${PAUSE})); await __perf.frame()`)
      const m0 = await b.metrics()
      const r = await ev(`
        const t0 = performance.now()
        const r = await __perf.time(async () => { ${act} }, () => ${test})
        r.api = performance.getEntriesByType('resource').filter(e => e.name.includes('/api/')).reduce((s, e) => s + e.duration, 0)
        return r`)
      const m1 = await b.metrics()
      if (i === 0) continue // warm-up (lazy chunks, definition cache, JIT)
      runs.push({ painted: r.painted, api: r.api, ...cpu(m0, m1) })
    }
    const row = { name, ...Object.fromEntries(Object.keys(runs[0]).map((k) => [k, round(median(runs.map((r) => r[k])))])) }
    row.client = round(Math.max(0, row.painted - row.api))
    results.actions.push(row)
    log(`eylem    ${name.padEnd(46)} painted ${pad(row.painted, 7)}  api ${pad(row.api)}  script ${pad(row.script)}  stil ${pad(row.style)}  yerleşim ${pad(row.layout)}`)
  }
  const closeApp = async () => {
    await ev(`const t = document.querySelector('.rt-tabs bz-tabs'); if (t.querySelector('bz-tab[value="siparis"]')) { await t.close('siparis'); await __perf.until(() => !t.querySelector('bz-tab[value="siparis"]')) } await __perf.frame()`)
    await until(HOME)
  }

  if (on("actions")) {
  await action("Karttan uygulama sekmesi açma", { setup: closeApp, act: `document.querySelector('a.app-card').click()`, test: APP_START })
  await action("Menüden liste (Müşteriler, 50 satır)", { setup: () => go("/apps/siparis", APP_START), act: `__perf.go('/apps/siparis/musteri?list=musteri')`, test: LIST(50) })
  await action("Listeden listeye (Siparişler, 50 satır)", { setup: () => go("/apps/siparis/musteri?list=musteri", LIST(50)), act: `__perf.go('/apps/siparis/siparis?list=siparis')`, test: LIST(50) })
  await action("Kayıt formu (7 kalem)", { setup: fromList, act: `__perf.go(${js(record(SMALL))})`, test: RECORD(7) })
  await action("Kayıt formu (120 kalem, tam çizim)", { setup: fromList, act: `__perf.go(${js(record(MEDIUM))})`, test: RECORD(120) })
  await action("Kayıt formu (400 kalem, sanal kaydırma)", { setup: fromList, act: `__perf.go(${js(record(BIG))})`, test: RECORD(10) })
  await action("Kayıttan listeye dönüş", { setup: () => go(record(SMALL), RECORD(7)), act: `__perf.go('/apps/siparis/siparis?list=siparis')`, test: LIST(50) })
  await action("Sekme: uygulama → ana sayfa", { setup: fromList, act: `document.querySelector('.rt-tabs bz-tab[value="__home"]').click()`, test: HOME })
  await action("Sekme: ana sayfa → uygulama (canlı içerik)", { setup: async () => { await fromList(); await go("/", HOME) }, act: `document.querySelector('.rt-tabs bz-tab[value="siparis"]').click()`, test: `__perf.visible(document.querySelector('.rt-page bz-data-grid'))` })
  await action("Liste sıralama (sunucuda, 50 satır)", {
    setup: () => go("/apps/siparis/musteri?list=musteri", LIST(50)),
    act: `window.__first = document.querySelector('.rt-page bz-data-grid [data-part="body"] [data-part="row"]').textContent; document.querySelector('.rt-page th[data-key="sehir"] [data-part="header"]').click()`,
    test: `!document.querySelector('.rt-page bz-data-grid[loading]') && document.querySelector('.rt-page bz-data-grid [data-part="body"] [data-part="row"]').textContent !== window.__first`,
  })
  await action("Kalem düzenleme diyaloğu açma", {
    setup: async () => {
      await ev(`document.querySelector('dialog[open]')?.closest('bz-dialog')?.close?.(); await __perf.frame()`)
      await go("/apps/siparis/musteri?list=musteri", LIST(50))
      await go(record(SMALL), RECORD(7))
    },
    act: `document.querySelector('.rt-page section bz-data-grid [data-part="body"] [data-part="row"]').click()`,
    test: `document.querySelector('dialog[open] bz-input')`,
  })
  await ev(`for (const d of document.querySelectorAll('dialog[open]')) d.closest('bz-dialog')?.close?.(); await __perf.frame()`)
  await action("Alan değişimi: Yönetim › Kullanıcılar", { setup: () => go("/", HOME), act: `__perf.go('/management/users')`, test: `__perf.rows() >= 1` })
  await action("Alan değişimi: Uygulamalar (ana sayfa)", { setup: () => go("/management/users", `__perf.rows() >= 1`), act: `__perf.go('/')`, test: HOME })
  }

  // ── Typing ─────────────────────────────────────────────────────────────
  if (on("typing")) {
    await go("/apps/siparis/siparis?list=siparis", LIST(50))
    await go(record(MEDIUM), RECORD(120))
    await ev(`const i = document.querySelector('.rt-page form.record-form bz-textarea textarea, .rt-page form.record-form textarea'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); await __perf.frame()`)
    const CHARS = 150
    const m0 = await b.metrics()
    const t0 = Date.now()
    for (let i = 0; i < CHARS; i++) await b.send("Input.insertText", { text: "abcçdefgğhıi jklmnoöprsştuüvyz"[i % 30] })
    await ev(`await __perf.frame()`)
    const m1 = await b.metrics()
    const typed = await ev(`return document.activeElement.value.length`)
    results.typing = {
      chars: CHARS,
      typed,
      scriptPerKey: round(cpu(m0, m1).script / CHARS, 3),
      stylePerKey: round(cpu(m0, m1).style / CHARS, 3),
      layoutPerKey: round(cpu(m0, m1).layout / CHARS, 3),
      taskPerKey: round(((m1.TaskDuration - m0.TaskDuration) * 1000) / CHARS, 3),
      layoutsPerKey: round((m1.LayoutCount - m0.LayoutCount) / CHARS, 2),
      wallPerKey: round((Date.now() - t0) / CHARS, 2),
    }
    log(`yazma    120 kalemli formda ${CHARS} tuş: tuş başına script ${results.typing.scriptPerKey} ms, stil ${results.typing.stylePerKey} ms, yerleşim ${results.typing.layoutPerKey} ms, ana iş parçacığı toplam ${results.typing.taskPerKey} ms`)
    await ev(`window.onbeforeunload = null`)
  }

  // ── Development ────────────────────────────────────────────────────────
  // A fresh page: the workbench and Monaco are lazy chunks (HTTP cache warm, as on a second visit).
  const once = async (name, act, test) => {
    const m0 = await b.metrics()
    const r = await ev(`return await __perf.time(async () => { ${act} }, () => ${test})`)
    const m1 = await b.metrics()
    const c = cpu(m0, m1)
    const row = { name, painted: round(r.painted), script: round(c.script), style: round(c.style), layout: round(c.layout) }
    results.actions.push(row)
    log(`geliştir ${name.padEnd(46)} painted ${pad(row.painted, 7)}  script ${pad(row.script)}  stil ${pad(row.style)}  yerleşim ${pad(row.layout)}`)
  }
  if (on("dev")) {
  await b.navigate(`${BASE}/?run=dev#/`)
  await until(HOME)
  await once("Geliştirme: çalışma alanını açma (ilk)", `__perf.go('/development/apps/siparis')`, WB)
  const memWorkbench = await b.memory()
  await once("C# dosyası açma (ilk: Monaco yüklenir)", `document.querySelector('bazlama-workbench').open('file:Siparis/SiparisEvents.cs')`, editorIn("file:Siparis/SiparisEvents.cs"))
  await once("C# dosyası açma (ikinci dosya)", `document.querySelector('bazlama-workbench').open('file:Siparis/KalemEvents.cs')`, editorIn("file:Siparis/KalemEvents.cs"))
  await once("Entity tasarımcısı sekmesi açma", `document.querySelector('bazlama-workbench').open('entity:siparis')`, `document.querySelector('bz-tab-panel[value="entity:siparis"] bazlama-entity-editor bz-input')`)
  await once("Tasarım → Kod görünümü (JSON, ilk)", `document.querySelector('bz-tab-panel[value="entity:siparis"] .dual-tab:nth-child(2)').click()`, editorIn("entity:siparis"))
  await once("Form tasarımcısı sekmesi açma", `document.querySelector('bazlama-workbench').open('form:siparis')`, `document.querySelector('bz-tab-panel[value="form:siparis"] bazlama-form-designer')`)
  const memMonaco = await b.memory()
  results.memory.push({ name: "Geliştirme: çalışma alanı (Monaco'dan önce)", heapMB: round(memWorkbench.heapMB, 2), nodes: memWorkbench.nodes, listeners: memWorkbench.listeners })
  results.memory.push({ name: "Geliştirme: Monaco + 2 C# + JSON + tasarımcılar", heapMB: round(memMonaco.heapMB, 2), nodes: memMonaco.nodes, listeners: memMonaco.listeners })
  log(`bellek   Geliştirme: çalışma alanı ${round(memWorkbench.heapMB, 2)} MB → Monaco ve sekmelerle ${round(memMonaco.heapMB, 2)} MB`)
  }

  // ── Memory ─────────────────────────────────────────────────────────────
  const snap = async (name) => {
    const m = await b.memory()
    const dom = await ev(`return document.querySelectorAll('*').length`)
    const row = { name, heapMB: round(m.heapMB, 2), domElements: dom, nodes: m.nodes, listeners: m.listeners }
    results.memory.push(row)
    log(`bellek   ${name.padEnd(46)} heap ${String(row.heapMB).padStart(6)} MB  sayfadaki öğe ${String(dom).padStart(5)}  canlı düğüm ${String(m.nodes).padStart(6)}  dinleyici ${String(m.listeners).padStart(5)}`)
    return m
  }
  if (on("memory")) {
  await b.navigate(`${BASE}/?run=mem#/`)
  await until(HOME)
  await snap("Ana sayfa (kartlar)")
  await go("/apps/siparis/musteri?list=musteri", LIST(50))
  await snap("Uygulama sekmesi + liste (50 satır)")
  await go(record(SMALL), RECORD(7))
  await snap("Kayıt formu (7 kalem)")
  await go("/apps/siparis/siparis?list=siparis", LIST(50))
  await go(record(MEDIUM), RECORD(120))
  await snap("Kayıt formu (120 kalem, tam çizim)")
  await go("/apps/siparis/siparis?list=siparis", LIST(50))
  await go(record(BIG), RECORD(10))
  await snap("Kayıt formu (400 kalem, sanal kaydırma)")
  }

  // ── Leaks: the same cycle many times; what stays after a full GC ───────
  const leak = async (name, cycles, prepare, body) => {
    await prepare()
    const loop = (n) => ev(`for (let i = 0; i < ${n}; i++) { ${body} }`)
    await loop(5) // warm-up: caches, lazily created singletons
    // Two batches: a leak grows the same in both; caches and code warming fade in the second.
    const start = await b.memory()
    await loop(cycles)
    const middle = await b.memory()
    await loop(cycles)
    const end = await b.memory()
    const row = {
      name,
      cycles,
      heapMB: [round(start.heapMB, 2), round(middle.heapMB, 2), round(end.heapMB, 2)],
      firstKBPerCycle: round(((middle.heapMB - start.heapMB) * 1024) / cycles, 2),
      secondKBPerCycle: round(((end.heapMB - middle.heapMB) * 1024) / cycles, 2),
      nodesPerCycle: round((end.nodes - start.nodes) / (2 * cycles), 2),
      listenersPerCycle: round((end.listeners - start.listeners) / (2 * cycles), 2),
    }
    results.leaks.push(row)
    log(`sızıntı  ${name.padEnd(40)} 2×${cycles} döngü: heap ${row.heapMB.join(" → ")} MB  (${row.firstKBPerCycle} sonra ${row.secondKBPerCycle} KB/döngü)  düğüm ${row.nodesPerCycle}/döngü  dinleyici ${row.listenersPerCycle}/döngü`)
  }
  if (on("leaks")) {
  await b.navigate(`${BASE}/?run=leaks#/`)
  await until(HOME)
  await leak("Liste ↔ kayıt formu", 40, () => go("/apps/siparis/siparis?list=siparis", LIST(50)),
    `__perf.go(${js(record(SMALL))}); ${wait(RECORD(7))} __perf.go('/apps/siparis/siparis?list=siparis'); ${wait(LIST(50))}`)
  await leak("Liste ↔ 120 kalemli kayıt", 20, () => go("/apps/siparis/siparis?list=siparis", LIST(50)),
    `__perf.go(${js(record(MEDIUM))}); ${wait(RECORD(120))} __perf.go('/apps/siparis/siparis?list=siparis'); ${wait(LIST(50))}`)
  await leak("Uygulama sekmesi aç / kapat", 30, () => go("/", HOME),
    `document.querySelector('a.app-card').click(); ${wait(APP_START)} await document.querySelector('.rt-tabs bz-tabs').close('siparis'); ${wait(`!document.querySelector('.rt-tabs bz-tab[value="siparis"]') && ${HOME}`)}`)
  await leak("Sekme geçişi ana sayfa ↔ uygulama", 50, () => go("/apps/siparis/musteri?list=musteri", LIST(50)),
    `document.querySelector('.rt-tabs bz-tab[value="__home"]').click(); ${wait(HOME)} document.querySelector('.rt-tabs bz-tab[value="siparis"]').click(); ${wait(`__perf.visible(document.querySelector('.rt-page bz-data-grid'))`)}`)
  await leak("Diyalog aç / kapat (kalem formu)", 40, async () => { await go("/apps/siparis/siparis?list=siparis", LIST(50)); await go(record(SMALL), RECORD(7)) },
    `document.querySelector('.rt-page section bz-data-grid [data-part="body"] [data-part="row"]').click(); ${wait(`document.querySelector('dialog[open] bz-input')`)}
     document.querySelector('dialog[open]').closest('bz-dialog').close(); ${wait(`!document.querySelector('dialog[open]')`)}`)
  await leak("Alan değişimi Uygulamalar ↔ Yönetim", 20, () => go("/", HOME),
    `__perf.go('/management/users'); ${wait(`__perf.rows() >= 1`)} __perf.go('/'); ${wait(HOME)}`)
  await leak("Geliştirme: C# sekmesi aç / kapat", 20, async () => { await go("/development/apps/siparis", WB); await ev(`document.querySelector('bazlama-workbench').open('file:Siparis/SiparisEvents.cs'); ${wait(editorIn("file:Siparis/SiparisEvents.cs"))}`) },
    `const w = document.querySelector('bazlama-workbench'); w.close('file:Siparis/SiparisEvents.cs'); ${wait(`!document.querySelector('bz-tab-panel[value="file:Siparis/SiparisEvents.cs"]')`)} w.open('file:Siparis/SiparisEvents.cs'); ${wait(editorIn("file:Siparis/SiparisEvents.cs"))}`)
  await leak("Geliştirme'ye gir / çık", 10, () => go("/", HOME),
    `__perf.go('/development/apps/siparis'); ${wait(WB)} __perf.go('/'); ${wait(HOME)}`)
  }

  // ── Where the style time goes (CSS selectors), on the heaviest page ────
  if (on("css")) {
    await b.navigate(`${BASE}/?run=css#/`)
    await until(HOME)
    await fromList()
    const trace = async (name, act, test) => {
      const stats = await b.selectorStats(() => ev(`await __perf.time(async () => { ${act} }, () => ${test})`))
      results.css = results.css ?? []
      results.css.push({ name, totals: Object.fromEntries(Object.entries(stats.totals).map(([k, v]) => [k, round(v)])), selectors: stats.selectors.slice(0, 15).map((x) => ({ ...x, ms: round(x.ms, 2) })) })
      log(`css      ${name}: stil ${round(stats.totals.recalcStyle)} ms, yerleşim ${round(stats.totals.layout)} ms, boyama ${round(stats.totals.paint)} ms, script ${round(stats.totals.script)} ms`)
      for (const x of stats.selectors.slice(0, 12)) log(`         ${pad(round(x.ms, 2), 8)} ms  ${pad(x.attempts, 7)} deneme  ${pad(x.matches, 6)} eşleşme  ${x.selector.slice(0, 150)}`)
    }
    await trace("Kayıt formu (400 kalem)", `__perf.go(${js(record(BIG))})`, RECORD(10))
    await fromList()
    await trace("Liste (Müşteriler, 50 satır)", `__perf.go('/apps/siparis/musteri?list=musteri')`, LIST(50))
  }

  if (arg("json")) await writeFile(arg("json"), JSON.stringify(results, null, 2))
} finally {
  await b.close()
}
