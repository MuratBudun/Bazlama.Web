import { html, onCleanup, signal } from "@bazlama/core"
import { dialogs, icon, toast, type GridColumn } from "@bazlama/headless"
import { definePage } from "@bazlama/router"
import { api } from "../api"
import { checkField, confirmAction, dataGrid, dateTime, formDialog, loader, loading, textField } from "../management/ui"
import { className, codeFiles, codeTree, validPath, type CheckResult, type CompletionEntry, type SourceFile } from "./code"
import "./components/code-editor"
import type { WorkbenchElement, WorkbenchModel } from "./components/workbench"
import "./components/workbench"

interface DevApp {
  key: string
  name: string
  version: string | null
  fileCount: number
  activeBuild: { number: number; appVersion: string; hash: string; createdAt: string } | null
  loaded: boolean
  stale: boolean
  installed: boolean
  hasDraft: boolean
}
interface LibraryRow {
  key: string
  name: string
  description: string | null
  versions: string[]
}
const status = (a: DevApp) =>
  a.stale
    ? html`<bz-badge variant="warning">Yeniden derlenmeli</bz-badge>`
    : a.activeBuild
      ? html`<bz-badge variant="success">Build #${a.activeBuild.number}</bz-badge>`
      : a.fileCount
        ? html`<bz-badge variant="neutral">Derlenmedi</bz-badge>`
        : html`<span class="muted small">Kod yok</span>`

export const devHome = definePage({
  title: "Geliştirme",
  setup(ctx) {
    const apps = loader(() => api.get<DevApp[]>("/development/apps"))
    const libs = loader(() => api.get<LibraryRow[]>("/development/libraries"))
    const newLibrary = async () => {
      const f = { key: signal(""), name: signal(""), description: signal("") }
      const ok = await formDialog({
        heading: "Yeni kod kütüphanesi",
        submitText: "Oluştur",
        body: () => html`<bz-form-layout columns="2" min-column-width="12rem">
          ${textField("Anahtar", f.key, { required: true, hint: "küçük harf, rakam, _ (örn. ortak)" })} ${textField("Ad", f.name, { required: true })}
          ${textField("Açıklama", f.description, { span: true })}
        </bz-form-layout>`,
        submit: () => api.post("/development/libraries", { key: f.key(), name: f.name(), description: f.description() || null }),
      })
      if (ok) void ctx.navigate(`/development/libraries/${f.key()}`)
    }
    const newApp = async () => {
      const f = { key: signal(""), name: signal(""), description: signal("") }
      const ok = await formDialog({
        heading: "Yeni uygulama",
        submitText: "Oluştur",
        body: () => html`<bz-form-layout columns="2" min-column-width="12rem">
          ${textField("Anahtar", f.key, { required: true, hint: "küçük harf, rakam, _ (en fazla 20; tablo adlarında kullanılır)" })} ${textField("Ad", f.name, { required: true })}
          ${textField("Açıklama", f.description, { span: true })}
        </bz-form-layout>`,
        submit: () => api.post("/development/apps", { key: f.key(), name: f.name(), description: f.description() || null }),
      })
      if (ok) void ctx.navigate(`/development/apps/${f.key()}`)
    }
    const appColumns: GridColumn<DevApp>[] = [
      { key: "name", header: "Uygulama", width: 240, flex: true, format: (v, a) => html`<strong>${v as string}</strong> <span class="muted small">${a.key}${a.version ? ` · v${a.version}` : ""}</span>` },
      { key: "hasDraft", header: "Tanım", width: 150, format: (_, a) => (!a.installed ? html`<bz-badge variant="neutral">Yayınlanmadı</bz-badge>` : a.hasDraft ? html`<bz-badge variant="warning">Taslak var</bz-badge>` : html`<span class="muted small">Yayında</span>`) },
      { key: "fileCount", header: "Dosya", width: 90, align: "end" },
      { key: "status", header: "Kod", width: 180, format: (_, a) => status(a) },
      { key: "built", header: "Son derleme", width: 160, format: (_, a) => (a.activeBuild ? dateTime(a.activeBuild.createdAt) : "") },
    ]
    const libColumns: GridColumn<LibraryRow>[] = [
      { key: "name", header: "Kütüphane", width: 240, flex: true, format: (v, l) => html`<strong>${v as string}</strong> <span class="muted small">${l.key}</span>` },
      { key: "versions", header: "Versiyonlar", width: 240, format: (v) => ((v as string[]).length ? (v as string[]).join(", ") : html`<span class="muted small">yayınlanmadı</span>`) },
      { key: "description", header: "Açıklama", width: 260 },
    ]
    return html`<div class="page">
      <div class="page-head">${icon("code", { size: 22 })}<h1>Geliştirme</h1></div>
      <p class="muted">Uygulamaların tasarımı (entity, alan, liste ve form) ve sunucu tarafı C# kodu (olaylar ve form eylemleri). Taslak yayınlanınca değiştirilemez bir versiyon olur; ortak kod versiyonlu kod kütüphanelerinde durur.</p>
      <div class="row"><h2>Uygulamalar</h2><span class="spacer"></span>
        <bz-button @click=${newApp}>${icon("plus")} Yeni uygulama</bz-button></div>
      ${loading(apps, () => dataGrid({ label: "Uygulamalar", persist: "dev-apps", columns: appColumns, rows: () => apps.data() ?? [], rowKey: "key",
        onOpen: (a) => void ctx.navigate(`/development/apps/${a.key}`), empty: "Uygulama yok: Yeni uygulama ile başlayın." }))}
      <div class="row"><h2>Kod kütüphaneleri</h2><span class="spacer"></span>
        <bz-button @click=${newLibrary}>${icon("plus")} Yeni kütüphane</bz-button></div>
      ${loading(libs, () => dataGrid({ label: "Kod kütüphaneleri", persist: "dev-libs", columns: libColumns, rows: () => libs.data() ?? [], rowKey: "key",
        onOpen: (l) => void ctx.navigate(`/development/libraries/${l.key}`), empty: "Kütüphane yok." }))}
    </div>`
  },
})

export const libraryPage = definePage({
  title: "Kod kütüphanesi",
  setup(ctx) {
    const key = ctx.params().key
    const lib = loader(() => api.get<{ key: string; name: string; description: string | null; files: SourceFile[]; versions: { version: string; hash: string; createdAt: string }[] }>(`/development/libraries/${key}`))
    return html`<div class="page code-page">${loading(lib, () => {
      const l = lib.data()!
      const versions = signal(l.versions)
      const files = codeFiles({
        files: l.files,
        save: (f) => api.put(`/development/libraries/${key}/files`, f),
        remove: (path) => api.delete(`/development/libraries/${key}/files?path=${encodeURIComponent(path)}`),
        check: (fs) => api.post<CheckResult>(`/development/libraries/${key}/check`, { files: fs }),
        complete: (fs, path, line, column) => api.post<CompletionEntry[]>(`/development/libraries/${key}/complete`, { files: fs, path, line, column }),
      })
      onCleanup(files.dispose)
      void files.check()
      let bench: WorkbenchElement | undefined
      ctx.onBeforeLeave(async () =>
        files.dirty().size === 0 ||
        dialogs.confirm({ heading: "Kaydedilmemiş dosyalar", message: `${files.dirty().size} dosyada kaydedilmemiş değişiklik var. Çıkılsın mı?`, confirmText: "Çık", cancelText: "Kal", variant: "danger" }),
      )

      const newFile = async (folder = "") => {
        const path = signal(folder ? `${folder}/` : "")
        const ok = await formDialog({
          heading: "Yeni dosya",
          submitText: "Oluştur",
          body: () => html`${textField("Dosya yolu", path, { required: true, hint: "Örn. Ortak/Metin.cs" })}`,
          submit: async () => {
            const p = path().trim().replace(/\\/g, "/")
            if (!validPath(p)) throw new Error("Dosya yolu harf, rakam, _ ve - içerebilir ve .cs ile bitmeli.")
            await files.create(p, `// ${p}\nnamespace Ortak;\n\npublic static class ${className(p)}\n{\n}\n`)
            path.set(p)
          },
        })
        if (ok) bench?.open(`file:${path()}`)
      }
      const removeFile = (path: string) =>
        confirmAction({ heading: "Dosyayı sil", message: `${path} silinsin mi?`, confirmText: "Sil", danger: true, action: () => files.remove(path) })

      const model: WorkbenchModel = {
        label: "Gezgin",
        persist: `library:${key}`,
        tree: () => [{ id: "code", label: l.name, icon: "book", children: codeTree(files.paths(), files.errorCounts()) }],
        initial: files.paths().slice(0, 1).map((p) => `file:${p}`),
        expanded: ["code"],
        tab(id) {
          if (!id.startsWith("file:")) return null
          const path = id.slice(5)
          return {
            title: () => path.split("/").pop()!,
            icon: "file-text",
            detail: path,
            dirty: () => files.dirty().has(path),
            content: () => html`<bazlama-code-editor .files=${files} path=${path}></bazlama-code-editor>`,
          }
        },
        menu(id) {
          if (id?.startsWith("file:")) return [{ value: "open", label: "Aç", icon: "external-link" }, { type: "separator" }, { value: "remove", label: "Sil", icon: "trash", variant: "danger" }]
          return [{ value: "new", label: "Yeni dosya", icon: "plus" }]
        },
        command(value, id) {
          if (value === "open" && id) bench?.open(id)
          else if (value === "remove" && id) void removeFile(id.slice(5))
          else if (value === "new") void newFile(id?.startsWith("folder:") ? id.slice(7) : "")
        },
        actions: () => html`<bz-button size="sm" variant="ghost" aria-label="Yeni dosya" data-tooltip="Yeni dosya" @click=${() => void newFile()}>${icon("plus")}</bz-button>`,
        problems: () =>
          files.diagnostics().map((d) => ({ severity: d.severity, tab: `file:${d.path}`, where: `${d.path}:${d.line}`, message: d.message, code: d.code, line: d.line, column: d.column })),
        checking: files.checking,
        save: (id) => (id.startsWith("file:") ? files.save(id.slice(5)).catch(() => {}) : undefined),
      }

      const next = () => {
        const last = versions()[0]?.version
        if (!last) return "1.0.0"
        const [a, b, c] = last.split(".").map(Number)
        return `${a}.${b}.${c + 1}`
      }
      const publish = async () => {
        await files.saveAll()
        const version = signal(next())
        const understood = signal(false)
        const ok = await formDialog({
          heading: "Versiyon yayınla",
          submitText: "Yayınla",
          body: () => html`<p class="muted">Kaydedilmiş dosyalar derlenip değiştirilemez bir versiyon olur. Uygulamalar bu versiyonu seçip kullanır.</p>
            ${textField("Versiyon", version, { required: true })} ${checkField("Bu versiyon sonradan değiştirilemez", understood)}`,
          submit: async () => {
            if (!understood()) throw new Error("Onay kutusunu işaretleyin.")
            await api.post(`/development/libraries/${key}/publish`, { version: version() })
          },
        })
        if (ok) {
          toast.success(`${l.name} ${version()} yayınlandı.`)
          versions.set((await api.get<typeof l>(`/development/libraries/${key}`)).versions)
        }
      }
      return html`
        <div class="page-head">
          <bz-button variant="ghost" size="sm" aria-label="Geliştirmeye dön" @click=${() => void ctx.navigate("/development")}>${icon("arrow-left")}</bz-button>
          <h1>${l.name}</h1><span class="muted small">${() => `${l.key}${versions().length ? ` · ${versions().map((v) => v.version).join(", ")}` : " · yayınlanmadı"}`}</span>
          <span class="spacer"></span>
          <bz-button ?disabled=${() => files.dirty().size === 0} @click=${() => void files.saveAll().then(() => toast.success("Kaydedildi."), () => {})}>${icon("download")} Kaydet</bz-button>
          <bz-button variant="primary" @click=${publish}>${icon("upload")} Versiyon yayınla</bz-button>
        </div>
        ${l.description ? html`<p class="muted small">${l.description}</p>` : null}
        <bazlama-workbench data-shell-fill .model=${model} ref=${(el: WorkbenchElement) => (bench = el)}></bazlama-workbench>`
    })}</div>`
  },
})
