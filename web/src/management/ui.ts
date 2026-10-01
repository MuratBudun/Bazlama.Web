import { html, signal, untrack, type Signal, type TemplateResult } from "@bazlama/core"
import { dialogs, toast, type GridColumn, type Sort } from "@bazlama/headless"
import { errorText } from "../api"
import { GRID_TR, PASSWORD_TR } from "../labels"

/*
 * Small building blocks of the management pages: bound fields, a form dialog that shows
 * server errors, data loading and Turkish formatting.
 */

const dateTimeFormat = new Intl.DateTimeFormat("tr-TR", { dateStyle: "short", timeStyle: "short" })
const dateFormat = new Intl.DateTimeFormat("tr-TR", { dateStyle: "short" })

/** Server times are UTC without an offset ("2026-10-01T09:00:00"). */
export const dateTime = (iso: string | null | undefined) => (iso ? dateTimeFormat.format(new Date(/[zZ+]/.test(iso.slice(10)) ? iso : `${iso}Z`)) : "")
export const dateOnly = (iso: string | null | undefined) => (iso ? dateFormat.format(new Date(`${iso}T00:00:00`)) : "")

export function textField(label: string, value: Signal<string>, attrs: { required?: boolean; type?: string; hint?: string; disabled?: boolean; span?: boolean } = {}) {
  return html`<bz-input label=${label} type=${attrs.type ?? "text"} hint=${attrs.hint ?? ""} ?required=${!!attrs.required} ?disabled=${!!attrs.disabled}
    data-span=${attrs.span ? "full" : null} .value=${value} @input=${(e: Event) => value.set((e.currentTarget as HTMLInputElement).value)}></bz-input>`
}

export function numberField(label: string, value: Signal<number>, attrs: { min?: number; max?: number; hint?: string } = {}) {
  return html`<bz-input label=${label} type="number" hint=${attrs.hint ?? ""} required
    .value=${() => String(value())} @input=${(e: Event) => value.set(Number((e.currentTarget as HTMLInputElement).value))}
    ref=${(el: HTMLElement) => queueMicrotask(() => {
      const input = el.querySelector("input")
      if (input && attrs.min !== undefined) input.min = String(attrs.min)
      if (input && attrs.max !== undefined) input.max = String(attrs.max)
    })}></bz-input>`
}

export function passwordField(label: string, value: Signal<string>) {
  return html`<bz-password .labels=${PASSWORD_TR} label=${label} required strength autocomplete="new-password" .value=${value}
    @input=${(e: Event) => value.set((e.currentTarget as HTMLInputElement).value)}></bz-password>`
}

export function checkField(label: string, value: Signal<boolean>, hint = "") {
  return html`<bz-checkbox label=${label} hint=${hint} .checked=${value}
    @change=${(e: CustomEvent<{ checked: boolean }>) => value.set(e.detail.checked)}></bz-checkbox>`
}

let formId = 0

/**
 * A dialog with a form. `submit` saves; when it throws, the error stays on the dialog.
 * Resolves true when saved.
 */
export async function formDialog(options: { heading: string; body: () => TemplateResult; submit: () => Promise<unknown>; submitText?: string; size?: string }) {
  const id = `form-dialog-${++formId}`
  const error = signal("")
  const busy = signal(false)
  const saved = await dialogs.open<boolean>({
    heading: options.heading,
    size: options.size,
    content: (ref) => html`<form id=${id} class="stack" @submit=${async (e: Event) => {
      e.preventDefault()
      busy.set(true)
      error.set("")
      try {
        await options.submit()
        void ref.close(true)
      } catch (err) {
        error.set(errorText(err))
      } finally {
        busy.set(false)
      }
    }}>
      ${() => (error() ? html`<bz-alert variant="danger">${error()}</bz-alert>` : null)}
      ${options.body()}
    </form>`,
    footer: (ref) => html`<bz-button @click=${() => void ref.close(false)}>Vazgeç</bz-button>
      <bz-button variant="primary" type="submit" form=${id} ?loading=${busy}>${options.submitText ?? "Kaydet"}</bz-button>`,
  })
  return saved === true
}

/** "Are you sure?" then the action; errors become a toast. */
export async function confirmAction(o: { heading: string; message: string; confirmText: string; danger?: boolean; action: () => Promise<unknown>; done?: string }) {
  const ok = await dialogs.confirm({ heading: o.heading, message: o.message, confirmText: o.confirmText, cancelText: "Vazgeç", variant: o.danger ? "danger" : undefined })
  if (!ok) return false
  try {
    await o.action()
    if (o.done) toast.success(o.done)
    return true
  } catch (err) {
    toast.error(errorText(err))
    return false
  }
}

/** Loads data into a signal; `reload()` fetches again. `loaded` runs after every load. */
export function loader<T>(fetch: () => Promise<T>, loaded?: (data: T) => void) {
  const data = signal<T | null>(null)
  const error = signal("")
  const reload = async () => {
    try {
      const value = await fetch()
      data.set(value)
      error.set("")
      loaded?.(value)
    } catch (err) {
      error.set(errorText(err))
    }
  }
  void reload()
  return { data, error, reload }
}

/**
 * Error banner or "loading" while a loader has no data, then `body`. The body is rebuilt only
 * when the data changes: signals it reads while it is being built (initial form values, a
 * search box) are not tracked, so typing into a field does not rebuild the page.
 */
export function loading(l: { data: () => unknown; error: () => string }, body: () => unknown) {
  return () => {
    if (l.error()) return html`<bz-alert variant="danger">${l.error()}</bz-alert>`
    if (l.data() === null) return html`<span class="muted">Yükleniyor…</span>`
    return untrack(body)
  }
}

/**
 * The lists of the management pages: <bz-data-grid> with Turkish labels and zebra rows.
 * `persist`: the user's column layout and sort are kept (localStorage, bazlama-<key>).
 * `onOpen`: a click (or double click / Enter) on a row opens it; clicks on buttons inside a
 * row do not.
 */
export function dataGrid<R extends object>(o: {
  label: string
  /** Element id, for a <bz-data-grid-columns for=…> button. */
  id?: string
  columns: GridColumn<R>[]
  rows: R[] | (() => R[])
  persist?: string
  rowKey?: string
  onOpen?: (row: R) => void
  empty?: string
  /** Takes the page's remaining height (a list page); otherwise up to 32rem. */
  fill?: boolean
  /** Sorting done by the server: the grid only shows `sort` and reports clicks. */
  sort?: { value: () => Sort; change: (sort: Sort) => void }
  loading?: () => boolean
}) {
  const open = (e: CustomEvent<{ row: R }>) => {
    if (!o.onOpen) return
    if (e.composedPath().some((n) => n instanceof Element && n.matches("bz-button, button, a, bz-checkbox"))) return
    o.onOpen(e.detail.row)
  }
  return html`<bz-data-grid id=${o.id ?? null} label=${o.label} striped ?data-shell-fill=${!!o.fill} class=${o.onOpen ? "clickable" : ""} row-key=${o.rowKey ?? "id"}
    persist=${o.persist ? `bazlama-${o.persist}` : null} .labels=${GRID_TR} .columns=${o.columns} .rows=${o.rows}
    sort-mode=${o.sort ? "manual" : "client"} .sort=${o.sort?.value ?? null} ?loading=${o.loading ?? false}
    @sort=${(e: CustomEvent<{ sort: Sort }>) => o.sort?.change(e.detail.sort)}
    @row-click=${open} @row-activate=${(e: CustomEvent<{ row: R; via: string }>) => e.detail.via === "keyboard" && open(e)}>
    <span slot="empty" class="muted">${o.empty ?? "Kayıt yok."}</span>
  </bz-data-grid>`
}
