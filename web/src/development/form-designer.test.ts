import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { flush, signal } from "@bazlama/core"
import { itemKey, type AppDef, type FormDef } from "../runtime/api"
import type { FormCodeOutline } from "./code"
import type { DraftStore } from "./draft"
import { addSection, locate, moveField, moveSection, placeField, placedKeys, removeField, renameField, setColumns, setSpan } from "./form-edit"

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
  await import("./components/form-designer")
})
afterEach(() => {
  document.body.replaceChildren()
  localStorage.clear()
})

const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((r) => setTimeout(r))
    flush()
  }
}

const sample = (): FormDef => ({
  key: "f",
  name: "F",
  entity: "e",
  sections: [
    { title: "A", columns: 2, fields: ["a", { field: "b", span: 2 }, "c"] },
    { title: "B", columns: 3, fields: ["d"] },
  ],
})
const layout = (f: FormDef) => f.sections.map((s) => s.fields.map(itemKey).join(","))

describe("form layout edits", () => {
  it("places, moves and removes fields", () => {
    const f = sample()
    expect([...placedKeys(f)]).toEqual(["a", "b", "c", "d"])
    expect(locate(f, "c")).toEqual({ section: 0, index: 2 })

    placeField(f, "x", 1) // a new field, at the end of a section
    placeField(f, "y", 0, "b") // before another field
    expect(layout(f)).toEqual(["a,y,b,c", "d,x"])
    placeField(f, "a", 0, "c") // within its section
    placeField(f, "d", 0, "a") // from another section
    placeField(f, "y", 0, "y") // onto itself: stays
    expect(layout(f)).toEqual(["y,b,d,a,c", "x"])
    expect(removeField(f, "d")).toBe("d")
    expect(removeField(f, "nope")).toBeNull()
    expect(layout(f)).toEqual(["y,b,a,c", "x"])
  })

  it("moves a field in reading order, across sections at their edges", () => {
    const f = sample()
    moveField(f, "a", 1)
    expect(layout(f)).toEqual(["b,a,c", "d"])
    moveField(f, "c", 1) // last of its section: first of the next
    expect(layout(f)).toEqual(["b,a", "c,d"])
    moveField(f, "c", -1) // first of its section: last of the previous
    moveField(f, "b", -1) // nothing before the first field
    moveField(f, "d", 1) // nothing after the last
    expect(layout(f)).toEqual(["b,a,c", "d"])
  })

  it("keeps a width as far as the section has columns", () => {
    const f = sample()
    setSpan(f, "a", 2)
    expect(f.sections[0].fields[0]).toEqual({ field: "a", span: 2 })
    setSpan(f, "a", undefined) // back to the plain key
    expect(f.sections[0].fields[0]).toBe("a")

    f.sections[1].columns = 1
    placeField(f, "b", 1) // span 2 into a one-column section
    expect(f.sections[1].fields[1]).toEqual({ field: "b", span: 1 })
    setSpan(f, "d", 3)
    setColumns(f, 1, 2) // fewer columns: wider fields shrink
    expect(f.sections[1].fields[0]).toEqual({ field: "d", span: 2 })
    setColumns(f, 1, 9)
    expect(f.sections[1].columns).toBe(3)

    renameField(f, "d", "dd") // the width survives a rename
    expect(f.sections[1].fields[0]).toEqual({ field: "dd", span: 2 })
  })

  it("adds and moves sections", () => {
    const f = sample()
    expect(addSection(f)).toBe(2)
    expect(addSection(f, 0)).toBe(0)
    expect(f.sections.map((s) => s.title)).toEqual(["Bölüm 4", "A", "B", "Bölüm 3"])
    expect(moveSection(f, 0, 3)).toBe(2) // before the section now at 3
    expect(moveSection(f, 3, 0)).toBe(0)
    expect(f.sections.map((s) => s.title)).toEqual(["Bölüm 3", "A", "B", "Bölüm 4"])
  })
})

function fakeStore() {
  const def = signal<AppDef | null>({
    key: "satis",
    name: "Satış",
    version: "0.0.0",
    entities: [
      {
        key: "siparis",
        name: "Sipariş",
        scope: "global",
        fields: [
          { key: "no", label: "No", type: "text", required: true },
          { key: "tarih", label: "Tarih", type: "date", required: true },
          { key: "aciklama", label: "Açıklama", type: "longText" },
        ],
      },
      { key: "kalem", name: "Kalem", pluralName: "Kalemler", scope: "global", parent: "siparis", fields: [{ key: "urun", label: "Ürün", type: "text" }] },
    ],
    forms: [{ key: "hizli", name: "Hızlı sipariş", entity: "siparis", sections: [{ title: "Genel", fields: ["no"], columns: 2 }] }],
    modals: [
      {
        key: "aralik",
        name: "Tarih aralığı",
        fields: [{ key: "baslangic", label: "Başlangıç", type: "date", required: true }],
        sections: [{ fields: ["baslangic"], columns: 2 }],
      },
    ],
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

async function mount(store: DraftStore, modal?: string) {
  const el = document.createElement("bazlama-form-designer") as HTMLElement & { store: DraftStore; form: string; modal: string }
  el.store = store
  if (modal) el.modal = modal
  else el.form = "hizli"
  document.body.append(el)
  await settle()
  const q = <T extends HTMLElement = HTMLElement>(selector: string) => el.querySelector<T>(selector)!
  const button = (label: string) => [...el.querySelectorAll<HTMLElement>("bz-button, button, [role=button]")].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label)!
  const palette = (key: string) => q(`.fd-palette-item[data-field="${key}"]`)
  const item = (key: string) => q(`.fd-item[data-key="${key}"]`)
  const key = (target: Element, name: string, alt = false) => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, altKey: alt, bubbles: true }))
  /** A drag from one element to a point of another (jsdom lays nothing out: the box is given). */
  const drag = (from: Element, to: Element, at: { x?: number; y?: number } = {}) => {
    to.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 40, right: 100, bottom: 40, x: 0, y: 0, toJSON: () => ({}) })
    const event = (type: string) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { clientX: at.x ?? 0, clientY: at.y ?? 0 })
    from.dispatchEvent(event("dragstart"))
    to.dispatchEvent(event("dragover"))
    // The mark is on what would take the drop (a field, or the section around an empty spot).
    const mark = el.querySelector("[data-drop]")?.getAttribute("data-drop") ?? null
    to.dispatchEvent(event("drop"))
    from.dispatchEvent(event("dragend"))
    return mark
  }
  return { el, q, button, palette, item, key, drag }
}
const form = (store: DraftStore) => store.def()!.forms![0]
const modal = (store: DraftStore) => store.def()!.modals![0]
/** Types into a labelled input of the properties panel. */
const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string, event = "input") => {
  input.focus()
  input.value = value
  input.dispatchEvent(new Event(event, { bubbles: true }))
}

describe("bazlama-form-designer", () => {
  it("shows the palette, the form on the canvas and the form's properties", async () => {
    const { el, q, palette } = await mount(fakeStore())
    // Palette: the entity's fields (the placed one is marked) and the section component.
    expect([...el.querySelectorAll(".fd-palette-item[data-field]")].map((b) => b.textContent!.trim())).toEqual(["No *", "Tarih *", "Açıklama"])
    expect(palette("no").classList.contains("placed")).toBe(true)
    expect(palette("tarih").draggable).toBe(true)
    expect(q(".fd-palette").textContent).toContain("Zorunlu ama formda yok: Tarih.")
    // Canvas: the section with the runtime's editor for its field, and the detail entity below.
    expect(q(".fd-section-head").textContent).toContain("Genel")
    expect(q(".fd-item[data-key=no] bz-input").getAttribute("label")).toBe("No *")
    expect(q(".fd-detail").textContent).toContain("Kalemler")
    // Nothing selected: the form's own properties.
    expect(q<HTMLInputElement>(".fd-props bz-input[label='Form adı'] input").value).toBe("Hızlı sipariş")
  })

  it("adds a palette field with a click, to the selected section", async () => {
    const store = fakeStore()
    const { palette, button, q } = await mount(store)
    button("Bölüm ekle").click()
    await settle()
    expect(form(store).sections.map((s) => s.title)).toEqual(["Genel", "Bölüm 2"])
    palette("aciklama").click() // the new section is selected
    await settle()
    expect(layout(form(store))).toEqual(["no", "aciklama"])
    expect(q(".fd-item[data-key=aciklama]").getAttribute("aria-selected")).toBe("true")
    expect(q(".fd-item[data-key=aciklama]").getAttribute("data-span")).toBe("full") // a long text takes the row
    expect(palette("aciklama").classList.contains("placed")).toBe(true)
  })

  it("moves fields and sections by dragging", async () => {
    const store = fakeStore()
    const { palette, item, q, drag, button } = await mount(store)
    // From the palette onto a field: left half = before it.
    expect(drag(palette("tarih"), item("no"), { x: 10 })).toBe("before")
    await settle()
    expect(layout(form(store))).toEqual(["tarih,no"])
    // A field on the canvas onto another: right half = after it.
    expect(drag(item("tarih"), item("no"), { x: 90 })).toBe("after")
    await settle()
    expect(layout(form(store))).toEqual(["no,tarih"])
    // Onto itself: no drop.
    expect(drag(item("no"), item("no"), { x: 10 })).toBeNull()

    // A new section from the palette, above the first; then a field into its empty body.
    expect(drag(button("Bölüm ekle"), q(".fd-section[data-section='0']"), { y: 5 })).toBe("before")
    await settle()
    expect(form(store).sections.map((s) => s.title)).toEqual(["Bölüm 2", "Genel"])
    expect(drag(item("tarih"), q(".fd-section[data-section='0'] .fd-empty"))).toBe("inside")
    await settle()
    expect(layout(form(store))).toEqual(["tarih", "no"])
    // The section itself, by its head, below the other.
    expect(drag(q(".fd-section[data-section='0'] .fd-section-head"), q(".fd-section[data-section='1']"), { y: 35 })).toBe("after")
    await settle()
    expect(form(store).sections.map((s) => s.title)).toEqual(["Genel", "Bölüm 2"])
    expect(q(".fd-section[data-section='1']").getAttribute("aria-selected")).toBe("true")
  })

  it("moves and removes the selection with the keyboard", async () => {
    const store = fakeStore()
    const { palette, item, key, q } = await mount(store)
    palette("tarih").click()
    palette("aciklama").click()
    await settle()
    expect(layout(form(store))).toEqual(["no,tarih,aciklama"])
    key(item("aciklama"), "ArrowLeft", true)
    await settle()
    expect(layout(form(store))).toEqual(["no,aciklama,tarih"])
    expect(document.activeElement).toBe(item("aciklama")) // the keyboard stays on it
    key(item("aciklama"), "Delete")
    await settle()
    expect(layout(form(store))).toEqual(["no,tarih"])
    expect(palette("aciklama").classList.contains("placed")).toBe(false)
    expect(q(".fd-item[data-key=tarih]").getAttribute("aria-selected")).toBe("true") // the neighbour

    key(q(".fd-section-head"), "Delete")
    await settle()
    expect(form(store).sections).toEqual([])
    expect(q(".fd-canvas").textContent).toContain("Formda bölüm yok.")
  })

  it("edits a section and a field's width in the properties panel", async () => {
    const store = fakeStore()
    const { q, item, palette } = await mount(store)
    palette("tarih").click()
    await settle()

    q(".fd-section").click()
    await settle()
    const title = q<HTMLInputElement>(".fd-props bz-input[label='Başlık'] input")
    title.focus()
    title.value = "Başlık bilgileri"
    title.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    expect(form(store).sections[0].title).toBe("Başlık bilgileri")
    expect(q(".fd-section-head").textContent).toContain("Başlık bilgileri")
    expect(title.isConnected).toBe(true) // typing keeps the input
    expect(document.activeElement).toBe(title)

    item("tarih").click()
    await settle()
    expect(q(".fd-props .fd-facts").textContent).toContain("Tarih *")
    const width = q(".fd-props bz-combobox[label='Genişlik']")
    width.dispatchEvent(new CustomEvent("change", { detail: { value: "2" } }))
    await settle()
    expect(form(store).sections[0].fields).toEqual(["no", { field: "tarih", span: 2 }])
    expect(item("tarih").getAttribute("data-span")).toBe("2")

    // Fewer columns: the width follows.
    q(".fd-section").click()
    await settle()
    q(".fd-props bz-combobox[label='Sütun sayısı']").dispatchEvent(new CustomEvent("change", { detail: { value: "1" } }))
    await settle()
    expect(form(store).sections[0]).toMatchObject({ columns: 1, fields: ["no", { field: "tarih", span: 1 }] })
  })

  it("typing the form's name keeps the input", async () => {
    const store = fakeStore()
    const { q } = await mount(store)
    const input = q<HTMLInputElement>("bz-input[label='Form adı'] input")
    input.focus()
    input.value = "Kısa sipariş"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    expect(form(store).name).toBe("Kısa sipariş")
    expect(q("h1").textContent).toBe("Kısa sipariş")
    expect(input.isConnected).toBe(true)
    expect(document.activeElement).toBe(input)
  })

  it("edits the form's tools menu in its own tab of the side panel", async () => {
    const store = fakeStore()
    const { el, q, button, key } = await mount(store)
    const tab = () => (q(".fd-side bz-tabs") as HTMLElement & { value: string }).value
    const rows = () => [...el.querySelectorAll<HTMLElement>(".fd-tool-list > bz-option")].map((o) => o.textContent!.replace(/\s+/g, " ").trim())
    const input = (label: string) => q<HTMLInputElement>(`.fd-tools bz-input[label='${label}'] input`)

    // The form's properties only name the tools; the button there opens the tab.
    expect(q(".fd-props").textContent).toContain("Boş: kayıt formunda Araçlar menüsü görünmez.")
    q("[data-open-tools]").click()
    await settle()
    expect(tab()).toBe("tools")
    expect(q(".fd-tools .fd-empty").textContent).toContain("Araç yok")

    // A new tool: selected, its name ready to be typed over.
    q("[data-add-tool]").click()
    await settle()
    expect(form(store).tools).toEqual([{ label: "Yeni araç", method: "YeniArac" }])
    expect(document.activeElement).toBe(input("Ad"))
    expect(q(".fd-side bz-tab[value=tools]").textContent).toBe("Araçlar (1)")

    // The method follows the name until it is edited by hand; typing keeps the inputs, the list follows.
    const name = input("Ad")
    type(name, "Teslim tarihini öner")
    await settle()
    expect(form(store).tools).toEqual([{ label: "Teslim tarihini öner", method: "TeslimTarihiniOner" }])
    expect(q<HTMLInputElement>(".fd-tools [data-tool-method] input").value).toBe("TeslimTarihiniOner")
    expect(rows()).toEqual(["Teslim tarihini öner TeslimTarihiniOner"])
    expect(q("[data-tool-signature]").textContent).toContain("public ActionResult TeslimTarihiniOner(")
    expect(q("[data-tool-signature]").textContent!.replace(/\s+/g, " ")).toContain("Siparis record, IAppContext context)")
    expect(name.isConnected).toBe(true)
    type(q<HTMLInputElement>(".fd-tools [data-tool-method] input"), "TeslimOner")
    type(name, "Teslim öner")
    type(input("Onay sorusu"), "Emin misiniz?")
    // The icon is picked from the icon set, shown in the panel.
    const icons = q<HTMLDetailsElement>(".fd-tools [data-tool-icon]")
    expect(icons.querySelector("summary")!.textContent).toContain("ikonsuz")
    expect([...icons.querySelectorAll(".fd-icon")].map((b) => b.getAttribute("aria-label"))).toEqual(expect.arrayContaining(["ikonsuz", "clock", "chevron-right"]))
    icons.open = true
    icons.querySelector<HTMLElement>(".fd-icon[aria-label=clock]")!.click()
    await settle()
    expect(form(store).tools).toEqual([{ label: "Teslim öner", method: "TeslimOner", confirm: "Emin misiniz?", icon: "clock" }])
    expect(icons.open).toBe(false)
    expect(icons.querySelector("summary")!.textContent).toContain("clock")
    expect(icons.querySelector(".fd-icon[aria-label=clock]")!.getAttribute("aria-pressed")).toBe("true")

    // A name that is not a method name is said at once, in the list too.
    type(q<HTMLInputElement>(".fd-tools [data-tool-method] input"), "2 kelime")
    await settle()
    expect(q(".fd-tools .field-error").textContent).toContain("Bir C# metot adı olmalı")
    expect(q(".fd-tool-row .fd-tool-mark")).not.toBeNull()
    type(q<HTMLInputElement>(".fd-tools [data-tool-method] input"), "TeslimOner")
    await settle()
    expect(el.querySelector(".fd-tools .field-error")).toBeNull()

    // A second one gets a method of its own; it moves up, by the button and by the keyboard.
    q("[data-add-tool]").click()
    q("[data-add-tool]").click()
    await settle()
    expect(form(store).tools!.map((t) => t.method)).toEqual(["TeslimOner", "YeniArac", "YeniArac2"])
    expect(input("Ad").value).toBe("Yeni araç 2") // the new one is selected
    button("Yukarı taşı").click()
    await settle()
    expect(form(store).tools!.map((t) => t.method)).toEqual(["TeslimOner", "YeniArac2", "YeniArac"])
    key(q(".fd-tool-list"), "ArrowUp", true)
    await settle()
    expect(form(store).tools!.map((t) => t.method)).toEqual(["YeniArac2", "TeslimOner", "YeniArac"])
    expect(input("Ad").value).toBe("Yeni araç 2") // still the one that moved

    // Selecting in the list shows that tool; removing the last tool removes the menu.
    q(".fd-tool-list").dispatchEvent(new CustomEvent("change", { detail: { value: "1" } }))
    await settle()
    expect(input("Ad").value).toBe("Teslim öner")
    for (let i = 0; i < 3; i++) {
      button("Aracı kaldır").click()
      await settle()
    }
    expect(form(store).tools).toBeUndefined()
    expect(q(".fd-side bz-tab[value=tools]").textContent).toBe("Araçlar")
    expect(layout(form(store))).toEqual(["no"]) // the layout is untouched
  })

  it("offers the methods of the form's code and goes to a tool's method", async () => {
    const store = fakeStore()
    store.update((d) => (d.forms![0].tools = [{ label: "Öner", method: "Oner" }]))
    const code = signal<FormCodeOutline | null | undefined>(undefined)
    const went: string[] = []
    const el = document.createElement("bazlama-form-designer") as HTMLElement & {
      store: DraftStore
      form: string
      formCode: (f: string) => FormCodeOutline | null | undefined
      goToMethod: (f: string, m: string) => void
    }
    el.store = store
    el.form = "hizli"
    el.formCode = (f) => (f === "hizli" ? code() : null)
    el.goToMethod = (f, m) => went.push(`${f}.${m}`)
    document.body.append(el)
    await settle()
    const q = <T extends HTMLElement = HTMLElement>(selector: string) => el.querySelector<T>(selector)!
    const state = () => q("[data-method-state]").getAttribute("data-method-state")
    const go = () => q("[data-go-to-method]")

    // Before the first check answers nothing is claimed about the code.
    expect(el.querySelector("[data-method-state]")).toBeNull()
    expect(go().getAttribute("aria-label")).toBe("Metoda git")

    // No code class yet: the button writes it.
    code.set(null)
    await settle()
    expect(state()).toBe("no-class")
    expect(go().getAttribute("aria-label")).toBe("Metodu oluştur ve git")

    // The class has other methods: they are offered, the tool's own is still missing.
    const method = (name: string, line: number) => ({ name, path: "HizliFormu.cs", line, column: 25 })
    code.set({ form: "hizli", class: "HizliFormu", record: "Siparis", path: "HizliFormu.cs", line: 4, column: 14, endLine: 20, endColumn: 1, methods: [method("TeslimOner", 6), method("NotEkle", 12)] })
    await settle()
    expect([...el.querySelectorAll("[data-tool-method] bz-option")].map((o) => o.getAttribute("value"))).toEqual(["TeslimOner", "NotEkle"])
    expect(state()).toBe("missing")
    go().click()
    expect(went).toEqual(["hizli.Oner"])

    // Picked from the list: found in the code, the button only goes there.
    q("[data-tool-method]").dispatchEvent(new CustomEvent("change", { detail: { value: "NotEkle" } }))
    await settle()
    expect(store.def()!.forms![0].tools![0].method).toBe("NotEkle")
    expect(state()).toBe("found")
    expect(q("[data-method-state]").textContent).toContain("HizliFormu · HizliFormu.cs:12")
    expect(go().getAttribute("aria-label")).toBe("Metoda git")
    go().click()
    expect(went).toEqual(["hizli.Oner", "hizli.NotEkle"])

    // Free text still works; a name that is not a method name cannot be gone to.
    type(q<HTMLInputElement>("[data-tool-method] input"), "Yeni Metot")
    await settle()
    expect(store.def()!.forms![0].tools![0].method).toBe("Yeni Metot")
    expect(el.querySelector("[data-method-state]")).toBeNull()
    expect(go().hasAttribute("disabled")).toBe(true)
  })

  it("shows what the code check says about the form's tools", async () => {
    const store = fakeStore()
    store.update((d) => (d.forms![0].tools = [{ label: "Öner", method: "Oner" }]))
    const el = document.createElement("bazlama-form-designer") as HTMLElement & { store: DraftStore; form: string; toolProblems: (f: string) => string[] }
    el.store = store
    el.form = "hizli"
    el.toolProblems = (f) => [`'${f}' formunun 'Öner' aracı HizliFormu.Oner(Siparis record, IAppContext context) metodunu çağırır; bu metot yok.`]
    document.body.append(el)
    await settle()
    expect(el.querySelector(".fd-tools bz-alert")!.textContent).toContain("HizliFormu.Oner(")
  })
})

describe("bazlama-form-designer (object tree)", () => {
  const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".fd-tree [role=treeitem]")]
  const row = (el: HTMLElement, label: string) => rows(el).find((r) => r.textContent!.trim().startsWith(label))!
  const tab = (el: HTMLElement) => (el.querySelector(".fd-side bz-tabs") as HTMLElement & { value: string }).value

  it("shows the form, its sections, fields and tools; a node selects on the canvas", async () => {
    const store = fakeStore()
    store.update((d) => {
      d.forms![0].sections.push({ title: "Diğer", columns: 1, fields: ["aciklama"] })
      d.forms![0].tools = [{ label: "Teslim öner", method: "TeslimOner" }]
    })
    const { el, q, item } = await mount(store)
    expect(tab(el)).toBe("props")
    expect(rows(el).map((r) => [r.getAttribute("aria-level"), r.textContent!.trim()])).toEqual([
      ["1", "Hızlı sipariş"], ["2", "Genel"], ["3", "No *"], ["2", "Diğer"], ["3", "Açıklama"], ["2", "Araçlar menüsü"], ["3", "Teslim öner"],
    ])

    // A field: selected on the canvas, its properties are ready behind the other tab.
    row(el, "Açıklama").click()
    await settle()
    expect(item("aciklama").getAttribute("aria-selected")).toBe("true")
    expect(q(".fd-props .fd-facts").textContent).toContain("aciklama")
    row(el, "Diğer").click()
    await settle()
    expect(q('.fd-section[data-section="1"]').getAttribute("aria-selected")).toBe("true")
    expect(q<HTMLInputElement>(".fd-props bz-input[label='Başlık'] input").value).toBe("Diğer")

    // The canvas selects in the tree; a double click opens the properties.
    q(".fd-side bz-tabs").dispatchEvent(new CustomEvent("change", { detail: { value: "tree" } }))
    item("no").click()
    await settle()
    expect(row(el, "No").getAttribute("aria-selected")).toBe("true")
    expect(tab(el)).toBe("tree")
    row(el, "No").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    await settle()
    expect(tab(el)).toBe("props")

    // The tools have a tab of their own: a tool's node opens it on that tool.
    store.update((d) => d.forms![0].tools!.push({ label: "Not ekle", method: "NotEkle" }))
    await settle()
    q(".fd-side bz-tabs").dispatchEvent(new CustomEvent("change", { detail: { value: "tree" } }))
    row(el, "Not ekle").click()
    await settle()
    expect(tab(el)).toBe("tools")
    expect(q<HTMLInputElement>(".fd-tools bz-input[label='Ad'] input").value).toBe("Not ekle")
  })

  it("moves and removes the selection with the keys of the canvas", async () => {
    const store = fakeStore()
    store.update((d) => (d.forms![0].sections[0].fields = ["no", "tarih", "aciklama"]))
    const { el, key } = await mount(store)
    row(el, "Tarih").click()
    await settle()
    key(row(el, "Tarih"), "ArrowDown", true)
    await settle()
    expect(layout(form(store))).toEqual(["no,aciklama,tarih"])
    expect(rows(el).map((r) => r.textContent!.trim())).toEqual(["Hızlı sipariş", "Genel", "No *", "Açıklama", "Tarih *"])
    key(row(el, "Tarih"), "Delete")
    await settle()
    expect(layout(form(store))).toEqual(["no,aciklama"])
    // Enter opens the properties of what is selected.
    el.querySelector(".fd-side bz-tabs")!.dispatchEvent(new CustomEvent("change", { detail: { value: "tree" } }))
    key(row(el, "Açıklama"), "Enter")
    await settle()
    expect(tab(el)).toBe("props")
  })

  it("shows a modal's own fields; a modal has no tools tab", async () => {
    const { el } = await mount(fakeStore(), "aralik")
    expect(rows(el).map((r) => r.textContent!.trim())).toEqual(["Tarih aralığı", "Başlıksız bölüm", "Başlangıç *"])
    expect([...el.querySelectorAll(".fd-side bz-tab")].map((t) => t.textContent!.trim())).toEqual(["Özellikler", "Nesne ağacı"])
  })
})

describe("bazlama-form-designer (modal)", () => {
  it("shows field types in the palette, the modal on the canvas and its properties", async () => {
    const { el, q } = await mount(fakeStore(), "aralik")
    expect(q(".fd").getAttribute("data-kind")).toBe("modal")
    expect([...el.querySelectorAll(".fd-palette-item[data-type]")].map((b) => b.getAttribute("data-type"))).toEqual(
      ["text", "longText", "integer", "decimal", "date", "dateTime", "boolean", "choice", "reference", "company", "location", "plant", "period"],
    )
    expect(q(".fd-item[data-key=baslangic] bz-input").getAttribute("label")).toBe("Başlangıç *")
    expect(q(".fd-modal-foot").textContent).toContain("Tamam")
    expect(q<HTMLInputElement>(".fd-props bz-input[label='Modal adı'] input").value).toBe("Tarih aralığı")
    expect(q(".fd-props .fd-code").textContent).toContain("ShowAsync<Aralik>()")

    type(q<HTMLInputElement>(".fd-props bz-input[label='Onay düğmesi'] input"), "Göster")
    await settle()
    expect(modal(el.store).okText).toBe("Göster")
    expect(q(".fd-modal-foot").textContent).toContain("Göster")
  })

  it("makes a field from a palette type and edits it in the properties panel", async () => {
    const store = fakeStore()
    const { q, item, drag } = await mount(store, "aralik")
    q(".fd-palette-item[data-type=date]").click()
    await settle()
    expect(modal(store).fields.map((f) => [f.key, f.label, f.type])).toEqual([["baslangic", "Başlangıç", "date"], ["tarih", "Tarih", "date"]])
    expect(layout(modal(store) as never)).toEqual(["baslangic,tarih"])

    // Its label is ready to be typed over; the key follows it.
    const label = q<HTMLInputElement>(".fd-props bz-input[label='Etiket'] input")
    expect(document.activeElement).toBe(label)
    type(label, "Bitiş")
    await settle()
    expect(modal(store).fields[1]).toEqual({ key: "bitis", label: "Bitiş", type: "date" })
    expect(layout(modal(store) as never)).toEqual(["baslangic,bitis"])
    expect(label.isConnected).toBe(true)
    expect(item("bitis").getAttribute("aria-selected")).toBe("true")

    // A key typed by hand must be free; then the label no longer renames it.
    const key = q<HTMLInputElement>(".fd-props bz-input[label='Anahtar'] input")
    type(key, "baslangic", "change")
    await settle()
    expect(q(".fd-props .field-error").textContent).toBe("Bu anahtar kullanılıyor.")
    type(key, "son", "change")
    type(label, "Bitiş tarihi")
    q(".fd-props bz-checkbox[label='Zorunlu']").dispatchEvent(new CustomEvent("change", { detail: { checked: true } }))
    await settle()
    expect(modal(store).fields[1]).toEqual({ key: "son", label: "Bitiş tarihi", type: "date", required: true })

    // A type dragged onto a field lands before it; an organization picker needs nothing more.
    expect(drag(q(".fd-palette-item[data-type=company]"), item("son"), { x: 10 })).toBe("before")
    await settle()
    expect(layout(modal(store) as never)).toEqual(["baslangic,firma,son"])
    expect(modal(store).fields[2]).toEqual({ key: "firma", label: "Firma", type: "company" })
    expect(item("firma").querySelector("bz-combobox")!.getAttribute("label")).toBe("Firma")

    // The type changes here (it is the modal's own field); a choice gets its options.
    q(".fd-props bz-combobox[label='Tip']").dispatchEvent(new CustomEvent("change", { detail: { value: "choice" } }))
    await settle()
    type(q<HTMLTextAreaElement>(".fd-props bz-textarea[label='Seçenekler'] textarea"), "a=Açık\nk=Kapalı")
    await settle()
    expect(modal(store).fields[2]).toMatchObject({ type: "choice", choices: [{ value: "a", label: "Açık" }, { value: "k", label: "Kapalı" }] })
  })

  it("deletes a field with what takes it off the layout", async () => {
    const store = fakeStore()
    const { q, item, key, button } = await mount(store, "aralik")
    q(".fd-palette-item[data-type=text]").click()
    q(".fd-palette-item[data-type=boolean]").click()
    await settle()
    expect(modal(store).fields.map((f) => f.key)).toEqual(["baslangic", "metin", "evet_hayir"])

    item("metin").focus()
    key(item("metin"), "Delete")
    await settle()
    expect(modal(store).fields.map((f) => f.key)).toEqual(["baslangic", "evet_hayir"])
    item("evet_hayir").click()
    await settle()
    button("Alanı sil").click()
    await settle()
    expect(modal(store).fields.map((f) => f.key)).toEqual(["baslangic"])

    // A section goes with its fields.
    q(".fd-section").click()
    await settle()
    button("Bölümü kaldır").click()
    await settle()
    expect(modal(store)).toMatchObject({ fields: [], sections: [] })
    expect(q(".fd-canvas").textContent).toContain("Modalda bölüm yok.")
  })
})
