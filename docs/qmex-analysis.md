# QMEX analizi (referans)

Durum: 2026-10-01. Bu dosya ileride QMEX modüllerini platforma taşımak için referanstır; prototip kapsamını belirlemez (bkz. `architecture.md`). Kaynak: `C:\Projects\qmex\qmex-2-7-0`, DB: `C:\Projects\qmex\qmex-db-2-7-0`.

## Genel bulgular

QMEX zaten kendi içinde bir low-code çekirdek taşıyor ("BMAS": `bmas_*` tabloları, `App_Code/BMASWebApp`, `bmas_sys`). Modüllerin çoğu bu çekirdek üzerine tablo + sayfa + iş akışı tanımı. Yeni platform BMAS'ın genelleştirilmiş, veritabanından bağımsız ve metadata'yı gerçekten çalıştıran halidir.

**Sayılar:** 445 tablo (412'sinde firma/lokasyon/dönem kolonu), 348 view, 212 procedure, 105 function; ~900 aspx sayfası, 20 modül klasörü.

**Bütün modüllerde tekrar eden ekran kalıbı:** liste + taslaklarım listesi → sekmeli form (başlık: numara, tarih, durum) → kontrol listesi, ekler, ilişkili kayıtlar, bilgilendirilen kullanıcılar, alt eylemler (sorumlu, termin, kalan gün), etkinlik değerlendirmesi → iş akışı onayı. Ayrıca her `_def_` tablosu için parametre listesi + formu, gruplu raporlar, grafik ve yıllık plan/takvim.

**Modüller arası akış:** iç/dış/tedarikçi denetimi ve risk analizi bulguları → CAPA; şikayet ↔ farmakovijilans; değişiklik kontrolü → doküman ve artwork; doküman → eğitim (okudum-anladım); PRM (malzeme, parti, firma, rehber) ve EIS (çalışan, organizasyon) herkesin ortak verisi.

**Korunacak işlevsel sözleşme:** login/MFA politikaları, firma/lokasyon/dönem kapsamı, grup bazlı modül/menü/alan/kayıt yetkisi, vekâlet, veri güdümlü iş akışı (koşulla seçilen akış, adım kullanıcıları, imza için yeniden kimlik doğrulama, adıma göre alan kuralları), silme dahil kim-ne-zaman audit, form geçmişi, seçim listeleri, ek alanlar, dinamik grid/raporlar, ekler, e-posta şablon/kuyruğu, zamanlayıcı, modül lisansı, eklenti modeli (qmex-api plugin yapısı yeni kernel'e örnek).

**Tekrarlanmayacak borçlar:**

| QMEX'te | Platformda |
|---|---|
| İş akışı, eylemler, işler T-SQL'de (cursor, dinamik SQL, `FOR XML`) | Tüm mantık C#'ta; SQL sadece veri motorundan, parametreli |
| Kapsam kolonlarında FK yok, filtre view/grid alışkanlığıyla | Kapsam veri motorunda zorunlu, FK'li |
| Yetki UI kontrollerine reflection ile uygulanıyor; mobil API sayfayı sahte context'te çalıştırıyor | Yetki ve alan kuralları sunucuda, API seviyesinde; UI sadece yansıtır |
| Koşullar ve eylem parametrelerinde serbest SQL metni | Tipli koşul/ifade modeli; gerisi app C# kodu |
| Trigger/temporal tablo audit; silen kullanıcı bilinmiyor | Uygulama katmanında audit olayı (EF interceptor + veri motoru), silme dahil |
| Onay tek uzun transaction içinde mail ve PDF üretiyor | Onay kısa transaction; mail/PDF outbox ile commit sonrası iş kuyruğunda |
| `MAX(no)+1` numaralandırma | Kilitli sayaç tablosu ile numaralandırma servisi |
| Türkçe kaynak metin çeviri anahtarı; dil `app_name()` içinde | Anahtar tabanlı i18n; dil açık istek bağlamında |
| Yerel saat `DATETIME`, 'E'/'H' boolean, alias UDT'ler | UTC + lokasyon saat dilimi, gerçek boolean, standart tipler |
| Satır başına 15 audit kolonu (kopyalanmış ad/e-posta) | Kullanıcı FK + UTC zaman |
| Kodda sabit şifreleme anahtarı, MD5 kayıt özeti, config'te parolalar | Data Protection API, SHA-256/HMAC, sırlar ayrı saklanır |
| 13 modülde kopyalanmış soru/kontrol listesi tabloları | Tek kontrol listesi motoru |


## Uzun vadede kernel servisleri (QMEX ihtiyaçlarından)

QMEX'te 3'ten fazla modülün kullandığı her şey kernel'e alınır. App'ler bunları metadata ile kullanır, SDK ile genişletir.

**Kimlik ve güvenlik**
- Kimlik kaynakları: yerel kullanıcı, LDAP/AD (çoklu domain), OIDC (Entra ID vb.). Harici kullanıcı çalışan kartına eşlenir.
- Parola politikası (uzunluk, karmaşıklık, süre, geçmiş), kilitleme (kullanıcı/IP), parola sıfırlama, ilk girişte değiştirme.
- MFA: TOTP, e-posta OTP, recovery code, passkey; zorunluluk herkes/grup bazlı; cihazı hatırla.
- Oturumlar: kanal (web/mobil/API), yöneticinin oturum sonlandırması, tek oturum seçeneği. API için kişisel erişim token'ı.
- Gruplar = roller (LDAP grubuna eşlenebilir). Yetki katmanları: app lisansı → app erişimi → menü → ekran/eylem izni → alan kuralı (grup ve iş akışı adımına göre görünür/düzenlenebilir/zorunlu) → kayıt erişimi (kapsam + sahiplik + iş akışı adım kullanıcısı + app'in kendi kuralı).
- Vekâlet: tarih aralıklı; vekil işleri görür ve "X yerine Y" olarak imzalar.

**Kurum yapısı**
- Firma → lokasyon (form numarası öneki, saat dilimi, varsayılan dil). Dönem: tarih aralığı + salt okunur bayrağı. Kullanıcılara firma/lokasyon ve dönem atanır.
- Organizasyon ağacı (birim, pozisyon, yönetici, çalışan ↔ kullanıcı). QMEX'te EIS modülündeydi ama iş akışı "yöneticisine gönder" ve imzada pozisyon kaydı için buna ihtiyaç duyuyor, bu yüzden kernel'de. HR'den senkron bir app/entegrasyon işidir.

**Veri ve kayıt servisleri**
- Standart entity tabanı (aşağıda), kapsam filtresi, taslak, soft delete, revizyon zinciri.
- Revizyon kopyası: kaydı alt kayıtlarıyla (isteğe bağlı ekleriyle) kopyalar, önceki revizyonu arşivler; hangi adımlarda ve kimlerin yapabileceği tanımlanır.
- Ekler (dosya deposu, şifreleme seçeneği, erişim kontrolü app'in kayıt yetkisinden gelir), notlar, kayıtlar arası ilişkiler (+ zorunlu ilişki kuralları), bilgilendirilen kullanıcılar.
- Numaralandırma: parçalı şablon (sabit, yıl, ay, alan, lokasyon öneki, sayaç uzunluğu), kilitli sayaç.
- Seçim listeleri: hiyerarşik, firma/lokasyon bazlı, kullanıcıya göre kısıtlanabilir.
- Sistem parametreleri: app başına tipli ayarlar.
- Kontrol listesi / anket motoru: soru şablonları, cevap tipleri, zorunlu açıklama, cevaba göre eylem.
- Yetkili veri düzeltme: kilitli kayıtta gerekçe + onay + audit ile alan düzeltme (GMP).

**İş akışı motoru**
- Versiyonlu tanım; kayıt akışa girdiğinde tanımın anlık kopyası (snapshot) kayda bağlanır, çalışan kayıtlar kendi versiyonunda kalır.
- Hangi akışın başlayacağı koşulla seçilir. Adım tipleri: başlangıç, işlem, imza, askı, iptal, arşiv, bitiş.
- Adım kullanıcıları: sahibi, grup, yönetici, başka bir adımın kullanıcıları, önceki adımda seçilen kişiler, app kodu. Seri veya paralel; paralelde oylama.
- Seçimler (onayla/reddet/geri gönder…): not zorunluluğu, olumlu/olumsuz, mobilde kullanılabilir, ön doğrulama.
- Eylemler: yerleşikler (sonraki/önceki/koşullu adıma git, alan değeri ata, numara ver, termin ata, e-posta gönder, ek durum ata, önceki revizyonu arşivle, alt akış başlat/ilerlet) + **app'lerin C# ile kaydettiği eylemler** (tipli parametreler tasarımcıda form olarak çıkar; ör. "bulgudan CAPA aç").
- Adıma göre alan kuralları, imza adımında yeniden kimlik doğrulama (parola / OTP / OIDC), imzada pozisyon ve birim kaydı.
- Bekleyen işlerim kutusu (web + mobil), işi devretme, akış geçmişi (form log).

**Zaman ve iletişim**
- Zamanlayıcı (günlük/haftalık/aylık/cron), app'ler iş kaydeder; arka plan iş kuyruğu (AsyncOperationSuite tabanlı).
- Hatırlatıcılar ve iş günü takvimi (tatiller, lokasyon bazlı), kalan gün hesabı, termin değişiklik geçmişi.
- E-posta şablonları (dil varyantlı, kayıt alanı yer tutucuları), outbox kuyruğu, vekile yönlendirme. Uygulama içi bildirim (SignalR).

**Kayıt ve izlenebilirlik**
- Audit: her kayıt değişikliği için kim, ne zaman, eski/yeni değer (FK'ler için görünen ad), silme dahil; uygulama katmanında yazılır, alan başlıkları metadata'dan gelir. Arşivleme ve sıkıştırma kernel işi.
- Form geçmişi: bilgi, akış, hata, güvenlik olayları. Sistem logları (OpenTelemetry).

**Raporlama ve doküman**
- Dinamik liste/rapor tasarımcısı (sütun, filtre, toplam, yetki), kullanıcı/grup bazlı kayıtlı grid düzenleri, Excel dışa aktarım.
- Form çıktıları: Word şablonuna veri birleştirme, PDF üretimi, filigran, PDF birleştirme. (Kütüphane seçimi açık soru.)
- Tam metin arama soyutlaması: MSSQL FTS, PostgreSQL `tsvector`, SQLite FTS5.

**i18n:** anahtar tabanlı UI çevirileri, metadata başlıklarının çevirisi, veri çevirisi için çok dilli alan tipi (QMEX'teki `_en`/`_tr` kolonlarının yerine).

**Lisans:** app bazında lisans (on-prem ürün olarak satılacaksa).

## QMEX'ten geçiş

- **Birlikte yaşama:** geçiş süresince QMEX WebForms ve platform yan yana çalışır. QMEX'in iframe + postMessage köprüsü (`docs/QMexLandingPlugin.md`) ve derin bağlantılar iki yönde kullanılabilir.
- **Veri taşıma:** app başına QMEX tablolarından platform tablolarına aktarım aracı; `bigint` id → Guid eşleme tablosu, `ads_id` metinleri → kullanıcı FK, 'E'/'H' → boolean, yerel saat → UTC, `_en/_tr` kolonları → çok dilli alan. İş akışı geçmişi ve audit de taşınmalı (GMP).
- **Pilot sırası:**
  1. Ortak veri app'leri: PRM (malzeme, parti, firma, departman, birim, tatil, rehber) ve EIS'in kernel dışında kalan kısmı.
  2. **OOS** (11 tablo): ortak kalıbın tamamını kullanıyor (liste, taslaklar, sekmeli form, kontrol listesi, ekler, ilişkiler, iş akışı, hatırlatıcı, grafik), özel bağımlılığı yok.
  3. EA veya IA (yıllık plan + bulgudan CAPA → app'ler arası bağımlılık), ardından CAPA.
  4. Sona bırakılacaklar: DM (DOCX karşılaştırma, filigranlı önizleme, kontrollü baskı), PHV (E2B(R3) XML, MedDRA), ETS (eğitim matrisleri), BMR (PDF birleştirme, ERP).

