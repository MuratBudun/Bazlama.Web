using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Bazlama.Tests.Engine;
using static Bazlama.Tests.TestHost;

namespace Bazlama.Tests.Development;

/// <summary>A draft's preview: its own tables and code, before anything is published.</summary>
public sealed class PreviewTests : IAsyncLifetime
{
    readonly TestHost host = new();
    HttpClient dev = null!;
    const string Data = "/api/runtime/data/siparis_pv";

    const string Code = """
        public class UrunEvents : EntityEvents<Urun>
        {
            public override Task ValidateAsync(Urun u, bool isNew, Errors errors, IAppContext context)
            {
                if (u.Kod is { } kod && !kod.StartsWith("U-")) errors.Add("kod", "Ürün kodu U- ile başlamalı.");
                return Task.CompletedTask;
            }
        }
        """;

    public async ValueTask InitializeAsync()
    {
        await host.SetupAsync();
        dev = host.Client();
        await dev.LoginAsync(AdminUser, AdminPassword);
    }

    public async ValueTask DisposeAsync() => await host.DisposeAsync();

    static async Task<JsonElement> Ok(HttpResponseMessage res)
    {
        if (!res.IsSuccessStatusCode) Assert.Fail($"{(int)res.StatusCode}: {await res.Content.ReadAsStringAsync(Ct)}");
        return res.StatusCode == HttpStatusCode.NoContent ? default : await res.JsonAsync();
    }

    Task<HttpResponseMessage> Preview(bool reset = false) => dev.PostAsJsonAsync("/api/development/apps/siparis/preview", new { reset }, Ct);
    async Task<int> Total(string entity) => (await Ok(await dev.GetAsync($"{Data}/{entity}", Ct))).GetProperty("total").GetInt32();
    Task<HttpResponseMessage> AddProduct(string kod) =>
        dev.PostAsJsonAsync($"{Data}/urun", new { values = new { kod, ad = "Vida", birim = "adet" } }, Ct);

    [Fact]
    public async Task A_draft_runs_with_its_code_in_tables_of_its_own_until_it_is_removed()
    {
        await Ok(await dev.PostAsJsonAsync("/api/development/apps", new { key = "siparis", name = "Sipariş Takibi" }, Ct));
        var draft = Samples.Node("siparis");
        await Ok(await dev.PutAsJsonAsync("/api/development/apps/siparis/draft", draft, Ct));
        await Ok(await dev.PutAsJsonAsync("/api/development/apps/siparis/files", new { path = "UrunEvents.cs", content = Code }, Ct));

        var prepared = await Ok(await Preview());
        Assert.Equal("siparis_pv", prepared.GetProperty("key").GetString());
        Assert.True(prepared.GetProperty("code").GetProperty("success").GetBoolean());
        Assert.Contains(prepared.GetProperty("changes").EnumerateArray(), c => c.GetString()!.Contains("app_siparis_pv_urun"));

        // Not an app: Runtime and Management do not list it; its own endpoint serves it with its menu.
        Assert.Empty((await Ok(await dev.GetAsync("/api/runtime/apps", Ct))).EnumerateArray());
        Assert.Empty((await Ok(await dev.GetAsync("/api/management/apps", Ct))).EnumerateArray());
        var preview = await Ok(await dev.GetAsync("/api/runtime/previews/siparis_pv", Ct));
        Assert.Equal("siparis_pv", preview.GetProperty("definition").GetProperty("key").GetString());
        Assert.Equal("siparis", preview.GetProperty("source").GetString());
        Assert.Equal(["Satış", "Ürünler"], preview.GetProperty("menu").EnumerateArray().Select(m => m.GetProperty("label").GetString()));
        Assert.True(preview.GetProperty("access").GetProperty("urun").GetProperty("canWrite").GetBoolean());

        // The draft's code runs on the preview's records.
        var refused = await AddProduct("X-1");
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Equal("Ürün kodu U- ile başlamalı.", (await refused.JsonAsync()).GetProperty("fieldErrors").GetProperty("kod").GetString());
        await Ok(await AddProduct("U-1"));
        Assert.Equal(1, await Total("urun"));

        // A new field: the table changes, the records stay.
        draft["entities"]!.AsArray()[1]!["fields"]!.AsArray().Add(new JsonObject { ["key"] = "barkod", ["label"] = "Barkod", ["type"] = "text" });
        await Ok(await dev.PutAsJsonAsync("/api/development/apps/siparis/draft", draft, Ct));
        var again = await Ok(await Preview());
        Assert.False(again.GetProperty("reset").GetBoolean());
        Assert.Contains(again.GetProperty("changes").EnumerateArray(), c => c.GetString()!.Contains("barkod"));
        Assert.Equal(1, await Total("urun"));

        // A type change an upgrade would refuse: the preview starts over.
        draft["entities"]!.AsArray()[1]!["fields"]!.AsArray().Last()!["type"] = "integer";
        await Ok(await dev.PutAsJsonAsync("/api/development/apps/siparis/draft", draft, Ct));
        Assert.True((await Ok(await Preview())).GetProperty("reset").GetBoolean());
        Assert.Equal(0, await Total("urun"));

        // Others cannot see it.
        var user = await Ok(await dev.PostAsJsonAsync("/api/management/users", new { userName = "ali", displayName = "Ali", password = "Kullanici2026x", mustChangePassword = false }, Ct));
        Assert.NotEqual(JsonValueKind.Undefined, user.ValueKind);
        var ali = host.Client();
        await ali.LoginAsync("ali", "Kullanici2026x");
        Assert.Equal(HttpStatusCode.Forbidden, (await ali.GetAsync("/api/runtime/previews/siparis_pv", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await ali.GetAsync($"{Data}/urun", Ct)).StatusCode);

        await Ok(await dev.DeleteAsync("/api/development/apps/siparis/preview", Ct));
        Assert.Equal(HttpStatusCode.NotFound, (await dev.GetAsync("/api/runtime/previews/siparis_pv", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await dev.GetAsync($"{Data}/urun", Ct)).StatusCode);
    }

    [Fact]
    public async Task An_invalid_draft_is_not_previewed_and_preview_keys_are_reserved()
    {
        await Ok(await dev.PostAsJsonAsync("/api/development/apps", new { key = "siparis", name = "Sipariş Takibi" }, Ct));
        var draft = Samples.Node("siparis");
        draft["entities"]!.AsArray()[1]!["fields"]!.AsArray().Add(new JsonObject { ["key"] = "id", ["label"] = "Id" });
        await Ok(await dev.PutAsJsonAsync("/api/development/apps/siparis/draft", draft, Ct));
        var res = await Preview();
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Contains((await res.JsonAsync()).GetProperty("errors").EnumerateArray(), e => e.GetString()!.Contains("sistem kolonu"));

        var app = Samples.Node("siparis");
        app["key"] = "deneme_pv";
        Assert.Contains("App anahtarı '_pv' ile bitemez (önizleme için ayrılmış).", Bazlama.Engine.Metadata.MetadataValidator.Validate(Bazlama.Engine.Metadata.AppDefinition.Parse(app.ToJsonString())));
    }

    [Fact]
    public async Task Build_explains_code_written_for_the_draft_and_publishing_builds_it()
    {
        await Ok(await dev.PostAsJsonAsync("/api/development/apps", new { key = "siparis", name = "Sipariş Takibi" }, Ct));
        var draft = Samples.Node("siparis");
        await Ok(await dev.PutAsJsonAsync("/api/development/apps/siparis/draft", draft, Ct));
        await Ok(await dev.PostAsJsonAsync("/api/development/apps/siparis/publish", new { version = "1.0.0", confirmDestructive = false }, Ct));

        // The draft gets a field and the code uses it: the editor (draft) is happy, 1.0.0 is not.
        draft["entities"]!.AsArray()[1]!["fields"]!.AsArray().Add(new JsonObject { ["key"] = "barkod", ["label"] = "Barkod", ["type"] = "text" });
        await Ok(await dev.PutAsJsonAsync("/api/development/apps/siparis/draft", draft, Ct));
        const string code = """
            public class UrunEvents : EntityEvents<Urun>
            {
                public override Task ValidateAsync(Urun u, bool isNew, Errors errors, IAppContext context)
                {
                    if (u.Barkod is { Length: > 13 }) errors.Add("barkod", "Barkod en fazla 13 hane.");
                    return Task.CompletedTask;
                }
            }
            """;
        await Ok(await dev.PutAsJsonAsync("/api/development/apps/siparis/files", new { path = "UrunEvents.cs", content = code }, Ct));

        var build = await dev.PostAsync("/api/development/apps/siparis/build", null, Ct);
        Assert.Equal(HttpStatusCode.BadRequest, build.StatusCode);
        Assert.StartsWith("Kod taslaktaki tanıma göre yazılmış; yayındaki v1.0.0 ile derlenmiyor.", (await build.JsonAsync()).GetProperty("errors")[0].GetString());

        await Ok(await dev.PostAsJsonAsync("/api/development/apps/siparis/publish", new { version = "1.1.0", confirmDestructive = false }, Ct));
        var app = (await Ok(await dev.GetAsync("/api/development/apps", Ct))).EnumerateArray().Single();
        Assert.Equal("1.1.0", app.GetProperty("activeBuild").GetProperty("appVersion").GetString());
        Assert.False(app.GetProperty("stale").GetBoolean());
        // With the code built for the published version, the package can be made.
        var export = await dev.GetAsync("/api/management/apps/siparis/export", Ct);
        Assert.Equal(HttpStatusCode.OK, export.StatusCode);
        Assert.Equal("application/zip", export.Content.Headers.ContentType?.MediaType);
    }
}
