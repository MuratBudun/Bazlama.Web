import { computed, html, signal, type Signal } from "@bazlama/core"
import { icon, toast, type GridColumn } from "@bazlama/headless"
import { definePage } from "@bazlama/router"
import { api, errorText } from "../api"
import { orgNames, type CompanyNode, type GroupRow, type MemberRow, type PermissionInfo, type UserRow } from "./types"
import { checkField, confirmAction, dataGrid, formDialog, loader, loading, textField } from "./ui"

const COLUMNS: GridColumn<GroupRow>[] = [
  { key: "name", header: "Grup", sortable: true, width: 260, format: (v, g) => html`<strong>${v as string}</strong> <span class="muted small">${g.code}</span>` },
  { key: "description", header: "Açıklama", width: 280, flex: true },
  { key: "memberCount", header: "Üye", align: "end", sortable: true, width: 90 },
  { key: "permissions", header: "İzin", align: "end", width: 90, format: (v) => ((v as string[]).includes("*") ? "Tümü" : (v as string[]).length) },
  { key: "flags", header: "Özellik", width: 200, format: (_, g) => html`<span class="row nowrap">
    ${g.requireMfa ? html`<bz-badge variant="info">MFA zorunlu</bz-badge>` : null}
    ${g.isSystem ? html`<bz-badge variant="neutral">Sistem</bz-badge>` : null}</span>` },
]

function groupForm(f: { code: Signal<string>; name: Signal<string>; description: Signal<string>; requireMfa: Signal<boolean> }, system = false) {
  return html`<bz-form-layout columns="2" min-column-width="12rem">
    ${textField("Kod", f.code, { required: true, disabled: system, hint: system ? "Sistem grubunun kodu değişmez." : "" })}
    ${textField("Ad", f.name, { required: true })}
    ${textField("Açıklama", f.description, { span: true })}
    <div data-span="full">${checkField("Üyeleri iki adımlı doğrulama kullanmalı", f.requireMfa)}</div>
  </bz-form-layout>`
}

export const groupsPage = definePage({
  title: "Gruplar",
  setup(ctx) {
    const groups = loader(() => api.get<GroupRow[]>("/management/groups"))

    const create = async () => {
      const f = { code: signal(""), name: signal(""), description: signal(""), requireMfa: signal(false) }
      let id = ""
      const ok = await formDialog({
        heading: "Yeni grup",
        submitText: "Oluştur",
        body: () => groupForm(f),
        submit: async () => {
          id = (await api.post<{ id: string }>("/management/groups", { code: f.code(), name: f.name(), description: f.description() || null, requireMfa: f.requireMfa() })).id
        },
      })
      if (ok) void ctx.navigate(`/management/groups/${id}`)
    }

    return html`<div class="page">
      <div class="page-head">
        <h1>Gruplar</h1><span class="spacer"></span>
        <bz-button variant="primary" @click=${create}>${icon("plus")} Yeni grup</bz-button>
      </div>
      <p class="muted">Gruplar rol yerine geçer: izinler gruplara verilir, kullanıcılar gruplara eklenir.</p>
      ${loading(groups, () => dataGrid({
        label: "Gruplar",
        persist: "groups",
        fill: true,
        columns: COLUMNS,
        rows: () => groups.data() ?? [],
        onOpen: (g) => void ctx.navigate(`/management/groups/${g.id}`),
      }))}
    </div>`
  },
})

export const groupPage = definePage({
  title: "Grup",
  setup(ctx) {
    const id = ctx.params().id
    const tab = signal("general")
    const f = { code: signal(""), name: signal(""), description: signal(""), requireMfa: signal(false) }
    const granted = signal<Set<string>>(new Set())
    const groups = loader(
      () => api.get<GroupRow[]>("/management/groups"),
      (list) => {
        const g = list.find((x) => x.id === id)
        if (!g) return
        f.code.set(g.code)
        f.name.set(g.name)
        f.description.set(g.description ?? "")
        f.requireMfa.set(g.requireMfa)
        granted.set(new Set(g.permissions))
      },
    )
    const group = computed(() => groups.data()?.find((g) => g.id === id) ?? null)
    const catalog = loader(() => api.get<PermissionInfo[]>("/management/groups/permissions"))
    const members = loader(() => api.get<MemberRow[]>(`/management/groups/${id}/members`))
    const users = loader(() => api.get<UserRow[]>("/management/users").catch(() => [] as UserRow[]))
    const org = loader(() => api.get<CompanyNode[]>("/management/organization").catch(() => [] as CompanyNode[]))

    const run = async (action: () => Promise<unknown>, done: string) => {
      try {
        await action()
        toast.success(done)
      } catch (err) {
        toast.error(errorText(err))
      }
    }
    const saveGeneral = (e: Event) => {
      e.preventDefault()
      void run(
        () => api.put(`/management/groups/${id}`, { code: f.code(), name: f.name(), description: f.description() || null, requireMfa: f.requireMfa() }).then(groups.reload),
        "Kaydedildi.",
      )
    }
    const savePermissions = () => run(() => api.put(`/management/groups/${id}/permissions`, [...granted()]).then(groups.reload), "İzinler kaydedildi.")
    const toggle = (key: string, on: boolean) => granted.update((s) => {
      const next = new Set(s)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
    const saveMembers = (items: { userId: string; locationId: string | null }[]) =>
      api.put(`/management/groups/${id}/members`, items).then(() => Promise.all([members.reload(), groups.reload()]))

    const addMember = () => {
      const userId = signal("")
      const locationId = signal("")
      const names = orgNames(org.data() ?? [])
      return formDialog({
        heading: "Üye ekle",
        submitText: "Ekle",
        body: () => html`<bz-combobox label="Kullanıcı" required .value=${userId} @change=${(e: CustomEvent<{ value: string }>) => userId.set(e.detail.value)}>
            ${(users.data() ?? []).map((u) => html`<bz-option value=${u.id}>${u.displayName} (${u.userName})</bz-option>`)}
          </bz-combobox>
          <bz-combobox label="Geçerli olduğu lokasyon" .value=${locationId} @change=${(e: CustomEvent<{ value: string }>) => locationId.set(e.detail.value)}>
            <bz-option value="">Tüm lokasyonlar</bz-option>
            ${names.locations.map((l) => html`<bz-option value=${l.id}>${l.label}</bz-option>`)}
          </bz-combobox>`,
        submit: () => saveMembers([...(members.data() ?? []).map((m) => ({ userId: m.userId, locationId: m.locationId })), { userId: userId(), locationId: locationId() || null }]),
      })
    }

    const remove = () =>
      confirmAction({
        heading: "Grubu sil",
        message: `${group()!.name} grubu silinsin mi? Üyelikler ve izinler de silinir.`,
        confirmText: "Sil",
        danger: true,
        action: () => api.delete(`/management/groups/${id}`),
        done: "Grup silindi.",
      }).then((ok) => ok && ctx.navigate("/management/groups"))

    const body = () => {
      const g = group()
      if (!g) return html`<bz-alert variant="danger" heading="Grup bulunamadı"></bz-alert>`
      const names = orgNames(org.data() ?? [])
      const all = () => granted().has("*")
      return html`<div class="page-head">
          <bz-button variant="ghost" size="sm" aria-label="Gruplara dön" @click=${() => void ctx.navigate("/management/groups")}>${icon("arrow-left")}</bz-button>
          <h1>${g.name}</h1><span class="muted">${g.code}</span>
          <span class="spacer"></span>
          ${g.isSystem ? null : html`<bz-button variant="danger" @click=${remove}>${icon("trash")} Sil</bz-button>`}
        </div>
        <bz-tabs .value=${tab} @change.self=${(e: CustomEvent<{ value: string }>) => tab.set(e.detail.value)}>
          <bz-tab-list label="Grup">
            <bz-tab value="general">Genel</bz-tab>
            <bz-tab value="permissions">İzinler</bz-tab>
            <bz-tab value="members">Üyeler (${g.memberCount})</bz-tab>
          </bz-tab-list>
          <bz-tab-panel value="general">
            <form class="stack narrow" @submit=${saveGeneral}>
              ${groupForm(f, g.isSystem)}
              <div class="row"><bz-button type="submit" variant="primary">Kaydet</bz-button></div>
            </form>
          </bz-tab-panel>
          <bz-tab-panel value="permissions">
            <div class="stack narrow">
              ${loading(catalog, () => html`<div class="checks">
                ${catalog.data()!.map((p) => html`<bz-checkbox label=${p.title} hint=${p.key}
                  ?disabled=${() => (p.key === "*" ? g.isSystem : all())}
                  .checked=${() => granted().has(p.key) || (p.key !== "*" && all())}
                  @change=${(e: CustomEvent<{ checked: boolean }>) => toggle(p.key, e.detail.checked)}></bz-checkbox>`)}
              </div>`)}
              ${g.isSystem ? html`<p class="muted small">Yöneticiler grubu her zaman tüm yetkilere sahiptir.</p>` : null}
              <div class="row"><bz-button variant="primary" @click=${savePermissions}>İzinleri kaydet</bz-button></div>
            </div>
          </bz-tab-panel>
          <bz-tab-panel value="members">
            <div class="stack">
              <div class="row"><span class="spacer"></span><bz-button @click=${addMember}>${icon("plus")} Üye ekle</bz-button></div>
              ${loading(members, () => dataGrid<MemberRow & { id: string }>({
                label: "Üyeler",
                persist: "group-members",
                columns: [
                  { key: "displayName", header: "Ad soyad", sortable: true, width: 220, flex: true },
                  { key: "userName", header: "Kullanıcı adı", sortable: true, width: 180 },
                  { key: "locationId", header: "Lokasyon", width: 240, format: (v) => names.location(v as string | null) },
                  { key: "remove", header: "", width: 64, align: "end", resizable: false, hideable: false, reorderable: false, format: (_, m) => html`<bz-button size="sm" variant="ghost" aria-label="Gruptan çıkar"
                    @click=${() => confirmAction({ heading: "Gruptan çıkar", message: `${m.displayName} gruptan çıkarılsın mı?`, confirmText: "Çıkar", danger: true,
                      action: () => saveMembers(members.data()!.filter((x) => x.userId !== m.userId || x.locationId !== m.locationId).map((x) => ({ userId: x.userId, locationId: x.locationId }))) })}>${icon("x")}</bz-button>` },
                ],
                rows: () => members.data()!.map((m) => ({ ...m, id: `${m.userId}:${m.locationId}` })),
                onOpen: (m) => void ctx.navigate(`/management/users/${m.userId}`),
                empty: "Üye yok.",
              }))}
            </div>
          </bz-tab-panel>
        </bz-tabs>`
    }

    return html`<div class="page">${loading(groups, body)}</div>`
  },
})
