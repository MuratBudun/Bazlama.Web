using Bazlama.Data.PostgreSql;
using Bazlama.Data.Sqlite;
using Bazlama.Data.SqlServer;
using Bazlama.Kernel.Auditing;
using Bazlama.Kernel.Data;
using Microsoft.EntityFrameworkCore;

namespace Bazlama.Host;

public static class DatabaseSetup
{
    public static readonly IReadOnlyList<IDatabaseProvider> Providers =
        [new SqlServerDatabaseProvider(), new PostgreSqlDatabaseProvider(), new SqliteDatabaseProvider()];

    /// <summary>Registers the kernel DbContext on the provider named by <c>Database:Provider</c>.</summary>
    public static IServiceCollection AddKernelDatabase(this IServiceCollection services, DatabaseOptions options)
    {
        var provider = Providers.FirstOrDefault(p => string.Equals(p.Name, options.Provider, StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidOperationException(
                $"Unknown Database:Provider '{options.Provider}'. Use one of: {string.Join(", ", Providers.Select(p => p.Name))}.");
        if (string.IsNullOrWhiteSpace(options.ConnectionString))
            throw new InvalidOperationException("Database:ConnectionString is empty.");

        services.AddSingleton(provider);
        services.AddDbContext<KernelDbContext>((sp, o) =>
        {
            provider.Configure(o, options.ConnectionString);
            o.AddInterceptors(new AuditInterceptor(sp.GetService<IAuditActor>() ?? SystemAuditActor.Instance));
        });
        return services;
    }

    public static async Task MigrateKernelDatabaseAsync(this WebApplication app)
    {
        await using var scope = app.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<KernelDbContext>();
        await db.Database.MigrateAsync();
    }
}
