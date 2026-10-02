import { html, signal } from "@bazlama/core"
import { dialogs } from "@bazlama/headless"
import { formDialog, textField } from "../management/ui"
import { defaultColumns, plural, type AppDef, type EntityDef, type FieldType, type MenuItemDef } from "../runtime/api"
import type { DraftStore } from "./draft"

/* Metadata vocabulary of the designers, and the entity actions shared by the explorer and the editors. */

export const TYPES: { value: FieldType; label: string }[] = [
  { value: "text", label: "Metin" },
  { value: "longText", label: "Uzun metin" },
  { value: "integer", label: "Tam sayı" },
  { value: "decimal", label: "Ondalık sayı" },
  { value: "date", label: "Tarih" },
  { value: "dateTime", label: "Tarih ve saat" },
  { value: "boolean", label: "Evet/hayır" },
  { value: "choice", label: "Seçim" },
  { value: "reference", label: "Referans (başka kayıt)" },
]
export const SCOPES: { value: EntityDef["scope"]; label: string }[] = [
  { value: "global", label: "Tüm kurum" },
  { value: "company", label: "Firma" },
  { value: "location", label: "Lokasyon" },
  { value: "plant", label: "Plant" },
]
export const typeLabel = (t: FieldType) => TYPES.find((x) => x.value === t)?.label ?? t
export const scopeLabel = (s: EntityDef["scope"]) => SCOPES.find((x) => x.value === s)?.label ?? s
export const keyOk = (k: string) => /^[a-z][a-z0-9_]{0,29}$/.test(k)

/** "Sipariş no" → "siparis_no" (a key suggestion from a label). */
export const toKey = (label: string) =>
  label
    .toLocaleLowerCase("tr-TR")
    .replace(/[çğıöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" })[c]!)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "f_$1")
    .slice(0, 30)

/** Asks for a name and key and adds the entity to the draft; returns its key. */
export async function newEntity(store: DraftStore, parent?: string): Promise<string | null> {
  const name = signal("")
  const k = signal("")
  const ok = await formDialog({
    heading: parent ? "Yeni detay entity" : "Yeni entity",
    submitText: "Ekle",
    body: () => html`<bz-form-layout columns="2" min-column-width="12rem">
      <bz-input label="Ad (tekil)" required .value=${name} @input=${(e: Event) => {
        name.set((e.currentTarget as HTMLInputElement).value)
        k.set(toKey(name()))
      }}></bz-input>
      ${textField("Anahtar", k, { required: true, hint: "Tablo adı olur; sonradan değişmez." })}
    </bz-form-layout>`,
    submit: async () => {
      if (!keyOk(k())) throw new Error("Anahtar küçük harf, rakam ve _ içermeli, harfle başlamalı.")
      if (store.def()!.entities.some((e) => e.key === k())) throw new Error("Bu anahtar kullanılıyor.")
      store.update((a) =>
        a.entities.push({ key: k(), name: name().trim(), scope: "global", parent, fields: [{ key: "ad", label: "Ad", type: "text", required: true }] }),
      )
    },
  })
  return ok ? k() : null
}

/** Removes an entity from the draft after a confirmation; refuses while others use it. */
export async function removeEntity(store: DraftStore, key: string) {
  const def = store.def()!
  const e = def.entities.find((x) => x.key === key)
  if (!e) return false
  const used = def.entities.filter((x) => x.parent === key || x.fields.some((f) => f.reference === key)).map((x) => x.name)
  if (used.length) {
    await dialogs.alert({ heading: "Kaldırılamaz", message: `${e.name} şunlarda kullanılıyor: ${used.join(", ")}.` })
    return false
  }
  const published = !!store.installedEntity(key)
  const forms = (def.forms ?? []).filter((f) => f.entity === key)
  const lists = (def.lists ?? []).filter((l) => l.entity === key)
  const message = [
    `${e.name} taslaktan kaldırılsın mı?`,
    forms.length ? `Formları da kaldırılır: ${forms.map((f) => f.name).join(", ")}.` : "",
    lists.length ? `Listeleri de kaldırılır: ${lists.map((l) => l.name).join(", ")}.` : "",
    published ? "Yayınlanırsa tablosu ve verileri silinir." : "",
  ].filter(Boolean).join(" ")
  if (!(await dialogs.confirm({ heading: "Entity'yi kaldır", message, confirmText: "Kaldır", cancelText: "Vazgeç", variant: "danger" }))) return false
  store.update((a) => {
    a.entities = a.entities.filter((x) => x.key !== key)
    const gone = { lists: new Set(lists.map((l) => l.key)), forms: new Set(forms.map((f) => f.key)) }
    if (a.forms) a.forms = a.forms.filter((f) => f.entity !== key)
    if (a.lists) a.lists = a.lists.filter((l) => l.entity !== key)
    dropFromMenu(a, (m) => (!!m.list && gone.lists.has(m.list)) || (!!m.form && gone.forms.has(m.form)))
  })
  return true
}

/** Menu items (groups included) whose target matches, at any depth. */
export function menuItems(menu: MenuItemDef[] | undefined, match: (m: MenuItemDef) => boolean): MenuItemDef[] {
  return (menu ?? []).flatMap((m) => [...(match(m) ? [m] : []), ...menuItems(m.items, match)])
}
/** Removes the menu items that match (their groups stay, even when empty). */
export function dropFromMenu(a: AppDef, match: (m: MenuItemDef) => boolean) {
  const prune = (items: MenuItemDef[]): MenuItemDef[] =>
    items.filter((m) => !match(m)).map((m) => (m.items ? { ...m, items: prune(m.items) } : m))
  if (a.menu) a.menu = prune(a.menu)
}
const menuNote = (items: MenuItemDef[]) => (items.length ? ` Menüden de çıkar: ${items.map((m) => m.label).join(", ")}.` : "")

/** Asks for a name, key and entity and adds a form with all of the entity's fields; returns its key. */
export async function newForm(store: DraftStore, entity?: string): Promise<string | null> {
  const def = store.def()!
  const forms = def.forms ?? []
  const target = signal(entity ?? def.entities.find((e) => !e.parent)?.key ?? def.entities[0]?.key ?? "")
  const entityName = () => def.entities.find((e) => e.key === target())?.name ?? ""
  // Suggested from the entity: "Sipariş" / siparis, then "Sipariş 2" / siparis_2…
  const suggest = () => {
    const base = toKey(entityName()) || "form"
    let k = base
    for (let i = 2; forms.some((f) => f.key === k); i++) k = `${base.slice(0, 27)}_${i}`
    return { key: k, name: k === base ? entityName() : `${entityName()} ${k.slice(base.length + 1)}` }
  }
  const name = signal(suggest().name)
  const key = signal(suggest().key)
  let touched = false
  if (!def.entities.length) {
    await dialogs.alert({ heading: "Yeni form", message: "Önce bir entity ekleyin: form bir entity'nin kayıtlarını gösterir." })
    return null
  }
  const ok = await formDialog({
    heading: "Yeni form",
    submitText: "Oluştur",
    body: () => html`<bz-form-layout columns="2" min-column-width="12rem">
      <bz-combobox label="Entity" required .value=${target} @change=${(e: CustomEvent<{ value: string }>) => {
        target.set(e.detail.value)
        if (touched) return
        const next = suggest()
        name.set(next.name)
        key.set(next.key)
      }}>
        ${def.entities.map((e) => html`<bz-option value=${e.key}>${e.name}${e.parent ? " (detay)" : ""}</bz-option>`)}
      </bz-combobox>
      <bz-input label="Ad" required .value=${name} @input=${(e: Event) => {
        touched = true
        name.set((e.currentTarget as HTMLInputElement).value)
        key.set(toKey(name()))
      }}></bz-input>
      ${textField("Anahtar", key, { required: true, hint: "Menüler formu bu anahtarla açar." })}
    </bz-form-layout>`,
    submit: async () => {
      if (!keyOk(key())) throw new Error("Anahtar küçük harf, rakam ve _ içermeli, harfle başlamalı.")
      if (forms.some((f) => f.key === key())) throw new Error("Bu anahtarla bir form var.")
      if (!name().trim()) throw new Error("Ad gerekli.")
      const e = def.entities.find((x) => x.key === target())
      if (!e) throw new Error("Entity seçin.")
      store.update((a) => (a.forms = [...(a.forms ?? []), { key: key(), name: name().trim(), entity: e.key, sections: [{ fields: e.fields.map((f) => f.key), columns: 2 }] }]))
    },
  })
  return ok ? key() : null
}

export async function removeForm(store: DraftStore, key: string) {
  const def = store.def()!
  const f = def.forms?.find((x) => x.key === key)
  if (!f) return false
  const inMenu = menuItems(def.menu, (m) => m.form === key)
  if (!(await dialogs.confirm({ heading: "Formu kaldır", message: `${f.name} formu kaldırılsın mı?${menuNote(inMenu)}`, confirmText: "Kaldır", cancelText: "Vazgeç", variant: "danger" }))) return false
  store.update((a) => {
    a.forms = (a.forms ?? []).filter((x) => x.key !== key)
    // Lists that opened their records in it fall back to the entity's first form.
    for (const l of a.lists ?? []) if (l.form === key) l.form = undefined
    dropFromMenu(a, (m) => m.form === key)
  })
  return true
}

/** Asks for a name, key and entity and adds a list with the entity's default columns; returns its key. */
export async function newList(store: DraftStore, entity?: string): Promise<string | null> {
  const def = store.def()!
  const lists = def.lists ?? []
  if (!def.entities.length) {
    await dialogs.alert({ heading: "Yeni liste", message: "Önce bir entity ekleyin: liste bir entity'nin kayıtlarını gösterir." })
    return null
  }
  const target = signal(entity ?? def.entities.find((e) => !e.parent)?.key ?? def.entities[0].key)
  const entityOf = () => def.entities.find((e) => e.key === target())
  const suggest = () => {
    const e = entityOf()
    const base = toKey(e ? plural(e) : "") || "liste"
    let k = base
    for (let i = 2; lists.some((l) => l.key === k); i++) k = `${base.slice(0, 27)}_${i}`
    return { key: k, name: e ? (k === base ? plural(e) : `${plural(e)} ${k.slice(base.length + 1)}`) : "" }
  }
  const name = signal(suggest().name)
  const key = signal(suggest().key)
  let touched = false
  const ok = await formDialog({
    heading: "Yeni liste",
    submitText: "Oluştur",
    body: () => html`<bz-form-layout columns="2" min-column-width="12rem">
      <bz-combobox label="Entity" required .value=${target} @change=${(e: CustomEvent<{ value: string }>) => {
        target.set(e.detail.value)
        if (touched) return
        const next = suggest()
        name.set(next.name)
        key.set(next.key)
      }}>
        ${def.entities.map((e) => html`<bz-option value=${e.key}>${e.name}${e.parent ? " (detay)" : ""}</bz-option>`)}
      </bz-combobox>
      <bz-input label="Ad" required .value=${name} @input=${(e: Event) => {
        touched = true
        name.set((e.currentTarget as HTMLInputElement).value)
        key.set(toKey(name()))
      }}></bz-input>
      ${textField("Anahtar", key, { required: true, hint: "Menüler listeyi bu anahtarla açar." })}
    </bz-form-layout>`,
    submit: async () => {
      if (!keyOk(key())) throw new Error("Anahtar küçük harf, rakam ve _ içermeli, harfle başlamalı.")
      if (lists.some((l) => l.key === key())) throw new Error("Bu anahtarla bir liste var.")
      if (!name().trim()) throw new Error("Ad gerekli.")
      const e = entityOf()
      if (!e) throw new Error("Entity seçin.")
      store.update((a) => (a.lists = [...(a.lists ?? []), { key: key(), name: name().trim(), entity: e.key, columns: defaultColumns(e) }]))
    },
  })
  return ok ? key() : null
}

export async function removeList(store: DraftStore, key: string) {
  const def = store.def()!
  const l = def.lists?.find((x) => x.key === key)
  if (!l) return false
  const inMenu = menuItems(def.menu, (m) => m.list === key)
  if (!(await dialogs.confirm({ heading: "Listeyi kaldır", message: `${l.name} listesi kaldırılsın mı?${menuNote(inMenu)}`, confirmText: "Kaldır", cancelText: "Vazgeç", variant: "danger" }))) return false
  store.update((a) => {
    a.lists = (a.lists ?? []).filter((x) => x.key !== key)
    dropFromMenu(a, (m) => m.list === key)
  })
  return true
}
