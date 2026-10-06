using static SiparisApp.Siparis.DurumValues;
using static Siparisler.SiparisKurallari;

namespace Siparisler;

// Sipariş formunun kodu: formun Araçlar menüsündeki öğeler buradaki metotları çağırır.
// Metot formun ekrandaki halini alır; değiştirdiği alanlar forma geri yazılır ama kaydedilmez
// (kaydetmek kullanıcıya kalır; ActionResult.Save dönülürse form kaydedilir).
// Kullanıcıdan girdi gerekiyorsa metot bir modal açar: context.Modals.ShowAsync<Modal>().

[Form("siparis")]
public class SiparisFormu : FormCode<Siparis>
{
    /// <summary>Modalsız araç. Teslim tarihini önerir: sipariş tarihinden üç iş günü sonra, saat 09:00 (Türkiye).</summary>
    public ActionResult TeslimOner(Siparis s, IAppContext context)
    {
        if (Kapali(s.Durum)) return ActionResult.Fail($"Bu sipariş {Ad(s.Durum)}; teslim tarihi değişmez.");
        var oneri = Oneri(s, context);
        s.Teslim = oneri;
        return ActionResult.Ok($"Teslim tarihi önerildi: {DateOnly.FromDateTime(oneri):dd.MM.yyyy} 09:00. Kaydedince geçerli olur.");
    }

    /// <summary>Aynı modal, başka formdan: formda seçili müşterinin siparişlerini özetler; modal siparişin ayıyla açılır.</summary>
    public async Task<ActionResult> MusteriOzeti(Siparis s, IAppContext context)
    {
        if (s.Musteri is not { } id) return ActionResult.Fail("Önce müşteriyi seçin.");
        var musteri = await context.Records.GetAsync<Musteri>(id);
        var aralik = await context.Modals.ShowAsync<TarihAraligi>(m =>
        {
            if (s.Tarih is not { } tarih) return;
            m.Baslangic = new DateOnly(tarih.Year, tarih.Month, 1);
            m.Bitis = tarih;
        });
        return ActionResult.Ok(await Ozetler.MusteriAsync(id, musteri?.Unvan, aralik, context));
    }

    /// <summary>Modalda girilen forma yazılır: türü ve metni sorulan not açıklamaya eklenir (kaydedilmez).</summary>
    public async Task<ActionResult> NotEkle(Siparis s, IAppContext context)
    {
        var not = await context.Modals.ShowAsync<SiparisNotu>();
        var satir = $"[{SiparisNotuKodu.Ad(not.Tur)}] {not.Metin!.Trim()}";
        s.Aciklama = string.IsNullOrWhiteSpace(s.Aciklama) ? satir
            : not.BasaEkle == true ? $"{satir}\n{s.Aciklama}"
            : $"{s.Aciklama}\n{satir}";
        return ActionResult.Ok("Not açıklamaya eklendi. Kaydedince geçerli olur.");
    }

    /// <summary>
    /// Modal + kaydetme: teslimat planı sorulur, forma yazılır ve form kaydedilir (ActionResult.Save).
    /// Modal onaylandıktan sonra dönülen hata modalın içinde gösterilir; kullanıcı düzeltip yeniden dener.
    /// </summary>
    public async Task<ActionResult> TeslimatPlanla(Siparis s, IAppContext context)
    {
        if (Kapali(s.Durum)) return ActionResult.Fail($"Bu sipariş {Ad(s.Durum)}; teslimatı planlanamaz.");
        var plan = await context.Modals.ShowAsync<Teslimat>(m => m.Teslim = s.Teslim ?? Oneri(s, context));
        if (s.Tarih is { } tarih && DateOnly.FromDateTime(plan.Teslim!.Value) < tarih)
            return ActionResult.Fail("Teslim zamanı sipariş tarihinden önce olamaz.");
        s.Teslim = plan.Teslim;
        s.Aciklama = Ekle(s.Aciklama, $"Teslimat: {TeslimatKodu.Ad(plan)}{(plan.Acil == true ? ", acil" : "")}");
        return ActionResult.Save("Teslimat planlandı.");
    }

    /// <summary>Modalda kayıt seçimi: sipariş başka bir müşteriye aktarılır; formdaki müşteri alanı yeni müşteriyi gösterir.</summary>
    public async Task<ActionResult> MusteriDegistir(Siparis s, IAppContext context)
    {
        if (s.Durum is not (null or Taslak)) return ActionResult.Fail($"Müşteri yalnız taslak siparişte değişir; bu sipariş {Ad(s.Durum)}.");
        var secim = await context.Modals.ShowAsync<MusteriSec>();
        if (secim.Musteri == s.Musteri) return ActionResult.Fail("Sipariş zaten bu müşteride.");
        s.Musteri = secim.Musteri;
        if (!string.IsNullOrWhiteSpace(secim.Neden)) s.Aciklama = Ekle(s.Aciklama, $"Müşteri değişti: {secim.Neden.Trim()}");
        return ActionResult.Ok("Müşteri değişti. Kaydedince geçerli olur.");
    }

    /// <summary>Neden soran iptal: modalın kendi kodu "Diğer" için açıklama ister; sonra durum değişir ve form kaydedilir.</summary>
    public async Task<ActionResult> NedeniyleIptalEt(Siparis s, IAppContext context)
    {
        if (s.Id == Guid.Empty) return ActionResult.Fail("Kaydedilmemiş sipariş iptal edilmez; formu kapatmanız yeter.");
        if (Kapali(s.Durum)) return ActionResult.Fail($"Bu sipariş zaten {Ad(s.Durum)}.");
        var iptal = await context.Modals.ShowAsync<IptalNedeni>();
        s.Durum = Iptal;
        var aciklama = string.IsNullOrWhiteSpace(iptal.Aciklama) ? "" : $" — {iptal.Aciklama.Trim()}";
        s.Aciklama = Ekle(s.Aciklama, $"İptal nedeni: {IptalNedeniKodu.Ad(iptal.Neden)}{aciklama}");
        return ActionResult.Save("Sipariş iptal edildi.");
    }

    /// <summary>Sipariş tarihinden (yoksa bugünden) üç iş günü sonra, 09:00 Türkiye saati.</summary>
    static DateTime Oneri(Siparis s, IAppContext context)
    {
        var gun = s.Tarih ?? DateOnly.FromDateTime(context.UtcNow);
        for (var kalan = 3; kalan > 0;)
        {
            gun = gun.AddDays(1);
            if (gun.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday)) kalan--;
        }
        return gun.ToDateTime(new TimeOnly(6, 0), DateTimeKind.Utc);
    }

    static string Ekle(string? aciklama, string satir) => string.IsNullOrWhiteSpace(aciklama) ? satir : $"{aciklama}\n{satir}";
}
