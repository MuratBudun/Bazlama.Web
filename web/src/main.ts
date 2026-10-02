import { computed, effect, html, render } from "@bazlama/core"
import { defineIcons, dialogs, toast, type TreeItem } from "@bazlama/headless"
import * as icons from "@bazlama/icons"
import { createRouter } from "@bazlama/router"
import "@bazlama/themes.css"
import "@bazlama/ui.css"
import "./app.css"
import { errorText } from "./api"
import { authPage, enrollStep } from "./auth/auth-page"
import { chooseContext } from "./auth/context-dialog"
import { changePassword } from "./auth/password-dialog"
import { canManage, managementNav, managementRoutes } from "./management"
import homePage from "./pages/home"
import { loadRuntimeApps } from "./runtime/api"
import { appPage, listPage, recordPage, runtimeHome, runtimeNav } from "./runtime/pages"
import { can, contextText, isActive, logout, me, refreshMe } from "./session"

/*
 * Before sign-in: the auth pages (setup, login, second factor…). Signed in: the platform
 * shell with its three areas (Runtime, Development, Management). Hash routing: #/management.
 */

defineIcons(icons)
document.documentElement.dataset.theme = "modern"

const router = createRouter({
  mode: "hash",
  titleTemplate: (t) => `${t} · Bazlama`,
  routes: [
    { path: "/", page: homePage },
    { path: "/runtime", page: runtimeHome },
    { path: "/runtime/:app", page: appPage, remount: true },
    { path: "/runtime/:app/:entity", page: listPage, remount: true },
    { path: "/runtime/:app/:entity/:id", page: recordPage, remount: true },
    { path: "/development", page: () => import("./development/pages").then((m) => m.devHome) },
    { path: "/development/apps/:app", page: () => import("./development/designer").then((m) => m.appDesignPage), remount: true },
    { path: "/development/apps/:app/entities/:entity", page: () => import("./development/designer").then((m) => m.entityDesignPage), remount: true },
    { path: "/development/apps/:app/code", page: () => import("./development/pages").then((m) => m.appCodePage), remount: true },
    { path: "/development/libraries/:key", page: () => import("./development/pages").then((m) => m.libraryPage), remount: true },
    ...managementRoutes,
  ],
})

const appsNav = runtimeNav(router.href)

const nav = computed<TreeItem[]>(() => {
  me() // permissions decide the menu
  const apps = appsNav()
  const items: TreeItem[] = [
    { id: "/", label: "Başlangıç", icon: "home", href: router.href("/") },
    apps.length
      ? { id: "/runtime", label: "Uygulamalar", icon: "layers", children: apps }
      : { id: "/runtime", label: "Uygulamalar", icon: "layers", href: router.href("/runtime") },
  ]
  if (can("development.access")) items.push({ id: "/development", label: "Geliştirme", icon: "code", href: router.href("/development") })
  if (canManage()) items.push(managementNav(router))
  return items
})
const flatten = (items: TreeItem[]): TreeItem[] => items.flatMap((n) => [n, ...flatten(n.children ?? [])])
/** The deepest menu item the current path is under ("/management/users/42" → Kullanıcılar). */
const current = computed(() => {
  const path = router.current()?.path ?? "/"
  return flatten(nav()).filter((n) => n.href && (path === n.id || path.startsWith(`${n.id}/`))).sort((a, b) => b.id.length - a.id.length)[0]?.id ?? ""
})
/** Groups stay open: apps and management. */
const expanded = computed(() => ["/runtime", "/management", ...appsNav().map((a) => a.id)])

const onUserMenu = async (e: CustomEvent<{ value: string }>) => {
  try {
    if (e.detail.value === "context") await chooseContext()
    else if (e.detail.value === "password") await changePassword()
    else if (e.detail.value === "mfa") await dialogs.open({ heading: "İki adımlı doğrulama", content: (ref) => enrollStep(true, () => void ref.close()) })
    else if (e.detail.value === "logout") await logout()
  } catch (err) {
    toast.error(errorText(err))
  }
}

const shell = () => html`
  <bz-shell resizable persist="bazlama" resize-label="Menüyü boyutlandır" skip-label="İçeriğe geç" .busy=${router.pending}>
    <bz-header slot="header" title="Bazlama" href=${router.href("/")} menu-label="Menü"
      user-name=${() => me()?.user?.displayName ?? ""} user-detail=${contextText} user-label="Kullanıcı menüsü" @select=${onUserMenu}>
      <bz-icon slot="logo" name="layers" size="24"></bz-icon>
      <bz-button variant="ghost" size="sm" class="context-button" data-tooltip="Çalışma bağlamını değiştir" @click=${() => void chooseContext()}>
        ${() => contextText() || "Bağlam seçin"}
      </bz-button>
      <bz-menu-item slot="user-menu" value="context" icon="building">Çalışma bağlamı</bz-menu-item>
      <bz-menu-item slot="user-menu" value="password" icon="lock">Parola değiştir</bz-menu-item>
      ${() => (me()?.user?.mfaEnabled ? null : html`<bz-menu-item slot="user-menu" value="mfa" icon="shield">İki adımlı doğrulamayı aç</bz-menu-item>`)}
      <bz-menu-separator slot="user-menu"></bz-menu-separator>
      <bz-menu-item slot="user-menu" value="logout" icon="log-out">Çıkış yap</bz-menu-item>
    </bz-header>
    <nav slot="start" aria-label="Menü">
      <bz-tree label="Menü" selection="leaf" .items=${nav} .value=${current} .expanded=${expanded}></bz-tree>
    </nav>
    <bz-outlet></bz-outlet>
  </bz-shell>
`

// Only a change between these rebuilds the page (not every new Me: context, MFA…).
const view = computed(() => (me() === null ? "loading" : isActive() ? "shell" : "auth"))
const app = html`${() => (view() === "shell" ? shell() : view() === "auth" ? authPage() : null)}`
render(app, document.getElementById("app")!)

// Signed out: the last page's title would stay in the tab.
effect(() => {
  if (view() === "auth") document.title = "Bazlama"
})

let started = false
effect(() => {
  if (!isActive()) return
  if (!started) {
    started = true
    void router.start()
  }
  if (me()?.contextRequired) queueMicrotask(() => void chooseContext(true))
})

// The apps menu follows the permissions (they can depend on the location).
effect(() => {
  if (isActive() && me()?.permissions) loadRuntimeApps().catch((e) => toast.error(errorText(e)))
})

refreshMe().catch((e) => toast.error(errorText(e)))
