using Ortak;

namespace Siparisler;

// Müşteri formunun kodu: formun Araçlar menüsündeki öğeler buradaki metotları çağırır.
// Metot formun ekrandaki halini alır (kaydedilmemiş de olabilir).

[Form("musteri")]
public class MusteriFormu : FormCode<Musteri>
{
    /// <summary>Müşterinin siparişlerini özetler; tarih aralığını "Tarih aralığı" modalı sorar.</summary>
    public async Task<ActionResult> SiparisOzeti(Musteri m, IAppContext context)
    {
        if (m.Id == Guid.Empty) return ActionResult.Fail("Önce müşteriyi kaydedin.");
        var aralik = await context.Modals.ShowAsync<TarihAraligi>();
        return ActionResult.Ok(await Ozetler.MusteriAsync(m.Id, m.Unvan, aralik, context));
    }

    /// <summary>
    /// Kütüphaneden modal: Ortak.Sor bu uygulamanın sınıflarını bilmez, "Tarih aralığı" modalını
    /// anahtarıyla açar. Açılış değerlerini kütüphaneye biz veriyoruz: son 30 gün.
    /// </summary>
    public async Task<ActionResult> SiparisSayisi(Musteri m, IAppContext context)
    {
        if (m.Id == Guid.Empty) return ActionResult.Fail("Önce müşteriyi kaydedin.");
        var bugun = DateOnly.FromDateTime(context.UtcNow);
        var (ilk, son) = await Sor.AralikAsync(context, "tarih_araligi", bugun.AddDays(-30), bugun);
        var adet = (await context.Records.ListAsync<Siparis>(take: 1000)).Count(s => s.Musteri == m.Id && s.Tarih >= ilk && s.Tarih <= son);
        return ActionResult.Ok($"{m.Unvan}: {ilk:dd.MM.yyyy} – {son:dd.MM.yyyy} arasında {adet} sipariş.");
    }

    /// <summary>
    /// Kurum seçicileri: firma, lokasyon, plant, dönem ve tarih aralığı tek modalda. İleride rapor
    /// ve iş tanımları kapsamı böyle soracak; bu örnek seçileni yalnızca özetler.
    /// </summary>
    public async Task<ActionResult> KapsamSec(Musteri m, IAppContext context)
    {
        var k = await context.Modals.ShowAsync<Kapsam>();
        var secim = new List<string> { k.Firma == context.CompanyId ? "çalıştığınız firma" : "başka bir firma" };
        secim.Add(k.Lokasyon is null ? "bütün lokasyonlar" : k.Lokasyon == context.LocationId ? "çalıştığınız lokasyon" : "başka bir lokasyon");
        if (k.Plant is not null) secim.Add("bir plant");
        secim.Add(k.Donem is null ? "dönem seçilmedi" : k.Donem == context.PeriodId ? "çalıştığınız dönem" : "başka bir dönem");
        var (ilk, son) = (k.Baslangic!.Value, k.Bitis!.Value);
        return ActionResult.Ok($"Kapsam: {string.Join(", ", secim)}; {ilk:dd.MM.yyyy} – {son:dd.MM.yyyy} ({son.DayNumber - ilk.DayNumber + 1} gün).");
    }
}
