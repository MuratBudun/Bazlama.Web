using Bazlama.Kernel.Data;
using Bazlama.Kernel.Identity;
using Bazlama.Modules.Identity;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using static Bazlama.Modules.Management.Http;

namespace Bazlama.Modules.Management;

public sealed record SessionRow(Guid Id, Guid UserId, string UserName, string DisplayName, string Status, string Channel,
    DateTime CreatedAt, DateTime LastSeenAt, string? IpAddress, string? UserAgent, string? Context, bool IsCurrent);

public sealed record AuditRow(Guid Id, DateTime At, string Category, string Action, string? UserName, string? EntityType, string? EntityId, string? Data, string? IpAddress);
public sealed record AuditPage(IReadOnlyList<AuditRow> Items, int Total);

/// <summary>Open sessions, security settings and the audit log.</summary>
static class SystemEndpoints
{
    public static void MapSessionEndpoints(this RouteGroupBuilder api)
    {
        var sessions = api.MapGroup("/sessions").RequirePermission(Permissions.Sessions);

        sessions.MapGet("/", async (KernelDbContext db, CurrentSession current, CancellationToken ct) =>
        {
            var rows = await (from s in db.UserSessions.AsNoTracking()
                              join u in db.Users on s.UserId equals u.Id
                              where s.Status != SessionStatus.Ended
                              orderby s.LastSeenAt descending
                              select new { s, u.UserName, u.DisplayName }).ToListAsync(ct);
            var companies = await db.Companies.ToDictionaryAsync(c => c.Id, c => c.Name, ct);
            var locations = await db.Locations.ToDictionaryAsync(l => l.Id, l => l.Name, ct);
            return rows.Select(r => new SessionRow(r.s.Id, r.s.UserId, r.UserName, r.DisplayName, r.s.Status.ToString(), r.s.Channel,
                r.s.CreatedAt, r.s.LastSeenAt, r.s.IpAddress, r.s.UserAgent,
                r.s.CompanyId is { } c ? $"{companies.GetValueOrDefault(c)} · {(r.s.LocationId is { } l ? locations.GetValueOrDefault(l) : "")}" : null,
                r.s.Id == current.Snapshot!.SessionId));
        });

        sessions.MapPost("/{id:guid}/end", async (Guid id, SessionStore store, CurrentSession current, CancellationToken ct) =>
        {
            if (id == current.Snapshot!.SessionId) return Errors("Kendi oturumunuzu buradan sonlandıramazsınız; çıkış yapın.");
            await store.EndAsync(id, "revoked", ct);
            return Results.NoContent();
        });
    }

    public static void MapSettingsEndpoints(this RouteGroupBuilder api)
    {
        var settings = api.MapGroup("/settings").RequirePermission(Permissions.Settings);

        settings.MapGet("/security", (SecuritySettingsStore store, CancellationToken ct) => store.GetAsync(ct));

        settings.MapPut("/security", async (SecuritySettings s, SecuritySettingsStore store, CancellationToken ct) =>
        {
            var errors = SecuritySettingsStore.Validate(s);
            if (errors.Count > 0) return Errors(errors);
            await store.SaveAsync(s, ct);
            return Results.NoContent();
        });
    }

    public static void MapAuditEndpoints(this RouteGroupBuilder api)
    {
        api.MapGet("/audit", async (KernelDbContext db, string? category, string? q, DateTime? from, DateTime? to, int? skip, int? take, CancellationToken ct) =>
        {
            var query = db.AuditEvents.AsNoTracking();
            if (!Blank(category)) query = query.Where(e => e.Category == category);
            if (from is { } f) query = query.Where(e => e.At >= f.ToUniversalTime());
            if (to is { } t) query = query.Where(e => e.At < t.ToUniversalTime());
            if (!Blank(q))
            {
                var term = q!.Trim();
                query = query.Where(e => e.Action.Contains(term) || (e.UserName != null && e.UserName.Contains(term))
                    || (e.EntityType != null && e.EntityType.Contains(term)) || (e.EntityId != null && e.EntityId.Contains(term)));
            }
            var total = await query.CountAsync(ct);
            var items = await query.OrderByDescending(e => e.At)
                .Skip(Math.Max(0, skip ?? 0)).Take(Math.Clamp(take ?? 50, 1, 500))
                .Select(e => new AuditRow(e.Id, e.At, e.Category, e.Action, e.UserName, e.EntityType, e.EntityId, e.Data, e.IpAddress))
                .ToListAsync(ct);
            return new AuditPage(items, total);
        }).RequirePermission(Permissions.Audit);
    }
}
