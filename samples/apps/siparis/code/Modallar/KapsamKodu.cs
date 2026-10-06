namespace Siparisler;

/// <summary>
/// "Kapsam seçimi" modalının kodu: modal, kullanıcının çalışma bağlamıyla (firma, lokasyon, plant,
/// dönem) ve bu ayla açılır. Seçenekleri platform süzer: lokasyonlar seçili firmanın, plant'lar
/// seçili lokasyonun; yalnız kullanıcının çalışabildikleri.
/// </summary>
public class KapsamKodu : ModalCode<Kapsam>
{
    public override Task OpenAsync(Kapsam m, IAppContext context)
    {
        m.Firma ??= context.CompanyId;
        if (m.Firma == context.CompanyId)
        {
            m.Lokasyon ??= context.LocationId;
            m.Plant ??= context.PlantId;
            m.Donem ??= context.PeriodId;
        }
        var bugun = DateOnly.FromDateTime(context.UtcNow);
        m.Baslangic ??= new DateOnly(bugun.Year, bugun.Month, 1);
        m.Bitis ??= bugun;
        return Task.CompletedTask;
    }

    public override Task ValidateAsync(Kapsam m, Errors errors, IAppContext context)
    {
        if (m.Plant is not null && m.Lokasyon is null) errors.Add("lokasyon", "Plant seçmek için lokasyon da seçilmeli.");
        if (m.Bitis < m.Baslangic) errors.Add("bitis", "Bitiş tarihi başlangıçtan önce olamaz.");
        return Task.CompletedTask;
    }
}
