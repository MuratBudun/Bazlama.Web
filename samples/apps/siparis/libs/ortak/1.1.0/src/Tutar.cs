using System;

namespace Ortak;

/// <summary>Para hesapları: kuruşa yuvarlanır (yarım kuruş yukarı).</summary>
public static class Tutar
{
    /// <summary>Kuruşa yuvarlar.</summary>
    public static decimal Yuvarla(decimal tutar) => Math.Round(tutar, 2, MidpointRounding.AwayFromZero);

    /// <summary>Bir satırın tutarı: miktar × birim fiyat, yüzde iskonto düşülmüş.</summary>
    public static decimal Satir(decimal miktar, decimal birimFiyat, long iskontoYuzde = 0) =>
        Yuvarla(miktar * birimFiyat * (100 - iskontoYuzde) / 100m);

    /// <summary>"1.234,50 ₺" biçimi.</summary>
    public static string Yaz(decimal tutar) => tutar.ToString("N2", Metin.Turkce) + " ₺";
}
