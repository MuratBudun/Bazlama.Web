import { computed, html, signal, type TemplateResult } from "@bazlama/core"
import { icon } from "@bazlama/headless"
import { api, errorText } from "../api"
import { me, refreshMe, type Me } from "../session"

/*
 * Everything before the shell: first setup, sign-in and the pending steps of a sign-in
 * (second factor, authenticator setup, required password change). The server decides the
 * step (GET /api/auth/me → status); every answer is a fresh Me.
 */

const LOGIN_LABELS = {
  identifier: "Kullanıcı adı",
  password: "Parola",
  submit: "Giriş yap",
  code: "Doğrulama kodu",
  codeNote: "Doğrulama uygulamanızdaki {n} haneli kodu girin.",
  verify: "Doğrula",
  back: "Geri",
}

interface LoginEl extends HTMLElement {
  loading: boolean
  error: string
  code: string
}

export function authPage(): TemplateResult {
  // The step is rebuilt only when it changes (a new Me with the same status keeps the form).
  const step = computed(() => (me()?.setupRequired ? "setup" : (me()?.status ?? "anonymous")))
  return html`<main class="auth">
    <div class="auth-brand">${icon("layers", { size: 28 })}<strong>Bazlama</strong></div>
    ${() => {
      switch (step()) {
        case "setup":
          return setupStep()
        case "mfa":
          return mfaStep()
        case "mfaEnrollment":
          return enrollStep(false)
        case "passwordChange":
          return passwordStep()
        default:
          return loginStep()
      }
    }}
  </main>`
}

function loginStep() {
  const onSubmit = async (e: Event) => {
    const el = e.currentTarget as LoginEl
    const d = (e as CustomEvent<{ identifier: string; password: string }>).detail
    el.loading = true
    el.error = ""
    try {
      me.set(await api.post<Me>("/auth/login", { userName: d.identifier, password: d.password }))
    } catch (err) {
      el.error = errorText(err)
    } finally {
      el.loading = false
    }
  }
  return html`<bz-login heading="Giriş" identifier-type="text" hide-remember hide-forgot .labels=${LOGIN_LABELS} @submit=${onSubmit}></bz-login>`
}

function mfaStep() {
  const recovery = signal(false)
  const recoveryCode = signal("")
  const error = signal("")
  const busy = signal(false)

  const verify = async (code: string) => {
    busy.set(true)
    error.set("")
    try {
      me.set(await api.post<Me>("/auth/mfa/verify", { code }))
    } catch (err) {
      error.set(errorText(err))
    } finally {
      busy.set(false)
    }
  }
  const onCode = async (e: Event) => {
    const el = e.currentTarget as LoginEl
    await verify((e as CustomEvent<{ code: string }>).detail.code)
    el.error = error()
    if (error()) el.code = ""
  }
  const back = () => void api.post("/auth/logout").then(refreshMe)

  return html`${() =>
    recovery()
      ? card(
          "Kurtarma kodu",
          html`<form class="stack" @submit=${(e: Event) => (e.preventDefault(), void verify(recoveryCode()))}>
            <p class="muted">Doğrulama uygulamanıza erişemiyorsanız kurtarma kodlarınızdan birini girin. Her kod bir kez kullanılabilir.</p>
            ${errorAlert(error)}
            <bz-input label="Kurtarma kodu" required autocomplete="one-time-code" placeholder="xxxxx-xxxxx" .value=${recoveryCode}
              @input=${(e: Event) => recoveryCode.set((e.currentTarget as HTMLInputElement).value)}></bz-input>
            <div class="row">
              <bz-button type="button" variant="ghost" @click=${() => recovery.set(false)}>Geri</bz-button>
              <span class="spacer"></span>
              <bz-button type="submit" variant="primary" ?loading=${busy}>Doğrula</bz-button>
            </div>
          </form>`,
        )
      : html`<div class="stack">
          <bz-login heading="Doğrulama" step="code" .labels=${LOGIN_LABELS} @submit=${onCode} @back=${back}></bz-login>
          <button type="button" class="link-button" @click=${() => recovery.set(true)}>Kurtarma kodu kullan</button>
        </div>`}`
}

/**
 * Authenticator setup: QR code + secret, then the first code, then the recovery codes (shown
 * once). Used by the sign-in (a card) and from the user menu (`inDialog`, inside a dialog).
 * The new Me is applied only when the user continues past the codes, so the page does not
 * switch away while they are on screen.
 */
export function enrollStep(inDialog: boolean, done?: () => void) {
  const setup = signal<{ secret: string; uri: string; qrSvg: string } | null>(null)
  const code = signal("")
  const error = signal("")
  const busy = signal(false)
  const result = signal<{ recoveryCodes: string[]; me: Me } | null>(null)

  api.post<{ secret: string; uri: string; qrSvg: string }>("/auth/mfa/setup").then(setup.set, (e) => error.set(errorText(e)))

  const confirm = async (e: Event) => {
    e.preventDefault()
    busy.set(true)
    error.set("")
    try {
      result.set(await api.post<{ recoveryCodes: string[]; me: Me }>("/auth/mfa/confirm", { code: code() }))
    } catch (err) {
      error.set(errorText(err))
    } finally {
      busy.set(false)
    }
  }
  const finish = () => {
    me.set(result()!.me)
    done?.()
  }
  const wrap = (heading: string, body: TemplateResult) => (inDialog ? body : card(heading, body))

  return html`${() => {
    const r = result()
    if (r) return wrap("Kurtarma kodları", recoveryCodesView(r.recoveryCodes, finish))
    return wrap(
      "Doğrulama uygulaması",
      html`<form class="stack" @submit=${confirm}>
        ${inDialog ? null : html`<p class="muted">Hesabınız için iki adımlı doğrulama gerekli.</p>`}
        <ol class="steps">
          <li>Telefonunuzda bir doğrulama uygulaması açın (Microsoft Authenticator, Google Authenticator…).</li>
          <li>QR kodu okutun ya da anahtarı elle girin.</li>
          <li>Uygulamanın gösterdiği 6 haneli kodu yazın.</li>
        </ol>
        ${() => {
          const s = setup()
          if (!s) return html`<span class="muted">Hazırlanıyor…</span>`
          return html`<div class="qr"><img alt="Doğrulama uygulaması için QR kod" src=${`data:image/svg+xml;charset=utf-8,${encodeURIComponent(s.qrSvg)}`} /></div>
            <div class="secret"><span class="muted small">Anahtar</span><code>${s.secret.replace(/(.{4})/g, "$1 ").trim()}</code></div>`
        }}
        ${errorAlert(error)}
        <bz-input label="Doğrulama kodu" required inputmode="numeric" autocomplete="one-time-code" maxlength="6" .value=${code}
          @input=${(e: Event) => code.set((e.currentTarget as HTMLInputElement).value)}></bz-input>
        <div class="row">
          <span class="spacer"></span>
          <bz-button type="submit" variant="primary" ?loading=${busy}>Etkinleştir</bz-button>
        </div>
      </form>`,
    )
  }}`
}

function recoveryCodesView(codes: string[], onContinue: () => void) {
  const copy = () => void navigator.clipboard?.writeText(codes.join("\n"))
  const download = () => {
    const a = document.createElement("a")
    a.href = URL.createObjectURL(new Blob([codes.join("\r\n")], { type: "text/plain" }))
    a.download = "bazlama-kurtarma-kodlari.txt"
    a.click()
    URL.revokeObjectURL(a.href)
  }
  return html`<div class="stack">
    <bz-alert variant="warning">Bu kodları güvenli bir yere kaydedin. Telefonunuza erişemezseniz giriş için bunlardan birini kullanırsınız; her kod bir kez geçerlidir. Kodlar bir daha gösterilmeyecek.</bz-alert>
    <ul class="codes">${codes.map((c) => html`<li><code>${c}</code></li>`)}</ul>
    <div class="row">
      <bz-button @click=${copy}>${icon("copy")} Kopyala</bz-button>
      <bz-button @click=${download}>${icon("download")} İndir</bz-button>
      <span class="spacer"></span>
      <bz-button variant="primary" @click=${onContinue}>Devam</bz-button>
    </div>
  </div>`
}

function passwordStep() {
  const next = signal("")
  const again = signal("")
  const errors = signal<string[]>([])
  const busy = signal(false)

  const submit = async (e: Event) => {
    e.preventDefault()
    if (next() !== again()) return errors.set(["Parolalar aynı değil."])
    busy.set(true)
    errors.set([])
    try {
      me.set(await api.post<Me>("/auth/password", { newPassword: next() }))
    } catch (err) {
      errors.set([errorText(err)])
    } finally {
      busy.set(false)
    }
  }

  return card(
    "Yeni parola",
    html`<form class="stack" @submit=${submit}>
      <p class="muted">Devam etmeden önce parolanızı değiştirmeniz gerekiyor.</p>
      ${() => (errors().length ? html`<bz-alert variant="danger">${errors().join(" ")}</bz-alert>` : null)}
      <bz-password label="Yeni parola" required strength autocomplete="new-password" .value=${next}
        @input=${(e: Event) => next.set((e.currentTarget as HTMLInputElement).value)}></bz-password>
      <bz-password label="Yeni parola (tekrar)" required autocomplete="new-password" .value=${again}
        @input=${(e: Event) => again.set((e.currentTarget as HTMLInputElement).value)}></bz-password>
      <div class="row"><span class="spacer"></span><bz-button type="submit" variant="primary" ?loading=${busy}>Kaydet ve devam et</bz-button></div>
    </form>`,
  )
}

function setupStep() {
  const f = {
    userName: signal("admin"),
    displayName: signal(""),
    password: signal(""),
    again: signal(""),
    companyCode: signal(""),
    companyName: signal(""),
    locationCode: signal("MERKEZ"),
    locationName: signal("Merkez"),
  }
  const errors = signal<string[]>([])
  const busy = signal(false)
  const field = (label: string, s: (typeof f)[keyof typeof f]) =>
    html`<bz-input label=${label} required .value=${s}
      @input=${(e: Event) => s.set((e.currentTarget as HTMLInputElement).value)}></bz-input>`

  const submit = async (e: Event) => {
    e.preventDefault()
    if (f.password() !== f.again()) return errors.set(["Parolalar aynı değil."])
    busy.set(true)
    errors.set([])
    try {
      await api.post("/auth/setup", {
        userName: f.userName(),
        displayName: f.displayName(),
        password: f.password(),
        companyCode: f.companyCode(),
        companyName: f.companyName(),
        locationCode: f.locationCode(),
        locationName: f.locationName(),
      })
      await refreshMe()
    } catch (err) {
      errors.set([errorText(err)])
    } finally {
      busy.set(false)
    }
  }

  return card(
    "İlk kurulum",
    html`<form class="stack" @submit=${submit}>
      <p class="muted">Henüz kullanıcı yok. Yönetici hesabını ve ilk firma ile lokasyonu oluşturun; diğer tanımları sonra Yönetim'den yapabilirsiniz.</p>
      ${() => (errors().length ? html`<bz-alert variant="danger">${errors().join(" ")}</bz-alert>` : null)}
      <bz-form-layout columns="2" min-column-width="12rem">
        <bz-form-section heading="Yönetici">
          ${field("Kullanıcı adı", f.userName)} ${field("Ad soyad", f.displayName)}
          <bz-password label="Parola" required strength autocomplete="new-password" .value=${f.password}
            @input=${(e: Event) => f.password.set((e.currentTarget as HTMLInputElement).value)}></bz-password>
          <bz-password label="Parola (tekrar)" required autocomplete="new-password" .value=${f.again}
            @input=${(e: Event) => f.again.set((e.currentTarget as HTMLInputElement).value)}></bz-password>
        </bz-form-section>
        <bz-form-section heading="Kurum">
          ${field("Firma kodu", f.companyCode)} ${field("Firma adı", f.companyName)}
          ${field("Lokasyon kodu", f.locationCode)} ${field("Lokasyon adı", f.locationName)}
        </bz-form-section>
      </bz-form-layout>
      <div class="row"><span class="spacer"></span><bz-button type="submit" variant="primary" ?loading=${busy}>Kurulumu tamamla</bz-button></div>
    </form>`,
    "wide",
  )
}

function card(heading: string, body: TemplateResult, size: "" | "wide" = "") {
  return html`<section class=${`auth-card ${size}`} aria-labelledby="auth-heading">
    <h1 id="auth-heading">${heading}</h1>
    ${body}
  </section>`
}

const errorAlert = (error: () => string) => () => (error() ? html`<bz-alert variant="danger">${error()}</bz-alert>` : null)
