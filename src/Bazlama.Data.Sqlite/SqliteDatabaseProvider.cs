using Bazlama.Kernel.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Bazlama.Data.Sqlite;

public sealed class SqliteDatabaseProvider : IDatabaseProvider
{
    public string Name => "Sqlite";

    public void Configure(DbContextOptionsBuilder options, string connectionString) =>
        options.UseSqlite(connectionString, x => x.MigrationsAssembly(typeof(SqliteDatabaseProvider).Assembly.GetName().Name));
}

/// <summary>Used only by <c>dotnet ef migrations add</c>; never connects.</summary>
public sealed class DesignTimeFactory : IDesignTimeDbContextFactory<KernelDbContext>
{
    public KernelDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<KernelDbContext>();
        new SqliteDatabaseProvider().Configure(options, "Data Source=design.db");
        return new KernelDbContext(options.Options);
    }
}
