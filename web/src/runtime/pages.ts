import { computed, html, signal, untrack, type Signal } from "@bazlama/core"
import { collectIds, dialogs, icon, toast, type Sort, type TreeItem } from "@bazlama/headless"
import { definePage, type PageContext } from "@bazlama/router"
import { ApiError, errorText } from "../api"
import { PAGINATION_TR } from "../labels"
import { confirmAction, dataGrid, loading } from "../management/ui"
import { contextText } from "../session"
import {
  childrenOf,
  entityOf,
  formSections,
  listColumns,
  listOf,
  plural,
  records,
  runtimeApps,
  runtimeConfig,
  titleField,
  type AppDef,
  type DataRecord,
  type EntityDef,
  type FieldDef,
  type RuntimeApp,
  type RuntimeMenuItem,
} from "./api"
import { fieldEditor, gridColumns } from "./fields"

/*
 * Runtime: the installed apps, drawn from their metadata. /runtime → apps,
 * /runtime/:app → its entities, /runtime/:app/:entity → list, …/:id (or "new") → form.
 */

const scopeText: Record<EntityDef["scope"], string> = {
  global: "Tüm kurum",
  company: "Firma",
  location: "Lokasyon",
  plant: "Plant",
}

export const runtimeHome = definePage({
  title: "Uygulamalar",
  setup: (ctx) => html`<div class="page">
    <div class="page-head">${icon("layers", { size: 22 })}<h1>Uygulamalar</h1></div>
    ${() =>
      runtimeApps().length === 0
        ? html`<p class="muted">Kullanabileceğiniz bir uygulama yok. Uygulamalar Yönetim › Uygulamalar'dan kurulur; erişim grup izinleriyle verilir.</p>`
        : html`<div class="cards">
            ${runtimeApps().map(
              (a) => html`<a class="card-link" href=${ctx.router.href(`${runtimeConfig.base}/${a.key}`)}>
                ${icon(a.icon ?? "layers", { size: 22 })}<strong>${a.name}</strong>
                <span class="muted small">${a.description ?? ""}</span>
                <span class="muted small">${a.entities.map((e) => e.plural).join(" · ")}</span>
              </a>`,
            )}
          </div>`}
  </div>`,
})

/** Loads the app definition and runs `body` with it (or shows the error). */
function withApp(ctx: PageContext, body: (app: RuntimeApp) => unknown) {
  const app = signal<RuntimeApp | null>(null)
  const error = signal("")
  runtimeConfig.load(ctx.params().app).then(app.set, (e) => error.set(e instanceof ApiError && e.status === 404 ? "Uygulama bulunamadı ya da erişim yetkiniz yok." : errorText(e)))
  return html`<div class="page">${loading({ data: app, error }, () => body(app()!))}</div>`
}

export const appPage = definePage({
  title: "Uygulama",
  setup: (ctx) =>
    withApp(ctx, ({ definition: app }) => {
      const items = menuLeaves(runtimeApps().find((a) => a.key === app.key)?.menu ?? [])
      return html`
        <div class="page-head">${icon(app.icon ?? "layers", { size: 22 })}<h1>${app.name}</h1><span class="muted small">v${app.version}</span></div>
        ${app.description ? html`<p class="muted">${app.description}</p>` : null}
        <div class="cards">
          ${items.map((m) => {
            const e = entityOf(app, m.entity ?? "")
            return html`<a class="card-link" href=${ctx.router.href(menuHref(app.key, m))}>
              ${icon(m.icon ?? e?.icon ?? (m.form ? "plus" : "list"), { size: 22 })}<strong>${m.label}</strong>
              <span class="muted small">${e ? `${scopeText[e.scope]}${e.periodBound ? " · döneme bağlı" : ""}` : ""}</span>
            </a>`
          })}
        </div>`
    }),
})

/** The leaves of a menu (items that open something), in order. */
const menuLeaves = (items: RuntimeMenuItem[]): RuntimeMenuItem[] => items.flatMap((m) => (m.items ? menuLeaves(m.items) : [m]))
/** Where a menu item goes: its list, or a new record in its form. */
export const menuHref = (app: string, m: RuntimeMenuItem) =>
  m.form ? `${runtimeConfig.base}/${app}/${m.entity}/new?form=${m.form}` : `${runtimeConfig.base}/${app}/${m.entity}${m.list ? `?list=${m.list}` : ""}`

export const listPage = definePage({
  title: "Liste",
  setup(ctx) {
    return withApp(ctx, ({ definition: app, access }) => {
      const e = entityOf(app, ctx.params().entity)
      if (!e || e.parent) return html`<bz-alert variant="danger">Liste bulunamadı.</bz-alert>`
      // Two lists of an entity share the path; switching between them changes only ?list.
      return html`${() => {
        const key = ctx.query.get("list")
        return untrack(() => listBody(ctx, app, e, access[e.key]?.canWrite ?? false, key))
      }}`
    })
  },
})

function listBody(ctx: PageContext, app: AppDef, e: EntityDef, canWrite: boolean, listKey: string | null) {
      const PAGE = 50
      const l = listOf(app, e, listKey)
      document.title = `${l.name} · ${app.name} · Bazlama`

      const search = signal("")
      const sort = signal<Sort>(l.sortField ? { key: l.sortField, dir: l.sortDescending ? "desc" : "asc" } : null)
      const page = signal(1)
      const rows = signal<DataRecord[]>([])
      const total = signal(0)
      const busy = signal(false)
      const error = signal("")
      const load = async () => {
        busy.set(true)
        try {
          const s = sort()
          const r = await records.list(app.key, e.key, { search: search(), sort: s?.key, desc: s?.dir === "desc", skip: (page() - 1) * PAGE, take: PAGE })
          rows.set(r.items)
          total.set(r.total)
          error.set("")
        } catch (err) {
          error.set(errorText(err))
        } finally {
          busy.set(false)
        }
      }
      void load()
      let timer: ReturnType<typeof setTimeout> | undefined
      const open = (id: string) => void ctx.navigate({ path: `${runtimeConfig.base}/${app.key}/${e.key}/${id}`, query: { list: l.key, form: l.form } })
      const gridId = `grid-${app.key}-${e.key}-${l.key ?? ""}`

      return html`
        <div class="page-head">
          ${icon(e.icon ?? "list", { size: 22 })}<h1>${l.name}</h1>
          <bz-badge variant="neutral" .count=${total}></bz-badge>
          <span class="muted small">${scopeText[e.scope]}${e.scope === "global" ? "" : () => ` · ${contextText()}`}</span>
          <span class="spacer"></span>
          ${canWrite ? html`<bz-button variant="primary" @click=${() => open("new")}>${icon("plus")} Yeni ${e.name.toLocaleLowerCase("tr-TR")}</bz-button>` : null}
        </div>
        <bz-toolbar label=${`${l.name} listesi`}>
          <bz-input placeholder="Ara…" aria-label="Ara" .value=${search} @input=${(ev: Event) => {
            search.set((ev.currentTarget as HTMLInputElement).value)
            clearTimeout(timer)
            timer = setTimeout(() => (page.set(1), void load()), 300)
          }}><span slot="prefix">${icon("search")}</span></bz-input>
          <bz-toolbar-spacer></bz-toolbar-spacer>
          <bz-data-grid-columns for=${gridId}>Sütunlar</bz-data-grid-columns>
        </bz-toolbar>
        ${() => (error() ? html`<bz-alert variant="danger">${error()}</bz-alert>` : null)}
        ${dataGrid({
          id: gridId,
          label: l.name,
          persist: `rt-${app.key}-${e.key}${l.key ? `-${l.key}` : ""}`,
          fill: true,
          columns: gridColumns(e, l.columns),
          rows,
          loading: busy,
          sort: { value: sort, change: (s) => (sort.set(s), page.set(1), void load()) },
          onOpen: (r) => open(r.id),
          empty: "Kayıt yok.",
        })}
        <bz-pagination show-info .labels=${PAGINATION_TR} .page=${page} .total=${total} page-size=${PAGE}
          @change=${(ev: CustomEvent<{ page: number }>) => (page.set(ev.detail.page), void load())}></bz-pagination>`
}

/** Field signals of a form, filled from a record. */
function formState(e: EntityDef, record: DataRecord | null) {
  const values = Object.fromEntries(e.fields.map((f) => [f.key, signal<unknown>(record?.[f.key] ?? (f.type === "boolean" ? false : null))])) as Record<string, Signal<unknown>>
  const titles = signal<Record<string, string | null>>({ ...(record?._titles ?? {}) })
  const errors = signal<Record<string, string>>({})
  const snapshot = () => Object.fromEntries(e.fields.map((f) => [f.key, values[f.key]()]))
  const initial = JSON.stringify(snapshot())
  return { values, titles, errors, snapshot, dirty: () => JSON.stringify(snapshot()) !== initial }
}

function formFields(app: AppDef, e: EntityDef, state: ReturnType<typeof formState>, readonly: boolean, sections = formSections(app, e)) {
  const field = (key: string) => e.fields.find((f) => f.key === key)
  return sections.map(
    (s) => html`<bz-form-layout columns=${s.columns ?? 2} min-column-width="14rem">
      ${s.title ? html`<h2 data-span="full" class="form-heading">${s.title}</h2>` : null}
      ${s.fields
        .map(field)
        .filter((f): f is FieldDef => !!f)
        .map((f) => fieldEditor({ app, field: f, value: state.values[f.key], titles: state.titles, error: () => state.errors()[f.key] ?? "", readonly }))}
    </bz-form-layout>`,
  )
}

export const recordPage = definePage({
  title: "Kayıt",
  setup(ctx) {
    return withApp(ctx, ({ definition: app, access, actions }) => {
      const e = entityOf(app, ctx.params().entity)
      if (!e || e.parent) return html`<bz-alert variant="danger">Kayıt türü bulunamadı.</bz-alert>`
      const id = ctx.params().id
      const isNew = id === "new"
      const canWrite = access[e.key]?.canWrite ?? false
      // The list it was opened from (back goes there) and the form it is shown in.
      const listKey = ctx.query.get("list")
      const formKey = ctx.query.get("form")
      const listPath = { path: `${runtimeConfig.base}/${app.key}/${e.key}`, query: { list: listKey } }
      const sections = formSections(app, e, formKey)

      const record = signal<DataRecord | null>(null)
      const error = signal("")
      if (isNew) record.set({ id: "", rowVersion: 0 } as DataRecord)
      else records.get(app.key, e.key, id).then(record.set, (err) => error.set(errorText(err)))

      return html`${loading({ data: record, error }, () => {
        const r = isNew ? null : record()!
        const state = formState(e, r)
        const busy = signal(false)
        const banner = signal("")
        const title = r ? String(r[titleField(e)!] ?? e.name) : `Yeni ${e.name.toLocaleLowerCase("tr-TR")}`
        document.title = `${title} · ${app.name} · Bazlama`
        let saved = false
        ctx.onBeforeLeave(async () =>
          saved || !canWrite || !state.dirty()
            ? true
            : dialogs.confirm({ heading: "Kaydedilmemiş değişiklikler", message: "Değişiklikleriniz kaybolacak. Sayfadan çıkılsın mı?", confirmText: "Çık", cancelText: "Kal", variant: "danger" }),
        )

        const save = async (ev: Event) => {
          ev.preventDefault()
          busy.set(true)
          banner.set("")
          state.errors.set({})
          try {
            if (isNew) {
              const res = await records.create(app.key, e.key, state.snapshot())
              saved = true
              toast.success(`${e.name} kaydedildi.`)
              void ctx.navigate({ path: `${listPath.path}/${res.id}`, query: { list: listKey, form: formKey } }, { replace: true })
            } else {
              await records.update(app.key, e.key, id, state.snapshot(), r!.rowVersion)
              saved = true
              toast.success("Kaydedildi.")
              record.set(await records.get(app.key, e.key, id))
            }
          } catch (err) {
            if (err instanceof ApiError) state.errors.set(err.fieldErrors)
            banner.set(errorText(err))
          } finally {
            busy.set(false)
          }
        }
        const run = async (a: RuntimeApp["actions"][string][number]) => {
          if (state.dirty()) return toast.warning("Önce değişiklikleri kaydedin.")
          if (a.confirm && !(await dialogs.confirm({ heading: a.label, message: a.confirm, confirmText: a.label, cancelText: "Vazgeç" }))) return
          try {
            const res = await records.action(app.key, e.key, id, a.key)
            toast.success(res.message ?? `${a.label}: tamamlandı.`)
            record.set(await records.get(app.key, e.key, id))
          } catch (err) {
            toast.error(errorText(err))
          }
        }
        const remove = () =>
          confirmAction({
            heading: `${e.name} sil`,
            message: `"${title}" silinsin mi?${childrenOf(app, e).length ? " Detay kayıtları da silinir." : ""}`,
            confirmText: "Sil",
            danger: true,
            action: async () => {
              await records.delete(app.key, e.key, id)
              saved = true
              await ctx.navigate(listPath)
            },
            done: `${e.name} silindi.`,
          })

        return html`
          <div class="page-head">
            <bz-button variant="ghost" size="sm" aria-label=${`${plural(e)} listesine dön`} @click=${() => void ctx.navigate(listPath)}>${icon("arrow-left")}</bz-button>
            <h1>${title}</h1><span class="muted small">${e.name}</span>
            <span class="spacer"></span>
            ${!isNew && canWrite ? (actions[e.key] ?? []).map((a) => html`<bz-button @click=${() => run(a)}>${a.icon ? icon(a.icon) : null} ${a.label}</bz-button>`) : null}
            ${!isNew && canWrite ? html`<bz-button variant="danger" @click=${remove}>${icon("trash")} Sil</bz-button>` : null}
          </div>
          ${canWrite ? null : html`<bz-alert variant="info">Bu kaydı yalnız görüntüleyebilirsiniz.</bz-alert>`}
          <form class="stack record-form" @submit=${save} novalidate>
            ${() => (banner() ? html`<bz-alert variant="danger">${banner()}</bz-alert>` : null)}
            ${formFields(app, e, state, !canWrite, sections)}
            ${canWrite ? html`<div class="row"><bz-button type="submit" variant="primary" ?loading=${busy}>${isNew ? "Oluştur" : "Kaydet"}</bz-button>
              <bz-button @click=${() => void ctx.navigate(listPath)}>Vazgeç</bz-button></div>` : null}
          </form>
          ${isNew ? (childrenOf(app, e).length ? html`<p class="muted">Detay kayıtlarını eklemek için önce kaydedin.</p>` : null) : childrenOf(app, e).map((child) => detailSection(app, child, id, canWrite))}`
      })}`
    })
  },
})

/** A master's detail records: a grid, edited in dialogs. */
function detailSection(app: AppDef, e: EntityDef, parentId: string, canWrite: boolean) {
  const rows = signal<DataRecord[]>([])
  const total = signal(0)
  const error = signal("")
  const load = async () => {
    try {
      const r = await records.list(app.key, e.key, { parent: parentId, take: 500 })
      rows.set(r.items)
      total.set(r.total)
      error.set("")
    } catch (err) {
      error.set(errorText(err))
    }
  }
  void load()

  const edit = async (r: DataRecord | null) => {
    const state = formState(e, r)
    const banner = signal("")
    const busy = signal(false)
    const formId = `detail-${e.key}`
    await dialogs.open({
      heading: r ? `${e.name} düzenle` : `Yeni ${e.name.toLocaleLowerCase("tr-TR")}`,
      size: "lg",
      content: (ref) => html`<form id=${formId} class="stack" novalidate @submit=${async (ev: Event) => {
        ev.preventDefault()
        busy.set(true)
        banner.set("")
        state.errors.set({})
        try {
          if (r) await records.update(app.key, e.key, r.id, state.snapshot(), r.rowVersion)
          else await records.create(app.key, e.key, state.snapshot(), parentId)
          await load()
          void ref.close()
        } catch (err) {
          if (err instanceof ApiError) state.errors.set(err.fieldErrors)
          banner.set(errorText(err))
        } finally {
          busy.set(false)
        }
      }}>
        ${() => (banner() ? html`<bz-alert variant="danger">${banner()}</bz-alert>` : null)}
        ${formFields(app, e, state, !canWrite)}
      </form>`,
      footer: (ref) => html`<bz-button @click=${() => void ref.close()}>${canWrite ? "Vazgeç" : "Kapat"}</bz-button>
        ${canWrite ? html`<bz-button variant="primary" type="submit" form=${formId} ?loading=${busy}>Kaydet</bz-button>` : null}`,
    })
  }
  const remove = (r: DataRecord) =>
    confirmAction({ heading: `${e.name} sil`, message: "Bu satır silinsin mi?", confirmText: "Sil", danger: true, action: () => records.delete(app.key, e.key, r.id).then(load) })

  const columns = gridColumns(e, listColumns(app, e))
  if (canWrite)
    columns.push({
      key: "_remove",
      header: "",
      width: 64,
      align: "end",
      resizable: false,
      hideable: false,
      reorderable: false,
      format: (_: unknown, r: DataRecord) => html`<bz-button size="sm" variant="ghost" aria-label="Satırı sil" @click=${() => remove(r)}>${icon("trash")}</bz-button>`,
    })

  return html`<section class="stack">
    <div class="row"><h2>${plural(e)}</h2><bz-badge variant="neutral" .count=${total}></bz-badge><span class="spacer"></span>
      ${canWrite ? html`<bz-button @click=${() => edit(null)}>${icon("plus")} Ekle</bz-button>` : null}</div>
    ${() => (error() ? html`<bz-alert variant="danger">${error()}</bz-alert>` : null)}
    ${dataGrid({ label: plural(e), persist: `rt-${app.key}-${e.key}`, columns, rows, onOpen: (r) => void edit(r), empty: "Satır yok." })}
  </section>`
}

/** Menu items: apps → their master entities. */
/**
 * The apps in the platform menu, each with its own menu. Item ids are where they go (with the
 * list or form in the query), so the shell can mark the current one.
 */
export const runtimeNav = (href: (path: string) => string) =>
  computed(() =>
    runtimeApps().map((a): TreeItem => {
      const items = (list: RuntimeMenuItem[], at: string): TreeItem[] =>
        list.map((m, i) =>
          m.items
            ? { id: `${runtimeConfig.base}/${a.key}#${at}${i}`, label: m.label, icon: m.icon ?? "folder", children: items(m.items, `${at}${i}.`) }
            : { id: menuHref(a.key, m), label: m.label, icon: m.icon ?? (m.form ? "plus" : "list"), href: href(menuHref(a.key, m)) },
        )
      return { id: `${runtimeConfig.base}/${a.key}`, label: a.name, icon: a.icon ?? "layers", children: items(a.menu, "") }
    }),
  )

/** Every group of the apps' menus (they stay open). */
export const runtimeGroups = (nav: () => TreeItem[]) => collectIds(nav())
