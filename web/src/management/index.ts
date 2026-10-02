import { html, signal } from "@bazlama/core"
import { api, type SystemInfo } from "../api"
import { icon } from "@bazlama/headless"
import { definePage, type RouteRecord } from "@bazlama/router"
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

/** What this installation is (version, environment mode, database). */
function installation() {
  const info = signal<SystemInfo | null>(null)
  const error = signal("")
  api.get<SystemInfo>("/system/info").then(info.set, (e: Error) => error.set(e.message))
  return html`<bz-panel heading="Kurulum">
    ${() => {
      if (error()) return html`<bz-alert variant="danger" heading="Sunucuya ulaşılamadı">${error()}</bz-alert>`
      const i = info()
      if (!i) return html`<span class="muted">Yükleniyor…</span>`
      return html`<dl class="facts">
        <dt>Sürüm</dt><dd>${i.version}</dd>
        <dt>Ortam</dt><dd>${i.environment}</dd>
        <dt>Veritabanı</dt><dd>${i.databaseProvider}</dd>
      </dl>`
    }}
  </bz-panel>`
}

const homePage = definePage({
  title: "Yönetim",
  setup: (ctx) => html`<div class="page">
    <div class="page-head"><h1>Yönetim</h1></div>
    ${installation()}
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
