import { html, signal, untrack, type Signal } from "@bazlama/core"
import { icon } from "@bazlama/headless"

/*
 * A designer tab with two views of the same part of the draft: "Tasarım" (the visual designer)
 * and "Kod" (its JSON in Monaco). Both stay mounted once shown, so switching keeps the cursor,
 * the selection and the scroll position; the view chosen per tab is remembered.
 */

type Mode = "design" | "code"
const KEY = "bazlama-dual-view"

function load(): Record<string, Mode> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown
    return v && typeof v === "object" ? (v as Record<string, Mode>) : {}
  } catch {
    return {}
  }
}
function save(id: string, mode: Mode) {
  try {
    const all = load()
    if (mode === "design") delete all[id]
    else all[id] = mode
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* storage unavailable */
  }
}

const modes = new Map<string, Signal<Mode>>()

/** `id`: the tab (its view is remembered); `design` and `code` render the two views (each once). */
export function dualView(id: string, design: () => unknown, code: () => unknown) {
  let mode = modes.get(id)
  if (!mode) modes.set(id, (mode = signal<Mode>(load()[id] ?? "design")))
  const m = mode
  const codeShown = signal(m.peek() === "code")
  const set = (next: Mode) => {
    m.set(next)
    save(id, next)
    if (next === "code") codeShown.set(true)
  }
  const button = (value: Mode, label: string, iconName: string, hint: string) =>
    html`<button type="button" class="dual-tab" aria-pressed=${() => String(m() === value)} data-tooltip=${hint} @click=${() => set(value)}>
      ${icon(iconName, { size: 14 })}<span>${label}</span></button>`

  return html`<div class="dual-view" data-mode=${m}>
    <div class="dual-bar" role="group" aria-label="Görünüm">
      ${button("design", "Tasarım", "dashboard", "Görsel tasarımcı")}
      ${button("code", "Kod", "code", "JSON olarak düzenle (şemalı, otomatik tamamlamalı)")}
    </div>
    <div class="dual-design" ?hidden=${() => m() !== "design"}>${design()}</div>
    ${() => (codeShown() ? html`<div class="dual-code" ?hidden=${() => m() !== "code"}>${untrack(code)}</div>` : null)}
  </div>`
}
