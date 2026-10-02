import { signal } from "@bazlama/core"
import { api } from "../api"

/** App metadata as the server serves it (Bazlama.Engine.Metadata, camelCase JSON). */
export type FieldType = "text" | "longText" | "integer" | "decimal" | "date" | "dateTime" | "boolean" | "choice" | "reference"

export interface FieldDef {
  key: string
  label: string
  type: FieldType
  required?: boolean
  hint?: string
  maxLength?: number
  precision?: number
  scale?: number
  choices?: { value: string; label: string }[]
  reference?: string
}
export interface EntityDef {
  key: string
  name: string
  pluralName?: string
  icon?: string
  scope: "global" | "company" | "location" | "plant"
  periodBound?: boolean
  parent?: string
  titleField?: string
  fields: FieldDef[]
}
/** A record list of an entity. An entity may have several lists, or none. */
export interface ListDef {
  key: string
  name: string
  entity: string
  columns: string[]
  sortField?: string
  sortDescending?: boolean
  /** The form its records open in (default: the entity's first form). */
  form?: string
}
/** A menu entry: a group (`items`), or an item opening a list or a new record's form. */
export interface MenuItemDef {
  label: string
  icon?: string
  list?: string
  form?: string
  items?: MenuItemDef[]
}
export interface FormSection {
  title?: string
  fields: string[]
  columns?: number
}
/** A record form of an entity. An entity may have several forms, or none. */
export interface FormDef {
  key: string
  name: string
  entity: string
  sections: FormSection[]
}
export interface AppDef {
  key: string
  name: string
  version: string
  description?: string
  icon?: string
  entities: EntityDef[]
  forms?: FormDef[]
  lists?: ListDef[]
  menu?: MenuItemDef[]
}
export interface RuntimeAppInfo {
  key: string
  name: string
  version: string
  description: string | null
  icon: string | null
  entities: { key: string; name: string; plural: string; icon: string | null }[]
  /** The menu as far as the user may read (the server filters it). */
  menu: RuntimeMenuItem[]
}
export interface RuntimeMenuItem {
  label: string
  icon: string | null
  entity: string | null
  list: string | null
  form: string | null
  items: RuntimeMenuItem[] | null
}
export interface RuntimeApp {
  definition: AppDef
  access: Record<string, { canRead: boolean; canWrite: boolean }>
  /** Entity key → the app code's record actions (form buttons). */
  actions: Record<string, { key: string; label: string; icon: string | null; confirm: string | null }[]>
}

/** A record: system values (id, rowVersion, createdAt…) and the field values; `_titles` names the referenced records. */
export type DataRecord = Record<string, unknown> & { id: string; rowVersion: number; _titles?: Record<string, string | null> }

/** The apps of the menu (reloaded at sign-in and after an install). */
export const runtimeApps = signal<RuntimeAppInfo[]>([])
export const loadRuntimeApps = async () => runtimeApps.set(await api.get<RuntimeAppInfo[]>("/runtime/apps"))

const cache = new Map<string, Promise<RuntimeApp>>()
export function runtimeApp(key: string) {
  let app = cache.get(key)
  if (!app) {
    app = api.get<RuntimeApp>(`/runtime/apps/${key}`)
    app.catch(() => cache.delete(key))
    cache.set(key, app)
  }
  return app
}
/** After an install the definitions change. */
export const forgetRuntimeApps = () => cache.clear()

/**
 * Where the Runtime pages live and how they load an app: the platform's Runtime, or (in a
 * preview tab) a draft's preview, whose records live in tables of its own.
 */
export const runtimeConfig: { base: string; load: (key: string) => Promise<RuntimeApp> } = {
  base: "/apps",
  load: (key) => runtimeApp(key),
}

/** A draft's preview (developers only): the app as Runtime gets it, plus its menu and source app. */
export interface PreviewApp extends RuntimeApp {
  menu: RuntimeMenuItem[]
  source: string
}
export const previewApp = (key: string) => api.get<PreviewApp>(`/runtime/previews/${key}`)

export const entityOf = (app: AppDef, key: string) => app.entities.find((e) => e.key === key)
export const plural = (e: EntityDef) => e.pluralName ?? e.name
export const titleField = (e: EntityDef) => e.titleField ?? e.fields.find((f) => f.type === "text")?.key ?? e.fields[0]?.key
export const childrenOf = (app: AppDef, e: EntityDef) => app.entities.filter((x) => x.parent === e.key)
/** Columns of an entity without a list: its first six fields that fit a grid. */
export const defaultColumns = (e: EntityDef) => e.fields.filter((f) => f.type !== "longText").slice(0, 6).map((f) => f.key)
export const listsOf = (app: AppDef, e: EntityDef) => (app.lists ?? []).filter((l) => l.entity === e.key)
/** The list a page shows: the given one, else the entity's first list, else default columns (newest first). */
export function listOf(app: AppDef, e: EntityDef, key?: string | null): Omit<ListDef, "key" | "entity"> & { key?: string } {
  const l = (key ? app.lists?.find((x) => x.key === key && x.entity === e.key) : undefined) ?? listsOf(app, e)[0]
  if (!l) return { name: plural(e), columns: defaultColumns(e) }
  return { ...l, columns: l.columns.length ? l.columns : defaultColumns(e) }
}
export const listColumns = (app: AppDef, e: EntityDef, key?: string | null) => listOf(app, e, key).columns
export const formsOf = (app: AppDef, e: EntityDef) => (app.forms ?? []).filter((f) => f.entity === e.key)
/** The sections a record is shown with: the given form, else the entity's first form, else all fields in one section. */
export const formSections = (app: AppDef, e: EntityDef, form?: string | null): FormSection[] => {
  const f = (form ? app.forms?.find((x) => x.key === form && x.entity === e.key) : undefined) ?? formsOf(app, e)[0]
  return f?.sections.length ? f.sections : [{ fields: e.fields.map((x) => x.key) }]
}

const dataPath = (app: string, entity: string) => `/runtime/data/${app}/${entity}`

export const records = {
  list: (app: string, entity: string, q: { search?: string; sort?: string; desc?: boolean; skip?: number; take?: number; parent?: string }) => {
    const p = new URLSearchParams()
    if (q.search) p.set("q", q.search)
    if (q.sort) p.set("sort", q.sort)
    if (q.desc) p.set("desc", "true")
    p.set("skip", String(q.skip ?? 0))
    p.set("take", String(q.take ?? 50))
    if (q.parent) p.set("parent", q.parent)
    return api.get<{ items: DataRecord[]; total: number }>(`${dataPath(app, entity)}?${p}`)
  },
  get: (app: string, entity: string, id: string) => api.get<DataRecord>(`${dataPath(app, entity)}/${id}`),
  create: (app: string, entity: string, values: Record<string, unknown>, parentId?: string) =>
    api.post<{ id: string }>(dataPath(app, entity), { values, parentId: parentId ?? null }),
  update: (app: string, entity: string, id: string, values: Record<string, unknown>, rowVersion: number) =>
    api.put<{ id: string }>(`${dataPath(app, entity)}/${id}`, { values, rowVersion }),
  delete: (app: string, entity: string, id: string) => api.delete(`${dataPath(app, entity)}/${id}`),
  action: (app: string, entity: string, id: string, action: string) =>
    api.post<{ message: string | null }>(`${dataPath(app, entity)}/${id}/actions/${encodeURIComponent(action)}`),
}
