/*
 * Monaco, only what the Development area needs: the editor core, its standard features (find,
 * folding, multi-cursor…) and the C# grammar. Loaded lazily (dynamic import) the first time an
 * editor opens, so Runtime and Management never download it.
 */
import * as monaco from "monaco-editor/editor/editor.api"
import "monaco-editor/features/register.all"
import "monaco-editor/languages/definitions/csharp/register"
import EditorWorker from "monaco-editor/editor/editor.worker?worker"

;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() }

export { monaco }
