/** Calls to Bazlama.Host. Same origin: in development Vite proxies /api to the host. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** Messages for the user (the server's { errors: [...] }, Turkish). */
    readonly errors: string[],
    /** Field key → message (the data engine's validation). */
    readonly fieldErrors: Record<string, string> = {},
    /** The whole answer (e.g. a failed build's diagnostics). */
    readonly body: unknown = null,
  ) {
    super(errors.join(" ") || `HTTP ${status}`)
  }
}

/** Fired on 401 for a signed-in request: the session ended (idle, revoked). */
export const SESSION_LOST = "bazlama:session-lost"

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (method !== "GET") headers["X-Bazlama-Request"] = "1"
  if (body !== undefined) headers["Content-Type"] = "application/json"
  const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal })
  if (res.status === 204) return undefined as T
  const data: unknown = res.headers.get("Content-Type")?.includes("json") ? await res.json() : null
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event(SESSION_LOST))
    const body = data as { errors?: string[]; fieldErrors?: Record<string, string> | null } | null
    throw new ApiError(res.status, body?.errors?.length ? body.errors : [statusText(res.status)], body?.fieldErrors ?? {}, data)
  }
  return data as T
}

function statusText(status: number) {
  if (status === 401) return "Oturum açmanız gerekiyor."
  if (status === 403) return "Bu işlem için yetkiniz yok."
  if (status === 404) return "Kayıt bulunamadı."
  if (status === 429) return "Çok fazla deneme. Biraz sonra tekrar deneyin."
  return `Sunucu hatası (${status}).`
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, signal),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
}

/** The message to show for a failed call. */
export const errorText = (e: unknown) => (e instanceof ApiError ? e.errors.join(" ") : e instanceof Error ? e.message : String(e))

/** GET /api/system/info */
export interface SystemInfo {
  product: string
  version: string
  environment: string
  databaseProvider: string
}
