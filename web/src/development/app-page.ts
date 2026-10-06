import { computed, html, onCleanup, signal } from "@bazlama/core"
import { dialogs, icon, toast, type MenuItemData, type TreeItem } from "@bazlama/headless"
import { definePage } from "@bazlama/router"
import { api, ApiError, errorText } from "../api"
import { exportPackage } from "../management/apps"
import { confirmAction, formDialog, loader, loading, textField } from "../management/ui"
import { forgetRuntimeApps } from "../runtime/api"
import { className, codeFiles, codeTree, generatedClassAt, pascal, validPath, type CheckResult, type CodeDiagnostic, type CompletionEntry, type SourceFile } from "./code"
import "./components/app-settings"
import "./components/code-editor"
import { dualView } from "./components/dual-view"
import "./components/json-editor"
import "./components/entity-editor"
import "./components/form-designer"
import "./components/list-designer"
import "./components/menu-designer"
import type { Problem, WorkbenchElement, WorkbenchModel, WorkbenchTab } from "./components/workbench"
import "./components/workbench"
import { discardDraft, draftStore, publishDraft } from "./draft"
import { newEntity, newForm, newList, newModal, removeEntity, removeForm, removeList, removeModal } from "./meta"
import { parts, type DraftPart } from "./schema"

/*
 * An app in development: one workbench. The explorer shows the app, its entities (details
 * under their master), its lists, forms and modals, its code files, the libraries it uses and the generated entity
 * classes; each opens as a tab. The toolbar saves, builds and publishes.
 */

interface LibraryRow {
  key: string
  name: string
  versions: string[]
}
interface LibraryRef {
  key: string
  version: string
}
interface BuildInfo {
  number: number
  appVersion: string
  hash: string
  createdAt: string
}
interface Workspace {
  app: { key: string; name: string; version: string; namespace: string }
  files: SourceFile[]
  generated: SourceFile
  libraries: LibraryRef[]
  activeBuild: BuildInfo | null
  loaded: { buildNumber: number; events: Record<string, string[]>; actions: Record<string, string[]> } | null
}
interface BuildResult {
  success: boolean
  number: number | null
  hash: string | null
  diagnostics: CodeDiagnostic[]
  errors: string[]
}

/** A new event class for an entity: Validate, ready to fill in. */
const eventsTemplate = (namespace: string, entity: string) => `// Entity sınıfları: ${namespace} (Üretilen › _Entities.g.cs).

public class ${entity}Events : EntityEvents<${entity}>
{
    public override Task ValidateAsync(${entity} record, bool isNew, Errors errors, IAppContext context)
    {
        return Task.CompletedTask;
    }
}
`
/** The code class of a form: a method per item of its tools menu. */
const formCodeTemplate = (name: string, form: string, entity: string, tools: { label: string; method: string }[]) => `// "${name}" formunun kodu. Formun Araçlar menüsündeki her öğe buradaki bir metodu çağırır.
// record: formun ekrandaki hali (kaydedilmemiş olabilir; yeni kayıtta Id boştur). Değiştirdiğiniz
// alanlar forma geri yazılır; kaydetmek için ActionResult.Save dönün. Metot async Task<ActionResult>
// de olabilir; kullanıcıdan girdi almak için: var m = await context.Modals.ShowAsync<ModalSinifi>();

[Form("${form}")]
public class ${pascal(form)}Formu : FormCode<${entity}>
{
${(tools.length ? tools : [{ label: "Örnek araç", method: "OrnekArac" }])
  .map((t) => `    // ${t.label}\n    public ActionResult ${t.method}(${entity} record, IAppContext context)\n    {\n        return ActionResult.Ok();\n    }`)
  .join("\n\n")}
}
`
/** The code class of a modal: what it starts with, and the check when the user accepts it. */
const modalCodeTemplate = (name: string, modal: string) => `// "${name}" modalının kodu.

public class ${modal}Kodu : ModalCode<${modal}>
{
    // Modal gösterilmeden önce: varsayılan değerler.
    public override Task OpenAsync(${modal} values, IAppContext context)
    {
        return Task.CompletedTask;
    }

    // Kullanıcı onayladığında: errors'a eklenen hata modalı açık tutar.
    public override Task ValidateAsync(${modal} values, Errors errors, IAppContext context)
    {
        return Task.CompletedTask;
    }
}
`
const fileTemplate = (namespace: string, path: string) => {
  const name = className(path)
  return name.endsWith("Events") && name.length > 6 ? eventsTemplate(namespace, name.slice(0, -6)) : `// ${path}\n// Entity sınıfları: ${namespace}\n\npublic static class ${name}\n{\n}\n`
}

function showBuildFailure(r: BuildResult) {
  void dialogs.open({
    heading: "Derlenemedi",
    size: "lg",
    content: html`<div class="stack">
      ${r.errors.map((e) => html`<bz-alert variant="danger">${e}</bz-alert>`)}
      <ul class="changes">${r.diagnostics.filter((d) => d.severity === "error").map((d) => html`<li class="destructive">${d.path ? `${d.path}:${d.line} — ` : ""}${d.message}</li>`)}</ul>
    </div>`,
  })
}

export const appPage = definePage({
  title: "Geliştirme",
  setup(ctx) {
    const key = ctx.params().app
    const ws = loader(() => api.get<Workspace>(`/development/apps/${key}/workspace`))
    let refresh: () => Promise<void> = async () => {}
    const store = draftStore(key, { saved: () => refresh() })
    const ready = computed(() => (ws.data() && store.def() ? true : null))

    const body = () => {
      const w = ws.data()!
      const files = codeFiles({
        files: w.files,
        readonly: [w.generated],
        save: (f) => api.put(`/development/apps/${key}/files`, f),
        remove: (path) => api.delete(`/development/apps/${key}/files?path=${encodeURIComponent(path)}`),
        check: (fs) => api.post<CheckResult>(`/development/apps/${key}/check`, { files: fs }),
        complete: (fs, path, line, column) => api.post<CompletionEntry[]>(`/development/apps/${key}/complete`, { files: fs, path, line, column }),
      })
      onCleanup(files.dispose)
      void files.check()
      const libraries = signal(w.libraries)
      const build = signal({ active: w.activeBuild, loaded: w.loaded })
      const busy = signal<"" | "build" | "publish" | "preview">("")
      /** Rebuilds the workbench (after the draft was thrown away: the editors hold old values). */
      const generation = signal(0)
      let bench: WorkbenchElement | undefined

      // The generated classes follow the saved draft; the code is checked against it again.
      refresh = async () => {
        const next = await api.get<Workspace>(`/development/apps/${key}/workspace`)
        files.setReadonly(next.generated.path, next.generated.content)
        libraries.set(next.libraries)
        build.set({ active: next.activeBuild, loaded: next.loaded })
        await files.check()
      }

      const dirtyCount = () => files.dirty().size + (store.dirty() ? 1 : 0)
      ctx.onBeforeLeave(async () =>
        dirtyCount() === 0 ||
        dialogs.confirm({ heading: "Kaydedilmemiş değişiklikler", message: "Taslakta ya da kod dosyalarında kaydedilmemiş değişiklikler var. Çıkılsın mı?", confirmText: "Çık", cancelText: "Kal", variant: "danger" }),
      )
      const saveAll = async () => {
        await store.save()
        await files.saveAll()
      }

      // ── Actions ──────────────────────────────────────────────────────
      const open = (id: string, at?: { line: number; column?: number }) => bench?.open(id, at)
      /**
       * The class generated for an entity or a modal, in the read-only file of generated code:
       * what the app's code sees of it (its properties, the constants of its choices).
       */
      const openGenerated = async (kind: "Entity" | "Modal", k: string) => {
        const find = () => generatedClassAt(files.text(w.generated.path), kind, k)
        // The generated classes follow the saved draft: unsaved changes are saved first.
        if (store.dirty()) await store.save().catch(() => {})
        const at = find()
        open(`file:${w.generated.path}`, at ?? undefined)
        if (!at) toast.warning("Bu tanımın sınıfı henüz üretilmedi: taslağı kaydedin ve hatalarını düzeltin.")
      }
      const addEntity = async (parent?: string) => {
        const k = await newEntity(store, parent)
        if (k) open(`entity:${k}`)
      }
      const addList = async (entity?: string) => {
        const k = await newList(store, entity)
        if (k) open(`list:${k}`)
      }
      const addForm = async (entity?: string) => {
        const k = await newForm(store, entity)
        if (k) open(`form:${k}`)
      }
      const addModal = async () => {
        const k = await newModal(store)
        if (k) open(`modal:${k}`)
      }
      /** The file holding a class that matches, else a new file from the template. */
      const openClass = async (declared: RegExp, path: string, template: () => string) => {
        const found = files.paths().find((p) => declared.test(files.text(p)))
        if (found) return open(`file:${found}`)
        // The generated classes come from the saved draft: a new form's or modal's must exist first.
        if (store.dirty()) await store.save()
        await files.create(path, template())
        open(`file:${path}`)
      }
      /** What the code check (BZ0003, against the saved draft) says about a form's tools. */
      const toolProblems = (form: string) => files.diagnostics().filter((d) => d.code === "BZ0003" && d.message.includes(`'${form}' formunun`)).map((d) => d.message)
      /** A form's code class as of the last check: null when it has none, undefined while the first check runs. */
      const formCode = (form: string) => {
        const all = files.outline()
        return all === null ? undefined : (all.find((f) => f.form === form) ?? null)
      }
      /**
       * A tool's method in the form's code. A method that is not there yet is written first: with
       * the class when the form has no code, else as a new method at the end of its class.
       */
      const goToMethod = async (form: string, method: string) => {
        const f = store.def()!.forms?.find((x) => x.key === form)
        if (!f || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(method)) return
        // The code is checked against the saved draft; the check says where things are now.
        if (store.dirty()) await store.save()
        await files.check()
        let code = formCode(form)
        if (!code) {
          await openFormCode(form)
          await files.check()
          code = formCode(form)
          // The file was there but holds no class the form can use: its problems say why.
          if (!code) return void toast.warning("Formun kod sınıfı bulunamadı: Sorunlar paneline bakın.")
        }
        const at = () => code!.methods.find((m) => m.name === method)
        if (!at()) {
          const lines = files.text(code.path).split(/\r?\n/)
          const indent = /^\s*/.exec(lines[code.endLine - 1] ?? "")![0]
          const before = (lines[code.endLine - 2] ?? "").trim()
          const label = f.tools?.find((t) => t.method === method)?.label
          const stub = [
            ...(before && before !== "{" ? [""] : []),
            ...(label ? [`${indent}    // ${label}`] : []),
            `${indent}    public ActionResult ${method}(${code.record} record, IAppContext context)`,
            `${indent}    {`,
            `${indent}        return ActionResult.Ok();`,
            `${indent}    }`,
          ]
          if (!(await files.insertBefore(code.path, code.endLine, stub.map((l) => `${l}\n`).join("")))) return
          await files.check()
          code = formCode(form) ?? code
          toast.info(`${method} metodu ${code.class} sınıfına eklendi; dosyayı kaydedin.`)
        }
        const m = at()
        open(`file:${m?.path ?? code.path}`, m ? { line: m.line, column: m.column } : { line: code.line, column: code.column })
      }
      const openFormCode = async (form: string) => {
        const f = store.def()!.forms?.find((x) => x.key === form)
        if (!f) return
        await openClass(new RegExp(`\\[\\s*Form\\s*\\(\\s*"${form}"\\s*\\)`), `${pascal(form)}Formu.cs`, () => formCodeTemplate(f.name, form, pascal(f.entity), f.tools ?? []))
      }
      const openModalCode = async (modal: string) => {
        const m = store.def()!.modals?.find((x) => x.key === modal)
        if (!m) return
        await openClass(new RegExp(`ModalCode\\s*<\\s*${pascal(modal)}\\s*>`), `${pascal(modal)}Kodu.cs`, () => modalCodeTemplate(m.name, pascal(modal)))
      }
      /** The entity's first form, or a new one. */
      const openForm = (entity: string) => {
        const f = store.def()!.forms?.find((x) => x.entity === entity)
        if (f) open(`form:${f.key}`)
        else void addForm(entity)
      }
      const eventsPath = (entity: string) => `${pascal(entity)}Events.cs`
      const openCode = async (entity: string) => {
        const path = eventsPath(entity)
        if (!files.paths().includes(path)) {
          if (!store.installedEntity(entity) && store.dirty()) await store.save()
          await files.create(path, eventsTemplate(w.app.namespace, pascal(entity)))
        }
        open(`file:${path}`)
      }
      const newFile = async (folder = "") => {
        const path = signal(folder ? `${folder}/` : "")
        const ok = await formDialog({
          heading: "Yeni dosya",
          submitText: "Oluştur",
          body: () => html`${textField("Dosya yolu", path, { required: true, hint: "Örn. Siparis/SiparisEvents.cs (…Events.cs bir olay sınıfıyla başlar)" })}`,
          submit: async () => {
            const p = path().trim().replace(/\\/g, "/")
            if (!validPath(p)) throw new Error("Dosya yolu harf, rakam, _ ve - içerebilir ve .cs ile bitmeli.")
            await files.create(p, fileTemplate(w.app.namespace, p))
            path.set(p)
          },
        })
        if (ok) open(`file:${path()}`)
      }
      const removeFile = (path: string) =>
        confirmAction({ heading: "Dosyayı sil", message: `${path} silinsin mi?`, confirmText: "Sil", danger: true, action: () => files.remove(path) })
      const editLibraries = async () => {
        const all = await api.get<LibraryRow[]>("/development/libraries")
        const chosen = Object.fromEntries(all.map((l) => [l.key, signal(libraries().find((x) => x.key === l.key)?.version ?? "")]))
        const ok = await formDialog({
          heading: "Kullanılan kütüphaneler",
          body: () => html`${all.length === 0 ? html`<p class="muted">Kütüphane yok. Geliştirme › Kod kütüphaneleri'nden oluşturun.</p>` : null}
            ${all.map((l) => html`<bz-combobox label=${l.name} .value=${chosen[l.key]} @change=${(e: CustomEvent<{ value: string }>) => chosen[l.key].set(e.detail.value)}>
              <bz-option value="">Kullanılmıyor</bz-option>
              ${l.versions.map((v) => html`<bz-option value=${v}>${v}</bz-option>`)}
            </bz-combobox>`)}`,
          submit: () => api.put(`/development/apps/${key}/libraries`, all.filter((l) => chosen[l.key]()).map((l) => ({ key: l.key, version: chosen[l.key]() }))),
        })
        if (ok) {
          await refresh()
          toast.info("Kütüphaneler değişti; etkinleştirmek için derleyin.")
        }
      }
      const runBuild = async () => {
        busy.set("build")
        try {
          await saveAll()
          const r = await api.post<BuildResult>(`/development/apps/${key}/build`)
          toast.success(`Build #${r.number} etkin.`)
          forgetRuntimeApps()
          await refresh()
        } catch (e) {
          if (e instanceof ApiError && e.status === 400 && e.body) showBuildFailure(e.body as BuildResult)
          else toast.error(errorText(e))
        } finally {
          busy.set("")
        }
      }
      const publish = async () => {
        busy.set("publish")
        try {
          await saveAll()
          if (await publishDraft(store)) await refresh()
        } catch (e) {
          toast.error(errorText(e))
        } finally {
          busy.set("")
        }
      }
      /**
       * Saves the draft and the code, installs them as the app's preview and shows it in a new
       * tab. The tab is opened at once (a tab opened after an await is a blocked popup) and
       * pointed at the preview when it is ready.
       */
      const runPreview = async () => {
        const tab = window.open("", "_blank")
        tab?.document.write("<p style='font: 14px system-ui; padding: 1rem'>Önizleme hazırlanıyor…</p>")
        busy.set("preview")
        try {
          await saveAll()
          const r = await api.post<{ key: string; code: { success: boolean; diagnostics: CodeDiagnostic[] } | null }>(`/development/apps/${key}/preview`, { reset: false })
          if (r.code && !r.code.success) toast.warning("Kod derlenmedi: önizleme kodsuz çalışıyor. Hatalar Sorunlar panelinde.")
          const url = new URL(`preview.html#/preview/${r.key}`, location.href).href
          if (tab) tab.location.href = url
          else window.open(url, "_blank")
        } catch (e) {
          tab?.close()
          const errors = e instanceof ApiError ? e.errors : [errorText(e)]
          void dialogs.open({
            heading: "Önizleme kurulamadı",
            content: html`<div class="stack"><p class="muted">Taslağı düzeltip tekrar deneyin.</p><ul class="errors">${errors.map((x) => html`<li>${x}</li>`)}</ul></div>`,
          })
        } finally {
          busy.set("")
        }
      }
      const discard = async () => {
        if (!(await discardDraft(store))) return
        await refresh()
        generation.update((n) => n + 1)
      }

      // ── Explorer ─────────────────────────────────────────────────────
      const entityErrors = computed(() => {
        const c = new Map<string, number>()
        for (const e of store.errors()) {
          const k = /^Entity '([a-z][a-z0-9_]*)'/.exec(e)?.[1]
          if (k) c.set(k, (c.get(k) ?? 0) + 1)
        }
        return c
      })
      /** Error counts per form / list key, for the explorer's badges. */
      const errorsOf = (kind: string) =>
        computed(() => {
          const c = new Map<string, number>()
          for (const e of store.errors()) {
            const k = new RegExp(`^${kind} '([a-z][a-z0-9_]*)'`).exec(e)?.[1]
            if (k) c.set(k, (c.get(k) ?? 0) + 1)
          }
          return c
        })
      const formErrors = errorsOf("Form")
      const listErrors = errorsOf("Liste")
      const modalErrors = errorsOf("Modal")
      const menuErrors = computed(() => store.errors().filter((e) => e.startsWith("Menü")).length)
      const tree = computed<TreeItem[]>(() => {
        const d = store.def()!
        const entityItem = (e: (typeof d.entities)[number]): TreeItem => {
          const details = d.entities.filter((x) => x.parent === e.key)
          return {
            id: `entity:${e.key}`,
            label: e.name || e.key,
            icon: e.parent ? "list" : "database",
            badge: entityErrors().get(e.key) || undefined,
            children: details.length ? details.map(entityItem) : undefined,
          }
        }
        return [
          { id: "app", label: d.name || key, icon: "settings" },
          { id: "definition", label: "app.json", icon: "file-text" },
          { id: "entities", label: "Entity'ler", icon: "folder", children: d.entities.filter((e) => !e.parent).map(entityItem) },
          { id: "menu", label: "Menü", icon: "menu", badge: menuErrors() || undefined },
          {
            id: "lists",
            label: "Listeler",
            icon: "folder",
            children: (d.lists ?? []).map((l) => ({ id: `list:${l.key}`, label: l.name || l.key, icon: "table", badge: listErrors().get(l.key) || undefined })),
          },
          {
            id: "forms",
            label: "Formlar",
            icon: "folder",
            children: (d.forms ?? []).map((f) => ({ id: `form:${f.key}`, label: f.name || f.key, icon: "dashboard", badge: formErrors().get(f.key) || undefined })),
          },
          {
            id: "modals",
            label: "Modallar",
            icon: "folder",
            children: (d.modals ?? []).map((m) => ({ id: `modal:${m.key}`, label: m.name || m.key, icon: "message", badge: modalErrors().get(m.key) || undefined })),
          },
          { id: "code", label: "Kod", icon: "folder", children: codeTree(files.paths(), files.errorCounts()) },
          {
            id: "libraries",
            label: "Kütüphaneler",
            icon: "book",
            children: libraries().map((l) => ({ id: `lib:${l.key}`, label: `${l.key} ${l.version}`, icon: "book" })),
          },
          { id: "generated", label: "Üretilen", icon: "folder", children: codeTree(files.readonlyPaths(), new Map(), true) },
        ]
      })

      const json = (part: DraftPart) => html`<bazlama-json-editor .store=${store} .part=${part}></bazlama-json-editor>`
      const entityTab = (k: string): WorkbenchTab => {
        const e = () => store.def()?.entities.find((x) => x.key === k)
        return {
          title: () => e()?.name || k,
          icon: e()?.parent ? "list" : "database",
          detail: `Entity: ${k}`,
          dirty: () => store.partDirty((d) => d.entities.find((x) => x.key === k) ?? null),
          content: () =>
            dualView(
              `entity:${key}:${k}`,
              () => html`<bazlama-entity-editor .store=${store} entity=${k} .openCode=${() => openCode} .openForm=${() => openForm} .openClass=${() => (e: string) => void openGenerated("Entity", e)}></bazlama-entity-editor>`,
              () => json(parts.entity(k)),
            ),
        }
      }
      const listTab = (k: string): WorkbenchTab => ({
        title: () => store.def()?.lists?.find((x) => x.key === k)?.name || k,
        icon: "table",
        detail: `Liste: ${k}`,
        dirty: () => store.partDirty((d) => d.lists?.find((x) => x.key === k) ?? null),
        content: () =>
          dualView(
            `list:${key}:${k}`,
            () => html`<bazlama-list-designer .store=${store} list=${k} .openEntity=${() => (e: string) => open(`entity:${e}`)}></bazlama-list-designer>`,
            () => json(parts.list(k)),
          ),
      })
      const formTab = (k: string): WorkbenchTab => ({
        title: () => store.def()?.forms?.find((x) => x.key === k)?.name || k,
        icon: "dashboard",
        detail: `Form: ${k}`,
        dirty: () => store.partDirty((d) => d.forms?.find((x) => x.key === k) ?? null),
        content: () =>
          dualView(
            `form:${key}:${k}`,
            () => html`<bazlama-form-designer .store=${store} form=${k} .openEntity=${() => (e: string) => open(`entity:${e}`)} .openCode=${() => (f: string) => void openFormCode(f)} .toolProblems=${() => toolProblems} .formCode=${() => formCode} .goToMethod=${() => (f: string, m: string) => void goToMethod(f, m).catch((e) => toast.error(errorText(e)))}></bazlama-form-designer>`,
            () => json(parts.form(k)),
          ),
      })
      const modalTab = (k: string): WorkbenchTab => ({
        title: () => store.def()?.modals?.find((x) => x.key === k)?.name || k,
        icon: "message",
        detail: `Modal: ${k}`,
        dirty: () => store.partDirty((d) => d.modals?.find((x) => x.key === k) ?? null),
        content: () =>
          dualView(
            `modal:${key}:${k}`,
            () => html`<bazlama-form-designer .store=${store} modal=${k} .openCode=${() => (m: string) => void openModalCode(m)} .openClass=${() => (m: string) => void openGenerated("Modal", m)}></bazlama-form-designer>`,
            () => json(parts.modal(k)),
          ),
      })
      const fileTab = (path: string): WorkbenchTab => ({
        title: () => path.split("/").pop()!,
        icon: files.isReadonly(path) ? "lock" : "file-text",
        detail: path,
        dirty: () => files.dirty().has(path),
        content: () => html`<bazlama-code-editor .files=${files} path=${path}></bazlama-code-editor>`,
      })

      const model: WorkbenchModel = {
        label: "Gezgin",
        persist: `app:${key}`,
        tree,
        initial: ["app"],
        expanded: ["entities", "lists", "forms", "modals", "code"],
        tab(id) {
          if (id === "app")
            return {
              title: () => store.def()?.name || key,
              icon: "settings",
              detail: "Uygulama",
              dirty: () => store.partDirty((d) => ({ name: d.name, icon: d.icon, description: d.description, entities: d.entities.map((e) => e.key), forms: (d.forms ?? []).map((f) => f.key), lists: (d.lists ?? []).map((l) => l.key), modals: (d.modals ?? []).map((m) => m.key) })),
              content: () =>
                dualView(
                  `app:${key}`,
                  () => html`<bazlama-app-settings .store=${store} .openEntity=${() => (k: string) => open(`entity:${k}`)} .addEntity=${() => () => void addEntity()}></bazlama-app-settings>`,
                  () => json(parts.app()),
                ),
            }
          if (id.startsWith("entity:")) return entityTab(id.slice(7))
          if (id.startsWith("form:")) return formTab(id.slice(5))
          if (id.startsWith("list:")) return listTab(id.slice(5))
          if (id.startsWith("modal:")) return modalTab(id.slice(6))
          if (id === "menu")
            return {
              title: () => "Menü",
              icon: "menu",
              detail: "Uygulamanın Runtime menüsü",
              dirty: () => store.partDirty((d) => d.menu ?? []),
              content: () => dualView(`menu:${key}`, () => html`<bazlama-menu-designer .store=${store}></bazlama-menu-designer>`, () => json(parts.menu())),
            }
          if (id === "definition")
            return {
              title: () => "app.json",
              icon: "file-text",
              detail: "Uygulama tanımının tamamı (JSON)",
              dirty: () => store.dirty(),
              content: () => html`<div class="dual-view" data-mode="code"><div class="dual-code">${json(parts.definition())}</div></div>`,
            }
          if (id.startsWith("file:")) return fileTab(id.slice(5))
          return null
        },
        activate(id) {
          if (id === "libraries" || id.startsWith("lib:")) void editLibraries()
        },
        menu(id) {
          const items: MenuItemData[] = []
          if (id === null || id === "entities") items.push({ value: "new-entity", label: "Yeni entity", icon: "plus" })
          else if (id === "app") items.push({ value: "open", label: "Aç", icon: "external-link" }, { value: "new-entity", label: "Yeni entity", icon: "plus" })
          else if (id.startsWith("entity:")) {
            const e = store.def()!.entities.find((x) => x.key === id.slice(7))
            items.push({ value: "open", label: "Aç", icon: "external-link" })
            if (e && !e.parent) items.push({ value: "new-detail", label: "Detay entity ekle", icon: "plus" })
            items.push(
              { value: "new-list", label: "Yeni liste", icon: "table" },
              { value: "new-form", label: "Yeni form", icon: "dashboard" },
              { value: "code", label: files.paths().includes(eventsPath(id.slice(7))) ? "Olay kodunu aç" : "Olay kodu oluştur", icon: "code" },
              { value: "class", label: "Üretilen sınıf", icon: "lock" },
              { type: "separator" },
              { value: "remove-entity", label: "Kaldır", icon: "trash", variant: "danger" },
            )
          } else if (id === "forms") items.push({ value: "new-form", label: "Yeni form", icon: "plus" })
          else if (id === "lists") items.push({ value: "new-list", label: "Yeni liste", icon: "plus" })
          else if (id === "modals") items.push({ value: "new-modal", label: "Yeni modal", icon: "plus" })
          else if (id.startsWith("modal:")) {
            items.push(
              { value: "open", label: "Aç", icon: "external-link" },
              { value: "modal-code", label: "Modal kodu", icon: "code" },
              { value: "modal-class", label: "Üretilen sınıf", icon: "lock" },
              { type: "separator" },
              { value: "remove-modal", label: "Kaldır", icon: "trash", variant: "danger" },
            )
          }
          else if (id === "menu" || id === "definition") items.push({ value: "open", label: "Aç", icon: "external-link" })
          else if (id.startsWith("list:")) {
            items.push(
              { value: "open", label: "Aç", icon: "external-link" },
              { value: "list-entity", label: "Entity'yi aç", icon: "database" },
              { type: "separator" },
              { value: "remove-list", label: "Kaldır", icon: "trash", variant: "danger" },
            )
          }
          else if (id.startsWith("form:")) {
            items.push(
              { value: "open", label: "Aç", icon: "external-link" },
              { value: "form-entity", label: "Entity'yi aç", icon: "database" },
              { value: "form-code", label: "Form kodu", icon: "code" },
              { type: "separator" },
              { value: "remove-form", label: "Kaldır", icon: "trash", variant: "danger" },
            )
          } else if (id === "code" || id.startsWith("folder:")) {
            if (!id.startsWith("folder:") || !files.readonlyPaths().some((p) => p.startsWith(`${id.slice(7)}/`))) items.push({ value: "new-file", label: "Yeni dosya", icon: "plus" })
          } else if (id.startsWith("file:")) {
            items.push({ value: "open", label: "Aç", icon: "external-link" })
            if (!files.isReadonly(id.slice(5))) items.push({ type: "separator" }, { value: "remove-file", label: "Sil", icon: "trash", variant: "danger" })
          } else if (id === "libraries" || id.startsWith("lib:")) items.push({ value: "libraries", label: "Kütüphaneleri düzenle", icon: "book" })
          return items.length ? items : null
        },
        command(value, id) {
          const rest = id?.slice(id.indexOf(":") + 1) ?? ""
          if (value === "open" && id) open(id)
          else if (value === "new-entity") void addEntity()
          else if (value === "new-detail") void addEntity(rest)
          else if (value === "code") void openCode(rest)
          else if (value === "class") void openGenerated("Entity", rest)
          else if (value === "modal-class") void openGenerated("Modal", rest)
          else if (value === "new-form") void addForm(id?.startsWith("entity:") ? rest : undefined)
          else if (value === "remove-form") void removeForm(store, rest)
          else if (value === "form-code") void openFormCode(rest)
          else if (value === "new-modal") void addModal()
          else if (value === "remove-modal") void removeModal(store, rest)
          else if (value === "modal-code") void openModalCode(rest)
          else if (value === "new-list") void addList(id?.startsWith("entity:") ? rest : undefined)
          else if (value === "remove-list") void removeList(store, rest)
          else if (value === "list-entity") {
            const l = store.def()!.lists?.find((x) => x.key === rest)
            if (l) open(`entity:${l.entity}`)
          }
          else if (value === "form-entity") {
            const f = store.def()!.forms?.find((x) => x.key === rest)
            if (f) open(`entity:${f.entity}`)
          }
          else if (value === "remove-entity") void removeEntity(store, rest)
          else if (value === "new-file") void newFile(id?.startsWith("folder:") ? rest : "")
          else if (value === "remove-file") void removeFile(rest)
          else if (value === "libraries") void editLibraries()
        },
        actions: () => html`
          <bz-button size="sm" variant="ghost" aria-label="Yeni entity" data-tooltip="Yeni entity" @click=${() => void addEntity()}>${icon("database")}</bz-button>
          <bz-button size="sm" variant="ghost" aria-label="Yeni liste" data-tooltip="Yeni liste" @click=${() => void addList()}>${icon("table")}</bz-button>
          <bz-button size="sm" variant="ghost" aria-label="Yeni form" data-tooltip="Yeni form" @click=${() => void addForm()}>${icon("dashboard")}</bz-button>
          <bz-button size="sm" variant="ghost" aria-label="Yeni modal" data-tooltip="Yeni modal" @click=${() => void addModal()}>${icon("message")}</bz-button>
          <bz-button size="sm" variant="ghost" aria-label="Yeni dosya" data-tooltip="Yeni kod dosyası" @click=${() => void newFile()}>${icon("plus")}</bz-button>`,
        problems: () => {
          const def = store.def()!
          const list: Problem[] = store.errors().map((message) => {
            const fk = /^Form '([a-z][a-z0-9_]*)'/.exec(message)?.[1]
            const f = fk ? def.forms?.find((x) => x.key === fk) : undefined
            if (f) return { severity: "error", tab: `form:${f.key}`, where: f.name || f.key, message }
            const lk = /^Liste '([a-z][a-z0-9_]*)'/.exec(message)?.[1]
            const l = lk ? def.lists?.find((x) => x.key === lk) : undefined
            if (l) return { severity: "error", tab: `list:${l.key}`, where: l.name || l.key, message }
            const mk = /^Modal '([a-z][a-z0-9_]*)'/.exec(message)?.[1]
            const m = mk ? def.modals?.find((x) => x.key === mk) : undefined
            if (m) return { severity: "error", tab: `modal:${m.key}`, where: m.name || m.key, message }
            if (message.startsWith("Menü")) return { severity: "error", tab: "menu", where: "Menü", message }
            const k = /^Entity '([a-z][a-z0-9_]*)'/.exec(message)?.[1]
            const e = k ? def.entities.find((x) => x.key === k) : undefined
            return { severity: "error", tab: e ? `entity:${e.key}` : "app", where: e ? e.name || e.key : "Tanım", message }
          })
          for (const d of files.diagnostics()) {
            // No file: the definition asks for code that is not there (a form's tools without their class).
            if (!d.path) {
              const form = /^'([a-z][a-z0-9_]*)' formunun/.exec(d.message)?.[1]
              list.push({ severity: d.severity, tab: form ? `form:${form}` : "app", where: "Kod", message: d.message, code: d.code })
            } else list.push({ severity: d.severity, tab: `file:${d.path}`, where: `${d.path}:${d.line}`, message: d.message, code: d.code, line: d.line, column: d.column })
          }
          return list
        },
        checking: files.checking,
        save: async (id) => {
          try {
            if (id.startsWith("file:")) await files.save(id.slice(5))
            else await store.save()
          } catch {
            /* reported */
          }
        },
      }

      const info = store.info
      const buildBadge = () => {
        const b = build()
        if (!b.active) return null
        return html`<bz-badge variant=${b.loaded ? "success" : "warning"} data-tooltip=${b.loaded ? `v${b.active.appVersion} için derlendi` : "Yüklü değil: yeniden derleyin"}>Build #${b.active.number}</bz-badge>`
      }
      return html`
        <div class="page-head">
          <bz-button variant="ghost" size="sm" aria-label="Geliştirmeye dön" @click=${() => void ctx.navigate("/development")}>${icon("arrow-left")}</bz-button>
          <h1>${() => store.def()?.name ?? key}</h1>
          <span class="muted small">${() => (info()?.installedVersion ? `yayında: v${info()!.installedVersion}` : "yayınlanmadı")}</span>
          ${() => (info()?.isDraft || store.dirty() ? html`<bz-badge variant="warning">Taslak</bz-badge>` : null)}
          ${buildBadge}
          <span class="spacer"></span>
          <bz-button ?disabled=${() => dirtyCount() === 0} ?loading=${store.busy} @click=${() => void saveAll().catch(() => {})} data-tooltip="Taslağı ve değişen dosyaları kaydeder (sekmede Ctrl+S)">
            ${icon("download")} Kaydet${() => (dirtyCount() ? ` (${dirtyCount()})` : "")}</bz-button>
          <bz-button ?loading=${() => busy() === "preview"} @click=${runPreview} data-tooltip="Taslağı ve kodu kaydeder, önizleme tablolarına kurar ve yeni sekmede açar">${icon("external-link")} Önizle</bz-button>
          <bz-button ?loading=${() => busy() === "build"} @click=${runBuild} data-tooltip="Kodu kurulu tanımla derler ve etkinleştirir">${icon("check")} Derle</bz-button>
          <bz-button variant="primary" ?loading=${() => busy() === "publish"} @click=${publish}>${icon("upload")} Yayınla</bz-button>
          <bz-menu @select=${(e: CustomEvent<{ value: string }>) => (e.detail.value === "discard" ? void discard() : e.detail.value === "libraries" ? void editLibraries() : null)}>
            <bz-button slot="trigger" variant="ghost" aria-label="Diğer">${icon("more-horizontal")}</bz-button>
            <bz-menu-item value="libraries" icon="book">Kütüphaneler…</bz-menu-item>
            ${() => (info()?.isDraft && info()?.installedVersion ? html`<bz-menu-item value="discard" icon="trash" variant="danger">Taslağı at</bz-menu-item>` : null)}
          </bz-menu>
          ${() => (info()?.installedVersion ? html`<bz-button @click=${() => exportPackage(key, info()!.installedVersion!)} data-tooltip="Yayındaki versiyonu .bzapp paketi olarak indirir">${icon("download")} .bzapp</bz-button>` : null)}
        </div>
        ${() => (generation(), html`<bazlama-workbench data-shell-fill .model=${model} ref=${(el: WorkbenchElement) => (bench = el)}></bazlama-workbench>`)}`
    }
    return html`<div class="page code-page">${loading({ data: ready, error: () => ws.error() || store.data.error() }, body)}</div>`
  },
})
