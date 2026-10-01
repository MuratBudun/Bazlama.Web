import { html, signal } from "@bazlama/core"
import { definePage } from "@bazlama/router"
import { api, type SystemInfo } from "../api"

/** Start page: what this installation is (version, environment mode, database). */
export default definePage({
  title: "Başlangıç",
  setup() {
    const info = signal<SystemInfo | null>(null)
    const error = signal("")
    api.get<SystemInfo>("/system/info").then(info.set, (e: Error) => error.set(e.message))

    return html`<div class="page">
      <div class="page-head"><h1>Bazlama</h1></div>
      ${() =>
        error()
          ? html`<bz-alert variant="danger" heading="Sunucuya ulaşılamadı">${error()}</bz-alert>`
          : null}
      <bz-panel heading="Kurulum">
        ${() => {
          const i = info()
          if (!i) return html`<span class="muted">Yükleniyor…</span>`
          return html`<dl class="facts">
            <dt>Sürüm</dt><dd>${i.version}</dd>
            <dt>Ortam</dt><dd>${i.environment}</dd>
            <dt>Veritabanı</dt><dd>${i.databaseProvider}</dd>
          </dl>`
        }}
      </bz-panel>
    </div>`
  },
})
