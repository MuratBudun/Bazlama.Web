import { computed, define, effect, flush, html, onCleanup, prop, repeat, signal, untrack } from "@bazlama/core"
import { contextMenu, icon, type MenuItemData, type TreeItem } from "@bazlama/headless"
import type { CodeEditorElement } from "./code-editor"

/*
 * <bazlama-workbench .model=${model}> — the development workspace: an explorer tree, editor
 * tabs and a problems panel, split by draggable separators. What the tree shows, what a tab
 * contains and what the problems are comes from the model; the workbench keeps which tabs
 * are open (saved per model in localStorage) and wires the parts together.
 *
 * Tab ids are tree item ids: the explorer marks the open tab, and a tab whose item left the
 * tree (a removed entity or file) closes.
 */

export interface WorkbenchTab {
  title: () => string
  icon: string
  /** Tooltip of the tab (e.g. the full path). */
  detail?: string
  dirty?: () => boolean
  /** The tab's content, rendered once when the tab first opens (state survives switching). */
  content: () => unknown
}

export interface Problem {
  severity: "error" | "warning"
  /** The tab that shows it. */
  tab: string
  where: string
  message: string
  code?: string
  line?: number
  column?: number
}

export interface WorkbenchModel {
  /** Explorer heading and the localStorage key of the layout. */
  label: string
  persist: string
  tree: () => TreeItem[]
  /** Opened when nothing was saved. */
  initial?: string[]
  /** Expanded when nothing was saved. */
  expanded?: string[]
  /** The tab of a tree item; null: the item only expands (a folder). */
  tab(id: string): WorkbenchTab | null
  /** Click / Enter on an item that has no tab (e.g. opens a dialog). */
  activate?(id: string): void
  /** Context menu of a tree item (null id: empty space). */
  menu?(id: string | null): MenuItemData[] | null
  command?(value: string, id: string | null): void
  /** Buttons in the explorer heading. */
  actions?: () => unknown
  problems: () => Problem[]
  checking?: () => boolean
  /** Ctrl+S on a tab. */
  save?(id: string): unknown
}

export interface WorkbenchElement extends HTMLElement {
  model: WorkbenchModel | null
  /** Opens (or shows) a tab; a position moves the cursor of a code tab. */
  open(id: string, at?: { line: number; column?: number }): void
  close(id: string): void
  current(): string
}

interface Layout {
  open: string[]
  current: string
  expanded: string[]
}

const flatten = (items: TreeItem[]): TreeItem[] => items.flatMap((n) => [n, ...flatten(n.children ?? [])])

function loadLayout(key: string): Partial<Layout> {
  try {
    const v = JSON.parse(localStorage.getItem(`bazlama-workbench:${key}`) ?? "null") as Partial<Layout> | null
    return v && typeof v === "object" ? v : {}
  } catch {
    return {}
  }
}
function saveLayout(key: string, layout: Layout) {
  try {
    localStorage.setItem(`bazlama-workbench:${key}`, JSON.stringify(layout))
  } catch {
    /* storage unavailable */
  }
}

export const Workbench = define("bazlama-workbench", {
  props: {
    model: prop.object<WorkbenchModel | null>(null),
  },
  setup(props, { host }) {
    const model = props.model.peek()
    if (!model) return null
    const saved = loadLayout(model.persist)
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined)

    const tabs = new Map<string, WorkbenchTab>()
    const tabOf = (id: string) => {
      let t = tabs.get(id)
      if (!t) {
        const made = untrack(() => model.tab(id))
        if (made) tabs.set(id, (t = made))
      }
      return t ?? null
    }
    const ids = computed(() => new Set(flatten(model.tree()).map((i) => i.id)))
    const known = (id: string) => ids().has(id) && tabOf(id) !== null

    const open = signal<string[]>((strings(saved.open) ?? model.initial ?? []).filter((id) => untrack(() => known(id))))
    const current = signal(typeof saved.current === "string" && open().includes(saved.current) ? saved.current : (open()[0] ?? ""))
    const expanded = signal<string[]>(strings(saved.expanded) ?? model.expanded ?? [])
    effect(() => saveLayout(model.persist, { open: open(), current: current(), expanded: expanded() }))

    // An item that left the tree closes its tab.
    effect(() => {
      const list = open()
      const kept = list.filter((id) => known(id))
      if (kept.length === list.length) return
      for (const id of list) if (!kept.includes(id)) tabs.delete(id)
      open.set(kept)
      if (!kept.includes(current.peek())) current.set(kept[0] ?? "")
    })

    let tabsEl: HTMLElement | undefined
    const reveal = (id: string, at?: { line: number; column?: number }) => {
      if (!at) return
      flush()
      const editor = tabsEl?.querySelector<CodeEditorElement>(`bz-tab-panel[value="${CSS.escape(id)}"] bazlama-code-editor`)
      void editor?.reveal(at.line, at.column)
    }
    const openTab = (id: string, at?: { line: number; column?: number }) => {
      if (!tabOf(id)) return void model.activate?.(id)
      if (!open().includes(id)) {
        // After the current tab, as editors do.
        const list = [...open()]
        const i = list.indexOf(current())
        list.splice(i < 0 ? list.length : i + 1, 0, id)
        open.set(list)
      }
      current.set(id)
      reveal(id, at)
    }
    const closeTab = (id: string) => {
      if (!open().includes(id)) return
      const list = open()
      const i = list.indexOf(id)
      const rest = list.filter((x) => x !== id)
      open.set(rest)
      tabs.delete(id)
      if (current() === id) current.set(rest[Math.min(i, rest.length - 1)] ?? "")
    }
    const el = host as unknown as WorkbenchElement
    el.open = openTab
    el.close = closeTab
    el.current = () => current()

    // Ctrl+S: before Monaco sees it (capture), for any tab.
    const onKeydown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault()
        e.stopPropagation()
        if (current()) void model.save?.(current())
      }
    }
    host.addEventListener("keydown", onKeydown, true)
    onCleanup(() => host.removeEventListener("keydown", onKeydown, true))

    const treeRef = (tree: HTMLElement) => {
      const idAt = (e: Event) => (e.target as Element).closest?.("[data-id]")?.getAttribute("data-id") ?? null
      if (!model.menu) return
      const remove = contextMenu(
        tree,
        (e) => model.menu!(idAt(e)),
        (value, e) => model.command?.(value, idAt(e)),
      )
      onCleanup(remove)
    }

    const tabLabel = (id: string) => {
      const t = tabOf(id)!
      return html`<bz-tab value=${id} closable close-label="Kapat" title=${t.detail ?? null}>
        ${icon(t.icon, { size: 14 })}<span data-part="title">${t.title}</span>
        ${() => (t.dirty?.() ? html`<span class="wb-dirty" aria-label="kaydedilmedi">●</span>` : null)}
      </bz-tab>`
    }
    const tabPanel = (id: string) => html`<bz-tab-panel value=${id}>${tabOf(id)!.content()}</bz-tab-panel>`

    const problems = computed(() => model.problems())
    const errors = computed(() => problems().filter((p) => p.severity === "error").length)
    const warnings = computed(() => problems().length - errors())

    // The problems panel opens and closes; closed, a bar below the editors keeps the counts in
    // view (red while there are errors). The split owns the state (it keeps it with the size).
    const problemsOpen = signal(true)
    let problemsSplit: (HTMLElement & { collapsed: boolean }) | undefined
    const splitRef = (el: HTMLElement) => {
      problemsSplit = el as HTMLElement & { collapsed: boolean }
      // The split reads its saved state when it connects.
      queueMicrotask(() => problemsOpen.set(!problemsSplit!.collapsed))
    }
    const showProblems = (open: boolean) => {
      if (problemsSplit) problemsSplit.collapsed = !open
      problemsOpen.set(open)
    }
    /** The counts as badges: coloured only while there is something to see. */
    const counts = () => html`<span class="wb-counts">
      <bz-badge variant=${errors() ? "danger" : "neutral"}>${icon("alert", { size: 12 })} ${errors()} hata</bz-badge>
      <bz-badge variant=${warnings() ? "warning" : "neutral"}>${icon("info", { size: 12 })} ${warnings()} uyarı</bz-badge>
    </span>`

    return html`
      <bz-split size="260" min="180" collapsible persist=${`bazlama-wb-explorer`} label="Gezgini boyutlandır">
        <section class="wb-explorer" aria-label=${model.label}>
          <header class="wb-head"><strong>${model.label}</strong><span class="spacer"></span>${model.actions?.() ?? null}</header>
          <bz-tree label=${model.label} selection="single" empty-text="Boş" ref=${treeRef}
            .items=${model.tree} .value=${current} .expanded=${expanded}
            @toggle=${(e: CustomEvent<{ id: string; expanded: boolean }>) =>
              expanded.update((x) => (e.detail.expanded ? [...new Set([...x, e.detail.id])] : x.filter((i) => i !== e.detail.id)))}
            @activate=${(e: CustomEvent<{ id: string }>) => openTab(e.detail.id)}></bz-tree>
        </section>
        <div class="wb-main">
        <bz-split orientation="vertical" primary="end" size="160" min="72" collapsible persist="bazlama-wb-problems" label="Sorunlar panelini boyutlandır" ref=${splitRef}
          @toggle=${(e: CustomEvent<{ collapsed: boolean }>) => problemsOpen.set(!e.detail.collapsed)}>
          <div class="wb-editors">
            ${() => (open().length ? null : html`<div class="wb-empty muted">Gezginden bir entity ya da dosya açın.</div>`)}
            <bz-tabs fill ?hidden=${() => open().length === 0} .value=${current} ref=${(t: HTMLElement) => (tabsEl = t)}
              @change.self=${(e: CustomEvent<{ value: string }>) => current.set(e.detail.value)}
              @close.self=${(e: CustomEvent<{ value: string }>) => closeTab(e.detail.value)}>
              <bz-tab-list>${() => repeat(open, (id) => id, tabLabel)}</bz-tab-list>
              ${() => repeat(open, (id) => id, tabPanel)}
            </bz-tabs>
          </div>
          <section class="wb-problems" aria-label="Sorunlar">
            <header class="wb-head">
              <strong>Sorunlar</strong>
              ${() => counts()}
              ${() => (model.checking?.() ? html`<span class="muted small">denetleniyor…</span>` : null)}
              <span class="spacer"></span>
              <bz-button size="sm" variant="ghost" aria-label="Sorunlar panelini kapat" data-tooltip="Kapat" @click=${() => showProblems(false)}>${icon("chevron-down")}</bz-button>
            </header>
            <ul>
              ${() =>
                problems().map(
                  (p) => html`<li><button type="button" class=${`problem ${p.severity}`} @click=${() => openTab(p.tab, p.line ? { line: p.line, column: p.column } : undefined)}>
                    ${icon(p.severity === "error" ? "alert" : "info", { size: 14 })}
                    <span class="where">${p.where}</span><span class="message">${p.message}</span>${p.code ? html`<span class="muted small">${p.code}</span>` : null}
                  </button></li>`,
                )}
            </ul>
          </section>
        </bz-split>
        ${() =>
          problemsOpen()
            ? null
            : html`<button type="button" class="wb-problems-bar" data-errors=${() => String(errors() > 0)} aria-expanded="false" @click=${() => showProblems(true)}>
                <strong>Sorunlar</strong>${() => counts()}${() => (model.checking?.() ? html`<span class="muted small">denetleniyor…</span>` : null)}
                <span class="spacer"></span>${icon("chevron-up", { size: 14 })}
              </button>`}
        </div>
      </bz-split>
    `
  },
})
