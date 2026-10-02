using System;
using System.Linq;

namespace Ortak;

/// <summary>Türkiye'deki kimlik numaraları: vergi kimlik no (10 hane) ve TC kimlik no (11 hane).</summary>
public static class Kimlik
{
    /// <summary>10 haneli vergi no ya da 11 haneli TC kimlik no; ikisi de son hanelerindeki denetimle.</summary>
    public static bool Gecerli(string? no) => no?.Length switch
    {
        10 => VergiNoGecerli(no),
        11 => TcKimlikNoGecerli(no),
        _ => false,
    };

    /// <summary>Vergi kimlik numarası: 10 rakam, son rakam ilk dokuzundan hesaplanır.</summary>
    public static bool VergiNoGecerli(string? no)
    {
        if (no is null || no.Length != 10 || !no.All(char.IsAsciiDigit)) return false;
        var toplam = 0;
        for (var i = 0; i < 9; i++)
        {
            var v = (no[i] - '0' + 9 - i) % 10;
            var p = v * (1 << (9 - i)) % 9;
            if (v != 0 && p == 0) p = 9;
            toplam += p;
        }
        return (10 - toplam % 10) % 10 == no[9] - '0';
    }

    /// <summary>TC kimlik numarası: 11 rakam, sıfırla başlamaz, son iki rakam öncekilerden hesaplanır.</summary>
    public static bool TcKimlikNoGecerli(string? no)
    {
        if (no is null || no.Length != 11 || !no.All(char.IsAsciiDigit) || no[0] == '0') return false;
        var d = no.Select(c => c - '0').ToArray();
        var tek = d[0] + d[2] + d[4] + d[6] + d[8];
        var cift = d[1] + d[3] + d[5] + d[7];
        return ((tek * 7 - cift) % 10 + 10) % 10 == d[9] && d.Take(10).Sum() % 10 == d[10];
    }
}
