using System.Security.Claims;
using Bazlama.Kernel.Data;
using Bazlama.Kernel.Identity;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;

namespace Bazlama.Modules.Identity;

public sealed record LoginRequest(string UserName, string Password);
public sealed record PasswordRequest(string? CurrentPassword, string NewPassword);
public sealed record CodeRequest(string Code);

public sealed record MeUser(Guid Id, string UserName, string DisplayName, bool MfaEnabled);
public sealed record MeContext(NamedOption? Company, NamedOption? Location, NamedOption? Plant, PeriodOption? Period);

/// <summary>
/// GET /api/auth/me. Status: anonymous | mfa | mfaEnrollment | passwordChange | active.
/// An active user without a context must choose one (<c>contextRequired</c>).
/// </summary>
public sealed record MeResponse(bool SetupRequired, string Status, MeUser? User, IReadOnlyList<string> Permissions, MeContext? Context, bool ContextRequired);

public static class AuthEndpoints
{
    public static IEndpointRouteBuilder MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        var auth = app.MapGroup("/api/auth");

        auth.MapGet("/me", MeAsync);

        auth.MapPost("/setup", async (SetupRequest request, AuthService service, CancellationToken ct) =>
        {
            var errors = await service.SetupAsync(request, ct);
            return errors.Count == 0 ? Results.NoContent() : Problem(errors);
        }).RequireRateLimiting(IdentityModule.LoginRateLimit);

        auth.MapPost("/login", async (LoginRequest request, HttpContext http, AuthService service, CancellationToken ct) =>
        {
            var result = await service.LoginAsync(request.UserName ?? "", request.Password ?? "", "web",
                http.Connection.RemoteIpAddress?.ToString(), http.Request.Headers.UserAgent.ToString(), ct);
            if (result.Session is null) return Problem([result.Error!], StatusCodes.Status401Unauthorized);
            await SignInAsync(http, result.Session);
            return Results.Ok(await BuildMeAsync(http, result.Session.Id, ct));
        }).RequireRateLimiting(IdentityModule.LoginRateLimit);

        auth.MapPost("/password", async (PasswordRequest request, HttpContext http, AuthService service, CancellationToken ct) =>
        {
            if (SessionId(http) is not { } sid) return Results.Unauthorized();
            var errors = await service.ChangePasswordAsync(sid, request.CurrentPassword, request.NewPassword ?? "", ct);
            return errors.Count == 0 ? Results.Ok(await BuildMeAsync(http, sid, ct)) : Problem(errors);
        }).RequireRateLimiting(IdentityModule.LoginRateLimit);

        auth.MapPost("/mfa/setup", async (HttpContext http, AuthService service, CancellationToken ct) =>
        {
            if (SessionId(http) is not { } sid) return Results.Unauthorized();
            var setup = await service.BeginMfaSetupAsync(sid, ct);
            return setup is null ? Problem(["Bu adımda doğrulama uygulaması kurulamaz."]) : Results.Ok(setup);
        });

        auth.MapPost("/mfa/confirm", async (CodeRequest request, HttpContext http, AuthService service, CancellationToken ct) =>
        {
            if (SessionId(http) is not { } sid) return Results.Unauthorized();
            var (codes, error) = await service.CompleteMfaSetupAsync(sid, request.Code ?? "", ct);
            return error is not null ? Problem([error]) : Results.Ok(new { recoveryCodes = codes, me = await BuildMeAsync(http, sid, ct) });
        }).RequireRateLimiting(IdentityModule.LoginRateLimit);

        auth.MapPost("/mfa/verify", async (CodeRequest request, HttpContext http, AuthService service, CancellationToken ct) =>
        {
            if (SessionId(http) is not { } sid) return Results.Unauthorized();
            var error = await service.VerifyMfaAsync(sid, request.Code ?? "", ct);
            return error is not null ? Problem([error]) : Results.Ok(await BuildMeAsync(http, sid, ct));
        }).RequireRateLimiting(IdentityModule.LoginRateLimit);

        auth.MapGet("/context/options", async (CurrentSession current, OrgContextService org, CancellationToken ct) =>
            Results.Ok(await org.OptionsAsync(current.Snapshot!.UserId, ct))).RequireActiveSession();

        auth.MapPut("/context", async (ContextSelection selection, HttpContext http, AuthService service, CancellationToken ct) =>
        {
            var sid = SessionId(http)!.Value;
            var error = await service.SelectContextAsync(sid, selection, ct);
            return error is not null ? Problem([error]) : Results.Ok(await BuildMeAsync(http, sid, ct));
        }).RequireActiveSession();

        auth.MapPost("/logout", async (HttpContext http, AuthService service, CancellationToken ct) =>
        {
            if (SessionId(http) is { } sid) await service.LogoutAsync(sid, ct);
            await http.SignOutAsync(IdentityModule.Scheme);
            return Results.NoContent();
        });

        return app;
    }

    /// <summary>Errors as { errors: [...] }: the UI shows them as they are.</summary>
    public static IResult Problem(IReadOnlyList<string> errors, int status = StatusCodes.Status400BadRequest) =>
        Results.Json(new { errors }, statusCode: status);

    static Guid? SessionId(HttpContext http) =>
        http.RequestServices.GetService(typeof(CurrentSession)) is CurrentSession { Snapshot: { } s } ? s.SessionId : null;

    static Task SignInAsync(HttpContext http, UserSession session)
    {
        var identity = new ClaimsIdentity(
            [new Claim(ClaimTypes.NameIdentifier, session.UserId.ToString()), new Claim(IdentityModule.SessionClaim, session.Id.ToString())],
            IdentityModule.Scheme);
        return http.SignInAsync(IdentityModule.Scheme, new ClaimsPrincipal(identity));
    }

    static async Task<MeResponse> MeAsync(HttpContext http, CurrentSession current, AuthService service, CancellationToken ct)
    {
        if (current.Snapshot is null)
            return new MeResponse(await service.SetupRequiredAsync(ct), "anonymous", null, [], null, false);
        return await BuildMeAsync(http, current.Snapshot.SessionId, ct);
    }

    static async Task<MeResponse> BuildMeAsync(HttpContext http, Guid sessionId, CancellationToken ct)
    {
        var sp = http.RequestServices;
        var db = (KernelDbContext)sp.GetService(typeof(KernelDbContext))!;
        var store = (SessionStore)sp.GetService(typeof(SessionStore))!;
        store.Invalidate(sessionId);
        var s = (await store.LoadAsync(sessionId, ct))!;
        var mfa = await db.Users.Where(u => u.Id == s.UserId).Select(u => u.TotpEnabled).FirstAsync(ct);
        var user = new MeUser(s.UserId, s.UserName, s.DisplayName, mfa);
        var status = s.Status switch
        {
            SessionStatus.PendingMfa => "mfa",
            SessionStatus.PendingMfaEnrollment => "mfaEnrollment",
            SessionStatus.PendingPasswordChange => "passwordChange",
            SessionStatus.Active => "active",
            _ => "anonymous",
        };
        if (status != "active") return new MeResponse(false, status, status == "anonymous" ? null : user, [], null, false);

        MeContext? context = null;
        if (s.CompanyId is { } companyId)
        {
            var company = await db.Companies.Where(c => c.Id == companyId).Select(c => new NamedOption(c.Id, c.Code, c.Name)).FirstOrDefaultAsync(ct);
            var location = await db.Locations.Where(l => l.Id == s.LocationId).Select(l => new NamedOption(l.Id, l.Code, l.Name)).FirstOrDefaultAsync(ct);
            var plant = s.PlantId is null ? null : await db.Plants.Where(p => p.Id == s.PlantId).Select(p => new NamedOption(p.Id, p.Code, p.Name)).FirstOrDefaultAsync(ct);
            var period = s.PeriodId is null ? null : await db.Periods.Where(p => p.Id == s.PeriodId)
                .Select(p => new PeriodOption(p.Id, p.Code, p.Name, p.StartDate, p.EndDate, p.IsClosed)).FirstOrDefaultAsync(ct);
            context = new MeContext(company, location, plant, period);
        }
        return new MeResponse(false, status, user, [.. s.Permissions.Order()], context, context is null);
    }
}
