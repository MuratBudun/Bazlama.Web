import type { AppDef, EntityDef, FormDef, ListDef, MenuItemDef } from "../runtime/api"
import { SCOPES, TYPES } from "./meta"

/*
 * The code view of the designers: each part of a draft (the app, an entity, a list, a form,
 * the menu, or the whole definition) as JSON, with a JSON schema made from the current draft.
 * The schema does the completion and the checking in Monaco: field types, scopes, and the keys
 * that exist (a list's columns are its entity's fields, a menu item opens an existing list…).
 * The server's validator stays the judge; this only helps while typing.
 */

type Schema = Record<string, unknown>

/** Where a part lives in the draft and how a new value goes back. */
export interface DraftPart {
  /** Unique per part; the Monaco model's name. */
  id: string
  get(d: AppDef): unknown
  set(d: AppDef, value: unknown): void
  schema(d: AppDef): Schema
  /** The value its "key" must keep: renaming updates references, the designer does it. */
  lockedKey?(d: AppDef): string
}

const KEY = { type: "string", pattern: "^[a-z][a-z0-9_]{0,29}$", description: "Anahtar: küçük harf, rakam ve _; harfle başlar." }
const ICON = { type: "string", description: "İkon adı (örn. cart, users, box, file-text)." }
const choose = (values: string[], description: string, labels?: string[]) =>
  values.length ? { type: "string", enum: values, description, ...(labels ? { enumDescriptions: labels } : {}) } : { type: "string", description }

const masters = (d: AppDef) => d.entities.filter((e) => !e.parent)
const entityOf = (d: AppDef, key: string | undefined) => d.entities.find((e) => e.key === key)
const fieldKeys = (e: EntityDef | undefined) => e?.fields.map((f) => f.key) ?? []
const fieldLabels = (e: EntityDef | undefined) => e?.fields.map((f) => f.label) ?? []

// ── Schemas ──────────────────────────────────────────────────────────────

function fieldSchema(d: AppDef): Schema {
  return {
    type: "object",
    required: ["key", "label", "type"],
    additionalProperties: false,
    properties: {
      key: { ...KEY, description: "Alanın anahtarı (kolon adı olur). Yayınlanmış bir alanın anahtarı değişmez." },
      label: { type: "string", description: "Formda ve listede görünen ad." },
      type: choose(TYPES.map((t) => t.value), "Alanın tipi.", TYPES.map((t) => t.label)),
      required: { type: "boolean", description: "Zorunlu alan." },
      hint: { type: "string", description: "Alanın altında görünen yardım metni." },
      maxLength: { type: "integer", minimum: 1, maximum: 4000, description: "Metin: en fazla karakter (varsayılan 200)." },
      precision: { type: "integer", minimum: 1, maximum: 28, description: "Ondalık sayı: toplam basamak (varsayılan 18)." },
      scale: { type: "integer", minimum: 0, maximum: 10, description: "Ondalık sayı: ondalık basamak (varsayılan 2)." },
      choices: {
        type: "array",
        description: "Seçim: seçenekler (değer saklanır, etiket gösterilir).",
        items: {
          type: "object",
          required: ["value", "label"],
          additionalProperties: false,
          properties: { value: { type: "string" }, label: { type: "string" } },
        },
      },
      reference: choose(masters(d).map((e) => e.key), "Referans: kaydı seçilen entity.", masters(d).map((e) => e.name)),
    },
  }
}

function entitySchema(d: AppDef, e: EntityDef | undefined): Schema {
  const others = masters(d).filter((x) => x.key !== e?.key)
  return {
    type: "object",
    required: ["key", "name", "scope", "fields"],
    additionalProperties: false,
    properties: {
      key: { ...KEY, description: "Entity anahtarı (tablo adı olur). Burada değiştirilemez." },
      name: { type: "string", description: "Tekil ad: \"Sipariş\"." },
      pluralName: { type: "string", description: "Çoğul ad: \"Siparişler\" (menü, liste)." },
      icon: ICON,
      scope: choose(SCOPES.map((s) => s.value), "Kaydın ait olduğu yer; kayıtlar buna göre süzülür.", SCOPES.map((s) => s.label)),
      periodBound: { type: "boolean", description: "Kayıtlar döneme bağlı; kapalı dönemde değiştirilemez." },
      parent: choose(others.map((x) => x.key), "Detay entity ise üst entity'si (master–detail).", others.map((x) => x.name)),
      titleField: choose(fieldKeys(e), "Kaydı adlandıran alan (referanslarda görünür).", fieldLabels(e)),
      fields: { type: "array", description: "Alanlar.", items: fieldSchema(d) },
    },
  }
}

function listSchema(d: AppDef, l: ListDef | undefined): Schema {
  const e = entityOf(d, l?.entity)
  const forms = (d.forms ?? []).filter((f) => f.entity === l?.entity)
  return {
    type: "object",
    required: ["key", "name", "entity", "columns"],
    additionalProperties: false,
    properties: {
      key: { ...KEY, description: "Liste anahtarı. Burada değiştirilemez." },
      name: { type: "string", description: "Listenin adı (menüde ve başlıkta)." },
      entity: choose(masters(d).map((x) => x.key), "Listelenen entity.", masters(d).map((x) => x.name)),
      columns: { type: "array", uniqueItems: true, description: "Sütunlar (alan anahtarları, sırasıyla).", items: choose(fieldKeys(e), "Alan.", fieldLabels(e)) },
      sortField: choose([...fieldKeys(e), "created_at", "updated_at"], "Varsayılan sıralama alanı (yoksa en yeni kayıt önce)."),
      sortDescending: { type: "boolean", description: "Azalan sıra." },
      form: choose(forms.map((f) => f.key), "Kayıtların açıldığı form (yoksa entity'nin ilk formu).", forms.map((f) => f.name)),
    },
  }
}

function formSchema(d: AppDef, f: FormDef | undefined): Schema {
  const e = entityOf(d, f?.entity)
  return {
    type: "object",
    required: ["key", "name", "entity", "sections"],
    additionalProperties: false,
    properties: {
      key: { ...KEY, description: "Form anahtarı. Burada değiştirilemez." },
      name: { type: "string", description: "Formun adı." },
      entity: choose(masters(d).map((x) => x.key), "Formun kayıtlarını düzenlediği entity.", masters(d).map((x) => x.name)),
      sections: {
        type: "array",
        description: "Bölümler; detay entity'ler bölümlerin altında listelenir.",
        items: {
          type: "object",
          required: ["fields"],
          additionalProperties: false,
          properties: {
            title: { type: "string", description: "Bölüm başlığı." },
            columns: { type: "integer", minimum: 1, maximum: 4, description: "Sütun sayısı (varsayılan 2)." },
            fields: { type: "array", uniqueItems: true, description: "Bölümdeki alanlar.", items: choose(fieldKeys(e), "Alan.", fieldLabels(e)) },
          },
        },
      },
    },
  }
}

function menuSchema(d: AppDef): Schema {
  const lists = d.lists ?? []
  const forms = d.forms ?? []
  return {
    type: "array",
    description: "Uygulamanın menüsü: gruplar (items) ve bir liste ya da yeni kayıt formu açan öğeler.",
    items: { $ref: "#/definitions/item" },
    definitions: {
      item: {
        type: "object",
        required: ["label"],
        additionalProperties: false,
        properties: {
          label: { type: "string", description: "Menüde görünen ad." },
          icon: ICON,
          list: choose(lists.map((l) => l.key), "Açılan liste.", lists.map((l) => l.name)),
          form: choose(forms.map((f) => f.key), "Yeni kayıt için açılan form.", forms.map((f) => f.name)),
          items: { type: "array", description: "Grubun öğeleri.", items: { $ref: "#/definitions/item" } },
        },
      },
    },
  }
}

const APP_PROPERTIES = {
  key: { ...KEY, description: "Uygulama anahtarı. Değiştirilemez." },
  name: { type: "string", description: "Uygulamanın adı." },
  version: { type: "string", description: "Yayınlanan versiyon (yayınlarken verilir)." },
  description: { type: "string", description: "Kısa açıklama (ana ekrandaki kartta görünür)." },
  icon: ICON,
}

function definitionSchema(d: AppDef): Schema {
  const menu = menuSchema(d)
  return {
    type: "object",
    required: ["key", "name", "entities"],
    additionalProperties: false,
    definitions: menu.definitions,
    properties: {
      ...APP_PROPERTIES,
      entities: { type: "array", items: entitySchema(d, undefined) },
      lists: { type: "array", items: listSchema(d, undefined) },
      forms: { type: "array", items: formSchema(d, undefined) },
      menu: { ...menu, definitions: undefined },
    },
  }
}

// ── Parts ────────────────────────────────────────────────────────────────

/** Replaces the item with `key` in a keyed array. */
function replaceKeyed<T extends { key: string }>(list: T[] | undefined, key: string, value: T) {
  const i = list?.findIndex((x) => x.key === key) ?? -1
  if (list && i >= 0) list[i] = value
}

export const parts = {
  app: (): DraftPart => ({
    id: "app",
    get: (d) => ({ key: d.key, name: d.name, version: d.version, description: d.description, icon: d.icon }),
    set: (d, v) => {
      const x = v as Partial<AppDef>
      d.name = x.name ?? ""
      d.description = x.description || undefined
      d.icon = x.icon || undefined
    },
    schema: () => ({ type: "object", required: ["key", "name"], additionalProperties: false, properties: APP_PROPERTIES }),
    lockedKey: (d) => d.key,
  }),
  entity: (key: string): DraftPart => ({
    id: `entity-${key}`,
    get: (d) => entityOf(d, key),
    set: (d, v) => replaceKeyed(d.entities, key, v as EntityDef),
    schema: (d) => entitySchema(d, entityOf(d, key)),
    lockedKey: () => key,
  }),
  list: (key: string): DraftPart => ({
    id: `list-${key}`,
    get: (d) => d.lists?.find((l) => l.key === key),
    set: (d, v) => replaceKeyed(d.lists, key, v as ListDef),
    schema: (d) => listSchema(d, d.lists?.find((l) => l.key === key)),
    lockedKey: () => key,
  }),
  form: (key: string): DraftPart => ({
    id: `form-${key}`,
    get: (d) => d.forms?.find((f) => f.key === key),
    set: (d, v) => replaceKeyed(d.forms, key, v as FormDef),
    schema: (d) => formSchema(d, d.forms?.find((f) => f.key === key)),
    lockedKey: () => key,
  }),
  menu: (): DraftPart => ({
    id: "menu",
    get: (d) => d.menu ?? [],
    set: (d, v) => {
      d.menu = v as MenuItemDef[]
    },
    schema: menuSchema,
  }),
  /** The whole definition (the app key stays). */
  definition: (): DraftPart => ({
    id: "definition",
    get: (d) => d,
    set: (d, v) => {
      const x = v as AppDef
      for (const k of Object.keys(d) as (keyof AppDef)[]) if (k !== "key") delete d[k]
      Object.assign(d, x, { key: d.key })
    },
    schema: definitionSchema,
    lockedKey: (d) => d.key,
  }),
}
