import { computed, html, signal, type Signal } from "@bazlama/core"
import { dialogs, icon, toast, type GridColumn } from "@bazlama/headless"
import { definePage, type PageContext } from "@bazlama/router"
import { api, ApiError, errorText } from "../api"
import { checkField, dataGrid, formDialog, loader, loading, numberField, textField } from "../management/ui"
import { forgetRuntimeApps, loadRuntimeApps, type AppDef, type EntityDef, type FieldDef, type FieldType } from "../runtime/api"
import type { CodeDiagnostic } from "./workspace"

/*
 * The designers: an app's draft definition (entities, fields, list and form layout), edited
 * here and published as a version. The draft is saved as a whole; the server validates it and
 * says what is wrong (it can be saved with errors, it cannot be published with them).
 */

interface Draft {
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

const TYPES: { value: FieldType; label: string }[] = [
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
const SCOPES = [
  { value: "global", label: "Tüm kurum" },
  { value: "company", label: "Firma" },
  { value: "location", label: "Lokasyon" },
  { value: "plant", label: "Plant" },
]
const typeLabel = (t: FieldType) => TYPES.find((x) => x.value === t)?.label ?? t
const keyOk = (k: string) => /^[a-z][a-z0-9_]{0,29}$/.test(k)
/** "Sipariş no" → "siparis_no" (a key suggestion from a label). */
const toKey = (label: string) =>
  label
    .toLocaleLowerCase("tr-TR")
    .replace(/[çğıöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" })[c]!)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "f_$1")
    .slice(0, 30)

/** The draft of an app, loaded and saved as a whole. */
function draftStore(appKey: string) {
  const data = loader(() => api.get<Draft>(`/development/apps/${appKey}/draft`))
  const def = signal<AppDef | null>(null)
  const errors = signal<string[]>([])
  let savedJson = ""
  const dirty = computed(() => def() !== null && JSON.stringify(def()) !== savedJson)
  const busy = signal(false)
  const reload = async () => {
    await data.reload()
    const d = data.data()
    if (!d) return
    def.set(structuredClone(d.definition))
    savedJson = JSON.stringify(d.definition)
    errors.set(d.errors)
  }
  void reload()
  const save = async () => {
    busy.set(true)
    try {
      const r = await api.put<{ errors: string[] }>(`/development/apps/${appKey}/draft`, def())
      savedJson = JSON.stringify(def())
      def.set(structuredClone(def()!)) // re-evaluate dirty
      errors.set(r.errors)
      await data.reload()
      toast.success(r.errors.length ? "Taslak kaydedildi (düzeltilmesi gereken noktalar var)." : "Taslak kaydedildi.")
    } catch (e) {
      toast.error(errorText(e))
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
  return { data, def, errors, dirty, busy, save, update, reload }
}

const leaveGuard = (dirty: () => boolean) => async () =>
  !dirty() ||
  dialogs.confirm({ heading: "Kaydedilmemiş tasarım", message: "Taslakta kaydedilmemiş değişiklikler var. Çıkılsın mı?", confirmText: "Çık", cancelText: "Kal", variant: "danger" })

function errorList(errors: () => string[]) {
  return () =>
    errors().length
      ? html`<bz-alert variant="warning" heading=${`Yayınlamadan önce düzeltilmeli (${errors().length})`}><ul class="errors">${errors().map((e) => html`<li>${e}</li>`)}</ul></bz-alert>`
      : null
}

function nav(ctx: PageContext, appKey: string, current: "design" | "code") {
  return html`<div class="row seg" role="group" aria-label="Uygulama">
    <bz-button size="sm" variant=${current === "design" ? "primary" : "ghost"} @click=${() => void ctx.navigate(`/development/apps/${appKey}`)}>${icon("layers")} Tasarım</bz-button>
    <bz-button size="sm" variant=${current === "code" ? "primary" : "ghost"} @click=${() => void ctx.navigate(`/development/apps/${appKey}/code`)}>${icon("code")} Kod</bz-button>
  </div>`
}
export { nav as appNav }

// ── App page ─────────────────────────────────────────────────────────────

export const appDesignPage = definePage({
  title: "Tasarım",
  setup(ctx) {
    const key = ctx.params().app
    const store = draftStore(key)
    ctx.onBeforeLeave(leaveGuard(store.dirty))

    const body = () => {
      const info = store.data.data
      const def = store.def
      const field = (label: string, get: (a: AppDef) => string | undefined, set: (a: AppDef, v: string) => void, attrs: { span?: boolean; hint?: string } = {}) => {
        const s = signal(get(def()!) ?? "")
        return html`<bz-input label=${label} hint=${attrs.hint ?? ""} data-span=${attrs.span ? "full" : null} .value=${s}
          @input=${(e: Event) => {
            const v = (e.currentTarget as HTMLInputElement).value
            s.set(v)
            store.update((a) => set(a, v))
          }}></bz-input>`
      }

      const newEntity = async () => {
        const name = signal("")
        const k = signal("")
        const ok = await formDialog({
          heading: "Yeni entity",
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
            if (def()!.entities.some((e) => e.key === k())) throw new Error("Bu anahtar kullanılıyor.")
            store.update((a) => a.entities.push({ key: k(), name: name().trim(), scope: "global", fields: [{ key: "ad", label: "Ad", type: "text", required: true }] }))
          },
        })
        if (ok) void ctx.navigate(`/development/apps/${key}/entities/${k()}`)
      }

      const removeEntity = async (e: EntityDef) => {
        const used = def()!.entities.filter((x) => x.parent === e.key || x.fields.some((f) => f.reference === e.key)).map((x) => x.name)
        if (used.length) return void dialogs.alert({ heading: "Silinemez", message: `${e.name} şunlarda kullanılıyor: ${used.join(", ")}.` })
        if (await dialogs.confirm({ heading: "Entity'yi kaldır", message: `${e.name} taslaktan kaldırılsın mı? Yayınlanırsa tablosu ve verileri silinir.`, confirmText: "Kaldır", cancelText: "Vazgeç", variant: "danger" }))
          store.update((a) => (a.entities = a.entities.filter((x) => x.key !== e.key)))
      }

      const columns: GridColumn<EntityDef & { id: string }>[] = [
        { key: "name", header: "Entity", width: 220, flex: true, format: (v, e) => html`<strong>${v as string}</strong> <span class="muted small">${e.key}</span>` },
        { key: "scope", header: "Kapsam", width: 130, format: (v, e) => (e.parent ? `Detay: ${def()!.entities.find((x) => x.key === e.parent)?.name ?? e.parent}` : SCOPES.find((s) => s.value === v)?.label ?? String(v)) },
        { key: "periodBound", header: "Dönem", width: 90, format: (v) => (v ? "Evet" : "") },
        { key: "fields", header: "Alan", width: 80, align: "end", format: (v) => (v as FieldDef[]).length },
        { key: "remove", header: "", width: 64, align: "end", resizable: false, hideable: false, reorderable: false, format: (_, e) => html`<bz-button size="sm" variant="ghost" aria-label="Kaldır" @click=${() => removeEntity(e)}>${icon("trash")}</bz-button>` },
      ]

      return html`
        <div class="page-head">
          <bz-button variant="ghost" size="sm" aria-label="Geliştirmeye dön" @click=${() => void ctx.navigate("/development")}>${icon("arrow-left")}</bz-button>
          <h1>${() => def()?.name ?? key}</h1>
          <span class="muted small">${() => (info()?.installedVersion ? `yayında: v${info()!.installedVersion}` : "yayınlanmadı")}</span>
          ${() => (info()?.isDraft || store.dirty() ? html`<bz-badge variant="warning">Taslak</bz-badge>` : null)}
          ${nav(ctx, key, "design")}
          <span class="spacer"></span>
          ${() => (info()?.installedVersion ? html`<a class="button-link" href=${`/api/management/apps/${key}/export`} download>${icon("download")} Dışa aktar (.bzapp)</a>` : null)}
          ${() => (info()?.isDraft && info()?.installedVersion ? html`<bz-button @click=${() => discard(key, store.reload)}>Taslağı at</bz-button>` : null)}
          <bz-button ?loading=${store.busy} ?disabled=${() => !store.dirty()} @click=${store.save}>Kaydet</bz-button>
          <bz-button variant="primary" @click=${() => publish(key, store)}>${icon("upload")} Yayınla</bz-button>
        </div>
        ${errorList(store.errors)}
        <bz-panel heading="Uygulama">
          <bz-form-layout columns="2" min-column-width="14rem">
            ${field("Ad", (a) => a.name, (a, v) => (a.name = v))}
            ${field("İkon", (a) => a.icon, (a, v) => (a.icon = v || undefined), { hint: "Örn. cart, users, box" })}
            ${field("Açıklama", (a) => a.description, (a, v) => (a.description = v || undefined), { span: true })}
          </bz-form-layout>
        </bz-panel>
        <div class="row"><h2>Entity'ler</h2><span class="spacer"></span><bz-button @click=${newEntity}>${icon("plus")} Yeni entity</bz-button></div>
        ${() => dataGrid({
          label: "Entity'ler",
          persist: "designer-entities",
          columns,
          rows: def()!.entities.map((e) => ({ ...e, id: e.key })),
          onOpen: (e) => void ctx.navigate(`/development/apps/${key}/entities/${e.key}`),
          empty: "Henüz entity yok: Yeni entity ile başlayın.",
        })}`
    }
    return html`<div class="page">${loading({ data: store.def, error: store.data.error }, body)}</div>`
  },
})

async function discard(appKey: string, reload: () => Promise<unknown>) {
  if (!(await dialogs.confirm({ heading: "Taslağı at", message: "Taslaktaki değişiklikler silinir; yayındaki tanıma dönülür.", confirmText: "At", cancelText: "Vazgeç", variant: "danger" }))) return
  try {
    await api.delete(`/development/apps/${appKey}/draft`)
    toast.success("Taslak atıldı.")
    await reload()
  } catch (e) {
    toast.error(errorText(e))
  }
}

/** Version → the plan (schema and code) → publish. */
async function publish(appKey: string, store: ReturnType<typeof draftStore>) {
  if (store.dirty()) await store.save()
  const installed = store.data.data()?.installedVersion
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
            ? html`<bz-alert variant="danger" heading="Kod yeni tanımla derlenmiyor"><ul>${codeErrors.slice(0, 10).map((d) => html`<li>${d.path}:${d.line} — ${d.message}</li>`)}</ul></bz-alert>`
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
}

// ── Entity designer ──────────────────────────────────────────────────────

export const entityDesignPage = definePage({
  title: "Entity",
  setup(ctx) {
    const key = ctx.params().app
    const entityKey = ctx.params().entity
    const store = draftStore(key)
    ctx.onBeforeLeave(leaveGuard(store.dirty))

    const body = () => {
      const installedEntity = () => store.data.data()?.installed?.entities.find((e) => e.key === entityKey)
      const installedKeys = new Set((installedEntity()?.fields ?? []).map((f) => f.key))
      const entity = () => store.def()!.entities.find((e) => e.key === entityKey)
      if (!entity()) return html`<bz-alert variant="danger">Entity bulunamadı.</bz-alert>`
      const change = (fn: (e: EntityDef, a: AppDef) => void) => store.update((a) => fn(a.entities.find((e) => e.key === entityKey)!, a))
      const others = () => store.def()!.entities.filter((e) => e.key !== entityKey)

      const prop = (label: string, get: (e: EntityDef) => string | undefined, set: (e: EntityDef, v: string) => void, hint = "") => {
        const s = signal(get(entity()!) ?? "")
        return html`<bz-input label=${label} hint=${hint} .value=${s} @input=${(ev: Event) => {
          const v = (ev.currentTarget as HTMLInputElement).value
          s.set(v)
          change((e) => set(e, v))
        }}></bz-input>`
      }
      const combo = (label: string, value: () => string, options: () => { value: string; label: string }[], set: (v: string) => void, disabled = () => false) =>
        html`${() => html`<bz-combobox label=${label} ?disabled=${disabled()} .value=${value()} @change=${(ev: CustomEvent<{ value: string }>) => set(ev.detail.value)}>
          ${options().map((o) => html`<bz-option value=${o.value}>${o.label}</bz-option>`)}
        </bz-combobox>`}`

      const editField = (f: FieldDef | null) => fieldDialog(store, entityKey, f, f ? installedKeys.has(f.key) : false)
      const move = (i: number, by: number) => change((e) => {
        const j = i + by
        if (j < 0 || j >= e.fields.length) return
        ;[e.fields[i], e.fields[j]] = [e.fields[j], e.fields[i]]
      })
      const removeField = async (f: FieldDef) => {
        if (await dialogs.confirm({ heading: "Alanı kaldır", message: `${f.label} kaldırılsın mı?${installedKeys.has(f.key) ? " Yayınlanırsa kolonu ve verileri silinir." : ""}`, confirmText: "Kaldır", cancelText: "Vazgeç", variant: "danger" }))
          change((e) => {
            e.fields = e.fields.filter((x) => x.key !== f.key)
            if (e.titleField === f.key) e.titleField = undefined
            if (e.list) e.list.columns = e.list.columns.filter((c) => c !== f.key)
            if (e.list?.sortField === f.key) e.list.sortField = undefined
            for (const s of e.form?.sections ?? []) s.fields = s.fields.filter((x) => x !== f.key)
          })
      }

      const fieldColumns: GridColumn<FieldDef & { id: string; index: number }>[] = [
        { key: "label", header: "Alan", width: 200, flex: true, format: (v, f) => html`<strong>${v as string}</strong>${f.required ? " *" : ""} <span class="muted small">${f.key}</span>` },
        { key: "type", header: "Tip", width: 240, format: (v, f) => (f.type === "reference" ? `${typeLabel(v as FieldType)} → ${store.def()!.entities.find((e) => e.key === f.reference)?.name ?? f.reference}` : typeLabel(v as FieldType)) },
        { key: "tools", header: "", width: 140, align: "end", resizable: false, hideable: false, reorderable: false, format: (_, f) => html`<span class="row nowrap">
          <bz-button size="sm" variant="ghost" aria-label="Yukarı" ?disabled=${f.index === 0} @click=${() => move(f.index, -1)}>${icon("chevron-up")}</bz-button>
          <bz-button size="sm" variant="ghost" aria-label="Aşağı" ?disabled=${f.index === entity()!.fields.length - 1} @click=${() => move(f.index, 1)}>${icon("chevron-down")}</bz-button>
          <bz-button size="sm" variant="ghost" aria-label="Kaldır" @click=${() => removeField(f)}>${icon("trash")}</bz-button></span>` },
      ]

      return html`
        <div class="page-head">
          <bz-button variant="ghost" size="sm" aria-label="Uygulamaya dön" @click=${() => void ctx.navigate(`/development/apps/${key}`)}>${icon("arrow-left")}</bz-button>
          <h1>${() => entity()?.name}</h1><span class="muted small">${entityKey}</span>
          ${() => (store.dirty() ? html`<bz-badge variant="warning">Kaydedilmedi</bz-badge>` : null)}
          <span class="spacer"></span>
          <bz-button variant="primary" ?loading=${store.busy} ?disabled=${() => !store.dirty()} @click=${store.save}>Kaydet</bz-button>
        </div>
        ${errorList(() => store.errors().filter((e) => e.includes(`'${entityKey}'`)))}
        <bz-panel heading="Entity">
          <bz-form-layout columns="3" min-column-width="12rem">
            ${prop("Ad (tekil)", (e) => e.name, (e, v) => (e.name = v))}
            ${prop("Ad (çoğul)", (e) => e.pluralName, (e, v) => (e.pluralName = v || undefined), "Menüde ve listede")}
            ${prop("İkon", (e) => e.icon, (e, v) => (e.icon = v || undefined))}
            ${combo("Üst entity (detay ise)", () => entity()?.parent ?? "", () => [{ value: "", label: "— (ana entity)" }, ...others().filter((o) => !o.parent).map((o) => ({ value: o.key, label: o.name }))],
              (v) => change((e) => { e.parent = v || undefined; if (v) e.scope = "global" }), () => !!installedEntity())}
            ${combo("Kapsam", () => entity()?.scope ?? "global", () => SCOPES, (v) => change((e) => (e.scope = v as EntityDef["scope"])), () => !!entity()?.parent)}
            ${combo("Başlık alanı", () => entity()?.titleField ?? "", () => [{ value: "", label: "— (ilk metin alanı)" }, ...entity()!.fields.map((f) => ({ value: f.key, label: f.label }))],
              (v) => change((e) => (e.titleField = v || undefined)))}
            <div data-span="full">${() => checkField("Döneme bağlı (kapalı dönemde değiştirilemez)", signalOf(!!entity()?.periodBound, (v) => change((e) => (e.periodBound = v || undefined))))}</div>
          </bz-form-layout>
          ${() => (entity()?.parent ? html`<p class="muted small">Detay entity'ler kapsamı ve dönemi üst entity'den alır.</p>` : null)}
        </bz-panel>
        <div class="row"><h2>Alanlar</h2><span class="spacer"></span><bz-button @click=${() => editField(null)}>${icon("plus")} Yeni alan</bz-button></div>
        ${() => dataGrid({
          label: "Alanlar",
          columns: fieldColumns,
          rows: entity()!.fields.map((f, index) => ({ ...f, id: f.key, index })),
          onOpen: (f) => void editField(entity()!.fields.find((x) => x.key === f.key)!),
          empty: "Alan yok.",
        })}
        <div class="designer-grid">
          <bz-panel heading="Liste">${() => listEditor(entity()!, change)}</bz-panel>
          <bz-panel heading="Form">${() => formEditor(entity()!, change)}</bz-panel>
        </div>`
    }
    return html`<div class="page">${loading({ data: store.def, error: store.data.error }, body)}</div>`
  },
})

/** A signal for a bound field that writes through to the draft. */
function signalOf<T>(value: T, write: (v: T) => void): Signal<T> {
  const s = signal(value)
  const set = s.set
  s.set = (v: T) => {
    set(v)
    write(v)
  }
  return s
}

function listEditor(e: EntityDef, change: (fn: (e: EntityDef) => void) => void) {
  const columns = e.list?.columns ?? []
  const toggle = (key: string, on: boolean) => change((x) => {
    const cols = x.list?.columns ?? []
    const next = on ? [...cols, key] : cols.filter((c) => c !== key)
    x.list = { ...(x.list ?? { columns: [] }), columns: e.fields.map((f) => f.key).filter((k) => next.includes(k)) }
  })
  return html`<div class="stack">
    <p class="muted small">Listede görünen sütunlar (seçilmezse ilk altı alan).</p>
    <div class="checks">${e.fields.map((f) => html`<bz-checkbox label=${f.label} .checked=${columns.includes(f.key)} @change=${(ev: CustomEvent<{ checked: boolean }>) => toggle(f.key, ev.detail.checked)}></bz-checkbox>`)}</div>
    <bz-combobox label="Varsayılan sıralama" .value=${e.list?.sortField ?? ""} @change=${(ev: CustomEvent<{ value: string }>) => change((x) => (x.list = { ...(x.list ?? { columns: [] }), sortField: ev.detail.value || undefined }))}>
      <bz-option value="">Oluşturma zamanı</bz-option>
      ${e.fields.filter((f) => f.type !== "longText").map((f) => html`<bz-option value=${f.key}>${f.label}</bz-option>`)}
    </bz-combobox>
    <bz-checkbox label="Azalan sıra" .checked=${!!e.list?.sortDescending} @change=${(ev: CustomEvent<{ checked: boolean }>) => change((x) => (x.list = { ...(x.list ?? { columns: [] }), sortDescending: ev.detail.checked || undefined }))}></bz-checkbox>
  </div>`
}

function formEditor(e: EntityDef, change: (fn: (e: EntityDef) => void) => void) {
  const sections = e.form?.sections ?? []
  const used = new Set(sections.flatMap((s) => s.fields))
  const setSections = (fn: (s: NonNullable<EntityDef["form"]>["sections"]) => void) => change((x) => {
    const s = structuredClone(x.form?.sections ?? [])
    fn(s)
    x.form = s.length ? { sections: s } : undefined
  })
  return html`<div class="stack">
    <p class="muted small">Bölümler ve alanları. Bölüm yoksa bütün alanlar tek bölümde gösterilir. Hiçbir bölümde olmayan alan formda görünmez.</p>
    ${sections.map((s, i) => html`<div class="form-section-editor">
      <div class="row">
        <bz-input aria-label="Bölüm başlığı" placeholder="Bölüm başlığı" .value=${s.title ?? ""} @change=${(ev: Event) => setSections((ss) => (ss[i].title = (ev.currentTarget as HTMLInputElement).value || undefined))}></bz-input>
        <bz-combobox aria-label="Sütun" .value=${String(s.columns ?? 2)} @change=${(ev: CustomEvent<{ value: string }>) => setSections((ss) => (ss[i].columns = Number(ev.detail.value)))}>
          <bz-option value="1">1 sütun</bz-option><bz-option value="2">2 sütun</bz-option><bz-option value="3">3 sütun</bz-option>
        </bz-combobox>
        <bz-button size="sm" variant="ghost" aria-label="Bölümü kaldır" @click=${() => setSections((ss) => ss.splice(i, 1))}>${icon("trash")}</bz-button>
      </div>
      <div class="checks inline">${e.fields.map((f) => html`<bz-checkbox label=${f.label} ?disabled=${!s.fields.includes(f.key) && used.has(f.key)} .checked=${s.fields.includes(f.key)}
        @change=${(ev: CustomEvent<{ checked: boolean }>) => setSections((ss) => {
          const next = ev.detail.checked ? [...ss[i].fields, f.key] : ss[i].fields.filter((x) => x !== f.key)
          ss[i].fields = e.fields.map((x) => x.key).filter((k) => next.includes(k))
        })}></bz-checkbox>`)}</div>
    </div>`)}
    <div><bz-button size="sm" @click=${() => setSections((ss) => ss.push({ title: `Bölüm ${ss.length + 1}`, fields: [], columns: 2 }))}>${icon("plus")} Bölüm ekle</bz-button></div>
  </div>`
}

/** Add or edit a field; the key of a published field cannot change (it is a column). */
async function fieldDialog(store: ReturnType<typeof draftStore>, entityKey: string, f: FieldDef | null, published: boolean) {
  const entity = () => store.def()!.entities.find((e) => e.key === entityKey)!
  const s = {
    label: signal(f?.label ?? ""),
    key: signal(f?.key ?? ""),
    type: signal<FieldType>(f?.type ?? "text"),
    required: signal(!!f?.required),
    hint: signal(f?.hint ?? ""),
    maxLength: signal(f?.maxLength ?? 200),
    precision: signal(f?.precision ?? 18),
    scale: signal(f?.scale ?? 2),
    choices: signal((f?.choices ?? []).map((c) => `${c.value}=${c.label}`).join("\n")),
    reference: signal(f?.reference ?? ""),
  }
  let keyTouched = !!f
  const typeLocked = published
  const ok = await formDialog({
    heading: f ? `Alan: ${f.label}` : "Yeni alan",
    submitText: f ? "Tamam" : "Ekle",
    body: () => html`<bz-form-layout columns="2" min-column-width="12rem">
      <bz-input label="Etiket" required .value=${s.label} @input=${(e: Event) => {
        s.label.set((e.currentTarget as HTMLInputElement).value)
        if (!keyTouched) s.key.set(toKey(s.label()))
      }}></bz-input>
      <bz-input label="Anahtar" required ?disabled=${published} hint=${published ? "Yayınlanmış alanın anahtarı değişmez." : "Kolon adı olur."} .value=${s.key}
        @input=${(e: Event) => ((keyTouched = true), s.key.set((e.currentTarget as HTMLInputElement).value))}></bz-input>
      <bz-combobox label="Tip" ?disabled=${typeLocked} .value=${s.type} @change=${(e: CustomEvent<{ value: string }>) => s.type.set(e.detail.value as FieldType)}>
        ${TYPES.map((t) => html`<bz-option value=${t.value}>${t.label}</bz-option>`)}
      </bz-combobox>
      ${textField("Yardım metni", s.hint)}
      <div data-span="full">${checkField("Zorunlu", s.required)}</div>
      ${() => {
        switch (s.type()) {
          case "text":
            return html`${numberField("En fazla karakter", s.maxLength, { min: 1, max: 4000 })}`
          case "decimal":
            return html`${numberField("Toplam basamak", s.precision, { min: 1, max: 28 })} ${numberField("Ondalık basamak", s.scale, { min: 0, max: 10 })}`
          case "choice":
            return html`<bz-textarea data-span="full" label="Seçenekler" hint="Her satıra bir seçenek: değer=Etiket (örn. taslak=Taslak)" rows="5" autosize .value=${s.choices}
              @input=${(e: Event) => s.choices.set((e.currentTarget as HTMLTextAreaElement).value)}></bz-textarea>`
          case "reference":
            return html`<bz-combobox label="Referans verilen entity" .value=${s.reference} @change=${(e: CustomEvent<{ value: string }>) => s.reference.set(e.detail.value)}>
              ${store.def()!.entities.filter((e) => !e.parent && e.key !== entityKey).map((e) => html`<bz-option value=${e.key}>${e.name}</bz-option>`)}
            </bz-combobox>`
          default:
            return null
        }
      }}
    </bz-form-layout>`,
    submit: async () => {
      const key = s.key().trim()
      if (!s.label().trim()) throw new Error("Etiket gerekli.")
      if (!keyOk(key)) throw new Error("Anahtar küçük harf, rakam ve _ içermeli, harfle başlamalı.")
      if (key !== f?.key && entity().fields.some((x) => x.key === key)) throw new Error("Bu anahtar kullanılıyor.")
      const field: FieldDef = { key, label: s.label().trim(), type: s.type(), required: s.required() || undefined, hint: s.hint() || undefined }
      if (field.type === "text" && s.maxLength() !== 200) field.maxLength = s.maxLength()
      if (field.type === "decimal") ((field.precision = s.precision()), (field.scale = s.scale()))
      if (field.type === "choice") {
        field.choices = s.choices().split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
          const [value, ...label] = l.split("=")
          return { value: value.trim(), label: (label.join("=") || value).trim() }
        })
        if (!field.choices.length) throw new Error("En az bir seçenek yazın.")
      }
      if (field.type === "reference") {
        if (!s.reference()) throw new Error("Referans verilen entity'yi seçin.")
        field.reference = s.reference()
      }
      store.update((a) => {
        const e = a.entities.find((x) => x.key === entityKey)!
        const i = f ? e.fields.findIndex((x) => x.key === f.key) : -1
        if (i >= 0) e.fields[i] = field
        else e.fields.push(field)
      })
    },
  })
  return ok
}
