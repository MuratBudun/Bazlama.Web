import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { flush, signal } from "@bazlama/core"
import type { AppDef } from "../runtime/api"
import type { DraftStore } from "./draft"

beforeAll(async () => {
  const proto = ElementInternals.prototype as unknown as Record<string, unknown>
  proto.setFormValue ??= () => {}
  proto.setValidity ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  const { defineIcons } = await import("@bazlama/headless")
  defineIcons(await import("@bazlama/icons"))
  await import("./components/list-designer")
  await import("./components/menu-designer")
})
afterEach(() => document.body.replaceChildren())

const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((r) => setTimeout(r))
    flush()
  }
}

function fakeStore(app: Partial<AppDef> = {}) {
  const def = signal<AppDef | null>({
    key: "satis",
    name: "Satış",
    version: "0.0.0",
    entities: [
      {
        key: "siparis",
        name: "Sipariş",
        pluralName: "Siparişler",
        scope: "global",
        fields: [
          { key: "no", label: "No", type: "text" },
          { key: "tarih", label: "Tarih", type: "date" },
          { key: "tutar", label: "Tutar", type: "decimal" },
          { key: "aciklama", label: "Açıklama", type: "longText" },
        ],
      },
      { key: "musteri", name: "Müşteri", pluralName: "Müşteriler", scope: "global", fields: [{ key: "unvan", label: "Unvan", type: "text" }] },
      { key: "kalem", name: "Kalem", scope: "global", parent: "siparis", fields: [{ key: "urun", label: "Ürün", type: "text" }] },
    ],
    forms: [{ key: "siparis", name: "Sipariş", entity: "siparis", sections: [{ fields: ["no"] }] }],
    lists: [{ key: "siparis", name: "Siparişler", entity: "siparis", columns: ["no", "tarih"] }],
    ...app,
  })
  const store = {
    def,
    errors: signal<string[]>([]),
    update: (fn: (d: AppDef) => void) => {
      const next = structuredClone(def()!)
      fn(next)
      def.set(next)
    },
  }
  return store as unknown as DraftStore & { def: typeof def }
}

async function mount(tag: string, store: DraftStore, attrs: Record<string, string> = {}) {
  const el = document.createElement(tag) as HTMLElement & { store: DraftStore }
  el.store = store
  for (const [k, v] of Object.entries(attrs)) (el as unknown as Record<string, string>)[k] = v
  document.body.append(el)
  await settle()
  const button = (label: string) => [...el.querySelectorAll<HTMLElement>("bz-button")].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label)!
  return { el, button }
}

describe("bazlama-list-designer", () => {
  it("edits the columns in order and previews them with sample rows", async () => {
    const store = fakeStore()
    const { el, button } = await mount("bazlama-list-designer", store, { list: "siparis" })
    expect(el.querySelectorAll(".fd-field")).toHaveLength(2)
    expect([...el.querySelectorAll("bz-data-grid thead th")].map((th) => th.textContent?.trim()).filter(Boolean)).toEqual(["No", "Tarih"])
    expect(el.querySelectorAll("bz-data-grid tbody tr[data-part=row]").length).toBeGreaterThan(0)

    // "Kalanları ekle" leaves long text out.
    button("Kalanları ekle").click()
    await settle()
    expect(store.def()!.lists![0].columns).toEqual(["no", "tarih", "tutar"])
    button("Tarih sola").click()
    await settle()
    expect(store.def()!.lists![0].columns).toEqual(["tarih", "no", "tutar"])
    button("No listeden çıkar").click()
    await settle()
    expect(store.def()!.lists![0].columns).toEqual(["tarih", "tutar"])
  })

  it("typing the list's name keeps the input; sort and form are set", async () => {
    const store = fakeStore()
    const { el } = await mount("bazlama-list-designer", store, { list: "siparis" })
    const name = el.querySelector<HTMLInputElement>("bz-input[label='Liste adı'] input")!
    name.focus()
    name.value = "Açık siparişler"
    name.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    expect(store.def()!.lists![0].name).toBe("Açık siparişler")
    expect(document.activeElement).toBe(name)

    const sort = el.querySelector<HTMLElement>("bz-combobox[label='Varsayılan sıralama']")!
    sort.dispatchEvent(new CustomEvent("change", { detail: { value: "tarih" } }))
    await settle()
    el.querySelector<HTMLElement>("bz-checkbox[label='Azalan sıra']")!.dispatchEvent(new CustomEvent("change", { detail: { checked: true } }))
    el.querySelector<HTMLElement>("bz-combobox[label='Kayıt formu']")!.dispatchEvent(new CustomEvent("change", { detail: { value: "siparis" } }))
    await settle()
    expect(store.def()!.lists![0]).toMatchObject({ sortField: "tarih", sortDescending: true, form: "siparis" })
  })
})

describe("bazlama-menu-designer", () => {
  const labels = (el: HTMLElement) => [...el.querySelectorAll(".md-tree [data-part=item] [data-part=label]")].map((n) => n.textContent)

  it("starts from the default menu: an item per master entity, making missing lists", async () => {
    const store = fakeStore()
    const { el, button } = await mount("bazlama-menu-designer", store)
    button("Varsayılandan başla").click()
    await settle()
    expect(store.def()!.menu).toEqual([
      { label: "Siparişler", list: "siparis" },
      { label: "Müşteriler", list: "musteri" },
    ])
    expect(store.def()!.lists!.map((l) => l.key)).toEqual(["siparis", "musteri"])
    expect(labels(el)).toEqual(["Siparişler", "Müşteriler"])
  })

  it("adds groups and items, moves them into and out of groups, and removes them", async () => {
    const store = fakeStore({ menu: [{ label: "Siparişler", list: "siparis" }] })
    const { el, button } = await mount("bazlama-menu-designer", store)
    button("Grup ekle").click()
    await settle()
    // The new group's label is focused; typing renames it.
    const label = el.querySelector<HTMLInputElement>("[data-focus=label] input")!
    expect(document.activeElement).toBe(label)
    label.value = "Satış"
    label.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    expect(store.def()!.menu).toEqual([{ label: "Siparişler", list: "siparis" }, { label: "Satış", items: [] }])
    expect(document.activeElement).toBe(label)

    button("Yukarı taşı").click()
    await settle()
    expect(store.def()!.menu!.map((m) => m.label)).toEqual(["Satış", "Siparişler"])

    // Select the item, put it into the group above.
    el.querySelector<HTMLElement>('.md-tree [data-id="1"]')!.click()
    await settle()
    button("Üstteki gruba al").click()
    await settle()
    expect(store.def()!.menu).toEqual([{ label: "Satış", items: [{ label: "Siparişler", list: "siparis" }] }])
    expect(labels(el)).toEqual(["Satış", "Siparişler"])

    // With the group selected, a new item goes into it and opens the first list.
    el.querySelector<HTMLElement>('.md-tree [data-id="0"]')!.click()
    await settle()
    button("Öğe ekle").click()
    await settle()
    expect(store.def()!.menu![0].items!.map((m) => m.label)).toEqual(["Siparişler", "Siparişler"])

    button("Gruptan çıkar").click()
    await settle()
    expect(store.def()!.menu!.map((m) => m.label)).toEqual(["Satış", "Siparişler"])
    button("Kaldır").click()
    await settle()
    expect(store.def()!.menu!.map((m) => m.label)).toEqual(["Satış"])
  })

  it("an item opens a list or a new record's form of a master entity", async () => {
    const store = fakeStore({ menu: [{ label: "Siparişler", list: "siparis" }] })
    const { el } = await mount("bazlama-menu-designer", store)
    el.querySelector<HTMLElement>('.md-tree [data-id="0"]')!.click()
    await settle()
    const kind = el.querySelector<HTMLElement>("bz-radio-group")!
    kind.dispatchEvent(new CustomEvent("change", { detail: { value: "form" } }))
    await settle()
    expect(store.def()!.menu![0]).toEqual({ label: "Siparişler", form: "siparis" })
    const forms = [...el.querySelectorAll("bz-combobox[label='Form'] bz-option")].map((o) => o.getAttribute("value"))
    expect(forms).toEqual(["siparis"])
    kind.dispatchEvent(new CustomEvent("change", { detail: { value: "list" } }))
    await settle()
    expect(store.def()!.menu![0]).toEqual({ label: "Siparişler", list: "siparis" })
  })
})
