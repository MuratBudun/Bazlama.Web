using System.Text.Json;
using Bazlama.Kernel.Auditing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Bazlama.Kernel.Data;

/// <summary>
/// Writes an <see cref="AuditEvent"/> for every added, changed or deleted <see cref="IAudited"/>
/// entity, in the same SaveChanges (so the change and its audit commit together).
/// </summary>
public sealed class AuditInterceptor(IAuditActor actor) : SaveChangesInterceptor
{
    /// <summary>Never written to the audit log in clear text.</summary>
    static readonly HashSet<string> Secret = ["PasswordHash", "TotpSecret"];

    /// <summary>Bookkeeping that changes on every sign-in; security events cover it.</summary>
    static readonly HashSet<string> Ignored =
        ["LastLoginAt", "FailedLoginCount", "TotpLastStep", "LastCompanyId", "LastLocationId", "LastPlantId", "LastPeriodId"];

    public override InterceptionResult<int> SavingChanges(DbContextEventData eventData, InterceptionResult<int> result)
    {
        if (eventData.Context is not null) AddAuditEvents(eventData.Context);
        return result;
    }

    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
    {
        if (eventData.Context is not null) AddAuditEvents(eventData.Context);
        return ValueTask.FromResult(result);
    }

    void AddAuditEvents(DbContext db)
    {
        var now = DateTime.UtcNow;
        var events = new List<AuditEvent>();
        foreach (var entry in db.ChangeTracker.Entries().Where(e => e.Entity is IAudited))
        {
            var (verb, data) = entry.State switch
            {
                EntityState.Added => ("create", Values(entry, e => e.CurrentValue)),
                EntityState.Deleted => ("delete", Values(entry, e => e.OriginalValue)),
                EntityState.Modified => ("update", Changes(entry)),
                _ => (null, null),
            };
            if (verb is null || data is null || data.Count == 0) continue;
            events.Add(new AuditEvent
            {
                At = now,
                Category = "data",
                Action = $"{entry.Metadata.ClrType.Name}.{verb}",
                UserId = actor.UserId,
                UserName = actor.UserName,
                SessionId = actor.SessionId,
                IpAddress = actor.IpAddress,
                EntityType = entry.Metadata.ClrType.Name,
                EntityId = KeyOf(entry),
                Data = JsonSerializer.Serialize(data),
            });
        }
        db.Set<AuditEvent>().AddRange(events);
    }

    static Dictionary<string, object?> Values(EntityEntry entry, Func<PropertyEntry, object?> value) =>
        entry.Properties
            .Where(p => !p.Metadata.IsPrimaryKey())
            .ToDictionary(p => p.Metadata.Name, p => Secret.Contains(p.Metadata.Name) ? Mask(value(p)) : value(p));

    static Dictionary<string, object?> Changes(EntityEntry entry) =>
        entry.Properties
            .Where(p => p.IsModified && !Ignored.Contains(p.Metadata.Name) && !Equals(p.OriginalValue, p.CurrentValue))
            .ToDictionary(p => p.Metadata.Name, p => (object?)(Secret.Contains(p.Metadata.Name)
                ? new { old = Mask(p.OriginalValue), @new = Mask(p.CurrentValue) }
                : new { old = p.OriginalValue, @new = p.CurrentValue }));

    static string? Mask(object? value) => value is null ? null : "***";

    static string KeyOf(EntityEntry entry) =>
        string.Join(",", entry.Metadata.FindPrimaryKey()!.Properties.Select(p => entry.Property(p.Name).CurrentValue));
}
