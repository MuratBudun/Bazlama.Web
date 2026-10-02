using System.Data.Common;
using Bazlama.Engine.Metadata;
using Bazlama.Engine.Schema;
using Bazlama.Engine.Sql;
using Bazlama.Kernel;
using Bazlama.Kernel.Apps;
using Bazlama.Kernel.Auditing;
using Bazlama.Kernel.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.Caching.Memory;

namespace Bazlama.Engine;

/// <summary>
/// Installed app definitions, cached until an install changes them. Previews of drafts are found
/// by key too (<see cref="GetAsync"/>), but they are not apps: <see cref="AllAsync"/> leaves them out.
/// </summary>
public sealed class AppRegistry(KernelDbContext db, IMemoryCache cache)
{
    const string CacheKey = "apps";
    const string PreviewsKey = "app-previews";

    public async Task<IReadOnlyDictionary<string, AppDefinition>> AllAsync(CancellationToken ct = default)
    {
        if (cache.TryGetValue(CacheKey, out IReadOnlyDictionary<string, AppDefinition>? apps)) return apps!;
        var rows = await db.Apps.AsNoTracking().Select(a => a.Metadata).ToListAsync(ct);
        apps = rows.Select(AppDefinition.Parse).ToDictionary(a => a.Key);
        cache.Set(CacheKey, apps, TimeSpan.FromMinutes(10));
        return apps;
    }

    /// <summary>An installed app, or a preview (by its preview key).</summary>
    public async Task<AppDefinition?> GetAsync(string key, CancellationToken ct = default) =>
        (await AllAsync(ct)).GetValueOrDefault(key) ?? (key.EndsWith(AppDefinition.PreviewSuffix, StringComparison.Ordinal) ? (await PreviewsAsync(ct)).GetValueOrDefault(key) : null);

    /// <summary>Previews by their preview key.</summary>
    public async Task<IReadOnlyDictionary<string, AppDefinition>> PreviewsAsync(CancellationToken ct = default)
    {
        if (cache.TryGetValue(PreviewsKey, out IReadOnlyDictionary<string, AppDefinition>? previews)) return previews!;
        var rows = await db.AppPreviews.AsNoTracking().Select(p => p.Definition).ToListAsync(ct);
        previews = rows.Select(json => AppDefinition.Parse(json).AsPreview()).ToDictionary(a => a.Key);
        cache.Set(PreviewsKey, previews, TimeSpan.FromMinutes(10));
        return previews;
    }

    public void Invalidate() => cache.Remove(CacheKey);
    public void InvalidatePreviews() => cache.Remove(PreviewsKey);
}

/// <summary>Planned changes of an install. <see cref="Errors"/> block it; destructive changes need a confirmation.</summary>
public sealed record InstallPlan(string Key, string Name, string? FromVersion, string ToVersion, IReadOnlyList<PlannedChange> Changes, IReadOnlyList<string> Errors)
{
    public bool HasDestructive => Changes.Any(c => c.Destructive);
}

public sealed record PlannedChange(string Description, bool Destructive);

public sealed record InstallResult(bool Installed, InstallPlan Plan);

/// <summary>Told after an app version is installed (e.g. its code is compiled again).</summary>
public interface IAppInstallListener
{
    Task AppInstalledAsync(AppDefinition app, CancellationToken ct);
}

/// <summary>Installs a version of an app: checks it, changes the schema, records it.</summary>
public sealed class AppInstaller(KernelDbContext db, SqlDialect dialect, AppRegistry registry, IRequestContext request, TimeProvider time, IEnumerable<IAppInstallListener> listeners)
{
    public async Task<InstallPlan> PlanAsync(AppDefinition next, CancellationToken ct = default) => (await PrepareAsync(next, ct)).Plan;

    async Task<(InstallPlan Plan, SchemaPlan Schema, InstalledApp? Row)> PrepareAsync(AppDefinition next, CancellationToken ct)
    {
        var errors = MetadataValidator.Validate(next).ToList();
        var row = errors.Count == 0 ? await db.Apps.FirstOrDefaultAsync(a => a.Key == next.Key, ct) : null;
        var installed = row is null ? null : AppDefinition.Parse(row.Metadata);
        if (installed is not null && CompareVersions(next.Version, installed.Version) <= 0)
            errors.Add($"Yeni versiyon kurulu versiyondan ({installed.Version}) büyük olmalı.");

        var schema = errors.Count == 0 ? SchemaDiff.Compare(installed, next) : new SchemaPlan([], []);
        errors.AddRange(schema.Errors);
        var plan = new InstallPlan(next.Key, next.Name, installed?.Version, next.Version,
            [.. schema.Changes.Select(c => new PlannedChange(c.Description, c.Destructive))], errors);
        return (plan, schema, row);
    }

    public async Task<InstallResult> InstallAsync(AppDefinition next, bool confirmDestructive, CancellationToken ct = default)
    {
        var (plan, schema, row) = await PrepareAsync(next, ct);
        if (plan.Errors.Count > 0 || (plan.HasDestructive && !confirmDestructive)) return new(false, plan);

        var statements = dialect.Statements(schema.Changes);
        var now = time.GetUtcNow().UtcDateTime;
        await db.Database.OpenConnectionAsync(ct);
        try
        {
            await ExecuteAsync(dialect.BeforeMigration, null, ct);
            await using (var tx = await db.Database.BeginTransactionAsync(ct))
            {
                await ExecuteAsync(statements, tx, ct);
                var json = next.ToJson();
                if (row is null)
                {
                    row = new InstalledApp { Key = next.Key, Name = next.Name, Version = next.Version, Metadata = json, InstalledAt = now, UpdatedAt = now, UpdatedBy = request.UserId };
                    db.Apps.Add(row);
                }
                else
                {
                    (row.Name, row.Version, row.Metadata, row.UpdatedAt, row.UpdatedBy) = (next.Name, next.Version, json, now, request.UserId);
                }
                db.AppVersions.Add(new AppVersionHistory
                {
                    AppId = row.Id,
                    Version = next.Version,
                    Metadata = json,
                    Changes = string.Join("\n", plan.Changes.Select(c => c.Description)),
                    InstalledAt = now,
                    InstalledBy = request.UserId,
                });
                db.AuditEvents.Add(new AuditEvent
                {
                    At = now,
                    Category = "data",
                    Action = plan.FromVersion is null ? "app.install" : "app.upgrade",
                    UserId = request.UserId,
                    UserName = request.UserName,
                    SessionId = request.SessionId,
                    IpAddress = request.IpAddress,
                    EntityType = "App",
                    EntityId = next.Key,
                    Data = System.Text.Json.JsonSerializer.Serialize(new { from = plan.FromVersion, to = next.Version, changes = plan.Changes.Select(c => c.Description) }),
                });
                await db.SaveChangesAsync(ct);
                await tx.CommitAsync(ct);
            }
        }
        finally
        {
            await ExecuteAsync(dialect.AfterMigration, null, CancellationToken.None);
            await db.Database.CloseConnectionAsync();
            registry.Invalidate();
        }
        foreach (var listener in listeners) await listener.AppInstalledAsync(next, ct);
        return new(true, plan);
    }

    /// <summary>
    /// Runs schema changes in one transaction (the provider's before/after migration statements
    /// around it) and, in that transaction, <paramref name="record"/> (e.g. a row that remembers
    /// the definition the tables now have).
    /// </summary>
    public async Task ApplySchemaAsync(IReadOnlyList<SchemaChange> changes, Func<Task> record, CancellationToken ct)
    {
        await db.Database.OpenConnectionAsync(ct);
        try
        {
            await ExecuteAsync(dialect.BeforeMigration, null, ct);
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            await ExecuteAsync(dialect.Statements(changes), tx, ct);
            await record();
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
        }
        finally
        {
            await ExecuteAsync(dialect.AfterMigration, null, CancellationToken.None);
            await db.Database.CloseConnectionAsync();
        }
    }

    async Task ExecuteAsync(IEnumerable<string> statements, IDbContextTransaction? tx, CancellationToken ct)
    {
        var connection = db.Database.GetDbConnection();
        foreach (var sql in statements.Where(s => !string.IsNullOrWhiteSpace(s)))
        {
            await using DbCommand cmd = connection.CreateCommand();
            cmd.CommandText = sql;
            if (tx is not null) cmd.Transaction = tx.GetDbTransaction();
            await cmd.ExecuteNonQueryAsync(ct);
        }
    }

    /// <summary>Semantic versions, numerically: 1.10.0 &gt; 1.9.0.</summary>
    public static int CompareVersions(string a, string b)
    {
        var x = a.Split('.').Select(int.Parse).ToArray();
        var y = b.Split('.').Select(int.Parse).ToArray();
        for (var i = 0; i < 3; i++)
            if (x[i] != y[i]) return x[i].CompareTo(y[i]);
        return 0;
    }
}
