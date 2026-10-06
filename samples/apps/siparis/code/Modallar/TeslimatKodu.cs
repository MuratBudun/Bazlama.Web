using Ortak;
using static SiparisApp.Teslimat.SekilValues;

namespace Siparisler;

/// <summary>
/// "Teslimat planı" modalının kodu. Alanlar arası kural burada: kargo ile teslimde kargo firması
/// zorunlu olur (tanımdaki "zorunlu" yalnız tek alanı bilir).
/// </summary>
public class TeslimatKodu : ModalCode<Teslimat>
{
    public override Task OpenAsync(Teslimat m, IAppContext context)
    {
        m.Sekil ??= Kargo;
        return Task.CompletedTask;
    }

    public override Task ValidateAsync(Teslimat m, Errors errors, IAppContext context)
    {
        if (m.Teslim < context.UtcNow) errors.Add("teslim", "Teslim zamanı geçmişte olamaz.");
        m.KargoFirmasi = Metin.Sadelestir(m.KargoFirmasi);
        if (m.Sekil == Kargo && m.KargoFirmasi is null) errors.Add("kargo_firmasi", "Kargo ile teslimde kargo firması gerekli.");
        return Task.CompletedTask;
    }

    /// <summary>Teslimat şeklinin okunur adı.</summary>
    public static string Ad(Teslimat m) => m.Sekil switch
    {
        Kargo => $"kargo ({m.KargoFirmasi})",
        Elden => "elden teslim",
        _ => "depodan teslim",
    };
}
