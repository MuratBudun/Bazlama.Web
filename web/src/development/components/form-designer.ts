import { computed, define, flush, html, prop, signal, untrack } from "@bazlama/core"
import { icon, type TreeItem } from "@bazlama/headless"
import * as iconSet from "@bazlama/icons"
import { childrenOf, itemKey, itemSpan, plural, type AppDef, type FieldDef, type FieldType, type FormDef, type FormSection, type FormToolDef, type ModalDef } from "../../runtime/api"
import { fieldEditor, fieldSpan } from "../../runtime/fields"
import { pascal, type FormCodeOutline } from "../code"
import type { DraftStore } from "../draft"
import { addSection, columnsOf, locate, MAX_COLUMNS, moveField, moveSection, placedKeys, placeField, removeField, removeSection, renameField, setColumns, setSpan, type Layout } from "../form-edit"
import { keyOk, MODAL_TYPES, NEW_FIELD_LABELS, toKey, TYPE_ICONS, typeLabel } from "../meta"

/*
 * <bazlama-form-designer .store=${draft} form="siparis">  — a record form of the app
 * <bazlama-form-designer .store=${draft} modal="tarih_araligi"> — a modal of the app
 *
 * Both are designed the classic way:
 *
 *   palette    | canvas                         | side panel, two tabs:
 *   what can   | the layout as Runtime draws    | Özellikler: the properties of
 *   be added   | it: sections of fields;        | what is selected (the form or
 *              | select, drag to move, drop     | modal, a section, a field);
 *              | from the palette               | Nesne ağacı: everything on it
 *
 * The object tree shows the form (or modal), its sections, their fields and the form's tools.
 * Selecting a node selects it on the canvas; a double click or Enter opens its properties.
 *
 * A form belongs to an entity: the palette offers that entity's fields, each at most once, and
 * the form only says where a field is and how wide. A form's side panel has a third tab,
 * Araçlar: the items of its tools menu, each calling a method of the form's code.
 *
 * A modal has fields of its own: the palette offers field types, dropping one makes a new field,
 * and its properties (label, key, type…) are edited here; taking it off deletes it.
 *
 * The canvas uses the runtime's field editors (inert), so the layout looks as it will there.
 * Everything can be done without dragging: click a palette entry to add it, Alt+arrows move the
 * selection, Delete removes it. Changes go to the draft store at once.
 */

type Selection = { kind: "form" } | { kind: "section"; index: number } | { kind: "field"; key: string }
/** What is being dragged: a field (from the palette or the canvas), a field type (a new field of a modal), a section, or a new section. */
type Drag = { kind: "field"; key: string } | { kind: "new-field"; type: FieldType } | { kind: "section"; index: number } | { kind: "new-section" }
type Where = "before" | "after" | "inside"
type SideTab = "props" | "tree" | "tools"
/** The names of the icon set ("chevronRight" is registered as "chevron-right"), for a tool's icon. */
const ICON_NAMES = Object.keys(iconSet).map((k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)).sort()

/** The side panel's tab is remembered (for this browser). */
const SIDE_TAB = "bazlama-designer-side"
const savedSideTab = (): SideTab => {
  try {
    const tab = localStorage.getItem(SIDE_TAB)
    return tab === "tree" || tab === "tools" ? tab : "props"
  } catch {
    return "props"
  }
}

export const FormDesigner = define("bazlama-form-designer", {
  props: {
    store: prop.object<DraftStore | null>(null),
    form: prop.string(),
    modal: prop.string(),
    /** Opens the form's entity. */
    openEntity: prop.object<((entity: string) => void) | null>(null),
    /** Opens (or creates) the code of the form or the modal. */
    openCode: prop.object<((key: string) => void) | null>(null),
    /** Opens the class generated for the modal (read-only). */
    openClass: prop.object<((key: string) => void) | null>(null),
    /** What the code check says about a form's tools (a method that is not there yet). */
    toolProblems: prop.object<((form: string) => string[]) | null>(null),
    /** The form's code class as of the last check (null: none; undefined: not checked yet): its methods are offered to the tools. */
    formCode: prop.object<((form: string) => FormCodeOutline | null | undefined) | null>(null),
    /** Opens the code at a tool's method (writing the method first when it is not there). */
    goToMethod: prop.object<((form: string, method: string) => void) | null>(null),
  },
  setup(props, { host }) {
    const store = props.store.peek()
    const formKey = props.form.peek()
    const modalKey = props.modal.peek()
    const isModal = !!modalKey
    const key = isModal ? modalKey : formKey
    if (!store) return null
    const form = () => (isModal ? undefined : store.def()?.forms?.find((f) => f.key === formKey))
    const modal = () => (isModal ? store.def()?.modals?.find((m) => m.key === modalKey) : undefined)
    const entity = () => store.def()?.entities.find((e) => e.key === form()?.entity)
    /** What is laid out: the form's or the modal's sections. */
    const layout = (): Layout | undefined => {
      const x = isModal ? modal() : form()
      return x ? { sections: x.sections ?? [] } : undefined
    }
    /** The fields that can be on it: the entity's, or the modal's own. */
    const fields = (): FieldDef[] => (isModal ? modal()?.fields : entity()?.fields) ?? []
    const exists = computed(() => (isModal ? !!modal() : !!form() && !!entity()))
    /** Changes when the layout or its fields do (not when another part of the draft does, nor the form's tools). */
    const snapshot = computed(() =>
      JSON.stringify([isModal ? modal() : { ...form(), tools: undefined }, entity(), store.def()?.entities.map((e) => [e.key, e.parent, e.name, e.pluralName])]),
    )
    const editModal = (fn: (m: ModalDef & Layout) => void) =>
      store.update((a) => {
        const m = a.modals!.find((x) => x.key === modalKey)!
        m.sections ??= []
        fn(m as ModalDef & Layout)
      })
    const editForm = (fn: (f: FormDef) => void) => store.update((a) => fn(a.forms!.find((x) => x.key === formKey)!))
    const edit = (fn: (l: Layout) => void) => (isModal ? editModal(fn) : editForm(fn))

    // ── Selection ────────────────────────────────────────────────────────
    const selected = signal<Selection>({ kind: "form" })
    /** Rebuilds the properties panel (only when something else is selected: typing keeps its input). */
    const shown = signal(0)
    const same = (a: Selection, b: Selection) => a.kind === b.kind && (a as { key?: string }).key === (b as { key?: string }).key && (a as { index?: number }).index === (b as { index?: number }).index
    const select = (s: Selection) => {
      if (same(s, selected.peek())) return
      selected.set(s)
      shown.update((n) => n + 1)
    }
    const isField = (k: string) => {
      const s = selected()
      return s.kind === "field" && s.key === k
    }
    const isSection = (index: number) => {
      const s = selected()
      return s.kind === "section" && s.index === index
    }
    /** While the object tree works on the selection: the keyboard stays in the tree. */
    let fromTree = false
    /** After a change the canvas is drawn again: the keyboard stays on what was moved. */
    const refocus = (selector: string) => {
      if (fromTree) return
      flush()
      queueMicrotask(() => host.querySelector<HTMLElement>(selector)?.focus())
    }
    const focusField = (k: string) => refocus(`.fd-item[data-key="${k}"]`)
    const focusSection = (index: number) => refocus(`.fd-section[data-section="${index}"] > .fd-section-head`)

    // ── Changes ──────────────────────────────────────────────────────────
    /** The section a new field goes to: the selected one (or the selected field's), else the last. */
    const targetSection = (l: Layout) => {
      const s = selected.peek()
      if (s.kind === "section" && l.sections[s.index]) return s.index
      if (s.kind === "field") return locate(l, s.key)?.section ?? l.sections.length - 1
      return l.sections.length - 1
    }
    const place = (l: Layout, k: string, section?: number, before: string | null = null) => {
      if (l.sections.length === 0) addSection(l)
      placeField(l, k, section ?? Math.max(0, targetSection(l)), before)
    }
    const addField = (k: string, section?: number, before: string | null = null) => {
      edit((l) => place(l, k, section, before))
      select({ kind: "field", key: k })
      focusField(k)
    }
    const uniqueKey = (base: string, except = "") => {
      const keys = new Set(fields().map((f) => f.key).filter((k) => k !== except))
      let k = base.slice(0, 30) || "alan"
      for (let i = 2; keys.has(k); i++) k = `${base.slice(0, 27)}_${i}`
      return k
    }
    /** A modal's new field of a type, put on the layout; its label is ready to be typed over. */
    const newField = (type: FieldType, section?: number, before: string | null = null) => {
      const label = NEW_FIELD_LABELS[type]
      const k = uniqueKey(toKey(label))
      const field: FieldDef = { key: k, label, type }
      if (type === "choice") field.choices = [{ value: "secenek_1", label: "Seçenek 1" }]
      if (type === "reference") field.reference = store.def()!.entities.find((e) => !e.parent)?.key
      editModal((m) => {
        m.fields.push(field)
        place(m, k, section, before)
      })
      select({ kind: "field", key: k })
      flush()
      queueMicrotask(() => {
        const input = host.querySelector<HTMLInputElement>("[data-focus=label] input")
        input?.focus()
        input?.select()
      })
    }
    /** Off the layout; a modal's field is deleted with it (a form's field stays in its entity). */
    const takeOff = (k: string) => {
      const l = layout()!
      const at = locate(l, k)
      if (isModal)
        editModal((m) => {
          removeField(m, k)
          m.fields = m.fields.filter((f) => f.key !== k)
        })
      else edit((x) => removeField(x, k))
      // The selection goes to a neighbour, else to the section.
      const neighbour = at ? (l.sections[at.section].fields[at.index + 1] ?? l.sections[at.section].fields[at.index - 1]) : undefined
      if (neighbour) {
        select({ kind: "field", key: itemKey(neighbour) })
        focusField(itemKey(neighbour))
      } else if (at) {
        select({ kind: "section", index: at.section })
        focusSection(at.section)
      } else select({ kind: "form" })
    }
    const nudgeField = (k: string, by: -1 | 1) => {
      edit((l) => moveField(l, k, by))
      focusField(k)
    }
    const newSection = (before?: number) => {
      let index = 0
      edit((l) => (index = addSection(l, before)))
      select({ kind: "section", index })
      focusSection(index)
    }
    const shiftSection = (index: number, by: -1 | 1) => {
      const count = layout()!.sections.length
      const to = index + by
      if (to < 0 || to >= count) return
      let at = index
      edit((l) => (at = moveSection(l, index, by > 0 ? to + 1 : to)))
      select({ kind: "section", index: at })
      focusSection(at)
    }
    const dropSection = (index: number) => {
      if (isModal)
        editModal((m) => {
          const gone = new Set(m.sections[index]?.fields.map(itemKey))
          removeSection(m, index)
          m.fields = m.fields.filter((f) => !gone.has(f.key))
        })
      else edit((l) => removeSection(l, index))
      select({ kind: "form" })
    }

    // ── Drag and drop ────────────────────────────────────────────────────
    let drag: Drag | null = null
    let mark: { el: Element; where: Where } | null = null
    const setMark = (el: Element | null, where: Where = "inside") => {
      if (mark?.el === el && mark.where === where) return
      mark?.el.removeAttribute("data-drop")
      mark = el ? { el, where } : null
      el?.setAttribute("data-drop", where)
    }
    const onDragStart = (e: DragEvent) => {
      const source = (e.target as Element).closest?.("[data-drag]")
      const [kind, value] = (source?.getAttribute("data-drag") ?? "").split(":")
      drag =
        kind === "field" ? { kind, key: value }
        : kind === "type" ? { kind: "new-field", type: value as FieldType }
        : kind === "section" ? { kind, index: Number(value) }
        : kind === "new-section" ? { kind }
        : null
      if (!drag) return
      // Firefox starts a drag only when there is data; the text is what lands in other apps.
      e.dataTransfer?.setData("text/plain", value ?? "Bölüm")
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"
      host.toggleAttribute("data-dragging", true)
    }
    /** Where the pointer says the dragged thing would go. */
    const target = (e: DragEvent): { el: Element; where: Where } | null => {
      if (!drag) return null
      const at = e.target as Element
      const section = at.closest?.(".fd-section")
      if (drag.kind === "field" || drag.kind === "new-field") {
        const item = at.closest?.(".fd-item")
        if (item) {
          if (drag.kind === "field" && item.getAttribute("data-key") === drag.key) return null
          const box = item.getBoundingClientRect()
          // Side by side in a row: left half before, right half after; one column: upper and lower half.
          const single = section?.getAttribute("data-columns") === "1"
          const first = single ? e.clientY < box.top + box.height / 2 : e.clientX < box.left + box.width / 2
          return { el: item, where: first ? "before" : "after" }
        }
        if (section) return { el: section, where: "inside" }
        const canvas = at.closest?.(".fd-canvas")
        return canvas ? { el: canvas, where: "inside" } : null
      }
      if (section) {
        if (drag.kind === "section" && Number(section.getAttribute("data-section")) === drag.index) return null
        const box = section.getBoundingClientRect()
        return { el: section, where: e.clientY < box.top + box.height / 2 ? "before" : "after" }
      }
      const canvas = at.closest?.(".fd-canvas")
      return canvas ? { el: canvas, where: "inside" } : null
    }
    const onDragOver = (e: DragEvent) => {
      const t = target(e)
      setMark(t?.el ?? null, t?.where)
      if (!t) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
    }
    const onDrop = (e: DragEvent) => {
      const t = target(e)
      const d = drag
      endDrag()
      if (!t || !d) return
      e.preventDefault()
      const l = layout()!
      const sectionOf = (el: Element) => Number(el.closest(".fd-section")?.getAttribute("data-section") ?? -1)
      if (d.kind === "field" || d.kind === "new-field") {
        const moved = d.kind === "field" ? d.key : null
        let section: number | undefined
        let before: string | null = null
        if (t.el.classList.contains("fd-item")) {
          section = sectionOf(t.el)
          const over = t.el.getAttribute("data-key")!
          const keys = l.sections[section].fields.map(itemKey)
          // "After X" is "before what follows X" (not counting the dragged field itself).
          before = t.where === "before" ? over : (keys.slice(keys.indexOf(over) + 1).find((k) => k !== moved) ?? null)
        } else if (t.el.classList.contains("fd-section")) section = sectionOf(t.el)
        else section = l.sections.length ? l.sections.length - 1 : undefined
        if (d.kind === "field") addField(d.key, section, before)
        else newField(d.type, section, before)
        return
      }
      const before = t.el.classList.contains("fd-section") ? sectionOf(t.el) + (t.where === "after" ? 1 : 0) : l.sections.length
      if (d.kind === "new-section") newSection(before)
      else {
        let at = d.index
        edit((x) => (at = moveSection(x, d.index, before)))
        select({ kind: "section", index: at })
        focusSection(at)
      }
    }
    const endDrag = () => {
      drag = null
      setMark(null)
      host.removeAttribute("data-dragging")
    }

    // ── Keyboard ─────────────────────────────────────────────────────────
    const onItemKey = (e: KeyboardEvent, k: string) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault()
        takeOff(k)
      } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowUp")) {
        e.preventDefault()
        nudgeField(k, -1)
      } else if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowDown")) {
        e.preventDefault()
        nudgeField(k, 1)
      }
    }
    const onSectionKey = (e: KeyboardEvent, index: number) => {
      if (e.target !== e.currentTarget) return
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        select({ kind: "section", index })
      } else if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault()
        shiftSection(index, -1)
      } else if (e.altKey && e.key === "ArrowDown") {
        e.preventDefault()
        shiftSection(index, 1)
      } else if (e.key === "Delete") {
        e.preventDefault()
        dropSection(index)
      }
    }

    // ── Palette ──────────────────────────────────────────────────────────
    /** Palette entries are not <button>s: browsers do not start a drag from a button. */
    const press = (run: () => void) => (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return
      e.preventDefault()
      run()
    }
    /** A field that exists: on the layout (select it) or not yet (add it). */
    const fieldEntry = (x: FieldDef, placed: boolean) =>
      placed
        ? html`<li><div role="button" tabindex="0" class="fd-palette-item placed" data-field=${x.key} aria-label=${`${x.label}: yerleşimde, seç`}
            @click=${() => (select({ kind: "field", key: x.key }), focusField(x.key))} @keydown=${press(() => (select({ kind: "field", key: x.key }), focusField(x.key)))}>
            ${icon(TYPE_ICONS[x.type], { size: 14 })}<span>${x.label}${x.required ? " *" : ""}</span>${icon("check", { size: 14 })}</div></li>`
        : html`<li><div role="button" tabindex="0" class="fd-palette-item" draggable="true" data-drag=${`field:${x.key}`} data-field=${x.key} aria-label=${`${x.label} alanını ekle`}
            data-tooltip="Tıklayın ya da tuvale sürükleyin" @click=${() => addField(x.key)} @keydown=${press(() => addField(x.key))}>
            ${icon(TYPE_ICONS[x.type], { size: 14 })}<span>${x.label}${x.required ? " *" : ""}</span>${icon("plus", { size: 14 })}</div></li>`
    const components = () => html`
      <h3>Bileşenler</h3>
      <ul class="fd-palette-list" aria-label="Bileşenler">
        <li><div role="button" tabindex="0" class="fd-palette-item" draggable="true" data-drag="new-section" aria-label="Bölüm ekle" data-tooltip="Tıklayın ya da tuvale sürükleyin"
          @click=${() => newSection()} @keydown=${press(() => newSection())}>
          ${icon("dashboard", { size: 14 })}<span>Bölüm</span>${icon("plus", { size: 14 })}</div></li>
      </ul>`
    const palette = () => {
      const placed = placedKeys(layout()!)
      if (isModal) {
        const loose = fields().filter((x) => !placed.has(x.key))
        return html`
          <h3>Yeni alan</h3>
          <ul class="fd-palette-list" aria-label="Alan tipleri">
            ${MODAL_TYPES.map(
              (t) => html`<li><div role="button" tabindex="0" class="fd-palette-item" draggable="true" data-drag=${`type:${t.value}`} data-type=${t.value} aria-label=${`${t.label} alanı ekle`}
                data-tooltip="Tıklayın ya da tuvale sürükleyin" @click=${() => newField(t.value)} @keydown=${press(() => newField(t.value))}>
                ${icon(TYPE_ICONS[t.value], { size: 14 })}<span>${t.label}</span>${icon("plus", { size: 14 })}</div></li>`,
            )}
          </ul>
          ${loose.length
            ? html`<h3>Yerleşimde olmayan</h3>
              <ul class="fd-palette-list" aria-label="Yerleşimde olmayan alanlar">${loose.map((x) => fieldEntry(x, false))}</ul>
              <p class="fd-note">Bu alanlar tanımlı ama modalda görünmüyor.</p>`
            : null}
          ${components()}`
      }
      const e = entity()!
      const missing = e.fields.filter((x) => x.required && !placed.has(x.key))
      return html`
        <h3>Alanlar <span class="muted small">${e.name}</span></h3>
        <ul class="fd-palette-list" aria-label="Entity'nin alanları">${e.fields.map((x) => fieldEntry(x, placed.has(x.key)))}</ul>
        ${missing.length ? html`<p class="fd-note warning">${icon("alert", { size: 14 })} Zorunlu ama formda yok: ${missing.map((x) => x.label).join(", ")}. Kod doldurmuyorsa kayıt eklenemez.</p>` : null}
        ${components()}`
    }

    // ── Canvas ───────────────────────────────────────────────────────────
    const canvas = () => {
      const l = layout()!
      const all = fields()
      const app = store.def()! as AppDef
      const titles = signal<Record<string, string | null>>({})
      const usable = (x: FieldDef | undefined): x is FieldDef => !!x && (x.type !== "reference" || app.entities.some((t) => t.key === x.reference))
      const item = (x: FieldDef, span: number | undefined) => html`<div class="fd-item" data-key=${x.key} data-span=${fieldSpan(x, span)} tabindex="0" draggable="true" data-drag=${`field:${x.key}`}
        role="option" aria-selected=${() => String(isField(x.key))} aria-label=${`${x.label} alanı`}
        @click=${(ev: Event) => (ev.stopPropagation(), select({ kind: "field", key: x.key }))} @focus=${() => select({ kind: "field", key: x.key })}
        @keydown=${(ev: KeyboardEvent) => onItemKey(ev, x.key)}>
        <div class="fd-item-body" inert>${fieldEditor({ app, field: x, value: signal<unknown>(null), titles, error: () => "", readonly: true })}</div>
      </div>`
      return html`
        ${l.sections.map((s: FormSection, i) => {
          const shown = s.fields.map((it) => ({ field: all.find((x) => x.key === itemKey(it)), span: itemSpan(it) })).filter((x) => usable(x.field))
          return html`<section class="fd-section" data-section=${i} data-columns=${columnsOf(s)} aria-selected=${() => String(isSection(i))} @click=${(ev: Event) => (ev.stopPropagation(), select({ kind: "section", index: i }))}>
            <header class="fd-section-head" tabindex="0" draggable="true" data-drag=${`section:${i}`} aria-label=${`Bölüm: ${s.title || "başlıksız"}`}
              @focus=${() => select({ kind: "section", index: i })} @keydown=${(ev: KeyboardEvent) => onSectionKey(ev, i)}>
              ${icon("menu", { size: 14 })}<strong>${s.title || html`<span class="muted">Başlıksız bölüm</span>`}</strong>
              <span class="muted small">${columnsOf(s)} sütun</span>
            </header>
            <bz-form-layout columns=${columnsOf(s)} min-column-width="9rem" role="listbox" aria-label=${`${s.title || "Bölüm"} alanları`}>
              ${shown.length ? shown.map((x) => item(x.field!, x.span)) : html`<p class="fd-empty" data-span="full">Alanları buraya sürükleyin ya da paletten tıklayın.</p>`}
            </bz-form-layout>
          </section>`
        })}
        ${l.sections.length ? null : html`<p class="fd-empty">${isModal ? "Modalda" : "Formda"} bölüm yok. Paletten bir alan ya da "Bölüm" ekleyin.</p>`}
        ${isModal
          ? html`<div class="fd-modal-foot" aria-hidden="true"><bz-button inert>Vazgeç</bz-button><bz-button variant="primary" inert>${modal()?.okText || "Tamam"}</bz-button></div>`
          : childrenOf(app, entity()!).map((d) => html`<div class="fd-detail">${icon("table", { size: 16 })} ${plural(d)} <span class="muted small">(detay tablosu; kayıt formunda bölümlerin altında gösterilir)</span></div>`)}`
    }

    // ── Properties ───────────────────────────────────────────────────────
    const text = (ev: Event) => (ev.currentTarget as HTMLInputElement).value

    // ── The form's tools menu: its own tab of the side panel ─────────────
    // A list of the menu's items and the properties of the one selected in it. The list is drawn
    // again when an item is added, removed or moved; typing keeps the inputs.
    const toolsShape = signal(0)
    const toolIndex = signal(0)
    const tools = () => form()?.tools ?? []
    const editTools = (fn: (tools: FormToolDef[]) => void, redraw = false) => {
      editForm((f) => {
        f.tools ??= []
        fn(f.tools)
        if (f.tools.length === 0) delete f.tools
      })
      if (redraw) toolsShape.update((n) => n + 1)
    }
    const methodOf = (label: string) => pascal(toKey(label))
    const focusTool = (what: "label" | "row") => {
      flush()
      queueMicrotask(() => {
        // The list keeps the focus itself (its options are active descendants).
        if (what === "row") return host.querySelector<HTMLElement>(".fd-tool-list")?.focus()
        const input = host.querySelector<HTMLInputElement>("[data-focus=tool-label] input")
        input?.focus()
        input?.select()
      })
    }
    const addTool = () => {
      let at = 0
      editTools((list) => {
        // A method of its own from the start: two tools may not call the same one.
        const used = new Set(list.map((t) => t.method))
        let n = 1
        while (used.has(n === 1 ? "YeniArac" : `YeniArac${n}`)) n++
        at = list.push({ label: n === 1 ? "Yeni araç" : `Yeni araç ${n}`, method: n === 1 ? "YeniArac" : `YeniArac${n}` }) - 1
      }, true)
      toolIndex.set(at)
      focusTool("label")
    }
    const moveTool = (by: -1 | 1) => {
      const i = toolIndex.peek()
      const j = i + by
      if (!tools()[i] || j < 0 || j >= tools().length) return
      editTools((list) => ([list[i], list[j]] = [list[j], list[i]]), true)
      toolIndex.set(j)
      focusTool("row")
    }
    const removeTool = () => {
      const i = toolIndex.peek()
      if (!tools()[i]) return
      editTools((list) => list.splice(i, 1), true)
      toolIndex.set(Math.max(0, Math.min(i, tools().length - 1)))
      focusTool("row")
    }
    const onToolKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault()
        e.stopPropagation()
        moveTool(e.key === "ArrowUp" ? -1 : 1)
      } else if (e.key === "Delete") {
        e.preventDefault()
        removeTool()
      }
    }
    /** What is wrong with a tool's method name (the server's validator says the same when saving). */
    const methodProblem = (i: number) => {
      const m = tools()[i]?.method ?? ""
      if (!m) return "Metot adı gerekli."
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(m)) return "Bir C# metot adı olmalı: harf, rakam ve _; rakamla başlamaz."
      if (tools().some((t, j) => j !== i && t.method === m)) return "Bu metot başka bir araçta kullanılıyor."
      return ""
    }
    const toolRow = (i: number) => html`<bz-option value=${String(i)} class="fd-tool-row">
      ${() => icon(tools()[i]?.icon || "cursor-click", { size: 16 })}
      <span class="fd-tool-text">
        <span class="fd-tool-name">${() => tools()[i]?.label || "(adsız)"}</span>
        <span class="fd-tool-method">${() => tools()[i]?.method}</span>
      </span>
      ${() => (methodProblem(i) ? html`<span class="fd-tool-mark" data-tooltip=${methodProblem(i)}>${icon("alert", { size: 14 })}</span>` : null)}
    </bz-option>`
    /** A tool's icon: the chosen one, opening to the icon set (in the panel itself: nothing pops over the canvas). */
    const iconPicker = (i: number) => {
      const chosen = () => tools()[i]?.icon ?? ""
      const choose = (ev: Event, name: string) => {
        editTools((list) => (list[i].icon = name || undefined))
        const details = (ev.currentTarget as Element).closest("details")
        if (details) details.open = false
      }
      return html`<details class="fd-icon-picker" data-tool-icon>
        <summary>
          <span class="fd-icon-label">İkon</span>
          ${() => (chosen() ? html`<span class="fd-icon-chosen">${icon(chosen(), { size: 16 })} ${chosen()}</span>` : html`<span class="fd-icon-chosen muted">ikonsuz</span>`)}
          ${icon("chevron-down", { size: 14 })}
        </summary>
        <div class="fd-icon-grid" role="group" aria-label="İkon seç">
          <button type="button" class="fd-icon" aria-label="ikonsuz" data-tooltip="ikonsuz" aria-pressed=${() => String(chosen() === "")} @click=${(ev: Event) => choose(ev, "")}>${icon("x", { size: 16 })}</button>
          ${ICON_NAMES.map(
            (n) => html`<button type="button" class="fd-icon" aria-label=${n} data-tooltip=${n} aria-pressed=${() => String(chosen() === n)} @click=${(ev: Event) => choose(ev, n)}>${icon(n, { size: 16 })}</button>`,
          )}
        </div>
      </details>`
    }
    /** The form's code class: null when the form has none, undefined when it is not known (yet). */
    const code = () => props.formCode()?.(key)
    /** The methods a tool may call; the combobox is drawn again only when these change. */
    const callable = computed(() => (code()?.methods ?? []).map((m) => m.name).join(" "))
    /** Where a tool's method stands in the code, said under the field. */
    const methodState = (i: number) => {
      const m = tools()[i]?.method ?? ""
      const c = code()
      if (c === undefined || methodProblem(i)) return null
      if (!c) return html`<p class="fd-note warning" data-method-state="no-class">${icon("alert", { size: 14 })} Formun kod sınıfı yok. Yandaki düğme sınıfı araçların metotlarıyla oluşturur.</p>`
      const at = c.methods.find((x) => x.name === m)
      return at
        ? html`<p class="fd-note" data-method-state="found">${icon("check", { size: 14 })} ${c.class} · ${at.path}:${at.line}</p>`
        : html`<p class="fd-note warning" data-method-state="missing">${icon("alert", { size: 14 })} ${c.class} sınıfında böyle bir metot yok. Yandaki düğme metodu ekler.</p>`
    }
    const toolProps = () => {
      const i = toolIndex.peek()
      const t = tools()[i]
      if (!t) return null
      const cur = () => tools()[i]
      const record = pascal(form()?.entity ?? "")
      const exists = () => !!code()?.methods.some((m) => m.name === cur()?.method)
      return html`
        <h3>Seçili araç</h3>
        <bz-input label="Ad" required hint="Menüde görünen ad." data-focus="tool-label" .value=${t.label} @input=${(ev: Event) =>
          editTools((list) => {
            // The method follows the name until it is edited by hand.
            const follow = !list[i].method || list[i].method === methodOf(list[i].label) || /^YeniArac\d*$/.test(list[i].method)
            list[i].label = text(ev)
            if (follow && methodOf(text(ev))) list[i].method = methodOf(text(ev))
          })}></bz-input>
        <div class="fd-method">
          ${() => {
            const names = callable()
            // Typed freely, or picked from the methods of the form's code class.
            return untrack(() => html`<bz-combobox label="Metot" required allow-custom data-tool-method empty-text=${() => (code() === undefined ? "Kod denetleniyor…" : code() ? "Eşleşen metot yok; yazdığınız ad kullanılır." : "Formun kod sınıfı yok; metodun adını yazın.")} .value=${() => cur()?.method ?? ""}
              @input=${(ev: Event) => editTools((list) => (list[i].method = (ev.target as HTMLInputElement).value.trim()))}
              @change=${(ev: CustomEvent<{ value: string }>) => editTools((list) => (list[i].method = (ev.detail.value ?? "").trim()))}>
              ${names ? names.split(" ").map((n) => html`<bz-option value=${n}>${n}</bz-option>`) : null}
            </bz-combobox>`)
          }}
          ${props.goToMethod()
            ? html`<bz-button data-go-to-method ?disabled=${() => !!methodProblem(i)} aria-label=${() => (exists() || code() === undefined ? "Metoda git" : "Metodu oluştur ve git")}
                data-tooltip=${() => (exists() || code() === undefined ? "Koddaki metoda git" : "Metodu formun kod sınıfına ekle ve oraya git")}
                @click=${() => props.goToMethod()!(key, cur()?.method ?? "")}>${() => icon(exists() || code() === undefined ? "external-link" : "plus", { size: 16 })}</bz-button>`
            : null}
        </div>
        ${() => (methodProblem(i) ? html`<div class="field-error" role="alert">${methodProblem(i)}</div>` : null)}
        ${() => methodState(i)}
        <pre class="fd-code" data-tool-signature>${() => `public ActionResult ${cur()?.method || "Metot"}(\n    ${record} record,\n    IAppContext context)`}</pre>
        ${iconPicker(i)}
        <bz-input label="Onay sorusu" hint="Yazılırsa araç çalışmadan önce sorulur." .value=${t.confirm ?? ""} @input=${(ev: Event) => editTools((list) => (list[i].confirm = text(ev).trim() || undefined))}></bz-input>`
    }
    const toolsPanel = () => html`
      ${() => {
        const problems = props.toolProblems()?.(key) ?? []
        return problems.length
          ? html`<bz-alert variant="warning" heading="Kod eksik"><ul class="errors">${problems.map((m) => html`<li>${m}</li>`)}</ul></bz-alert>`
          : null
      }}
      <bz-toolbar label="Araçlar">
        <bz-button size="sm" data-add-tool @click=${addTool}>${icon("plus")} Araç ekle</bz-button>
        <bz-toolbar-separator></bz-toolbar-separator>
        <bz-button size="sm" variant="ghost" aria-label="Yukarı taşı" data-tooltip="Yukarı (Alt+↑)" ?disabled=${() => toolIndex() <= 0 || tools().length === 0} @click=${() => moveTool(-1)}>${icon("chevron-up")}</bz-button>
        <bz-button size="sm" variant="ghost" aria-label="Aşağı taşı" data-tooltip="Aşağı (Alt+↓)" ?disabled=${() => toolIndex() >= tools().length - 1} @click=${() => moveTool(1)}>${icon("chevron-down")}</bz-button>
        <bz-button size="sm" variant="ghost" aria-label="Aracı kaldır" data-tooltip="Kaldır (Delete)" ?disabled=${() => tools().length === 0} @click=${removeTool}>${icon("trash")}</bz-button>
      </bz-toolbar>
      ${() => {
        toolsShape()
        return untrack(() =>
          tools().length
            ? html`<bz-list label="Araçlar menüsü" class="fd-tool-list" .value=${() => String(toolIndex())} @keydown=${onToolKey}
                @change=${(ev: CustomEvent<{ value: string }>) => ev.detail.value !== "" && toolIndex.set(Number(ev.detail.value))}>
                ${tools().map((_, i) => toolRow(i))}
              </bz-list>`
            : html`<p class="fd-empty">Araç yok: kayıt formunda Araçlar menüsü görünmez.</p>`,
        )
      }}
      ${() => (toolsShape(), toolIndex(), untrack(toolProps))}
      <p class="fd-note">Her araç formun kod sınıfındaki bir metodu çağırır. Metot formun ekrandaki halini (kaydedilmemiş de olsa) alır; değiştirdiği alanlar forma geri yazılır. Metot bir modal da açabilir.</p>`

    const formProps = () => html`
      <h3>Form</h3>
      <bz-input label="Form adı" required .value=${() => form()?.name ?? ""} @input=${(ev: Event) => editForm((f) => (f.name = text(ev)))}></bz-input>
      <bz-input label="Anahtar" readonly .value=${formKey}></bz-input>
      <bz-input label="Entity" readonly .value=${() => entity()?.name ?? ""} hint="Form bu entity'nin kayıtlarını düzenler; değiştirilemez."></bz-input>
      ${props.openEntity() ? html`<bz-button size="sm" @click=${() => props.openEntity()!(form()!.entity)}>${icon("database")} Entity'yi aç</bz-button>` : null}
      <p class="fd-note">${() => {
        const f = form()
        return f ? `${f.sections.length} bölüm, ${placedKeys(f).size} / ${entity()?.fields.length ?? 0} alan formda.` : ""
      }}</p>
      <h3>Araçlar menüsü</h3>
      <p class="fd-note">${() => (tools().length ? tools().map((t) => t.label).join(", ") : "Boş: kayıt formunda Araçlar menüsü görünmez.")}</p>
      <bz-button size="sm" data-open-tools @click=${() => showSide("tools")}>${icon("cursor-click")} Araçları düzenle</bz-button>
      <p class="fd-note">Bir bölümü ya da alanı seçince özellikleri burada görünür. Alt+ok tuşları seçileni taşır, Delete formdan çıkarır.</p>`
    const modalProps = () => html`
      <h3>Modal</h3>
      <bz-input label="Modal adı" required hint="Pencerenin başlığı." .value=${() => modal()?.name ?? ""} @input=${(ev: Event) => editModal((m) => (m.name = text(ev)))}></bz-input>
      <bz-input label="Anahtar" readonly .value=${modalKey}></bz-input>
      <bz-input label="Onay düğmesi" placeholder="Tamam" .value=${() => modal()?.okText ?? ""} @input=${(ev: Event) => editModal((m) => (m.okText = text(ev).trim() || undefined))}></bz-input>
      ${props.openCode() ? html`<bz-button size="sm" @click=${() => props.openCode()!(key)}>${icon("code")} Modal kodu</bz-button>` : null}
      ${props.openClass() ? html`<bz-button size="sm" variant="ghost" @click=${() => props.openClass()!(key)}>${icon("lock")} Üretilen sınıf</bz-button>` : null}
      <p class="fd-note">${() => `${modal()?.sections?.length ?? 0} bölüm, ${modal()?.fields.length ?? 0} alan.`}</p>
      <p class="fd-note">Modalı kod açar; kullanıcının girdikleri koda döner:</p>
      <pre class="fd-code">var m = await context.Modals
    .ShowAsync&lt;${pascal(modalKey)}&gt;();</pre>
      <p class="fd-note">Modalın kendi kodu (açılış değerleri, onayda denetim) bir ModalCode&lt;${pascal(modalKey)}&gt; sınıfıdır. Alt+ok tuşları seçileni taşır, Delete siler.</p>`
    const sectionProps = (index: number) => {
      const section = () => layout()?.sections[index]
      return html`
        <h3>Bölüm</h3>
        <bz-input label="Başlık" placeholder="Başlıksız" .value=${() => section()?.title ?? ""} @input=${(ev: Event) => edit((l) => (l.sections[index].title = text(ev).trim() ? text(ev) : undefined))}></bz-input>
        ${() => html`<bz-combobox label="Sütun sayısı" .value=${String(section() ? columnsOf(section()!) : 2)} @change=${(ev: CustomEvent<{ value: string }>) => edit((l) => setColumns(l, index, Number(ev.detail.value)))}>
          ${Array.from({ length: MAX_COLUMNS }, (_, i) => html`<bz-option value=${String(i + 1)}>${i + 1} sütun</bz-option>`)}
        </bz-combobox>`}
        <div class="row">
          <bz-button size="sm" ?disabled=${() => index === 0} @click=${() => shiftSection(index, -1)}>${icon("chevron-up")} Yukarı</bz-button>
          <bz-button size="sm" ?disabled=${() => index >= (layout()?.sections.length ?? 0) - 1} @click=${() => shiftSection(index, 1)}>${icon("chevron-down")} Aşağı</bz-button>
        </div>
        <bz-button size="sm" variant="danger" @click=${() => dropSection(index)}>${icon("trash")} Bölümü kaldır</bz-button>
        <p class="fd-note">${isModal ? "Kaldırılan bölümün alanları da silinir." : "Kaldırılan bölümün alanları formdan çıkar; paletten yeniden eklenebilir."}</p>`
    }
    /** Where the field is and how wide: the same for a form's and a modal's field. */
    const placement = (k: () => string) => {
      const at = () => (layout() ? locate(layout()!, k()) : null)
      const columns = () => (at() ? columnsOf(layout()!.sections[at()!.section]) : 1)
      const span = () => (at() ? itemSpan(layout()!.sections[at()!.section].fields[at()!.index]) : undefined)
      const type = () => fields().find((x) => x.key === k())?.type
      return html`
        ${() => html`<bz-combobox label="Genişlik" hint="Bölümün kaç sütununu kaplar." .value=${String(span() ?? "")}
          @change=${(ev: CustomEvent<{ value: string }>) => (edit((l) => setSpan(l, k(), ev.detail.value ? Number(ev.detail.value) : undefined)), focusField(k()))}>
          <bz-option value="">Otomatik${type() === "longText" ? " (tam satır)" : " (1 sütun)"}</bz-option>
          ${Array.from({ length: columns() }, (_, i) => html`<bz-option value=${String(i + 1)}>${i + 1} sütun${i + 1 === columns() && columns() > 1 ? " (tam satır)" : ""}</bz-option>`)}
        </bz-combobox>`}
        <div class="row">
          <bz-button size="sm" @click=${() => nudgeField(k(), -1)}>${icon("chevron-left")} Öne</bz-button>
          <bz-button size="sm" @click=${() => nudgeField(k(), 1)}>Arkaya ${icon("chevron-right")}</bz-button>
        </div>`
    }
    const fieldProps = (k: string) => {
      const field = () => entity()?.fields.find((x) => x.key === k)
      return html`
        <h3>Alan</h3>
        <dl class="fd-facts">
          <dt>Etiket</dt><dd>${() => field()?.label ?? k}${() => (field()?.required ? " *" : "")}</dd>
          <dt>Anahtar</dt><dd>${k}</dd>
          <dt>Tip</dt><dd>${() => (field() ? typeLabel(field()!.type) : "")}</dd>
        </dl>
        ${placement(() => k)}
        <bz-button size="sm" @click=${() => takeOff(k)}>${icon("x")} Formdan çıkar</bz-button>
        ${props.openEntity() ? html`<bz-button size="sm" variant="ghost" @click=${() => props.openEntity()!(form()!.entity)}>${icon("database")} Alanı entity'de düzenle</bz-button>` : null}
        <p class="fd-note">Etiket, tip ve zorunluluk entity'de tanımlıdır; form yalnız yerini ve genişliğini belirler.</p>`
    }

    // A modal's field is defined here. Its key may change while the panel is open (it follows the
    // label), so the panel reads the selection instead of holding a key.
    const keyError = signal("")
    const currentKey = () => {
      const s = selected()
      return s.kind === "field" ? s.key : ""
    }
    const current = () => modal()?.fields.find((x) => x.key === currentKey())
    const currentType = computed(() => current()?.type)
    const changeField = (fn: (f: FieldDef) => void) => {
      const k = currentKey()
      editModal((m) => {
        const f = m.fields.find((x) => x.key === k)
        if (f) fn(f)
      })
    }
    const rename = (from: string, to: string) => {
      editModal((m) => {
        m.fields.find((f) => f.key === from)!.key = to
        renameField(m, from, to)
      })
      selected.set({ kind: "field", key: to })
    }
    const typeProps = (type: FieldType | undefined) => {
      const f = current()
      if (!f) return null
      switch (type) {
        case "text":
          return html`<bz-input label="En fazla karakter" hint="1–4000" .value=${String(f.maxLength ?? 200)} @input=${(ev: Event) => {
            const n = Number(text(ev))
            if (Number.isInteger(n) && n >= 1 && n <= 4000) changeField((x) => (x.maxLength = n === 200 ? undefined : n))
          }}></bz-input>`
        case "decimal":
          return html`<bz-input label="Ondalık basamak" hint="0–10" .value=${String(f.scale ?? 2)} @input=${(ev: Event) => {
            const n = Number(text(ev))
            if (text(ev) !== "" && Number.isInteger(n) && n >= 0 && n <= 10) changeField((x) => (x.scale = n === 2 ? undefined : n))
          }}></bz-input>`
        case "choice":
          return html`<bz-textarea label="Seçenekler" hint="Her satıra bir seçenek: değer=Etiket" rows="4" autosize
            .value=${(f.choices ?? []).map((c) => `${c.value}=${c.label}`).join("\n")}
            @input=${(ev: Event) => {
              const lines = (ev.currentTarget as HTMLTextAreaElement).value.split("\n").map((x) => x.trim()).filter(Boolean)
              changeField((x) => (x.choices = lines.map((line) => {
                const [value, ...label] = line.split("=")
                return { value: value.trim(), label: (label.join("=") || value).trim() }
              })))
            }}></bz-textarea>`
        case "reference":
          return html`<bz-combobox label="Kaydı seçilen entity" .value=${f.reference ?? ""} @change=${(ev: CustomEvent<{ value: string }>) => changeField((x) => (x.reference = ev.detail.value || undefined))}>
            <bz-option value="">— seçin</bz-option>
            ${store.def()!.entities.filter((e) => !e.parent).map((e) => html`<bz-option value=${e.key}>${e.name}</bz-option>`)}
          </bz-combobox>`
        case "company":
        case "location":
        case "plant":
        case "period":
          return html`<p class="fd-note">Kullanıcının çalışabildiği ${type === "period" ? "dönemler" : type === "company" ? "firmalar" : type === "location" ? "lokasyonlar" : "plant'lar"} listelenir. ${
            type === "company" ? "" : "Modalda bir firma" + (type === "plant" ? " ya da lokasyon" : "") + " alanı varsa ona göre, yoksa çalışma bağlamına göre süzülür."
          }</p>`
        default:
          return null
      }
    }
    const modalFieldProps = () => {
      keyError.set("")
      const f = current()
      if (!f) return null
      const setLabel = (v: string) => {
        const now = current()!
        // The key follows the label until it is edited by hand.
        const follow = now.key === toKey(now.label) || new RegExp(`^${toKey(now.label)}_\\d+$`).test(now.key)
        changeField((x) => (x.label = v))
        if (follow && v.trim()) {
          const next = uniqueKey(toKey(v), now.key)
          if (keyOk(next) && next !== now.key) rename(now.key, next)
        }
      }
      const setKey = (ev: Event) => {
        const v = ((ev.target as HTMLInputElement).value ?? "").trim()
        const now = current()!
        if (v === now.key) return keyError.set("")
        if (!keyOk(v)) return keyError.set("Küçük harf, rakam ve _; harfle başlamalı (en fazla 30).")
        if (modal()!.fields.some((x) => x.key === v)) return keyError.set("Bu anahtar kullanılıyor.")
        keyError.set("")
        rename(now.key, v)
      }
      return html`
        <h3>Alan</h3>
        <bz-input label="Etiket" required data-focus="label" .value=${f.label} @input=${(ev: Event) => setLabel(text(ev))}></bz-input>
        <bz-input label="Anahtar" hint="Kodda özelliğin adı olur; Enter ya da çıkınca uygulanır." .value=${() => current()?.key ?? ""} @change=${setKey}></bz-input>
        ${() => (keyError() ? html`<div class="field-error" role="alert">${keyError()}</div>` : null)}
        ${() => html`<bz-combobox label="Tip" .value=${currentType() ?? "text"} @change=${(ev: CustomEvent<{ value: string }>) =>
          changeField((x) => {
            x.type = ev.detail.value as FieldType
            for (const p of ["maxLength", "precision", "scale", "choices", "reference"] as const) delete x[p]
          })}>
          ${MODAL_TYPES.map((t) => html`<bz-option value=${t.value}>${t.label}</bz-option>`)}
        </bz-combobox>`}
        <bz-checkbox label="Zorunlu" .checked=${() => !!current()?.required} @change=${(ev: CustomEvent<{ checked: boolean }>) => changeField((x) => (x.required = ev.detail.checked || undefined))}></bz-checkbox>
        <bz-input label="Yardım metni" hint="Alanın altında görünür." .value=${f.hint ?? ""} @input=${(ev: Event) => changeField((x) => (x.hint = text(ev) || undefined))}></bz-input>
        ${() => {
          const type = currentType()
          return untrack(() => typeProps(type))
        }}
        ${placement(currentKey)}
        <bz-button size="sm" variant="danger" @click=${() => takeOff(currentKey())}>${icon("trash")} Alanı sil</bz-button>`
    }

    // ── Side panel: properties | object tree ─────────────────────────────
    const sideTab = signal<SideTab>(isModal && savedSideTab() === "tools" ? "props" : savedSideTab())
    const showSide = (tab: SideTab) => {
      sideTab.set(tab)
      try {
        localStorage.setItem(SIDE_TAB, tab)
      } catch {
        /* the tab is just not remembered */
      }
    }
    /** The form (or modal), its sections with their fields, and a form's tools. */
    const tree = computed<TreeItem[]>(() => {
      const l = layout()
      if (!l) return []
      const all = fields()
      const sections = l.sections.map((s, i): TreeItem => ({
        id: `section:${i}`,
        label: s.title || "Başlıksız bölüm",
        icon: "dashboard",
        children: s.fields.flatMap((it): TreeItem[] => {
          const f = all.find((x) => x.key === itemKey(it))
          return f ? [{ id: `field:${f.key}`, label: `${f.label}${f.required ? " *" : ""}`, icon: TYPE_ICONS[f.type] }] : []
        }),
      }))
      const list = tools()
      const menu: TreeItem[] = list.length
        ? [{ id: "tools", label: "Araçlar menüsü", icon: "settings", children: list.map((t, i) => ({ id: `tool:${i}`, label: t.label || t.method, icon: t.icon || "cursor-click" })) }]
        : []
      return [{ id: "form", label: (isModal ? modal()?.name : form()?.name) || key, icon: isModal ? "message" : "dashboard", children: [...sections, ...menu] }]
    })
    const treeOpen = computed(() => ["form", "tools", ...(layout()?.sections.map((_, i) => `section:${i}`) ?? [])])
    const treeValue = computed(() => {
      const s = selected()
      return s.kind === "section" ? `section:${s.index}` : s.kind === "field" ? `field:${s.key}` : "form"
    })
    let treeEl: HTMLElement | undefined
    /** A node of the tree: selected on the canvas too (and scrolled to), the keyboard stays in the tree. */
    const pick = (id: string) => {
      const [kind, value] = id.split(":")
      if (kind === "section") {
        select({ kind, index: Number(value) })
        host.querySelector(`.fd-section[data-section="${value}"]`)?.scrollIntoView({ block: "nearest" })
      } else if (kind === "field") {
        select({ kind, key: value })
        host.querySelector(`.fd-item[data-key="${value}"]`)?.scrollIntoView({ block: "nearest" })
      } else {
        // The tools have a tab of their own.
        if (kind === "tools" || kind === "tool") {
          if (kind === "tool") toolIndex.set(Number(value))
          showSide("tools")
        } else select({ kind: "form" })
      }
    }
    /** The keys of the canvas work in the tree too: Alt+arrows move the selection, Delete removes it, Enter opens its properties. */
    const onTreeKey = (e: KeyboardEvent) => {
      const s = selected.peek()
      const up = e.key === "ArrowUp"
      const run = (action: () => void) => {
        e.preventDefault()
        e.stopPropagation()
        fromTree = true
        try {
          action()
        } finally {
          fromTree = false
        }
        flush()
        queueMicrotask(() => treeEl?.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')?.focus())
      }
      if (e.key === "Enter")
        queueMicrotask(() => {
          showSide("props")
          host.querySelector<HTMLElement>('.fd-side bz-tab[value="props"]')?.focus()
        })
      else if (e.altKey && (up || e.key === "ArrowDown")) {
        if (s.kind === "field") run(() => nudgeField(s.key, up ? -1 : 1))
        else if (s.kind === "section") run(() => shiftSection(s.index, up ? -1 : 1))
      } else if (e.key === "Delete") {
        if (s.kind === "field") run(() => takeOff(s.key))
        else if (s.kind === "section") run(() => dropSection(s.index))
      }
    }
    /** Moving through the tree with the arrow keys selects as it goes (the canvas follows). */
    const onTreeFocus = (e: FocusEvent) => {
      const id = (e.target as Element).closest?.("[data-id]")?.getAttribute("data-id")
      if (id && id !== treeValue.peek() && !id.startsWith("tool")) pick(id)
    }
    const objectTree = () => html`
      <bz-tree label="Nesne ağacı" selection="single" class="fd-tree-list" .items=${tree} .value=${treeValue} .expanded=${treeOpen}
        ref=${(el: HTMLElement) => ((treeEl = el), el.addEventListener("keydown", onTreeKey, true))} @focusin=${onTreeFocus}
        @select=${(e: CustomEvent<{ id: string }>) => pick(e.detail.id)} @dblclick=${() => showSide("props")}></bz-tree>
      <p class="fd-note">Seçilen tuvalde de seçilir. Çift tıklama ya da Enter özelliklerini açar (araçlar kendi sekmesinde); Alt+↑/↓ taşır, Delete ${isModal ? "siler" : "formdan çıkarır"}.</p>`

    const rootProps = () => (isModal ? modalProps() : formProps())
    const properties = () => {
      const s = selected.peek()
      if (s.kind === "section" && layout()?.sections[s.index]) return sectionProps(s.index)
      if (s.kind === "field" && layout() && locate(layout()!, s.key)) return isModal ? modalFieldProps() : fieldProps(s.key)
      return rootProps()
    }
    // Something selected that is gone (removed elsewhere, e.g. in the code view): back to the root.
    const stale = computed(() => {
      snapshot()
      const s = selected()
      const l = layout()
      return !!l && ((s.kind === "section" && !l.sections[s.index]) || (s.kind === "field" && !locate(l, s.key)))
    })

    const errors = () => store.errors().filter((e) => e.startsWith(`${isModal ? "Modal" : "Form"} '${key}'`))
    const body = () => html`
      <header class="fd-head">
        ${icon(isModal ? "message" : "dashboard", { size: 18 })}<h1>${() => (isModal ? modal()?.name : form()?.name) || key}</h1>
        <span class="muted small">${key} · ${() => (isModal ? "modal" : entity()?.name)}</span>
      </header>
      ${() =>
        errors().length
          ? html`<bz-alert variant="warning" heading=${`Yayınlamadan önce düzeltilmeli (${errors().length})`}><ul class="errors">${errors().map((e) => html`<li>${e}</li>`)}</ul></bz-alert>`
          : null}
      <div class="fd" data-kind=${isModal ? "modal" : "form"} @dragstart=${onDragStart} @dragover=${onDragOver} @drop=${onDrop} @dragend=${endDrag}>
        <aside class="fd-palette" aria-label="Palet">${() => (snapshot(), untrack(palette))}</aside>
        <div class="fd-canvas" aria-label="Tuval" @click=${() => select({ kind: "form" })}>${() => (snapshot(), untrack(canvas))}</div>
        <aside class="fd-side" aria-label="Özellikler ve nesne ağacı">
          <bz-tabs fill .value=${sideTab} @change.self=${(e: CustomEvent<{ value: string }>) => showSide(e.detail.value === "tree" || e.detail.value === "tools" ? e.detail.value : "props")}>
            <bz-tab-list label="Yan panel">
              <bz-tab value="props">Özellikler</bz-tab>
              <bz-tab value="tree">Nesne ağacı</bz-tab>
              ${isModal ? null : html`<bz-tab value="tools">Araçlar${() => (tools().length ? ` (${tools().length})` : "")}</bz-tab>`}
            </bz-tab-list>
            <bz-tab-panel value="props"><div class="fd-props">${() => (shown(), stale() ? untrack(rootProps) : untrack(properties))}</div></bz-tab-panel>
            <bz-tab-panel value="tree"><div class="fd-tree">${objectTree()}</div></bz-tab-panel>
            ${isModal ? null : html`<bz-tab-panel value="tools"><div class="fd-tools">${toolsPanel()}</div></bz-tab-panel>`}
          </bz-tabs>
        </aside>
      </div>`

    return html`${() => (exists() ? untrack(body) : html`<div class="page editor-page"><bz-alert variant="danger">${isModal ? "Modal" : "Form"} taslakta yok.</bz-alert></div>`)}`
  },
})
