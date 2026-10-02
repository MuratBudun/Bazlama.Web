using Ortak;
using static SiparisApp.Siparis.DurumValues;

namespace Siparisler;

/// <summary>
/// Siparişin durumları ve toplamı; olaylar da eylemler de bunları kullanır.
/// taslak → onaylandı → sevk edildi; taslak ve onaylı sipariş iptal edilebilir, onaylı sipariş
/// taslağa geri alınabilir. Sevk edilmiş ve iptal edilmiş sipariş kapanmıştır.
/// </summary>
static class SiparisKurallari
{
    static readonly Dictionary<string, string[]> Gecisler = new()
    {
        [Taslak] = [Onaylandi, Iptal],
        [Onaylandi] = [Sevk, Taslak, Iptal],
        [Sevk] = [],
        [Iptal] = [],
    };

    public static bool GecisVar(string? eski, string? yeni) =>
        eski == yeni || (eski is not null && yeni is not null && Gecisler.TryGetValue(eski, out var olur) && olur.Contains(yeni));

    public static bool Kapali(string? durum) => durum is Sevk or Iptal;

    /// <summary>"onaylı", "sevk edilmiş"… (cümle içinde).</summary>
    public static string Ad(string? durum) => durum switch
    {
        Taslak => "taslak",
        Onaylandi => "onaylı",
        Sevk => "sevk edilmiş",
        Iptal => "iptal edilmiş",
        _ => "durumsuz",
    };

    public static async Task<IReadOnlyList<Kalem>> KalemlerAsync(Siparis s, IAppContext context) =>
        s.Id == Guid.Empty ? [] : await context.Records.ListAsync<Kalem>(take: 1000, parentId: s.Id);

    public static decimal Toplam(IEnumerable<Kalem> kalemler) => Tutar.Yuvarla(kalemler.Sum(k => k.Tutar ?? 0));
}
