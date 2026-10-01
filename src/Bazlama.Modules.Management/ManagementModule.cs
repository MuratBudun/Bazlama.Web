using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;

namespace Bazlama.Modules.Management;

/// <summary>/api/management: users, groups, organization, sessions, security settings, audit.</summary>
public static class ManagementModule
{
    public static IEndpointRouteBuilder MapManagementEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/management");
        group.MapUserEndpoints();
        group.MapGroupEndpoints();
        group.MapOrganizationEndpoints();
        group.MapSessionEndpoints();
        group.MapSettingsEndpoints();
        group.MapAuditEndpoints();
        return app;
    }
}

/// <summary>Small helpers shared by the endpoint files.</summary>
static class Http
{
    public static IResult Errors(params string[] errors) => Bazlama.Modules.Identity.AuthEndpoints.Problem(errors);
    public static IResult Errors(IReadOnlyList<string> errors) => Bazlama.Modules.Identity.AuthEndpoints.Problem(errors);

    public static bool Blank(string? s) => string.IsNullOrWhiteSpace(s);

    /// <summary>A delete refused by a foreign key: something still refers to the row.</summary>
    public static async Task<IResult> SaveOrInUseAsync(DbContext db, string inUse, CancellationToken ct, IResult? ok = null)
    {
        try
        {
            await db.SaveChangesAsync(ct);
            return ok ?? Results.NoContent();
        }
        catch (DbUpdateException)
        {
            return Errors(inUse);
        }
    }
}
