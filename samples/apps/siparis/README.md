# Sipariş Takibi (örnek uygulama)

Müşteriler, ürünler, siparişler ve sipariş kalemleri. Tanım (`app.json`), uygulama kodu (`code/`) ve kullandığı kod kütüphanesi (`libs/ortak/1.1.0/`) kaynak dosyaları olarak burada durur; `tests/Bazlama.Tests/SampleApps/SampleAppTests.cs` her test koşusunda paketleyip kurar ve kuralları dener.

## Klasör

```
app.json                         tanım (versiyonu paketin versiyonu)
code/Musteri/MusteriEvents.cs    müşteri olayları
code/Urun/UrunEvents.cs          ürün olayları
code/Siparis/SiparisKurallari.cs durum geçişleri ve toplam (ortak kurallar)
code/Siparis/SiparisEvents.cs    sipariş olayları
code/Siparis/KalemEvents.cs      kalem olayları
code/Siparis/SiparisEylemleri.cs formdaki düğmeler: Onayla, Sevk et, Taslağa al, İptal et
code/Siparis/SiparisFormu.cs     sipariş formunun Araçlar menüsü (altı araç)
code/Musteri/MusteriFormu.cs     müşteri formunun Araçlar menüsü (üç araç)
code/Siparis/Ozetler.cs          iki formun kullandığı sipariş özeti
code/Modallar/*Kodu.cs           modalların kendi kodları (açılış değerleri, onayda denetim)
libs/ortak/1.1.0/                Ortak kütüphanesi: Kimlik, Tutar, Metin, Sor (modalı anahtarıyla açar)
```

## Kurallar

| Nerede | Ne |
| --- | --- |
| Müşteri | Vergi no 10 haneli VKN ya da 11 haneli TC kimlik no olmalı (denetim haneleriyle); aynı numara ikinci müşteride olamaz. Unvan sadeleşir, şehir Türkçe başlık biçimine girer ("iSTANBUL" → "İstanbul"); yeni müşteri aktif başlar. |
| Ürün | Kod büyük harfe çevrilir (Türkçe: "ı" → "I") ve tekildir; fiyat eksi olamaz. |
| Sipariş | Numara boşsa `S-<yıl>-<sıra>` verilir (lokasyon içinde); tarih boşsa bugün, durum taslak. Teslim tarihten önce olamaz; pasif müşteriye sipariş açılmaz. Toplam, kalemlerin tutarlarından her kaydedişte hesaplanır. |
| Durum | taslak → onaylandı → sevk edildi; taslak ve onaylı sipariş iptal edilebilir, onaylı sipariş taslağa alınabilir. Kalemi olmayan sipariş onaylanmaz. Sevk edilmiş ya da iptal edilmiş sipariş değiştirilemez; yalnız taslak sipariş silinir. |
| Kalem | Birim fiyat boşsa ürünün liste fiyatı gelir; tutar = miktar × fiyat − iskonto (kuruşa yuvarlanır). Miktar sıfırdan büyük, iskonto 0–100. Kalemler yalnız sipariş taslakken eklenir, değişir, silinir. |

Kurallar formdan da eylem düğmesinden de aynı yoldan geçer: bir eylem kaydı değiştirip `ActionResult.Save` döndüğünde doğrulama ve kaydetme olayları yine çalışır.

## Formların araçları ve modal örnekleri

Formların sağ üstündeki **Araçlar** menüsü formun kod sınıfındaki metotları çağırır; metot formun ekrandaki halini alır (kaydedilmemiş de olsa). Her araç modalların başka bir kullanımını gösterir:

| Araç | Modal | Ne gösterir |
| --- | --- | --- |
| Sipariş › Teslim tarihini öner | — | Modalsız araç: sipariş tarihinden üç iş günü sonrasını teslim zamanına yazar. Yeni, kaydedilmemiş siparişte de çalışır; kaydetmek kullanıcıya kalır. |
| Sipariş › Müşteri özeti | Tarih aralığı | Açan kodun verdiği açılış değerleri (siparişin ayı). Sonuç bir mesajdır. |
| Müşteri › Sipariş özeti | Tarih aralığı | Aynı modal başka formdan; açılış değerlerini bu kez modalın kendi kodu verir (bu ay). |
| Sipariş › Not ekle | Sipariş notu | Seçim, uzun metin ve onay kutusu. Girilen forma yazılır (açıklamaya eklenir), kaydedilmez. |
| Sipariş › Teslimatı planla | Teslimat planı | Tarih-saat ve alanlar arası kural (kargo seçilince kargo firması zorunlu; modalın kodu). Araç `ActionResult.Save` döner: form kaydedilir. Araç modal onaylandıktan sonra hata dönerse modal açık kalır. |
| Sipariş › Müşteriyi değiştir | Müşteri seç | Modalda kayıt seçimi (referans alanı). Modalın kodu kayıt okur: pasif müşteri seçilemez. Formdaki müşteri alanı yeni müşteriyi gösterir. |
| Sipariş › Nedeniyle iptal et | İptal nedeni | Neden sorup durumu değiştirir ve kaydeder; "Diğer" seçilince açıklama zorunlu. |
| Müşteri › Sipariş sayısı (kütüphaneden) | Tarih aralığı | Modalı kod kütüphanesi açar: `Ortak.Sor.AralikAsync(context, "tarih_araligi", …)` uygulamanın sınıflarını bilmez, modalı anahtarıyla açar. |
| Müşteri › Kapsam seçimi (örnek) | Kapsam seçimi | Firma, lokasyon, plant ve dönem seçicileri ile tarih aralığı, iki bölümde. Çalışma bağlamıyla açılır; lokasyonlar seçili firmaya göre süzülür. İleride rapor ve iş tanımları kapsamı böyle soracak; örnek seçileni özetler. |

Modallar `app.json` › `modals` altında bir kez tanımlıdır; "Tarih aralığı" üç araçtan açılır.

## Kurmak

Paket üret (sunucunun klasöründe):

```powershell
.\Bazlama.Host.exe pack-app <repo>\samples\apps\siparis
```

`siparis-2.1.0.bzapp` oluşur; **Yönetim › Uygulamalar › Paket içe aktar** ile kurulur. İçe aktarma, uygulamanın geliştirme çalışma alanındaki kodu ve taslağı paketteki ile değiştirir.

Geliştirmek için: Geliştirme'de uygulamayı açın, değiştirip yayınlayın; kaynak dosyalarını güncel tutmak için değişiklikleri buraya da taşıyın (Gezgin › app.json ve kod dosyaları).
