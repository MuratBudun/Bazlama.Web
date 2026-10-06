# Ölçüm sonuçları

İleride tekrar ölçünce karşılaştırmak için. Ham veriler `results/<tarih>/` altında (JSON).

## 2026-10-03

Ortam: Ryzen 5 1600X, 32 GB, Windows 11; headless Chrome 154; üretim derlemesi; sunucu aynı makinede (SQLite). Veri: `seed.mjs` (300 müşteri, 120 ürün, 150 sipariş; 400 ve 120 kalemli siparişler). Süreler ms, medyan. Koşudan koşuya %10–15 oynar.

### Uygulama: çizim süreleri (önce → sonra)

"Önce": ölçümün ilk hali. "Sonra": aynı gün yapılan dört düzeltmeden sonra (kabuğun doldurma zinciri `:has()` yerine işaretle; ızgara yükseklik sınırının miras kalmaması; `repeat` yeniden sıralama; statik dosya sıkıştırma ve önbellek). Süre: tıklamadan, ekranın hazır olduğu ilk kareye kadar.

| Senaryo | Normal: önce | sonra | 4× yavaş CPU: önce | sonra |
|---|---|---|---|---|
| Karttan uygulama sekmesi açma | 13 | 13 | 90 | 111 |
| Menüden liste (50 satır) | 63 | 54 | 511 | 349 |
| Listeden başka listeye | 34 | 32 | 215 | 192 |
| Kayıt formu, 7 kalem | 69 | 61 | 464 | 239 |
| Kayıt formu, 120 kalem | 151 | 133 | 1.034 | 550 |
| Kayıt formu, 400 kalem | 320 | 62 | 2.347 | 264 |
| Kayıttan listeye dönüş | 69 | 51 | 515 | 249 |
| Sekme: uygulama → ana sayfa | 15 | 10 | 76 | 48 |
| Sekme: ana sayfa → uygulama | 41 | 30 | 261 | 142 |
| Liste sıralama (sunucuda) | 28 | 22 | 251 | 152 |
| Diyalog açma | 21 | 17 | 141 | 106 |
| Alan değişimi: Yönetim | 33 | 31 | 214 | 163 |

- Yazma (120 kalemli formda): tuş başına ana iş parçacığı 1,8–2,2 ms, JavaScript 0,07 ms (önce ve sonra aynı).
- Stil hesaplama: 50 satırlı liste 30 → 15 ms; 120 kalemli form 71 → 37 ms; 400 kalemli form 156 → 13 ms.
- Sayfa yükleme (ana sayfa): yeni sekmede 190–250 ms, aynı sekmede yenileme 43–65 ms (sonra 52–92 ms).
- İlk yükleme boyutu 379 → 104 KB; Monaco 3,9 → 0,98 MB.
- Geliştirme: çalışma alanı ~110–140 ms; ilk C# dosyası (Monaco yüklenir) 500–650 ms; sonraki sekmeler 45–120 ms.

### Bellek ve sızıntı

| Durum | JS belleği (önce) | sonra |
|---|---|---|
| Ana sayfa | 1,4 MB | 1,7 MB |
| Uygulama sekmesi + 50 satırlı liste | 1,9 MB | 2,2 MB |
| Kayıt formu, 7 kalem | 2,3 MB | 2,5 MB |
| Kayıt formu, 120 kalem | 3,0 MB | 3,3 MB |
| Kayıt formu, 400 kalem | 4,8 MB (4.857 öğe) | 3,0 MB (666 öğe) |
| Geliştirme: Monaco + sekmeler | 17 MB | 17 MB |

Sızıntı döngüleri (liste ↔ kayıt, sekme aç/kapat, sekme geçişi, diyalog, alan değişimi, Geliştirme): hiçbirinde DOM düğümü ya da olay dinleyicisi birikmedi. Runtime'da döngü başına 0–3 KB, Geliştirme'de 7–28 KB büyüme kaldı (kaynağı ayrıştırılmadı).

### Kütüphane kıyaslaması: yerel DOM / Bazlama / React / Mantine

Her uygulama kendi sayfasında, yalnız kendi kodu ve stiliyle. React 19.3, Mantine 9.6.3. Üç koşunun ortancası. Ana iş parçacığı süresi (ms).

| Tablo işlemi | Yerel DOM | Bazlama | React (çıplak) | Mantine |
|---|---|---|---|---|
| 1.000 satır oluştur | 75 | 94 | 99 | 185 |
| 1.000 satırı yenileriyle değiştir | 80 | 103 | 101 | 198 |
| 1.000 satıra 1.000 ekle | 97 | 129 | 122 | 255 |
| 10.000 satır oluştur | 912 | 1.109 | 1.195 | 2.009 |
| Her 10. satırı güncelle | 28 | 31 | 31 | 43 |
| Satır seç | 2,1 | 3,1 | 3,5 | 4,0 |
| İki satırın yerini değiştir | 12 | 12,5 | 73 | 96 |
| Bir satır sil | 14 | 15 | 15 | 28 |
| 1.000 satırı temizle | 7,7 | 11 | 12 | 18 |
| Satır başına JS belleği | 0,13 KB | 1,8 KB | 1,7 KB | 5,0 KB |

"İki satırın yerini değiştir": `repeat` düzeltmesinden önce Bazlama 83 ms'ydi.

Bileşen başına kurulum süresi (µs) ve JS belleği:

| Bileşen | Yerel HTML | Bazlama (`bz-*`) | React (çıplak) | Mantine |
|---|---|---|---|---|
| Düğme | 24 / ~0 | 66 / 5,0 KB | 28 / 0,6 KB | 151 / 3,1 KB |
| Metin alanı | 137 / ~0 | 277 / 17 KB | 159 / 1,5 KB | 375 / 15 KB |
| Onay kutusu | 29 / ~0 | 196 / 14 KB | 49 / 1,4 KB | 390 / 13 KB |
| Seçim kutusu | 277 / ~0 | 509 / 26 KB | 339 / 2,0 KB | 4.033 / 132 KB |
| Rozet | 17 / ~0 | 87 / 4,5 KB | 23 / 0,4 KB | 110 / 1,8 KB |

"React (çıplak)" elle yazılmış yerel öğelerdir (durumlu `<input>`, `<select>`); bileşen kütüphanesi değildir.

İndirme boyutu (gzip): Bazlama, bütün bileşenler 55 KB JS + 16 KB CSS; React 67 KB; React + Mantine (bu 7 bileşen) 118 KB JS + 34 KB CSS.

### Yalnız Bazlama

- Veri ızgarası (8 sütun, 600 px): 100 satır 43 ms; 1.000 – 100.000 satır 17–26 ms (DOM'da 21 satır); kaydırma 60 kare/sn (kare başına 8–9 ms iş); 100.000 satırda sıralama 150–330 ms, bellek 19 MB (verinin kendisi). Sanal kaydırma kapalıyken 1.000 satır 350 ms.
- Signal çekirdeği: 100.000 signal + computed + effect 200 ms (üçlü başına 1,1 KB); 100.000 güncelleme 200 ms; 1 signal → 10.000 effect × 100 güncelleme 360–390 ms; 10 katmanlı computed zinciri × 100.000 güncelleme 420–460 ms.

### Ölçümde öğrenilenler

- Chrome 10 saniyede ~200'den fazla gezinmeyi sessizce düşürür; router her rota değişiminde iki gezinme yapar. Betikler gezinen adımlar arasında bekler.
- Aynı sayfada iki kütüphane birbirini yavaşlatır (React çalıştıktan sonra aynı Bazlama kodu %20–45 yavaş ölçüldü); her biri kendi sayfasında ölçülmeli.
- Sayfa yükleme, yeni bir tarayıcı sürecinde (yeni sekme) 3–4 kat yavaştır; `PERF_BFCACHE=1` bu durumu ölçer.
