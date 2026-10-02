import { computed, effect, html, onCleanup, render, repeat, root, signal, untrack, type Cleanup, type Signal } from "@bazlama/core"
import { contextMenu, icon, type MenuItemData, type TreeItem } from "@bazlama/headless"
import { compilePath, createQuery, definePage, matchPath, type LeaveGuard, type PageContext, type PageDef, type Params, type RouteInfo, type Router } from "@bazlama/router"
import { runtimeApps, runtimeConfig, type RuntimeAppInfo } from "./api"
import { appPage, listPage, recordPage, runtimeNav } from "./pages"

/*
 * Runtime: a home tab with the apps as cards, and one tab per open app. An app tab has the
 * app's menu on the left and its pages (lists, records) on the right; moving between them
 * stays inside the tab. Tabs keep their pages alive while another tab is shown.
 *
 * The URL is the active tab's location (#/apps/siparis/siparis/42?list=acik): links, back and
 * forward work as before, and opening a link of an app that is not open opens its tab. The
 * open tabs are not kept across reloads.
 */

const HOME = "__home"

interface Location {
  path: string
  query: URLSearchParams
}
interface Tab {
  key: string
  loc: Signal<Location>
  /** Leave guards of the page shown in the tab (unsaved changes). */
  guards: Set<LeaveGuard>
}

/** The pages inside an app tab. Another route (or other params) is a new page. */
const ROUTES: { pattern: ReturnType<typeof compilePath>; page: PageDef<any> }[] = [
  { pattern: compilePath(`${runtimeConfig.base}/:app`), page: appPage },
  { pattern: compilePath(`${runtimeConfig.base}/:app/:entity`), page: listPage },
  { pattern: compilePath(`${runtimeConfig.base}/:app/:entity/:id`), page: recordPage },
]
function resolve(path: string): { index: number; params: Params } | null {
  for (let index = 0; index < ROUTES.length; index++) {
    const params = matchPath(ROUTES[index].pattern, path)
    if (params) return { index, params }
  }
  return null
}
const pageKey = (path: string) => {
  const r = resolve(path)
  return r ? `${r.index}:${JSON.stringify(r.params)}` : ""
}
const appOf = (path: string) => new RegExp(`^${runtimeConfig.base}/([^/?#]+)`).exec(path)?.[1] ?? null
const hrefOf = (loc: Location) => (loc.query.size ? `${loc.path}?${loc.query}` : loc.path)

/** Runtime paths are everything but the other areas. */
export const isRuntimePath = (path: string) => !/^\/(development|management)(\/|$)/.test(path)

// ── Recently used apps (this browser) ────────────────────────────────────

const RECENTS = "bazlama-recent-apps"
function readRecents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENTS) ?? "[]") as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}
const recents = signal(readRecents())
function touchRecent(key: string) {
  const next = [key, ...recents().filter((k) => k !== key)].slice(0, 8)
  recents.set(next)
  try {
    localStorage.setItem(RECENTS, JSON.stringify(next))
  } catch {
    /* storage unavailable */
  }
}

/** A calm accent per app (the same app always gets the same one). */
const ACCENTS = ["#2563eb", "#0d9488", "#7c3aed", "#db2777", "#ea580c", "#16a34a", "#0891b2", "#9333ea", "#ca8a04", "#4f46e5"]
export const accentOf = (key: string) => ACCENTS[[...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % ACCENTS.length]

// ── Home: the apps as cards ──────────────────────────────────────────────

function homeView(router: Router) {
  const search = signal("")
  const norm = (s: string) => s.toLocaleLowerCase("tr-TR")
  const matches = (a: RuntimeAppInfo) => {
    const q = norm(search().trim())
    return !q || [a.name, a.key, a.description ?? "", ...a.entities.map((e) => e.plural)].some((s) => norm(s).includes(q))
  }
  const card = (a: RuntimeAppInfo) => html`<a class="app-card" href=${router.href(`${runtimeConfig.base}/${a.key}`)} style=${`--app-accent: ${accentOf(a.key)}`}>
    <span class="app-card-icon">${icon(a.icon ?? "layers", { size: 22 })}</span>
    <span class="app-card-text">
      <strong>${a.name}</strong>
      <span class="muted small">${a.description || a.entities.map((e) => e.plural).join(" · ")}</span>
    </span>
  </a>`
  const recentApps = computed(() => (search() ? [] : recents().map((k) => runtimeApps().find((a) => a.key === k)).filter((a): a is RuntimeAppInfo => !!a)))
  const hour = new Date().getHours()
  const greeting = hour < 6 ? "İyi geceler" : hour < 12 ? "Günaydın" : hour < 18 ? "İyi günler" : "İyi akşamlar"

  return html`<div class="page rt-home">
    <div class="rt-home-head">
      <h1>${greeting}</h1>
      <bz-input class="rt-search" placeholder="Uygulama ara…" aria-label="Uygulama ara" .value=${search}
        @input=${(e: Event) => search.set((e.currentTarget as HTMLInputElement).value)}><span slot="prefix">${icon("search")}</span></bz-input>
    </div>
    ${() =>
      recentApps().length
        ? html`<section class="stack"><h2 class="rt-group">Son kullanılanlar</h2>
            <div class="rt-recents">${recentApps().map((a) => html`<a class="rt-recent" href=${router.href(`${runtimeConfig.base}/${a.key}`)} style=${`--app-accent: ${accentOf(a.key)}`}>
              ${icon(a.icon ?? "layers", { size: 16 })}${a.name}</a>`)}</div></section>`
        : null}
    <section class="stack">
      <h2 class="rt-group">Uygulamalar</h2>
      ${() => {
        if (runtimeApps().length === 0)
          return html`<p class="muted">Kullanabileceğiniz bir uygulama yok. Uygulamalar Yönetim › Uygulamalar'dan kurulur; erişim grup izinleriyle verilir.</p>`
        const list = runtimeApps().filter(matches)
        return list.length ? html`<div class="app-cards">${list.map(card)}</div>` : html`<p class="muted">"${search()}" ile eşleşen uygulama yok.</p>`
      }}
    </section>
  </div>`
}

// ── An app tab ───────────────────────────────────────────────────────────

const flatten = (items: TreeItem[]): TreeItem[] => items.flatMap((n) => [n, ...flatten(n.children ?? [])])
const groupIds = (items: TreeItem[]): string[] => flatten(items).filter((n) => n.children).map((n) => n.id)

/** The menu item of a location: the list (or form) it came from, else the deepest item the path is under. */
function menuCurrent(items: TreeItem[], loc: Location) {
  const leaves = flatten(items).filter((n) => n.href)
  const list = loc.query.get("list")
  const form = loc.query.get("form")
  const entityPath = loc.path.split("/").slice(0, 4).join("/")
  const exact = [list ? `${entityPath}?list=${list}` : "", form ? `${loc.path}?form=${form}` : ""]
  const hit = leaves.find((n) => exact.includes(n.id))
  if (hit) return hit.id
  const base = (id: string) => id.split("?")[0]
  return leaves.filter((n) => loc.path === base(n.id) || loc.path.startsWith(`${base(n.id)}/`)).sort((a, b) => b.id.length - a.id.length)[0]?.id ?? ""
}

/** A page context for a page inside a tab: the tab's location instead of the URL. */
function tabContext(router: Router, tab: Tab, params: Params): PageContext {
  const path = computed(() => tab.loc().path)
  return {
    router,
    params: computed(() => params),
    query: createQuery(() => tab.loc().query, router),
    hash: computed(() => ""),
    path,
    state: computed(() => undefined),
    data: computed(() => undefined),
    error: computed(() => undefined),
    navigate: router.navigate,
    onBeforeLeave(guard) {
      tab.guards.add(guard)
      onCleanup(() => tab.guards.delete(guard))
    },
    blockUnload(when) {
      const listener = (e: BeforeUnloadEvent) => {
        if (!when()) return
        e.preventDefault()
        e.returnValue = ""
      }
      addEventListener("beforeunload", listener)
      onCleanup(() => removeEventListener("beforeunload", listener))
    },
  }
}

/** The page of a tab's location, re-created when the location is another page. */
function tabPage(router: Router, tab: Tab) {
  const host = document.createElement("div")
  host.className = "rt-page"
  const key = computed(() => pageKey(tab.loc().path))
  let dispose: Cleanup | null = null
  effect(() => {
    key()
    untrack(() => {
      dispose?.()
      dispose = null
      host.replaceChildren()
      const r = resolve(tab.loc().path)
      if (!r) return void render(html`<div class="page"><bz-alert variant="warning">Sayfa bulunamadı.</bz-alert></div>`, host)
      dispose = root((d) => {
        try {
          render(ROUTES[r.index].page.setup(tabContext(router, tab, r.params)), host)
        } catch (error) {
          console.error("bazlama runtime: page failed", error)
        }
        return d
      })
    })
  })
  onCleanup(() => dispose?.())
  return host
}

function appView(router: Router, tab: Tab) {
  const nav = runtimeNav(router.href)
  const items = computed(() => nav().find((a) => a.id === `${runtimeConfig.base}/${tab.key}`)?.children ?? [])
  const app = () => runtimeApps().find((a) => a.key === tab.key)
  return html`<bz-split class="rt-app" size="240" min="160" max="420" collapsible persist="bazlama-rt-menu" label="Uygulama menüsünü boyutlandır">
    <nav class="rt-app-menu" aria-label=${() => `${app()?.name ?? tab.key} menüsü`}>
      <a class="rt-app-title" href=${router.href(`${runtimeConfig.base}/${tab.key}`)} style=${`--app-accent: ${accentOf(tab.key)}`}>
        <span class="app-card-icon small">${icon(app()?.icon ?? "layers", { size: 16 })}</span><strong>${() => app()?.name ?? tab.key}</strong>
      </a>
      <bz-tree label=${() => `${app()?.name ?? tab.key} menüsü`} selection="leaf" .items=${items} .value=${() => menuCurrent(items(), tab.loc())}
        .expanded=${() => groupIds(items())}></bz-tree>
    </nav>
    <div class="rt-app-content">${tabPage(router, tab)}</div>
  </bz-split>`
}

// ── The tabs ─────────────────────────────────────────────────────────────

export const runtimeShell = definePage({
  // The active tab's app (the router sets the title after every navigation).
  title: (info) => {
    const key = appOf(info.path)
    return key ? (runtimeApps().find((a) => a.key === key)?.name ?? key) : "Ana sayfa"
  },
  setup(ctx) {
    const router = ctx.router
    const tabs = new Map<string, Tab>()
    const open = signal<string[]>([])
    const current = computed(() => appOf(ctx.path()) ?? HOME)
    const titleOf = (key: string) => (key === HOME ? "Ana sayfa" : (runtimeApps().find((a) => a.key === key)?.name ?? key))

    // The URL opens (or moves) the tab of its app.
    effect(() => {
      const path = ctx.path()
      const query = router.current()?.query ?? new URLSearchParams()
      const key = appOf(path)
      untrack(() => {
        if (!key) return
        const loc = { path, query: new URLSearchParams(query) }
        const tab = tabs.get(key)
        if (tab) tab.loc.set(loc)
        else {
          tabs.set(key, { key, loc: signal(loc), guards: new Set() })
          open.set([...open(), key])
          touchRecent(key)
        }
      })
    })

    /** Asks the page of a tab whether it may go (unsaved changes). */
    const mayLeave = async (tab: Tab, to: RouteInfo, from: RouteInfo) => {
      for (const guard of [...tab.guards]) if ((await guard(to, from)) === false) return false
      return true
    }
    // Leaving a page: within its tab, or leaving Runtime (every tab's page goes).
    ctx.onBeforeLeave(async (to, from) => {
      const leaving = !isRuntimePath(to.path)
      const toApp = appOf(to.path)
      for (const tab of tabs.values()) {
        const gone = leaving || (toApp === tab.key && pageKey(to.path) !== pageKey(tab.loc().path))
        if (gone && !(await mayLeave(tab, to, from))) return false
      }
      return true
    })

    const show = (key: string) => {
      if (key === HOME) return void router.navigate("/")
      const tab = tabs.get(key)
      if (tab) void router.navigate(hrefOf(tab.loc()))
    }
    const close = async (keys: string[]) => {
      const here = router.current()
      for (const key of keys) {
        const tab = tabs.get(key)
        if (!tab) continue
        if (here && !(await mayLeave(tab, here, here))) return
      }
      const list = open()
      const rest = list.filter((k) => !keys.includes(k))
      const active = current()
      if (keys.includes(active)) {
        // The neighbour of the closed tab (or home) becomes the active one.
        const i = list.indexOf(active)
        const after = list.slice(i + 1).find((k) => rest.includes(k)) ?? list.slice(0, i).reverse().find((k) => rest.includes(k))
        for (const k of keys) tabs.get(k)?.guards.clear() // already asked
        if (!(await router.navigate(after ? hrefOf(tabs.get(after)!.loc()) : "/"))) return
      }
      for (const k of keys) tabs.delete(k)
      open.set(rest)
    }

    const tabList = (el: HTMLElement) => {
      const remove = contextMenu(
        el,
        (e) => {
          const key = (e.target as Element).closest?.("bz-tab")?.getAttribute("value")
          if (!key) return null
          const others = open().filter((k) => k !== key)
          const items: MenuItemData[] = []
          if (key !== HOME) items.push({ value: "close", label: "Kapat", icon: "x" })
          if (others.length) items.push({ value: "others", label: key === HOME ? "Tüm sekmeleri kapat" : "Diğerlerini kapat" })
          if (key !== HOME && open().length > 1) items.push({ value: "all", label: "Tümünü kapat" })
          return items.length ? items : null
        },
        (value, e) => {
          const key = (e.target as Element).closest?.("bz-tab")?.getAttribute("value") ?? ""
          if (value === "close") void close([key])
          else if (value === "others") void close(open().filter((k) => k !== key))
          else if (value === "all") void close(open())
        },
      )
      onCleanup(remove)
    }
    // Middle click closes a tab, as in browsers.
    const onAuxClick = (e: MouseEvent) => {
      if (e.button !== 1) return
      const key = (e.target as Element).closest?.("bz-tab")?.getAttribute("value")
      if (key && key !== HOME) {
        e.preventDefault()
        void close([key])
      }
    }

    const tabLabel = (key: string) =>
      html`<bz-tab value=${key} closable close-label="Kapat" style=${`--app-accent: ${accentOf(key)}`}>
        <span class="rt-tab-icon">${icon(runtimeApps().find((a) => a.key === key)?.icon ?? "layers", { size: 14 })}</span>${() => titleOf(key)}
      </bz-tab>`
    const tabPanel = (key: string) => html`<bz-tab-panel value=${key}>${appView(router, tabs.get(key)!)}</bz-tab-panel>`

    return html`<div class="rt-tabs" data-shell-fill>
      <bz-tabs fill .value=${current} @change.self=${(e: CustomEvent<{ value: string }>) => show(e.detail.value)}
        @before-close.self=${(e: CustomEvent<{ value: string }>) => {
          e.preventDefault()
          void close([e.detail.value])
        }}>
        <bz-tab-list ref=${tabList} @auxclick=${onAuxClick}>
          <bz-tab value=${HOME} aria-label="Ana sayfa" data-tooltip="Ana sayfa">${icon("home", { size: 16 })}</bz-tab>
          ${() => repeat(open, (k) => k, tabLabel)}
        </bz-tab-list>
        <bz-tab-panel value=${HOME}>${homeView(router)}</bz-tab-panel>
        ${() => repeat(open, (k) => k, tabPanel)}
      </bz-tabs>
    </div>`
  },
})

