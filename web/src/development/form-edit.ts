import { formItem, itemKey, itemSpan, type FormItem, type FormSection } from "../runtime/api"

/*
 * Changes to a layout (sections of fields: a form's or a modal's), as plain functions on the
 * definition: the designer's drag and drop, buttons and keys all end here, and so does the
 * entity editor when a field is renamed or removed. They change the layout in place (the draft
 * store hands out a copy to change).
 */

/** What is laid out: a form, or a modal. */
export interface Layout {
  sections: FormSection[]
}

/** Columns a section may have. */
export const MAX_COLUMNS = 3
export const columnsOf = (s: FormSection) => Math.min(MAX_COLUMNS, Math.max(1, s.columns ?? 2))

/** Keys of the fields on the form. */
export const placedKeys = (f: Layout) => new Set(f.sections.flatMap((s) => s.fields.map(itemKey)))

/** Where a field is: its section and its place in it. */
export function locate(f: Layout, key: string): { section: number; index: number } | null {
  for (let section = 0; section < f.sections.length; section++) {
    const index = f.sections[section].fields.findIndex((i) => itemKey(i) === key)
    if (index >= 0) return { section, index }
  }
  return null
}

/** Takes a field off the form; returns what was there (to put it somewhere else). */
export function removeField(f: Layout, key: string): FormItem | null {
  const at = locate(f, key)
  if (!at) return null
  return f.sections[at.section].fields.splice(at.index, 1)[0]
}

/**
 * Puts a field into a section, before the field `before` (null: at the end). A field already on
 * the form moves; its width is kept as far as the new section has columns.
 */
export function placeField(f: Layout, key: string, section: number, before: string | null = null) {
  if (before === key) return
  const target = f.sections[section]
  if (!target) return
  const item = removeField(f, key) ?? key
  const span = itemSpan(item)
  const fitted = formItem(key, span ? Math.min(span, columnsOf(target)) : undefined)
  const index = before === null ? -1 : target.fields.findIndex((i) => itemKey(i) === before)
  if (index < 0) target.fields.push(fitted)
  else target.fields.splice(index, 0, fitted)
}

/** Moves a field one place in reading order; at the edge of its section it goes to the next one. */
export function moveField(f: Layout, key: string, by: -1 | 1) {
  const at = locate(f, key)
  if (!at) return
  const fields = f.sections[at.section].fields
  const to = at.index + by
  if (to >= 0 && to < fields.length) {
    ;[fields[at.index], fields[to]] = [fields[to], fields[at.index]]
    return
  }
  const next = at.section + by
  if (next < 0 || next >= f.sections.length) return
  placeField(f, key, next, by > 0 ? (f.sections[next].fields[0] ? itemKey(f.sections[next].fields[0]) : null) : null)
}

/** Sets how many columns a field takes; undefined: by its type (one; a long text the row). */
export function setSpan(f: Layout, key: string, span: number | undefined) {
  const at = locate(f, key)
  if (at) f.sections[at.section].fields[at.index] = formItem(key, span)
}

/** A field's key changed in the entity. */
export function renameField(f: Layout, from: string, to: string) {
  for (const s of f.sections) s.fields = s.fields.map((i) => (itemKey(i) === from ? formItem(to, itemSpan(i)) : i))
}

/** Adds an empty section before the section at `before` (default: at the end); returns its index. */
export function addSection(f: Layout, before = f.sections.length): number {
  const at = Math.max(0, Math.min(before, f.sections.length))
  f.sections.splice(at, 0, { title: `Bölüm ${f.sections.length + 1}`, fields: [], columns: 2 })
  return at
}

/** Moves a section so that it comes before the section now at `before`; returns its new index. */
export function moveSection(f: Layout, from: number, before: number): number {
  if (from < 0 || from >= f.sections.length) return from
  const [section] = f.sections.splice(from, 1)
  const at = Math.max(0, Math.min(before > from ? before - 1 : before, f.sections.length))
  f.sections.splice(at, 0, section)
  return at
}

/** Removes a section; its fields leave the form (they are back in the palette). */
export function removeSection(f: Layout, index: number) {
  f.sections.splice(index, 1)
}

/** Sets a section's column count; fields wider than that shrink to it. */
export function setColumns(f: Layout, index: number, columns: number) {
  const s = f.sections[index]
  if (!s) return
  s.columns = Math.min(MAX_COLUMNS, Math.max(1, columns))
  s.fields = s.fields.map((i) => {
    const span = itemSpan(i)
    return span && span > s.columns! ? formItem(itemKey(i), s.columns) : i
  })
}
