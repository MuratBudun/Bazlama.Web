import { html, signal, type Signal } from "@bazlama/core"
import { dialogs } from "@bazlama/headless"
import { ApiError, errorText } from "../api"
import { modalSections, records, type AppDef, type FormDef, type FormToolDef, type ModalDef, type ModalPrompt, type ToolResult } from "./api"
import { fieldEditor, sectionsView } from "./fields"

/*
 * Modals (popups with fields of their own, defined in the app) and the form tools that open
 * them. A tool is a method of the form's code; when it asks for a modal the server answers with
 * the modal instead of a result, the modal is shown here, and the tool is called again with
 * what the user entered. The server checks the values (required fields, the modal's own code),
 * so a refused modal comes back with its errors and stays open.
 */

/**
 * Shows a modal. `accept` gets what the user entered and answers with the modal again (it stays
 * open, showing its errors) or with a result (it closes). Undefined: the user cancelled.
 */
export async function askModal<R>(
  app: AppDef,
  modal: ModalDef,
  prompt: ModalPrompt,
  accept: (values: Record<string, unknown>) => Promise<{ again: ModalPrompt } | { done: R }>,
): Promise<R | undefined> {
  const values = Object.fromEntries(
    modal.fields.map((f) => [f.key, signal<unknown>(prompt.values[f.key] ?? (f.type === "boolean" ? false : null))]),
  ) as Record<string, Signal<unknown>>
  const titles = signal<Record<string, string | null>>({ ...(prompt.titles ?? {}) })
  const errors = signal<Record<string, string>>(prompt.fieldErrors ?? {})
  const banner = signal((prompt.errors ?? []).join(" "))
  const busy = signal(false)
  const formId = `modal-${modal.key}`
  const snapshot = () => Object.fromEntries(modal.fields.map((f) => [f.key, values[f.key]()]))

  // A location is one of the chosen company's, a plant one of the chosen location's: when the
  // modal has no company (or location) field, the working context's is meant.
  const first = (type: string) => modal.fields.find((f) => f.type === type)
  const company = first("company")
  const location = first("location")
  const scope = {
    company: company ? () => values[company.key]() as string | null : undefined,
    location: location ? () => values[location.key]() as string | null : undefined,
  }
  const clear = (...types: string[]) => {
    for (const f of modal.fields) if (types.includes(f.type)) values[f.key].set(null)
  }
  const changed = (type: string) => (type === "company" ? () => clear("location", "plant", "period") : type === "location" ? () => clear("plant") : undefined)

  const sections = modalSections(modal)
  const result = await dialogs.open<{ value: R }>({
    heading: modal.name,
    size: sections.some((s) => (s.columns ?? 2) > 2) ? "lg" : "md",
    content: (ref) => html`<form id=${formId} class="stack rt-modal" data-modal=${modal.key} novalidate @submit=${async (ev: Event) => {
      ev.preventDefault()
      if (busy()) return
      busy.set(true)
      banner.set("")
      errors.set({})
      try {
        const r = await accept(snapshot())
        if ("done" in r) void ref.close({ value: r.done })
        else {
          errors.set(r.again.fieldErrors ?? {})
          banner.set((r.again.errors ?? []).join(" "))
        }
      } catch (err) {
        if (err instanceof ApiError) errors.set(err.fieldErrors)
        banner.set(errorText(err))
      } finally {
        busy.set(false)
      }
    }}>
      ${() => (banner() ? html`<bz-alert variant="danger">${banner()}</bz-alert>` : null)}
      ${sectionsView(sections, modal.fields, (f, span) =>
        fieldEditor({ app, field: f, value: values[f.key], titles, error: () => errors()[f.key] ?? "", readonly: false, span, scope, changed: changed(f.type) }),
      )}
    </form>`,
    footer: (ref) => html`<bz-button @click=${() => void ref.close()}>Vazgeç</bz-button>
      <bz-button variant="primary" type="submit" form=${formId} ?loading=${busy}>${modal.okText || "Tamam"}</bz-button>`,
  })
  return result?.value
}

/**
 * Runs a tool of a form's menu on the form as it is on the screen. Modals the code asks for are
 * shown on the way. Undefined: the user cancelled a modal (nothing happened).
 */
export async function runTool(o: {
  app: AppDef
  form: FormDef
  tool: FormToolDef
  /** The record on the form; null for a new one. */
  id: string | null
  parentId?: string | null
  values: Record<string, unknown>
}): Promise<ToolResult | undefined> {
  /** What the user entered so far, by modal. */
  const inputs: Record<string, Record<string, unknown>> = {}
  const call = (more: Record<string, Record<string, unknown>> = {}) =>
    records.tool(o.app.key, o.form.key, o.tool.method, { values: o.values, id: o.id, parentId: o.parentId ?? null, inputs: { ...inputs, ...more } })

  let result = await call()
  while (result.modal) {
    const prompt = result.modal
    const modal = o.app.modals?.find((m) => m.key === prompt.key)
    if (!modal) throw new Error(`Modal bulunamadı: ${prompt.key}`)
    const next = await askModal<ToolResult>(o.app, modal, prompt, async (entered) => {
      const r = await call({ [modal.key]: entered })
      // The same modal again: it was refused (the errors are in it).
      if (r.modal?.key === modal.key) return { again: r.modal }
      inputs[modal.key] = entered
      return { done: r }
    })
    if (!next) return undefined
    result = next
  }
  return result
}
