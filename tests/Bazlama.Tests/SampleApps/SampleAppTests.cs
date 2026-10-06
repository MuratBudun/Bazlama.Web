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
        Assert.Equal("siparis-2.1.0.bzapp", name);
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

    [Fact]
    public async Task The_forms_tools_work_on_the_form_and_ask_for_the_date_range()
    {
        async Task<JsonElement> Tool(string form, string method, object body)
        {
            var res = await client.PostAsJsonAsync($"/api/runtime/forms/siparis/{form}/tools/{method}", body, Ct);
            var json = await res.JsonAsync();
            Assert.True(res.IsSuccessStatusCode, json.ToString());
            return json;
        }

        // The menus come with the definition.
        var app = await (await client.GetAsync("/api/runtime/apps/siparis", Ct)).JsonAsync();
        var forms = app.GetProperty("definition").GetProperty("forms");
        Assert.Equal(["Teslim tarihini öner", "Müşteri özeti", "Not ekle", "Teslimatı planla", "Müşteriyi değiştir", "Nedeniyle iptal et"],
            forms[1].GetProperty("tools").EnumerateArray().Select(t => t.GetProperty("label").GetString()));

        // A new, unsaved order: 2026-10-01 is a Thursday, three working days later is Tuesday the 6th.
        var suggested = await Tool("siparis", "TeslimOner", new { values = new { tarih = "2026-10-01", durum = "taslak" } });
        Assert.Equal("Teslim tarihi önerildi: 06.10.2026 09:00. Kaydedince geçerli olur.", suggested.GetProperty("message").GetString());
        Assert.StartsWith("2026-10-06T06:00:00", suggested.GetProperty("values").GetProperty("teslim").GetString());

        var musteri = (await Create("musteri", new { unvan = "Acme" })).GetProperty("id").GetGuid();
        var urun = (await Create("urun", new { kod = "U1", ad = "Ürün", birim = "adet", fiyat = 10 })).GetProperty("id").GetGuid();
        var siparis = (await Create("siparis", new { musteri })).GetProperty("id").GetGuid();
        await Create("kalem", new { urun, miktar = 2 }, siparis);
        Assert.True((await Update("siparis", await Get("siparis", siparis), [])).IsSuccessStatusCode); // the total is computed when the order is saved
        await Create("siparis", new { musteri, tarih = "2026-09-15" });

        // The summary asks for the range: the modal starts with this month (its own code).
        var body = new { id = musteri, values = new { unvan = "Acme" } };
        var asked = (await Tool("musteri", "SiparisOzeti", body)).GetProperty("modal");
        Assert.Equal(("tarih_araligi", "2026-10-01", "2026-10-01"),
            (asked.GetProperty("key").GetString(), asked.GetProperty("values").GetProperty("baslangic").GetString(), asked.GetProperty("values").GetProperty("bitis").GetString()));
        var backwards = await Tool("musteri", "SiparisOzeti", new { body.id, body.values, inputs = new { tarih_araligi = new { baslangic = "2026-10-02", bitis = "2026-10-01" } } });
        Assert.Equal("Bitiş tarihi başlangıçtan önce olamaz.", backwards.GetProperty("modal").GetProperty("fieldErrors").GetProperty("bitis").GetString());
        var october = await Tool("musteri", "SiparisOzeti", new { body.id, body.values, inputs = new { tarih_araligi = new { baslangic = "2026-10-01", bitis = "2026-10-31" } } });
        Assert.Equal("Acme: 01.10.2026 – 31.10.2026 arasında 1 sipariş, toplam 20,00 ₺.", october.GetProperty("message").GetString());

        // From the order form the same modal opens with the order's month.
        var fromOrder = await Tool("siparis", "MusteriOzeti", new { id = siparis, values = new { musteri, tarih = "2026-09-20" } });
        Assert.Equal(("2026-09-01", "2026-09-20"),
            (fromOrder.GetProperty("modal").GetProperty("values").GetProperty("baslangic").GetString(), fromOrder.GetProperty("modal").GetProperty("values").GetProperty("bitis").GetString()));
        var approved = await Tool("siparis", "MusteriOzeti", new { id = siparis, values = new { musteri }, inputs = new { tarih_araligi = new { baslangic = "2026-09-01", bitis = "2026-10-31", yalniz_onayli = true } } });
        Assert.Equal("Acme: 01.09.2026 – 31.10.2026 arasında sipariş yok.", approved.GetProperty("message").GetString());
    }

    /// <summary>A form tool as the web client calls it; `inputs`: what the user entered in the modals.</summary>
    async Task<(HttpStatusCode Status, JsonElement Body)> Tool(string form, string method, object values, Guid? id = null, object? inputs = null)
    {
        var res = await client.PostAsJsonAsync($"/api/runtime/forms/siparis/{form}/tools/{method}", new { id, values, inputs }, Ct);
        return (res.StatusCode, await res.JsonAsync());
    }
    static string? ModalError(JsonElement body, string field) => body.GetProperty("modal").GetProperty("fieldErrors").GetProperty(field).GetString();

    [Fact]
    public async Task The_example_modals_write_to_the_form_save_it_and_check_what_is_entered()
    {
        var acme = (await Create("musteri", new { unvan = "Acme" })).GetProperty("id").GetGuid();
        var beta = (await Create("musteri", new { unvan = "Beta" })).GetProperty("id").GetGuid();
        var pasif = await Create("musteri", new { unvan = "Pasif" });
        Assert.True((await Update("musteri", pasif, new() { ["aktif"] = false })).IsSuccessStatusCode);
        var order = new { musteri = acme, tarih = "2026-10-01", durum = "taslak", aciklama = "İlk satır" };

        // Not ekle: the modal opens with its kind chosen; what is entered goes into the form's text.
        var (_, note) = await Tool("siparis", "NotEkle", order);
        Assert.Equal(("siparis_notu", "bilgi"), (note.GetProperty("modal").GetProperty("key").GetString(), note.GetProperty("modal").GetProperty("values").GetProperty("tur").GetString()));
        var (_, shortNote) = await Tool("siparis", "NotEkle", order, inputs: new { siparis_notu = new { tur = "uyari", metin = " a " } });
        Assert.Equal("Not en az üç karakter olmalı.", ModalError(shortNote, "metin"));
        var (_, noted) = await Tool("siparis", "NotEkle", order, inputs: new { siparis_notu = new { tur = "uyari", metin = "Kapıda ödeme", basa_ekle = true } });
        Assert.Equal("[Uyarı] Kapıda ödeme\nİlk satır", noted.GetProperty("values").GetProperty("aciklama").GetString());
        Assert.False(noted.GetProperty("save").GetBoolean());

        // Teslimatı planla: starts with the suggestion; a rule between two fields is the modal's own code;
        // what the tool itself refuses after the modal comes back as an error (the client keeps the modal open).
        var (_, plan) = await Tool("siparis", "TeslimatPlanla", order);
        Assert.StartsWith("2026-10-06T06:00:00", plan.GetProperty("modal").GetProperty("values").GetProperty("teslim").GetString());
        Assert.Equal("kargo", plan.GetProperty("modal").GetProperty("values").GetProperty("sekil").GetString());
        var (_, noCarrier) = await Tool("siparis", "TeslimatPlanla", order, inputs: new { teslimat = new { teslim = "2026-10-06T06:00:00Z", sekil = "kargo" } });
        Assert.Equal("Kargo ile teslimde kargo firması gerekli.", ModalError(noCarrier, "kargo_firmasi"));
        var (_, past) = await Tool("siparis", "TeslimatPlanla", order, inputs: new { teslimat = new { teslim = "2026-09-01T06:00:00Z", sekil = "elden" } });
        Assert.Equal("Teslim zamanı geçmişte olamaz.", ModalError(past, "teslim"));
        var (early, tooEarly) = await Tool("siparis", "TeslimatPlanla", order with { tarih = "2026-10-20" }, inputs: new { teslimat = new { teslim = "2026-10-06T06:00:00Z", sekil = "elden" } });
        Assert.Equal(HttpStatusCode.BadRequest, early);
        Assert.Equal("Teslim zamanı sipariş tarihinden önce olamaz.", tooEarly.Errors().Single());
        var (_, planned) = await Tool("siparis", "TeslimatPlanla", order, inputs: new { teslimat = new { teslim = "2026-10-07T08:30:00Z", sekil = "kargo", kargo_firmasi = "  Hızlı   Kargo ", acil = true } });
        Assert.True(planned.GetProperty("save").GetBoolean()); // the client saves the form
        Assert.StartsWith("2026-10-07T08:30:00", planned.GetProperty("values").GetProperty("teslim").GetString());
        Assert.Equal("İlk satır\nTeslimat: kargo (Hızlı Kargo), acil", planned.GetProperty("values").GetProperty("aciklama").GetString());

        // Müşteriyi değiştir: a record chosen in the modal; its title comes back for the form's lookup.
        var (_, passive) = await Tool("siparis", "MusteriDegistir", order, inputs: new { musteri_sec = new { musteri = pasif.GetProperty("id").GetGuid() } });
        Assert.Equal("Pasif pasif; sipariş aktarılamaz.", ModalError(passive, "musteri"));
        var (same, sameWhy) = await Tool("siparis", "MusteriDegistir", order, inputs: new { musteri_sec = new { musteri = acme } });
        Assert.Equal((HttpStatusCode.BadRequest, "Sipariş zaten bu müşteride."), (same, sameWhy.Errors().Single()));
        var (_, moved) = await Tool("siparis", "MusteriDegistir", order, inputs: new { musteri_sec = new { musteri = beta, neden = "yanlış seçilmiş" } });
        Assert.Equal(beta, moved.GetProperty("values").GetProperty("musteri").GetGuid());
        Assert.Equal("Beta", moved.GetProperty("titles").GetProperty("musteri").GetString());
        Assert.EndsWith("Müşteri değişti: yanlış seçilmiş", moved.GetProperty("values").GetProperty("aciklama").GetString());

        // Nedeniyle iptal et: only a saved, open order; "Diğer" needs its explanation.
        Assert.Equal("Kaydedilmemiş sipariş iptal edilmez; formu kapatmanız yeter.", (await Tool("siparis", "NedeniyleIptalEt", order)).Body.Errors().Single());
        var id = (await Create("siparis", new { musteri = acme })).GetProperty("id").GetGuid();
        var (_, other) = await Tool("siparis", "NedeniyleIptalEt", order, id, new { iptal_nedeni = new { neden = "diger" } });
        Assert.Equal("\"Diğer\" seçildiğinde nedeni açıklayın.", ModalError(other, "aciklama"));
        var (_, cancelled) = await Tool("siparis", "NedeniyleIptalEt", order, id, new { iptal_nedeni = new { neden = "stok_yok" } });
        Assert.True(cancelled.GetProperty("save").GetBoolean());
        Assert.Equal("iptal", cancelled.GetProperty("values").GetProperty("durum").GetString());
        Assert.Equal("İlk satır\nİptal nedeni: stok yok", cancelled.GetProperty("values").GetProperty("aciklama").GetString());
    }

    [Fact]
    public async Task The_library_asks_for_the_range_and_the_scope_modal_starts_with_the_working_context()
    {
        var acme = (await Create("musteri", new { unvan = "Acme" })).GetProperty("id").GetGuid();
        await Create("siparis", new { musteri = acme });
        await Create("siparis", new { musteri = acme, tarih = "2026-08-01" });
        var form = new { unvan = "Acme" };

        // Ortak.Sor (the code library) opens the app's modal by its key, with the range it was given.
        var (_, asked) = await Tool("musteri", "SiparisSayisi", form, acme);
        var modal = asked.GetProperty("modal");
        Assert.Equal(("tarih_araligi", "2026-09-01", "2026-10-01"),
            (modal.GetProperty("key").GetString(), modal.GetProperty("values").GetProperty("baslangic").GetString(), modal.GetProperty("values").GetProperty("bitis").GetString()));
        var (_, counted) = await Tool("musteri", "SiparisSayisi", form, acme, new { tarih_araligi = new { baslangic = "2026-09-01", bitis = "2026-10-01" } });
        Assert.Equal("Acme: 01.09.2026 – 01.10.2026 arasında 1 sipariş.", counted.GetProperty("message").GetString());

        // Kapsam: company, location and period pickers start with the user's working context.
        var me = await (await client.GetAsync("/api/auth/me", Ct)).JsonAsync();
        var context = me.GetProperty("context");
        var company = context.GetProperty("company").GetProperty("id").GetGuid();
        var location = context.GetProperty("location").GetProperty("id").GetGuid();
        var (_, scope) = await Tool("musteri", "KapsamSec", form);
        var values = scope.GetProperty("modal").GetProperty("values");
        Assert.Equal((company, location, "2026-10-01"), (values.GetProperty("firma").GetGuid(), values.GetProperty("lokasyon").GetGuid(), values.GetProperty("baslangic").GetString()));

        var (_, foreign) = await Tool("musteri", "KapsamSec", form, inputs: new { kapsam = new { firma = Guid.NewGuid(), baslangic = "2026-10-01", bitis = "2026-10-31" } });
        Assert.Equal("Bu seçime yetkiniz yok.", ModalError(foreign, "firma"));
        var (_, chosen) = await Tool("musteri", "KapsamSec", form, inputs: new { kapsam = new { firma = company, baslangic = "2026-10-01", bitis = "2026-10-31" } });
        Assert.Equal("Kapsam: çalıştığınız firma, bütün lokasyonlar, dönem seçilmedi; 01.10.2026 – 31.10.2026 (31 gün).", chosen.GetProperty("message").GetString());
        var (_, here) = await Tool("musteri", "KapsamSec", form, inputs: new { kapsam = new { firma = company, lokasyon = location, baslangic = "2026-10-01", bitis = "2026-10-01" } });
        Assert.StartsWith("Kapsam: çalıştığınız firma, çalıştığınız lokasyon,", here.GetProperty("message").GetString());
    }
}
