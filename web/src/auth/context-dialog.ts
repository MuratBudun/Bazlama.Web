import { computed, html, signal } from "@bazlama/core"
import { dialogs, toast } from "@bazlama/headless"
import { api, errorText } from "../api"
import { me, type CompanyOption, type Me } from "../session"

/**
 * The organization context: company → location → (plant) and (period). Required ones are
 * company and location. `required`: the dialog cannot be dismissed (no context yet).
 */
export async function chooseContext(required = false) {
  let options: CompanyOption[]
  try {
    options = await api.get<CompanyOption[]>("/auth/context/options")
  } catch (e) {
    toast.error(errorText(e))
    return
  }
  if (options.length === 0) {
    await dialogs.alert({ heading: "Kurum yetkisi yok", message: "Hesabınıza bir firma veya lokasyon atanmamış. Yöneticinize başvurun." })
    return
  }

  const current = me()?.context
  const company = signal(current?.company?.id ?? options[0].id)
  const location = signal(current?.location?.id ?? "")
  const plant = signal(current?.plant?.id ?? "")
  const period = signal(current?.period?.id ?? "")
  const error = signal("")
  const busy = signal(false)

  const companyOption = computed(() => options.find((c) => c.id === company()))
  const locationOption = computed(() => companyOption()?.locations.find((l) => l.id === location()))
  if (!locationOption()) location.set(companyOption()?.locations[0]?.id ?? "")

  const pick = (s: typeof company) => (e: CustomEvent<{ value: string }>) => s.set(e.detail.value)

  await dialogs.open({
    heading: "Çalışma bağlamı",
    persistent: required,
    hideClose: required,
    content: (ref) => html`<form id="context-form" class="stack" @submit=${async (e: Event) => {
      e.preventDefault()
      busy.set(true)
      error.set("")
      try {
        me.set(await api.put<Me>("/auth/context", {
          companyId: company(),
          locationId: location(),
          plantId: plant() || null,
          periodId: period() || null,
        }))
        void ref.close()
      } catch (err) {
        error.set(errorText(err))
      } finally {
        busy.set(false)
      }
    }}>
      ${() => (error() ? html`<bz-alert variant="danger">${error()}</bz-alert>` : null)}
      <bz-combobox label="Firma" required .value=${company} @change=${(e: CustomEvent<{ value: string }>) => {
        company.set(e.detail.value)
        location.set(companyOption()?.locations[0]?.id ?? "")
        plant.set("")
        period.set("")
      }}>
        ${options.map((c) => html`<bz-option value=${c.id}>${c.name}</bz-option>`)}
      </bz-combobox>
      ${() => html`<bz-combobox label="Lokasyon" required .value=${location} @change=${(e: CustomEvent<{ value: string }>) => {
        location.set(e.detail.value)
        plant.set("")
      }}>
        ${(companyOption()?.locations ?? []).map((l) => html`<bz-option value=${l.id}>${l.name}</bz-option>`)}
      </bz-combobox>`}
      ${() => {
        const plants = locationOption()?.plants ?? []
        return plants.length === 0
          ? null
          : html`<bz-combobox label="Plant" .value=${plant} @change=${pick(plant)}>
              <bz-option value="">Tümü</bz-option>
              ${plants.map((p) => html`<bz-option value=${p.id}>${p.name}</bz-option>`)}
            </bz-combobox>`
      }}
      ${() => {
        const periods = companyOption()?.periods ?? []
        return periods.length === 0
          ? null
          : html`<bz-combobox label="Dönem" .value=${period} @change=${pick(period)}>
              <bz-option value="">Seçilmedi</bz-option>
              ${periods.map((p) => html`<bz-option value=${p.id}>${p.name}${p.isClosed ? " (kapalı)" : ""}</bz-option>`)}
            </bz-combobox>`
      }}
    </form>`,
    footer: (ref) => html`${required ? null : html`<bz-button @click=${() => void ref.close()}>Vazgeç</bz-button>`}
      <bz-button variant="primary" type="submit" form="context-form" ?loading=${busy}>Seç</bz-button>`,
  })
}
