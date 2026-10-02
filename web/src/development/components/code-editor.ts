import { define, html, onCleanup, prop, signal } from "@bazlama/core"
import type { CodeFiles } from "../code"

type Editor = import("monaco-editor/editor/editor.api").editor.IStandaloneCodeEditor

export interface CodeEditorElement extends HTMLElement {
  files: CodeFiles | null
  path: string
  /** Moves the cursor to a position (1-based) and focuses the editor. */
  reveal(line: number, column?: number): Promise<void>
}

/**
 * <bazlama-code-editor .files=${files} path="Siparis/SiparisEvents.cs"> — one Monaco editor
 * on a file's model. The model (text, undo, markers) belongs to `files` and outlives the
 * editor: closing a tab keeps unsaved changes. Monaco is loaded on first use.
 */
export const CodeEditor = define("bazlama-code-editor", {
  props: {
    files: prop.object<CodeFiles | null>(null),
    path: prop.string(),
  },
  setup(props, { host }) {
    const ready = signal(false)
    let editor: Editor | undefined
    let disposed = false
    let mounted: Promise<void> | undefined

    const mount = (el: HTMLElement) =>
      (mounted = (async () => {
        const files = props.files.peek()
        if (!files) return
        const m = await files.load()
        if (disposed) return
        const path = props.path.peek()
        const dark = /dark/.test(document.documentElement.dataset.theme ?? "")
        editor = m.editor.create(el, {
          model: files.model(path) ?? null,
          readOnly: files.isReadonly(path),
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
        ready.set(true)
      })())

    ;(host as unknown as CodeEditorElement).reveal = async (line: number, column = 1) => {
      await mounted
      if (!editor) return
      editor.revealLineInCenter(line)
      editor.setPosition({ lineNumber: line, column })
      editor.focus()
    }

    onCleanup(() => {
      disposed = true
      editor?.dispose()
    })

    return html`<div data-part="editor" ref=${(el: HTMLElement) => void mount(el)}></div>
      ${() => (ready() ? null : html`<span data-part="loading" class="muted">Editör yükleniyor…</span>`)}`
  },
})
