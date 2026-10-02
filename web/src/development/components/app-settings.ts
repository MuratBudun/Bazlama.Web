import { computed, define, html, prop, signal, untrack } from "@bazlama/core"
import { icon, type GridColumn } from "@bazlama/headless"
import { dataGrid } from "../../management/ui"
import type { AppDef, EntityDef } from "../../runtime/api"
import type { DraftStore } from "../draft"
import { removeEntity, scopeLabel } from "../meta"

/*
 * <bazlama-app-settings .store=${draft} .openEntity=${fn} .addEntity=${fn}> — the "Uygulama"
 * tab: the app's name, icon and description, and its entities at a glance.
 */

export const AppSettings = define("bazlama-app-settings", {
  props: {
    store: prop.object<DraftStore | null>(null),
    openEntity: prop.object<((key: string) => void) | null>(null),
    addEntity: prop.object<(() => void) | null>(null),
  },
  setup(props) {
    const store = props.store.peek()
    if (!store) return null
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

    const columns: GridColumn<EntityDef & { id: string }>[] = [
      { key: "name", header: "Entity", width: 220, flex: true, format: (v, e) => html`<strong>${v as string}</strong> <span class="muted small">${e.key}</span>` },
      { key: "scope", header: "Kapsam", width: 150, format: (v, e) => (e.parent ? `Detay: ${def()!.entities.find((x) => x.key === e.parent)?.name ?? e.parent}` : scopeLabel(v as EntityDef["scope"])) },
      { key: "periodBound", header: "Dönem", width: 90, format: (v) => (v ? "Evet" : "") },
      { key: "fields", header: "Alan", width: 80, align: "end", format: (v) => (v as unknown[]).length },
      { key: "remove", header: "", width: 64, align: "end", resizable: false, hideable: false, reorderable: false, format: (_, e) => html`<bz-button size="sm" variant="ghost" aria-label="Kaldır" @click=${() => removeEntity(store, e.key)}>${icon("trash")}</bz-button>` },
    ]
    // Entity, form, list and menu messages are shown in their own tabs.
    const errors = () => store.errors().filter((e) => !/^((Entity|Form|Liste) '|Menü)/.test(e))

    const body = () => html`
      <div class="page-head">${icon(def()!.icon ?? "layers", { size: 20 })}<h1>${() => def()?.name}</h1><span class="muted small">${store.appKey}</span></div>
      ${() =>
        errors().length
          ? html`<bz-alert variant="warning" heading=${`Yayınlamadan önce düzeltilmeli (${errors().length})`}><ul class="errors">${errors().map((e) => html`<li>${e}</li>`)}</ul></bz-alert>`
          : null}
      <bz-panel heading="Uygulama">
        <bz-form-layout columns="2" min-column-width="14rem">
          ${field("Ad", (a) => a.name, (a, v) => (a.name = v))}
          ${field("İkon", (a) => a.icon, (a, v) => (a.icon = v || undefined), { hint: "Örn. cart, users, box" })}
          ${field("Açıklama", (a) => a.description, (a, v) => (a.description = v || undefined), { span: true })}
        </bz-form-layout>
      </bz-panel>
      <div class="row"><h2>Entity'ler</h2><span class="spacer"></span>
        ${props.addEntity() ? html`<bz-button @click=${() => props.addEntity()!()}>${icon("plus")} Yeni entity</bz-button>` : null}</div>
      ${() => dataGrid({
        label: "Entity'ler",
        persist: "designer-entities",
        columns,
        rows: def()!.entities.map((e) => ({ ...e, id: e.key })),
        onOpen: (e) => props.openEntity()?.(e.key),
        empty: "Henüz entity yok: Yeni entity ile başlayın.",
      })}`

    const loaded = computed(() => def() !== null)
    return html`<div class="page editor-page">${() => (loaded() ? untrack(body) : null)}</div>`
  },
})
