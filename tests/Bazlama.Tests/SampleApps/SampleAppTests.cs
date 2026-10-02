using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Bazlama.Packaging;
using Bazlama.Tests.Engine;
using static Bazlama.Tests.TestHost;

namespace Bazlama.Tests.SampleApps;

/// <summary>
/// samples/apps/siparis as it is in the repository: packed from its source files (definition,
/// code, the "ortak" library) and imported into a test installation, where its business rules
/// run. Keeps the sample compiling and doing what its README says.
/// </summary>
public sealed class SampleAppTests : IAsyncLifetime
{
    readonly TestHost host = new(environmentMode: "Test");
    HttpClient client = null!;
    const string Data = "/api/runtime/data/siparis";

    public async ValueTask InitializeAsync()
    {
        await host.SetupAsync();
        client = host.Client();
        await client.LoginAsync(AdminUser, AdminPassword);

        var (bytes, name, errors) = SourcePackager.Pack(Samples.Folder("siparis"), "0.1.0", DateTime.UtcNow, "test");
        Assert.True(bytes is not null, string.Join("\n", errors));
        Assert.Equal("siparis-2.0.0.bzapp", name);
        var content = new ByteArrayContent(bytes!);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        var import = await client.PostAsync("/api/management/apps/import", content, Ct);
        var result = await import.JsonAsync();
        Assert.True(import.IsSuccessStatusCode, result.ToString());
        Assert.True(result.GetProperty("hashMatches").GetBoolean()); // packed here, compiled there: the same build
    }

    public ValueTask DisposeAsync() => host.DisposeAsync();

    async Task<JsonElement> Create(string entity, object values, Guid? parent = null)
    {
        var res = await client.PostAsJsonAsync($"{Data}/{entity}", new { values, parentId = parent }, Ct);
        var body = await res.JsonAsync();
        Assert.True(res.IsSuccessStatusCode, body.ToString());
        return await Get(entity, body.GetProperty("id").GetGuid());
    }
    async Task<JsonElement> Refused(string entity, object values, Guid? parent = null)
    {
        var res = await client.PostAsJsonAsync($"{Data}/{entity}", new { values, parentId = parent }, Ct);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        return await res.JsonAsync();
    }
    async Task<JsonElement> Get(string entity, Guid id) => await (await client.GetAsync($"{Data}/{entity}/{id}", Ct)).JsonAsync();
    async Task<HttpResponseMessage> Update(string entity, JsonElement record, Dictionary<string, object?> changes)
    {
        var values = JsonSerializer.Deserialize<Dictionary<string, object?>>(record.GetRawText())!;
        foreach (var key in new[] { "id", "rowVersion", "_titles", "parentId", "createdAt", "createdBy", "updatedAt", "updatedBy", "companyId", "locationId", "plantId", "periodId" })
            values.Remove(key);
        foreach (var (k, v) in changes) values[k] = v;
        return await client.PutAsJsonAsync($"{Data}/{entity}/{record.GetProperty("id").GetGuid()}", new { values, rowVersion = record.GetProperty("rowVersion").GetInt64() }, Ct);
    }
    async Task<HttpResponseMessage> Action(Guid order, string action) => await client.PostAsync($"{Data}/siparis/{order}/actions/{action}", null, Ct);

    static string? Field(JsonElement body, string key) =>
        body.TryGetProperty("fieldErrors", out var f) && f.ValueKind == JsonValueKind.Object && f.TryGetProperty(key, out var m) ? m.GetString() : null;

    [Fact]
    public async Task Customers_and_products_are_checked_and_tidied()
    {
        Assert.Equal("Numara geçersiz: denetim hanesi tutmuyor.", Field(await Refused("musteri", new { unvan = "Acme", vergi_no = "1234567891" }), "vergi_no"));
        Assert.Equal("10 haneli vergi no ya da 11 haneli TC kimlik no girin.", Field(await Refused("musteri", new { unvan = "Acme", vergi_no = "123" }), "vergi_no"));

        var acme = await Create("musteri", new { unvan = "  Acme   Gıda  ", vergi_no = "1234567890", sehir = "iSTANBUL avrupa" });
        Assert.Equal("Acme Gıda", acme.GetProperty("unvan").GetString());
        Assert.Equal("İstanbul Avrupa", acme.GetProperty("sehir").GetString());
        Assert.True(acme.GetProperty("aktif").GetBoolean());
        Assert.Equal("Bu numara \"Acme Gıda\" müşterisinde kayıtlı.", Field(await Refused("musteri", new { unvan = "Başka", vergi_no = "1234567890" }), "vergi_no"));
        await Create("musteri", new { unvan = "Ayşe Yılmaz", vergi_no = "10000000146" }); // TC kimlik no

        var urun = await Create("urun", new { kod = "kl-ı1", ad = "Kalem", birim = "adet", fiyat = 12.5 });
        Assert.Equal("KL-I1", urun.GetProperty("kod").GetString());
        Assert.Equal("KL-I1 kodu \"Kalem\" ürününde kullanılıyor.", Field(await Refused("urun", new { kod = "KL-I1", ad = "Başka", birim = "adet" }), "kod"));
        Assert.Equal("Fiyat eksi olamaz.", Field(await Refused("urun", new { kod = "X", ad = "X", birim = "adet", fiyat = -1 }), "fiyat"));
    }

    [Fact]
    public async Task An_order_is_numbered_totalled_and_goes_through_its_states()
    {
        var musteri = (await Create("musteri", new { unvan = "Acme" })).GetProperty("id").GetGuid();
        var urun = (await Create("urun", new { kod = "U1", ad = "Ürün", birim = "adet", fiyat = 12.5 })).GetProperty("id").GetGuid();

        // Number, date and state come from the code.
        var siparis = await Create("siparis", new { musteri });
        var id = siparis.GetProperty("id").GetGuid();
        Assert.Equal("S-2026-0001", siparis.GetProperty("siparis_no").GetString());
        Assert.Equal("taslak", siparis.GetProperty("durum").GetString());
        Assert.Equal("2026-10-01", siparis.GetProperty("tarih").GetString());
        Assert.Equal("S-2026-0002", (await Create("siparis", new { musteri })).GetProperty("siparis_no").GetString());

        var empty = await Action(id, "Onayla");
        Assert.Equal(HttpStatusCode.BadRequest, empty.StatusCode);
        Assert.Equal("Kalemi olmayan sipariş onaylanamaz.", (await empty.JsonAsync()).Errors().Single());

        // A line: the product's price, the discount, the amount.
        var kalem = await Create("kalem", new { urun, miktar = 3, iskonto = 10 }, id);
        Assert.Equal(12.5m, kalem.GetProperty("birim_fiyat").GetDecimal());
        Assert.Equal(33.75m, kalem.GetProperty("tutar").GetDecimal());
        Assert.Equal("İskonto 0 ile 100 arasında olmalı.", Field(await Refused("kalem", new { urun, miktar = 1, iskonto = 120 }, id), "iskonto"));

        var approve = await Action(id, "Onayla");
        var approved = await approve.JsonAsync();
        Assert.True(approve.IsSuccessStatusCode, approved.ToString());
        Assert.Equal("Sipariş onaylandı: 1 kalem, 33,75 ₺.", approved.GetProperty("message").GetString());
        siparis = await Get("siparis", id);
        Assert.Equal("onaylandi", siparis.GetProperty("durum").GetString());
        Assert.Equal(33.75m, siparis.GetProperty("toplam").GetDecimal());

        // Approved: its lines are locked; a state may change only along the allowed paths.
        Assert.Equal("Sipariş onaylı; kalemleri yalnız taslakken değişir. Önce taslağa alın.", (await Refused("kalem", new { urun, miktar = 1 }, id)).Errors().Single());
        var back = await Update("siparis", siparis, new() { ["durum"] = "taslak" });
        Assert.True(back.IsSuccessStatusCode); // onaylı → taslak is allowed (the same as "Taslağa al")
        siparis = await Get("siparis", id);
        Assert.True((await Action(id, "Onayla")).IsSuccessStatusCode);

        var ship = await Action(id, "SevkEt");
        Assert.True(ship.IsSuccessStatusCode);
        siparis = await Get("siparis", id);
        Assert.Equal("sevk", siparis.GetProperty("durum").GetString());
        Assert.NotEqual(JsonValueKind.Null, siparis.GetProperty("teslim").ValueKind);

        // Shipped: closed.
        var edit = await Update("siparis", siparis, new() { ["aciklama"] = "geç kaldı" });
        Assert.Equal(HttpStatusCode.BadRequest, edit.StatusCode);
        Assert.Equal("Bu sipariş sevk edilmiş; değiştirilemez.", (await edit.JsonAsync()).Errors().Single());
        var delete = await client.DeleteAsync($"{Data}/siparis/{id}", Ct);
        Assert.Equal(HttpStatusCode.BadRequest, delete.StatusCode);
        Assert.StartsWith("Yalnız taslak sipariş silinir", (await delete.JsonAsync()).Errors().Single());
        Assert.Equal("Bu sipariş zaten sevk edilmiş.", (await (await Action(id, "IptalEt")).JsonAsync()).Errors().Single());
    }

    [Fact]
    public async Task A_state_cannot_skip_a_step()
    {
        var musteri = (await Create("musteri", new { unvan = "Acme" })).GetProperty("id").GetGuid();
        Assert.Equal("Yeni sipariş taslak olarak açılır.", Field(await Refused("siparis", new { musteri, durum = "sevk" }), "durum"));

        var siparis = await Create("siparis", new { musteri, siparis_no = "s-özel-1" });
        Assert.Equal("S-ÖZEL-1", siparis.GetProperty("siparis_no").GetString());
        var skip = await Update("siparis", siparis, new() { ["durum"] = "sevk" });
        Assert.Equal("taslak bir sipariş sevk edilmiş yapılamaz.", Field(await skip.JsonAsync(), "durum"));
        Assert.Equal("S-ÖZEL-1 numaralı bir sipariş var.", Field(await Refused("siparis", new { musteri, siparis_no = "S-ÖZEL-1" }), "siparis_no"));

        Assert.True((await Action(siparis.GetProperty("id").GetGuid(), "IptalEt")).IsSuccessStatusCode);
        Assert.Equal("iptal", (await Get("siparis", siparis.GetProperty("id").GetGuid())).GetProperty("durum").GetString());
    }
}
