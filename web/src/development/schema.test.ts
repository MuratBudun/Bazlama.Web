import { describe, expect, it } from "vitest"
import type { AppDef } from "../runtime/api"
import { parts } from "./schema"

const app = (): AppDef => ({
  key: "satis",
  name: "Satış",
  version: "1.0.0",
  entities: [
    { key: "musteri", name: "Müşteri", scope: "company", fields: [{ key: "unvan", label: "Ünvan", type: "text" }] },
    {
      key: "siparis",
      name: "Sipariş",
      scope: "location",
      fields: [
        { key: "no", label: "No", type: "text" },
        { key: "musteri", label: "Müşteri", type: "reference", reference: "musteri" },
      ],
    },
    { key: "kalem", name: "Kalem", scope: "global", parent: "siparis", fields: [{ key: "urun", label: "Ürün", type: "text" }] },
  ],
  lists: [{ key: "acik", name: "Açık siparişler", entity: "siparis", columns: ["no"] }],
  forms: [{ key: "siparis", name: "Sipariş", entity: "siparis", sections: [{ fields: ["no"] }] }],
  menu: [{ label: "Siparişler", list: "acik" }],
})

type Obj = Record<string, unknown>
const props = (s: unknown) => (s as { properties: Record<string, Obj> }).properties

describe("draft parts (code view)", () => {
  it("reads and writes a part in place", () => {
    const d = app()
    const p = parts.list("acik")
    const list = structuredClone(p.get(d)) as Obj
    list.columns = ["no", "musteri"]
    p.set(d, list)
    expect(d.lists![0].columns).toEqual(["no", "musteri"])
    expect(p.lockedKey!(d)).toBe("acik")
  })

  it("offers the keys that exist in the draft", () => {
    const d = app()
    const list = props(parts.list("acik").schema(d))
    expect((list.columns.items as Obj).enum).toEqual(["no", "musteri"])
    expect(list.form.enum).toEqual(["siparis"])
    // Only master entities have lists, are referenced or are parents.
    expect(list.entity.enum).toEqual(["musteri", "siparis"])

    const entity = props(parts.entity("siparis").schema(d))
    expect(entity.titleField.enum).toEqual(["no", "musteri"])
    expect(entity.parent.enum).toEqual(["musteri"])
    expect(props((entity.fields as { items: unknown }).items).type.enum).toContain("reference")

    const menu = parts.menu().schema(d) as { definitions: { item: unknown } }
    expect(props(menu.definitions.item).list.enum).toEqual(["acik"])
  })

  it("keeps the app key when the whole definition is replaced", () => {
    const d = app()
    const next = { ...app(), key: "baska", name: "Yeni ad", lists: [] }
    parts.definition().set(d, next)
    expect(d.key).toBe("satis")
    expect(d.name).toBe("Yeni ad")
    expect(d.lists).toEqual([])
  })

  it("changes only the app's own properties from its part", () => {
    const d = app()
    parts.app().set(d, { key: "satis", name: "Satış 2", icon: "cart", entities: [] })
    expect(d.name).toBe("Satış 2")
    expect(d.icon).toBe("cart")
    expect(d.entities).toHaveLength(3)
  })

  it("describes modals with their own fields and a form's tools", () => {
    const d = app()
    d.modals = [{ key: "aralik", name: "Aralık", fields: [{ key: "firma", label: "Firma", type: "company" }, { key: "gun", label: "Gün", type: "date" }] }]
    const part = parts.modal("aralik")
    const modal = props(part.schema(d))
    const types = props((modal.fields as { items: unknown }).items).type.enum as string[]
    expect(types).toEqual(expect.arrayContaining(["date", "company", "location", "plant", "period"]))
    // Organization pickers are for modals only.
    expect(props((props(parts.entity("siparis").schema(d)).fields as { items: unknown }).items).type.enum).not.toContain("company")
    // The layout offers the modal's own fields.
    const item = (props((modal.sections as { items: unknown }).items).fields.items as { anyOf: Obj[] }).anyOf[0]
    expect(item.enum).toEqual(["firma", "gun"])

    part.set(d, { ...d.modals[0], okText: "Göster" })
    expect(d.modals[0].okText).toBe("Göster")
    expect(part.lockedKey!(d)).toBe("aralik")

    const tool = props((props(parts.form("siparis").schema(d)).tools as { items: unknown }).items)
    expect(Object.keys(tool)).toEqual(["label", "icon", "method", "confirm"])
    expect(props(parts.definition().schema(d)).modals).toBeDefined()
  })
})
