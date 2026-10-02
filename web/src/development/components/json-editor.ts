import { define, effect, html, onCleanup, prop, signal, untrack } from "@bazlama/core"
import type { DraftStore } from "../draft"
import type { DraftPart } from "../schema"

type MonacoModule = typeof import("../monaco")
type Editor = import("monaco-editor/editor/editor.api").editor.IStandaloneCodeEditor
type Model = import("monaco-editor/editor/editor.api").editor.ITextModel

/*
 * <bazlama-json-editor .store=${draft} .part=${parts.entity("siparis")}> — the code view of a
 * designer: the part of the draft as JSON in Monaco, checked against a schema made from the
 * draft (completion, hover, errors). It and the designer edit the same draft:
 * - typing changes the draft once the text is valid JSON (a moment after typing stops);
 * - a change from the designer (or the draft) replaces the text, unless the text already says
 *   the same thing (so typing is not reformatted under the cursor).
 */

const OWNER = "bazlama-json"
const pretty = (v: unknown) => `${JSON.stringify(v ?? null, null, 2)}\n`
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Every open code view's schema, keyed by its model URI (Monaco takes them all at once). */
const schemas = new Map<string, Record<string, unknown>>()
let schemaTimer: ReturnType<typeof setTimeout> | undefined
function applySchemas(m: MonacoModule) {
  clearTimeout(schemaTimer)
  schemaTimer = setTimeout(() => {
    m.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      allowComments: false,
      enableSchemaRequest: false,
      schemaValidation: "error",
      schemas: [...schemas].map(([uri, schema]) => ({ uri: `${uri}#schema`, fileMatch: [uri], schema })),
    })
  }, 150)
}

export const JsonEditor = define("bazlama-json-editor", {
  props: {
    store: prop.object<DraftStore | null>(null),
    part: prop.object<DraftPart | null>(null),
  },
  setup(props) {
    const store = props.store.peek()
    const part = props.part.peek()
    if (!store || !part) return null
    const ready = signal(false)
    const problem = signal("")
    let editor: Editor | undefined
    let model: Model | undefined
    let disposed = false
    const cleanups: (() => void)[] = []

    const mount = async (el: HTMLElement) => {
      const m = await import("../monaco")
      if (disposed) return
      const monaco = m.monaco
      const uri = monaco.Uri.parse(`bazlama://${store.appKey}/${part.id}.json`).toString()
      model = monaco.editor.getModel(monaco.Uri.parse(uri)) ?? monaco.editor.createModel(pretty(untrack(() => part.get(store.def()!))), "json", monaco.Uri.parse(uri))
      const dark = /dark/.test(document.documentElement.dataset.theme ?? "")
      editor = monaco.editor.create(el, {
        model,
        automaticLayout: true,
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        tabSize: 2,
        theme: dark ? "vs-dark" : "vs",
        fixedOverflowWidgets: true,
        quickSuggestions: { strings: true, other: true, comments: false },
        unicodeHighlight: { ambiguousCharacters: false, nonBasicASCII: false },
      })
      ready.set(true)

      // The draft → the text (and the schema, which follows the draft).
      const stop = effect(() => {
        const def = store.def()
        if (!def) return
        const value = part.get(def)
        untrack(() => {
          schemas.set(uri, part.schema(def))
          applySchemas(m)
          let shown: unknown
          try {
            shown = JSON.parse(model!.getValue())
          } catch {
            shown = Symbol("invalid")
          }
          if (value === undefined || same(shown, value)) return
          model!.pushEditOperations([], [{ range: model!.getFullModelRange(), text: pretty(value) }], () => null)
        })
      })
      cleanups.push(stop)

      // The text → the draft, when it is valid JSON and says something new.
      let timer: ReturnType<typeof setTimeout> | undefined
      const sub = model.onDidChangeContent(() => {
        clearTimeout(timer)
        timer = setTimeout(() => void apply(), 300)
      })
      /** Schema errors of the current text, asked from the JSON worker (its markers may lag behind). */
      const schemaErrors = async () => {
        const worker = (await (await m.json.getWorker())(model!.uri)) as unknown as {
          doValidation(uri: string): Promise<{ severity?: number; message: string; range: { start: { line: number } } }[]>
        }
        return (await worker.doValidation(model!.uri.toString())).filter((d) => d.severity === 1)
      }
      const apply = async () => {
        if (!model || model.isDisposed()) return
        const version = model.getVersionId()
        let value: unknown
        try {
          value = JSON.parse(model.getValue())
        } catch {
          problem.set("")
          return // Monaco marks the syntax error
        }
        if (!store.def() || same(value, part.get(store.def()!))) return problem.set("")
        // Values the schema refuses stay in the editor until they are fixed.
        const invalid = await schemaErrors()
        if (model.isDisposed() || model.getVersionId() !== version) return // typed on meanwhile
        if (invalid.length)
          return problem.set(`Şemaya uymayan ${invalid.length} yer var (satır ${invalid[0].range.start.line + 1}: ${invalid[0].message}); düzeltilene kadar taslağa geçmez.`)
        const def = store.def()
        if (!def) return
        const locked = part.lockedKey?.(def)
        if (locked !== undefined && (value as { key?: unknown } | null)?.key !== locked) {
          problem.set(`Anahtar burada değiştirilemez ("${locked}" kalmalı); yeniden adlandırmak için Tasarım görünümünü kullanın.`)
          monaco.editor.setModelMarkers(model, OWNER, [{ severity: monaco.MarkerSeverity.Error, message: problem(), startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }])
          return
        }
        if (typeof value !== "object" || value === null) return problem.set("Değer bir JSON nesnesi (ya da dizisi) olmalı.")
        problem.set("")
        monaco.editor.setModelMarkers(model, OWNER, [])
        store.update((d) => part.set(d, value))
      }
      cleanups.push(() => {
        clearTimeout(timer)
        sub.dispose()
      })
    }

    onCleanup(() => {
      disposed = true
      for (const c of cleanups) c()
      editor?.dispose()
      // The next code view of this part starts from the draft again.
      if (model && !model.isDisposed()) {
        schemas.delete(model.uri.toString())
        model.dispose()
      }
    })

    return html`<div data-part="editor" ref=${(el: HTMLElement) => void mount(el)}></div>
      ${() => (ready() ? null : html`<span data-part="loading" class="muted">Editör yükleniyor…</span>`)}
      ${() => (problem() ? html`<div data-part="problem" role="status">${problem()}</div>` : null)}`
  },
})

declare global {
  interface HTMLElementTagNameMap {
    "bazlama-json-editor": HTMLElement
  }
}
