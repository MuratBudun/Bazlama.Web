using static SiparisApp.SiparisNotu.TurValues;

namespace Siparisler;

/// <summary>"Sipariş notu" modalının kodu: tür seçili gelir; not birkaç harften uzun olmalı.</summary>
public class SiparisNotuKodu : ModalCode<SiparisNotu>
{
    public override Task OpenAsync(SiparisNotu m, IAppContext context)
    {
        m.Tur ??= Bilgi;
        return Task.CompletedTask;
    }

    public override Task ValidateAsync(SiparisNotu m, Errors errors, IAppContext context)
    {
        if ((m.Metin ?? "").Trim().Length < 3) errors.Add("metin", "Not en az üç karakter olmalı.");
        return Task.CompletedTask;
    }

    /// <summary>Not türünün okunur adı.</summary>
    public static string Ad(string? tur) => tur switch
    {
        Uyari => "Uyarı",
        Istek => "Müşteri isteği",
        _ => "Bilgi",
    };
}
