import { computed, define, html, prop, untrack } from "@bazlama/core"
import { icon } from "@bazlama/headless"
import { dataGrid } from "../../management/ui"
import type { AppDef, DataRecord, EntityDef, FieldDef, ListDef } from "../../runtime/api"
import { gridColumns } from "../../runtime/fields"
import type { DraftStore } from "../draft"
import { typeLabel } from "../meta"

/*
 * <bazlama-list-designer .store=${draft} list="siparis"> — a record list of the app: its name,
 * columns in order, default sorting and the form its records open in. Next to it the runtime
 * grid with sample rows.
 */

/** Rows that look like data, for the preview: a value of the right type per column. */
export function sampleRows(app: AppDef, e: EntityDef, count = 3): DataRecord[] {
  const value = (f: FieldDef, i: number): unknown => {
    switch (f.type) {
      case "integer":
        return 10 * i
      case "decimal":
        return 1250.5 * i
      case "date":
        return `2026-10-0${i}`
      case "dateTime":
        return `2026-10-0${i}T09:30:00Z`
      case "boolean":
        return i % 2 === 1
      case "choice":
        return f.choices?.length ? f.choices[(i - 1) % f.choices.length].value : null
      case "reference":
        return `ref-${i}`
      default:
        return `${f.label} ${i}`
    }
  }
  return Array.from({ length: count }, (_, n) => {
    const i = n + 1
    const titles: Record<string, string | null> = {}
    for (const f of e.fields)
      if (f.type === "reference") titles[f.key] = `${app.entities.find((x) => x.key === f.reference)?.name ?? "Kayıt"} ${i}`
    return { id: `ornek-${i}`, rowVersion: 1, _titles: titles, ...Object.fromEntries(e.fields.map((f) => [f.key, value(f, i)])) } as DataRecord
  })
}

export const ListDesigner = define("bazlama-list-designer", {
  props: {
    store: prop.object<DraftStore | null>(null),
    list: prop.string(),
    /** Opens the list's entity. */
    openEntity: prop.object<((entity: string) => void) | null>(null),
  },
  setup(props) {
    const store = props.store.peek()
    const listKey = props.list.peek()
    if (!store) return null
    const list = () => store.def()?.lists?.find((l) => l.key === listKey)
    const entity = () => store.def()?.entities.find((e) => e.key === list()?.entity)
    const exists = computed(() => !!list() && !!entity())

    const edit = (fn: (l: ListDef, e: EntityDef) => void) =>
      store.update((a) => {
        const l = a.lists!.find((x) => x.key === listKey)!
        fn(l, a.entities.find((x) => x.key === l.entity)!)
      })
    const swap = (cols: string[], i: number, j: number) => {
      if (j < 0 || j >= cols.length) return
      ;[cols[i], cols[j]] = [cols[j], cols[i]]
    }

    const columnRow = (f: FieldDef, i: number, count: number) => html`<li class="fd-field">
      ${icon("table", { size: 14 })}
      <span class="fd-label">${f.label}</span>
      <span class="muted small">${typeLabel(f.type)}</span>
      <span class="spacer"></span>
      <bz-button size="sm" variant="ghost" aria-label=${`${f.label} sola`} ?disabled=${i === 0} @click=${() => edit((l) => swap(l.columns, i, i - 1))}>${icon("chevron-up", { size: 14 })}</bz-button>
      <bz-button size="sm" variant="ghost" aria-label=${`${f.label} sağa`} ?disabled=${i === count - 1} @click=${() => edit((l) => swap(l.columns, i, i + 1))}>${icon("chevron-down", { size: 14 })}</bz-button>
      <bz-button size="sm" variant="ghost" aria-label=${`${f.label} listeden çıkar`} @click=${() => edit((l) => l.columns.splice(i, 1))}>${icon("x", { size: 14 })}</bz-button>
    </li>`

    const columnsEditor = () => {
      const l = list()!
      const e = entity()!
      const columns = l.columns.map((k) => e.fields.find((f) => f.key === k)).filter((f): f is FieldDef => !!f)
      const unused = e.fields.filter((f) => !l.columns.includes(f.key))
      return html`<div class="stack">
        ${columns.length
          ? html`<ul class="fd-fields">${columns.map((f, i) => columnRow(f, i, columns.length))}</ul>`
          : html`<bz-alert>Listede sütun yok: en az bir alan ekleyin.</bz-alert>`}
        ${unused.length
          ? html`<div class="row">
              <bz-combobox aria-label="Sütun ekle" placeholder="Sütun ekle…" .value=${""}
                @change=${(ev: CustomEvent<{ value: string }>) => ev.detail.value && edit((x) => x.columns.push(ev.detail.value))}>
                ${unused.map((f) => html`<bz-option value=${f.key}>${f.label}${f.type === "longText" ? " (uzun metin)" : ""}</bz-option>`)}
              </bz-combobox>
              <bz-button size="sm" variant="ghost" @click=${() => edit((x) => x.columns.push(...unused.filter((f) => f.type !== "longText").map((f) => f.key)))}>${icon("plus")} Kalanları ekle</bz-button>
            </div>`
          : null}
        <p class="muted small">Sütunların sırası listede soldan sağadır. Kullanıcı kendi ekranında genişlikleri ve görünürlüğü değiştirebilir.</p>
      </div>`
    }

    const settings = () => {
      const l = list()!
      const e = entity()!
      const sortable = e.fields.filter((f) => f.type !== "longText")
      const forms = (store.def()!.forms ?? []).filter((f) => f.entity === e.key)
      return html`<bz-form-layout columns="2" min-column-width="14rem">
        <bz-input label="Liste adı" required .value=${l.name}
          @input=${(ev: Event) => edit((x) => (x.name = (ev.currentTarget as HTMLInputElement).value))}></bz-input>
        <bz-input label="Entity" readonly .value=${() => entity()?.name ?? ""} hint="Liste bu entity'nin kayıtlarını gösterir."></bz-input>
        ${() => html`<bz-combobox label="Varsayılan sıralama" .value=${list()?.sortField ?? ""}
          @change=${(ev: CustomEvent<{ value: string }>) => edit((x) => (x.sortField = ev.detail.value || undefined))}>
          <bz-option value="">Oluşturma zamanı (yeniden eskiye)</bz-option>
          <bz-option value="created_at">Oluşturma zamanı</bz-option>
          <bz-option value="updated_at">Son değişiklik zamanı</bz-option>
          ${sortable.map((f) => html`<bz-option value=${f.key}>${f.label}</bz-option>`)}
        </bz-combobox>`}
        ${() => html`<bz-checkbox label="Azalan sıra" ?disabled=${!list()?.sortField} .checked=${!!list()?.sortDescending}
          @change=${(ev: CustomEvent<{ checked: boolean }>) => edit((x) => (x.sortDescending = ev.detail.checked || undefined))}></bz-checkbox>`}
        ${() => html`<bz-combobox label="Kayıt formu" data-span="full" hint="Listeden açılan kayıt bu formla gösterilir."
          .value=${list()?.form ?? ""} @change=${(ev: CustomEvent<{ value: string }>) => edit((x) => (x.form = ev.detail.value || undefined))}>
          <bz-option value="">${forms.length ? `Varsayılan (${forms[0].name})` : "Varsayılan (bütün alanlar)"}</bz-option>
          ${forms.map((f) => html`<bz-option value=${f.key}>${f.name}</bz-option>`)}
        </bz-combobox>`}
      </bz-form-layout>`
    }

    const preview = () => {
      const l = list()!
      const e = entity()!
      const app = store.def()!
      return dataGrid({ label: `${l.name} önizlemesi`, columns: gridColumns(e, l.columns), rows: sampleRows(app, e), empty: "Sütun yok." })
    }

    const errors = () => store.errors().filter((e) => e.startsWith(`Liste '${listKey}'`))
    const body = () => html`
      <div class="page-head">
        ${icon("table", { size: 20 })}<h1>${() => list()?.name || listKey}</h1><span class="muted small">${listKey}</span>
        <span class="spacer"></span>
        ${props.openEntity()
          ? html`<bz-button size="sm" @click=${() => props.openEntity()!(list()!.entity)}>${icon("database")} ${() => entity()?.name}</bz-button>`
          : null}
      </div>
      ${() =>
        errors().length
          ? html`<bz-alert variant="warning" heading=${`Yayınlamadan önce düzeltilmeli (${errors().length})`}><ul class="errors">${errors().map((e) => html`<li>${e}</li>`)}</ul></bz-alert>`
          : null}
      ${() => (entity()?.parent ? html`<bz-alert>Detay entity'nin listesi: ana kaydın formundaki tabloda kullanılır, menüde açılamaz.</bz-alert>` : null)}
      ${settings()}
      <div class="fd-layout">
        <bz-panel heading="Sütunlar">${() => columnsEditor()}</bz-panel>
        <bz-panel heading="Önizleme">${() => preview()}</bz-panel>
      </div>`

    return html`<div class="page editor-page">${() => (exists() ? untrack(body) : html`<bz-alert variant="danger">Liste taslakta yok.</bz-alert>`)}</div>`
  },
})
