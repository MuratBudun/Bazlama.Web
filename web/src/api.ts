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
  const raw = body instanceof Blob
  if (body !== undefined) headers["Content-Type"] = raw ? "application/octet-stream" : "application/json"
  const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), signal })
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
  /** POST a file as the raw body. */
  upload: <T>(path: string, file: Blob) => request<T>("POST", path, file),
}

/**
 * Downloads a file the server makes (e.g. a .bzapp package). A plain <a download> link fails
 * silently when the server refuses (the error JSON is lost); this throws an ApiError with the
 * server's message instead. The file name comes from Content-Disposition.
 */
export async function downloadFile(path: string, fallbackName: string) {
  const res = await fetch(`/api${path}`, { headers: { Accept: "application/octet-stream, application/json" } })
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event(SESSION_LOST))
    const data: unknown = res.headers.get("Content-Type")?.includes("json") ? await res.json() : null
    const errors = (data as { errors?: string[] } | null)?.errors
    throw new ApiError(res.status, errors?.length ? errors : [statusText(res.status)], {}, data)
  }
  const disposition = res.headers.get("Content-Disposition") ?? ""
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
  const name = encoded ? decodeURIComponent(encoded) : (/filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? fallbackName)
  const a = document.createElement("a")
  a.href = URL.createObjectURL(await res.blob())
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

let info: Promise<SystemInfo> | null = null
/** /api/system/info, fetched once (the environment does not change while running). */
export const systemInfo = () => (info ??= api.get<SystemInfo>("/system/info").catch((e: unknown) => ((info = null), Promise.reject(e))))

/** The message to show for a failed call. */
export const errorText = (e: unknown) => (e instanceof ApiError ? e.errors.join(" ") : e instanceof Error ? e.message : String(e))

/** GET /api/system/info */
export interface SystemInfo {
  product: string
  version: string
  environment: string
  databaseProvider: string
}
