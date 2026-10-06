// @ts-nocheck — the benchmark page is not part of the app's type check (no React types installed).
import { createElement as h, memo, useState } from "react"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"

/*
 * The same table and components with React 19 (production build), written the way
 * js-framework-benchmark's keyed React implementation is: one state object, a memoized row
 * component, immutable updates. flushSync makes each operation commit at once, so it is timed
 * like the others.
 */

export function table(host: HTMLElement, newRow: () => { id: number; label: string }) {
  let setState: (update: (s: State) => State) => void = () => {}
  let root: ReturnType<typeof createRoot> | null = null
  interface State {
    rows: { id: number; label: string }[]
    selected: number
  }
  const build = (n: number) => Array.from({ length: n }, newRow)

  const Row = memo(function Row({ item, selected }: { item: State["rows"][number]; selected: boolean }) {
    return h(
      "tr",
      { className: selected ? "danger" : "" },
      h("td", { className: "id" }, item.id),
      h("td", null, h("a", { onClick: () => setState((s) => ({ ...s, selected: item.id })) }, item.label)),
      h("td", null, h("a", { className: "remove", onClick: () => setState((s) => ({ ...s, rows: s.rows.filter((r) => r !== item) })) }, "x")),
      h("td", null),
    )
  })
  function App() {
    const [state, set] = useState<State>({ rows: [], selected: 0 })
    setState = set
    return h("table", { className: "bench" }, h("tbody", null, state.rows.map((r) => h(Row, { key: r.id, item: r, selected: state.selected === r.id }))))
  }
  const update = (fn: (s: State) => State) => flushSync(() => setState(fn))

  return {
    mount() {
      root = createRoot(host)
      flushSync(() => root!.render(h(App)))
    },
    unmount() {
      root?.unmount()
      root = null
      host.replaceChildren()
    },
    create: (n: number) => update((s) => ({ ...s, rows: build(n) })),
    append: (n: number) => update((s) => ({ ...s, rows: [...s.rows, ...build(n)] })),
    update: () => update((s) => ({ ...s, rows: s.rows.map((r, i) => (i % 10 === 0 ? { ...r, label: `${r.label} !!!` } : r)) })),
    select: (index: number) => update((s) => ({ ...s, selected: s.rows[index].id })),
    swap: () =>
      update((s) => {
        const rows = [...s.rows]
        ;[rows[1], rows[rows.length - 2]] = [rows[rows.length - 2], rows[1]]
        return { ...s, rows }
      }),
    remove: (index: number) => update((s) => ({ ...s, rows: s.rows.filter((_, i) => i !== index) })),
    clear: () => update((s) => ({ ...s, rows: [] })),
    flush() {},
  }
}

/*
 * Components: what a React app writes by hand for the same job: native elements with state
 * (controlled inputs). No component library, so no styling logic, validation or form
 * association as the bz-* elements have: this is React's own cost.
 */
const Button = ({ i }: { i: number }) => {
  const [count, setCount] = useState(0)
  return h("button", { type: "button", className: "v-btn", onClick: () => setCount(count + 1) }, `Kaydet ${i}`)
}
const Input = ({ i }: { i: number }) => {
  const [value, setValue] = useState(`değer ${i}`)
  return h("label", { className: "v-field" }, h("span", null, `Alan ${i}`), h("input", { value, onChange: (e) => setValue(e.target.value) }))
}
const Checkbox = ({ i }: { i: number }) => {
  const [checked, setChecked] = useState(false)
  return h("label", { className: "v-check" }, h("input", { type: "checkbox", checked, onChange: (e) => setChecked(e.target.checked) }), ` Seçenek ${i}`)
}
const Combobox = ({ i }: { i: number }) => {
  const [value, setValue] = useState("b")
  return h(
    "label",
    { className: "v-field" },
    h("span", null, `Durum ${i}`),
    h("select", { value, onChange: (e) => setValue(e.target.value) }, h("option", { value: "a" }, "Taslak"), h("option", { value: "b" }, "Onaylandı"), h("option", { value: "c" }, "Sevk edildi"), h("option", { value: "d" }, "İptal")),
  )
}
const Badge = ({ i }: { i: number }) => h("span", { className: "v-badge" }, i)
const KINDS = { button: Button, input: Input, checkbox: Checkbox, combobox: Combobox, badge: Badge }

/** Mounts `count` components of a kind; returns the function that removes them. */
export function components(host: HTMLElement, kind: keyof typeof KINDS, count: number) {
  const root = createRoot(host)
  const Kind = KINDS[kind]
  flushSync(() => root.render(h("div", { className: "grid-of" }, Array.from({ length: count }, (_, i) => h(Kind, { key: i, i })))))
  return () => {
    root.unmount()
    host.replaceChildren()
  }
}
