import { computed, html, signal, type Signal } from "@bazlama/core"
import { dialogs, icon, type GridColumn } from "@bazlama/headless"
import { errorText } from "../api"
import { dataGrid, dateOnly, dateTime } from "../management/ui"
import { listColumns, plural, records, titleField, type AppDef, type DataRecord, type EntityDef, type FieldDef } from "./api"

/*
 * How each field type is shown in a grid and edited in a form. Values are kept as the API
 * sends them: text, number, "yyyy-MM-dd" for dates, ISO UTC for date-times, the id for references.
 */

const integerFormat = new Intl.NumberFormat("tr-TR")
const decimalFormats = new Map<number, Intl.NumberFormat>()
const decimalFormat = (scale: number) => {
  let f = decimalFormats.get(scale)
  if (!f) decimalFormats.set(scale, (f = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: scale, maximumFractionDigits: scale })))
  return f
}

/** A value for a grid cell. */
export function formatValue(f: FieldDef, value: unknown, record: DataRecord): unknown {
  if (value === null || value === undefined || value === "") return ""
  switch (f.type) {
    case "choice":
      return f.choices?.find((c) => c.value === value)?.label ?? String(value)
    case "boolean":
      return value ? html`<span class="yes">${icon("check", { size: 16 })}<span class="sr-only">Evet</span></span>` : html`<span class="muted">Hayır</span>`
    case "date":
      return dateOnly(value as string)
    case "dateTime":
      return dateTime(value as string)
    case "integer":
      return integerFormat.format(value as number)
    case "decimal":
      return decimalFormat(f.scale ?? 2).format(value as number)
    case "reference":
      return record._titles?.[f.key] ?? ""
    case "longText": {
      const s = String(value)
      return s.length > 80 ? `${s.slice(0, 80)}…` : s
    }
    default:
      return String(value)
  }
}

/** Grid columns of the given fields of an entity (a list's columns). */
export function gridColumns(e: EntityDef, keys: string[]): GridColumn<DataRecord>[] {
  return keys
    .map((k) => e.fields.find((f) => f.key === k))
    .filter((f): f is FieldDef => !!f)
    .map((f, i) => ({
      key: f.key,
      header: f.label,
      sortable: f.type !== "longText",
      width: f.type === "boolean" ? 90 : f.type === "date" ? 120 : f.type === "dateTime" ? 150 : f.type === "integer" || f.type === "decimal" ? 130 : 200,
      flex: i === 0,
      align: f.type === "integer" || f.type === "decimal" ? ("end" as const) : undefined,
      format: (v: unknown, r: DataRecord) => formatValue(f, v, r),
    }))
}

// ── Editing ──────────────────────────────────────────────────────────────

/** "2026-10-05T10:30:00Z" ↔ the local "2026-10-05T13:30" of <input type="datetime-local">. */
const toLocalInput = (iso: string) => {
  const d = new Date(/[zZ+]/.test(iso.slice(10)) ? iso : `${iso}Z`)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const fromLocalInput = (local: string) => (local ? new Date(local).toISOString() : null)

/** Number inputs: a step that fits the field (decimals), set on the native input. */
const step = (f: FieldDef) => (el: HTMLElement) =>
  queueMicrotask(() => {
    const input = el.querySelector("input")
    if (input) input.step = f.type === "decimal" ? String(10 ** -(f.scale ?? 2)) : "1"
  })

export interface EditorOptions {
  app: AppDef
  field: FieldDef
  value: Signal<unknown>
  /** Referenced records' titles (for references), keyed by field. */
  titles: Signal<Record<string, string | null>>
  error: () => string
  readonly: boolean
}

export function fieldEditor(o: EditorOptions) {
  const { field: f, value } = o
  const text = (e: Event) => (e.currentTarget as HTMLInputElement).value
  // "Required" is checked by the server (one Turkish message under the field); the label shows it.
  const common = { label: f.required ? `${f.label} *` : f.label, hint: f.hint ?? "" }
  let editor: unknown
  switch (f.type) {
    case "longText":
      editor = html`<bz-textarea label=${common.label} hint=${common.hint} ?readonly=${o.readonly} autosize rows="3"
        .value=${() => (value() as string | null) ?? ""} @input=${(e: Event) => value.set(text(e) || null)}></bz-textarea>`
      break
    case "integer":
    case "decimal":
      editor = html`<bz-input type="number" label=${common.label} hint=${common.hint} ?readonly=${o.readonly} ref=${step(f)}
        .value=${() => (value() === null || value() === undefined ? "" : String(value()))}
        @input=${(e: Event) => value.set(text(e) === "" ? null : Number(text(e)))}></bz-input>`
      break
    case "date":
      editor = html`<bz-input type="date" label=${common.label} hint=${common.hint} ?readonly=${o.readonly}
        .value=${() => (value() as string | null) ?? ""} @input=${(e: Event) => value.set(text(e) || null)}></bz-input>`
      break
    case "dateTime":
      editor = html`<bz-input type="datetime-local" label=${common.label} hint=${common.hint} ?readonly=${o.readonly}
        .value=${() => (value() ? toLocalInput(value() as string) : "")} @input=${(e: Event) => value.set(fromLocalInput(text(e)))}></bz-input>`
      break
    case "boolean":
      editor = html`<bz-checkbox label=${common.label} hint=${common.hint} ?disabled=${o.readonly} .checked=${() => value() === true}
        @change=${(e: CustomEvent<{ checked: boolean }>) => value.set(e.detail.checked)}></bz-checkbox>`
      break
    case "choice":
      editor = html`<bz-combobox label=${common.label} ?disabled=${o.readonly} native="touch"
        .value=${() => (value() as string | null) ?? ""} @change=${(e: CustomEvent<{ value: string }>) => value.set(e.detail.value || null)}>
        ${f.required ? null : html`<bz-option value="">—</bz-option>`}
        ${(f.choices ?? []).map((c) => html`<bz-option value=${c.value}>${c.label}</bz-option>`)}
      </bz-combobox>`
      break
    case "reference": {
      const target = o.app.entities.find((x) => x.key === f.reference)!
      editor = html`<bz-lookup label=${common.label} hint=${common.hint} ?readonly=${o.readonly} clearable
        heading=${`${target.name} seç`} .labels=${LOOKUP_TR}
        .value=${() => (value() as string | null) ?? ""} .text=${() => o.titles()[f.key] ?? ""}
        .pick=${() => () => pickRecord(o.app, target)}
        @change=${(e: CustomEvent<{ value: string; text: string }>) => {
          value.set(e.detail.value || null)
          o.titles.update((t) => ({ ...t, [f.key]: e.detail.text || null }))
        }}></bz-lookup>`
      break
    }
    default:
      editor = html`<bz-input label=${common.label} hint=${common.hint} ?readonly=${o.readonly} maxlength=${f.maxLength ?? 200}
        .value=${() => (value() as string | null) ?? ""} @input=${(e: Event) => value.set(text(e) || null)}></bz-input>`
  }
  return html`<div class="field" data-span=${f.type === "longText" ? "full" : null}>
    ${editor}
    ${() => (o.error() ? html`<div class="field-error" role="alert">${o.error()}</div>` : null)}
  </div>`
}

const LOOKUP_TR = { select: "Seç", clear: "Temizle", search: "Ara", ok: "Seç", cancel: "Vazgeç", empty: "Sonuç yok", required: "Bir değer seçin." }

/** A dialog to choose a record: server-side search over the entity's list. */
async function pickRecord(app: AppDef, e: EntityDef) {
  const query = signal("")
  const rows = signal<DataRecord[]>([])
  const total = signal(0)
  const error = signal("")
  const title = titleField(e)!
  let timer: ReturnType<typeof setTimeout> | undefined
  const load = async () => {
    try {
      const r = await records.list(app.key, e.key, { search: query(), take: 50, sort: title })
      rows.set(r.items)
      total.set(r.total)
      error.set("")
    } catch (err) {
      error.set(errorText(err))
    }
  }
  void load()
  const picked = await dialogs.open<{ value: string; text: string }>({
    heading: `${e.name} seç`,
    size: "lg",
    content: (ref) => html`<div class="stack">
      <bz-input placeholder="Ara…" aria-label="Ara" autofocus .value=${query} @input=${(ev: Event) => {
        query.set((ev.currentTarget as HTMLInputElement).value)
        clearTimeout(timer)
        timer = setTimeout(load, 250)
      }}><span slot="prefix">${icon("search")}</span></bz-input>
      ${() => (error() ? html`<bz-alert variant="danger">${error()}</bz-alert>` : null)}
      ${dataGrid({
        label: plural(e),
        columns: gridColumns(e, listColumns(app, e)),
        rows,
        onOpen: (r) => void ref.close({ value: r.id, text: String(r[title] ?? "") }),
        empty: "Sonuç yok.",
      })}
      ${computed(() => (total() > rows().length ? html`<span class="muted small">İlk ${rows().length} kayıt gösteriliyor (${total()}). Aramayı daraltın.</span>` : null))}
    </div>`,
  })
  return picked ?? undefined
}
