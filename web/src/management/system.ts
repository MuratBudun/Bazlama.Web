import { computed, html, signal } from "@bazlama/core"
import { dialogs, icon, toast, type GridColumn } from "@bazlama/headless"
import { definePage } from "@bazlama/router"
import { api, errorText } from "../api"
import type { AuditRow, SecuritySettings, SessionRow } from "./types"
import { checkField, confirmAction, dataGrid, dateTime, loader, loading, numberField } from "./ui"

const STATUS: Record<string, string> = {
  Active: "Etkin",
  PendingMfa: "Doğrulama bekliyor",
  PendingMfaEnrollment: "MFA kurulumu bekliyor",
  PendingPasswordChange: "Parola değişimi bekliyor",
}

/** "Chrome 141 · Windows" from a user agent (enough to recognize a session). */
function browser(ua: string | null) {
  if (!ua) return ""
  const name = /Edg\/(\d+)/.exec(ua) ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}` : /Chrome\/(\d+)/.exec(ua) ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}` : /Firefox\/(\d+)/.exec(ua) ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}` : /Safari\//.test(ua) ? "Safari" : ua.slice(0, 40)
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : ""
  return [name, os].filter(Boolean).join(" · ")
}

export const sessionsPage = definePage({
  title: "Oturumlar",
  setup() {
    const sessions = loader(() => api.get<SessionRow[]>("/management/sessions"))
    const end = (s: SessionRow) =>
      confirmAction({
        heading: "Oturumu sonlandır",
        message: `${s.displayName} kullanıcısının bu oturumu kapatılsın mı? Kullanıcı yeniden giriş yapmak zorunda kalır.`,
        confirmText: "Sonlandır",
        danger: true,
        action: () => api.post(`/management/sessions/${s.id}/end`).then(sessions.reload),
        done: "Oturum sonlandırıldı.",
      })
    const columns: GridColumn<SessionRow>[] = [
      { key: "displayName", header: "Kullanıcı", sortable: true, width: 260, flex: true, format: (v, s) => html`${v as string} <span class="muted small">${s.userName}</span>${s.isCurrent ? html` <bz-badge variant="primary">Bu oturum</bz-badge>` : null}` },
      { key: "status", header: "Durum", width: 170, format: (v) => STATUS[v as string] ?? (v as string) },
      { key: "context", header: "Bağlam", width: 220 },
      { key: "ipAddress", header: "IP", width: 130 },
      { key: "userAgent", header: "Tarayıcı", width: 180, format: (v) => browser(v as string | null) },
      { key: "createdAt", header: "Giriş", sortable: true, width: 140, format: (v) => dateTime(v as string) },
      { key: "lastSeenAt", header: "Son etkinlik", sortable: true, width: 140, format: (v) => dateTime(v as string) },
      { key: "end", header: "", width: 120, align: "end", resizable: false, hideable: false, reorderable: false, format: (_, s) => (s.isCurrent ? null : html`<bz-button size="sm" variant="ghost" @click=${() => end(s)}>Sonlandır</bz-button>`) },
    ]
    return html`<div class="page">
      <div class="page-head"><h1>Oturumlar</h1><span class="spacer"></span>
        <bz-button @click=${sessions.reload}>${icon("refresh")} Yenile</bz-button></div>
      <p class="muted">Açık oturumlar. Giriş adımını tamamlamamış oturumlar 10 dakika sonra kendiliğinden kapanır.</p>
      ${loading(sessions, () => dataGrid({ label: "Oturumlar", persist: "sessions", fill: true, columns, rows: () => sessions.data() ?? [], empty: "Açık oturum yok." }))}
    </div>`
  },
})

export const settingsPage = definePage({
  title: "Güvenlik ayarları",
  setup() {
    const f = {
      passwordMinLength: signal(8),
      passwordRequireMixed: signal(true),
      passwordHistoryCount: signal(5),
      passwordExpireDays: signal(0),
      lockoutMaxFailed: signal(5),
      lockoutMinutes: signal(15),
      mfaRequiredForAll: signal(false),
      sessionIdleMinutes: signal(30),
      singleSession: signal(false),
    }
    const settings = loader(
      () => api.get<SecuritySettings>("/management/settings/security"),
      (s) => (Object.keys(f) as (keyof SecuritySettings)[]).forEach((k) => (f[k] as ReturnType<typeof signal<unknown>>).set(s[k])),
    )
    const busy = signal(false)
    const save = async (e: Event) => {
      e.preventDefault()
      busy.set(true)
      try {
        const body = Object.fromEntries(Object.entries(f).map(([k, s]) => [k, s()]))
        await api.put("/management/settings/security", body)
        toast.success("Ayarlar kaydedildi.")
      } catch (err) {
        toast.error(errorText(err))
      } finally {
        busy.set(false)
      }
    }
    return html`<div class="page">
      <div class="page-head"><h1>Güvenlik ayarları</h1></div>
      ${loading(settings, () => html`<form class="stack narrow" @submit=${save}>
        <bz-form-layout columns="2" min-column-width="14rem">
          <bz-form-section heading="Parola">
            ${numberField("En az uzunluk", f.passwordMinLength, { min: 6, max: 128 })}
            ${numberField("Geçmiş (tekrar kullanılamayan)", f.passwordHistoryCount, { min: 0, max: 24, hint: "0: kapalı" })}
            ${numberField("Geçerlilik süresi (gün)", f.passwordExpireDays, { min: 0, max: 3650, hint: "0: süresiz" })}
            <div data-span="full">${checkField("Büyük harf, küçük harf ve rakam zorunlu", f.passwordRequireMixed)}</div>
          </bz-form-section>
          <bz-form-section heading="Hesap kilidi">
            ${numberField("Hatalı deneme sınırı", f.lockoutMaxFailed, { min: 1, max: 100 })}
            ${numberField("Kilit süresi (dakika)", f.lockoutMinutes, { min: 1, max: 1440 })}
          </bz-form-section>
          <bz-form-section heading="Oturum ve doğrulama">
            ${numberField("Hareketsizlik zaman aşımı (dakika)", f.sessionIdleMinutes, { min: 5, max: 1440 })}
            <div data-span="full" class="stack">
              ${checkField("Herkes için iki adımlı doğrulama zorunlu", f.mfaRequiredForAll, "Kapalıyken yalnız 'MFA zorunlu' gruplarının üyeleri için zorunludur.")}
              ${checkField("Tek oturum", f.singleSession, "Yeni giriş, kullanıcının diğer oturumlarını kapatır.")}
            </div>
          </bz-form-section>
        </bz-form-layout>
        <div class="row"><bz-button type="submit" variant="primary" ?loading=${busy}>Kaydet</bz-button></div>
      </form>`)}
    </div>`
  },
})

const ACTIONS: Record<string, string> = {
  "login.success": "Giriş",
  "login.password": "Parola doğrulandı",
  "login.failed": "Hatalı giriş",
  "login.locked": "Kilitli hesaba giriş denemesi",
  "login.lockout": "Hesap kilitlendi",
  logout: "Çıkış",
  "password.change": "Parola değiştirildi",
  "mfa.enable": "MFA açıldı",
  "mfa.recovery-code": "Kurtarma kodu kullanıldı",
  setup: "İlk kurulum",
}
const VERBS: Record<string, string> = { create: "oluşturuldu", update: "güncellendi", delete: "silindi" }
const ENTITIES: Record<string, string> = {
  User: "Kullanıcı",
  Group: "Grup",
  GroupMember: "Grup üyeliği",
  GroupPermission: "Grup izni",
  UserOrgAccess: "Kurum yetkisi",
  Company: "Firma",
  Location: "Lokasyon",
  Plant: "Plant",
  Period: "Dönem",
}
const entityText = (e: string | null) => (e ? (ENTITIES[e] ?? e) : "")
const actionText = (a: string) => {
  if (ACTIONS[a]) return ACTIONS[a]
  const [entity, verb] = a.split(".")
  return verb && VERBS[verb] ? `${entityText(entity)} ${VERBS[verb]}` : a
}

export const auditPage = definePage({
  title: "Audit",
  setup() {
    const PAGE = 50
    const category = signal("")
    const query = signal("")
    const skip = signal(0)
    const result = signal<{ items: AuditRow[]; total: number } | null>(null)
    const error = signal("")
    const load = async () => {
      try {
        const p = new URLSearchParams({ skip: String(skip()), take: String(PAGE) })
        if (category()) p.set("category", category())
        if (query().trim()) p.set("q", query().trim())
        result.set(await api.get(`/management/audit?${p}`))
        error.set("")
      } catch (err) {
        error.set(errorText(err))
      }
    }
    void load()
    const search = (e?: Event) => {
      e?.preventDefault()
      skip.set(0)
      void load()
    }
    const page = (delta: number) => {
      skip.set(Math.max(0, skip() + delta * PAGE))
      void load()
    }
    const range = computed(() => {
      const r = result()
      if (!r || r.total === 0) return ""
      return `${skip() + 1}–${Math.min(skip() + PAGE, r.total)} / ${r.total}`
    })

    const show = (row: AuditRow) => {
      let data = row.data ?? ""
      try {
        data = JSON.stringify(JSON.parse(data), null, 2)
      } catch {
        /* not JSON */
      }
      void dialogs.open({
        heading: actionText(row.action),
        size: "lg",
        content: html`<div class="stack">
          <dl class="facts">
            <dt>Zaman</dt><dd>${dateTime(row.at)}</dd>
            <dt>Kullanıcı</dt><dd>${row.userName ?? "—"}</dd>
            <dt>Kayıt</dt><dd>${row.entityType ? `${entityText(row.entityType)} ${row.entityId ?? ""}` : "—"}</dd>
            <dt>IP</dt><dd>${row.ipAddress ?? "—"}</dd>
            <dt>İşlem kodu</dt><dd><code>${row.action}</code></dd>
          </dl>
          ${data ? html`<pre class="json">${data}</pre>` : null}
        </div>`,
      })
    }

    const columns: GridColumn<AuditRow>[] = [
      { key: "at", header: "Zaman", width: 150, format: (v) => dateTime(v as string) },
      { key: "category", header: "Tür", width: 100, format: (v) => (v === "security" ? html`<bz-badge variant="info">Güvenlik</bz-badge>` : html`<bz-badge variant="neutral">Veri</bz-badge>`) },
      { key: "action", header: "İşlem", width: 260, flex: true, format: (v) => actionText(v as string) },
      { key: "userName", header: "Kullanıcı", width: 140 },
      { key: "entityType", header: "Kayıt", width: 200, format: (v, r) => (v ? html`${entityText(v as string)} <span class="muted small">${(r.entityId ?? "").slice(0, 8)}</span>` : "") },
      { key: "ipAddress", header: "IP", width: 130 },
    ]

    return html`<div class="page">
      <div class="page-head"><h1>Audit</h1></div>
      <form class="row" @submit=${search}>
        <bz-combobox aria-label="Tür" .value=${category} @change=${(e: CustomEvent<{ value: string }>) => (category.set(e.detail.value), search())}>
          <bz-option value="">Tümü</bz-option><bz-option value="security">Güvenlik</bz-option><bz-option value="data">Veri</bz-option>
        </bz-combobox>
        <bz-input placeholder="İşlem, kullanıcı veya kayıt ara…" aria-label="Ara" .value=${query} @input=${(e: Event) => query.set((e.currentTarget as HTMLInputElement).value)}>
          <span slot="prefix">${icon("search")}</span>
        </bz-input>
        <bz-button type="submit">Ara</bz-button>
        <span class="spacer"></span>
        <span class="muted small">${range}</span>
        <bz-button size="sm" variant="ghost" aria-label="Önceki sayfa" ?disabled=${() => skip() === 0} @click=${() => page(-1)}>${icon("chevron-left")}</bz-button>
        <bz-button size="sm" variant="ghost" aria-label="Sonraki sayfa" ?disabled=${() => !result() || skip() + PAGE >= result()!.total} @click=${() => page(1)}>${icon("chevron-right")}</bz-button>
      </form>
      ${loading({ data: result, error }, () => dataGrid({ label: "Audit kayıtları", persist: "audit", fill: true, columns, rows: () => result()!.items, onOpen: show }))}
    </div>`
  },
})
