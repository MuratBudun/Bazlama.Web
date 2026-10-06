import { computed, html, signal } from "@bazlama/core"
import { dialogs, icon, toast } from "@bazlama/headless"
import { api, ApiError, errorText } from "../api"
import { checkField, loader } from "../management/ui"
import { forgetRuntimeApps, loadRuntimeApps, type AppDef } from "../runtime/api"
import type { CodeDiagnostic } from "./code"

/*
 * An app's draft definition (entities, fields, list and form layout): loaded and saved as a
 * whole. The server validates it and says what is wrong; it can be saved with errors, it
 * cannot be published with them.
 */

export interface Draft {
  definition: AppDef
  isDraft: boolean
  installedVersion: string | null
  /** The published definition (what has tables and columns already). */
  installed: AppDef | null
  errors: string[]
}
interface Plan {
  fromVersion: string | null
  toVersion: string
  changes: { description: string; destructive: boolean }[]
  errors: string[]
  hasDestructive: boolean
}

export function draftStore(appKey: string, o: { saved?: () => unknown } = {}) {
  const data = loader(() => api.get<Draft>(`/development/apps/${appKey}/draft`))
  const def = signal<AppDef | null>(null)
  const errors = signal<string[]>([])
  const savedJson = signal("")
  const dirty = computed(() => def() !== null && JSON.stringify(def()) !== savedJson())
  const saved = computed(() => (savedJson() ? (JSON.parse(savedJson()) as AppDef) : null))
  /** Whether a part of the definition (an entity, the app's own properties) has unsaved changes. */
  const partDirty = (part: (d: AppDef) => unknown) => {
    const now = def()
    const was = saved()
    return now !== null && was !== null && JSON.stringify(part(now)) !== JSON.stringify(part(was))
  }
  const busy = signal(false)
  const reload = async () => {
    await data.reload()
    const d = data.data()
    if (!d) return
    def.set(structuredClone(d.definition))
    savedJson.set(JSON.stringify(d.definition))
    errors.set(d.errors)
  }
  const ready = reload()
  const save = async () => {
    if (!dirty()) return
    busy.set(true)
    try {
      const json = JSON.stringify(def())
      const r = await api.put<{ errors: string[] }>(`/development/apps/${appKey}/draft`, def())
      savedJson.set(json)
      errors.set(r.errors)
      await data.reload()
      toast.success(r.errors.length ? "Taslak kaydedildi (düzeltilmesi gereken noktalar var)." : "Taslak kaydedildi.")
      await o.saved?.()
    } catch (e) {
      toast.error(errorText(e))
      throw e
    } finally {
      busy.set(false)
    }
  }
  /** Changes the definition (immutably; signals see a new object). */
  const update = (change: (d: AppDef) => void) => {
    const next = structuredClone(def()!)
    change(next)
    def.set(next)
  }
  const info = data.data
  /** The published definition of an entity (its fields are columns already). */
  const installedEntity = (key: string) => info()?.installed?.entities.find((e) => e.key === key)
  return { appKey, data, info, def, errors, dirty, partDirty, busy, ready, save, update, reload, installedEntity }
}

export type DraftStore = ReturnType<typeof draftStore>

export async function discardDraft(store: DraftStore) {
  if (!(await dialogs.confirm({ heading: "Taslağı at", message: "Taslaktaki değişiklikler silinir; yayındaki tanıma dönülür.", confirmText: "At", cancelText: "Vazgeç", variant: "danger" }))) return false
  try {
    await api.delete(`/development/apps/${store.appKey}/draft`)
    toast.success("Taslak atıldı.")
    await store.reload()
    return true
  } catch (e) {
    toast.error(errorText(e))
    return false
  }
}

/** Version → the plan (schema and code) → publish. Save the draft and the code first. */
export async function publishDraft(store: DraftStore) {
  const appKey = store.appKey
  const installed = store.info()?.installedVersion
  const next = () => {
    if (!installed) return "1.0.0"
    const [a, b] = installed.split(".").map(Number)
    return `${a}.${b + 1}.0`
  }
  const version = signal(next())
  const plan = signal<{ plan: Plan; code: { success: boolean; diagnostics: CodeDiagnostic[] } | null } | null>(null)
  const error = signal("")
  const confirmDrop = signal(false)
  const busy = signal(false)
  const check = async () => {
    error.set("")
    plan.set(null)
    try {
      plan.set(await api.post(`/development/apps/${appKey}/publish/plan`, { version: version() }))
    } catch (e) {
      error.set(errorText(e))
    }
  }
  void check()
  const published = await dialogs.open<boolean>({
    heading: "Yayınla",
    size: "lg",
    content: () => html`<div class="stack">
      <p class="muted">Taslak değiştirilemez bir versiyon olarak kurulur: tablolar güncellenir, kod yeni tanımla derlenir.</p>
      <div class="row">
        <bz-input label="Versiyon" .value=${version} @input=${(e: Event) => version.set((e.currentTarget as HTMLInputElement).value)}></bz-input>
        <bz-button @click=${check}>Planı yenile</bz-button>
      </div>
      ${() => (error() ? html`<bz-alert variant="danger">${error()}</bz-alert>` : null)}
      ${() => {
        const p = plan()
        if (!p) return null
        const codeErrors = p.code?.diagnostics.filter((d) => d.severity === "error") ?? []
        return html`<div class="stack plan">
          ${p.plan.errors.length ? html`<bz-alert variant="danger" heading="Yayınlanamaz"><ul>${p.plan.errors.map((e) => html`<li>${e}</li>`)}</ul></bz-alert>` : null}
          ${p.code && !p.code.success
            ? html`<bz-alert variant="danger" heading="Kod yeni tanımla derlenmiyor"><ul>${codeErrors.slice(0, 10).map((d) => html`<li>${d.path ? `${d.path}:${d.line} — ` : ""}${d.message}</li>`)}</ul></bz-alert>`
            : p.code ? html`<bz-alert variant="success">Kod yeni tanımla derleniyor.</bz-alert>` : null}
          ${p.plan.errors.length ? null : html`<h2>${p.plan.fromVersion ? `${p.plan.fromVersion} → ${p.plan.toVersion}` : `${p.plan.toVersion} (ilk yayın)`}</h2>
            <ul class="changes">${p.plan.changes.map((c) => html`<li class=${c.destructive ? "destructive" : ""}>${c.destructive ? icon("alert", { size: 14 }) : icon("check", { size: 14 })} ${c.description}</li>`)}</ul>
            ${p.plan.changes.length === 0 ? html`<p class="muted">Veritabanında değişiklik yok.</p>` : null}
            ${p.plan.hasDestructive ? html`${checkField("Veri kaybını anlıyorum, devam et", confirmDrop)}` : null}`}
        </div>`
      }}
    </div>`,
    footer: (ref) => html`<bz-button @click=${() => void ref.close(false)}>Vazgeç</bz-button>
      <bz-button variant="primary" ?loading=${busy}
        ?disabled=${() => { const p = plan(); return !p || p.plan.errors.length > 0 || (p.code !== null && !p.code.success) || (p.plan.hasDestructive && !confirmDrop()) }}
        @click=${async () => {
          busy.set(true)
          try {
            await api.post(`/development/apps/${appKey}/publish`, { version: version(), confirmDestructive: confirmDrop() })
            void ref.close(true)
          } catch (e) {
            error.set(e instanceof ApiError ? e.errors.join(" ") : errorText(e))
          } finally {
            busy.set(false)
          }
        }}>Yayınla</bz-button>`,
  })
  if (published) {
    toast.success(`v${version()} yayınlandı.`)
    forgetRuntimeApps()
    await loadRuntimeApps()
    await store.reload()
  }
  return !!published
}
