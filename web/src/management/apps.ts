import { html, signal } from "@bazlama/core"
import { dialogs, icon, toast, type GridColumn } from "@bazlama/headless"
import { definePage } from "@bazlama/router"
import { api, ApiError, errorText, systemInfo } from "../api"
import { forgetRuntimeApps, loadRuntimeApps } from "../runtime/api"
import { refreshMe } from "../session"
import { checkField, dataGrid, dateTime, loader, loading } from "./ui"

interface AppRow {
  key: string
  name: string
  version: string
  installedAt: string
  updatedAt: string
  entityCount: number
}
interface InstallPlan {
  key: string
  name: string
  fromVersion: string | null
  toVersion: string
  changes: { description: string; destructive: boolean }[]
  errors: string[]
  hasDestructive: boolean
}
interface ImportPreview {
  manifest: { key: string; name: string; version: string; platformVersion: string; exportedAt: string; exportedBy: string | null; buildHash: string | null } | null
  plan: InstallPlan | null
  libraries: { key: string; version: string; status: "new" | "installed" | "conflict" }[]
  code: { fileCount: number; success: boolean; diagnostics: { path: string; line: number; message: string; severity: string }[] } | null
  errors: string[]
  canImport: boolean
}
interface ImportResult {
  imported: boolean
  preview: ImportPreview
  buildHash: string | null
  hashMatches: boolean | null
}
interface AppDetail {
  definition: unknown
  versions: { version: string; installedAt: string; installedBy: string | null; changes: string | null }[]
}

const COLUMNS: GridColumn<AppRow>[] = [
  { key: "name", header: "Uygulama", sortable: true, width: 240, flex: true, format: (v, a) => html`<strong>${v as string}</strong> <span class="muted small">${a.key}</span>` },
  { key: "version", header: "Versiyon", width: 110 },
  { key: "entityCount", header: "Entity", width: 90, align: "end" },
  { key: "installedAt", header: "Kurulum", width: 150, format: (v) => dateTime(v as string) },
  { key: "updatedAt", header: "Son güncelleme", width: 150, sortable: true, format: (v) => dateTime(v as string) },
]

/** Install or upgrade: the definition (file or pasted JSON) → the plan → install. */
async function install(after: () => Promise<unknown>) {
  const text = signal("")
  const plan = signal<InstallPlan | null>(null)
  const error = signal("")
  const busy = signal(false)
  const confirmDrop = signal(false)

  const parse = () => {
    try {
      return JSON.parse(text()) as unknown
    } catch (e) {
      error.set(`JSON okunamadı: ${(e as Error).message}`)
      return undefined
    }
  }
  const check = async () => {
    error.set("")
    plan.set(null)
    const definition = parse()
    if (definition === undefined) return
    busy.set(true)
    try {
      plan.set(await api.post<InstallPlan>("/management/apps/plan", definition))
      confirmDrop.set(false)
    } catch (e) {
      error.set(errorText(e))
    } finally {
      busy.set(false)
    }
  }
  const readFile = async (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0]
    if (!file) return
    text.set(await file.text())
    await check()
  }

  const installed = await dialogs.open<boolean>({
    heading: "Uygulama kur / güncelle",
    size: "lg",
    content: () => html`<div class="stack">
      <p class="muted">Uygulama tanımını (JSON) seçin ya da yapıştırın. Kurmadan önce veritabanında yapılacak değişiklikler gösterilir.</p>
      <div class="row"><input type="file" accept=".json,application/json" aria-label="Tanım dosyası" @change=${readFile} /></div>
      <bz-textarea label="Tanım (JSON)" rows="8" max-rows="16" autosize .value=${text}
        @input=${(e: Event) => (text.set((e.currentTarget as HTMLTextAreaElement).value), plan.set(null))}></bz-textarea>
      ${() => (error() ? html`<bz-alert variant="danger">${error()}</bz-alert>` : null)}
      ${() => {
        const p = plan()
        if (!p) return null
        return html`<section class="stack plan">
          <h2>${p.name} <span class="muted small">${p.fromVersion ? `${p.fromVersion} → ${p.toVersion}` : `${p.toVersion} (yeni kurulum)`}</span></h2>
          ${p.errors.length
            ? html`<bz-alert variant="danger" heading="Kurulamaz"><ul>${p.errors.map((e) => html`<li>${e}</li>`)}</ul></bz-alert>`
            : html`<ul class="changes">${p.changes.map((c) => html`<li class=${c.destructive ? "destructive" : ""}>${c.destructive ? icon("alert", { size: 14 }) : icon("check", { size: 14 })} ${c.description}</li>`)}</ul>
              ${p.changes.length === 0 ? html`<p class="muted">Veritabanında değişiklik yok (yalnız tanım güncellenir).</p>` : null}
              ${p.hasDestructive
                ? html`<bz-alert variant="warning" heading="Veri kaybı">Kırmızı işaretli değişiklikler kolon veya tablo siler; içindeki veriler geri alınamaz.</bz-alert>
                    ${checkField("Veri kaybını anlıyorum, devam et", confirmDrop)}`
                : null}`}
        </section>`
      }}
    </div>`,
    footer: (ref) => html`<bz-button @click=${() => void ref.close(false)}>Vazgeç</bz-button>
      <bz-button ?loading=${busy} ?disabled=${() => !text().trim()} @click=${check}>Planı göster</bz-button>
      <bz-button variant="primary" ?loading=${busy} ?disabled=${() => !plan() || plan()!.errors.length > 0 || (plan()!.hasDestructive && !confirmDrop())}
        @click=${async () => {
          const definition = parse()
          if (definition === undefined) return
          busy.set(true)
          try {
            await api.post("/management/apps/install", { definition, confirmDestructive: confirmDrop() })
            void ref.close(true)
          } catch (e) {
            error.set(errorText(e))
          } finally {
            busy.set(false)
          }
        }}>Kur</bz-button>`,
  })
  if (installed) {
    toast.success("Uygulama kuruldu. Kullanıcılara erişim için grup izinlerini verin.")
    forgetRuntimeApps()
    await Promise.all([after(), loadRuntimeApps(), refreshMe()])
  }
}

const LIBRARY_STATUS = { new: "kurulacak", installed: "kurulu (aynı)", conflict: "çakışıyor" }

/** A .bzapp package: the file → what it would do (schema, libraries, code) → import. */
async function importPackage(after: () => Promise<unknown>) {
  const file = signal<File | null>(null)
  const preview = signal<ImportPreview | null>(null)
  const error = signal("")
  const busy = signal(false)
  const confirmDrop = signal(false)
  let result = null as ImportResult | null

  const readFile = async (e: Event) => {
    const f = (e.currentTarget as HTMLInputElement).files?.[0] ?? null
    file.set(f)
    preview.set(null)
    error.set("")
    confirmDrop.set(false)
    if (!f) return
    busy.set(true)
    try {
      preview.set(await api.upload<ImportPreview>("/management/apps/import/preview", f))
    } catch (e) {
      error.set(errorText(e))
    } finally {
      busy.set(false)
    }
  }

  const imported = await dialogs.open<boolean>({
    heading: "Paket içe aktar (.bzapp)",
    size: "lg",
    content: () => html`<div class="stack">
      <p class="muted">Geliştirme ortamında dışa aktarılan paketi seçin. Kurmadan önce veritabanı değişiklikleri, kütüphaneler ve kodun bu kurulumda derlenip derlenmediği gösterilir.</p>
      <div class="row"><input type="file" accept=".bzapp" aria-label="Paket dosyası" @change=${readFile} /></div>
      ${() => (error() ? html`<bz-alert variant="danger">${error()}</bz-alert>` : null)}
      ${() => {
        const p = preview()
        if (!p) return null
        const m = p.manifest
        const plan = p.plan
        const codeErrors = p.code?.diagnostics.filter((d) => d.severity === "error") ?? []
        return html`<section class="stack plan">
          ${m ? html`<h2>${m.name} <span class="muted small">${plan?.fromVersion ? `${plan.fromVersion} → ${m.version}` : `${m.version} (yeni kurulum)`}</span></h2>
            <p class="muted small">Dışa aktaran: ${m.exportedBy ?? "?"} · ${dateTime(m.exportedAt)} · platform ${m.platformVersion}</p>` : null}
          ${p.errors.length ? html`<bz-alert variant="danger" heading="Kurulamaz"><ul>${p.errors.map((e) => html`<li>${e}</li>`)}</ul></bz-alert>` : null}
          ${plan?.errors.length ? html`<bz-alert variant="danger" heading="Kurulamaz"><ul>${plan.errors.map((e) => html`<li>${e}</li>`)}</ul></bz-alert>` : null}
          ${plan && !plan.errors.length
            ? html`<h3>Veritabanı</h3><ul class="changes">${plan.changes.map((c) => html`<li class=${c.destructive ? "destructive" : ""}>${c.destructive ? icon("alert", { size: 14 }) : icon("check", { size: 14 })} ${c.description}</li>`)}</ul>
              ${plan.changes.length === 0 ? html`<p class="muted">Veritabanında değişiklik yok.</p>` : null}`
            : null}
          ${p.libraries.length ? html`<h3>Kod kütüphaneleri</h3><ul class="changes">${p.libraries.map((l) => html`<li class=${l.status === "conflict" ? "destructive" : ""}>${l.key} ${l.version} — ${LIBRARY_STATUS[l.status]}</li>`)}</ul>` : null}
          ${p.code
            ? p.code.success
              ? html`<bz-alert variant="success">Kod (${p.code.fileCount} dosya) bu kurulumda derleniyor.</bz-alert>`
              : html`<bz-alert variant="danger" heading="Kod derlenmiyor"><ul>${codeErrors.slice(0, 10).map((d) => html`<li>${d.path}:${d.line} — ${d.message}</li>`)}</ul></bz-alert>`
            : null}
          ${plan?.hasDestructive && p.canImport
            ? html`<bz-alert variant="warning" heading="Veri kaybı">Kırmızı işaretli değişiklikler kolon veya tablo siler; içindeki veriler geri alınamaz.</bz-alert>
                ${checkField("Veri kaybını anlıyorum, devam et", confirmDrop)}`
            : null}
        </section>`
      }}
    </div>`,
    footer: (ref) => html`<bz-button @click=${() => void ref.close(false)}>Vazgeç</bz-button>
      <bz-button variant="primary" ?loading=${busy} ?disabled=${() => !preview()?.canImport || (preview()!.plan!.hasDestructive && !confirmDrop())}
        @click=${async () => {
          busy.set(true)
          try {
            result = await api.upload<ImportResult>(`/management/apps/import?confirmDestructive=${confirmDrop()}`, file()!)
            void ref.close(true)
          } catch (e) {
            if (e instanceof ApiError && (e.body as ImportResult | null)?.preview) preview.set((e.body as ImportResult).preview)
            error.set(errorText(e))
          } finally {
            busy.set(false)
          }
        }}>İçe aktar</bz-button>`,
  })
  if (imported) {
    if (result?.hashMatches === false) toast.warning("Kuruldu, ancak derlenen kodun özeti paketteki özetle aynı değil.")
    else toast.success("Paket kuruldu. Kullanıcılara erişim için grup izinlerini verin.")
    forgetRuntimeApps()
    await Promise.all([after(), loadRuntimeApps(), refreshMe()])
  }
}

/** Installing from a bare definition is for development installations; others take packages. */
const devInstall = signal(false)
void systemInfo().then((i) => devInstall.set(i.environment === "Development"), () => {})

export const appsPage = definePage({
  title: "Uygulamalar",
  setup(ctx) {
    const apps = loader(() => api.get<AppRow[]>("/management/apps"))
    return html`<div class="page">
      <div class="page-head">
        <h1>Uygulamalar</h1><span class="spacer"></span>
        ${() => (devInstall() ? html`<bz-button @click=${() => install(apps.reload)}>${icon("upload")} Tanımdan kur (JSON)</bz-button>` : null)}
        <bz-button variant="primary" @click=${() => importPackage(apps.reload)}>${icon("upload")} Paket içe aktar</bz-button>
      </div>
      <p class="muted">Kurulu uygulamalar. Yeni bir uygulama ya da yeni versiyonu .bzapp paketiyle kurulur; tablolar tanıma göre güncellenir.</p>
      ${loading(apps, () => dataGrid({
        label: "Uygulamalar",
        persist: "apps",
        fill: true,
        columns: COLUMNS,
        rows: () => apps.data() ?? [],
        rowKey: "key",
        onOpen: (a) => void ctx.navigate(`/management/apps/${a.key}`),
        empty: "Henüz uygulama kurulmadı.",
      }))}
    </div>`
  },
})

export const appDetailPage = definePage({
  title: "Uygulama",
  setup(ctx) {
    const key = ctx.params().key
    const detail = loader(() => api.get<AppDetail>(`/management/apps/${key}`))
    const download = () => {
      const a = document.createElement("a")
      a.href = URL.createObjectURL(new Blob([JSON.stringify(detail.data()!.definition, null, 2)], { type: "application/json" }))
      a.download = `${key}.json`
      a.click()
      URL.revokeObjectURL(a.href)
    }
    return html`<div class="page">${loading(detail, () => {
      const d = detail.data()!
      const def = d.definition as { name: string; version: string; description?: string }
      return html`<div class="page-head">
          <bz-button variant="ghost" size="sm" aria-label="Uygulamalara dön" @click=${() => void ctx.navigate("/management/apps")}>${icon("arrow-left")}</bz-button>
          <h1>${def.name}</h1><span class="muted small">v${def.version}</span><span class="spacer"></span>
          <bz-button @click=${download}>${icon("download")} Tanımı indir</bz-button>
          <a class="button-link" href=${`/api/management/apps/${key}/export`} download>${icon("download")} Dışa aktar (.bzapp)</a>
          <bz-button variant="primary" @click=${() => importPackage(detail.reload)}>${icon("upload")} Yeni versiyon (paket)</bz-button>
        </div>
        ${def.description ? html`<p class="muted">${def.description}</p>` : null}
        <h2>Versiyon geçmişi</h2>
        ${dataGrid({
          label: "Versiyonlar",
          columns: [
            { key: "version", header: "Versiyon", width: 110 },
            { key: "installedAt", header: "Kurulum", width: 150, format: (v) => dateTime(v as string) },
            { key: "installedBy", header: "Kuran", width: 160 },
            { key: "changes", header: "Değişiklikler", width: 400, flex: true, format: (v) => ((v as string | null)?.split("\n").length ?? 0) + " değişiklik" },
          ],
          rows: d.versions.map((v) => ({ ...v, id: v.version })),
          onOpen: (v) => void dialogs.open({ heading: `Versiyon ${v.version}`, size: "lg", content: html`<pre class="json">${v.changes || "Değişiklik yok."}</pre>` }),
        })}
        <h2>Tanım</h2>
        <pre class="json">${JSON.stringify(d.definition, null, 2)}</pre>`
    })}</div>`
  },
})
