using Ortak;
using static SiparisApp.Siparis.DurumValues;
using static Siparisler.SiparisKurallari;

namespace Siparisler;

/// <summary>Sipariş: numara, varsayılanlar, durum geçişleri, kapanmış siparişin kilidi, toplam.</summary>
public class SiparisEvents : EntityEvents<Siparis>
{
    public override async Task ValidateAsync(Siparis s, bool isNew, Errors errors, IAppContext context)
    {
        if (s.Tarih is { } tarih && s.Teslim is { } teslim && DateOnly.FromDateTime(teslim) < tarih)
            errors.Add("teslim", "Teslim zamanı sipariş tarihinden önce olamaz.");
        if (s.Musteri is { } musteri && await context.Records.GetAsync<Musteri>(musteri) is { Aktif: false })
            errors.Add("musteri", "Pasif müşteriye sipariş açılamaz.");
        if (Metin.Buyuk(s.SiparisNo) is { } no
            && (await context.Records.ListAsync<Siparis>(search: no, take: 20)).Any(x => x.Id != s.Id && x.SiparisNo == no))
            errors.Add("siparis_no", $"{no} numaralı bir sipariş var.");

        if (isNew)
        {
            if (s.Durum is not null && s.Durum != Taslak) errors.Add("durum", "Yeni sipariş taslak olarak açılır.");
            return;
        }
        if (await context.Records.GetAsync<Siparis>(s.Id) is not { } eski) return;
        if (Kapali(eski.Durum))
        {
            errors.Add($"Bu sipariş {Ad(eski.Durum)}; değiştirilemez.");
            return;
        }
        if (!GecisVar(eski.Durum, s.Durum))
            errors.Add("durum", $"{Ad(eski.Durum)} bir sipariş {Ad(s.Durum)} yapılamaz.");
        else if (s.Durum == Onaylandi && eski.Durum != Onaylandi && (await KalemlerAsync(s, context)).Count == 0)
            errors.Add("durum", "Kalemi olmayan sipariş onaylanamaz.");
        if (eski.Durum == Onaylandi && s.Durum == Onaylandi && s.Musteri != eski.Musteri)
            errors.Add("musteri", "Onaylı siparişin müşterisi değişmez; önce taslağa alın.");
    }

    public override async Task BeforeSaveAsync(Siparis s, bool isNew, IAppContext context)
    {
        s.SiparisNo = Metin.Buyuk(s.SiparisNo);
        if (isNew)
        {
            s.Durum ??= Taslak;
            s.Tarih ??= DateOnly.FromDateTime(context.UtcNow);
            s.SiparisNo ??= await YeniNumaraAsync(s.Tarih.Value.Year, context);
        }
        s.Toplam = Toplam(await KalemlerAsync(s, context));
    }

    public override Task BeforeDeleteAsync(Siparis s, Errors errors, IAppContext context)
    {
        if (s.Durum != Taslak) errors.Add($"Yalnız taslak sipariş silinir; bu sipariş {Ad(s.Durum)}. İptal edebilirsiniz.");
        return Task.CompletedTask;
    }

    /// <summary>"S-2026-0007": o yılın son numarasının bir fazlası (bu lokasyonda).</summary>
    static async Task<string> YeniNumaraAsync(int yil, IAppContext context)
    {
        var onek = $"S-{yil}-";
        var son = (await context.Records.ListAsync<Siparis>(search: onek, take: 1000))
            .Select(x => x.SiparisNo is { } no && no.StartsWith(onek, StringComparison.Ordinal) && int.TryParse(no[onek.Length..], out var n) ? n : 0)
            .DefaultIfEmpty(0)
            .Max();
        return $"{onek}{son + 1:D4}";
    }
}
