/*
 * Prepares an installation for the performance runs: first-time setup (if it is new), the
 * sample app from a .bzapp and enough records to make lists and forms realistic.
 *
 *   BASE=http://127.0.0.1:5420 PERF_USER=admin PERF_PASSWORD=… node perf/seed.mjs <siparis.bzapp>
 *
 * Use a throw-away installation: it creates a few hundred records.
 */
import { readFile } from "node:fs/promises"

const BASE = process.env.BASE ?? "http://127.0.0.1:5420"
const USER = process.env.PERF_USER ?? "admin"
const PASSWORD = process.env.PERF_PASSWORD
if (!PASSWORD) throw new Error("PERF_PASSWORD gerekli.")

const COUNTS = { musteri: 300, urun: 120, siparis: 150, buyukKalem: 400, ortaKalem: 120 }

let cookie = ""
async function call(method, path, body, raw = false) {
  const headers = { Accept: "application/json", Cookie: cookie }
  if (method !== "GET") headers["X-Bazlama-Request"] = "1"
  if (body !== undefined) headers["Content-Type"] = raw ? "application/octet-stream" : "application/json"
  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) })
  const set = res.headers.getSetCookie()
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ")
  const text = await res.text()
  const data = text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`)
  return data
}
const create = async (entity, values, parentId = null) => (await call("POST", `/runtime/data/siparis/${entity}`, { values, parentId })).id

const me = await call("GET", "/auth/me")
if (me.setupRequired) {
  await call("POST", "/auth/setup", { userName: USER, displayName: "Performans", password: PASSWORD, companyCode: "PRF", companyName: "Performans A.Ş.", locationCode: "MRK", locationName: "Merkez" })
  console.log("kurulum yapıldı")
}
await call("POST", "/auth/login", { userName: USER, password: PASSWORD })

const apps = await call("GET", "/management/apps")
if (!apps.some((a) => a.key === "siparis")) {
  const file = process.argv[2]
  if (!file) throw new Error("Uygulama kurulu değil: .bzapp yolunu verin.")
  const r = await call("POST", "/management/apps/import", await readFile(file), true)
  console.log(`siparis kuruldu (özet eşleşti: ${r.hashMatches})`)
}

const existing = (await call("GET", "/runtime/data/siparis/musteri?take=1")).total
if (existing >= COUNTS.musteri) {
  console.log("veri zaten var")
  process.exit(0)
}

const SEHIR = ["İstanbul", "Ankara", "İzmir", "Bursa", "Antalya", "Konya", "Adana", "Gaziantep", "Kayseri", "Eskişehir"]
const SEGMENT = ["kurumsal", "kobi", "bireysel"]
const AD = ["Akıncı", "Demir", "Yıldız", "Çelik", "Öztürk", "Şahin", "Aydın", "Güneş", "Kaya", "Polat", "Arslan", "Doğan"]
const IS = ["Gıda", "Tekstil", "Makine", "Yazılım", "Lojistik", "İnşaat", "Kimya", "Otomotiv", "Enerji", "Tarım"]

const musteriler = []
for (let i = 0; i < COUNTS.musteri; i++)
  musteriler.push(await create("musteri", { unvan: `${AD[i % AD.length]} ${IS[(i * 7) % IS.length]} ${["A.Ş.", "Ltd.", "Tic."][i % 3]} ${i + 1}`, sehir: SEHIR[i % SEHIR.length], segment: SEGMENT[i % 3], aktif: true, notlar: i % 5 === 0 ? "Vadeli çalışır." : null }))
console.log(`${musteriler.length} müşteri`)

const urunler = []
for (let i = 0; i < COUNTS.urun; i++)
  urunler.push(await create("urun", { kod: `U-${String(i + 1).padStart(4, "0")}`, ad: `${IS[i % IS.length]} ürünü ${i + 1}`, birim: ["adet", "kg", "lt"][i % 3], fiyat: 10 + ((i * 37) % 900) / 4 }))
console.log(`${urunler.length} ürün`)

const siparisler = []
for (let i = 0; i < COUNTS.siparis; i++) siparisler.push(await create("siparis", { musteri: musteriler[(i * 13) % musteriler.length], aciklama: `Sipariş ${i + 1}` }))
console.log(`${siparisler.length} sipariş`)

// Two orders with many lines: one below the grid's virtual-scroll threshold (200), one above.
const lines = async (order, count) => {
  for (let i = 0; i < count; i++) await create("kalem", { urun: urunler[i % urunler.length], miktar: 1 + (i % 9), iskonto: (i % 4) * 5, not: i % 6 === 0 ? "Acil" : null }, order)
}
await lines(siparisler[0], COUNTS.buyukKalem)
await lines(siparisler[1], COUNTS.ortaKalem)
for (let i = 2; i < 40; i++) await lines(siparisler[i], 3 + (i % 5))
console.log(`kalemler: ${COUNTS.buyukKalem} + ${COUNTS.ortaKalem} + küçük siparişler`)
console.log(JSON.stringify({ big: siparisler[0], medium: siparisler[1], small: siparisler[5] }))
