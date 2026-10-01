using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Bazlama.Tests.Engine;
using static Bazlama.Tests.TestHost;

namespace Bazlama.Tests.Code;

/// <summary>App code end to end: workspace files, build, events around saves, actions, libraries, upgrades.</summary>
public sealed class AppCodeTests : IAsyncLifetime
{
    readonly TestHost host = new();
    HttpClient admin = null!;
    const string Dev = "/api/development/apps/siparis";
    const string Data = "/api/runtime/data/siparis";

    const string Events = """
        namespace Siparisler;

        public class SiparisEvents : EntityEvents<Siparis>
        {
            public override async Task ValidateAsync(Siparis s, bool isNew, Errors errors, IAppContext context)
            {
                if (s.SiparisNo is { } no && !no.StartsWith("S-")) errors.Add("siparis_no", "Sipariş no 'S-' ile başlamalı.");
                if (s.Musteri is { } id && await context.Records.GetAsync<Musteri>(id) is { Aktif: false })
                    errors.Add("musteri", "Pasif müşteriye sipariş açılamaz.");
            }

            public override Task BeforeSaveAsync(Siparis s, bool isNew, IAppContext context)
            {
                if (isNew) s.Aciklama ??= $"Açan: {context.UserName}";
                return Task.CompletedTask;
            }

            public override Task AfterSaveAsync(Siparis s, bool isNew, IAppContext context) =>
                s.SiparisNo == "S-HATA" ? throw new InvalidOperationException("kayıt sonrası hata") : Task.CompletedTask;

            public override Task BeforeDeleteAsync(Siparis s, Errors errors, IAppContext context)
            {
                if (s.Durum == Siparis.DurumValues.Onaylandi) errors.Add("Onaylı sipariş silinemez.");
                return Task.CompletedTask;
            }
        }

        [Action("Onayla", Icon = "check", Confirm = "Sipariş onaylansın mı?")]
        public class Onayla : RecordAction<Siparis>
        {
            public override Task<ActionResult> RunAsync(Siparis s, IAppContext context)
            {
                if (s.Durum != Siparis.DurumValues.Taslak) return Task.FromResult(ActionResult.Fail("Yalnız taslak sipariş onaylanır."));
                s.Durum = Siparis.DurumValues.Onaylandi;
                return Task.FromResult(ActionResult.Save("Sipariş onaylandı."));
            }
        }
        """;

    public async ValueTask InitializeAsync()
    {
        await host.SetupAsync();
        admin = host.Client();
        await admin.LoginAsync(AdminUser, AdminPassword);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync("/api/management/apps/install", new { definition = Samples.Node("siparis"), confirmDestructive = false }, Ct)).StatusCode);
    }

    public ValueTask DisposeAsync() => host.DisposeAsync();

    async Task SaveFile(string path, string content) =>
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsJsonAsync($"{Dev}/files", new { path, content }, Ct)).StatusCode);

    async Task<JsonElement> Build()
    {
        var res = await admin.PostAsync($"{Dev}/build", null, Ct);
        var body = await res.JsonAsync();
        Assert.True(res.IsSuccessStatusCode, body.ToString());
        return body;
    }

    async Task<(HttpStatusCode Status, JsonElement Body)> Post(string path, object body)
    {
        var res = await admin.PostAsJsonAsync(path, body, Ct);
        return (res.StatusCode, await res.JsonAsync());
    }

    async Task<Guid> Customer(bool active)
    {
        var (_, body) = await Post($"{Data}/musteri", new { values = new { unvan = active ? "Aktif A.Ş." : "Pasif A.Ş.", aktif = active } });
        return body.GetProperty("id").GetGuid();
    }

    [Fact]
    public async Task Events_validate_change_and_roll_back_saves_and_actions_run_on_records()
    {
        await SaveFile("Siparis/SiparisEvents.cs", Events);
        Assert.Equal(1, (await Build()).GetProperty("number").GetInt32());

        var active = await Customer(true);
        var passive = await Customer(false);
        var order = new { siparis_no = "X-1", musteri = passive, tarih = "2026-10-01", durum = "taslak" };

        var (status, body) = await Post($"{Data}/siparis", new { values = order });
        Assert.Equal(HttpStatusCode.BadRequest, status);
        Assert.Equal("Sipariş no 'S-' ile başlamalı.", body.GetProperty("fieldErrors").GetProperty("siparis_no").GetString());
        Assert.Equal("Pasif müşteriye sipariş açılamaz.", body.GetProperty("fieldErrors").GetProperty("musteri").GetString());

        // AfterSave fails: nothing is stored.
        var (failed, failure) = await Post($"{Data}/siparis", new { values = order with { siparis_no = "S-HATA", musteri = active } });
        Assert.Equal(HttpStatusCode.BadRequest, failed);
        Assert.Contains("kayıt sonrası hata", failure.GetProperty("errors")[0].GetString());
        Assert.Equal(0, (await (await admin.GetAsync($"{Data}/siparis", Ct)).JsonAsync()).GetProperty("total").GetInt32());

        var (ok, created) = await Post($"{Data}/siparis", new { values = order with { siparis_no = "S-1", musteri = active } });
        Assert.Equal(HttpStatusCode.OK, ok);
        var id = created.GetProperty("id").GetGuid();
        var record = await (await admin.GetAsync($"{Data}/siparis/{id}", Ct)).JsonAsync();
        Assert.Equal("Açan: admin", record.GetProperty("aciklama").GetString()); // BeforeSave

        // The action is offered with the app, and runs.
        var app = await (await admin.GetAsync("/api/runtime/apps/siparis", Ct)).JsonAsync();
        var action = app.GetProperty("actions").GetProperty("siparis")[0];
        Assert.Equal(("Onayla", "Onayla", "Sipariş onaylansın mı?"), (action.GetProperty("key").GetString(), action.GetProperty("label").GetString(), action.GetProperty("confirm").GetString()));
        var (ran, result) = await Post($"{Data}/siparis/{id}/actions/Onayla", new { });
        Assert.Equal(HttpStatusCode.OK, ran);
        Assert.Equal("Sipariş onaylandı.", result.GetProperty("message").GetString());
        Assert.Equal("onaylandi", (await (await admin.GetAsync($"{Data}/siparis/{id}", Ct)).JsonAsync()).GetProperty("durum").GetString());
        var (again, refused) = await Post($"{Data}/siparis/{id}/actions/Onayla", new { });
        Assert.Equal(HttpStatusCode.BadRequest, again);
        Assert.Equal("Yalnız taslak sipariş onaylanır.", refused.GetProperty("errors")[0].GetString());

        // BeforeDelete refuses.
        var delete = await admin.DeleteAsync($"{Data}/siparis/{id}", Ct);
        Assert.Equal(HttpStatusCode.BadRequest, delete.StatusCode);
        Assert.Equal("Onaylı sipariş silinemez.", (await delete.JsonAsync()).GetProperty("errors")[0].GetString());
    }

    [Fact]
    public async Task Check_reports_unsaved_errors_and_a_new_build_replaces_the_old_without_a_restart()
    {
        var check = await Post($"{Dev}/check", new { files = new[] { new { path = "A.cs", content = "public class A { int X() => System.IO.File.ReadAllBytes(\"x\").Length; }" } } });
        Assert.False(check.Body.GetProperty("success").GetBoolean());
        var diagnostic = check.Body.GetProperty("diagnostics").EnumerateArray().Single(d => d.GetProperty("code").GetString() == "BZ0001");
        Assert.Equal("A.cs", diagnostic.GetProperty("path").GetString());

        await SaveFile("Siparis/SiparisEvents.cs", Events);
        await Build();
        var active = await Customer(true);
        Assert.Equal(HttpStatusCode.BadRequest, (await Post($"{Data}/siparis", new { values = new { siparis_no = "X-1", musteri = active, tarih = "2026-10-01", durum = "taslak" } })).Status);

        await SaveFile("Siparis/SiparisEvents.cs", """
            public class SiparisEvents : EntityEvents<Siparis>
            {
                public override Task BeforeSaveAsync(Siparis s, bool isNew, IAppContext context)
                {
                    s.SiparisNo = s.SiparisNo?.ToUpperInvariant();
                    return Task.CompletedTask;
                }
            }
            """);
        Assert.Equal(2, (await Build()).GetProperty("number").GetInt32());
        var (status, body) = await Post($"{Data}/siparis", new { values = new { siparis_no = "x-1", musteri = active, tarih = "2026-10-01", durum = "taslak" } });
        Assert.Equal(HttpStatusCode.OK, status);
        var record = await (await admin.GetAsync($"{Data}/siparis/{body.GetProperty("id").GetGuid()}", Ct)).JsonAsync();
        Assert.Equal("X-1", record.GetProperty("siparis_no").GetString());
    }

    [Fact]
    public async Task Apps_use_a_published_library_version()
    {
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsJsonAsync("/api/development/libraries", new { key = "metin", name = "Metin yardımcıları" }, Ct)).StatusCode);
        await admin.PutAsJsonAsync("/api/development/libraries/metin/files", new
        {
            path = "Metin.cs",
            content = """
                namespace Ortak;
                public static class Metin
                {
                    public static string Kod(string onek, int sira) => $"{onek}-{sira:D4}";
                }
                """,
        }, Ct);
        var publish = await admin.PostAsJsonAsync("/api/development/libraries/metin/publish", new { version = "1.0.0" }, Ct);
        Assert.Equal(HttpStatusCode.OK, publish.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync("/api/development/libraries/metin/publish", new { version = "1.0.0" }, Ct)).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsJsonAsync($"{Dev}/libraries", new[] { new { key = "metin", version = "1.0.0" } }, Ct)).StatusCode);
        await SaveFile("UrunEvents.cs", """
            public class UrunEvents : EntityEvents<Urun>
            {
                public override Task BeforeSaveAsync(Urun u, bool isNew, IAppContext context)
                {
                    if (isNew && string.IsNullOrEmpty(u.Kod)) u.Kod = Ortak.Metin.Kod("U", 7);
                    return Task.CompletedTask;
                }
            }
            """);
        await Build();
        var (status, body) = await Post($"{Data}/urun", new { values = new { ad = "Vida", birim = "adet" } });
        Assert.True(status == HttpStatusCode.OK, body.ToString());
        var urun = await (await admin.GetAsync($"{Data}/urun/{body.GetProperty("id").GetGuid()}", Ct)).JsonAsync();
        Assert.Equal("U-0007", urun.GetProperty("kod").GetString());
    }

    [Fact]
    public async Task A_new_app_version_rebuilds_the_code_and_code_that_no_longer_compiles_is_unloaded()
    {
        await SaveFile("Siparis/SiparisEvents.cs", Events);
        await Build();

        var v2 = Samples.Node("siparis");
        v2["version"] = "1.1.0";
        v2["entities"]!.AsArray()[2]!["fields"]!.AsArray().Add(new JsonObject { ["key"] = "oncelik", ["label"] = "Öncelik", ["type"] = "integer" });
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync("/api/management/apps/install", new { definition = v2, confirmDestructive = false }, Ct)).StatusCode);
        var apps = await (await admin.GetAsync("/api/development/apps", Ct)).JsonAsync();
        var app = apps.EnumerateArray().Single();
        Assert.Equal(2, app.GetProperty("activeBuild").GetProperty("number").GetInt32());
        Assert.False(app.GetProperty("stale").GetBoolean());

        // 1.2.0 drops "aciklama", which the code uses: the rebuild fails and the code is unloaded.
        var v3 = Samples.Node("siparis");
        v3["version"] = "1.2.0";
        var siparis = v3["entities"]!.AsArray()[2]!.AsObject();
        siparis["fields"]!.AsArray().RemoveAt(5);
        siparis["form"] = null;
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync("/api/management/apps/install", new { definition = v3, confirmDestructive = true }, Ct)).StatusCode);
        app = (await (await admin.GetAsync("/api/development/apps", Ct)).JsonAsync()).EnumerateArray().Single();
        Assert.True(app.GetProperty("stale").GetBoolean());
        Assert.False(app.GetProperty("loaded").GetBoolean());
    }

    [Fact]
    public async Task Code_cannot_be_changed_outside_a_development_installation()
    {
        await using var test = new TestHost(environmentMode: "Test");
        await test.SetupAsync();
        var client = test.Client();
        await client.LoginAsync(AdminUser, AdminPassword);
        await client.PostAsJsonAsync("/api/management/apps/install", new { definition = Samples.Node("siparis"), confirmDestructive = false }, Ct);
        var res = await client.PutAsJsonAsync($"{Dev}/files", new { path = "A.cs", content = "public class A {}" }, Ct);
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync($"{Dev}/workspace", Ct)).StatusCode); // reading is fine
    }
}
