using static SiparisApp.IptalNedeni.NedenValues;

namespace Siparisler;

/// <summary>"İptal nedeni" modalının kodu: neden "Diğer" ise açıklama zorunlu olur.</summary>
public class IptalNedeniKodu : ModalCode<IptalNedeni>
{
    public override Task ValidateAsync(IptalNedeni m, Errors errors, IAppContext context)
    {
        if (m.Neden == Diger && string.IsNullOrWhiteSpace(m.Aciklama)) errors.Add("aciklama", "\"Diğer\" seçildiğinde nedeni açıklayın.");
        return Task.CompletedTask;
    }

    /// <summary>Nedenin okunur adı.</summary>
    public static string Ad(string? neden) => neden switch
    {
        MusteriVazgecti => "müşteri vazgeçti",
        StokYok => "stok yok",
        Fiyat => "fiyatta anlaşılamadı",
        HataliGiris => "hatalı giriş",
        _ => "diğer",
    };
}
