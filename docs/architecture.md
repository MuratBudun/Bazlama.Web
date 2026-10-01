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

Üç alan ayrı ürün değil: aynı kernel üzerinde çalışan sistem uygulamalarıdır.

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
2. ✅ **Veri motoru + Runtime:** metadata modeli, metadata → tablo, şema farkı, kapsam filtreli CRUD API, liste ve form ekranlarının metadata'dan çizilmesi. App'ler şimdilik JSON tanımla Management › Uygulamalar'dan kurulur (örnek: `samples/apps/siparis.json`). Açık kalanlar: "yetkili olduğum tüm lokasyonlar" liste görünümü; plant seçilmediğinde plant'a bağlı kayıtlarda kullanıcının plant yetkisine göre süzme; SQLite'ta Türkçe büyük/küçük harf duyarsız arama (yalnız ASCII).
3. ✅ **Kod:** `Bazlama.Sdk` (EntityEvents: Validate/BeforeSave/AfterSave/BeforeDelete, RecordAction + ActionAttribute, IAppContext.Records), metadata'dan tipli entity sınıfları, Roslyn ile deterministik derleme ve yasaklı API denetimi (BZ0001), app başına collectible AssemblyLoadContext (yeniden başlatmadan yeni build), versiyonlu code library'ler, app'in yeni versiyonu kurulunca otomatik yeniden derleme. Development: Monaco (yalnız C# ve editör çekirdeği, tembel yükleme), sunucu tanılaması, Roslyn ile tamamlama, Runtime formunda eylem düğmeleri. Açık kalanlar: kod çalışma zamanında sınırsız döngüyü durduramaz (istek zaman aşımına uğrar, iş parçacığı sürebilir); app kodu yalnız okuyabilir (Records), başka kayıt yazamaz.
4. **Development + paketleme:** entity/liste/form tasarımcıları, taslak/publish, `.bzapp` export/import, ortam modları. Sonunda yukarıdaki senaryo uçtan uca çalışır.

**Prototip sonrası:** iş akışı, e-posta, zamanlayıcı, raporlama, LDAP/OIDC, ekler/notlar/ilişkiler, numaralandırma, revizyonlar (bkz. `qmex-analysis.md`).

## Geliştirme ortamı

- Web arayüzü `@bazlama/*` paketlerini derlenmiş paket olarak değil, komşu repodaki kaynak dosyalarından alias ile kullanır: `../Bazlama.Web.Component/next/packages/*` (iki repo aynı üst dizinde olmalı). Paketler yayınlanınca npm bağımlılığına çevrilir.
- MSSQL ve PostgreSQL testleri Testcontainers ile yazılır; Docker yoksa atlanır. Şimdilik testler SQLite ile koşar.

## Açık sorular

(Şu an yok.)
