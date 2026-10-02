using System.Text.Json;
using Bazlama.Engine;
using Bazlama.Engine.Metadata;
using Bazlama.Kernel;
using Bazlama.Packaging;
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

        // Installing from a bare definition: a development installation only (others take packages).
        apps.MapPost("/plan", async (JsonElement definition, AppInstaller installer, PlatformInfo platform, CancellationToken ct) =>
            !platform.CanDevelop ? PackagesOnly(platform)
            : Read(definition, out var app, out var error) ? Results.Ok(await installer.PlanAsync(app!, ct)) : Errors(error!));

        apps.MapPost("/install", async (InstallRequest request, AppInstaller installer, PlatformInfo platform, CancellationToken ct) =>
        {
            if (!platform.CanDevelop) return PackagesOnly(platform);
            if (!Read(request.Definition, out var app, out var error)) return Errors(error!);
            var result = await installer.InstallAsync(app!, request.ConfirmDestructive, ct);
            if (result.Installed) SessionStore.PermissionsChanged(); // new app permissions in the catalog
            return result.Installed ? Results.Ok(result) : Results.Json(result, statusCode: StatusCodes.Status400BadRequest);
        });

        // ── .bzapp packages ──────────────────────────────────────────────

        apps.MapGet("/{key}/export", async (string key, PackageService packages, CancellationToken ct) =>
        {
            var (bytes, name, error) = await packages.ExportAsync(key, ct);
            return bytes is null ? Errors(error!) : Results.File(bytes, "application/zip", name);
        });

        apps.MapPost("/import/preview", async (HttpRequest http, PackageService packages, CancellationToken ct) =>
            await Body(http, ct) is { } bytes ? Results.Ok(await packages.PreviewAsync(bytes, ct)) : Errors("Paket 20 MB'tan büyük olamaz."));

        apps.MapPost("/import", async (HttpRequest http, bool? confirmDestructive, PackageService packages, CancellationToken ct) =>
        {
            if (await Body(http, ct) is not { } bytes) return Errors("Paket 20 MB'tan büyük olamaz.");
            var result = await packages.ImportAsync(bytes, confirmDestructive ?? false, ct);
            if (result.Imported) SessionStore.PermissionsChanged();
            return result.Imported ? Results.Ok(result) : Results.Json(result, statusCode: StatusCodes.Status400BadRequest);
        });
    }

    static IResult PackagesOnly(PlatformInfo platform) =>
        Errors($"Bu kurulum bir {platform.Mode} ortamı: uygulamalar yalnız paketle (.bzapp) kurulur ve güncellenir.");

    /// <summary>The raw request body (a .bzapp), at most 20 MB.</summary>
    static async Task<byte[]?> Body(HttpRequest http, CancellationToken ct)
    {
        const int Max = 20 * 1024 * 1024;
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await http.Body.ReadAsync(chunk, ct)) > 0)
        {
            if (buffer.Length + read > Max) return null;
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }

    static bool Read(JsonElement json, out AppDefinition? app, out string? error)
    {
        app = null;
        error = null;
        try
        {
            app = AppDefinition.Parse(json.GetRawText());
            return true;
        }
        catch (JsonException e)
        {
            error = $"Tanım okunamadı: {e.Message}";
            return false;
        }
    }
}
