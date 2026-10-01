/** Shapes of /api/management (Bazlama.Modules.Management). */

export interface UserRow {
  id: string
  userName: string
  displayName: string
  email: string | null
  isActive: boolean
  mfaEnabled: boolean
  mustChangePassword: boolean
  lockoutEndsAt: string | null
  lastLoginAt: string | null
  createdAt: string
  groups: string[]
}
export interface Membership {
  groupId: string
  locationId: string | null
}
export interface Access {
  companyId: string
  locationId: string | null
  plantId: string | null
}
export interface UserDetail {
  user: UserRow
  groups: Membership[]
  access: Access[]
}

export interface GroupRow {
  id: string
  code: string
  name: string
  description: string | null
  requireMfa: boolean
  isSystem: boolean
  memberCount: number
  permissions: string[]
}
export interface MemberRow {
  userId: string
  userName: string
  displayName: string
  locationId: string | null
}
export interface PermissionInfo {
  key: string
  title: string
}

export interface PlantNode {
  id: string
  locationId: string
  code: string
  name: string
  isActive: boolean
}
export interface LocationNode {
  id: string
  companyId: string
  code: string
  name: string
  timeZone: string | null
  isActive: boolean
  plants: PlantNode[]
}
export interface PeriodNode {
  id: string
  companyId: string
  code: string
  name: string
  startDate: string
  endDate: string
  isClosed: boolean
}
export interface CompanyNode {
  id: string
  code: string
  name: string
  isActive: boolean
  locations: LocationNode[]
  periods: PeriodNode[]
}

export interface SessionRow {
  id: string
  userId: string
  userName: string
  displayName: string
  status: string
  channel: string
  createdAt: string
  lastSeenAt: string
  ipAddress: string | null
  userAgent: string | null
  context: string | null
  isCurrent: boolean
}

export interface SecuritySettings {
  passwordMinLength: number
  passwordRequireMixed: boolean
  passwordHistoryCount: number
  passwordExpireDays: number
  lockoutMaxFailed: number
  lockoutMinutes: number
  mfaRequiredForAll: boolean
  sessionIdleMinutes: number
  singleSession: boolean
}

export interface AuditRow {
  id: string
  at: string
  category: string
  action: string
  userName: string | null
  entityType: string | null
  entityId: string | null
  data: string | null
  ipAddress: string | null
}

/** Names for ids, from the organization tree. */
export function orgNames(companies: CompanyNode[]) {
  const company = new Map(companies.map((c) => [c.id, c.name]))
  const location = new Map(companies.flatMap((c) => c.locations.map((l) => [l.id, `${l.name}`] as const)))
  const plant = new Map(companies.flatMap((c) => c.locations.flatMap((l) => l.plants.map((p) => [p.id, p.name] as const))))
  return {
    company: (id: string) => company.get(id) ?? "?",
    location: (id: string | null) => (id ? (location.get(id) ?? "?") : "Tüm lokasyonlar"),
    plant: (id: string | null) => (id ? (plant.get(id) ?? "?") : "Tüm plantler"),
    /** Every location as "Firma · Lokasyon" for pickers. */
    locations: companies.flatMap((c) => c.locations.map((l) => ({ id: l.id, label: `${c.name} · ${l.name}` }))),
  }
}
