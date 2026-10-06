using Ortak;
using static SiparisApp.Siparis.DurumValues;

namespace Siparisler;

/// <summary>Bir müşterinin bir tarih aralığındaki siparişlerinin özeti; müşteri ve sipariş formlarının araçları kullanır.</summary>
static class Ozetler
{
    public static async Task<string> MusteriAsync(Guid musteri, string? unvan, TarihAraligi aralik, IAppContext context)
    {
        var (ilk, son) = (aralik.Baslangic!.Value, aralik.Bitis!.Value);
        var siparisler = (await context.Records.ListAsync<Siparis>(take: 1000))
            .Where(s => s.Musteri == musteri && s.Tarih >= ilk && s.Tarih <= son)
            .Where(s => aralik.YalnizOnayli != true || s.Durum is Onaylandi or Sevk)
            .ToList();
        var donem = $"{ilk:dd.MM.yyyy} – {son:dd.MM.yyyy}";
        return siparisler.Count == 0
            ? $"{unvan}: {donem} arasında sipariş yok."
            : $"{unvan}: {donem} arasında {siparisler.Count} sipariş, toplam {Tutar.Yaz(siparisler.Sum(s => s.Toplam ?? 0))}.";
    }
}
