using System.Threading.RateLimiting;
using Bazlama.Kernel.Auditing;
using Bazlama.Kernel.Data;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace Bazlama.Modules.Identity;

public static class IdentityModule
{
    public const string Scheme = "bazlama";
    public const string SessionClaim = "sid";
    public const string LoginRateLimit = "login";

    public static IServiceCollection AddIdentityModule(this IServiceCollection services)
    {
        services.AddMemoryCache();
        services.TryAddTimeProvider();
        services.AddDataProtection().SetApplicationName("Bazlama").PersistKeysToDbContext<KernelDbContext>();

        services.AddScoped<CurrentSession>();
        services.AddScoped<IAuditActor>(sp => sp.GetRequiredService<CurrentSession>());
        services.AddScoped<SessionStore>();
        services.AddScoped<SecuritySettingsStore>();
        services.AddScoped<PasswordService>();
        services.AddScoped<OrgContextService>();
        services.AddScoped<AuthService>();
        services.AddScoped<IAuthorizationHandler, SessionAuthorizationHandler>();

        services.AddAuthentication(Scheme).AddCookie(Scheme, o =>
        {
            o.Cookie.Name = "bazlama.session";
            o.Cookie.HttpOnly = true;
            o.Cookie.SameSite = SameSiteMode.Strict;
            o.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
            // The session row decides expiry (idle timeout); the cookie just must outlive it.
            o.ExpireTimeSpan = TimeSpan.FromHours(24);
            o.SlidingExpiration = true;
            // An API: answer 401/403 instead of redirecting to a login page.
            o.Events.OnRedirectToLogin = c => { c.Response.StatusCode = StatusCodes.Status401Unauthorized; return Task.CompletedTask; };
            o.Events.OnRedirectToAccessDenied = c => { c.Response.StatusCode = StatusCodes.Status403Forbidden; return Task.CompletedTask; };
        });
        services.AddAuthorization();

        services.AddRateLimiter(o =>
        {
            o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            o.AddPolicy(LoginRateLimit, http => RateLimitPartition.GetFixedWindowLimiter(
                http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                _ => new FixedWindowRateLimiterOptions { PermitLimit = 30, Window = TimeSpan.FromMinutes(1) }));
        });
        return services;
    }

    static void TryAddTimeProvider(this IServiceCollection services)
    {
        if (!services.Any(s => s.ServiceType == typeof(TimeProvider))) services.AddSingleton(TimeProvider.System);
    }

    /// <summary>Authentication, session loading, the request header guard, authorization.</summary>
    public static IApplicationBuilder UseIdentityModule(this IApplicationBuilder app) => app
        .UseMiddleware<RequestHeaderGuardMiddleware>()
        .UseAuthentication()
        .UseMiddleware<SessionMiddleware>()
        .UseAuthorization()
        .UseRateLimiter();
}
