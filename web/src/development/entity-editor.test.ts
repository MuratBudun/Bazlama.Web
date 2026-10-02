import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { computed, flush, signal } from "@bazlama/core"
import type { AppDef, EntityDef, ListDef } from "../runtime/api"
import type { DraftStore } from "./draft"

beforeAll(async () => {
  const proto = ElementInternals.prototype as unknown as Record<string, unknown>
  proto.setFormValue ??= () => {}
  proto.setValidity ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
  const { defineIcons } = await import("@bazlama/headless")
  defineIcons(await import("@bazlama/icons"))
  await import("./components/entity-editor")
})
afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((r) => setTimeout(r))
    flush()
  }
}

/** The parts of the draft store the editor uses, over a plain definition. */
function fakeStore(entities: EntityDef[], installed: EntityDef[] = [], lists: ListDef[] = [{ key: "siparis", name: "Siparişler", entity: "siparis", columns: ["no", "tarih"] }]) {
  const forms = [{ key: "siparis", name: "Sipariş", entity: "siparis", sections: [{ title: "Genel", fields: ["no", "tarih"], columns: 2 }] }]
  const def = signal<AppDef | null>({ key: "satis", name: "Satış", version: "0.0.0", entities, forms, lists })
  const store = {
    appKey: "satis",
    def,
    errors: signal<string[]>([]),
    update: (fn: (d: AppDef) => void) => {
      const next = structuredClone(def()!)
      fn(next)
      def.set(next)
    },
    installedEntity: (key: string) => installed.find((e) => e.key === key),
    dirty: computed(() => false),
  }
  return store as unknown as DraftStore & { def: typeof def }
}

async function mount(store: DraftStore, entity = "siparis") {
  const el = document.createElement("bazlama-entity-editor") as HTMLElement & { store: DraftStore; entity: string }
  el.store = store
  el.entity = entity
  document.body.append(el)
  await settle()
  const rows = () => [...el.querySelectorAll<HTMLElement>(".ee-list > bz-option")].map((o) => o.getAttribute("value"))
  const select = async (value: string) => {
    const list = el.querySelector<HTMLElement & { value: string }>(".ee-list")!
    list.querySelector<HTMLElement>(`bz-option[value="${value}"]`)!.click()
    await settle()
  }
  const input = (label: string) =>
    [...el.querySelectorAll<HTMLElement & { label: string }>(".ee-inspector bz-input")].find((i) => i.getAttribute("label") === label)!.querySelector("input")!
  const type = async (target: HTMLInputElement, text: string) => {
    target.value = text
    target.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
  }
  const button = (label: string) => [...el.querySelectorAll<HTMLElement>("bz-button")].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label)!
  return { el, rows, select, input, type, button }
}

const siparis = (): EntityDef => ({
  key: "siparis",
  name: "Sipariş",
  scope: "location",
  fields: [
    { key: "no", label: "No", type: "text", required: true },
    { key: "tarih", label: "Tarih", type: "date" },
  ],
})
const formFields = (store: { def: () => AppDef | null }) => store.def()!.forms![0].sections[0].fields

describe("bazlama-entity-editor", () => {
  it("lists the entity and its fields; the entity's properties are shown first", async () => {
    const { el, rows } = await mount(fakeStore([siparis()]))
    expect(rows()).toEqual(["@entity", "no", "tarih"])
    expect(el.querySelector(".ee-inspector h3")!.textContent).toBe("Entity")
  })

  it("typing the entity's name changes the draft without rebuilding the tab", async () => {
    const store = fakeStore([siparis()])
    const { el, input, type } = await mount(store)
    const name = input("Ad (tekil)")
    name.focus()
    await type(name, "Satış siparişi")
    expect(store.def()!.entities[0].name).toBe("Satış siparişi")
    expect(el.querySelector(".ee-head h1")!.textContent).toBe("Satış siparişi")
    expect(name.isConnected).toBe(true)
    expect(document.activeElement).toBe(name)
  })

  it("adds a field whose key follows its label while it is typed, keeping the focus", async () => {
    const store = fakeStore([siparis()])
    const { el, rows, button, type } = await mount(store)
    button("Alan ekle").click()
    await settle()
    expect(rows()).toEqual(["@entity", "no", "tarih", "yeni_alan"])
    const label = el.querySelector<HTMLInputElement>("[data-focus=label] input")!
    expect(document.activeElement).toBe(label)
    // Forms do not change: their designer offers the fields they do not show.
    expect(formFields(store)).toEqual(["no", "tarih"])

    await type(label, "Müşteri adı")
    expect(rows()).toEqual(["@entity", "no", "tarih", "musteri_adi"])
    // The same input is still there and focused: the panel was not rebuilt.
    expect(label.isConnected).toBe(true)
    expect(document.activeElement).toBe(label)
  })

  it("renames a key everywhere it is used and refuses invalid or taken keys", async () => {
    const store = fakeStore([{ ...siparis(), titleField: "no" }], [], [{ key: "siparis", name: "Siparişler", entity: "siparis", columns: ["no"], sortField: "no" }])
    const { el, select, input, rows } = await mount(store)
    await select("no")
    const key = input("Anahtar")
    key.value = "tarih"
    key.dispatchEvent(new Event("input", { bubbles: true }))
    key.dispatchEvent(new Event("change", { bubbles: true }))
    await settle()
    expect(el.querySelector(".ee-inspector .field-error")!.textContent).toContain("kullanılıyor")

    key.value = "siparis_no"
    key.dispatchEvent(new Event("input", { bubbles: true }))
    key.dispatchEvent(new Event("change", { bubbles: true }))
    await settle()
    const e = store.def()!.entities[0]
    expect(rows()).toEqual(["@entity", "siparis_no", "tarih"])
    expect(e.titleField).toBe("siparis_no")
    expect(store.def()!.lists![0]).toMatchObject({ columns: ["siparis_no"], sortField: "siparis_no" })
    expect(formFields(store)).toEqual(["siparis_no", "tarih"])
    expect(el.querySelector(".ee-inspector .field-error")).toBeNull()
  })

  it("a published field's key and type are locked", async () => {
    const { select, el } = await mount(fakeStore([siparis()], [siparis()]))
    await select("no")
    const key = [...el.querySelectorAll<HTMLElement & { disabled: boolean }>(".ee-inspector bz-input")].find((i) => i.getAttribute("label") === "Anahtar")!
    expect(key.disabled).toBe(true)
    const typeBox = [...el.querySelectorAll<HTMLElement & { disabled: boolean }>(".ee-inspector bz-combobox")].find((i) => i.getAttribute("label") === "Tip")!
    expect(typeBox.disabled).toBe(true)
  })

  it("moves and removes fields; removing cleans the list and the form", async () => {
    const store = fakeStore([siparis()])
    const { select, rows, button } = await mount(store)
    await select("tarih")
    button("Yukarı taşı").click()
    await settle()
    expect(rows()).toEqual(["@entity", "tarih", "no"])

    vi.spyOn((await import("@bazlama/headless")).dialogs, "confirm").mockResolvedValue(true)
    button("Alanı kaldır").click()
    await settle()
    expect(rows()).toEqual(["@entity", "no"])
    expect(store.def()!.lists![0].columns).toEqual(["no"])
    expect(formFields(store)).toEqual(["no"])
  })


})
