using System.Text.Json;
using Bazlama.Engine;
using Bazlama.Engine.Metadata;
using Bazlama.Kernel.Data;
using Bazlama.Kernel.Identity;
using Bazlama.Modules.Identity;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using static Bazlama.Modules.Management.Http;

namespace Bazlama.Modules.Management;

public sealed record AppRow(string Key, string Name, string Version, DateTime InstalledAt, DateTime UpdatedAt, int EntityCount);
public sealed record AppVersionRow(string Version, DateTime InstalledAt, string? InstalledBy, string? Changes);
public sealed record InstallRequest(JsonElement Definition, bool ConfirmDestructive);

/// <summary>Installing and upgrading apps from their definition (until app packages, Faz 4).</summary>
static class AppEndpoints
{
    public static void MapAppEndpoints(this RouteGroupBuilder api)
    {
        var apps = api.MapGroup("/apps").RequirePermission(Permissions.Apps);

        apps.MapGet("/", async (KernelDbContext db, CancellationToken ct) =>
        {
            var rows = await db.Apps.AsNoTracking().OrderBy(a => a.Name).ToListAsync(ct);
            return rows.Select(a => new AppRow(a.Key, a.Name, a.Version, a.InstalledAt, a.UpdatedAt, AppDefinition.Parse(a.Metadata).Entities.Count));
        });

        apps.MapGet("/{key}", async (string key, KernelDbContext db, CancellationToken ct) =>
        {
            var app = await db.Apps.AsNoTracking().FirstOrDefaultAsync(a => a.Key == key, ct);
            if (app is null) return Results.NotFound();
            var versions = await (from v in db.AppVersions
                                  join u in db.Users on v.InstalledBy equals (Guid?)u.Id into users
                                  from u in users.DefaultIfEmpty()
                                  where v.AppId == app.Id
                                  orderby v.InstalledAt descending
                                  select new AppVersionRow(v.Version, v.InstalledAt, u == null ? null : u.DisplayName, v.Changes)).ToListAsync(ct);
            return Results.Ok(new { definition = JsonDocument.Parse(app.Metadata).RootElement, versions });
        });

        apps.MapPost("/plan", async (JsonElement definition, AppInstaller installer, CancellationToken ct) =>
            Read(definition, out var app, out var error) ? Results.Ok(await installer.PlanAsync(app!, ct)) : Errors(error!));

        apps.MapPost("/install", async (InstallRequest request, AppInstaller installer, CancellationToken ct) =>
        {
            if (!Read(request.Definition, out var app, out var error)) return Errors(error!);
            var result = await installer.InstallAsync(app!, request.ConfirmDestructive, ct);
            if (result.Installed) SessionStore.PermissionsChanged(); // new app permissions in the catalog
            return result.Installed ? Results.Ok(result) : Results.Json(result, statusCode: StatusCodes.Status400BadRequest);
        });
    }

    static bool Read(JsonElement json, out AppDefinition? app, out string? error)
    {
        app = null;
        error = null;
        try
        {
            app = json.Deserialize<AppDefinition>(AppDefinition.Json) ?? throw new JsonException("Boş tanım.");
            return true;
        }
        catch (JsonException e)
        {
            error = $"Tanım okunamadı: {e.Message}";
            return false;
        }
    }
}
