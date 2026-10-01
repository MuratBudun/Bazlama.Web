import { computed, signal } from "@bazlama/core"
import { api, SESSION_LOST } from "./api"

export interface Named {
  id: string
  code: string
  name: string
}
export interface PeriodInfo extends Named {
  startDate: string
  endDate: string
  isClosed: boolean
}
export interface LocationOption extends Named {
  plants: Named[]
}
export interface CompanyOption extends Named {
  locations: LocationOption[]
  periods: PeriodInfo[]
}

/** GET /api/auth/me (Bazlama.Modules.Identity/AuthEndpoints.cs). */
export interface Me {
  setupRequired: boolean
  status: "anonymous" | "mfa" | "mfaEnrollment" | "passwordChange" | "active"
  user: { id: string; userName: string; displayName: string; mfaEnabled: boolean } | null
  permissions: string[]
  context: { company: Named | null; location: Named | null; plant: Named | null; period: PeriodInfo | null } | null
  contextRequired: boolean
}

/** The signed-in state; null until the first /me answer. */
export const me = signal<Me | null>(null)

export const isActive = computed(() => me()?.status === "active")

export const can = (permission: string) => {
  const p = me()?.permissions ?? []
  return p.includes("*") || p.includes(permission)
}

export async function refreshMe() {
  me.set(await api.get<Me>("/auth/me"))
}

export async function logout() {
  await api.post("/auth/logout")
  await refreshMe()
}

// A request answered 401 although we thought we were signed in: the session ended.
window.addEventListener(SESSION_LOST, () => void refreshMe())

/** "Firma · Lokasyon · Plant · 2026" */
export const contextText = computed(() => {
  const c = me()?.context
  if (!c) return ""
  return [c.company?.name, c.location?.name, c.plant?.name, c.period?.name].filter(Boolean).join(" · ")
})
