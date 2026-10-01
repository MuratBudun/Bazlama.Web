using System.Net.Http.Json;
using System.Text.Json;
using Bazlama.Kernel.Data;
using Bazlama.Modules.Identity;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;

namespace Bazlama.Tests;

/// <summary>A clock the tests move (TOTP steps, lockout and idle timeouts).</summary>
public sealed class TestClock : TimeProvider
{
    public DateTimeOffset Now { get; set; } = new(2026, 10, 1, 9, 0, 0, TimeSpan.Zero);
    public override DateTimeOffset GetUtcNow() => Now;
    public override TimeZoneInfo LocalTimeZone => TimeZoneInfo.Utc;
    public void Advance(TimeSpan by) => Now += by;
}

/// <summary>The real host on a fresh SQLite file, with a test clock.</summary>
public sealed class TestHost : IAsyncDisposable
{
    readonly string dbPath = Path.Combine(Path.GetTempPath(), $"bazlama-test-{Guid.NewGuid():N}.db");
    public WebApplicationFactory<Program> Factory { get; }
    public TestClock Clock { get; } = new();

    public const string AdminUser = "admin";
    public const string AdminPassword = "Bazlama2026x";

    public TestHost(string environmentMode = "Development")
    {
        Factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b => b
            .UseSetting("Database:Provider", "Sqlite")
            .UseSetting("Database:ConnectionString", $"Data Source={dbPath};Pooling=False")
            .UseSetting("Platform:EnvironmentMode", environmentMode)
            .ConfigureServices(s => s.AddSingleton<TimeProvider>(Clock)));
    }

    /// <summary>A client with its own cookies, sending the X-Bazlama-Request header.</summary>
    public HttpClient Client()
    {
        var client = Factory.CreateClient();
        client.DefaultRequestHeaders.Add(RequestHeaderGuardMiddleware.Header, "1");
        return client;
    }

    public async Task SetupAsync()
    {
        var res = await Client().PostAsJsonAsync("/api/auth/setup", new SetupRequest(AdminUser, "Yönetici", AdminPassword, "C1", "Firma", "L1", "Merkez"), Ct);
        res.EnsureSuccessStatusCode();
    }

    public async Task<T> WithDbAsync<T>(Func<KernelDbContext, Task<T>> action)
    {
        await using var scope = Factory.Services.CreateAsyncScope();
        return await action(scope.ServiceProvider.GetRequiredService<KernelDbContext>());
    }

    public async Task WithServicesAsync(Func<IServiceProvider, Task> action)
    {
        await using var scope = Factory.Services.CreateAsyncScope();
        await action(scope.ServiceProvider);
    }

    public static CancellationToken Ct => TestContext.Current.CancellationToken;

    public async ValueTask DisposeAsync()
    {
        await Factory.DisposeAsync();
        File.Delete(dbPath);
    }
}

public static class HttpExtensions
{
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static async Task<JsonElement> JsonAsync(this HttpResponseMessage res) =>
        await res.Content.ReadFromJsonAsync<JsonElement>(Json, TestHost.Ct);

    public static async Task<JsonElement> LoginAsync(this HttpClient client, string user, string password)
    {
        var res = await client.PostAsJsonAsync("/api/auth/login", new { userName = user, password }, TestHost.Ct);
        return await res.JsonAsync();
    }

    public static string Status(this JsonElement me) => me.GetProperty("status").GetString()!;

    public static string[] Errors(this JsonElement problem) =>
        [.. problem.GetProperty("errors").EnumerateArray().Select(e => e.GetString()!)];
}
