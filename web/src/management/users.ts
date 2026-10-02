import { computed, html, signal } from "@bazlama/core"
import { icon, toast, type GridColumn } from "@bazlama/headless"
import { definePage } from "@bazlama/router"
import { api } from "../api"
import { me } from "../session"
import { orgNames, type Access, type CompanyNode, type GroupRow, type Membership, type UserDetail, type UserRow } from "./types"
import { checkField, confirmAction, dataGrid, dateTime, formDialog, loader, loading, passwordField, textField } from "./ui"

const badges = (u: UserRow) => html`<span class="row nowrap">
  ${u.isActive ? null : html`<bz-badge variant="neutral">Pasif</bz-badge>`}
  ${u.lockoutEndsAt ? html`<bz-badge variant="danger">Kilitli</bz-badge>` : null}
  ${u.mfaEnabled ? html`<bz-badge variant="success">MFA</bz-badge>` : null}
  ${u.mustChangePassword ? html`<bz-badge variant="warning">Parola değişecek</bz-badge>` : null}
</span>`

const COLUMNS: GridColumn<UserRow>[] = [
  { key: "userName", header: "Kullanıcı adı", sortable: true, width: 160 },
  { key: "displayName", header: "Ad soyad", sortable: true, width: 200 },
  { key: "email", header: "E-posta", sortable: true, width: 220 },
  { key: "groups", header: "Gruplar", width: 220, flex: true, format: (v) => (v as string[]).join(", ") },
  { key: "status", header: "Durum", width: 200, format: (_, u) => badges(u) },
  { key: "lastLoginAt", header: "Son giriş", sortable: true, width: 150, format: (v) => dateTime(v as string | null) },
]

export const usersPage = definePage({
  title: "Kullanıcılar",
  setup(ctx) {
    const users = loader(() => api.get<UserRow[]>("/management/users"))
    const query = signal("")
    const rows = computed(() => {
      const q = query().toLocaleLowerCase("tr-TR").trim()
      return (users.data() ?? []).filter((u) => !q || [u.userName, u.displayName, u.email ?? ""].some((v) => v.toLocaleLowerCase("tr-TR").includes(q)))
    })

    const create = async () => {
      const f = { userName: signal(""), displayName: signal(""), email: signal(""), password: signal(""), mustChange: signal(true) }
      let id = ""
      const ok = await formDialog({
        heading: "Yeni kullanıcı",
        submitText: "Oluştur",
        body: () => html`<bz-form-layout columns="2" min-column-width="12rem">
          ${textField("Kullanıcı adı", f.userName, { required: true })} ${textField("Ad soyad", f.displayName, { required: true })}
          ${textField("E-posta", f.email, { type: "email", span: true })}
          ${passwordField("İlk parola", f.password)}
          <div data-span="full">${checkField("İlk girişte parolasını değiştirsin", f.mustChange)}</div>
        </bz-form-layout>`,
        submit: async () => {
          const res = await api.post<{ id: string }>("/management/users", {
            userName: f.userName(),
            displayName: f.displayName(),
            email: f.email() || null,
            password: f.password(),
            mustChangePassword: f.mustChange(),
          })
          id = res.id
        },
      })
      if (ok) {
        toast.success("Kullanıcı oluşturuldu. Gruplarını ve kurum yetkilerini verin.")
        void ctx.navigate(`/management/users/${id}`)
      }
    }

    return html`<div class="page">
      <div class="page-head">
        <h1>Kullanıcılar</h1><span class="spacer"></span>
        <bz-button variant="primary" @click=${create}>${icon("plus")} Yeni kullanıcı</bz-button>
      </div>
      <bz-toolbar label="Kullanıcı listesi">
        <bz-input placeholder="Ara…" aria-label="Kullanıcı ara" .value=${query} @input=${(e: Event) => query.set((e.currentTarget as HTMLInputElement).value)}>
          <span slot="prefix">${icon("search")}</span>
        </bz-input>
        <bz-toolbar-spacer></bz-toolbar-spacer>
        <bz-data-grid-columns for="users-grid">Sütunlar</bz-data-grid-columns>
      </bz-toolbar>
      ${loading(users, () => dataGrid({
        id: "users-grid",
        label: "Kullanıcılar",
        persist: "users",
        fill: true,
        columns: COLUMNS,
        rows,
        onOpen: (u) => void ctx.navigate(`/management/users/${u.id}`),
        empty: "Aramanızla eşleşen kullanıcı yok.",
      }))}
    </div>`
  },
})

export const userPage = definePage({
  title: "Kullanıcı",
  setup(ctx) {
    const id = ctx.params().id
    const f = { displayName: signal(""), email: signal(""), isActive: signal(true) }
    const tab = signal("general")
    const detail = loader(
      () => api.get<UserDetail>(`/management/users/${id}`),
      (d) => {
        f.displayName.set(d.user.displayName)
        f.email.set(d.user.email ?? "")
        f.isActive.set(d.user.isActive)
      },
    )
    const org = loader(() => api.get<CompanyNode[]>("/management/organization"))
    const groups = loader(() => api.get<GroupRow[]>("/management/groups"))
    const isMe = () => me()?.user?.id === id

    const saveGeneral = async (e: Event) => {
      e.preventDefault()
      try {
        await api.put(`/management/users/${id}`, { displayName: f.displayName(), email: f.email() || null, isActive: f.isActive() })
        toast.success("Kaydedildi.")
        await detail.reload()
      } catch (err) {
        toast.error((err as Error).message)
      }
    }

    const resetPassword = () => {
      const password = signal("")
      const mustChange = signal(true)
      return formDialog({
        heading: "Parola sıfırla",
        submitText: "Sıfırla",
        body: () => html`<p class="muted">Kullanıcının açık oturumları kapatılır.</p>
          ${passwordField("Yeni parola", password)} ${checkField("Girişte parolasını değiştirsin", mustChange)}`,
        submit: () => api.post(`/management/users/${id}/password`, { password: password(), mustChangePassword: mustChange() }),
      }).then(async (ok) => { if (ok) { toast.success("Parola sıfırlandı."); await detail.reload() } })
    }

    const saveGroups = (items: Membership[]) => api.put(`/management/users/${id}/groups`, items).then(detail.reload)
    const saveAccess = (items: Access[]) => api.put(`/management/users/${id}/access`, items).then(detail.reload)

    const addGroup = () => {
      const groupId = signal(groups.data()?.[0]?.id ?? "")
      const locationId = signal("")
      const names = orgNames(org.data() ?? [])
      return formDialog({
        heading: "Gruba ekle",
        submitText: "Ekle",
        body: () => html`<bz-combobox label="Grup" required .value=${groupId} @change=${(e: CustomEvent<{ value: string }>) => groupId.set(e.detail.value)}>
            ${(groups.data() ?? []).map((g) => html`<bz-option value=${g.id}>${g.name}</bz-option>`)}
          </bz-combobox>
          <bz-combobox label="Geçerli olduğu lokasyon" .value=${locationId} @change=${(e: CustomEvent<{ value: string }>) => locationId.set(e.detail.value)}>
            <bz-option value="">Tüm lokasyonlar</bz-option>
            ${names.locations.map((l) => html`<bz-option value=${l.id}>${l.label}</bz-option>`)}
          </bz-combobox>`,
        submit: () => saveGroups([...(detail.data()?.groups ?? []), { groupId: groupId(), locationId: locationId() || null }]),
      })
    }

    const addAccess = () => {
      const companies = org.data() ?? []
      const companyId = signal(companies[0]?.id ?? "")
      const locationId = signal("")
      const plantId = signal("")
      const company = computed(() => companies.find((c) => c.id === companyId()))
      const location = computed(() => company()?.locations.find((l) => l.id === locationId()))
      return formDialog({
        heading: "Kurum yetkisi ver",
        submitText: "Ekle",
        body: () => html`<p class="muted">Boş bırakılan seviye "tümü" demektir: yalnız firma seçmek, firmanın bütün lokasyon ve plantlerine yetki verir.</p>
          <bz-combobox label="Firma" required .value=${companyId} @change=${(e: CustomEvent<{ value: string }>) => (companyId.set(e.detail.value), locationId.set(""), plantId.set(""))}>
            ${companies.map((c) => html`<bz-option value=${c.id}>${c.name}</bz-option>`)}
          </bz-combobox>
          ${() => html`<bz-combobox label="Lokasyon" .value=${locationId} @change=${(e: CustomEvent<{ value: string }>) => (locationId.set(e.detail.value), plantId.set(""))}>
            <bz-option value="">Tüm lokasyonlar</bz-option>
            ${(company()?.locations ?? []).map((l) => html`<bz-option value=${l.id}>${l.name}</bz-option>`)}
          </bz-combobox>`}
          ${() => (location()?.plants.length
            ? html`<bz-combobox label="Plant" .value=${plantId} @change=${(e: CustomEvent<{ value: string }>) => plantId.set(e.detail.value)}>
                <bz-option value="">Tüm plantler</bz-option>
                ${location()!.plants.map((p) => html`<bz-option value=${p.id}>${p.name}</bz-option>`)}
              </bz-combobox>`
            : null)}`,
        submit: () => saveAccess([...(detail.data()?.access ?? []), { companyId: companyId(), locationId: locationId() || null, plantId: plantId() || null }]),
      })
    }

    const body = () => {
      const d = detail.data()!
      const u = d.user
      const names = orgNames(org.data() ?? [])
      const groupName = (gid: string) => groups.data()?.find((g) => g.id === gid)?.name ?? "?"

      return html`<div class="page-head">
          <bz-button variant="ghost" size="sm" aria-label="Kullanıcılara dön" @click=${() => void ctx.navigate("/management/users")}>${icon("arrow-left")}</bz-button>
          <h1>${u.displayName}</h1><span class="muted">${u.userName}</span>${badges(u)}
          <span class="spacer"></span>
          ${u.lockoutEndsAt
            ? html`<bz-button @click=${() => confirmAction({ heading: "Kilidi aç", message: `${u.displayName} hesabının kilidi açılsın mı?`, confirmText: "Kilidi aç", action: () => api.post(`/management/users/${id}/unlock`).then(detail.reload), done: "Kilit açıldı." })}>${icon("lock")} Kilidi aç</bz-button>`
            : null}
          ${u.mfaEnabled
            ? html`<bz-button @click=${() => confirmAction({ heading: "İki adımlı doğrulamayı sıfırla", message: "Kullanıcı bir sonraki girişte doğrulama uygulamasını yeniden kuracak (zorunluysa). Kurtarma kodları silinir, açık oturumları kapanır.", confirmText: "Sıfırla", danger: true, action: () => api.post(`/management/users/${id}/reset-mfa`).then(detail.reload), done: "İki adımlı doğrulama sıfırlandı." })}>${icon("shield")} MFA sıfırla</bz-button>`
            : null}
          <bz-button @click=${resetPassword}>${icon("refresh")} Parola sıfırla</bz-button>
        </div>
        <bz-tabs .value=${tab} @change.self=${(e: CustomEvent<{ value: string }>) => tab.set(e.detail.value)}>
          <bz-tab-list label="Kullanıcı">
            <bz-tab value="general">Genel</bz-tab>
            <bz-tab value="groups">Gruplar (${d.groups.length})</bz-tab>
            <bz-tab value="access">Kurum yetkileri (${d.access.length})</bz-tab>
          </bz-tab-list>
          <bz-tab-panel value="general">
            <form class="stack narrow" @submit=${saveGeneral}>
              <bz-form-layout columns="2" min-column-width="12rem">
                ${textField("Ad soyad", f.displayName, { required: true })} ${textField("E-posta", f.email, { type: "email" })}
                <div data-span="full">${checkField("Etkin", f.isActive, isMe() ? "Kendi hesabınızı pasif yapamazsınız." : "Pasif kullanıcı giriş yapamaz; açık oturumları kapanır.")}</div>
              </bz-form-layout>
              <dl class="facts">
                <dt>Oluşturulma</dt><dd>${dateTime(u.createdAt)}</dd>
                <dt>Son giriş</dt><dd>${dateTime(u.lastLoginAt) || "—"}</dd>
              </dl>
              <div class="row"><bz-button type="submit" variant="primary">Kaydet</bz-button></div>
            </form>
          </bz-tab-panel>
          <bz-tab-panel value="groups">
            <div class="stack">
              <div class="row"><span class="muted">İzinler gruplardan gelir. Lokasyona bağlı üyelik yalnız o lokasyon seçiliyken geçerlidir.</span><span class="spacer"></span>
                <bz-button @click=${addGroup}>${icon("plus")} Gruba ekle</bz-button></div>
              ${dataGrid<Membership & { id: string }>({
                label: "Gruplar",
                persist: "user-groups",
                columns: [
                  { key: "group", header: "Grup", width: 240, flex: true, format: (_, m) => groupName(m.groupId) },
                  { key: "location", header: "Lokasyon", width: 260, format: (_, m) => names.location(m.locationId) },
                  { key: "remove", header: "", width: 64, align: "end", resizable: false, hideable: false, reorderable: false, format: (_, m) => html`<bz-button size="sm" variant="ghost" aria-label="Gruptan çıkar"
                    @click=${() => confirmAction({ heading: "Gruptan çıkar", message: `${groupName(m.groupId)} grubundan çıkarılsın mı?`, confirmText: "Çıkar", danger: true, action: () => saveGroups(d.groups.filter((x) => x.groupId !== m.groupId || x.locationId !== m.locationId)) })}>${icon("x")}</bz-button>` },
                ],
                rows: d.groups.map((m) => ({ ...m, id: `${m.groupId}:${m.locationId}` })),
                empty: "Hiçbir grupta değil.",
              })}
            </div>
          </bz-tab-panel>
          <bz-tab-panel value="access">
            <div class="stack">
              <div class="row"><span class="muted">Kullanıcı yalnız yetkili olduğu firma, lokasyon ve plantleri bağlam olarak seçebilir.</span><span class="spacer"></span>
                <bz-button @click=${addAccess}>${icon("plus")} Yetki ekle</bz-button></div>
              ${dataGrid<Access & { id: string }>({
                label: "Kurum yetkileri",
                persist: "user-access",
                columns: [
                  { key: "company", header: "Firma", width: 220, flex: true, format: (_, a) => names.company(a.companyId) },
                  { key: "location", header: "Lokasyon", width: 200, format: (_, a) => names.location(a.locationId) },
                  { key: "plant", header: "Plant", width: 200, format: (_, a) => names.plant(a.plantId) },
                  { key: "remove", header: "", width: 64, align: "end", resizable: false, hideable: false, reorderable: false, format: (_, a) => html`<bz-button size="sm" variant="ghost" aria-label="Yetkiyi kaldır"
                    @click=${() => confirmAction({ heading: "Yetkiyi kaldır", message: "Bu kurum yetkisi kaldırılsın mı?", confirmText: "Kaldır", danger: true, action: () => saveAccess(d.access.filter((x) => `${x.companyId}:${x.locationId}:${x.plantId}` !== a.id)) })}>${icon("x")}</bz-button>` },
                ],
                rows: d.access.map((a) => ({ ...a, id: `${a.companyId}:${a.locationId}:${a.plantId}` })),
                empty: "Kurum yetkisi yok: kullanıcı giriş yapınca bağlam seçemez.",
              })}
            </div>
          </bz-tab-panel>
        </bz-tabs>`
    }

    return html`<div class="page">${loading({ data: () => (detail.data() && org.data() && groups.data()) || null, error: () => detail.error() || org.error() || groups.error() }, body)}</div>`
  },
})
