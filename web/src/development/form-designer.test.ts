import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { flush, signal } from "@bazlama/core"
import type { AppDef } from "../runtime/api"
import type { DraftStore } from "./draft"

beforeAll(async () => {
  const proto = ElementInternals.prototype as unknown as Record<string, unknown>
  proto.setFormValue ??= () => {}
  proto.setValidity ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
  const { defineIcons } = await import("@bazlama/headless")
  defineIcons(await import("@bazlama/icons"))
  await import("./components/form-designer")
})
afterEach(() => document.body.replaceChildren())

const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((r) => setTimeout(r))
    flush()
  }
}

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
          { key: "no", label: "No", type: "text" },
          { key: "tarih", label: "Tarih", type: "date" },
          { key: "aciklama", label: "Açıklama", type: "longText" },
        ],
      },
      { key: "kalem", name: "Kalem", pluralName: "Kalemler", scope: "global", parent: "siparis", fields: [{ key: "urun", label: "Ürün", type: "text" }] },
    ],
    forms: [{ key: "hizli", name: "Hızlı sipariş", entity: "siparis", sections: [{ title: "Genel", fields: ["no"], columns: 2 }] }],
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

async function mount(store: DraftStore) {
  const el = document.createElement("bazlama-form-designer") as HTMLElement & { store: DraftStore; form: string }
  el.store = store
  el.form = "hizli"
  document.body.append(el)
  await settle()
  const button = (label: string) => [...el.querySelectorAll<HTMLElement>("bz-button")].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label)!
  return { el, button }
}
const sections = (store: DraftStore) => store.def()!.forms![0].sections

describe("bazlama-form-designer", () => {
  it("shows the form's sections, the fields it does not show, and a preview with the details", async () => {
    const { el } = await mount(fakeStore())
    expect([...el.querySelectorAll(".fd-field .fd-label")].map((n) => n.textContent)).toEqual(["No"])
    expect(el.textContent).toContain("Formda olmayan alanlar: Tarih, Açıklama.")
    expect(el.querySelectorAll(".fd-preview bz-form-layout")).toHaveLength(1)
    expect(el.querySelector(".fd-detail")!.textContent).toContain("Kalemler")
  })

  it("adds the remaining fields to the last section and reorders fields", async () => {
    const store = fakeStore()
    const { button } = await mount(store)
    button("Kalan alanları ekle").click()
    await settle()
    expect(sections(store)[0].fields).toEqual(["no", "tarih", "aciklama"])
    button("Tarih yukarı").click()
    await settle()
    expect(sections(store)[0].fields).toEqual(["tarih", "no", "aciklama"])
    button("Açıklama formdan çıkar").click()
    await settle()
    expect(sections(store)[0].fields).toEqual(["tarih", "no"])
  })

  it("adds and removes sections", async () => {
    const store = fakeStore()
    const { button } = await mount(store)
    button("Bölüm ekle").click()
    await settle()
    expect(sections(store).map((s) => s.title)).toEqual(["Genel", "Bölüm 2"])
    const ups = [...document.querySelectorAll<HTMLElement>("bz-button[aria-label='Bölümü yukarı taşı']")]
    ups.at(-1)!.click() // the second section's
    await settle()
    expect(sections(store).map((s) => s.title)).toEqual(["Bölüm 2", "Genel"])
  })

  it("typing the form's name keeps the input", async () => {
    const store = fakeStore()
    const { el } = await mount(store)
    const input = el.querySelector<HTMLInputElement>("bz-input[label='Form adı'] input")!
    input.focus()
    input.value = "Kısa sipariş"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    expect(store.def()!.forms![0].name).toBe("Kısa sipariş")
    expect(el.querySelector("h1")!.textContent).toBe("Kısa sipariş")
    expect(input.isConnected).toBe(true)
    expect(document.activeElement).toBe(input)
  })
})
