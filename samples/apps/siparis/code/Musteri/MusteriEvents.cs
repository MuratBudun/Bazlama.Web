using Ortak;

namespace Siparisler;

/// <summary>Müşteri: vergi no denetimi ve tekrarı, adların düzeni.</summary>
public class MusteriEvents : EntityEvents<Musteri>
{
    public override async Task ValidateAsync(Musteri m, bool isNew, Errors errors, IAppContext context)
    {
        if (Metin.Sadelestir(m.VergiNo) is not { } no) return;
        if (!Kimlik.Gecerli(no))
        {
            errors.Add("vergi_no", no.Length is 10 or 11 ? "Numara geçersiz: denetim hanesi tutmuyor." : "10 haneli vergi no ya da 11 haneli TC kimlik no girin.");
            return;
        }
        // Aynı numarayla ikinci müşteri olmasın (bu firmada).
        var ayni = (await context.Records.ListAsync<Musteri>(search: no, take: 20)).FirstOrDefault(x => x.Id != m.Id && x.VergiNo == no);
        if (ayni is not null) errors.Add("vergi_no", $"Bu numara \"{ayni.Unvan}\" müşterisinde kayıtlı.");
    }

    public override Task BeforeSaveAsync(Musteri m, bool isNew, IAppContext context)
    {
        m.Unvan = Metin.Sadelestir(m.Unvan);
        m.VergiNo = Metin.Sadelestir(m.VergiNo);
        m.Sehir = Metin.Baslik(m.Sehir);
        if (isNew) m.Aktif ??= true;
        return Task.CompletedTask;
    }
}
