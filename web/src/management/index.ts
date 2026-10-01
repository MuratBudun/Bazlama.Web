import { html } from "@bazlama/core"
import { icon, type TreeItem } from "@bazlama/headless"
import { definePage, type RouteRecord, type Router } from "@bazlama/router"
import { can } from "../session"
import { appDetailPage, appsPage } from "./apps"
import { groupPage, groupsPage } from "./groups"
import { organizationPage } from "./organization"
import { auditPage, sessionsPage, settingsPage } from "./system"
import { userPage, usersPage } from "./users"

/** The Management sections, each behind its permission. */
export const SECTIONS = [
  { path: "/management/users", label: "Kullanıcılar", icon: "users", permission: "system.users", text: "Hesaplar, parola ve MFA sıfırlama, grup üyelikleri, kurum yetkileri." },
  { path: "/management/groups", label: "Gruplar", icon: "shield", permission: "system.groups", text: "Roller: izinler ve üyeler." },
  { path: "/management/organization", label: "Organizasyon", icon: "building", permission: "system.organization", text: "Firma, lokasyon, plant ve dönemler." },
  { path: "/management/sessions", label: "Oturumlar", icon: "clock", permission: "system.sessions", text: "Açık oturumlar; oturum sonlandırma." },
  { path: "/management/settings", label: "Güvenlik ayarları", icon: "lock", permission: "system.settings", text: "Parola kuralları, hesap kilidi, oturum ve MFA." },
  { path: "/management/audit", label: "Audit", icon: "file-text", permission: "system.audit", text: "Güvenlik olayları ve veri değişiklikleri." },
  { path: "/management/apps", label: "Uygulamalar", icon: "layers", permission: "system.apps", text: "Uygulama kurma ve güncelleme; versiyon geçmişi." },
] as const

export const canManage = () => SECTIONS.some((s) => can(s.permission))

const homePage = definePage({
  title: "Yönetim",
  setup: (ctx) => html`<div class="page">
    <div class="page-head"><h1>Yönetim</h1></div>
    <div class="cards">
      ${() => SECTIONS.filter((s) => can(s.permission)).map(
        (s) => html`<a class="card-link" href=${ctx.router.href(s.path)}>
          ${icon(s.icon, { size: 22 })}<strong>${s.label}</strong><span class="muted small">${s.text}</span>
        </a>`,
      )}
    </div>
  </div>`,
})

export const managementRoutes: RouteRecord[] = [
  { path: "/management", page: homePage },
  { path: "/management/users", page: usersPage },
  { path: "/management/users/:id", page: userPage, remount: true },
  { path: "/management/groups", page: groupsPage },
  { path: "/management/groups/:id", page: groupPage, remount: true },
  { path: "/management/organization", page: organizationPage },
  { path: "/management/sessions", page: sessionsPage },
  { path: "/management/settings", page: settingsPage },
  { path: "/management/audit", page: auditPage },
  { path: "/management/apps", page: appsPage },
  { path: "/management/apps/:key", page: appDetailPage, remount: true },
]

/** The menu node with the sections the user may open. */
export const managementNav = (router: Router): TreeItem => ({
  id: "/management",
  label: "Yönetim",
  icon: "settings",
  children: SECTIONS.filter((s) => can(s.permission)).map((s) => ({ id: s.path, label: s.label, icon: s.icon, href: router.href(s.path) })),
})
