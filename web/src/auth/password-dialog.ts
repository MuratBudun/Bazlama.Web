import { html, signal } from "@bazlama/core"
import { dialogs, toast } from "@bazlama/headless"
import { api, errorText } from "../api"
import { PASSWORD_TR } from "../labels"

/** A signed-in user's own password change (the current password is asked). */
export async function changePassword() {
  const current = signal("")
  const next = signal("")
  const again = signal("")
  const error = signal("")
  const busy = signal(false)
  const bind = (s: typeof current) => (e: Event) => s.set((e.currentTarget as HTMLInputElement).value)

  await dialogs.open({
    heading: "Parola değiştir",
    content: (ref) => html`<form id="password-form" class="stack" @submit=${async (e: Event) => {
      e.preventDefault()
      if (next() !== again()) return error.set("Parolalar aynı değil.")
      busy.set(true)
      error.set("")
      try {
        await api.post("/auth/password", { currentPassword: current(), newPassword: next() })
        toast.success("Parolanız değiştirildi. Diğer oturumlarınız kapatıldı.")
        void ref.close()
      } catch (err) {
        error.set(errorText(err))
      } finally {
        busy.set(false)
      }
    }}>
      ${() => (error() ? html`<bz-alert variant="danger">${error()}</bz-alert>` : null)}
      <bz-password .labels=${PASSWORD_TR} label="Mevcut parola" required autocomplete="current-password" .value=${current} @input=${bind(current)}></bz-password>
      <bz-password .labels=${PASSWORD_TR} label="Yeni parola" required strength autocomplete="new-password" .value=${next} @input=${bind(next)}></bz-password>
      <bz-password .labels=${PASSWORD_TR} label="Yeni parola (tekrar)" required autocomplete="new-password" .value=${again} @input=${bind(again)}></bz-password>
    </form>`,
    footer: (ref) => html`<bz-button @click=${() => void ref.close()}>Vazgeç</bz-button>
      <bz-button variant="primary" type="submit" form="password-form" ?loading=${busy}>Değiştir</bz-button>`,
  })
}
