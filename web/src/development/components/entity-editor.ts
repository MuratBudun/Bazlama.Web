import { computed, define, flush, html, prop, repeat, signal, untrack } from "@bazlama/core"
import { dialogs, icon } from "@bazlama/headless"
import { titleField, type AppDef, type EntityDef, type FieldDef, type FieldType } from "../../runtime/api"
import type { DraftStore } from "../draft"
import { keyOk, SCOPES, toKey, TYPES, typeLabel } from "../meta"

/*
 * <bazlama-entity-editor .store=${draft} entity="siparis"> — an entity of the draft: its fields
 * on the left, the properties of the selection (the entity or a field) on the right. Every
 * change goes to the draft store at once; saving is the workbench's (Ctrl+S, Kaydet). The form
 * has its own designer (bazlama-form-designer).
 */

/** The entity itself in the field list (field keys never start with "@"). */
const ENTITY = "@entity"

const TYPE_ICONS: Record<FieldType, string> = {
  text: "edit",
  longText: "file-text",
  integer: "chart",
  decimal: "chart",
  date: "calendar",
  dateTime: "clock",
  boolean: "check",
  choice: "list",
  reference: "external-link",
}

export const EntityEditor = define("bazlama-entity-editor", {
  props: {
    store: prop.object<DraftStore | null>(null),
    entity: prop.string(),
    /** "Olay kodu": opens (or creates) the entity's event class. */
    openCode: prop.object<((entity: string) => void) | null>(null),
    /** "Form": opens the entity's first form, or creates one. */
    openForm: prop.object<((entity: string) => void) | null>(null),
  },
  setup(props, { host }) {
    const store = props.store.peek()
    const entityKey = props.entity.peek()
    if (!store) return null
    const entity = () => store.def()?.entities.find((e) => e.key === entityKey)
    const exists = computed(() => !!entity())
    const change = (fn: (e: EntityDef, a: AppDef) => void) => store.update((a) => fn(a.entities.find((e) => e.key === entityKey)!, a))
    const published = (key: string) => !!store.installedEntity(entityKey)?.fields.some((f) => f.key === key)

    /*
     * The selection: ENTITY or a field key. A key changes while a new field's label is typed
     * (it follows the label), so the properties panel is rebuilt on `shown`, which changes only
     * when the user selects something else.
     */
    const selected = signal(ENTITY)
    const shown = signal(0)
    const select = (key: string) => {
      if (key === selected.peek()) return
      selected.set(key)
      shown.update((n) => n + 1)
    }
    const current = () => entity()?.fields.find((f) => f.key === selected())
    const currentType = computed(() => current()?.type)

    // ── Field operations ────────────────────────────────────────────────
    const changeField = (fn: (f: FieldDef, e: EntityDef) => void) => {
      const key = selected.peek()
      change((e) => fn(e.fields.find((f) => f.key === key)!, e))
    }
    const uniqueKey = (base: string, except = "") => {
      const keys = new Set(entity()!.fields.map((f) => f.key).filter((k) => k !== except))
      let k = base.slice(0, 30) || "alan"
      for (let i = 2; keys.has(k); i++) k = `${base.slice(0, 27)}_${i}`
      return k
    }
    /** A key change, carried to the lists, the forms and the title field. */
    /** The sections of the entity's forms and its lists. */
    const sectionsOf = (a: AppDef) => (a.forms ?? []).filter((f) => f.entity === entityKey).flatMap((f) => f.sections)
    const listsOf = (a: AppDef) => (a.lists ?? []).filter((l) => l.entity === entityKey)
    const rename = (from: string, to: string) => {
      change((e, a) => {
        e.fields.find((f) => f.key === from)!.key = to
        if (e.titleField === from) e.titleField = to
        for (const l of listsOf(a)) {
          l.columns = l.columns.map((c) => (c === from ? to : c))
          if (l.sortField === from) l.sortField = to
        }
        for (const s of sectionsOf(a)) s.fields = s.fields.map((c) => (c === from ? to : c))
      })
      selected.set(to)
    }
    const addField = () => {
      const key = uniqueKey("yeni_alan")
      // Forms are not changed: their designer lists the fields they do not show yet.
      change((e) => e.fields.push({ key, label: "Yeni alan", type: "text" }))
      select(key)
      flush()
      const label = host.querySelector<HTMLInputElement>("[data-focus=label] input")
      label?.focus()
      label?.select()
    }
    const removeField = async () => {
      const f = current()
      if (!f) return
      const message = published(f.key) ? `${f.label} kaldırılsın mı? Yayınlanırsa kolonu ve verileri silinir.` : `${f.label} kaldırılsın mı?`
      if (!(await dialogs.confirm({ heading: "Alanı kaldır", message, confirmText: "Kaldır", cancelText: "Vazgeç", variant: "danger" }))) return
      const list = entity()!.fields
      const next = list[list.indexOf(f) + 1] ?? list[list.indexOf(f) - 1]
      change((e, a) => {
        e.fields = e.fields.filter((x) => x.key !== f.key)
        if (e.titleField === f.key) e.titleField = undefined
        for (const l of listsOf(a)) {
          l.columns = l.columns.filter((c) => c !== f.key)
          if (l.sortField === f.key) l.sortField = undefined
        }
        for (const s of sectionsOf(a)) s.fields = s.fields.filter((x) => x !== f.key)
      })
      select(next?.key ?? ENTITY)
    }
    const move = (by: number) => {
      const key = selected.peek()
      change((e) => {
        const i = e.fields.findIndex((f) => f.key === key)
        const j = i + by
        if (i < 0 || j < 0 || j >= e.fields.length) return
        ;[e.fields[i], e.fields[j]] = [e.fields[j], e.fields[i]]
      })
    }
    const index = () => entity()?.fields.findIndex((f) => f.key === selected()) ?? -1

    // ── Inputs bound to the draft ───────────────────────────────────────
    /** A text input: shows `get` when built, writes every keystroke with `set`. */
    const text = (label: string, get: () => string | undefined, set: (v: string) => void, o: { hint?: string; focus?: string; required?: boolean } = {}) =>
      html`<bz-input label=${label} hint=${o.hint ?? ""} ?required=${!!o.required} data-focus=${o.focus ?? null} .value=${get() ?? ""}
        @input=${(ev: Event) => set((ev.currentTarget as HTMLInputElement).value)}></bz-input>`
    const choose = (label: string, value: () => string, options: () => { value: string; label: string }[], set: (v: string) => void, o: { disabled?: () => boolean; hint?: string } = {}) =>
      html`${() => html`<bz-combobox label=${label} hint=${o.hint ?? ""} ?disabled=${o.disabled?.() ?? false} .value=${value()}
        @change=${(ev: CustomEvent<{ value: string }>) => set(ev.detail.value)}>
        ${options().map((x) => html`<bz-option value=${x.value}>${x.label}</bz-option>`)}
      </bz-combobox>`}`
    const check = (label: string, checked: () => boolean, set: (v: boolean) => void, hint = "") =>
      html`<bz-checkbox label=${label} hint=${hint} .checked=${checked} @change=${(ev: CustomEvent<{ checked: boolean }>) => set(ev.detail.checked)}></bz-checkbox>`

    // ── Entity properties ───────────────────────────────────────────────
    const entityProps = () => {
      const masters = () => store.def()!.entities.filter((e) => e.key !== entityKey && !e.parent)
      return html`<div class="ee-props">
        <h3>Entity</h3>
        ${text("Ad (tekil)", () => entity()?.name, (v) => change((e) => (e.name = v)), { required: true })}
        ${text("Ad (çoğul)", () => entity()?.pluralName, (v) => change((e) => (e.pluralName = v || undefined)), { hint: "Menüde ve listede" })}
        ${text("İkon", () => entity()?.icon, (v) => change((e) => (e.icon = v || undefined)), { hint: "Örn. cart, users, box" })}
        ${choose("Üst entity (detay ise)", () => entity()?.parent ?? "", () => [{ value: "", label: "— (ana entity)" }, ...masters().map((o) => ({ value: o.key, label: o.name }))],
          (v) => change((e) => { e.parent = v || undefined; if (v) ((e.scope = "global"), (e.periodBound = undefined)) }),
          { disabled: () => !!store.installedEntity(entityKey), hint: "Yayınlandıktan sonra değişmez." })}
        ${choose("Kapsam", () => entity()?.scope ?? "global", () => SCOPES, (v) => change((e) => (e.scope = v as EntityDef["scope"])),
          { disabled: () => !!entity()?.parent, hint: "Kayıtlar bu seviyeye göre süzülür." })}
        ${check("Döneme bağlı", () => !!entity()?.periodBound, (v) => change((e) => (e.periodBound = v || undefined)), "Kapalı dönemde değiştirilemez.")}
        ${() => (entity()?.parent ? html`<p class="muted small">Detay entity'ler kapsamı ve dönemi üst entity'den alır.</p>` : null)}
        <h3>Kayıt</h3>
        ${choose("Başlık alanı", () => entity()?.titleField ?? "", () => [{ value: "", label: "— (ilk metin alanı)" }, ...entity()!.fields.map((f) => ({ value: f.key, label: f.label }))],
          (v) => change((e) => (e.titleField = v || undefined)), { hint: "Referanslarda ve başlıklarda görünür." })}
        <p class="muted small">Listeler ve formlar gezginin Listeler ve Formlar klasörlerinde tasarlanır.</p>
      </div>`
    }

    // ── Field properties ────────────────────────────────────────────────
    const keyError = signal("")
    const fieldProps = () => {
      keyError.set("")
      const f = current()
      if (!f) return null
      const locked = published(f.key)
      const setLabel = (v: string) => {
        const now = current()!
        // A new field's key follows its label until the key is edited by hand.
        const follow = !published(now.key) && (now.key === toKey(now.label) || /^yeni_alan(_\d+)?$/.test(now.key))
        changeField((x) => (x.label = v))
        if (follow && v.trim()) {
          const next = uniqueKey(toKey(v), now.key)
          if (keyOk(next) && next !== now.key) rename(now.key, next)
        }
      }
      const setKey = (ev: Event) => {
        // The native input's text (the bz-input's value follows it on input events).
        const v = ((ev.target as HTMLInputElement).value ?? "").trim()
        const now = current()!
        if (v === now.key) return keyError.set("")
        if (!keyOk(v)) return keyError.set("Küçük harf, rakam ve _; harfle başlamalı (en fazla 30).")
        if (entity()!.fields.some((x) => x.key === v)) return keyError.set("Bu anahtar kullanılıyor.")
        keyError.set("")
        rename(now.key, v)
      }
      return html`<div class="ee-props">
        <h3>Alan</h3>
        ${text("Etiket", () => f.label, setLabel, { required: true, focus: "label" })}
        <bz-input label="Anahtar" ?disabled=${locked} hint=${locked ? "Yayınlanmış alanın anahtarı değişmez (kolon adı)." : "Kolon adı olur; Enter ya da çıkınca uygulanır."}
          .value=${() => current()?.key ?? ""} @change=${setKey}></bz-input>
        ${() => (keyError() ? html`<div class="field-error" role="alert">${keyError()}</div>` : null)}
        ${choose("Tip", () => current()?.type ?? "text", () => TYPES, (v) =>
          changeField((x) => {
            x.type = v as FieldType
            for (const k of ["maxLength", "precision", "scale", "choices", "reference"] as const) delete x[k]
          }), { disabled: () => locked, hint: locked ? "Yayınlanmış alanın tipi değişmez." : "" })}
        ${check("Zorunlu", () => !!current()?.required, (v) => changeField((x) => (x.required = v || undefined)))}
        ${text("Yardım metni", () => f.hint, (v) => changeField((x) => (x.hint = v || undefined)), { hint: "Alanın altında görünür." })}
        ${() => {
          const type = currentType()
          return untrack(() => typeProps(type))
        }}
        <h3>Kayıt</h3>
        ${check("Kayıt başlığı", () => titleField(entity()!) === selected(), (v) => change((e) => (e.titleField = v ? selected.peek() : undefined)), "Referanslarda bu alanın değeri görünür.")}
      </div>`
    }
    const typeProps = (type: FieldType | undefined) => {
      const f = current()
      if (!f) return null
      switch (type) {
        case "text":
          return text("En fazla karakter", () => String(f.maxLength ?? 200), (v) => {
            const n = Number(v)
            if (Number.isInteger(n) && n >= 1 && n <= 4000) changeField((x) => (x.maxLength = n === 200 ? undefined : n))
          }, { hint: "1–4000" })
        case "decimal":
          return html`<div class="ee-pair">
            ${text("Toplam basamak", () => String(f.precision ?? 18), (v) => Number(v) >= 1 && Number(v) <= 28 && changeField((x) => (x.precision = Number(v))))}
            ${text("Ondalık basamak", () => String(f.scale ?? 2), (v) => v !== "" && Number(v) >= 0 && Number(v) <= 10 && changeField((x) => (x.scale = Number(v))))}
          </div>`
        case "choice":
          return html`<bz-textarea label="Seçenekler" hint="Her satıra bir seçenek: değer=Etiket (örn. taslak=Taslak)" rows="4" autosize
            .value=${(f.choices ?? []).map((c) => `${c.value}=${c.label}`).join("\n")}
            @input=${(e: Event) => {
              const lines = (e.currentTarget as HTMLTextAreaElement).value.split("\n").map((l) => l.trim()).filter(Boolean)
              changeField((x) => (x.choices = lines.map((l) => {
                const [value, ...label] = l.split("=")
                return { value: value.trim(), label: (label.join("=") || value).trim() }
              })))
            }}></bz-textarea>`
        case "reference":
          return choose("Referans verilen entity", () => current()?.reference ?? "",
            () => [{ value: "", label: "— seçin" }, ...store.def()!.entities.filter((e) => !e.parent && e.key !== entityKey).map((e) => ({ value: e.key, label: e.name }))],
            (v) => changeField((x) => (x.reference = v || undefined)), { disabled: () => published(f.key) })
        default:
          return null
      }
    }

    // ── Field list ──────────────────────────────────────────────────────
    const keys = computed(() => entity()?.fields.map((f) => f.key) ?? [])
    const fieldRow = (key: string) => {
      const f = () => entity()?.fields.find((x) => x.key === key)
      return html`<bz-option value=${key} class="ee-row">
        ${() => icon(TYPE_ICONS[f()?.type ?? "text"], { size: 16 })}
        <span class="ee-name">${() => f()?.label}${() => (f()?.required ? " *" : "")}</span>
        <span class="ee-key">${key}</span>
        <span class="spacer"></span>
        ${() => (titleField(entity()!) === key ? html`<bz-badge variant="neutral" data-tooltip="Kayıt başlığı">başlık</bz-badge>` : null)}
        ${published(key) ? html`<span class="ee-mark" data-tooltip="Yayında: anahtarı ve tipi değişmez">${icon("lock", { size: 14 })}</span>` : null}
        <span class="ee-type">${() => (f() ? typeLabel(f()!.type) : "")}</span>
      </bz-option>`
    }
    const onListKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && selected() !== ENTITY) {
        e.preventDefault()
        e.stopPropagation()
        move(e.key === "ArrowUp" ? -1 : 1)
      } else if (e.key === "Delete" && selected() !== ENTITY) {
        e.preventDefault()
        void removeField()
      }
    }

    const errors = () => store.errors().filter((e) => e.includes(`'${entityKey}'`))
    const body = () => html`
      <div class="ee-head">
        ${icon(entity()?.parent ? "list" : "database", { size: 20 })}
        <h1>${() => entity()?.name}</h1><span class="muted small">${entityKey}</span>
        <span class="spacer"></span>
        ${props.openForm() ? html`<bz-button size="sm" @click=${() => props.openForm()!(entityKey)}>${icon("dashboard")} Form</bz-button>` : null}
        ${props.openCode() ? html`<bz-button size="sm" @click=${() => props.openCode()!(entityKey)}>${icon("code")} Olay kodu</bz-button>` : null}
      </div>
      ${() =>
        errors().length
          ? html`<bz-alert variant="warning" heading=${`Yayınlamadan önce düzeltilmeli (${errors().length})`}><ul class="errors">${errors().map((e) => html`<li>${e}</li>`)}</ul></bz-alert>`
          : null}
      <bz-split class="ee-split" primary="end" size="380" min="280" persist="bazlama-entity-props" label="Özellikler panelini boyutlandır">
        <section class="ee-fields" aria-label="Alanlar">
          <bz-toolbar label="Alanlar">
            <bz-button size="sm" @click=${addField}>${icon("plus")} Alan ekle</bz-button>
            <bz-toolbar-separator></bz-toolbar-separator>
            <bz-button size="sm" variant="ghost" aria-label="Yukarı taşı" data-tooltip="Yukarı (Alt+↑)" ?disabled=${() => index() <= 0} @click=${() => move(-1)}>${icon("chevron-up")}</bz-button>
            <bz-button size="sm" variant="ghost" aria-label="Aşağı taşı" data-tooltip="Aşağı (Alt+↓)" ?disabled=${() => index() < 0 || index() >= keys().length - 1} @click=${() => move(1)}>${icon("chevron-down")}</bz-button>
            <bz-button size="sm" variant="ghost" aria-label="Alanı kaldır" data-tooltip="Kaldır (Delete)" ?disabled=${() => index() < 0} @click=${removeField}>${icon("trash")}</bz-button>
          </bz-toolbar>
          <bz-list label="Alanlar" class="ee-list" .value=${selected} @keydown=${onListKey}
            @change=${(e: CustomEvent<{ value: string }>) => select(e.detail.value || ENTITY)}>
            <bz-option value=${ENTITY} class="ee-row ee-entity">
              ${icon("settings", { size: 16 })}<span class="ee-name">${() => entity()?.name}</span><span class="muted small">entity özellikleri</span>
            </bz-option>
            ${() => repeat(keys, (k) => k, fieldRow)}
          </bz-list>
          ${() => (keys().length ? null : html`<p class="muted small ee-empty">Alan yok: Alan ekle ile başlayın.</p>`)}
        </section>
        <section class="ee-inspector" aria-label="Özellikler">
          ${() => {
            shown()
            return untrack(() => (selected() === ENTITY ? entityProps() : fieldProps()))
          }}
        </section>
      </bz-split>`

    return html`${() => (exists() ? untrack(body) : html`<bz-alert variant="danger">Entity taslakta yok.</bz-alert>`)}`
  },
})
