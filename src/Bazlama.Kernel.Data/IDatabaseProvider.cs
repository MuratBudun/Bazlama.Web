using Microsoft.EntityFrameworkCore;

namespace Bazlama.Kernel.Data;

/// <summary>
/// One supported database (SqlServer, PostgreSql, Sqlite). Each lives in its own assembly,
/// which also holds that provider's EF migrations and, later, its SQL dialect.
/// </summary>
public interface IDatabaseProvider
{
    /// <summary>The name used in configuration: <c>Database:Provider</c>.</summary>
    string Name { get; }

    void Configure(DbContextOptionsBuilder options, string connectionString);
}

/// <summary>The <c>Database</c> configuration section.</summary>
public class DatabaseOptions
{
    public string Provider { get; set; } = "Sqlite";
    public string ConnectionString { get; set; } = "";
    /// <summary>Apply pending kernel migrations at startup.</summary>
    public bool MigrateOnStartup { get; set; } = true;
}
