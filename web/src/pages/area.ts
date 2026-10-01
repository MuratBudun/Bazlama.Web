import { html } from "@bazlama/core"
import { icon } from "@bazlama/headless"
import { definePage } from "@bazlama/router"

/** Placeholder start page of an area until its phase is built (docs/architecture.md, Fazlar). */
export const areaPage = (title: string, iconName: string, text: string) =>
  definePage({
    title,
    setup: () => html`<div class="page">
      <div class="page-head">${icon(iconName, { size: 22 })}<h1>${title}</h1></div>
      <p class="muted">${text}</p>
    </div>`,
  })
