# Performans ölçümleri

Arayüzün gerçek bir Chrome'da (headless, DevTools protokolü) ölçülmesi. Bağımlılık yok: Node 22+ ve kurulu Chrome yeter. Ölçümler atılabilir bir kurulumda yapılır (veri üretir).

## Hazırlık

```bash
# 1. Atılabilir bir kurulum (boş veritabanı) ve örnek uygulamanın paketi
dotnet publish src/Bazlama.Host -c Release -o <klasör>
cd <klasör>
./Bazlama.Host pack-app <repo>/samples/apps/siparis .
ASPNETCORE_URLS=http://127.0.0.1:5420 Platform__CookieName=bazlama.perf ./Bazlama.Host

# 2. İlk kurulum + örnek uygulama + veri (300 müşteri, 120 ürün, 150 sipariş; 400 ve 120 kalemli siparişler)
cd web
PERF_PASSWORD=<parola> node perf/seed.mjs <klasör>/siparis-2.0.0.bzapp
```

## Uygulama senaryoları: `perf/app.mjs`

```bash
PERF_PASSWORD=<parola> node perf/app.mjs                       # hepsi (~6 dk)
PERF_PASSWORD=<parola> node perf/app.mjs --sections=actions --throttle=4
PERF_PASSWORD=<parola> node perf/app.mjs --sections=css        # stil süresi hangi seçicilerde
PERF_PASSWORD=<parola> node perf/app.mjs --sections=dev --identity   # dosyalar sıkıştırılmadan istenir (sıkıştırmanın bu bağlantıdaki etkisi)
PERF_BFCACHE=1 PERF_PASSWORD=<parola> node perf/app.mjs --sections=loads   # her yükleme yeni bir süreçte (yeni açılan sekme gibi)
```

Bölümler: `loads` (sayfa yükleme), `actions` (çalışan uygulamada gezinme), `typing` (formda yazma), `dev` (Geliştirme, Monaco), `memory`, `leaks` (aynı döngü çok kez; tam GC'den sonra kalan), `css` (iz kaydıyla en pahalı seçiciler).

Sütunlar (medyan, ms): `painted` eylemden, arayüz beklenen duruma geldikten sonraki ilk kareye kadar (kullanıcının beklediği süre); `api` bunun `/api` isteklerinde geçen kısmı; `script`, `stil`, `yerleşim` ana iş parçacığının CPU süreleri.

Dikkat: Chrome 10 saniyede ~200'den fazla gezinmeyi sessizce düşürür ve router her rota değişiminde iki gezinme yapar (iptal eder, sayfayı hazırlar, yeniden başlatır). Betik bu yüzden gezinen adımların arasında kısa bekler; beklemeler ölçülen sürenin dışındadır.

## Bileşen kütüphanesi kıyaslaması: `perf/bench.mjs`

Aynı işin ölçümü: düz DOM çağrıları (`vanilla`: tarayıcının yapabileceği en azı) ve `@bazlama/*` (`bazlama`). İstenirse React (çıplak yerel öğelerle) ve Mantine (bir React bileşen kütüphanesi; `bz-*` bileşenlerinin asıl dengi) de eklenir.

Ölçülenler: tablo işlemleri (oluştur, değiştir, kısmi güncelle, seç, takas, sil, ekle, temizle), 1.000 bileşenin maliyeti, veri ızgarası (100 – 100.000 satır, kaydırma, sıralama; yalnız Bazlama) ve signal çekirdeği. Her uygulama kendi sayfa yüklemesinde, yalnız kendi kodu ve stil dosyasıyla ölçülür.

```bash
npx vite build --config perf/vite.config.ts        # perf/dist (parça boyutları çıktıda)
cp -r perf/dist <klasör>/wwwroot/bench             # ya da herhangi bir statik sunucu
BENCH_URL=http://127.0.0.1:5420/bench/index.html node perf/bench.mjs
BENCH_URL=… node perf/bench.mjs --sections=table,components --impls=bazlama,mantine
```

Koşudan koşuya %10–15 oynar: karşılaştırma için birkaç koşunun ortancasını alın.

### React ve Mantine (isteğe bağlı)

Projenin hiçbir `package.json` dosyasında yokturlar. Karşılaştırmak için geçici kurulur; `--no-save` sayesinde `package.json` ve `package-lock.json` değişmez:

```bash
cd web
npm install --no-save react react-dom @mantine/core @mantine/hooks
npx vite build --config perf/vite.config.ts        # şimdi react-impl ve mantine-impl de derlenir
# … sayfayı kopyalayıp bench.mjs'i çalıştırın …
npm ci                                             # bitince: node_modules kilit dosyasındaki haline döner
```

Kurulu değillerken sayfa yine derlenir (`perf/vite.config.ts` yerlerine boş birer modül koyar) ve `bench.mjs` "Ölçülmüyor (kurulu değil): react, mantine" deyip yalnız `vanilla` ile `bazlama`yı ölçer. Temizlik için `npm prune` kullanmayın: kilit dosyasını yeniden yazıyor.

## Sonuçlar

`RESULTS.md`: son ölçümün özeti (tablolar). `results/<tarih>/`: o günün ham JSON çıktıları (`--json=` ile yazılır). Yeni bir ölçümde yeni bir tarih klasörü açıp `RESULTS.md`'ye yeni bir bölüm ekleyin.
