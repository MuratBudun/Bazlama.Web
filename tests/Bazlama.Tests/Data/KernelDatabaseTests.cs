using Bazlama.Data.PostgreSql;
using Bazlama.Data.Sqlite;
using Bazlama.Data.SqlServer;
using Bazlama.Kernel;
using Bazlama.Kernel.Data;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Testcontainers.MsSql;
using Testcontainers.PostgreSql;

namespace Bazlama.Tests.Data;

/// <summary>
/// The same kernel database tests on every provider: migrations apply and data round-trips.
/// SqlServer and PostgreSql run in Docker (Testcontainers) and are skipped without it.
/// </summary>
public abstract class KernelDatabaseTests : IAsyncLifetime
{
    protected abstract IDatabaseProvider Provider { get; }
    /// <summary>Returns the connection string, or null when the database is not available (the tests skip).</summary>
    protected abstract ValueTask<string?> StartAsync();
    public virtual ValueTask DisposeAsync() => ValueTask.CompletedTask;

    string? connectionString;
    string? skipReason;

    public async ValueTask InitializeAsync() => connectionString = await StartAsync();

    void SkipIfUnavailable() => Assert.SkipWhen(connectionString is null, skipReason ?? "The database is not available.");

    KernelDbContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<KernelDbContext>();
        Provider.Configure(options, connectionString!);
        return new KernelDbContext(options.Options);
    }

    [Fact]
    public async Task Migrations_apply_and_settings_round_trip()
    {
        SkipIfUnavailable();
        var ct = TestContext.Current.CancellationToken;
        await using (var db = CreateContext())
        {
            await db.Database.MigrateAsync(ct);
            Assert.Empty(await db.Database.GetPendingMigrationsAsync(ct));
            db.SystemSettings.Add(new SystemSetting { Key = "test.key", Value = "değer – ğüşiöç", UpdatedAt = DateTime.UtcNow });
            await db.SaveChangesAsync(ct);
        }
        await using (var db = CreateContext())
        {
            var setting = await db.SystemSettings.SingleAsync(s => s.Key == "test.key", ct);
            Assert.Equal("değer – ğüşiöç", setting.Value);
        }
    }

    /// <summary>
    /// Builds and starts a container. Without Docker, Testcontainers already fails in Build():
    /// the tests then skip instead of failing.
    /// </summary>
    protected async Task<T?> StartContainerAsync<T>(Func<T> build) where T : class, DotNet.Testcontainers.Containers.IContainer
    {
        try
        {
            var container = build();
            await container.StartAsync(TestContext.Current.CancellationToken);
            return container;
        }
        catch (Exception e) when (IsDockerUnavailable(e))
        {
            skipReason = $"Docker is not available ({e.GetType().Name}).";
            return null;
        }
    }

    static bool IsDockerUnavailable(Exception? e)
    {
        for (; e is not null; e = e.InnerException)
            if (e.GetType().Name.Contains("Docker") || e is TimeoutException || e is IOException)
                return true;
        return false;
    }
}

public sealed class SqliteKernelDatabaseTests : KernelDatabaseTests
{
    // A named in-memory database lives while one connection to it is open.
    readonly SqliteConnection keepAlive = new($"Data Source=kernel-{Guid.NewGuid():N};Mode=Memory;Cache=Shared");

    protected override IDatabaseProvider Provider { get; } = new SqliteDatabaseProvider();

    protected override async ValueTask<string?> StartAsync()
    {
        await keepAlive.OpenAsync(TestContext.Current.CancellationToken);
        return keepAlive.ConnectionString;
    }

    public override async ValueTask DisposeAsync() => await keepAlive.DisposeAsync();
}

public sealed class SqlServerKernelDatabaseTests : KernelDatabaseTests
{
    MsSqlContainer? container;

    protected override IDatabaseProvider Provider { get; } = new SqlServerDatabaseProvider();

    protected override async ValueTask<string?> StartAsync()
    {
        container = await StartContainerAsync(() => new MsSqlBuilder("mcr.microsoft.com/mssql/server:2022-latest").Build());
        return container?.GetConnectionString();
    }

    public override ValueTask DisposeAsync() => container?.DisposeAsync() ?? ValueTask.CompletedTask;
}

public sealed class PostgreSqlKernelDatabaseTests : KernelDatabaseTests
{
    PostgreSqlContainer? container;

    protected override IDatabaseProvider Provider { get; } = new PostgreSqlDatabaseProvider();

    protected override async ValueTask<string?> StartAsync()
    {
        container = await StartContainerAsync(() => new PostgreSqlBuilder("postgres:17-alpine").Build());
        return container?.GetConnectionString();
    }

    public override ValueTask DisposeAsync() => container?.DisposeAsync() ?? ValueTask.CompletedTask;
}
