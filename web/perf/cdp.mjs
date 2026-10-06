/*
 * A small Chrome DevTools Protocol client for the performance runs: starts the installed
 * Chrome headless with a throw-away profile and drives one page. No dependencies (Node 22+).
 */
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CHROME = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].filter(Boolean)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function launch({ port = 9333, width = 1440, height = 900 } = {}) {
  const exe = CHROME.find((p) => existsSync(p))
  if (!exe) throw new Error("Chrome bulunamadı (CHROME ortam değişkeniyle yolunu verin).")
  const profile = mkdtempSync(join(tmpdir(), "bazlama-perf-"))
  const child = spawn(
    exe,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--enable-precise-memory-info",
      // A page left behind must not stay in memory (it would count in the next page's numbers).
      // PERF_BFCACHE=1 keeps Chrome's default: every load then starts in a new renderer process
      // (as a newly opened browser tab does), which is the slower, colder case for page loads.
      ...(process.env.PERF_BFCACHE ? [] : ["--disable-features=BackForwardCache"]),
      "--js-flags=--expose-gc",
      "about:blank",
    ],
    { stdio: "ignore" },
  )

  let version
  for (let i = 0; i < 50 && !version; i++) {
    await sleep(200)
    version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json(), () => null)
  }
  if (!version) throw new Error("Chrome başlatılamadı.")

  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let nextId = 0
  const pending = new Map()
  const listeners = new Set()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id !== undefined) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`))
      else p.resolve(m.result)
    } else for (const l of listeners) l(m)
  }
  const raw = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject, method })
      ws.send(JSON.stringify({ id, method, params, sessionId }))
    })

  const { targetId } = await raw("Target.createTarget", { url: "about:blank" })
  const { sessionId } = await raw("Target.attachToTarget", { targetId, flatten: true })
  const send = (method, params) => raw(method, params, sessionId)
  await send("Page.enable")
  await send("Runtime.enable")
  await send("Performance.enable", { timeDomain: "threadTicks" })
  await send("Network.enable")
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false })

  /** Runs an expression (may be async) in the page and returns its value. */
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(`sayfada hata: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n${expression.slice(0, 200)}`)
    return r.result.value
  }
  const metrics = async () => Object.fromEntries((await send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]))
  /** Heap, DOM nodes and listeners after a full garbage collection. */
  const memory = async () => {
    for (let i = 0; i < 3; i++) await send("HeapProfiler.collectGarbage")
    await sleep(100)
    const m = await metrics()
    return { heapMB: m.JSHeapUsedSize / 1048576, nodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents }
  }
  const navigate = async (url) => {
    const loaded = new Promise((resolve) => {
      const l = (m) => {
        if (m.method === "Page.loadEventFired" && m.sessionId === sessionId) {
          listeners.delete(l)
          resolve()
        }
      }
      listeners.add(l)
    })
    const r = await send("Page.navigate", { url })
    // A change of the hash only stays in the document: no load event.
    if (r.loaderId) await loaded
  }
  const close = async () => {
    try {
      await raw("Browser.close")
    } catch {
      /* already gone */
    }
    child.kill()
    await sleep(500)
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* the profile is in the temp folder anyway */
    }
  }
  /**
   * Records a trace while `run` works and returns the CSS selectors that cost the most style
   * time ({ selector, ms, attempts, matches }), slowest first, and the main-thread totals.
   */
  const selectorStats = async (run) => {
    const events = []
    const collect = (m) => {
      if (m.method === "Tracing.dataCollected") events.push(...m.params.value)
    }
    listeners.add(collect)
    await raw("Tracing.start", { traceConfig: { includedCategories: ["blink", "devtools.timeline", "disabled-by-default-blink.debug", "disabled-by-default-devtools.timeline"] }, transferMode: "ReportEvents" })
    await run()
    const done = new Promise((resolve) => {
      const l = (m) => {
        if (m.method === "Tracing.tracingComplete") {
          listeners.delete(l)
          resolve()
        }
      }
      listeners.add(l)
    })
    await raw("Tracing.end")
    await done
    listeners.delete(collect)
    const bySelector = new Map()
    for (const e of events) {
      if (e.name !== "SelectorStats") continue
      for (const t of e.args?.selector_stats?.selector_timings ?? []) {
        const row = bySelector.get(t.selector) ?? { selector: t.selector, ms: 0, attempts: 0, matches: 0 }
        row.ms += t["elapsed (us)"] / 1000
        row.attempts += t.match_attempts
        row.matches += t.match_count
        bySelector.set(t.selector, row)
      }
    }
    const sum = (name) => events.filter((e) => e.name === name && e.ph === "X").reduce((s, e) => s + e.dur / 1000, 0)
    return {
      selectors: [...bySelector.values()].sort((a, b) => b.ms - a.ms),
      totals: { recalcStyle: sum("UpdateLayoutTree"), layout: sum("Layout"), paint: sum("Paint") + sum("PrePaint"), script: sum("FunctionCall") + sum("EvaluateScript") },
    }
  }
  return { send, evaluate, metrics, memory, navigate, close, selectorStats, on: (l) => listeners.add(l), version: version.Browser }
}

export const median = (values) => {
  const s = [...values].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
export const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d

/**
 * In-page helpers (installed on every document): wait for the UI, and time an action from its
 * start to the first frame after the UI is in the expected state.
 */
export const PAGE_HELPERS = `
window.__perf = {
  frame: () => new Promise((r) => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => r(performance.now()); c.port2.postMessage(0) })),
  /** Resolves when test() is truthy (checked on every DOM change and frame). */
  until(test, timeout = 20000) {
    return new Promise((resolve, reject) => {
      let done = false
      const check = () => {
        if (done) return
        let ok = false
        try { ok = !!test() } catch {}
        if (!ok) return
        done = true
        observer.disconnect()
        clearTimeout(timer)
        resolve(performance.now())
      }
      const observer = new MutationObserver(check)
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
      const timer = setTimeout(() => { done = true; observer.disconnect(); reject(new Error("zaman aşımı: " + test)) }, timeout)
      const loop = () => { check(); if (!done) requestAnimationFrame(loop) }
      loop()
    })
  },
  /** { ready: ms until the DOM is in the state, painted: ms until the frame after it }. */
  async time(action, test) {
    const t0 = performance.now()
    await action()
    const ready = await this.until(test)
    const painted = await this.frame()
    return { ready: ready - t0, painted: painted - t0 }
  },
  rows: (root = document) => root.querySelectorAll('bz-data-grid [data-part="body"] [data-part="row"]').length,
  visible: (el) => !!el && el.getClientRects().length > 0,
  go(hash) { location.hash = hash },
}
`
