import { html, signal } from "@bazlama/core"
import { dialogs, icon, toast, type GridColumn } from "@bazlama/headless"
import { definePage } from "@bazlama/router"
import { appNav } from "./designer"
import { api, ApiError, errorText } from "../api"
import { checkField, dataGrid, dateTime, formDialog, loader, loading, textField } from "../management/ui"
import { forgetRuntimeApps } from "../runtime/api"
import { codeWorkspace, unsavedGuard, type CheckResult, type CodeDiagnostic, type CompletionEntry, type SourceFile } from "./workspace"

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
interface LibraryRef {
  key: string
  version: string
}
interface Workspace {
  app: { key: string; name: string; version: string; namespace: string }
  files: SourceFile[]
  generated: SourceFile
  libraries: LibraryRef[]
  activeBuild: DevApp["activeBuild"]
  loaded: { buildNumber: number; events: Record<string, string[]>; actions: Record<string, string[]> } | null
}
interface BuildResult {
  success: boolean
  number: number | null
  hash: string | null
  diagnostics: CodeDiagnostic[]
  errors: string[]
}

const className = (path: string) => (path.split("/").pop() ?? "Kod").replace(/\.cs$/, "").replace(/[^A-Za-z0-9_]/g, "") || "Kod"

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

/** Shows a failed build's diagnostics in a dialog. */
function showBuildFailure(r: BuildResult) {
  void dialogs.open({
    heading: "Derlenemedi",
    size: "lg",
    content: html`<div class="stack">
      ${r.errors.map((e) => html`<bz-alert variant="danger">${e}</bz-alert>`)}
      <ul class="changes">${r.diagnostics.filter((d) => d.severity === "error").map((d) => html`<li class="destructive">${d.path}:${d.line} — ${d.message}</li>`)}</ul>
    </div>`,
  })
}

export const appCodePage = definePage({
  title: "Kod",
  setup(ctx) {
    const key = ctx.params().app
    const ws = loader(() => api.get<Workspace>(`/development/apps/${key}/workspace`))
    return html`<div class="page code-page">${loading(ws, () => {
      const w = ws.data()!
      const busy = signal(false)
      const workspace = codeWorkspace({
        files: w.files,
        readonly: [w.generated],
        save: (f) => api.put(`/development/apps/${key}/files`, f),
        remove: (path) => api.delete(`/development/apps/${key}/files?path=${encodeURIComponent(path)}`),
        check: (files) => api.post<CheckResult>(`/development/apps/${key}/check`, { files }),
        complete: (files, path, line, column) => api.post<CompletionEntry[]>(`/development/apps/${key}/complete`, { files, path, line, column }),
        template: (path) => `// ${path}\n// Entity sınıfları: ${w.app.namespace} (üretilen dosyaya bakın).\n\npublic class ${className(path)} : EntityEvents<${className(path).replace(/Events$/, "")}>\n{\n    public override Task ValidateAsync(${className(path).replace(/Events$/, "")} record, bool isNew, Errors errors, IAppContext context)\n    {\n        return Task.CompletedTask;\n    }\n}\n`,
      })
      ctx.onBeforeLeave(unsavedGuard(workspace.dirtyCount))

      const build = async () => {
        busy.set(true)
        try {
          await workspace.saveAll()
          const r = await api.post<BuildResult>(`/development/apps/${key}/build`)
          toast.success(`Build #${r.number} etkin.`)
          forgetRuntimeApps()
          await ws.reload()
        } catch (e) {
          if (e instanceof ApiError && e.status === 400 && e.body) showBuildFailure(e.body as BuildResult)
          else toast.error(errorText(e))
        } finally {
          busy.set(false)
        }
      }
      const libraries = async () => {
        const all = await api.get<LibraryRow[]>("/development/libraries")
        const chosen = Object.fromEntries(all.map((l) => [l.key, signal(w.libraries.find((x) => x.key === l.key)?.version ?? "")]))
        const ok = await formDialog({
          heading: "Kullanılan kütüphaneler",
          body: () => html`${all.length === 0 ? html`<p class="muted">Kütüphane yok.</p>` : null}
            ${all.map((l) => html`<bz-combobox label=${l.name} .value=${chosen[l.key]} @change=${(e: CustomEvent<{ value: string }>) => chosen[l.key].set(e.detail.value)}>
              <bz-option value="">Kullanılmıyor</bz-option>
              ${l.versions.map((v) => html`<bz-option value=${v}>${v}</bz-option>`)}
            </bz-combobox>`)}`,
          submit: () => api.put(`/development/apps/${key}/libraries`, all.filter((l) => chosen[l.key]()).map((l) => ({ key: l.key, version: chosen[l.key]() }))),
        })
        if (ok) {
          await ws.reload()
          toast.info("Kütüphaneler değişti; etkinleştirmek için derleyin.")
        }
      }
      const loadedText = () => {
        if (!w.loaded) return "Çalışan kod yok."
        const events = Object.entries(w.loaded.events).map(([e, t]) => `${e}: ${t.join(", ")}`)
        const actions = Object.entries(w.loaded.actions).map(([e, a]) => `${e}: ${a.join(", ")}`)
        return [events.length ? `Olaylar — ${events.join(" · ")}` : "", actions.length ? `Eylemler — ${actions.join(" · ")}` : ""].filter(Boolean).join("   ") || "Kod yüklü; olay veya eylem yok."
      }
      return html`
        <div class="page-head">
          <bz-button variant="ghost" size="sm" aria-label="Geliştirmeye dön" @click=${() => void ctx.navigate("/development")}>${icon("arrow-left")}</bz-button>
          <h1>${w.app.name}</h1><span class="muted small">v${w.app.version} · ${w.app.namespace}</span>
          ${appNav(ctx, key, "code")}
          ${w.activeBuild ? html`<bz-badge variant=${w.loaded ? "success" : "warning"}>Build #${w.activeBuild.number}${w.loaded ? "" : " (yüklü değil)"}</bz-badge>` : null}
          <span class="spacer"></span>
          <bz-button @click=${libraries}>${icon("layers")} Kütüphaneler${w.libraries.length ? ` (${w.libraries.length})` : ""}</bz-button>
          <bz-button @click=${() => void workspace.saveAll().then(() => toast.success("Kaydedildi."))}>${icon("download")} Kaydet</bz-button>
          <bz-button variant="primary" ?loading=${busy} @click=${build}>${icon("check")} Derle ve etkinleştir</bz-button>
        </div>
        <p class="muted small">${loadedText()}</p>
        ${workspace.view}`
    })}</div>`
  },
})

export const libraryPage = definePage({
  title: "Kod kütüphanesi",
  setup(ctx) {
    const key = ctx.params().key
    const lib = loader(() => api.get<{ key: string; name: string; description: string | null; files: SourceFile[]; versions: { version: string; hash: string; createdAt: string }[] }>(`/development/libraries/${key}`))
    return html`<div class="page code-page">${loading(lib, () => {
      const l = lib.data()!
      const workspace = codeWorkspace({
        files: l.files,
        save: (f) => api.put(`/development/libraries/${key}/files`, f),
        remove: (path) => api.delete(`/development/libraries/${key}/files?path=${encodeURIComponent(path)}`),
        check: (files) => api.post<CheckResult>(`/development/libraries/${key}/check`, { files }),
        complete: (files, path, line, column) => api.post<CompletionEntry[]>(`/development/libraries/${key}/complete`, { files, path, line, column }),
        template: (path) => `// ${path}\nnamespace Ortak;\n\npublic static class ${className(path)}\n{\n}\n`,
      })
      ctx.onBeforeLeave(unsavedGuard(workspace.dirtyCount))
      const next = () => {
        const last = l.versions[0]?.version
        if (!last) return "1.0.0"
        const [a, b, c] = last.split(".").map(Number)
        return `${a}.${b}.${c + 1}`
      }
      const publish = async () => {
        await workspace.saveAll()
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
          await lib.reload()
        }
      }
      return html`
        <div class="page-head">
          <bz-button variant="ghost" size="sm" aria-label="Geliştirmeye dön" @click=${() => void ctx.navigate("/development")}>${icon("arrow-left")}</bz-button>
          <h1>${l.name}</h1><span class="muted small">${l.key}${l.versions.length ? ` · ${l.versions.map((v) => v.version).join(", ")}` : " · yayınlanmadı"}</span>
          <span class="spacer"></span>
          <bz-button @click=${() => void workspace.saveAll().then(() => toast.success("Kaydedildi."))}>${icon("download")} Kaydet</bz-button>
          <bz-button variant="primary" @click=${publish}>${icon("upload")} Versiyon yayınla</bz-button>
        </div>
        ${l.description ? html`<p class="muted small">${l.description}</p>` : null}
        ${workspace.view}`
    })}</div>`
  },
})
