import { computed, effect, html, render, signal } from "@bazlama/core"
import { collectIds, defineIcons, dialogs, icon, toast, type TreeItem } from "@bazlama/headless"
import * as icons from "@bazlama/icons"
import { createRouter } from "@bazlama/router"
import "@bazlama/themes.css"
import "@bazlama/ui.css"
import "./app.css"
import { api, ApiError, errorText } from "./api"
import { chooseContext } from "./auth/context-dialog"
import { previewApp, runtimeApps, runtimeConfig, type PreviewApp } from "./runtime/api"
import { appPage, listPage, recordPage, runtimeNav } from "./runtime/pages"
import { contextText, isActive, me, refreshMe } from "./session"

/*
 * A draft's preview, in a tab of its own (preview.html#/preview/<app>_pv/…). The Runtime pages
 * draw it from the preview's definition; its records live in the preview's own tables and the
 * draft's code runs on them. Only the app's menu is shown: it looks as it will once published.
 * "Yenile" installs the saved draft again (Development › Önizle does the same).
 */

defineIcons(icons)
document.documentElement.dataset.theme = "modern"

const key = /^#\/preview\/([a-z0-9_]+)/.exec(location.hash)?.[1] ?? ""
const preview = signal<PreviewApp | null>(null)
const error = signal("")
const busy = signal(false)

runtimeConfig.base = "/preview"
runtimeConfig.load = async (k) => {
  if (k !== key) throw new ApiError(404, ["Bu sekme yalnız kendi önizlemesini gösterir."], {}, null)
  return preview() ?? (await load())
}

async function load() {
  const p = await previewApp(key)
  preview.set(p)
  const d = p.definition
  runtimeApps.set([{ key: d.key, name: d.name, version: d.version, description: d.description ?? null, icon: d.icon ?? null, entities: [], menu: p.menu }])
  document.title = `${d.name} · Önizleme`
  return p
}

const router = createRouter({
  mode: "hash",
  titleTemplate: (t) => `${t} · Önizleme`,
  routes: [
    { path: "/preview/:app", page: appPage, remount: true },
    { path: "/preview/:app/:entity", page: listPage, remount: true },
    { path: "/preview/:app/:entity/:id", page: recordPage, remount: true },
  ],
})

const nav = computed<TreeItem[]>(() => runtimeNav(router.href)()[0]?.children ?? [])
const flatten = (items: TreeItem[]): TreeItem[] => items.flatMap((n) => [n, ...flatten(n.children ?? [])])
/** As in the platform shell: the item of the list a page came from, else the deepest one the path is under. */
const current = computed(() => {
  const state = router.current()
  const path = state?.path ?? "/"
  const list = state?.query.get("list")
  const form = state?.query.get("form")
  const items = flatten(nav()).filter((n) => n.href)
  const exact = [list ? `${path.split("/").slice(0, 4).join("/")}?list=${list}` : "", form ? `${path}?form=${form}` : ""]
  const hit = items.find((n) => exact.includes(n.id))
  if (hit) return hit.id
  const base = (id: string) => id.split("?")[0]
  return items.filter((n) => path === base(n.id) || path.startsWith(`${base(n.id)}/`)).sort((a, b) => b.id.length - a.id.length)[0]?.id ?? ""
})

/** Installs the saved draft again (reset: its records go too) and reloads the tab. */
async function reinstall(reset: boolean) {
  const source = preview()?.source ?? key.replace(/_pv$/, "")
  if (reset && !(await dialogs.confirm({ heading: "Verileri sıfırla", message: "Önizlemenin tabloları baştan kurulur, girilen kayıtlar silinir.", confirmText: "Sıfırla", cancelText: "Vazgeç", variant: "danger" })))
    return
  busy.set(true)
  try {
    const r = await api.post<{ code: { success: boolean } | null }>(`/development/apps/${source}/preview`, { reset })
    if (r.code && !r.code.success) toast.warning("Kod derlenmedi: önizleme kodsuz çalışıyor. Hatalar Geliştirme'de.")
    location.reload()
  } catch (e) {
    busy.set(false)
    void dialogs.alert({ heading: "Önizleme kurulamadı", message: e instanceof ApiError ? e.errors.join("\n") : errorText(e) })
  }
}

const onMenu = (e: CustomEvent<{ value: string }>) => {
  if (e.detail.value === "context") void chooseContext()
  else if (e.detail.value === "reset") void reinstall(true)
}

const shell = () => html`
  <bz-shell resizable start-collapse="hidden" persist="bazlama-preview" resize-label="Menüyü boyutlandır" skip-label="İçeriğe geç" .busy=${() => router.pending() || busy()}>
    <bz-header slot="header" title=${() => preview()?.definition.name ?? "Önizleme"} subtitle="Önizleme · taslak" href=${router.href(`/preview/${key}`)}
      menu-label="Menü" user-name=${() => me()?.user?.displayName ?? ""} user-detail=${contextText} user-label="Önizleme menüsü" @select=${onMenu}>
      <bz-icon slot="logo" name=${preview()?.definition.icon ?? "layers"} size="24"></bz-icon>
      <bz-badge slot="center" variant="warning" data-tooltip="Kayıtlar önizlemenin kendi tablolarında; yayındaki uygulamaya dokunmaz">Önizleme</bz-badge>
      <bz-button variant="ghost" size="sm" class="context-button" data-tooltip="Çalışma bağlamını değiştir" @click=${() => void chooseContext()}>
        ${() => contextText() || "Bağlam seçin"}
      </bz-button>
      <bz-button variant="ghost" size="sm" data-tooltip="Kaydedilmiş taslağı ve kodu yeniden kurar" @click=${() => void reinstall(false)}>${icon("refresh")} Yenile</bz-button>
      <bz-menu-item slot="user-menu" value="context" icon="building">Çalışma bağlamı</bz-menu-item>
      <bz-menu-item slot="user-menu" value="reset" icon="trash">Önizleme verilerini sıfırla</bz-menu-item>
    </bz-header>
    <nav slot="start" aria-label="Uygulama menüsü">
      <bz-tree label="Uygulama menüsü" selection="leaf" .items=${nav} .value=${current} .expanded=${() => collectIds(nav())}></bz-tree>
    </nav>
    <bz-outlet></bz-outlet>
  </bz-shell>
`

const message = (text: string, action?: unknown) =>
  html`<div class="page"><div class="page-head">${icon("layers", { size: 22 })}<h1>Önizleme</h1></div><bz-alert variant="warning">${text}</bz-alert>${action ?? null}</div>`

const view = computed(() => (me() === null ? "loading" : !isActive() ? "signed-out" : error() ? "error" : preview() ? "shell" : "loading"))
render(
  html`${() => {
    switch (view()) {
      case "signed-out":
        return message("Önizleme için Bazlama'da oturum açın.", html`<p><a href="./">Bazlama'yı aç</a></p>`)
      case "error":
        return message(error())
      case "shell":
        return shell()
      default:
        return null
    }
  }}`,
  document.getElementById("app")!,
)

let started = false
effect(() => {
  if (!isActive() || started) return
  started = true
  load().then(
    () => {
      void router.start()
      if (me()?.contextRequired) queueMicrotask(() => void chooseContext(true))
    },
    (e) =>
      error.set(e instanceof ApiError && e.status === 404 ? "Bu önizleme kurulmamış ya da kaldırılmış. Geliştirme'de uygulamayı açıp Önizle'ye basın." : errorText(e)),
  )
})

refreshMe().catch((e) => toast.error(errorText(e)))
