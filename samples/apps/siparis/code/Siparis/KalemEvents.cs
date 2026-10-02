using Ortak;
using static SiparisApp.Siparis.DurumValues;
using static Siparisler.SiparisKurallari;

namespace Siparisler;

/// <summary>Sipariş kalemi: miktar ve iskonto sınırları, üründen gelen fiyat, tutar; yalnız taslak siparişte değişir.</summary>
public class KalemEvents : EntityEvents<Kalem>
{
    public override async Task ValidateAsync(Kalem k, bool isNew, Errors errors, IAppContext context)
    {
        if (k.Miktar is <= 0) errors.Add("miktar", "Miktar sıfırdan büyük olmalı.");
        if (k.Iskonto is < 0 or > 100) errors.Add("iskonto", "İskonto 0 ile 100 arasında olmalı.");
        if (k.BirimFiyat is < 0) errors.Add("birim_fiyat", "Birim fiyat eksi olamaz.");
        await SiparisTaslakMi(k, errors, context);
    }

    public override async Task BeforeSaveAsync(Kalem k, bool isNew, IAppContext context)
    {
        // Fiyat girilmediyse ürünün liste fiyatı.
        if (k.BirimFiyat is null && k.Urun is { } urun) k.BirimFiyat = (await context.Records.GetAsync<Urun>(urun))?.Fiyat;
        k.Tutar = k.Miktar is { } miktar && k.BirimFiyat is { } fiyat ? Tutar.Satir(miktar, fiyat, k.Iskonto ?? 0) : null;
        k.Not = Metin.Sadelestir(k.Not);
    }

    public override Task BeforeDeleteAsync(Kalem k, Errors errors, IAppContext context) => SiparisTaslakMi(k, errors, context);

    static async Task SiparisTaslakMi(Kalem k, Errors errors, IAppContext context)
    {
        if (k.ParentId is { } id && await context.Records.GetAsync<Siparis>(id) is { } s && s.Durum != Taslak)
            errors.Add($"Sipariş {Ad(s.Durum)}; kalemleri yalnız taslakken değişir. Önce taslağa alın.");
    }
}
