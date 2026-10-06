# Bazlama Platform: mimari taslağı

Durum: taslak (2026-10-01). Kararlar ve açık sorular bu dosyada tutulur.

**Hedef:** minimum özelliklerle bir app geliştirilebilen bir **prototip**. Uzun vadede QMEX modüllerinin bu platform üzerinde app olarak yazılabilmesi akılda tutulur ama prototipin amacı bu değildir; QMEX'ten çıkan ihtiyaçlar `qmex-analysis.md` dosyasında referans olarak durur.

## Kararlar

| Konu | Karar |
|---|---|
| Platform | .NET 10 (LTS), ASP.NET Core, tek host, modüler monolit |
| Veritabanı | MSSQL, PostgreSQL, SQLite (üçü de birinci sınıf, CI'da üçü de test edilir) |
| Kiracı | Çok kiracı yok |
| Kurum yapısı | Firma → Lokasyon → Plant, sabit üç seviye (ağaç değil). Dönem firmaya bağlı |
| Uygulama verisi | Metadata'dan üretilen gerçek tablolar |
| Özel mantık | Sadece sunucu tarafı, C#. Roslyn ile derlenir, app başına DLL |
| Ortak kod | Versiyonlu code library'ler; app'ler belirli bir versiyona bağlanır |
| Kod editörü | Monaco, sadece ihtiyaç duyulan kadarı |
| Dağıtım | On-prem. Development → publish → export → başka ortama import |
| Arayüz | `@bazlama/*` web component paketleri (`Bazlama.Web.Component/next`) |
| Prototip dışı | İş akışı, e-posta, zamanlayıcı, raporlama, LDAP/OIDC, QMEX geçişi |

## Prototipin bitti sayılma senaryosu

1. Development ortamında bir geliştirici yeni bir app açar.
2. İki entity tanımlar (ana-detay, ör. `Order` + `OrderLine`), birinin kapsamı `Location` olsun.
3. Liste ve form ekranlarını tanımlar.
4. Monaco'da C# ile bir doğrulama (`Validate`) ve bir form butonu eylemi yazar; derleme hataları editörde işaretlenir.
5. Ortak bir fonksiyonu bir code library'ye koyar ve app'ten kullanır.
6. App'i publish eder (v1.0.0) ve `.bzapp` olarak export eder.
7. **Farklı veritabanı provider'ı kullanan** ikinci bir kurulumda (ör. dev SQLite, test PostgreSQL) import eder; tablolar oluşur, kod derlenir.
8. Bir alan ekleyip v1.1.0 yayınlar; ikinci kurulumda import şema farkını gösterir ve uygular, host yeniden başlamaz.
9. Yetkisi olan kullanıcı app'i Runtime'da kullanır; yetkisi olmayan göremez. Kayıtlar aktif firma/lokasyona göre filtrelenir.

## Genel yapı

```
┌──────────────────────────────────────────────────────────────────┐
│  Development            │  Runtime              │  Management       │
│  entity, liste, form    │  yayınlanmış app'leri  │  kullanıcı, grup, │
│  tasarımı, Monaco +     │  metadata'dan çizer,   │  firma/lokasyon/  │
│  C#, library, publish,  │  derlenmiş kodu        │  plant/dönem, app │
│  export                 │  çalıştırır            │  import, audit    │
├──────────────────────────────────────────────────────────────────┤
│  Kernel: Identity · MFA · Gruplar/İzinler · Kurum bağlamı ·         │
│  Metadata Store · Veri motoru · Derleyici · Paketleme · Audit       │
├──────────────────────────────────────────────────────────────────┤
│  SQL lehçeleri: SqlServer │ PostgreSql │ Sqlite                     │
└──────────────────────────────────────────────────────────────────┘
```

Üç alan ayrı ürün değil: aynı kernel üzerinde çalışan sistem uygulamalarıdır. Arayüzde ise keskin biçimde ayrılırlar; her birinin kendi çerçevesi vardır ve başlıktaki alan düğmeleriyle (yetki varsa) aralarında geçilir:

- **Runtime** (`#/`): ana sekmede uygulamalar kart olarak (arama, son kullanılanlar); bir kart uygulamayı kendi sekmesinde açar. Uygulama sekmesinde solda uygulamanın menüsü, sağda listeleri ve kayıtları; gezinme sekmenin içinde kalır. Sekmeler arasında geçince sayfalar canlı kalır (yarım kalan form kaybolmaz); adres çubuğu etkin sekmeyi gösterir; aynı uygulama ikinci kez açılmaz. Sekmeler sayfa yenilenince geri gelmez. QMEX'ten esinlenildi (kart ana ekran, sekmeler), iç içe sekme şeritleri alınmadı.
- **Development** (`#/development`): tam pencere bir IDE: gezgin, sekmeli editörler, Sorunlar paneli. Tasarımcı sekmeleri iki görünümlüdür: **Tasarım** (görsel tasarımcı) ve **Kod** (aynı parçanın JSON'u, Monaco'da; taslaktan üretilen şemayla otomatik tamamlama ve denetim). İkisi aynı taslağı düzenler. Gezgindeki `app.json` tanımın tamamıdır.
- **Management** (`#/management`): yan menülü sistem ekranları.

## Kimlik ve yetki (Faz 1)

- Yerel kullanıcılar. Parola: ASP.NET Core Identity'nin `PasswordHasher`'ı; politika (min uzunluk, karmaşıklık, süre, geçmiş), hesap kilitleme, ilk girişte parola değiştirme, yönetici tarafından sıfırlama.
- MFA: TOTP + recovery code. Passkey ve e-posta OTP sonraya.
- Oturum: cookie tabanlı (aynı origin), antiforgery, oturum listesi ve yöneticinin oturum sonlandırması.
- Arayüz: `bz-login` (2FA adımı hazır), `bz-password`.
- **Gruplar = roller.** İzinler string anahtarlardır (`system.users.manage`, `app.<appKey>.<entity>.read` …). Kernel izinleri sabit; app izinleri app kurulunca kaydolur. Grup üyeliği isteğe bağlı olarak lokasyona bağlanabilir.
- Yetki her zaman sunucuda kontrol edilir; arayüz sadece yansıtır.

## Kurum yapısı ve bağlam

- **Firma → Lokasyon → Plant:** üç sabit seviye, her biri bir üstüne FK ile bağlı. Ağaç (serbest derinlik) yok. Plant isteğe bağlıdır; bir lokasyonun plant'ı olmayabilir.
- **Dönem:** firmaya bağlı (`CompanyId`, başlangıç/bitiş tarihi, açık/kapalı). Bağlam seçicide sadece `PeriodBound` entity'si olan bir app açıkken görünür.
- **Kullanıcı ataması:** kullanıcıya firma, lokasyon ve plant yetkileri verilir.
- **Oturum bağlamı:** kullanıcı girişte (ya da başlıktaki seçiciden) firma, lokasyon, plant ve dönem seçer; seçim hatırlanır. Her istek bu bağlamla çalışır.
- **Entity kapsamı metadata'da:** `Global` | `Company` | `Location` | `Plant`, ayrıca `PeriodBound`. Veri motoru ilgili kolonları, FK'leri ve indeksleri ekler, filtreyi kendisi uygular; app kodu filtreyi unutamaz.
- **Yazma** aktif bağlama yapılır. **Okuma** varsayılan olarak aktif bağlam; yetkisi olan kullanıcı listede "yetkili olduğum tüm lokasyonlar" görünümüne geçebilir.
- Kapalı döneme yazma kernel'de engellenir.

## Veri motoru

- Sistem tabloları EF Core 10 ile; migration'lar provider başına ayrı assembly'de.
- App tabloları metadata'dan üretilir: `app_<appKey>_<entity>`.
- **Standart kolonlar:** `Id` (Guid v7), kapsam kolonları, `CreatedAt/By`, `UpdatedAt/By`, `IsDeleted`, `RowVersion`. Zamanlar UTC.
- **Prototipte alan tipleri:** metin, uzun metin, tam sayı, ondalık, tarih, tarih-saat, boolean, seçim (sabit liste), referans (başka entity'ye FK), alt tablo (ana-detay).
- **Şema farkı:** yeni versiyon kurulurken eski ve yeni metadata karşılaştırılır, DDL planı çıkar. Yıkıcı değişiklikler açık onay ister. SQLite için tablo yeniden kurma yolu.
- Sorgular kendi sorgu modelimizden lehçe başına SQL'e çevrilir; her zaman parametreli.
- Kimlikler Guid v7: ortamlar arası export/import'ta öğelerin tanınması ve çakışmaması için; zaman sıralı olduğu için indeks dostu.

## Sunucu tarafı C# kodu

**SDK (`Bazlama.Sdk`):** app kodunun gördüğü tek sözleşme. Prototipte:
- Entity olayları: `Validate`, `BeforeSave`, `AfterSave`, `BeforeDelete`
- Ekran eylemleri (form/liste butonları)
- `IDataContext` (kapsam ve yetki uygulanmış veri erişimi), `ICurrentContext` (kullanıcı, firma, lokasyon, plant, dönem)
- Metadata'dan **tipli entity sınıfları üretilir**; kullanıcı kodu bunlarla birlikte derlenir

**Derleme:** Roslyn, deterministik. App kodu + üretilen entity sınıfları + referans verilen library versiyonları → tek DLL.

**Yükleme:** her app versiyonu kendi collectible `AssemblyLoadContext`'inde. Yeni versiyon gelince istekler yeni ALC'ye geçer, eskisi boşaltılır; host yeniden başlamaz. Kernel, app tiplerine referans tutmaz.

**Code library:** entity içermeyen, versiyonlu ortak kod. App manifest'i library'yi versiyonuyla referans verir; library app'in ALC'sine yüklenir.

**Güvenlik:** kodu güvenilir geliştiriciler yazar (.NET'te gerçek sandbox yok). Derleme izinli referans setine karşı yapılır, yasaklı API'ler (`System.IO`, `Process`, `Reflection.Emit` vb.) analyzer ile derleme hatasıdır, her çağrıda zaman aşımı vardır.

## Kod editörü (Monaco)

Amaç tam bir IDE değil; bir app'i yazmaya yetecek kadar.

**Prototipte:**
- C# sözdizimi renklendirme (Monaco'nun hazır `csharp` tanımı), açık/koyu tema `@bazlama/themes` token'larından.
- Dosya listesi (app'in kod dosyaları), sekmeler, kaydet (Ctrl+S).
- **Sunucuda Roslyn ile tanılama:** yazmayı bıraktıktan kısa süre sonra kod sunucuya gönderilir, hata/uyarılar editörde işaretlenir (`setModelMarkers`), Problemler listesi.
- **Basit tamamlama:** SDK tipleri ve üretilen entity sınıfları için Roslyn `CompletionService` üzerinden (`registerCompletionItemProvider`). Bu Faz 3'ün sonunda; renklendirme + tanılama önce gelir.

**Kapsam dışı:** hata ayıklama (debugger), refactoring, git entegrasyonu, çoklu imleç gibi gelişmiş ayarlar, TypeScript/JSON worker'ları.

**Paketleme:** Monaco yalnızca Development alanında, ilk açılışta tembel (lazy) yüklenir; sadece editör çekirdeği ve C# dili alınır, diğer diller ve worker'lar pakete girmez. Runtime ve Management sıfır bağımlılık ilkesini korur.

## Form, modal ve sayfa tasarımı

Üç tanım türü, tek tasarımcı yapısı (palet | tuval | özellik düzenleyici):

- **Form:** mutlaka bir entity'ye bağlıdır, onun bir kaydını düzenler. Palet o entity'nin alanlarını sunar (her alan forma en fazla bir kez konur) ve "Bölüm" bileşenini. Yerleşim modeli: bölüm (başlık, 1–3 sütun) + alanlar; alan başına genişlik (`span`: bölümün kaç sütununu kaplar, `bz-form-layout`'un `data-span`'ı). Tanımda alan, anahtarı ya da `{ "field": "aciklama", "span": 2 }` olarak yazılır. Etiket, tip ve zorunluluk entity'dedir; form yalnız yeri ve genişliği belirler. ✅ Tasarımcı yapıldı (tıklama, sürükle-bırak, klavye; Kod görünümü aynı tanımın JSON'u).
- **Modal:** entity'den bağımsız, kendi alanları olan, yeniden kullanılabilir popup tanımı (ör. tarih aralığı ve firma/lokasyon/dönem seçimi). Bir kez tanımlanır (`modals[]`), birçok yerden çağrılır. Alan tipleri entity'ninkiler ve yalnız modallarda bulunan kurum seçicileri: `company`, `location`, `plant`, `period` (kullanıcının çalışabildikleri; lokasyon seçili firmaya, plant seçili lokasyona göre süzülür, modalda o alan yoksa çalışma bağlamına göre). Yerleşim formdaki gibidir (bölüm + `span`). ✅ Tanım, tasarımcı (palet alan tipleri sunar; alan modalın kendisinindir, özellikleri orada düzenlenir) ve form araçlarından çağrı yapıldı. ⏳ Sayfa, liste, rapor ve job'dan çağrı o tanımlar gelince.
- **Page:** entity'ye bağlı olmayan, tamamen bağımsız sayfa (ör. dashboard); menüden açılır. Ayrıntısı sonra ele alınacak; ilk sürüm yalnız bir başlangıç. ⏳ Yapılacak.

Koşullu davranış (duruma göre salt okunur / gizli alan, bölüm) iş akışı fazında ele alınacak.

### Formun araçları ve modalların kodu

**Araçlar menüsü.** Formun kendi eylemleri vardır: tanımda `tools[]` (ad, ikon, metot, isteğe bağlı onay sorusu), kayıt formunda "Araçlar" menüsü. Her öğe formun kod sınıfındaki bir metodu çağırır:

```csharp
[Form("siparis")]
public class SiparisFormu : FormCode<Siparis>
{
    public async Task<ActionResult> MusteriOzeti(Siparis record, IAppContext context)
    {
        var aralik = await context.Modals.ShowAsync<TarihAraligi>();   // modal açılır, değerleri döner
        record.Aciklama = $"{aralik.Baslangic:d} – {aralik.Bitis:d}";    // forma geri yazılır
        return ActionResult.Ok("Hazır.");
    }
}
```

- Metoda **formun ekrandaki hali** verilir: kaydedilmemiş değişiklikler dahil, yeni kayıtta `Id` boştur. Metodun değiştirdiği alanlar forma geri yazılır ama **kaydedilmez**; `ActionResult.Save` dönerse form olağan yoldan kaydedilir (doğrulama ve olaylar çalışır). `ActionResult.Fail` formun üstünde gösterilir.
- Kayıt eylemlerinden (`RecordAction<T>`, formdaki düğmeler) farkı: eylem kaydedilmiş kaydı veritabanından alır ve değiştirir; araç ekrandaki formla çalışır.
- Yalnız formun menüsünde tanımlı metotlar çağrılabilir. Derleme tanımı da denetler (**BZ0003**): `[Form]` var olan bir formu ve o formun entity'sini göstermeli, her aracın metodu (`(Kayıt record, IAppContext context)`) bulunmalı. Aracı olan tanım kodsuz yayınlanamaz.

**Modal çağrısı.** Kod modalı `context.Modals` ile açar: uygulama kodu üretilen sınıfla (`ShowAsync<TarihAraligi>(m => m.Baslangic = …)`), uygulamanın sınıflarını bilmeyen **kod kütüphanesi** anahtarla (`ShowAsync("tarih_araligi", başlangıçDeğerleri)` → alan anahtarıyla değerler). Her modal için `_Entities.g.cs` içinde bir sınıf üretilir (`[Modal("tarih_araligi")] class TarihAraligi : ModalValues`).

**Modalın kendi kodu.** `ModalCode<T>` sınıfı: `OpenAsync` açılış değerlerini verir, `ValidateAsync` kullanıcı onayladığında denetler (hata eklenirse modal açık kalır). Zorunlu alanları ve kurum seçimlerinin yetkisini motor denetler.

**Nasıl çalışır (yeniden çalıştırma).** Sunucudaki kod kullanıcıyı beklemez. `ShowAsync` ilk çağrıda çalışmayı keser ve istemciye "şu modalı göster" yanıtı gider; kullanıcı onaylayınca aynı metot **baştan** çalışır, bu kez `ShowAsync` girilen değerleri döner. Sonuçları:
- `ShowAsync`'ten önceki kod iki kez çalışır; orada yan etki olmamalı (kayıt okumak sorun değil; uygulama kodu zaten yalnız okuyabilir).
- Aynı çalıştırmada aynı modal iki kez sorulursa ikisi de aynı yanıtı alır.
- Kullanıcı vazgeçerse metot yeniden çalışmaz.
- Kaydetme ve silme olaylarında (bekleyen bir kullanıcı yok) `ShowAsync` hata verir.

API: `POST /api/runtime/forms/{app}/{form}/tools/{metot}` gövdesi `{ values, id?, parentId?, inputs: { <modal>: { … } } }`; yanıt `{ values, titles, message, save }` ya da `{ modal: { key, values, fieldErrors, errors } }`.

## Versiyon, paket, export/import

**Akış:** Development'ta taslak → **publish** değiştirilemez versiyon (semver) → **export** `.bzapp` → başka kurulumda **import**.

**`.bzapp` paketi (zip):**
```
manifest.json      key, version, minPlatformVersion, sdkVersion,
                   library bağımlılıkları, izinler
metadata/          entity, liste, form, menü (JSON)
code/              C# kaynakları
libs/              (isteğe bağlı) bağımlı library paketleri
hashes.json        dosya özetleri + derlenmiş DLL'in özeti
```

**Import adımları:** doğrulama → platform/SDK uyumu → library bağımlılıkları → şema farkı planı → onay → DDL (MSSQL ve PostgreSQL'de transaction içinde) → derleme (özet karşılaştırması) → ALC değişimi → audit.

**Pakete girmeyenler:** kullanıcılar, grup üyelikleri, ortama özel ayar değerleri.

**Ortam modu:** `Development` | `Test` | `Production`. Test ve Production'da tasarımcı kapalıdır, app'ler sadece import ile değişir. Şema ileri yönlüdür.

**Kaynak klasöründen paket:** bir uygulama kaynak kontrolünde dosya olarak tutulabilir (`app.json`, `code/**/*.cs`, `libs/<anahtar>/<versiyon>/library.json` + `src/**/*.cs`). `Bazlama.Host pack-app <klasör>` veritabanı olmadan derleyip `.bzapp` üretir; özetler, içe aktaran kurulumun kendi derlemesiyle aynı çıkar. Örnek: `samples/apps/siparis/` (kodlu sipariş uygulaması; testler her koşuda paketleyip kurar).

## Solution yapısı

```
src/
  Bazlama.Kernel/               domain: kullanıcı, grup, izin, firma/lokasyon/plant/dönem
  Bazlama.Kernel.Data/          EF Core DbContext (sistem tabloları)
  Bazlama.Data.SqlServer/       EF migration'ları + SQL lehçesi
  Bazlama.Data.PostgreSql/
  Bazlama.Data.Sqlite/
  Bazlama.Engine/               metadata modeli, şema farkı, sorgu modeli, kapsam filtresi
  Bazlama.Sdk/                  app kodunun sözleşmesi (ayrı versiyonlanır)
  Bazlama.Compiler/             Roslyn derleme, tanılama, tamamlama, analyzer, ALC yönetimi
  Bazlama.Packaging/            publish, export, import
  Bazlama.Modules.Identity/     login, MFA, oturum
  Bazlama.Modules.Management/
  Bazlama.Modules.Development/
  Bazlama.Modules.Runtime/
  Bazlama.Host/                 ASP.NET Core 10 giriş noktası
web/                            Vite; shell + üç alan, @bazlama/* paketleri, Monaco (sadece Development)
tests/                          xUnit, Testcontainers (MSSQL, PostgreSQL), SQLite
```

## Fazlar

0. ✅ **İskelet:** solution, host, üç provider, Testcontainers ile CI, web projesinin `@bazlama/*` paketlerine bağlanması, shell.
1. ✅ **Kullanıcı ve giriş:** kullanıcılar, login, parola politikası, kilitleme, TOTP MFA + recovery code, oturumlar, gruplar ve izinler, firma/lokasyon/plant/dönem ve oturum bağlamı, temel audit. Management'ta bu ekranlar.
2. ✅ **Veri motoru + Runtime:** metadata modeli, metadata → tablo, şema farkı, kapsam filtreli CRUD API, liste ve form ekranlarının metadata'dan çizilmesi. App'ler şimdilik JSON tanımla Management › Uygulamalar'dan kurulur (örnek: `samples/apps/siparis/app.json`). Açık kalanlar: "yetkili olduğum tüm lokasyonlar" liste görünümü; plant seçilmediğinde plant'a bağlı kayıtlarda kullanıcının plant yetkisine göre süzme; SQLite'ta Türkçe büyük/küçük harf duyarsız arama (yalnız ASCII).
3. ✅ **Kod:** `Bazlama.Sdk` (EntityEvents: Validate/BeforeSave/AfterSave/BeforeDelete, RecordAction + ActionAttribute, IAppContext.Records), metadata'dan tipli entity sınıfları, Roslyn ile deterministik derleme ve yasaklı API denetimi (BZ0001), app başına collectible AssemblyLoadContext (yeniden başlatmadan yeni build), versiyonlu code library'ler, app'in yeni versiyonu kurulunca otomatik yeniden derleme. Development: Monaco (yalnız C# ve editör çekirdeği, tembel yükleme), sunucu tanılaması, Roslyn ile tamamlama, Runtime formunda eylem düğmeleri. Açık kalanlar: kod çalışma zamanında sınırsız döngüyü durduramaz (istek zaman aşımına uğrar, iş parçacığı sürebilir); app kodu yalnız okuyabilir (Records), başka kayıt yazamaz.
4. 🚧 **Development + paketleme:** Geliştirme'de yeni uygulama, taslak tanım (`sys_app_drafts`) üzerinde entity/alan/liste/form tasarımcıları; kod denetimi ve tamamlama taslağa göre yapılır. Yayınla: versiyon seçilir, şema planı ve kodun yeni tanımla derlenip derlenmediği gösterilir, derlenmiyorsa yayınlanmaz. `.bzapp` (zip: manifest.json + SHA-256 özetleri, metadata/app.json, code/, libs/<key>/<versiyon>/): dışa aktarma kurulu versiyonu ve etkin build'in kodunu/kütüphanelerini alır; içe aktarma önizlemesi şema planı, kütüphane durumu (yeni/kurulu/çakışma) ve kodun bu kurulumda derlenmesini gösterir, kurulumdan sonra derlenen kodun özeti paketteki özetle karşılaştırılır. Development dışındaki ortamlarda uygulamalar yalnız paketle kurulur. Açık kalanlar: başka DB provider'lı kurulumda uçtan uca deneme (Docker yok), uygulamalar arası bağımlılıklar, tasarımcıda sürükle-bırak form düzeni.
   - **Geliştirme çalışma alanı:** uygulama başına tek ekran (`<bazlama-workbench>`): gezgin (Uygulama, Entity'ler, Formlar, Kod, Kütüphaneler, Üretilen), sekmeli editörler (entity: alanlar + özellikler paneli; form: bölümler + Runtime önizlemesi; C#: Monaco), Sorunlar paneli. Formlar ve listeler uygulama düzeyindedir (`forms`, `lists`): bir entity'nin birden çok formu ve listesi olabilir ya da hiç olmayabilir (Runtime o zaman bütün alanları / ilk altı alanı gösterir); liste, kayıtlarının açılacağı formu seçer. Uygulama menüsü (`menu`) gruplar (en fazla üç seviye) ve bir listeyi ya da yeni kayıt formunu açan öğelerden oluşur; menü yoksa her ana entity için bir öğe gösterilir. Runtime menüyü okuma yetkisine göre süzer. Eski `entities[].form` / `entities[].list` biçimi okunurken taşınır. **Önizleme:** Geliştirme'de "Önizle", kaydedilmiş taslağı ve kodu uygulamanın önizleme anahtarına (`<app>_pv`, ayrı tablolar) kurar ve yeni sekmede yalnız uygulamanın menüsüyle açar; kayıtlar gerçek veri motorunda saklanır, C# kodu çalışır, yayındaki uygulamaya dokunulmaz. Önizleme verisi atılabilirdir (tip/kapsam değişikliğinde tablolar baştan kurulur). Sıradaki: form tasarımı.

**Prototip sonrası:** iş akışı, e-posta, zamanlayıcı, raporlama, LDAP/OIDC, ekler/notlar/ilişkiler, numaralandırma, revizyonlar (bkz. `qmex-analysis.md`).

## Geliştirme ortamı

- Web arayüzü `@bazlama/*` paketlerini derlenmiş paket olarak değil, komşu repodaki kaynak dosyalarından alias ile kullanır: `../Bazlama.Web.Component/next/packages/*` (iki repo aynı üst dizinde olmalı). Paketler yayınlanınca npm bağımlılığına çevrilir.
- MSSQL ve PostgreSQL testleri Testcontainers ile yazılır; Docker yoksa atlanır. Şimdilik testler SQLite ile koşar.

## Açık sorular

(Şu an yok.)
