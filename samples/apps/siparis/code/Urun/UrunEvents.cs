using Ortak;

namespace Siparisler;

/// <summary>Ürün: kod büyük harfle ve tekil, fiyat eksi olamaz.</summary>
public class UrunEvents : EntityEvents<Urun>
{
    public override async Task ValidateAsync(Urun u, bool isNew, Errors errors, IAppContext context)
    {
        if (u.Fiyat is < 0) errors.Add("fiyat", "Fiyat eksi olamaz.");
        if (Metin.Buyuk(u.Kod) is not { } kod) return;
        var ayni = (await context.Records.ListAsync<Urun>(search: kod, take: 20)).FirstOrDefault(x => x.Id != u.Id && Metin.Buyuk(x.Kod) == kod);
        if (ayni is not null) errors.Add("kod", $"{kod} kodu \"{ayni.Ad}\" ürününde kullanılıyor.");
    }

    public override Task BeforeSaveAsync(Urun u, bool isNew, IAppContext context)
    {
        u.Kod = Metin.Buyuk(u.Kod);
        u.Ad = Metin.Sadelestir(u.Ad);
        return Task.CompletedTask;
    }
}
