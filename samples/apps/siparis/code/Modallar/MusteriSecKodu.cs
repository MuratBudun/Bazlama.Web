namespace Siparisler;

/// <summary>"Müşteri seç" modalının kodu: modal kodu da kayıt okuyabilir; pasif müşteri seçilemez.</summary>
public class MusteriSecKodu : ModalCode<MusteriSec>
{
    public override async Task ValidateAsync(MusteriSec m, Errors errors, IAppContext context)
    {
        if (m.Musteri is { } id && await context.Records.GetAsync<Musteri>(id) is { Aktif: false } musteri)
            errors.Add("musteri", $"{musteri.Unvan} pasif; sipariş aktarılamaz.");
    }
}
