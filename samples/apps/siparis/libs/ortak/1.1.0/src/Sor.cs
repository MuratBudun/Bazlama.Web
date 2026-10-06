using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Bazlama.Sdk;

namespace Ortak;

/// <summary>
/// Kullanıcıya soru soran yardımcılar. Kütüphane, çağıran uygulamanın sınıflarını bilmez: modalı
/// anahtarıyla açar, değerleri alan anahtarlarıyla okur. Böylece aynı yardımcı her uygulamada çalışır.
/// </summary>
public static class Sor
{
    /// <summary>
    /// Tarih aralığı sorar. Uygulamanın <paramref name="modal"/> anahtarlı modalında "baslangic" ve
    /// "bitis" adında iki zorunlu tarih alanı olmalı. Verilen tarihler modalın açılış değerleri olur.
    /// </summary>
    public static async Task<(DateOnly Ilk, DateOnly Son)> AralikAsync(IAppContext context, string modal, DateOnly? ilk = null, DateOnly? son = null)
    {
        var acilis = new Dictionary<string, object?>();
        if (ilk is { } a) acilis["baslangic"] = a;
        if (son is { } b) acilis["bitis"] = b;
        var girilen = await context.Modals.ShowAsync(modal, acilis);
        if (!girilen.TryGetValue("baslangic", out var x) || x is not DateOnly baslangic || !girilen.TryGetValue("bitis", out var y) || y is not DateOnly bitis)
            throw new InvalidOperationException($"'{modal}' modalında 'baslangic' ve 'bitis' adında iki zorunlu tarih alanı olmalı.");
        return (baslangic, bitis);
    }
}
