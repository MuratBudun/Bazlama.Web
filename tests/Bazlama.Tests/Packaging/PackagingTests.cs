using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Bazlama.Tests.Engine;
using static Bazlama.Tests.TestHost;

namespace Bazlama.Tests.Packaging;

/// <summary>
/// The prototype's acceptance scenario: an app is designed and published in a development
/// installation, exported as .bzapp and imported into a test installation (where apps change
/// only by package); then an upgrade travels the same way.
/// </summary>
public sealed class PackagingTests : IAsyncLifetime
{
    readonly TestHost devHost = new();
    readonly TestHost testHost = new(environmentMode: "Test");
    HttpClient dev = null!;
    HttpClient test = null!;

    const string Code = """
        public class SiparisEvents : EntityEvents<Siparis>
        {
            public override Task ValidateAsync(Siparis s, bool isNew, Errors errors, IAppContext context)
            {
                if (s.SiparisNo is { } no && !no.StartsWith("S-")) errors.Add("siparis_no", Ortak.Metin.Mesaj("S-"));
                return Task.CompletedTask;
            }
        }
        """;

    public async ValueTask InitializeAsync()
    {
        await devHost.SetupAsync();
        await testHost.SetupAsync();
        dev = devHost.Client();
        test = testHost.Client();
        await dev.LoginAsync(AdminUser, AdminPassword);
        await test.LoginAsync(AdminUser, AdminPassword);
    }

    public async ValueTask DisposeAsync()
    {
        await devHost.DisposeAsync();
        await testHost.DisposeAsync();
    }

    static async Task Ok(HttpResponseMessage res)
    {
        if (!res.IsSuccessStatusCode) Assert.Fail($"{(int)res.StatusCode}: {await res.Content.ReadAsStringAsync(Ct)}");
    }

    /// <summary>In the development installation: a new app, its draft, a library, code, published as 1.0.0.</summary>
    async Task DesignAndPublishAsync()
    {
        await Ok(await dev.PostAsJsonAsync("/api/development/apps", new { key = "siparis", name = "Sipariş Takibi" }, Ct));
        await Ok(await dev.PutAsJsonAsync("/api/development/apps/siparis/draft", Samples.Node("siparis"), Ct));

        await Ok(await dev.PostAsJsonAsync("/api/development/libraries", new { key = "metin", name = "Metin" }, Ct));
        await Ok(await dev.PutAsJsonAsync("/api/development/libraries/metin/files", new { path = "Metin.cs", content = "namespace Ortak; public static class Metin { public static string Mesaj(string onek) => $\"Sipariş no '{onek}' ile başlamalı.\"; }" }, Ct));
        await Ok(await dev.PostAsJsonAsync("/api/development/libraries/metin/publish", new { version = "1.0.0" }, Ct));
        await Ok(await dev.PutAsJsonAsync("/api/development/apps/siparis/libraries", new[] { new { key = "metin", version = "1.0.0" } }, Ct));
        await Ok(await dev.PutAsJsonAsync("/api/development/apps/siparis/files", new { path = "SiparisEvents.cs", content = Code }, Ct));

        var plan = await (await dev.PostAsJsonAsync("/api/development/apps/siparis/publish/plan", new { version = "1.0.0" }, Ct)).JsonAsync();
        Assert.Empty(plan.GetProperty("plan").GetProperty("errors").EnumerateArray());
        Assert.True(plan.GetProperty("code").GetProperty("success").GetBoolean());
        await Ok(await dev.PostAsJsonAsync("/api/development/apps/siparis/publish", new { version = "1.0.0", confirmDestructive = false }, Ct));
    }

    async Task<byte[]> ExportAsync()
    {
        var res = await dev.GetAsync("/api/management/apps/siparis/export", Ct);
        await Ok(res);
        Assert.Equal("siparis-" + (await (await dev.GetAsync("/api/management/apps", Ct)).JsonAsync())[0].GetProperty("version").GetString() + ".bzapp",
            res.Content.Headers.ContentDisposition?.FileNameStar ?? res.Content.Headers.ContentDisposition?.FileName?.Trim('"'));
        return await res.Content.ReadAsByteArrayAsync(Ct);
    }

    static ByteArrayContent Package(byte[] bytes)
    {
        var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        return content;
    }

    [Fact]
    public async Task An_app_designed_and_published_in_development_is_imported_into_a_test_installation()
    {
        await DesignAndPublishAsync();
        var package = await ExportAsync();

        // The test installation refuses bare definitions…
        Assert.Equal(HttpStatusCode.BadRequest, (await test.PostAsJsonAsync("/api/management/apps/install", new { definition = Samples.Node("siparis"), confirmDestructive = false }, Ct)).StatusCode);

        // …and takes the package: the preview shows what will happen.
        var preview = await (await test.PostAsync("/api/management/apps/import/preview", Package(package), Ct)).JsonAsync();
        Assert.True(preview.GetProperty("canImport").GetBoolean(), preview.ToString());
        Assert.Equal("1.0.0", preview.GetProperty("manifest").GetProperty("version").GetString());
        Assert.Equal("new", preview.GetProperty("libraries")[0].GetProperty("status").GetString());
        Assert.True(preview.GetProperty("code").GetProperty("success").GetBoolean());
        Assert.Contains(preview.GetProperty("plan").GetProperty("changes").EnumerateArray(), c => c.GetProperty("description").GetString()!.Contains("app_siparis_siparis"));

        var import = await test.PostAsync("/api/management/apps/import", Package(package), Ct);
        await Ok(import);
        var result = await import.JsonAsync();
        Assert.True(result.GetProperty("hashMatches").GetBoolean()); // deterministic build: the same code, the same hash

        // The app works there, with its code (and its library).
        var customer = (await (await test.PostAsJsonAsync("/api/runtime/data/siparis/musteri", new { values = new { unvan = "Acme" } }, Ct)).JsonAsync()).GetProperty("id").GetGuid();
        var bad = await test.PostAsJsonAsync("/api/runtime/data/siparis/siparis", new { values = new { siparis_no = "X-1", musteri = customer, tarih = "2026-10-01", durum = "taslak" } }, Ct);
        Assert.Equal("Sipariş no 'S-' ile başlamalı.", (await bad.JsonAsync()).GetProperty("fieldErrors").GetProperty("siparis_no").GetString());
        await Ok(await test.PostAsJsonAsync("/api/runtime/data/siparis/siparis", new { values = new { siparis_no = "S-1", musteri = customer, tarih = "2026-10-01", durum = "taslak" } }, Ct));

        // The same package again: already installed.
        var again = await (await test.PostAsync("/api/management/apps/import/preview", Package(package), Ct)).JsonAsync();
        Assert.False(again.GetProperty("canImport").GetBoolean());

        // An upgrade designed in development (a new field) follows the same way; the data stays.
        var draft = Samples.Node("siparis");
        draft["entities"]!.AsArray()[2]!["fields"]!.AsArray().Add(new JsonObject { ["key"] = "oncelik", ["label"] = "Öncelik", ["type"] = "integer" });
        await Ok(await dev.PutAsJsonAsync("/api/development/apps/siparis/draft", draft, Ct));
        await Ok(await dev.PostAsJsonAsync("/api/development/apps/siparis/publish", new { version = "1.1.0", confirmDestructive = false }, Ct));
        var upgrade = await ExportAsync();
        var upgradePreview = await (await test.PostAsync("/api/management/apps/import/preview", Package(upgrade), Ct)).JsonAsync();
        Assert.Equal("installed", upgradePreview.GetProperty("libraries")[0].GetProperty("status").GetString());
        Assert.Contains(upgradePreview.GetProperty("plan").GetProperty("changes").EnumerateArray(), c => c.GetProperty("description").GetString() == "Kolon eklenecek: app_siparis_siparis.oncelik");
        await Ok(await test.PostAsync("/api/management/apps/import", Package(upgrade), Ct));
        var orders = await (await test.GetAsync("/api/runtime/data/siparis/siparis", Ct)).JsonAsync();
        Assert.Equal("S-1", orders.GetProperty("items")[0].GetProperty("siparis_no").GetString());
        Assert.Equal(JsonValueKind.Null, orders.GetProperty("items")[0].GetProperty("oncelik").ValueKind);
    }

    [Fact]
    public async Task A_changed_package_is_refused()
    {
        await DesignAndPublishAsync();
        var package = await ExportAsync();

        using var stream = new MemoryStream();
        stream.Write(package);
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Update, leaveOpen: true))
        {
            var entry = zip.GetEntry("code/SiparisEvents.cs")!;
            using var writer = new StreamWriter(entry.Open());
            writer.BaseStream.SetLength(0);
            writer.Write("public class Kotu { }");
        }
        var preview = await (await test.PostAsync("/api/management/apps/import/preview", Package(stream.ToArray()), Ct)).JsonAsync();
        Assert.False(preview.GetProperty("canImport").GetBoolean());
        Assert.Contains("Dosya değiştirilmiş (özet tutmuyor): code/SiparisEvents.cs", preview.GetProperty("errors").EnumerateArray().Select(e => e.GetString()));
    }

    [Fact]
    public async Task A_draft_the_code_no_longer_compiles_against_is_not_published()
    {
        await DesignAndPublishAsync();
        var draft = Samples.Node("siparis");
        var fields = draft["entities"]!.AsArray()[2]!["fields"]!.AsArray();
        fields.RemoveAt(0); // siparis_no, used by the code
        Samples.Unuse(draft, "siparis", "siparis_no");
        await Ok(await dev.PutAsJsonAsync("/api/development/apps/siparis/draft", draft, Ct));

        var publish = await dev.PostAsJsonAsync("/api/development/apps/siparis/publish", new { version = "1.1.0", confirmDestructive = true }, Ct);
        Assert.Equal(HttpStatusCode.BadRequest, publish.StatusCode);
        var body = await publish.JsonAsync();
        Assert.Equal("Kod yeni tanımla derlenmiyor; önce kodu düzeltin.", body.Errors().Single());
        Assert.False(body.GetProperty("code").GetProperty("success").GetBoolean());
        Assert.Equal("1.0.0", (await (await dev.GetAsync("/api/management/apps", Ct)).JsonAsync())[0].GetProperty("version").GetString());
    }
}
