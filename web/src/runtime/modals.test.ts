import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { flush } from "@bazlama/core"
import type { AppDef, FormDef, ToolResult } from "./api"
import { runTool } from "./modals"

beforeAll(async () => {
  const proto = ElementInternals.prototype as unknown as Record<string, unknown>
  proto.setFormValue ??= () => {}
  proto.setValidity ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  const { defineIcons } = await import("@bazlama/headless")
  defineIcons(await import("@bazlama/icons"))
})
afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((r) => setTimeout(r))
    flush()
  }
}

const form: FormDef = { key: "siparis", name: "Sipariş", entity: "siparis", sections: [], tools: [{ label: "Özet", method: "Ozet" }] }
const app: AppDef = {
  key: "satis",
  name: "Satış",
  version: "1.0.0",
  entities: [{ key: "siparis", name: "Sipariş", scope: "global", fields: [{ key: "no", label: "No", type: "text" }] }],
  forms: [form],
  modals: [
    {
      key: "aralik",
      name: "Tarih aralığı",
      okText: "Göster",
      fields: [
        { key: "baslangic", label: "Başlangıç", type: "date", required: true },
        { key: "bitis", label: "Bitiş", type: "date", required: true },
        { key: "firma", label: "Firma", type: "company" },
        { key: "lokasyon", label: "Lokasyon", type: "location" },
      ],
    },
  ],
}
const companies = [
  { id: "c1", code: "A", name: "Acme", locations: [{ id: "l1", code: "IST", name: "İstanbul", plants: [] }], periods: [] },
  { id: "c2", code: "B", name: "Beta", locations: [{ id: "l2", code: "ANK", name: "Ankara", plants: [] }], periods: [] },
]

/** The server: answers the tool's calls in order, and the organization options. */
function server(answers: (Partial<ToolResult> | { status: number; errors: string[] })[]) {
  const calls: { values: Record<string, unknown>; id: string | null; inputs: Record<string, Record<string, unknown>> }[] = []
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/context/options")) return json(companies)
      expect(url).toBe("/api/runtime/forms/satis/siparis/tools/Ozet")
      calls.push(JSON.parse(init!.body as string))
      const answer = answers.shift()!
      return "status" in answer ? json({ errors: answer.errors }, answer.status) : json({ values: null, titles: null, message: null, save: false, modal: null, ...answer })
    }),
  )
  return calls
}

const dialog = () => document.querySelector<HTMLElement>("bz-dialog")
const field = (label: string) => dialog()!.querySelector<HTMLElement>(`[label^="${label}"]`)!
const type = (label: string, value: string) => {
  const input = field(label).querySelector("input")!
  input.value = value
  input.dispatchEvent(new Event("input", { bubbles: true }))
}
const submit = () => dialog()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
const run = () => runTool({ app, form, tool: form.tools![0], id: null, values: { no: "S-1" } })

describe("form tools and modals", () => {
  it("returns the tool's result when it asks for nothing", async () => {
    const calls = server([{ values: { no: "S-2" }, message: "Tamam" }])
    expect(await run()).toMatchObject({ values: { no: "S-2" }, message: "Tamam" })
    expect(calls).toEqual([{ values: { no: "S-1" }, id: null, parentId: null, inputs: {} }])
    expect(dialog()).toBeNull()
  })

  it("shows the modal the code asks for, keeps it open while it is refused, and runs the tool with the values", async () => {
    const calls = server([
      { modal: { key: "aralik", values: { baslangic: "2026-10-01", bitis: null, firma: null, lokasyon: null } } },
      { modal: { key: "aralik", values: {}, fieldErrors: { bitis: "Zorunlu alan." }, errors: ["Aralık eksik."] } },
      { status: 400, errors: ["Bu aralıkta sipariş yok."] },
      { values: { no: "S-1" }, message: "3 sipariş" },
    ])
    const done = run()
    await settle()

    // The modal: its name, its fields with what the code started them with, its own button text.
    expect(dialog()!.getAttribute("heading") ?? (dialog() as HTMLElement & { heading: string }).heading).toBe("Tarih aralığı")
    expect(field("Başlangıç").querySelector("input")!.value).toBe("2026-10-01")
    expect(field("Bitiş").getAttribute("label")).toBe("Bitiş *")
    expect([...dialog()!.querySelectorAll("bz-button")].map((b) => b.textContent!.trim())).toEqual(["Vazgeç", "Göster"])

    // Refused by the server: the errors are shown and the modal stays.
    submit()
    await settle()
    expect(calls[1].inputs).toEqual({ aralik: { baslangic: "2026-10-01", bitis: null, firma: null, lokasyon: null } })
    expect(dialog()!.querySelector(".field-error")!.textContent).toBe("Zorunlu alan.")
    expect(dialog()!.querySelector("bz-alert")!.textContent).toContain("Aralık eksik.")

    // The tool itself refuses what was entered: still open, with its message.
    type("Bitiş", "2026-10-31")
    submit()
    await settle()
    expect(dialog()!.querySelector("bz-alert")!.textContent).toContain("Bu aralıkta sipariş yok.")
    expect(dialog()!.querySelector(".field-error")).toBeNull()

    type("Bitiş", "2026-11-30")
    submit()
    expect(await done).toMatchObject({ message: "3 sipariş" })
    expect(calls[3].inputs.aralik).toMatchObject({ baslangic: "2026-10-01", bitis: "2026-11-30" })
    expect(calls[3].values).toEqual({ no: "S-1" }) // the form goes along every time
  })

  it("offers the user's companies and that company's locations", async () => {
    server([{ modal: { key: "aralik", values: {} } }])
    void run()
    await settle()
    const options = (label: string) => [...field(label).querySelectorAll("bz-option")].map((o) => o.textContent!.trim())
    expect(options("Firma")).toEqual(["—", "Acme", "Beta"])
    expect(options("Lokasyon")).toEqual(["—"]) // no company chosen yet

    field("Firma").dispatchEvent(new CustomEvent("change", { detail: { value: "c2" } }))
    await settle()
    expect(options("Lokasyon")).toEqual(["—", "Ankara"])
    field("Lokasyon").dispatchEvent(new CustomEvent("change", { detail: { value: "l2" } }))
    // Another company: its location is no longer one of them.
    field("Firma").dispatchEvent(new CustomEvent("change", { detail: { value: "c1" } }))
    await settle()
    expect(options("Lokasyon")).toEqual(["—", "İstanbul"])
    expect((field("Lokasyon") as HTMLElement & { value: string }).value).toBe("")
  })

  it("does nothing more when the modal is cancelled", async () => {
    const calls = server([{ modal: { key: "aralik", values: {} } }])
    const done = run()
    await settle()
    ;[...dialog()!.querySelectorAll<HTMLElement>("bz-button")].find((b) => b.textContent!.trim() === "Vazgeç")!.click()
    expect(await done).toBeUndefined()
    expect(calls).toHaveLength(1)
  })
})
