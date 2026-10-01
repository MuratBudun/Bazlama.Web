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
  list?: { columns: string[]; sortField?: string; sortDescending?: boolean }
  form?: { sections: { title?: string; fields: string[]; columns?: number }[] }
}
export interface AppDef {
  key: string
  name: string
  version: string
  description?: string
  icon?: string
  entities: EntityDef[]
}
export interface RuntimeAppInfo {
  key: string
  name: string
  version: string
  description: string | null
  icon: string | null
  entities: { key: string; name: string; plural: string; icon: string | null }[]
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

export const entityOf = (app: AppDef, key: string) => app.entities.find((e) => e.key === key)
export const plural = (e: EntityDef) => e.pluralName ?? e.name
export const titleField = (e: EntityDef) => e.titleField ?? e.fields.find((f) => f.type === "text")?.key ?? e.fields[0]?.key
export const childrenOf = (app: AppDef, e: EntityDef) => app.entities.filter((x) => x.parent === e.key)
export const listColumns = (e: EntityDef) => (e.list?.columns.length ? e.list.columns : e.fields.filter((f) => f.type !== "longText").slice(0, 6).map((f) => f.key))
export const formSections = (e: EntityDef) => (e.form?.sections.length ? e.form.sections : [{ fields: e.fields.map((f) => f.key) }])

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
