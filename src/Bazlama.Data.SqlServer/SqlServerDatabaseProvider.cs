using Bazlama.Kernel.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Bazlama.Data.SqlServer;

public sealed class SqlServerDatabaseProvider : IDatabaseProvider
{
    public string Name => "SqlServer";

    public void Configure(DbContextOptionsBuilder options, string connectionString) =>
        options.UseSqlServer(connectionString, x => x.MigrationsAssembly(typeof(SqlServerDatabaseProvider).Assembly.GetName().Name));
}

/// <summary>Used only by <c>dotnet ef migrations add</c>; never connects.</summary>
public sealed class DesignTimeFactory : IDesignTimeDbContextFactory<KernelDbContext>
{
    public KernelDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<KernelDbContext>();
        new SqlServerDatabaseProvider().Configure(options, "Server=.;Database=bazlama_design;Trusted_Connection=True");
        return new KernelDbContext(options.Options);
    }
}
