/*
 * Monaco, only what the Development area needs: the editor core, its standard features (find,
 * folding, multi-cursor…), the C# grammar and the JSON language service (the definitions'
 * code view: schema validation and completion). Loaded lazily (dynamic import) the first time
 * an editor opens, so Runtime and Management never download it.
 */
import * as monaco from "monaco-editor/editor/editor.api"
import "monaco-editor/features/register.all"
import "monaco-editor/languages/definitions/csharp/register"
import * as json from "monaco-editor/languages/features/json/register"
import EditorWorker from "monaco-editor/editor/editor.worker?worker"
import JsonWorker from "monaco-editor/languages/features/json/json.worker?worker"

;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: (_: string, label: string) => (label === "json" ? new JsonWorker() : new EditorWorker()),
}

export { json, monaco }
