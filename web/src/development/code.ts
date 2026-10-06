import { computed, signal } from "@bazlama/core"
import { toast, type TreeItem } from "@bazlama/headless"
import { errorText } from "../api"

/*
 * The source files of an app or a code library: one Monaco model per file, shared by every
 * editor tab that shows it. Tracks unsaved changes and asks the server (Roslyn) for
 * diagnostics a moment after typing stops; they become markers on the models.
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
/** A method of a form's code class that a tool may call; positions are 1-based. */
export interface FormMethod {
  name: string
  path: string
  line: number
  column: number
}
/** A form's code class: where it is, where it ends (its closing brace) and the methods its tools may call. */
export interface FormCodeOutline {
  form: string
  class: string
  /** The class of the records the form edits ("Siparis"). */
  record: string
  path: string
  line: number
  column: number
  endLine: number
  endColumn: number
  methods: FormMethod[]
}
export interface CheckResult {
  success: boolean
  diagnostics: CodeDiagnostic[]
  /** The forms' code classes in the checked files (an app's check; a library has none). */
  forms?: FormCodeOutline[]
}
/** A suggestion from Roslyn (kind: Class, Method, Property, Keyword…). */
export interface CompletionEntry {
  label: string
  insertText: string
  filterText: string
  kind: string
  sortText: string
}

export interface CodeFilesOptions {
  files: SourceFile[]
  /** Shown read-only (the generated entity classes). */
  readonly?: SourceFile[]
  save: (file: SourceFile) => Promise<unknown>
  remove: (path: string) => Promise<unknown>
  check: (files: SourceFile[]) => Promise<CheckResult>
  /** Suggestions at a position (1-based) of a file, given every file's current text. */
  complete?: (files: SourceFile[], path: string, line: number, column: number) => Promise<CompletionEntry[]>
}

export type Monaco = typeof import("./monaco").monaco
export type Model = import("monaco-editor/editor/editor.api").editor.ITextModel

/** "Siparis/SiparisEvents.cs" → "SiparisEvents" (a class name for a new file). */
export const className = (path: string) => (path.split("/").pop() ?? "Kod").replace(/\.cs$/, "").replace(/[^A-Za-z0-9_]/g, "") || "Kod"
/** Same rule as EntityCodeGenerator.Pascal: "siparis_satir" → "SiparisSatir". */
export const pascal = (key: string) =>
  key
    .split(/[_\-. ]/)
    .map((p) => p.replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join("")
/**
 * Where the generated class of an entity or a modal is declared in the generated file
 * (EntityCodeGenerator marks each class with [Entity("key")] or [Modal("key")]): 1-based, the
 * column of the class name. Null: the file has no such class (yet).
 */
export function generatedClassAt(text: string, kind: "Entity" | "Modal", key: string): { line: number; column: number } | null {
  const lines = text.split(/\r?\n/)
  const mark = lines.findIndex((l) => l.trim() === `[${kind}("${key}")]`)
  if (mark < 0) return null
  const at = lines.findIndex((l, i) => i > mark && /\bclass\s/.test(l))
  if (at < 0) return null
  return { line: at + 1, column: lines[at].search(/\bclass\s/) + "class ".length + 1 }
}
export const validPath = (path: string) => /^[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-]+)*\.cs$/.test(path)

/**
 * Explorer items of source files: folders ("folder:Siparis") and files ("file:Siparis/X.cs"),
 * folders first, each with its error count as a badge.
 */
export function codeTree(paths: string[], errors: ReadonlyMap<string, number>, readonly = false): TreeItem[] {
  const root: TreeItem[] = []
  const folders = new Map<string, TreeItem[]>([["", root]])
  const folder = (path: string): TreeItem[] => {
    let list = folders.get(path)
    if (list) return list
    const cut = path.lastIndexOf("/")
    const parent = folder(cut < 0 ? "" : path.slice(0, cut))
    list = []
    folders.set(path, list)
    parent.push({ id: `folder:${path}`, label: path.slice(cut + 1), icon: "folder", children: list })
    return list
  }
  for (const path of [...paths].sort()) {
    const cut = path.lastIndexOf("/")
    const count = errors.get(path)
    folder(cut < 0 ? "" : path.slice(0, cut)).push({ id: `file:${path}`, label: path.slice(cut + 1), icon: readonly ? "lock" : "file-text", badge: count || undefined })
  }
  const sort = (list: TreeItem[]) => {
    list.sort((a, b) => Number(!a.children) - Number(!b.children) || a.label.localeCompare(b.label, "tr"))
    for (const i of list) if (i.children) sort(i.children)
  }
  sort(root)
  return root
}

/*
 * Monaco takes one completion provider per language; it asks the files that own the model
 * (by its URI) for suggestions.
 */
const completers = new Map<string, (line: number, column: number) => Promise<CompletionEntry[]>>()
let providerRegistered = false

function registerCompletion(m: Monaco) {
  if (providerRegistered) return
  providerRegistered = true
  const k = m.languages.CompletionItemKind
  const kinds: Record<string, number> = {
    Class: k.Class,
    Structure: k.Struct,
    Interface: k.Interface,
    Enum: k.Enum,
    EnumMember: k.EnumMember,
    Method: k.Method,
    ExtensionMethod: k.Method,
    Property: k.Property,
    Field: k.Field,
    Event: k.Event,
    Local: k.Variable,
    Parameter: k.Variable,
    Constant: k.Constant,
    Keyword: k.Keyword,
    Namespace: k.Module,
    Delegate: k.Function,
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
          suggestions: items.map((i) => ({ label: i.label, insertText: i.insertText, filterText: i.filterText, sortText: i.sortText, kind: kinds[i.kind] ?? k.Text, range })),
        }
      } catch {
        return { suggestions: [] }
      }
    },
  })
}

/** Each set of files gets its own URI space: two workbenches (an app, a library) never share a model. */
let instances = 0

export function codeFiles(o: CodeFilesOptions) {
  const space = `bazlama${++instances}`
  const saved = new Map(o.files.map((f) => [f.path, f.content]))
  const readonlyText = new Map((o.readonly ?? []).map((f) => [f.path, f.content]))
  const paths = signal<string[]>(o.files.map((f) => f.path).sort())
  const readonlyPaths = signal<string[]>([...readonlyText.keys()])
  const dirty = signal<ReadonlySet<string>>(new Set())
  const diagnostics = signal<CodeDiagnostic[]>([])
  /** The forms' code classes as of the last check; null until the first check answers. */
  const outline = signal<FormCodeOutline[] | null>(null)
  const checking = signal(false)

  let m: Monaco | undefined
  let loading: Promise<Monaco> | undefined
  const models = new Map<string, Model>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const isReadonly = (path: string) => readonlyText.has(path)
  const text = (path: string) => models.get(path)?.getValue() ?? saved.get(path) ?? readonlyText.get(path) ?? ""
  const contents = () => paths().map((p) => ({ path: p, content: text(p) }))
  const markDirty = (path: string, on: boolean) =>
    dirty.update((d) => {
      if (d.has(path) === on) return d
      const n = new Set(d)
      if (on) n.add(path)
      else n.delete(path)
      return n
    })

  const createModel = (path: string) => {
    let mdl = models.get(path)
    if (mdl || !m) return mdl
    mdl = m.editor.createModel(text(path), "csharp", m.Uri.parse(`${space}:///${path}`))
    const model = mdl
    model.onDidChangeContent(() => {
      if (isReadonly(path)) return
      // Back to the saved text (undo): not dirty any more.
      markDirty(path, model.getValue() !== saved.get(path))
      scheduleCheck()
    })
    models.set(path, model)
    if (o.complete && !isReadonly(path)) completers.set(model.uri.toString(), (line, column) => o.complete!(contents(), path, line, column))
    return model
  }

  /** Loads Monaco (once) and creates the models; the first check runs then. */
  const load = () =>
    (loading ??= import("./monaco").then(({ monaco }) => {
      m = monaco
      registerCompletion(m)
      for (const p of [...paths(), ...readonlyPaths()]) createModel(p)
      applyMarkers()
      return m
    }))

  const scheduleCheck = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void check(), 700)
  }
  const check = async () => {
    clearTimeout(timer)
    checking.set(true)
    try {
      const r = await o.check(contents())
      if (disposed) return
      diagnostics.set(r.diagnostics)
      outline.set(r.forms ?? [])
      applyMarkers()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      checking.set(false)
    }
  }
  const applyMarkers = () => {
    if (!m) return
    const severity = m.MarkerSeverity
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
            severity: d.severity === "error" ? severity.Error : severity.Warning,
          })),
      )
  }

  const save = async (path: string) => {
    if (isReadonly(path) || !dirty().has(path)) return
    const content = text(path)
    try {
      await o.save({ path, content })
      saved.set(path, content)
      markDirty(path, text(path) !== content)
    } catch (e) {
      toast.error(errorText(e))
      throw e
    }
  }
  const saveAll = async () => {
    for (const p of [...dirty()]) await save(p)
  }

  /** Adds a file on the server and here. */
  const create = async (path: string, content: string) => {
    if (paths().includes(path) || isReadonly(path)) throw new Error("Bu dosya zaten var.")
    await o.save({ path, content })
    saved.set(path, content)
    paths.update((ps) => [...ps, path].sort())
    createModel(path)
    scheduleCheck()
  }
  /** Inserts lines before a line of a file: an unsaved edit like any other (it can be undone in the editor). */
  const insertBefore = async (path: string, line: number, lines: string) => {
    const monaco = await load()
    const model = createModel(path)
    if (!model || isReadonly(path)) return false
    model.pushEditOperations([], [{ range: new monaco.Range(line, 1, line, 1), text: lines }], () => null)
    return true
  }
  const remove = async (path: string) => {
    await o.remove(path)
    const mdl = models.get(path)
    if (mdl) completers.delete(mdl.uri.toString())
    mdl?.dispose()
    models.delete(path)
    saved.delete(path)
    paths.update((ps) => ps.filter((p) => p !== path))
    markDirty(path, false)
    scheduleCheck()
  }
  /** Replaces a read-only file's text (the generated classes after the definition changed). */
  const setReadonly = (path: string, content: string) => {
    readonlyText.set(path, content)
    if (!readonlyPaths().includes(path)) readonlyPaths.update((ps) => [...ps, path])
    const mdl = models.get(path)
    if (mdl && mdl.getValue() !== content) mdl.setValue(content)
    else createModel(path)
  }

  const dispose = () => {
    disposed = true
    clearTimeout(timer)
    for (const mdl of models.values()) {
      completers.delete(mdl.uri.toString())
      mdl.dispose()
    }
    models.clear()
  }

  const errorCounts = computed(() => {
    const c = new Map<string, number>()
    for (const d of diagnostics()) if (d.severity === "error") c.set(d.path, (c.get(d.path) ?? 0) + 1)
    return c
  })

  return {
    paths,
    readonlyPaths,
    isReadonly,
    dirty,
    diagnostics,
    outline,
    insertBefore,
    errorCounts,
    checking,
    load,
    /** The model of a file (after load()). */
    model: (path: string) => createModel(path),
    text,
    save,
    saveAll,
    create,
    remove,
    setReadonly,
    check,
    dispose,
  }
}

export type CodeFiles = ReturnType<typeof codeFiles>
