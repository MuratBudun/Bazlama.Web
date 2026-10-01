using Bazlama.Kernel.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Bazlama.Data.PostgreSql;

public sealed class PostgreSqlDatabaseProvider : IDatabaseProvider
{
    public string Name => "PostgreSql";

    public void Configure(DbContextOptionsBuilder options, string connectionString) =>
        options.UseNpgsql(connectionString, x => x.MigrationsAssembly(typeof(PostgreSqlDatabaseProvider).Assembly.GetName().Name));
}

/// <summary>Used only by <c>dotnet ef migrations add</c>; never connects.</summary>
public sealed class DesignTimeFactory : IDesignTimeDbContextFactory<KernelDbContext>
{
    public KernelDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<KernelDbContext>();
        new PostgreSqlDatabaseProvider().Configure(options, "Host=localhost;Database=bazlama_design");
        return new KernelDbContext(options.Options);
    }
}
