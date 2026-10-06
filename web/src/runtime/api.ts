import { signal } from "@bazlama/core"
import { api } from "../api"

/** App metadata as the server serves it (Bazlama.Engine.Metadata, camelCase JSON). */
export type FieldType =
  | "text" | "longText" | "integer" | "decimal" | "date" | "dateTime" | "boolean" | "choice" | "reference"
  // Organization pickers, in modals only: one of the user's companies, locations, plants or periods.
  | "company" | "location" | "plant" | "period"

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
/** A field on a form: its key, or the key with how it is laid out ({ field, span }). */
export type FormItem = string | { field: string; span?: number }
export interface FormSection {
  title?: string
  fields: FormItem[]
  columns?: number
}
export const itemKey = (item: FormItem) => (typeof item === "string" ? item : item.field)
/** Columns the field takes, when the form says so (otherwise the field's type decides). */
export const itemSpan = (item: FormItem) => (typeof item === "string" ? undefined : item.span)
/** The shortest way to write it: the key alone when nothing else is set. */
export const formItem = (field: string, span?: number): FormItem => (span ? { field, span } : field)
/** A record form of an entity. An entity may have several forms, or none. */
export interface FormDef {
  key: string
  name: string
  entity: string
  sections: FormSection[]
  /** The form's tools menu ("Araçlar"). */
  tools?: FormToolDef[]
}
/** An item of a form's tools menu: it calls a method of the form's code with the form as it is on the screen. */
export interface FormToolDef {
  label: string
  icon?: string
  method: string
  /** A question asked before it runs. */
  confirm?: string
}
/** A popup with fields of its own, opened by code (a form's tools). */
export interface ModalDef {
  key: string
  name: string
  fields: FieldDef[]
  sections?: FormSection[]
  /** The text of the button that accepts it (default "Tamam"). */
  okText?: string
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
  modals?: ModalDef[]
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
/** The form a record is shown in: the given one, else the entity's first form (it may have none). */
export const formOf = (app: AppDef, e: EntityDef, form?: string | null): FormDef | undefined =>
  (form ? app.forms?.find((x) => x.key === form && x.entity === e.key) : undefined) ?? formsOf(app, e)[0]
/** The sections a record is shown with: the form's, else all fields in one section. */
export const formSections = (app: AppDef, e: EntityDef, form?: string | null): FormSection[] => {
  const f = formOf(app, e, form)
  return f?.sections.length ? f.sections : [{ fields: e.fields.map((x) => x.key) }]
}
/** The sections a modal is shown with: its own, else all fields in one section. */
export const modalSections = (m: ModalDef): FormSection[] =>
  m.sections?.length ? m.sections : [{ fields: m.fields.map((f) => f.key), columns: m.fields.length > 1 ? 2 : 1 }]

/** A modal the code asked for: what it starts with and, after a refused attempt, what was wrong. */
export interface ModalPrompt {
  key: string
  values: Record<string, unknown>
  titles?: Record<string, string | null> | null
  fieldErrors?: Record<string, string> | null
  errors?: string[] | null
}
/** What a form tool did: the form's values after it, or a modal to show first. */
export interface ToolResult {
  values: Record<string, unknown> | null
  /** Titles of the records the changed reference fields now hold. */
  titles: Record<string, string | null> | null
  message: string | null
  /** The tool asks for the form to be saved. */
  save: boolean
  modal: ModalPrompt | null
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
  /** A form tool, on the form as it is on the screen; `inputs`: what the user entered in the modals it asked for. */
  tool: (app: string, form: string, method: string, body: { values: Record<string, unknown>; id: string | null; parentId: string | null; inputs: Record<string, Record<string, unknown>> }) =>
    api.post<ToolResult>(`/runtime/forms/${app}/${form}/tools/${encodeURIComponent(method)}`, body),
}
