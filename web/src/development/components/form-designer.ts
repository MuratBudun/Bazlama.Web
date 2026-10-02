import { computed, define, html, prop, signal, untrack } from "@bazlama/core"
import { icon } from "@bazlama/headless"
import { childrenOf, plural, type AppDef, type EntityDef, type FieldDef, type FormDef, type FormSection } from "../../runtime/api"
import { fieldEditor } from "../../runtime/fields"
import type { DraftStore } from "../draft"
import { typeLabel } from "../meta"

/*
 * <bazlama-form-designer .store=${draft} form="siparis"> — a record form of the app: its name,
 * sections (title, columns) and the fields in each, in order. Next to it a preview drawn with
 * the runtime's field editors, so the form looks as it will in Runtime.
 */

export const FormDesigner = define("bazlama-form-designer", {
  props: {
    store: prop.object<DraftStore | null>(null),
    form: prop.string(),
    /** Opens the form's entity. */
    openEntity: prop.object<((entity: string) => void) | null>(null),
  },
  setup(props) {
    const store = props.store.peek()
    const formKey = props.form.peek()
    if (!store) return null
    const form = () => store.def()?.forms?.find((f) => f.key === formKey)
    const entity = () => store.def()?.entities.find((e) => e.key === form()?.entity)
    const exists = computed(() => !!form() && !!entity())

    const edit = (fn: (sections: FormSection[], f: FormDef, e: EntityDef) => void) =>
      store.update((a) => {
        const f = a.forms!.find((x) => x.key === formKey)!
        fn(f.sections, f, a.entities.find((x) => x.key === f.entity)!)
      })
    const swap = <T,>(list: T[], i: number, j: number) => {
      if (j < 0 || j >= list.length) return
      ;[list[i], list[j]] = [list[j], list[i]]
    }

    const fieldRow = (f: FieldDef, si: number, fi: number, count: number) => html`<li class="fd-field">
      ${icon("edit", { size: 14 })}
      <span class="fd-label">${f.label}${f.required ? " *" : ""}</span>
      <span class="muted small">${typeLabel(f.type)}</span>
      <span class="spacer"></span>
      <bz-button size="sm" variant="ghost" aria-label=${`${f.label} yukarı`} ?disabled=${fi === 0} @click=${() => edit((s) => swap(s[si].fields, fi, fi - 1))}>${icon("chevron-up", { size: 14 })}</bz-button>
      <bz-button size="sm" variant="ghost" aria-label=${`${f.label} aşağı`} ?disabled=${fi === count - 1} @click=${() => edit((s) => swap(s[si].fields, fi, fi + 1))}>${icon("chevron-down", { size: 14 })}</bz-button>
      <bz-button size="sm" variant="ghost" aria-label=${`${f.label} formdan çıkar`} @click=${() => edit((s) => s[si].fields.splice(fi, 1))}>${icon("x", { size: 14 })}</bz-button>
    </li>`

    const sectionCard = (s: FormSection, si: number, e: EntityDef, unused: FieldDef[], count: number) => {
      const fields = s.fields.map((k) => e.fields.find((f) => f.key === k)).filter((f): f is FieldDef => !!f)
      return html`<section class="fd-section">
        <div class="row">
          <bz-input aria-label="Bölüm başlığı" placeholder="Bölüm başlığı (isteğe bağlı)" .value=${s.title ?? ""}
            @change=${(ev: Event) => edit((ss) => (ss[si].title = (ev.currentTarget as HTMLInputElement).value.trim() || undefined))}></bz-input>
          <bz-combobox aria-label="Sütun sayısı" .value=${String(s.columns ?? 2)} @change=${(ev: CustomEvent<{ value: string }>) => edit((ss) => (ss[si].columns = Number(ev.detail.value)))}>
            <bz-option value="1">1 sütun</bz-option><bz-option value="2">2 sütun</bz-option><bz-option value="3">3 sütun</bz-option>
          </bz-combobox>
          <bz-button size="sm" variant="ghost" aria-label="Bölümü yukarı taşı" ?disabled=${si === 0} @click=${() => edit((ss) => swap(ss, si, si - 1))}>${icon("chevron-up")}</bz-button>
          <bz-button size="sm" variant="ghost" aria-label="Bölümü aşağı taşı" ?disabled=${si === count - 1} @click=${() => edit((ss) => swap(ss, si, si + 1))}>${icon("chevron-down")}</bz-button>
          <bz-button size="sm" variant="ghost" aria-label="Bölümü kaldır" @click=${() => edit((ss) => ss.splice(si, 1))}>${icon("trash")}</bz-button>
        </div>
        ${fields.length ? html`<ul class="fd-fields">${fields.map((f, fi) => fieldRow(f, si, fi, fields.length))}</ul>` : html`<p class="muted small">Bu bölümde alan yok.</p>`}
        ${unused.length
          ? html`<bz-combobox aria-label="Alan ekle" placeholder="Alan ekle…" .value=${""}
              @change=${(ev: CustomEvent<{ value: string }>) => ev.detail.value && edit((ss) => ss[si].fields.push(ev.detail.value))}>
              ${unused.map((f) => html`<bz-option value=${f.key}>${f.label}</bz-option>`)}
            </bz-combobox>`
          : null}
      </section>`
    }

    const sectionsEditor = () => {
      const f = form()!
      const e = entity()!
      const used = new Set(f.sections.flatMap((s) => s.fields))
      const unused = e.fields.filter((x) => !used.has(x.key))
      const addSection = () => edit((ss) => ss.push({ title: `Bölüm ${ss.length + 1}`, fields: [], columns: 2 }))
      return html`<div class="stack">
        ${f.sections.length ? null : html`<bz-alert>Formda bölüm yok. Bütün alanlarla başlayın ya da boş bir bölüm ekleyin.</bz-alert>`}
        ${f.sections.map((s, i) => sectionCard(s, i, e, unused, f.sections.length))}
        <div class="row">
          <bz-button size="sm" @click=${addSection}>${icon("plus")} Bölüm ekle</bz-button>
          ${unused.length
            ? html`<bz-button size="sm" variant="ghost" @click=${() =>
                edit((ss) => (ss.length ? ss[ss.length - 1].fields.push(...unused.map((x) => x.key)) : ss.push({ fields: unused.map((x) => x.key), columns: 2 })))}>
                ${icon("plus")} Kalan alanları ekle</bz-button>`
            : null}
        </div>
        ${unused.length ? html`<p class="muted small">Formda olmayan alanlar: ${unused.map((x) => x.label).join(", ")}.</p>` : null}
      </div>`
    }

    /** The form as Runtime draws it (read-only, empty values). */
    const preview = () => {
      const f = form()!
      const e = entity()!
      const app = store.def()! as AppDef
      const titles = signal<Record<string, string | null>>({})
      return html`<div class="fd-preview">
        ${f.sections.map(
          (s) => html`<bz-form-layout columns=${s.columns ?? 2} min-column-width="14rem">
            ${s.title ? html`<h2 data-span="full" class="form-heading">${s.title}</h2>` : null}
            ${s.fields
              .map((k) => e.fields.find((x) => x.key === k))
              .filter((x): x is FieldDef => !!x && (x.type !== "reference" || app.entities.some((t) => t.key === x.reference)))
              .map((x) => fieldEditor({ app, field: x, value: signal<unknown>(null), titles, error: () => "", readonly: true }))}
          </bz-form-layout>`,
        )}
        ${f.sections.length ? null : html`<p class="muted">Önizlenecek alan yok.</p>`}
        ${childrenOf(app, e).map((d) => html`<div class="fd-detail">${icon("table", { size: 16 })} ${plural(d)} <span class="muted small">(detay tablosu)</span></div>`)}
      </div>`
    }

    const errors = () => store.errors().filter((e) => e.startsWith(`Form '${formKey}'`))
    const body = () => html`
      <div class="page-head">
        ${icon("dashboard", { size: 20 })}<h1>${() => form()?.name || formKey}</h1><span class="muted small">${formKey}</span>
        <span class="spacer"></span>
        ${props.openEntity()
          ? html`<bz-button size="sm" @click=${() => props.openEntity()!(form()!.entity)}>${icon("database")} ${() => entity()?.name}</bz-button>`
          : html`<span class="muted small">${() => entity()?.name}</span>`}
      </div>
      ${() =>
        errors().length
          ? html`<bz-alert variant="warning" heading=${`Yayınlamadan önce düzeltilmeli (${errors().length})`}><ul class="errors">${errors().map((e) => html`<li>${e}</li>`)}</ul></bz-alert>`
          : null}
      <bz-form-layout columns="2" min-column-width="14rem">
        <bz-input label="Form adı" required .value=${form()!.name}
          @input=${(ev: Event) => edit((_, f) => (f.name = (ev.currentTarget as HTMLInputElement).value))}></bz-input>
        <bz-input label="Entity" readonly .value=${() => entity()?.name ?? ""} hint="Form bu entity'nin kayıtlarını gösterir."></bz-input>
      </bz-form-layout>
      <div class="fd-layout">
        <bz-panel heading="Bölümler">${() => sectionsEditor()}</bz-panel>
        <bz-panel heading="Önizleme">${() => preview()}</bz-panel>
      </div>`

    return html`<div class="page editor-page">${() => (exists() ? untrack(body) : html`<bz-alert variant="danger">Form taslakta yok.</bz-alert>`)}</div>`
  },
})
