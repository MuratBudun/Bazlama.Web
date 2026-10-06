// @ts-nocheck — the benchmark page is not part of the app's type check (no React types installed).
import { createElement as h, memo, useState } from "react"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Badge, Button, Checkbox, MantineProvider, Select, Table, TextInput } from "@mantine/core"
import "@mantine/core/styles.css"

/*
 * The same table and components with Mantine (a React component library): what a React app
 * uses instead of bare elements, so the fair counterpart of the bz-* components (label, error
 * and description slots, styling, keyboard and ARIA are the library's). Same shape as
 * react-impl.ts; its stylesheet comes with this chunk only.
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
      Table.Tr,
      { className: selected ? "danger" : "" },
      h(Table.Td, { className: "id" }, item.id),
      h(Table.Td, null, h("a", { onClick: () => setState((s) => ({ ...s, selected: item.id })) }, item.label)),
      h(Table.Td, null, h("a", { className: "remove", onClick: () => setState((s) => ({ ...s, rows: s.rows.filter((r) => r !== item) })) }, "x")),
      h(Table.Td, null),
    )
  })
  function App() {
    const [state, set] = useState<State>({ rows: [], selected: 0 })
    setState = set
    return h(Table, { className: "bench" }, h(Table.Tbody, null, state.rows.map((r) => h(Row, { key: r.id, item: r, selected: state.selected === r.id }))))
  }
  const update = (fn: (s: State) => State) => flushSync(() => setState(fn))

  return {
    mount() {
      root = createRoot(host)
      flushSync(() => root!.render(h(MantineProvider, null, h(App))))
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

const OPTIONS = [
  { value: "a", label: "Taslak" },
  { value: "b", label: "Onaylandı" },
  { value: "c", label: "Sevk edildi" },
  { value: "d", label: "İptal" },
]
const KINDS = {
  button: ({ i }: { i: number }) => h(Button, null, `Kaydet ${i}`),
  input: ({ i }: { i: number }) => {
    const [value, setValue] = useState(`değer ${i}`)
    return h(TextInput, { label: `Alan ${i}`, value, onChange: (e) => setValue(e.currentTarget.value) })
  },
  checkbox: ({ i }: { i: number }) => {
    const [checked, setChecked] = useState(false)
    return h(Checkbox, { label: `Seçenek ${i}`, checked, onChange: (e) => setChecked(e.currentTarget.checked) })
  },
  combobox: ({ i }: { i: number }) => {
    const [value, setValue] = useState<string | null>("b")
    return h(Select, { label: `Durum ${i}`, data: OPTIONS, value, onChange: setValue })
  },
  badge: ({ i }: { i: number }) => h(Badge, { color: "green", variant: "light" }, i),
}

/** Mounts `count` components of a kind; returns the function that removes them. */
export function components(host: HTMLElement, kind: keyof typeof KINDS, count: number) {
  const root = createRoot(host)
  const Kind = KINDS[kind]
  flushSync(() => root.render(h(MantineProvider, null, h("div", { className: "grid-of" }, Array.from({ length: count }, (_, i) => h(Kind, { key: i, i }))))))
  return () => {
    root.unmount()
    host.replaceChildren()
  }
}
