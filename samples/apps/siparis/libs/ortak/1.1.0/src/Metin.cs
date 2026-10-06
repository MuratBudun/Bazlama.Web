using System;
using System.Globalization;

namespace Ortak;

/// <summary>Türkçe metin biçimleri (i/İ, ı/I harfleri Türkçe kurallarla).</summary>
public static class Metin
{
    /// <summary>tr-TR kültürü.</summary>
    public static readonly CultureInfo Turkce = CultureInfo.GetCultureInfo("tr-TR");

    /// <summary>Baştaki/sondaki boşlukları atar, aradakileri teke indirir; boşsa null.</summary>
    public static string? Sadelestir(string? metin)
    {
        if (string.IsNullOrWhiteSpace(metin)) return null;
        return string.Join(' ', metin.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
    }

    /// <summary>"iSTANBUL  avrupa" → "İstanbul Avrupa".</summary>
    public static string? Baslik(string? metin) =>
        Sadelestir(metin) is { } s ? Turkce.TextInfo.ToTitleCase(s.ToLower(Turkce)) : null;

    /// <summary>"kod-ı1" → "KOD-I1".</summary>
    public static string? Buyuk(string? metin) => Sadelestir(metin)?.ToUpper(Turkce);
}
