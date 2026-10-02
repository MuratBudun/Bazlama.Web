using Ortak;
using static SiparisApp.Siparis.DurumValues;
using static Siparisler.SiparisKurallari;

namespace Siparisler;

// Sipariş formundaki düğmeler. Sınıf adı eylemin anahtarıdır. Eylem kaydı değiştirip Save
// dönünce kaydetme olayları (doğrulama dahil) yine çalışır: kurallar SiparisEvents'te tek yerde.

[Action("Onayla", Icon = "check", Confirm = "Sipariş onaylansın mı? Onaydan sonra kalemler değiştirilemez.")]
public class Onayla : RecordAction<Siparis>
{
    public override async Task<ActionResult> RunAsync(Siparis s, IAppContext context)
    {
        if (s.Durum != Taslak) return ActionResult.Fail($"Yalnız taslak sipariş onaylanır; bu sipariş {Ad(s.Durum)}.");
        var kalemler = await KalemlerAsync(s, context);
        if (kalemler.Count == 0) return ActionResult.Fail("Kalemi olmayan sipariş onaylanamaz.");
        s.Durum = Onaylandi;
        return ActionResult.Save($"Sipariş onaylandı: {kalemler.Count} kalem, {Tutar.Yaz(Toplam(kalemler))}.");
    }
}

[Action("Sevk et", Icon = "send", Confirm = "Sipariş sevk edildi olarak işaretlensin mi? Sonra değiştirilemez.")]
public class SevkEt : RecordAction<Siparis>
{
    public override Task<ActionResult> RunAsync(Siparis s, IAppContext context)
    {
        if (s.Durum != Onaylandi) return Task.FromResult(ActionResult.Fail($"Yalnız onaylı sipariş sevk edilir; bu sipariş {Ad(s.Durum)}."));
        s.Durum = Sevk;
        s.Teslim ??= context.UtcNow;
        return Task.FromResult(ActionResult.Save("Sipariş sevk edildi."));
    }
}

[Action("Taslağa al", Icon = "edit")]
public class TaslagaAl : RecordAction<Siparis>
{
    public override Task<ActionResult> RunAsync(Siparis s, IAppContext context)
    {
        if (s.Durum != Onaylandi) return Task.FromResult(ActionResult.Fail($"Yalnız onaylı sipariş taslağa alınır; bu sipariş {Ad(s.Durum)}."));
        s.Durum = Taslak;
        return Task.FromResult(ActionResult.Save("Sipariş taslağa alındı; kalemleri değiştirebilirsiniz."));
    }
}

[Action("İptal et", Icon = "x", Confirm = "Sipariş iptal edilsin mi? Bu geri alınamaz.")]
public class IptalEt : RecordAction<Siparis>
{
    public override Task<ActionResult> RunAsync(Siparis s, IAppContext context)
    {
        if (Kapali(s.Durum)) return Task.FromResult(ActionResult.Fail($"Bu sipariş zaten {Ad(s.Durum)}."));
        s.Durum = Iptal;
        return Task.FromResult(ActionResult.Save("Sipariş iptal edildi."));
    }
}
