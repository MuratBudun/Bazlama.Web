import { html, signal } from "@bazlama/core"
import { icon } from "@bazlama/headless"
import { definePage } from "@bazlama/router"
import { api } from "../api"
import { refreshMe } from "../session"
import type { CompanyNode, LocationNode, PeriodNode, PlantNode } from "./types"
import { checkField, confirmAction, dataGrid, dateOnly, formDialog, loader, loading, textField } from "./ui"

/*
 * Company → location → plant (three fixed levels) and each company's periods. Everything is
 * edited in dialogs; a record in use (sub records, user access) cannot be deleted, it can be
 * made inactive.
 */

export const organizationPage = definePage({
  title: "Organizasyon",
  setup() {
    const org = loader(() => api.get<CompanyNode[]>("/management/organization"))
    // Names in the header context may have changed.
    const reload = () => Promise.all([org.reload(), refreshMe()])

    const codeName = (heading: string, current: { code?: string; name?: string; isActive?: boolean } | null, save: (v: { code: string; name: string; isActive: boolean }) => Promise<unknown>, extra?: () => unknown) => {
      const code = signal(current?.code ?? "")
      const name = signal(current?.name ?? "")
      const active = signal(current?.isActive ?? true)
      return formDialog({
        heading,
        submitText: current ? "Kaydet" : "Ekle",
        body: () => html`<bz-form-layout columns="2" min-column-width="10rem">
          ${textField("Kod", code, { required: true })} ${textField("Ad", name, { required: true })}
          ${extra?.() ?? null}
          <div data-span="full">${checkField("Etkin", active)}</div>
        </bz-form-layout>`,
        submit: () => save({ code: code(), name: name(), isActive: active() }),
      }).then(async (ok) => { if (ok) await reload() })
    }

    const editCompany = (c: CompanyNode | null) =>
      codeName(c ? "Firmayı düzenle" : "Yeni firma", c, (v) => (c ? api.put(`/management/organization/companies/${c.id}`, v) : api.post("/management/organization/companies", v)))

    const editLocation = (companyId: string, l: LocationNode | null) => {
      const timeZone = signal(l?.timeZone ?? "")
      return codeName(
        l ? "Lokasyonu düzenle" : "Yeni lokasyon",
        l,
        (v) => {
          const body = { ...v, companyId, timeZone: timeZone() || null }
          return l ? api.put(`/management/organization/locations/${l.id}`, body) : api.post("/management/organization/locations", body)
        },
        () => textField("Saat dilimi", timeZone, { span: true, hint: "Örn. Europe/Istanbul. Boş: sunucunun saat dilimi." }),
      )
    }

    const editPlant = (locationId: string, p: PlantNode | null) =>
      codeName(p ? "Plant'ı düzenle" : "Yeni plant", p, (v) => {
        const body = { ...v, locationId }
        return p ? api.put(`/management/organization/plants/${p.id}`, body) : api.post("/management/organization/plants", body)
      })

    const editPeriod = (companyId: string, p: PeriodNode | null) => {
      const year = new Date().getFullYear() + 1
      const f = {
        code: signal(p?.code ?? String(year)),
        name: signal(p?.name ?? String(year)),
        start: signal(p?.startDate ?? `${year}-01-01`),
        end: signal(p?.endDate ?? `${year}-12-31`),
        closed: signal(p?.isClosed ?? false),
      }
      return formDialog({
        heading: p ? "Dönemi düzenle" : "Yeni dönem",
        submitText: p ? "Kaydet" : "Ekle",
        body: () => html`<bz-form-layout columns="2" min-column-width="10rem">
          ${textField("Kod", f.code, { required: true })} ${textField("Ad", f.name, { required: true })}
          ${textField("Başlangıç", f.start, { type: "date", required: true })} ${textField("Bitiş", f.end, { type: "date", required: true })}
          <div data-span="full">${checkField("Kapalı (salt okunur)", f.closed)}</div>
        </bz-form-layout>`,
        submit: () => {
          const body = { companyId, code: f.code(), name: f.name(), startDate: f.start(), endDate: f.end(), isClosed: f.closed() }
          return p ? api.put(`/management/organization/periods/${p.id}`, body) : api.post("/management/organization/periods", body)
        },
      }).then(async (ok) => { if (ok) await reload() })
    }

    const remove = (what: string, name: string, path: string) =>
      confirmAction({ heading: `${what} sil`, message: `${name} silinsin mi?`, confirmText: "Sil", danger: true, action: () => api.delete(path).then(reload), done: `${name} silindi.` })

    const inactive = (on: boolean) => (on ? null : html`<bz-badge variant="neutral">Pasif</bz-badge>`)

    const location = (c: CompanyNode, l: LocationNode) => html`<li class="org-location">
      <div class="row">
        ${icon("building", { size: 16 })}<strong>${l.name}</strong><span class="muted small">${l.code}</span>
        ${l.timeZone ? html`<span class="muted small">${l.timeZone}</span>` : null}${inactive(l.isActive)}
        <span class="spacer"></span>
        <bz-button size="sm" variant="ghost" @click=${() => editPlant(l.id, null)}>${icon("plus")} Plant</bz-button>
        <bz-button size="sm" variant="ghost" aria-label="Lokasyonu düzenle" @click=${() => editLocation(c.id, l)}>${icon("edit")}</bz-button>
        <bz-button size="sm" variant="ghost" aria-label="Lokasyonu sil" @click=${() => remove("Lokasyonu", l.name, `/management/organization/locations/${l.id}`)}>${icon("trash")}</bz-button>
      </div>
      ${l.plants.length
        ? html`<div class="row chips">${l.plants.map(
            (p) => html`<bz-chip removable @click=${() => editPlant(l.id, p)}
              @remove=${(e: Event) => (e.preventDefault(), remove("Plant'ı", p.name, `/management/organization/plants/${p.id}`))}>${p.name}${p.isActive ? "" : " (pasif)"}</bz-chip>`,
          )}</div>`
        : null}
    </li>`

    const company = (c: CompanyNode) => html`<bz-panel>
      <div slot="header" class="row grow">
        <strong>${c.name}</strong><span class="muted small">${c.code}</span>${inactive(c.isActive)}
      </div>
      <div slot="actions" class="row">
        <bz-button size="sm" variant="ghost" aria-label="Firmayı düzenle" @click=${() => editCompany(c)}>${icon("edit")}</bz-button>
        <bz-button size="sm" variant="ghost" aria-label="Firmayı sil" @click=${() => remove("Firmayı", c.name, `/management/organization/companies/${c.id}`)}>${icon("trash")}</bz-button>
      </div>
      <div class="org-company">
        <section class="stack">
          <div class="row"><h2>Lokasyonlar ve plantler</h2><span class="spacer"></span>
            <bz-button size="sm" @click=${() => editLocation(c.id, null)}>${icon("plus")} Lokasyon</bz-button></div>
          ${c.locations.length ? html`<ul class="org-locations">${c.locations.map((l) => location(c, l))}</ul>` : html`<p class="muted">Lokasyon yok.</p>`}
        </section>
        <section class="stack">
          <div class="row"><h2>Dönemler</h2><span class="spacer"></span>
            <bz-button size="sm" @click=${() => editPeriod(c.id, null)}>${icon("plus")} Dönem</bz-button></div>
          ${dataGrid<PeriodNode>({
            label: "Dönemler",
            persist: "periods",
            columns: [
              { key: "name", header: "Dönem", width: 140, flex: true },
              { key: "startDate", header: "Başlangıç", width: 120, sortable: true, format: (v) => dateOnly(v as string) },
              { key: "endDate", header: "Bitiş", width: 120, format: (v) => dateOnly(v as string) },
              { key: "isClosed", header: "Durum", width: 100, format: (v) => (v ? html`<bz-badge variant="neutral">Kapalı</bz-badge>` : html`<bz-badge variant="success">Açık</bz-badge>`) },
              { key: "remove", header: "", width: 64, align: "end", resizable: false, hideable: false, reorderable: false, format: (_, p) => html`<bz-button size="sm" variant="ghost" aria-label="Dönemi sil"
                @click=${() => remove("Dönemi", p.name, `/management/organization/periods/${p.id}`)}>${icon("trash")}</bz-button>` },
            ],
            rows: c.periods,
            onOpen: (p) => void editPeriod(c.id, p),
            empty: "Dönem yok.",
          })}
        </section>
      </div>
    </bz-panel>`

    return html`<div class="page">
      <div class="page-head">
        <h1>Organizasyon</h1><span class="spacer"></span>
        <bz-button variant="primary" @click=${() => editCompany(null)}>${icon("plus")} Yeni firma</bz-button>
      </div>
      <p class="muted">Firma → lokasyon → plant. Dönemler firmaya bağlıdır ve birbiriyle çakışamaz. Kullanılan bir kayıt silinemez; pasif yapılabilir.</p>
      ${loading(org, () => html`<div class="stack">${org.data()!.map(company)}</div>`)}
    </div>`
  },
})
