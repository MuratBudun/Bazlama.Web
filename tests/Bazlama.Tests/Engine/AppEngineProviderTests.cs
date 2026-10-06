using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using DotNet.Testcontainers.Containers;
using Testcontainers.MsSql;
using Testcontainers.PostgreSql;
using static Bazlama.Tests.TestHost;

namespace Bazlama.Tests.Engine;

/// <summary>
/// The app engine on SQL Server and PostgreSQL (their dialects): install, every field type
/// round-trips, search, update, upgrade with a dropped column. Skipped without Docker.
/// </summary>
public abstract class AppEngineProviderTests : IAsyncLifetime
{
    protected abstract string Provider { get; }
    /// <summary>Null: no container (SQLite uses a temporary file).</summary>
    protected abstract IContainer? Build();
    protected abstract string? ConnectionString(IContainer? container);

    IContainer? container;
    string? skip;

    public async ValueTask InitializeAsync()
    {
        try
        {
            container = Build();
            if (container is not null) await container.StartAsync(Ct);
        }
        catch (Exception e) when (e.GetType().Name.Contains("Docker") || e.InnerException?.GetType().Name.Contains("Docker") == true || e is TimeoutException)
        {
            skip = $"Docker is not available ({e.GetType().Name}).";
        }
    }

    public ValueTask DisposeAsync() => container?.DisposeAsync() ?? ValueTask.CompletedTask;

    [Fact]
    public async Task Sample_app_installs_round_trips_and_upgrades()
    {
        Assert.SkipWhen(skip is not null, skip ?? "");
        await using var host = new TestHost(provider: Provider, connectionString: ConnectionString(container));
        await host.SetupAsync();
        var admin = host.Client();
        await admin.LoginAsync(AdminUser, AdminPassword);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync("/api/management/apps/install", new { definition = Samples.Node("siparis"), confirmDestructive = false }, Ct)).StatusCode);

        const string data = "/api/runtime/data/siparis";
        async Task<Guid> Create(string entity, object values, Guid? parentId = null)
        {
            var res = await admin.PostAsJsonAsync($"{data}/{entity}", new { values, parentId }, Ct);
            var body = await res.JsonAsync();
            Assert.True(res.IsSuccessStatusCode, body.ToString());
            return body.GetProperty("id").GetGuid();
        }

        var product = await Create("urun", new { kod = "U1", ad = "Vida", birim = "adet", fiyat = 12.5 });
        var customer = await Create("musteri", new { unvan = "Ağaç İşleri", segment = "kobi", aktif = true, notlar = "Çok satırlı\nnot" });
        var order = await Create("siparis", new { siparis_no = "S-1", musteri = customer, tarih = "2026-10-01", durum = "taslak", teslim = "2026-10-05T10:30:00Z" });
        await Create("kalem", new { urun = product, miktar = 2.5, birim_fiyat = 12.5, iskonto = 5, not = "acil" }, order);

        var orders = await (await admin.GetAsync($"{data}/siparis", Ct)).JsonAsync();
        var o = orders.GetProperty("items")[0];
        Assert.Equal("Ağaç İşleri", o.GetProperty("_titles").GetProperty("musteri").GetString());
        Assert.Equal("2026-10-01", o.GetProperty("tarih").GetString());
        Assert.Equal(new DateTime(2026, 10, 5, 10, 30, 0, DateTimeKind.Utc), o.GetProperty("teslim").GetDateTime().ToUniversalTime());

        var c = await (await admin.GetAsync($"{data}/musteri/{customer}", Ct)).JsonAsync();
        Assert.True(c.GetProperty("aktif").GetBoolean());
        Assert.Equal("Çok satırlı\nnot", c.GetProperty("notlar").GetString());
        Assert.Equal(1, (await (await admin.GetAsync($"{data}/musteri?q=ağaç", Ct)).JsonAsync()).GetProperty("total").GetInt32());

        var line = (await (await admin.GetAsync($"{data}/kalem?parent={order}", Ct)).JsonAsync()).GetProperty("items")[0];
        Assert.Equal(2.5m, line.GetProperty("miktar").GetDecimal());
        Assert.Equal(5, line.GetProperty("iskonto").GetInt64());

        var update = await admin.PutAsJsonAsync($"{data}/siparis/{order}", new { values = new { durum = "onaylandi" }, rowVersion = 1 }, Ct);
        Assert.Equal(HttpStatusCode.OK, update.StatusCode);

        var v2 = Samples.Node("siparis");
        v2["version"] = "2.2.0";
        var siparis = v2["entities"]!.AsArray()[2]!.AsObject();
        siparis["fields"]!.AsArray().RemoveAt(5);
        siparis["fields"]!.AsArray().Add(new JsonObject { ["key"] = "oncelik", ["label"] = "Öncelik", ["type"] = "integer" });
        Samples.Unuse(v2, "siparis", "aciklama");
        // A reference column is dropped too (foreign key and index go first).
        var kalem = v2["entities"]!.AsArray()[3]!.AsObject();
        kalem["fields"]!.AsArray().RemoveAt(0);
        Samples.Unuse(v2, "kalem", "urun");
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync("/api/management/apps/install", new { definition = v2, confirmDestructive = true }, Ct)).StatusCode);
        var after = await (await admin.GetAsync($"{data}/siparis/{order}", Ct)).JsonAsync();
        Assert.Equal("onaylandi", after.GetProperty("durum").GetString());
        Assert.Equal(1, (await (await admin.GetAsync($"{data}/kalem?parent={order}", Ct)).JsonAsync()).GetProperty("total").GetInt32());
    }
}

public sealed class SqlServerAppEngineTests : AppEngineProviderTests
{
    protected override string Provider => "SqlServer";
    protected override IContainer? Build() => new MsSqlBuilder("mcr.microsoft.com/mssql/server:2022-latest").Build();
    protected override string? ConnectionString(IContainer? c) => ((MsSqlContainer)c!).GetConnectionString();
}

public sealed class PostgreSqlAppEngineTests : AppEngineProviderTests
{
    protected override string Provider => "PostgreSql";
    protected override IContainer? Build() => new PostgreSqlBuilder("postgres:17-alpine").Build();
    protected override string? ConnectionString(IContainer? c) => ((PostgreSqlContainer)c!).GetConnectionString();
}

/// <summary>The same scenario on SQLite (always runs): it covers the SQLite table rebuild.</summary>
public sealed class SqliteAppEngineTests : AppEngineProviderTests
{
    protected override string Provider => "Sqlite";
    protected override IContainer? Build() => null;
    protected override string? ConnectionString(IContainer? c) => null;
}
