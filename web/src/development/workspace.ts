import { computed, html, onCleanup, signal } from "@bazlama/core"
import { dialogs, icon, toast } from "@bazlama/headless"
import { errorText } from "../api"
import { confirmAction, formDialog, textField } from "../management/ui"

/*
 * A code workspace: a file list, one Monaco editor and a problems panel. Diagnostics come from
 * the server (Roslyn) a moment after typing stops; they are drawn as markers in the editor.
 * Used for app code and for code libraries.
 */

export interface SourceFile {
  path: string
  content: string
}
export interface CodeDiagnostic {
  path: string
  line: number
  column: number
  endLine: number
  endColumn: number
  severity: "error" | "warning"
  code: string
  message: string
}
export interface CheckResult {
  success: boolean
  diagnostics: CodeDiagnostic[]
}
/** A suggestion from Roslyn (kind: Class, Method, Property, Keyword…). */
export interface CompletionEntry {
  label: string
  insertText: string
  filterText: string
  kind: string
  sortText: string
}

export interface WorkspaceOptions {
  files: SourceFile[]
  /** Shown read-only (the generated entity classes). */
  readonly?: SourceFile[]
  save: (file: SourceFile) => Promise<unknown>
  remove: (path: string) => Promise<unknown>
  check: (files: SourceFile[]) => Promise<CheckResult>
  /** Starting text of a new file. */
  template: (path: string) => string
  /** Suggestions at a position (1-based) of a file, given every file's current text. */
  complete?: (files: SourceFile[], path: string, line: number, column: number) => Promise<CompletionEntry[]>
  /** A read-only workspace (no development rights or not a development installation). */
  locked?: boolean
}

type Monaco = typeof import("./monaco").monaco
type Model = import("monaco-editor/editor/editor.api").editor.ITextModel

/*
 * Monaco takes one completion provider per language; it asks the workspace that owns the model
 * (by its URI) for suggestions.
 */
const completers = new Map<string, (line: number, column: number) => Promise<CompletionEntry[]>>()
let providerRegistered = false

function registerCompletion(m: Monaco) {
  if (providerRegistered) return
  providerRegistered = true
  const kinds: Record<string, number> = {
    Class: m.languages.CompletionItemKind.Class,
    Structure: m.languages.CompletionItemKind.Struct,
    Interface: m.languages.CompletionItemKind.Interface,
    Enum: m.languages.CompletionItemKind.Enum,
    EnumMember: m.languages.CompletionItemKind.EnumMember,
    Method: m.languages.CompletionItemKind.Method,
    ExtensionMethod: m.languages.CompletionItemKind.Method,
    Property: m.languages.CompletionItemKind.Property,
    Field: m.languages.CompletionItemKind.Field,
    Event: m.languages.CompletionItemKind.Event,
    Local: m.languages.CompletionItemKind.Variable,
    Parameter: m.languages.CompletionItemKind.Variable,
    Constant: m.languages.CompletionItemKind.Constant,
    Keyword: m.languages.CompletionItemKind.Keyword,
    Namespace: m.languages.CompletionItemKind.Module,
    Delegate: m.languages.CompletionItemKind.Function,
  }
  m.languages.registerCompletionItemProvider("csharp", {
    triggerCharacters: ["."],
    async provideCompletionItems(model, position) {
      const complete = completers.get(model.uri.toString())
      if (!complete) return { suggestions: [] }
      const word = model.getWordUntilPosition(position)
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }
      try {
        const items = await complete(position.lineNumber, position.column)
        return {
          suggestions: items.map((i) => ({
            label: i.label,
            insertText: i.insertText,
            filterText: i.filterText,
            sortText: i.sortText,
            kind: kinds[i.kind] ?? m.languages.CompletionItemKind.Text,
            range,
          })),
        }
      } catch {
        return { suggestions: [] }
      }
    },
  })
}

export function codeWorkspace(o: WorkspaceOptions) {
  const saved = new Map(o.files.map((f) => [f.path, f.content]))
  const paths = signal<string[]>(o.files.map((f) => f.path).sort())
  const readonlyPaths = (o.readonly ?? []).map((f) => f.path)
  const current = signal(paths()[0] ?? readonlyPaths[0] ?? "")
  const dirty = signal<Set<string>>(new Set())
  const diagnostics = signal<CodeDiagnostic[]>([])
  const checking = signal(false)
  const ready = signal(false)

  let m: Monaco | undefined
  let editor: import("monaco-editor/editor/editor.api").editor.IStandaloneCodeEditor | undefined
  const models = new Map<string, Model>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const contents = () => paths().map((p) => ({ path: p, content: models.get(p)?.getValue() ?? saved.get(p) ?? "" }))
  const isReadonly = (path: string) => o.locked || readonlyPaths.includes(path)

  const model = (path: string, content: string) => {
    let mdl = models.get(path)
    if (!mdl && m) {
      mdl = m.editor.createModel(content, "csharp", m.Uri.parse(`file:///${path}`))
      mdl.onDidChangeContent(() => {
        // Back to the saved text (undo): not dirty any more.
        const changed = !readonlyPaths.includes(path) && mdl!.getValue() !== saved.get(path)
        dirty.update((d) => {
          const n = new Set(d)
          if (changed) n.add(path)
          else n.delete(path)
          return n
        })
        scheduleCheck()
      })
      models.set(path, mdl)
      if (o.complete && !readonlyPaths.includes(path))
        completers.set(mdl.uri.toString(), (line, column) => o.complete!(contents(), path, line, column))
    }
    return mdl
  }

  const scheduleCheck = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void runCheck(), 700)
  }
  const runCheck = async () => {
    checking.set(true)
    try {
      const r = await o.check(contents())
      if (disposed) return
      diagnostics.set(r.diagnostics)
      applyMarkers()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      checking.set(false)
    }
  }
  const applyMarkers = () => {
    if (!m) return
    for (const [path, mdl] of models)
      m.editor.setModelMarkers(
        mdl,
        "bazlama",
        diagnostics()
          .filter((d) => d.path === path)
          .map((d) => ({
            startLineNumber: d.line,
            startColumn: d.column,
            endLineNumber: d.endLine,
            endColumn: Math.max(d.endColumn, d.column + 1),
            message: `${d.message} (${d.code})`,
            severity: d.severity === "error" ? m!.MarkerSeverity.Error : m!.MarkerSeverity.Warning,
          })),
      )
  }

  const open = (path: string, line?: number, column?: number) => {
    current.set(path)
    if (!editor || !m) return
    const mdl = model(path, saved.get(path) ?? o.readonly?.find((f) => f.path === path)?.content ?? "")!
    editor.setModel(mdl)
    editor.updateOptions({ readOnly: isReadonly(path) })
    if (line) {
      editor.revealLineInCenter(line)
      editor.setPosition({ lineNumber: line, column: column ?? 1 })
    }
    editor.focus()
  }

  const save = async (path = current()) => {
    if (isReadonly(path) || !dirty().has(path)) return
    const content = models.get(path)!.getValue()
    try {
      await o.save({ path, content })
      saved.set(path, content)
      dirty.update((d) => {
        const n = new Set(d)
        n.delete(path)
        return n
      })
    } catch (e) {
      toast.error(errorText(e))
      throw e
    }
  }
  const saveAll = async () => {
    for (const p of [...dirty()]) await save(p)
  }

  const create = async () => {
    const path = signal("")
    const ok = await formDialog({
      heading: "Yeni dosya",
      submitText: "Oluştur",
      body: () => html`${textField("Dosya yolu", path, { required: true, hint: "Örn. Siparis/SiparisEvents.cs" })}`,
      submit: async () => {
        const p = path().trim().replace(/\\/g, "/")
        if (!/^[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-]+)*\.cs$/.test(p)) throw new Error("Dosya yolu harf, rakam, _ ve - içerebilir ve .cs ile bitmeli.")
        if (paths().includes(p)) throw new Error("Bu dosya zaten var.")
        await o.save({ path: p, content: o.template(p) })
        saved.set(p, o.template(p))
        paths.update((ps) => [...ps, p].sort())
        path.set(p)
      },
    })
    if (ok) {
      open(path().trim().replace(/\\/g, "/"))
      scheduleCheck()
    }
  }
  const remove = (path: string) =>
    confirmAction({
      heading: "Dosyayı sil",
      message: `${path} silinsin mi?`,
      confirmText: "Sil",
      danger: true,
      action: async () => {
        await o.remove(path)
        models.get(path)?.dispose()
        models.delete(path)
        saved.delete(path)
        paths.update((ps) => ps.filter((p) => p !== path))
        dirty.update((d) => {
          const n = new Set(d)
          n.delete(path)
          return n
        })
        open(paths()[0] ?? readonlyPaths[0] ?? "")
        scheduleCheck()
      },
    })

  const mount = async (host: HTMLElement) => {
    m = (await import("./monaco")).monaco
    if (disposed) return
    registerCompletion(m)
    const dark = /dark/.test(document.documentElement.dataset.theme ?? "")
    editor = m.editor.create(host, {
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabSize: 4,
      theme: dark ? "vs-dark" : "vs",
      fixedOverflowWidgets: true,
      // Turkish letters (ı, ş, ğ…) are not "confusable" characters in this editor.
      unicodeHighlight: { ambiguousCharacters: false, nonBasicASCII: false },
    })
    // Ctrl+S saves the open file.
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => void save())
    for (const f of o.files) model(f.path, f.content)
    for (const f of o.readonly ?? []) model(f.path, f.content)
    dirty.set(new Set())
    ready.set(true)
    open(current())
    void runCheck()
  }

  onCleanup(() => {
    disposed = true
    clearTimeout(timer)
    editor?.dispose()
    for (const mdl of models.values()) {
      completers.delete(mdl.uri.toString())
      mdl.dispose()
    }
  })

  const counts = computed(() => {
    const c = new Map<string, number>()
    for (const d of diagnostics()) if (d.severity === "error") c.set(d.path, (c.get(d.path) ?? 0) + 1)
    return c
  })
  const errors = computed(() => diagnostics().filter((d) => d.severity === "error").length)
  const warnings = computed(() => diagnostics().length - errors())

  const fileItem = (path: string, ro: boolean) => html`<li>
    <button type="button" class=${() => `file ${current() === path ? "current" : ""}`} @click=${() => open(path)}>
      ${icon(ro ? "lock" : "file-text", { size: 14 })}<span class="name">${path}</span>
      ${() => (dirty().has(path) ? html`<span class="dot" title="Kaydedilmedi">●</span>` : null)}
      ${() => (counts().get(path) ? html`<bz-badge variant="danger" .count=${counts().get(path)!}></bz-badge>` : null)}
    </button>
    ${ro || o.locked ? null : html`<bz-button size="sm" variant="ghost" aria-label=${`${path} sil`} @click=${() => remove(path)}>${icon("trash", { size: 14 })}</bz-button>`}
  </li>`

  // data-shell-fill: the workspace takes the rest of the page's height (bz-shell).
  const view = html`<div class="workspace" data-shell-fill>
    <aside class="files">
      <div class="row"><strong>Dosyalar</strong><span class="spacer"></span>
        ${o.locked ? null : html`<bz-button size="sm" variant="ghost" aria-label="Yeni dosya" data-tooltip="Yeni dosya" @click=${create}>${icon("plus")}</bz-button>`}</div>
      <ul>${() => paths().map((p) => fileItem(p, false))}</ul>
      ${readonlyPaths.length ? html`<div class="muted small">Üretilen (salt okunur)</div><ul>${readonlyPaths.map((p) => fileItem(p, true))}</ul>` : null}
    </aside>
    <div class="editor-host" ref=${(el: HTMLElement) => void mount(el)}>
      ${() => (ready() ? null : html`<span class="muted loading">Editör yükleniyor…</span>`)}
    </div>
    <section class="problems" aria-label="Sorunlar">
      <div class="row">
        <strong>Sorunlar</strong>
        ${() => html`<span class="muted small">${errors()} hata · ${warnings()} uyarı</span>`}
        ${() => (checking() ? html`<span class="muted small">denetleniyor…</span>` : null)}
      </div>
      <ul>
        ${() =>
          diagnostics().map(
            (d) => html`<li><button type="button" class=${`problem ${d.severity}`} @click=${() => open(d.path, d.line, d.column)}>
              ${icon(d.severity === "error" ? "alert" : "info", { size: 14 })}
              <span class="where">${d.path}:${d.line}</span><span class="message">${d.message}</span><span class="muted small">${d.code}</span>
            </button></li>`,
          )}
      </ul>
    </section>
  </div>`

  return { view, saveAll, dirtyCount: () => dirty().size, check: runCheck, diagnostics }
}

/** Asks before leaving with unsaved files. */
export const unsavedGuard = (count: () => number) => async () =>
  count() === 0 ||
  dialogs.confirm({ heading: "Kaydedilmemiş dosyalar", message: `${count()} dosyada kaydedilmemiş değişiklik var. Çıkılsın mı?`, confirmText: "Çık", cancelText: "Kal", variant: "danger" })
