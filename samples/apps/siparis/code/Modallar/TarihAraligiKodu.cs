namespace Siparisler;

/// <summary>
/// "Tarih aralığı" modalının kodu. Modal açılırken bu ayı önerir (açan kod bir değer vermediyse),
/// kullanıcı onayladığında aralığı denetler: hata eklenirse modal açık kalır.
/// </summary>
public class TarihAraligiKodu : ModalCode<TarihAraligi>
{
    public override Task OpenAsync(TarihAraligi m, IAppContext context)
    {
        var bugun = DateOnly.FromDateTime(context.UtcNow);
        m.Baslangic ??= new DateOnly(bugun.Year, bugun.Month, 1);
        m.Bitis ??= bugun;
        return Task.CompletedTask;
    }

    public override Task ValidateAsync(TarihAraligi m, Errors errors, IAppContext context)
    {
        // İkisi de zorunlu alan: boşsa motor zaten geri çevirir.
        if (m.Baslangic is not { } ilk || m.Bitis is not { } son) return Task.CompletedTask;
        if (son < ilk) errors.Add("bitis", "Bitiş tarihi başlangıçtan önce olamaz.");
        else if (son.DayNumber - ilk.DayNumber > 366) errors.Add("Aralık en fazla bir yıl olabilir.");
        return Task.CompletedTask;
    }
}
