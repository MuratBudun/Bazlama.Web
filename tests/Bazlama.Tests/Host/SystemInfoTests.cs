using System.Net;
using System.Net.Http.Json;
using static Bazlama.Tests.TestHost;

namespace Bazlama.Tests.Host;

public sealed class SystemInfoTests : IAsyncLifetime
{
    readonly TestHost host = new(environmentMode: "Test");

    public async ValueTask InitializeAsync() => await host.SetupAsync();
    public ValueTask DisposeAsync() => host.DisposeAsync();

    record SystemInfo(string Product, string Version, string Environment, string DatabaseProvider);

    [Fact]
    public async Task Reports_installation_and_provider_to_signed_in_users()
    {
        var client = host.Client();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/system/info", Ct)).StatusCode);

        await client.LoginAsync(AdminUser, AdminPassword);
        var info = await client.GetFromJsonAsync<SystemInfo>("/api/system/info", Ct);
        Assert.NotNull(info);
        Assert.Equal("Bazlama", info.Product);
        Assert.Equal("Test", info.Environment);
        Assert.Equal("Sqlite", info.DatabaseProvider);
    }

    [Fact]
    public async Task Unknown_api_path_is_404_not_the_web_ui()
    {
        var res = await host.Client().GetAsync("/api/nope", Ct);
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    /// <summary>Needs the built UI (web/: npm run build → src/Bazlama.Host/wwwroot); skipped without it.</summary>
    [Fact]
    public async Task The_web_ui_is_compressed_and_cached_and_the_api_is_not()
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "Bazlama.slnx"))) root = root.Parent;
        var assets = new DirectoryInfo(Path.Combine(root!.FullName, "src", "Bazlama.Host", "wwwroot", "assets"));
        Assert.SkipWhen(!assets.Exists, "Web arayüzü derlenmemiş (wwwroot yok).");
        var script = assets.GetFiles("*.js").OrderByDescending(f => f.Length).First();

        var client = host.Client();
        async Task<HttpResponseMessage> Get(string path)
        {
            var request = new HttpRequestMessage(HttpMethod.Get, path);
            request.Headers.AcceptEncoding.ParseAdd("br, gzip");
            return await client.SendAsync(request, Ct);
        }

        // A hashed asset: compressed (once; the result is kept), and kept by the browser for good.
        var asset = await Get($"/assets/{script.Name}");
        Assert.Equal(HttpStatusCode.OK, asset.StatusCode);
        Assert.Equal("br", asset.Content.Headers.ContentEncoding.Single());
        var bytes = await asset.Content.ReadAsByteArrayAsync(Ct);
        Assert.True(bytes.Length < script.Length / 2);
        Assert.Equal("public, max-age=31536000, immutable", asset.Headers.CacheControl?.ToString());
        using (var brotli = new System.IO.Compression.BrotliStream(new MemoryStream(bytes), System.IO.Compression.CompressionMode.Decompress))
        using (var plain = new MemoryStream())
        {
            await brotli.CopyToAsync(plain, Ct);
            Assert.Equal(await File.ReadAllBytesAsync(script.FullName, Ct), plain.ToArray());
        }
        Assert.Equal(bytes, await (await Get($"/assets/{script.Name}")).Content.ReadAsByteArrayAsync(Ct));

        // The same file again with its ETag: not sent again. Without Accept-Encoding: as it is.
        var again = new HttpRequestMessage(HttpMethod.Get, $"/assets/{script.Name}");
        again.Headers.AcceptEncoding.ParseAdd("br");
        again.Headers.TryAddWithoutValidation("If-None-Match", asset.Headers.ETag!.ToString());
        Assert.Equal(HttpStatusCode.NotModified, (await client.SendAsync(again, Ct)).StatusCode);
        var raw = await client.GetAsync($"/assets/{script.Name}", Ct);
        Assert.Empty(raw.Content.Headers.ContentEncoding);
        Assert.Equal(script.Length, (await raw.Content.ReadAsByteArrayAsync(Ct)).Length);
        Assert.Equal("public, max-age=31536000, immutable", raw.Headers.CacheControl?.ToString());

        // The page (also for any UI path): checked on every visit.
        foreach (var path in new[] { "/", "/management/users" })
            Assert.Equal("no-cache", (await Get(path)).Headers.CacheControl?.ToString());

        // The API stays uncompressed (it carries data that depends on the user).
        await client.LoginAsync(AdminUser, AdminPassword);
        var api = await Get("/api/system/info");
        Assert.Equal(HttpStatusCode.OK, api.StatusCode);
        Assert.Empty(api.Content.Headers.ContentEncoding);
    }
}
