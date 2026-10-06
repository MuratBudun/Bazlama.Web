import { computed, effect, flush, html, render, repeat, root, signal, type Signal } from "@bazlama/core"
import { defineIcons, type GridColumn } from "@bazlama/headless"
import * as icons from "@bazlama/icons"

/*
 * Micro-benchmarks of the component library in a real browser, next to the same work done with
 * plain DOM calls ("vanilla": the least a browser can do) and, on request, with React on bare
 * elements (react-impl.ts) and with Mantine, a React component library (mantine-impl.ts).
 * Those two are in no package.json: they are installed for a run (see README.md), and
 * without them their implementations are left out. Driven by perf/bench.mjs, which
 * calls window.bench.prepare(...) (not timed) and window.bench.run(...) (timed) and reads the
 * main-thread CPU time and the heap through the DevTools protocol.
 *
 * The table operations are those of js-framework-benchmark (keyed): create, replace, partial
 * update, select, swap, remove, append, clear.
 */

defineIcons(icons)
document.documentElement.dataset.theme = "modern"

const host = document.getElementById("app")!
const frame = () =>
  new Promise<number>((r) =>
    requestAnimationFrame(() => {
      const c = new MessageChannel()
      c.port1.onmessage = () => r(performance.now())
      c.port2.postMessage(0)
    }),
  )

// ── Data ─────────────────────────────────────────────────────────────────
const A = ["pretty", "large", "big", "small", "tall", "short", "long", "handsome", "plain", "quaint", "clean", "elegant", "easy", "angry", "crazy", "helpful", "mushy", "odd", "unsightly", "adorable"]
const C = ["red", "yellow", "blue", "green", "pink", "brown", "purple", "brown", "white", "black", "orange"]
const N = ["table", "chair", "house", "bbq", "desk", "car", "pony", "cookie", "sandwich", "burger", "pizza", "mouse", "keyboard"]
let seed = 1
const random = (max: number) => (seed = (seed * 16807) % 2147483647) % max
let nextId = 1
const label = () => `${A[random(A.length)]} ${C[random(C.length)]} ${N[random(N.length)]}`

// ── Table: bazlama (html + repeat + signals) ─────────────────────────────
interface Row {
  id: number
  label: Signal<string>
}
function bazlamaTable() {
  const rows = signal<Row[]>([])
  const selected = signal(0)
  const build = (n: number): Row[] => Array.from({ length: n }, () => ({ id: nextId++, label: signal(label()) }))
  let dispose = () => {}
  return {
    mount() {
      dispose = root((d) => {
        render(
          html`<table class="bench"><tbody>
            ${repeat(rows, (r) => r.id, (r) => html`<tr class=${() => (selected() === r.id ? "danger" : "")}>
              <td class="id">${r.id}</td>
              <td><a @click=${() => selected.set(r.id)}>${r.label}</a></td>
              <td><a class="remove" @click=${() => rows.set(rows().filter((x) => x !== r))}>x</a></td>
              <td></td>
            </tr>`)}
          </tbody></table>`,
          host,
        )
        return d
      })
    },
    unmount() {
      dispose()
      host.replaceChildren()
      rows.set([])
    },
    create: (n: number) => rows.set(build(n)),
    append: (n: number) => rows.set([...rows(), ...build(n)]),
    update() {
      const list = rows()
      for (let i = 0; i < list.length; i += 10) list[i].label.set(`${list[i].label()} !!!`)
    },
    select: (index: number) => selected.set(rows()[index].id),
    swap() {
      const list = [...rows()]
      ;[list[1], list[list.length - 2]] = [list[list.length - 2], list[1]]
      rows.set(list)
    },
    remove: (index: number) => rows.set(rows().filter((_, i) => i !== index)),
    clear: () => rows.set([]),
    flush,
  }
}

// ── Table: vanilla DOM ───────────────────────────────────────────────────
function vanillaTable() {
  let tbody: HTMLTableSectionElement
  let data: { id: number; label: string; tr: HTMLTableRowElement }[] = []
  let selected: HTMLTableRowElement | null = null
  const template = document.createElement("template")
  template.innerHTML = `<tr><td class="id"></td><td><a></a></td><td><a class="remove">x</a></td><td></td></tr>`
  const build = (n: number) => {
    const out = []
    for (let i = 0; i < n; i++) {
      const tr = (template.content.firstChild as HTMLTableRowElement).cloneNode(true) as HTMLTableRowElement
      const row = { id: nextId++, label: label(), tr }
      tr.firstChild!.textContent = String(row.id)
      tr.children[1].firstChild!.textContent = row.label
      out.push(row)
    }
    return out
  }
  const select = (tr: HTMLTableRowElement) => {
    if (selected) selected.className = ""
    selected = tr
    tr.className = "danger"
  }
  return {
    mount() {
      host.innerHTML = `<table class="bench"><tbody></tbody></table>`
      tbody = host.querySelector("tbody")!
      // One delegated listener (as vanilla implementations do).
      tbody.addEventListener("click", (e) => {
        const a = (e.target as Element).closest("a")
        const tr = a?.closest("tr") as HTMLTableRowElement | null
        if (!a || !tr) return
        if (a.className === "remove") {
          data = data.filter((r) => r.tr !== tr)
          tr.remove()
        } else select(tr)
      })
    },
    unmount() {
      host.replaceChildren()
      data = []
      selected = null
    },
    create(n: number) {
      tbody.textContent = ""
      data = build(n)
      const f = document.createDocumentFragment()
      for (const r of data) f.append(r.tr)
      tbody.append(f)
    },
    append(n: number) {
      const more = build(n)
      data = data.concat(more)
      const f = document.createDocumentFragment()
      for (const r of more) f.append(r.tr)
      tbody.append(f)
    },
    update() {
      for (let i = 0; i < data.length; i += 10) {
        data[i].label += " !!!"
        data[i].tr.children[1].firstChild!.textContent = data[i].label
      }
    },
    select: (index: number) => select(data[index].tr),
    swap() {
      const a = data[1]
      const b = data[data.length - 2]
      data[1] = b
      data[data.length - 2] = a
      tbody.insertBefore(b.tr, a.tr)
      tbody.insertBefore(a.tr, data[data.length - 1].tr)
    },
    remove(index: number) {
      data[index].tr.remove()
      data.splice(index, 1)
    },
    clear() {
      tbody.textContent = ""
      data = []
    },
    flush() {},
  }
}

/*
 * The driver measures each implementation in a page of its own (?impl=…), with only its own
 * code and stylesheet loaded: in one page they slow each other down (measured: the same
 * Bazlama code ran 20-45 % slower once React had run in the page, and every stylesheet adds
 * rules that all elements are matched against). React and Mantine are chunks of their own, so
 * their sizes show in the build output.
 */
const IMPL = new URLSearchParams(location.search).get("impl") ?? "bazlama"
const loaded = IMPL === "react" ? await import("./react-impl") : IMPL === "mantine" ? await import("./mantine-impl") : null
// Not installed: the build put a stub in its place (perf/vite.config.ts).
const framework = loaded && (loaded as { available?: boolean }).available !== false ? loaded : null
if (IMPL === "bazlama") await Promise.all([import("@bazlama/themes.css"), import("@bazlama/ui.css")])

type Table = ReturnType<typeof bazlamaTable>
const tables: Record<string, Table> = {
  bazlama: bazlamaTable(),
  vanilla: vanillaTable() as unknown as Table,
  ...(framework ? { [IMPL]: framework.table(host, () => ({ id: nextId++, label: label() })) as unknown as Table } : {}),
}
/** Each operation: what is there before (not timed) and the operation itself (timed). */
const TABLE_OPS: Record<string, { before: (t: Table) => void; run: (t: Table) => void }> = {
  "1.000 satır oluştur": { before: () => {}, run: (t) => t.create(1000) },
  "1.000 satırı yenileriyle değiştir": { before: (t) => t.create(1000), run: (t) => t.create(1000) },
  "her 10. satırı güncelle (1.000)": { before: (t) => t.create(1000), run: (t) => t.update() },
  "satır seç (1.000)": { before: (t) => (t.create(1000), t.flush(), t.select(3)), run: (t) => t.select(500) },
  "iki satırın yerini değiştir (1.000)": { before: (t) => t.create(1000), run: (t) => t.swap() },
  "bir satır sil (1.000)": { before: (t) => t.create(1000), run: (t) => t.remove(500) },
  "10.000 satır oluştur": { before: () => {}, run: (t) => t.create(10000) },
  "1.000 satıra 1.000 ekle": { before: (t) => t.create(1000), run: (t) => t.append(1000) },
  "1.000 satırı temizle": { before: (t) => t.create(1000), run: (t) => t.clear() },
}

// ── Components: N instances of one element ───────────────────────────────
const COMPONENTS: Record<string, { bazlama: (i: number) => unknown; vanilla: (i: number) => string }> = {
  button: { bazlama: (i) => html`<bz-button>Kaydet ${i}</bz-button>`, vanilla: (i) => `<button type="button" class="v-btn">Kaydet ${i}</button>` },
  input: { bazlama: (i) => html`<bz-input label=${`Alan ${i}`} value=${`değer ${i}`}></bz-input>`, vanilla: (i) => `<label class="v-field"><span>Alan ${i}</span><input value="değer ${i}"></label>` },
  checkbox: { bazlama: (i) => html`<bz-checkbox label=${`Seçenek ${i}`}></bz-checkbox>`, vanilla: (i) => `<label class="v-check"><input type="checkbox"> Seçenek ${i}</label>` },
  combobox: {
    bazlama: (i) => html`<bz-combobox label=${`Durum ${i}`} value="b"><bz-option value="a">Taslak</bz-option><bz-option value="b">Onaylandı</bz-option><bz-option value="c">Sevk edildi</bz-option><bz-option value="d">İptal</bz-option></bz-combobox>`,
    vanilla: (i) => `<label class="v-field"><span>Durum ${i}</span><select><option>Taslak</option><option selected>Onaylandı</option><option>Sevk edildi</option><option>İptal</option></select></label>`,
  },
  badge: { bazlama: (i) => html`<bz-badge variant="success">${i}</bz-badge>`, vanilla: (i) => `<span class="v-badge">${i}</span>` },
}
let componentDispose = () => {}
function mountComponents(impl: string, kind: string, count: number) {
  const c = COMPONENTS[kind]
  if (impl === "react" || impl === "mantine") componentDispose = framework!.components(host, kind as never, count)
  else if (impl === "vanilla") {
    let markup = ""
    for (let i = 0; i < count; i++) markup += c.vanilla(i)
    host.innerHTML = `<div class="grid-of">${markup}</div>`
    componentDispose = () => host.replaceChildren()
  } else {
    componentDispose = root((d) => {
      render(html`<div class="grid-of">${Array.from({ length: count }, (_, i) => c.bazlama(i))}</div>`, host)
      return () => {
        d()
        host.replaceChildren()
      }
    })
  }
}

// ── Data grid ────────────────────────────────────────────────────────────
interface GridRow {
  id: number
  no: string
  musteri: string
  sehir: string
  tarih: string
  durum: string
  miktar: number
  tutar: number
  not: string
}
const SEHIR = ["İstanbul", "Ankara", "İzmir", "Bursa", "Antalya", "Konya", "Adana"]
const gridRows = (n: number): GridRow[] =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    no: `S-2026-${String(i + 1).padStart(6, "0")}`,
    musteri: `${A[random(A.length)]} ${N[random(N.length)]} A.Ş.`,
    sehir: SEHIR[random(SEHIR.length)],
    tarih: `2026-${String(1 + random(12)).padStart(2, "0")}-${String(1 + random(28)).padStart(2, "0")}`,
    durum: ["Taslak", "Onaylandı", "Sevk edildi", "İptal"][random(4)],
    miktar: random(500),
    tutar: random(1000000) / 100,
    not: random(5) === 0 ? "Acil" : "",
  }))
const GRID_COLUMNS: GridColumn<GridRow>[] = [
  { key: "no", header: "Sipariş no", width: 150, sortable: true },
  { key: "musteri", header: "Müşteri", width: 220, flex: true, sortable: true },
  { key: "sehir", header: "Şehir", width: 120, sortable: true },
  { key: "tarih", header: "Tarih", width: 110, sortable: true },
  { key: "durum", header: "Durum", width: 120, sortable: true },
  { key: "miktar", header: "Miktar", width: 90, align: "end", sortable: true },
  { key: "tutar", header: "Tutar", width: 120, align: "end", sortable: true, format: (v) => (v as number).toLocaleString("tr-TR", { minimumFractionDigits: 2 }) },
  { key: "not", header: "Not", width: 120 },
]
const gridData = signal<GridRow[]>([])
const gridSort = signal<{ key: string; dir: "asc" | "desc" } | null>(null)
let gridDispose = () => {}
let pending: GridRow[] = []
const grid = {
  /** Builds the rows first: the timed part is only the grid's work. */
  data(n: number) {
    pending = gridRows(n)
  },
  mount(virtual: "auto" | "off" = "auto") {
    gridSort.set(null)
    gridData.set(pending)
    gridDispose = root((d) => {
      render(html`<div class="grid-box"><bz-data-grid label="Siparişler" striped virtual=${virtual} .columns=${GRID_COLUMNS} .rows=${gridData} .sort=${gridSort}></bz-data-grid></div>`, host)
      return () => {
        d()
        host.replaceChildren()
      }
    })
  },
  unmount() {
    gridDispose()
    gridDispose = () => {}
    gridData.set([])
    pending = []
  },
  sort: (key: string) => gridSort.set({ key, dir: gridSort()?.key === key && gridSort()?.dir === "asc" ? "desc" : "asc" }),
  replace: () => gridData.set(pending),
  rendered: () => host.querySelectorAll('bz-data-grid [data-part="body"] [data-part="row"]').length,
  /** Scrolls through the grid a step per frame; frame intervals in ms. */
  async scroll(frames: number, step: number) {
    const scroller = host.querySelector<HTMLElement>('bz-data-grid [data-part="scroller"]')!
    const times: number[] = []
    let last = await new Promise<number>((r) => requestAnimationFrame(r))
    for (let i = 0; i < frames; i++) {
      scroller.scrollTop += step
      const now = await new Promise<number>((r) => requestAnimationFrame(r))
      times.push(now - last)
      last = now
    }
    times.sort((a, b) => a - b)
    return { frames, median: times[Math.floor(frames / 2)], p95: times[Math.floor(frames * 0.95)], max: times[frames - 1], over20ms: times.filter((t) => t > 20).length, scrolled: scroller.scrollTop }
  },
}

// ── Reactivity core ──────────────────────────────────────────────────────
const SIGNAL_OPS: Record<string, () => number> = {
  /** 100.000 signals, each with a computed and an effect. */
  "100.000 signal + computed + effect oluştur": () =>
    root((dispose) => {
      let sum = 0
      const list: Signal<number>[] = []
      for (let i = 0; i < 100000; i++) {
        const s = signal(i)
        const c = computed(() => s() * 2)
        effect(() => {
          sum += c()
        })
        list.push(s)
      }
      flush()
      ;(window as unknown as { __signals: unknown }).__signals = { list, dispose }
      return sum
    }),
  "100.000 signal'i güncelle (her biri 1 effect)": () => {
    const { list } = (window as unknown as { __signals: { list: Signal<number>[] } }).__signals
    for (let i = 0; i < list.length; i++) list[i].set(i + 1)
    flush()
    return list.length
  },
  "1 signal → 10.000 effect, 100 güncelleme": () =>
    root((dispose) => {
      const s = signal(0)
      let runs = 0
      for (let i = 0; i < 10000; i++)
        effect(() => {
          s()
          runs++
        })
      flush()
      for (let i = 1; i <= 100; i++) {
        s.set(i)
        flush()
      }
      dispose()
      return runs
    }),
  "10 katmanlı computed zinciri, 100.000 güncelleme": () =>
    root((dispose) => {
      const s = signal(0)
      let c: () => number = s
      for (let i = 0; i < 10; i++) {
        const prev = c
        c = computed(() => prev() + 1)
      }
      let last = 0
      effect(() => {
        last = c()
      })
      flush()
      for (let i = 1; i <= 100000; i++) {
        s.set(i)
        flush()
      }
      dispose()
      return last
    }),
}

// ── Driver API ───────────────────────────────────────────────────────────
const timed = async (work: () => unknown) => {
  const t0 = performance.now()
  const value = work()
  const sync = performance.now() - t0
  const painted = (await frame()) - t0
  return { sync, painted, value }
}
const bench = {
  /** Whether this page's implementation (?impl=…) can be measured (React, Mantine: only when installed). */
  available: IMPL === "vanilla" || IMPL === "bazlama" || framework !== null,
  tableOps: Object.keys(TABLE_OPS),
  components: Object.keys(COMPONENTS),
  signalOps: Object.keys(SIGNAL_OPS),
  frame,
  async reset() {
    for (const t of Object.values(tables)) t.unmount()
    componentDispose()
    componentDispose = () => {}
    grid.unmount()
    const s = (window as unknown as { __signals?: { dispose: () => void } }).__signals
    s?.dispose()
    delete (window as unknown as { __signals?: unknown }).__signals
    host.replaceChildren()
    await frame()
  },
  async tablePrepare(impl: string, op: string) {
    const t = tables[impl]
    t.mount()
    TABLE_OPS[op].before(t)
    t.flush()
    await frame()
  },
  tableRun: (impl: string, op: string) =>
    timed(() => {
      const t = tables[impl]
      TABLE_OPS[op].run(t)
      t.flush()
    }),
  componentsMount: (impl: string, kind: string, count: number) => timed(() => (mountComponents(impl, kind, count), flush())),
  componentsUnmount: () => timed(() => (componentDispose(), (componentDispose = () => {}), flush())),
  gridData: (n: number) => grid.data(n),
  gridMount: (virtual: "auto" | "off" = "auto") => timed(() => (grid.mount(virtual), flush())),
  gridSort: (key: string) => timed(() => (grid.sort(key), flush())),
  gridReplace: () => timed(() => (grid.replace(), flush())),
  gridScroll: (frames: number, step: number) => grid.scroll(frames, step),
  gridRendered: () => grid.rendered(),
  signalRun: (op: string) => timed(() => SIGNAL_OPS[op]()),
  elements: () => host.querySelectorAll("*").length,
}
;(window as unknown as { bench: typeof bench }).bench = bench
document.documentElement.dataset.ready = "1"
