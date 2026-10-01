using System.Security.Claims;
using Bazlama.Kernel.Auditing;
using Bazlama.Kernel.Data;
using Bazlama.Kernel.Identity;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Bazlama.Modules.Identity;

/// <summary>What a request needs to know about its session; cached for a short time.</summary>
public sealed record SessionSnapshot(
    Guid SessionId,
    Guid UserId,
    string UserName,
    string DisplayName,
    SessionStatus Status,
    DateTime CreatedAt,
    DateTime LastSeenAt,
    Guid? CompanyId,
    Guid? LocationId,
    Guid? PlantId,
    Guid? PeriodId,
    IReadOnlySet<string> Permissions,
    int PermissionVersion);

/// <summary>The current request's session (filled by <see cref="SessionMiddleware"/>). Also the audit actor.</summary>
public sealed class CurrentSession : IAuditActor, Bazlama.Kernel.IRequestContext
{
    public SessionSnapshot? Snapshot { get; set; }
    public string? Ip { get; set; }

    public bool IsActive => Snapshot?.Status == SessionStatus.Active;
    public bool Has(string permission) => IsActive && Permissions.Grants(Snapshot!.Permissions, permission);

    public Guid? UserId => Snapshot?.UserId;
    public string? UserName => Snapshot?.UserName;
    public Guid? SessionId => Snapshot?.SessionId;
    public string? IpAddress => Ip;

    // Only an active session has a context.
    public Guid? CompanyId => IsActive ? Snapshot!.CompanyId : null;
    public Guid? LocationId => IsActive ? Snapshot!.LocationId : null;
    public Guid? PlantId => IsActive ? Snapshot!.PlantId : null;
    public Guid? PeriodId => IsActive ? Snapshot!.PeriodId : null;

    public bool HasPermission(string permission) => Has(permission);
}

public sealed class SessionStore(KernelDbContext db, IMemoryCache cache, TimeProvider time)
{
    static int permissionVersion;

    /// <summary>Group, membership or permission changes: every cached permission set is stale.</summary>
    public static void PermissionsChanged() => Interlocked.Increment(ref permissionVersion);

    static string Key(Guid sid) => $"session:{sid}";

    public void Invalidate(Guid sid) => cache.Remove(Key(sid));

    public async Task<SessionSnapshot?> LoadAsync(Guid sid, CancellationToken ct = default)
    {
        var version = Volatile.Read(ref permissionVersion);
        if (cache.TryGetValue(Key(sid), out SessionSnapshot? cached) && cached!.PermissionVersion == version)
            return cached;

        var row = await (from us in db.UserSessions.AsNoTracking()
                         join u in db.Users.AsNoTracking() on us.UserId equals u.Id
                         where us.Id == sid
                         select new { s = us, u.UserName, u.DisplayName, u.IsActive }).FirstOrDefaultAsync(ct);
        if (row is null) return null;
        var s = row.s;
        // An inactive user's sessions end at the next request.
        var status = row.IsActive ? s.Status : SessionStatus.Ended;
        var permissions = status == SessionStatus.Active
            ? await PermissionsOfAsync(s.UserId, s.LocationId, ct)
            : new HashSet<string>();
        var snapshot = new SessionSnapshot(s.Id, s.UserId, row.UserName, row.DisplayName, status, s.CreatedAt, s.LastSeenAt,
            s.CompanyId, s.LocationId, s.PlantId, s.PeriodId, permissions, version);
        cache.Set(Key(sid), snapshot, TimeSpan.FromSeconds(30));
        return snapshot;
    }

    /// <summary>Permissions of the user's groups; a location-bound membership counts only in that location.</summary>
    public async Task<HashSet<string>> PermissionsOfAsync(Guid userId, Guid? locationId, CancellationToken ct = default)
    {
        var groups = db.GroupMembers.Where(m => m.UserId == userId && (m.LocationId == null || m.LocationId == locationId)).Select(m => m.GroupId);
        var list = await db.GroupPermissions.Where(p => groups.Contains(p.GroupId)).Select(p => p.Permission).Distinct().ToListAsync(ct);
        return [.. list];
    }

    public async Task TouchAsync(SessionSnapshot snapshot, CancellationToken ct = default)
    {
        var now = time.GetUtcNow().UtcDateTime;
        await db.UserSessions.Where(s => s.Id == snapshot.SessionId).ExecuteUpdateAsync(u => u.SetProperty(s => s.LastSeenAt, now), ct);
        cache.Set(Key(snapshot.SessionId), snapshot with { LastSeenAt = now }, TimeSpan.FromSeconds(30));
    }

    public async Task EndAsync(Guid sid, string reason, CancellationToken ct = default)
    {
        var now = time.GetUtcNow().UtcDateTime;
        await db.UserSessions.Where(s => s.Id == sid && s.Status != SessionStatus.Ended)
            .ExecuteUpdateAsync(u => u.SetProperty(s => s.Status, SessionStatus.Ended).SetProperty(s => s.EndedAt, now).SetProperty(s => s.EndReason, reason), ct);
        Invalidate(sid);
    }

    /// <summary>Ends every open session of a user (password reset, deactivation, single-session sign-in).</summary>
    public async Task EndAllOfUserAsync(Guid userId, string reason, Guid? except = null, CancellationToken ct = default)
    {
        var ids = await db.UserSessions.Where(s => s.UserId == userId && s.Status != SessionStatus.Ended && s.Id != except).Select(s => s.Id).ToListAsync(ct);
        foreach (var id in ids) await EndAsync(id, reason, ct);
    }
}

/// <summary>
/// After authentication: loads the session behind the cookie, ends it when it is idle too long
/// and treats the request as anonymous when the session is gone.
/// </summary>
public sealed class SessionMiddleware(RequestDelegate next)
{
    /// <summary>A sign-in that stops halfway (password accepted, no MFA code) expires after this.</summary>
    static readonly TimeSpan PendingTimeout = TimeSpan.FromMinutes(10);

    public async Task InvokeAsync(HttpContext ctx, CurrentSession current, SessionStore store, SecuritySettingsStore settings, TimeProvider time)
    {
        current.Ip = ctx.Connection.RemoteIpAddress?.ToString();
        if (ctx.User.Identity?.IsAuthenticated == true && Guid.TryParse(ctx.User.FindFirstValue(IdentityModule.SessionClaim), out var sid))
        {
            var ct = ctx.RequestAborted;
            var snapshot = await store.LoadAsync(sid, ct);
            var ok = snapshot is not null && snapshot.Status != SessionStatus.Ended;
            if (ok)
            {
                var now = time.GetUtcNow().UtcDateTime;
                var active = snapshot!.Status == SessionStatus.Active;
                var limit = active ? TimeSpan.FromMinutes((await settings.GetAsync(ct)).SessionIdleMinutes) : PendingTimeout;
                if (now - (active ? snapshot.LastSeenAt : snapshot.CreatedAt) > limit)
                {
                    await store.EndAsync(sid, "expired", ct);
                    ok = false;
                }
                else
                {
                    if (active && now - snapshot.LastSeenAt > TimeSpan.FromMinutes(1)) await store.TouchAsync(snapshot, ct);
                    current.Snapshot = snapshot;
                }
            }
            if (!ok)
            {
                await ctx.SignOutAsync(IdentityModule.Scheme);
                ctx.User = new ClaimsPrincipal(new ClaimsIdentity());
            }
        }
        await next(ctx);
    }
}

/// <summary>
/// Cross-site request guard: state-changing /api calls must carry X-Bazlama-Request. A page on
/// another origin cannot add a custom header without a CORS preflight (and the cookie is
/// SameSite=Strict as well).
/// </summary>
public sealed class RequestHeaderGuardMiddleware(RequestDelegate next)
{
    public const string Header = "X-Bazlama-Request";

    public Task InvokeAsync(HttpContext ctx)
    {
        var m = ctx.Request.Method;
        if (ctx.Request.Path.StartsWithSegments("/api") && !(HttpMethods.IsGet(m) || HttpMethods.IsHead(m) || HttpMethods.IsOptions(m))
            && !ctx.Request.Headers.ContainsKey(Header))
        {
            ctx.Response.StatusCode = StatusCodes.Status400BadRequest;
            return ctx.Response.WriteAsJsonAsync(new { error = $"Missing {Header} header." });
        }
        return next(ctx);
    }
}

public sealed class ActiveSessionRequirement : IAuthorizationRequirement;

public sealed record PermissionRequirement(string Permission) : IAuthorizationRequirement;

public sealed class SessionAuthorizationHandler(CurrentSession current) : IAuthorizationHandler
{
    public Task HandleAsync(AuthorizationHandlerContext context)
    {
        foreach (var r in context.PendingRequirements.ToList())
        {
            if (r is ActiveSessionRequirement && current.IsActive) context.Succeed(r);
            else if (r is PermissionRequirement p && current.Has(p.Permission)) context.Succeed(r);
        }
        return Task.CompletedTask;
    }
}

public static class AuthorizationExtensions
{
    /// <summary>A signed-in, fully authenticated (Active) session.</summary>
    public static TBuilder RequireActiveSession<TBuilder>(this TBuilder builder) where TBuilder : IEndpointConventionBuilder =>
        builder.RequireAuthorization(p => p.RequireAuthenticatedUser().AddRequirements(new ActiveSessionRequirement()));

    public static TBuilder RequirePermission<TBuilder>(this TBuilder builder, string permission) where TBuilder : IEndpointConventionBuilder =>
        builder.RequireAuthorization(p => p.RequireAuthenticatedUser().AddRequirements(new ActiveSessionRequirement(), new PermissionRequirement(permission)));
}
