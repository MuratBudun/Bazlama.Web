import { html, signal } from "@bazlama/core"
import { dialogs, icon, toast, type GridColumn } from "@bazlama/headless"
import { definePage } from "@bazlama/router"
import { api, errorText } from "../api"
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

export const appsPage = definePage({
  title: "Uygulamalar",
  setup(ctx) {
    const apps = loader(() => api.get<AppRow[]>("/management/apps"))
    return html`<div class="page">
      <div class="page-head">
        <h1>Uygulamalar</h1><span class="spacer"></span>
        <bz-button variant="primary" @click=${() => install(apps.reload)}>${icon("upload")} Kur / güncelle</bz-button>
      </div>
      <p class="muted">Kurulu uygulamalar. Bir uygulamanın yeni versiyonu aynı yerden yüklenir; tablolar tanıma göre güncellenir.</p>
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
          <bz-button variant="primary" @click=${() => install(detail.reload)}>${icon("upload")} Yeni versiyon</bz-button>
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
