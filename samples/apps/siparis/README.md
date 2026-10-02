# Sipariş Takibi (örnek uygulama)

Müşteriler, ürünler, siparişler ve sipariş kalemleri. Tanım (`app.json`), uygulama kodu (`code/`) ve kullandığı kod kütüphanesi (`libs/ortak/1.0.0/`) kaynak dosyaları olarak burada durur; `tests/Bazlama.Tests/SampleApps/SampleAppTests.cs` her test koşusunda paketleyip kurar ve kuralları dener.

## Klasör

```
app.json                         tanım (versiyonu paketin versiyonu)
code/Musteri/MusteriEvents.cs    müşteri olayları
code/Urun/UrunEvents.cs          ürün olayları
code/Siparis/SiparisKurallari.cs durum geçişleri ve toplam (ortak kurallar)
code/Siparis/SiparisEvents.cs    sipariş olayları
code/Siparis/KalemEvents.cs      kalem olayları
code/Siparis/SiparisEylemleri.cs formdaki düğmeler: Onayla, Sevk et, Taslağa al, İptal et
libs/ortak/1.0.0/                Ortak kütüphanesi: Kimlik, Tutar, Metin
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

## Kurmak

Paket üret (sunucunun klasöründe):

```powershell
.\Bazlama.Host.exe pack-app <repo>\samples\apps\siparis
```

`siparis-2.0.0.bzapp` oluşur; **Yönetim › Uygulamalar › Paket içe aktar** ile kurulur. İçe aktarma, uygulamanın geliştirme çalışma alanındaki kodu ve taslağı paketteki ile değiştirir.

Geliştirmek için: Geliştirme'de uygulamayı açın, değiştirip yayınlayın; kaynak dosyalarını güncel tutmak için değişiklikleri buraya da taşıyın (Gezgin › app.json ve kod dosyaları).
