import { computed, effect, html, render, untrack } from "@bazlama/core"
import { defineIcons, dialogs, icon, toast, type TreeItem } from "@bazlama/headless"
import * as icons from "@bazlama/icons"
import { createRouter } from "@bazlama/router"
import "@bazlama/themes.css"
import "@bazlama/ui.css"
import "./app.css"
import { errorText } from "./api"
import { authPage, enrollStep } from "./auth/auth-page"
import { chooseContext } from "./auth/context-dialog"
import { changePassword } from "./auth/password-dialog"
import { canManage, managementRoutes, SECTIONS } from "./management"
import { loadRuntimeApps } from "./runtime/api"
import { runtimeShell } from "./runtime/tabs"
import { can, contextText, isActive, logout, me, refreshMe } from "./session"

/*
 * Before sign-in: the auth pages (setup, login, second factor…). Signed in: one of three
 * areas, each with a frame of its own:
 * - Runtime (#/, #/apps/…): the apps as cards on a home tab, each app in a tab of its own.
 * - Development (#/development…): a full-window IDE.
 * - Management (#/management…): a side menu with the system screens.
 * The header's area menu moves between them (as far as the permissions allow).
 */

defineIcons(icons)
document.documentElement.dataset.theme = "modern"

const router = createRouter({
  mode: "hash",
  titleTemplate: (t) => `${t} · Bazlama`,
  routes: [
    { path: "/development", page: () => import("./development/pages").then((m) => m.devHome) },
    { path: "/development/apps/:app", page: () => import("./development/app-page").then((m) => m.appPage), remount: true },
    { path: "/development/libraries/:key", page: () => import("./development/pages").then((m) => m.libraryPage), remount: true },
    ...managementRoutes,
    // Everything else is Runtime: one page holding the tabs (the URL is the active tab's).
    { path: "/*rest", page: runtimeShell },
  ],
})

type Area = "runtime" | "development" | "management"
const area = computed<Area>(() => {
  const path = router.current()?.path ?? ""
  return path.startsWith("/development") ? "development" : path.startsWith("/management") ? "management" : "runtime"
})
const AREAS: { area: Area; label: string; icon: string; path: string; allowed: () => boolean }[] = [
  { area: "runtime", label: "Uygulamalar", icon: "layers", path: "/", allowed: () => true },
  { area: "development", label: "Geliştirme", icon: "code", path: "/development", allowed: () => can("development.access") },
  { area: "management", label: "Yönetim", icon: "settings", path: "/management", allowed: canManage },
]

const onUserMenu = async (e: CustomEvent<{ value: string }>) => {
  try {
    const value = e.detail.value
    const target = AREAS.find((a) => `area:${a.area}` === value)
    if (target) await router.navigate(target.path)
    else if (value === "context") await chooseContext()
    else if (value === "password") await changePassword()
    else if (value === "mfa") await dialogs.open({ heading: "İki adımlı doğrulama", content: (ref) => enrollStep(true, () => void ref.close()) })
    else if (value === "logout") await logout()
  } catch (err) {
    toast.error(errorText(err))
  }
}

/** The areas the user may enter, as buttons (the current one marked). */
const areaSwitch = () => {
  const list = AREAS.filter((a) => a.allowed())
  if (list.length < 2) return null
  return html`<div class="area-switch" role="group" aria-label="Alan">
    ${list.map(
      (a) => html`<a href=${router.href(a.path)} class="area-link" ?data-current=${() => area() === a.area} data-tooltip=${a.label}>
        ${icon(a.icon, { size: 16 })}<span>${a.label}</span></a>`,
    )}
  </div>`
}

const header = (title: string, subtitle: string | null, home: string) => html`
  <bz-header slot="header" title=${title} subtitle=${subtitle} href=${router.href(home)} ?no-menu-button=${area() !== "management"} menu-label="Menü"
    user-name=${() => me()?.user?.displayName ?? ""} user-detail=${contextText} user-label="Kullanıcı menüsü" @select=${onUserMenu}>
    <bz-icon slot="logo" name="layers" size="24"></bz-icon>
    ${areaSwitch()}
    <bz-button variant="ghost" size="sm" class="context-button" data-tooltip="Çalışma bağlamını değiştir" @click=${() => void chooseContext()}>
      ${() => contextText() || "Bağlam seçin"}
    </bz-button>
    <bz-menu-item slot="user-menu" value="context" icon="building">Çalışma bağlamı</bz-menu-item>
    <bz-menu-item slot="user-menu" value="password" icon="lock">Parola değiştir</bz-menu-item>
    ${() => (me()?.user?.mfaEnabled ? null : html`<bz-menu-item slot="user-menu" value="mfa" icon="shield">İki adımlı doğrulamayı aç</bz-menu-item>`)}
    <bz-menu-separator slot="user-menu"></bz-menu-separator>
    <bz-menu-item slot="user-menu" value="logout" icon="log-out">Çıkış yap</bz-menu-item>
  </bz-header>`

// ── The three frames ─────────────────────────────────────────────────────

const runtimeFrame = () => html`
  <bz-shell class="frame-runtime" skip-label="İçeriğe geç" .busy=${router.pending}>
    ${header("Bazlama", null, "/")}
    <bz-outlet></bz-outlet>
  </bz-shell>`

const developmentFrame = () => html`
  <bz-shell class="frame-development" skip-label="İçeriğe geç" .busy=${router.pending}>
    ${header("Bazlama", "Geliştirme", "/development")}
    <bz-outlet></bz-outlet>
  </bz-shell>`

const managementNav = computed<TreeItem[]>(() => {
  me() // permissions decide the menu
  return [
    { id: "/management", label: "Genel bakış", icon: "dashboard", href: router.href("/management") },
    ...SECTIONS.filter((s) => can(s.permission)).map((s) => ({ id: s.path, label: s.label, icon: s.icon, href: router.href(s.path) })),
  ]
})
/** The deepest section the path is under ("/management/users/42" → Kullanıcılar). */
const managementCurrent = computed(() => {
  const path = router.current()?.path ?? ""
  return managementNav().filter((n) => path === n.id || path.startsWith(`${n.id}/`)).sort((a, b) => b.id.length - a.id.length)[0]?.id ?? ""
})

const managementFrame = () => html`
  <bz-shell class="frame-management" resizable persist="bazlama-management" resize-label="Menüyü boyutlandır" skip-label="İçeriğe geç" .busy=${router.pending}>
    ${header("Bazlama", "Yönetim", "/management")}
    <nav slot="start" aria-label="Yönetim menüsü">
      <bz-tree label="Yönetim menüsü" selection="leaf" .items=${managementNav} .value=${managementCurrent}></bz-tree>
    </nav>
    <bz-outlet></bz-outlet>
  </bz-shell>`

const frame = () => {
  const a = area()
  // An area the user may not enter (an old link): back to Runtime.
  if (!AREAS.find((x) => x.area === a)!.allowed()) {
    queueMicrotask(() => void router.navigate("/", { replace: true }))
    return null
  }
  return a === "development" ? developmentFrame() : a === "management" ? managementFrame() : runtimeFrame()
}

// Only a change between these rebuilds the page (not every new Me: context, MFA…).
const view = computed(() => (me() === null ? "loading" : isActive() ? "shell" : "auth"))
// The frame is rebuilt only when the area changes.
const app = html`${() => (view() === "shell" ? (area(), untrack(frame)) : view() === "auth" ? authPage() : null)}`
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

// The apps follow the permissions (they can depend on the location).
effect(() => {
  if (isActive() && me()?.permissions) loadRuntimeApps().catch((e) => toast.error(errorText(e)))
})

refreshMe().catch((e) => toast.error(errorText(e)))
