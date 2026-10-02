using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using static Bazlama.Tests.TestHost;

namespace Bazlama.Tests.Engine;

/// <summary>The sample app end to end over HTTP: install, records, scope, periods, permissions, upgrade.</summary>
public sealed class AppEngineTests : IAsyncLifetime
{
    readonly TestHost host = new();
    HttpClient admin = null!;

    public async ValueTask InitializeAsync()
    {
        await host.SetupAsync();
        admin = host.Client();
        await admin.LoginAsync(AdminUser, AdminPassword);
        var install = await admin.PostAsJsonAsync("/api/management/apps/install", new { definition = Samples.Node("siparis"), confirmDestructive = false }, Ct);
        Assert.Equal(HttpStatusCode.OK, install.StatusCode);
    }

    public ValueTask DisposeAsync() => host.DisposeAsync();

    const string Data = "/api/runtime/data/siparis";

    static async Task<(HttpStatusCode Status, JsonElement Body)> Send(HttpClient client, HttpMethod method, string path, object? body = null)
    {
        using var request = new HttpRequestMessage(method, path) { Content = body is null ? null : JsonContent.Create(body) };
        var res = await client.SendAsync(request, Ct);
        var json = res.Content.Headers.ContentLength == 0 ? default : await res.JsonAsync();
        return (res.StatusCode, json);
    }

    static async Task<Guid> Create(HttpClient client, string entity, object values, Guid? parentId = null)
    {
        var (status, body) = await Send(client, HttpMethod.Post, $"{Data}/{entity}", new { values, parentId });
        Assert.True(status == HttpStatusCode.OK, body.ToString());
        return body.GetProperty("id").GetGuid();
    }

    static async Task<JsonElement> List(HttpClient client, string entity, string query = "") =>
        (await Send(client, HttpMethod.Get, $"{Data}/{entity}{query}")).Body;

    async Task<(Guid Customer, Guid Product, Guid Order)> SeedAsync()
    {
        var product = await Create(admin, "urun", new { kod = "U1", ad = "Vida", birim = "adet", fiyat = 12.5 });
        var customer = await Create(admin, "musteri", new { unvan = "Acme Ltd.", segment = "kurumsal", aktif = true });
        var order = await Create(admin, "siparis", new { siparis_no = "S-1", musteri = customer, tarih = "2026-10-01", durum = "taslak", teslim = "2026-10-05T10:30:00Z" });
        await Create(admin, "kalem", new { urun = product, miktar = 2.5, birim_fiyat = 12.5, iskonto = 5, not = "acil" }, order);
        return (customer, product, order);
    }

    [Fact]
    public async Task Installed_app_appears_in_runtime_and_the_same_version_cannot_be_installed_again()
    {
        var apps = await (await admin.GetAsync("/api/runtime/apps", Ct)).JsonAsync();
        var app = apps.EnumerateArray().Single();
        Assert.Equal("siparis", app.GetProperty("key").GetString());
        Assert.Equal(["musteri", "urun", "siparis"], app.GetProperty("entities").EnumerateArray().Select(e => e.GetProperty("key").GetString()));
        // The app's menu: a group with lists and a new-record form, and a list.
        var menu = app.GetProperty("menu");
        Assert.Equal(["Satış", "Ürünler"], menu.EnumerateArray().Select(m => m.GetProperty("label").GetString()));
        var sales = menu[0].GetProperty("items");
        Assert.Equal(["Siparişler", "Yeni sipariş", "Son siparişler", "Müşteriler"], sales.EnumerateArray().Select(m => m.GetProperty("label").GetString()));
        Assert.Equal(("siparis", "siparis"), (sales[1].GetProperty("entity").GetString(), sales[1].GetProperty("form").GetString()));
        Assert.Equal(("urun", "urun"), (menu[1].GetProperty("entity").GetString(), menu[1].GetProperty("list").GetString()));

        var plan = await (await admin.PostAsJsonAsync("/api/management/apps/plan", Samples.Node("siparis"), Ct)).JsonAsync();
        Assert.Contains("Yeni versiyon kurulu versiyondan (1.0.0) büyük olmalı.", plan.GetProperty("errors").EnumerateArray().Select(e => e.GetString()));

        // App permissions are in the catalog for the groups screen.
        var permissions = await (await admin.GetAsync("/api/management/groups/permissions", Ct)).JsonAsync();
        Assert.Contains(permissions.EnumerateArray(), p => p.GetProperty("key").GetString() == "app.siparis.siparis.write");
    }

    [Fact]
    public async Task Records_with_references_details_titles_search_and_validation()
    {
        var (_, _, order) = await SeedAsync();

        var orders = await List(admin, "siparis");
        Assert.Equal(1, orders.GetProperty("total").GetInt32());
        var o = orders.GetProperty("items")[0];
        Assert.Equal("Acme Ltd.", o.GetProperty("_titles").GetProperty("musteri").GetString());
        Assert.Equal("2026-10-01", o.GetProperty("tarih").GetString());
        Assert.Equal(new DateTime(2026, 10, 5, 10, 30, 0, DateTimeKind.Utc), o.GetProperty("teslim").GetDateTime().ToUniversalTime());

        Assert.Equal(HttpStatusCode.BadRequest, (await Send(admin, HttpMethod.Get, $"{Data}/kalem")).Status);
        var lines = await List(admin, "kalem", $"?parent={order}");
        var line = lines.GetProperty("items")[0];
        Assert.Equal("Vida", line.GetProperty("_titles").GetProperty("urun").GetString());
        Assert.Equal(2.5m, line.GetProperty("miktar").GetDecimal());
        Assert.Equal(5, line.GetProperty("iskonto").GetInt64());
        Assert.Equal("acil", line.GetProperty("not").GetString());

        Assert.Equal(1, (await List(admin, "musteri", "?q=acm")).GetProperty("total").GetInt32());
        Assert.Equal(0, (await List(admin, "musteri", "?q=xyz")).GetProperty("total").GetInt32());

        var (status, body) = await Send(admin, HttpMethod.Post, $"{Data}/siparis", new { values = new { siparis_no = "S-2", durum = "yok", tarih = "01.10.2026" } });
        Assert.Equal(HttpStatusCode.BadRequest, status);
        var fieldErrors = body.GetProperty("fieldErrors");
        Assert.Equal("Zorunlu alan.", fieldErrors.GetProperty("musteri").GetString());
        Assert.Equal("Geçerli bir seçenek seçin.", fieldErrors.GetProperty("durum").GetString());
        Assert.Equal("Tarih girin (yyyy-aa-gg).", fieldErrors.GetProperty("tarih").GetString());

        var tooPrecise = await Send(admin, HttpMethod.Post, $"{Data}/urun", new { values = new { kod = "U2", ad = "Somun", birim = "adet", fiyat = 1.234 } });
        Assert.Equal("En fazla 2 ondalık basamak.", tooPrecise.Body.GetProperty("fieldErrors").GetProperty("fiyat").GetString());
    }

    [Fact]
    public async Task Updates_need_the_current_row_version_and_are_audited()
    {
        var (_, _, order) = await SeedAsync();
        var record = (await Send(admin, HttpMethod.Get, $"{Data}/siparis/{order}")).Body;
        Assert.Equal(1, record.GetProperty("rowVersion").GetInt32());

        Assert.Equal(HttpStatusCode.OK, (await Send(admin, HttpMethod.Put, $"{Data}/siparis/{order}", new { values = new { durum = "onaylandi" }, rowVersion = 1 })).Status);
        var stale = await Send(admin, HttpMethod.Put, $"{Data}/siparis/{order}", new { values = new { durum = "iptal" }, rowVersion = 1 });
        Assert.Equal(HttpStatusCode.Conflict, stale.Status);

        var updated = (await Send(admin, HttpMethod.Get, $"{Data}/siparis/{order}")).Body;
        Assert.Equal("onaylandi", updated.GetProperty("durum").GetString());
        Assert.Equal("S-1", updated.GetProperty("siparis_no").GetString()); // fields not sent keep their value
        Assert.Equal(2, updated.GetProperty("rowVersion").GetInt32());

        var audit = await (await admin.GetAsync("/api/management/audit?q=siparis.siparis.update", Ct)).JsonAsync();
        Assert.Contains("onaylandi", audit.GetProperty("items")[0].GetProperty("data").GetString());
    }

    [Fact]
    public async Task Used_records_cannot_be_deleted_and_deleting_a_master_deletes_its_details()
    {
        var (customer, _, order) = await SeedAsync();
        var refused = await Send(admin, HttpMethod.Delete, $"{Data}/musteri/{customer}");
        Assert.Equal(HttpStatusCode.BadRequest, refused.Status);
        Assert.Contains("Siparişler", refused.Body.GetProperty("errors")[0].GetString());

        Assert.Equal(HttpStatusCode.OK, (await Send(admin, HttpMethod.Delete, $"{Data}/siparis/{order}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await Send(admin, HttpMethod.Get, $"{Data}/siparis/{order}")).Status);
        Assert.Equal(0, (await List(admin, "kalem", $"?parent={order}")).GetProperty("total").GetInt32());
        Assert.Equal(HttpStatusCode.OK, (await Send(admin, HttpMethod.Delete, $"{Data}/musteri/{customer}")).Status);
    }

    [Fact]
    public async Task Records_are_seen_only_in_their_location_and_closed_periods_are_read_only()
    {
        await SeedAsync();
        var me = await (await admin.GetAsync("/api/auth/me", Ct)).JsonAsync();
        var context = me.GetProperty("context");
        var company = context.GetProperty("company").GetProperty("id").GetGuid();
        var period = context.GetProperty("period").GetProperty("id").GetGuid();

        var fab = (await Send(admin, HttpMethod.Post, "/api/management/organization/locations", new { companyId = company, code = "FAB", name = "Fabrika", isActive = true })).Body.GetProperty("id").GetGuid();
        await Send(admin, HttpMethod.Put, "/api/auth/context", new { companyId = company, locationId = fab, periodId = period });
        Assert.Equal(0, (await List(admin, "siparis")).GetProperty("total").GetInt32()); // location scope
        Assert.Equal(1, (await List(admin, "musteri")).GetProperty("total").GetInt32()); // company scope
        Assert.Equal(1, (await List(admin, "urun")).GetProperty("total").GetInt32());    // global

        // Without a period, period-bound records cannot be read or written.
        await Send(admin, HttpMethod.Put, "/api/auth/context", new { companyId = company, locationId = fab });
        Assert.Equal(HttpStatusCode.Forbidden, (await Send(admin, HttpMethod.Get, $"{Data}/siparis")).Status);

        await Send(admin, HttpMethod.Put, $"/api/management/organization/periods/{period}",
            new { companyId = company, code = "2026", name = "2026", startDate = "2026-01-01", endDate = "2026-12-31", isClosed = true });
        await Send(admin, HttpMethod.Put, "/api/auth/context", new { companyId = company, locationId = fab, periodId = period });
        var customer = (await List(admin, "musteri")).GetProperty("items")[0].GetProperty("id").GetGuid();
        var closed = await Send(admin, HttpMethod.Post, $"{Data}/siparis", new { values = new { siparis_no = "S-9", musteri = customer, tarih = "2026-11-01", durum = "taslak" } });
        Assert.Equal("Dönem kapalı; kayıt eklenemez.", closed.Body.GetProperty("errors")[0].GetString());
    }

    [Fact]
    public async Task Users_see_and_change_only_what_their_groups_allow()
    {
        await SeedAsync();
        var org = await (await admin.GetAsync("/api/management/organization", Ct)).JsonAsync();
        var company = org[0].GetProperty("id").GetGuid();
        var user = (await Send(admin, HttpMethod.Post, "/api/management/users", new { userName = "ali", displayName = "Ali", password = "Kullanici2026x", mustChangePassword = false })).Body.GetProperty("id").GetGuid();
        await Send(admin, HttpMethod.Put, $"/api/management/users/{user}/access", new[] { new { companyId = company } });
        var group = (await Send(admin, HttpMethod.Post, "/api/management/groups", new { code = "siparis-okur", name = "Sipariş okur" })).Body.GetProperty("id").GetGuid();
        await Send(admin, HttpMethod.Put, $"/api/management/groups/{group}/permissions", new[] { "app.siparis.siparis.read" });
        await Send(admin, HttpMethod.Put, $"/api/management/groups/{group}/members", new[] { new { userId = user, locationId = (Guid?)null } });

        var ali = host.Client();
        await ali.LoginAsync("ali", "Kullanici2026x");
        var apps = await (await ali.GetAsync("/api/runtime/apps", Ct)).JsonAsync();
        Assert.Equal(["siparis"], apps[0].GetProperty("entities").EnumerateArray().Select(e => e.GetProperty("key").GetString()));
        // Only the menu items of readable entities; the group stays because it is not empty.
        var menu = apps[0].GetProperty("menu");
        Assert.Equal("Satış", menu.EnumerateArray().Single().GetProperty("label").GetString());
        Assert.Equal(["Siparişler", "Yeni sipariş", "Son siparişler"], menu[0].GetProperty("items").EnumerateArray().Select(m => m.GetProperty("label").GetString()));

        var orders = await List(ali, "siparis");
        Assert.Equal(1, orders.GetProperty("total").GetInt32());
        var order = orders.GetProperty("items")[0].GetProperty("id").GetGuid();
        Assert.Equal(1, (await List(ali, "kalem", $"?parent={order}")).GetProperty("total").GetInt32()); // details follow the master
        Assert.Equal(HttpStatusCode.Forbidden, (await Send(ali, HttpMethod.Get, $"{Data}/musteri")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await Send(ali, HttpMethod.Put, $"{Data}/siparis/{order}", new { values = new { durum = "iptal" }, rowVersion = 1 })).Status);
    }

    [Fact]
    public async Task An_upgrade_adds_columns_and_drops_them_only_when_confirmed()
    {
        var (_, _, order) = await SeedAsync();
        var v2 = Samples.Node("siparis");
        v2["version"] = "1.1.0";
        var siparis = v2["entities"]!.AsArray()[2]!.AsObject();
        var fields = siparis["fields"]!.AsArray();
        fields.RemoveAt(5); // aciklama
        Samples.Unuse(v2, "siparis", "aciklama");
        fields.Add(new JsonObject { ["key"] = "oncelik", ["label"] = "Öncelik", ["type"] = "integer" });

        var plan = await (await admin.PostAsJsonAsync("/api/management/apps/plan", v2, Ct)).JsonAsync();
        Assert.True(plan.GetProperty("hasDestructive").GetBoolean());

        var refused = await admin.PostAsJsonAsync("/api/management/apps/install", new { definition = v2, confirmDestructive = false }, Ct);
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        var installed = await admin.PostAsJsonAsync("/api/management/apps/install", new { definition = v2, confirmDestructive = true }, Ct);
        Assert.Equal(HttpStatusCode.OK, installed.StatusCode);

        var record = (await Send(admin, HttpMethod.Get, $"{Data}/siparis/{order}")).Body;
        Assert.Equal("S-1", record.GetProperty("siparis_no").GetString()); // data kept
        Assert.False(record.TryGetProperty("aciklama", out _));
        Assert.Equal(JsonValueKind.Null, record.GetProperty("oncelik").ValueKind);
        Assert.Equal(HttpStatusCode.OK, (await Send(admin, HttpMethod.Put, $"{Data}/siparis/{order}", new { values = new { oncelik = 3 }, rowVersion = 1 })).Status);
        Assert.Equal(1, (await List(admin, "kalem", $"?parent={order}")).GetProperty("total").GetInt32()); // details still linked

        var detail = await (await admin.GetAsync("/api/management/apps/siparis", Ct)).JsonAsync();
        Assert.Equal(2, detail.GetProperty("versions").GetArrayLength());
    }
}
