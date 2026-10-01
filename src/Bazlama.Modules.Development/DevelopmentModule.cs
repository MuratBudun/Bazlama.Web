using System.Text.Json;
using System.Text.RegularExpressions;
using Bazlama.Compiler;
using Bazlama.Engine;
using Bazlama.Kernel;
using Bazlama.Kernel.Code;
using Bazlama.Kernel.Data;
using Bazlama.Kernel.Identity;
using Bazlama.Modules.Identity;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;

namespace Bazlama.Modules.Development;

public sealed record FileSave(string Path, string Content);
public sealed record FilesCheck(IReadOnlyList<SourceFile> Files);
public sealed record CompletionRequest(IReadOnlyList<SourceFile> Files, string Path, int Line, int Column);
public sealed record LibraryCreate(string Key, string Name, string? Description);
public sealed record LibraryPublish(string Version);
public sealed record BuildInfo(int Number, string AppVersion, string Hash, DateTime CreatedAt);
public sealed record DevApp(string Key, string Name, string Version, int FileCount, BuildInfo? ActiveBuild, bool Loaded, bool Stale);

/// <summary>/api/development: app code workspaces, compiling, code libraries.</summary>
public static partial class DevelopmentModule
{
    [GeneratedRegex(@"^[A-Za-z0-9_\-]+(/[A-Za-z0-9_\-]+)*\.cs$")]
    private static partial Regex FilePath();

    [GeneratedRegex("^[a-z][a-z0-9_]{0,29}$")]
    private static partial Regex LibraryKey();

    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static IEndpointRouteBuilder MapDevelopmentEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var api = endpoints.MapGroup("/api/development").RequirePermission(Permissions.Development);

        // Writes only in a development installation (Test/Production change by import).
        api.AddEndpointFilter(async (context, next) =>
        {
            var platform = context.HttpContext.RequestServices.GetService(typeof(PlatformInfo)) as PlatformInfo;
            if (!HttpMethods.IsGet(context.HttpContext.Request.Method) && platform is { CanDevelop: false })
                return AuthEndpoints.Problem([$"Bu kurulum bir {platform.Mode} ortamı: kod yalnız geliştirme ortamında değiştirilir."], StatusCodes.Status403Forbidden);
            return await next(context);
        });

        api.MapGet("/apps", async (AppRegistry registry, KernelDbContext db, AppCodeHost host, CancellationToken ct) =>
        {
            var apps = await registry.AllAsync(ct);
            var counts = await db.AppCodeFiles.GroupBy(f => f.AppKey).Select(g => new { g.Key, Count = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.Count, ct);
            var builds = await db.AppBuilds.Where(b => b.IsActive).Select(b => new { b.AppKey, Info = new BuildInfo(b.Number, b.AppVersion, b.Hash, b.CreatedAt) }).ToDictionaryAsync(x => x.AppKey, x => x.Info, ct);
            return apps.Values.OrderBy(a => a.Name).Select(a =>
            {
                var build = builds.GetValueOrDefault(a.Key);
                var loaded = host.Get(a.Key);
                return new DevApp(a.Key, a.Name, a.Version, counts.GetValueOrDefault(a.Key), build, loaded is not null,
                    build is not null && (build.AppVersion != a.Version || loaded is null));
            });
        });

        var app = api.MapGroup("/apps/{app}");

        app.MapGet("/workspace", async (string app, AppRegistry registry, CodeBuildService builds, KernelDbContext db, AppCodeHost host, CancellationToken ct) =>
        {
            var def = await registry.GetAsync(app, ct);
            if (def is null) return Results.NotFound();
            var active = await db.AppBuilds.Where(b => b.AppKey == app && b.IsActive).Select(b => new BuildInfo(b.Number, b.AppVersion, b.Hash, b.CreatedAt)).FirstOrDefaultAsync(ct);
            var loaded = host.Get(app);
            return Results.Ok(new
            {
                app = new { def.Key, def.Name, def.Version, Namespace = EntityCodeGenerator.Namespace(def) },
                files = await builds.FilesAsync(app, ct),
                generated = new SourceFile(EntityCodeGenerator.FileName, EntityCodeGenerator.Generate(def)),
                libraries = await builds.LibrariesOfAsync(app, ct),
                activeBuild = active,
                loaded = loaded is null ? null : new
                {
                    loaded.BuildNumber,
                    events = loaded.Events.ToDictionary(e => e.Key, e => e.Value.Select(t => t.Name)),
                    actions = loaded.Actions.ToDictionary(a => a.Key, a => a.Value.Select(x => x.Label)),
                },
            });
        });

        app.MapPut("/files", async (string app, FileSave f, AppRegistry registry, KernelDbContext db, IRequestContext request, TimeProvider time, CancellationToken ct) =>
        {
            if (await registry.GetAsync(app, ct) is null) return Results.NotFound();
            if (!FilePath().IsMatch(f.Path ?? "") || f.Path == EntityCodeGenerator.FileName) return AuthEndpoints.Problem(["Dosya yolu geçersiz (örn. Siparis/SiparisEvents.cs)."]);
            var file = await db.AppCodeFiles.FirstOrDefaultAsync(x => x.AppKey == app && x.Path == f.Path, ct);
            if (file is null) db.AppCodeFiles.Add(file = new AppCodeFile { AppKey = app, Path = f.Path!, Content = f.Content ?? "" });
            else file.Content = f.Content ?? "";
            file.UpdatedAt = time.GetUtcNow().UtcDateTime;
            file.UpdatedBy = request.UserId;
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        app.MapDelete("/files", async (string app, string path, KernelDbContext db, CancellationToken ct) =>
        {
            var removed = await db.AppCodeFiles.Where(x => x.AppKey == app && x.Path == path).ExecuteDeleteAsync(ct);
            return removed == 0 ? Results.NotFound() : Results.NoContent();
        });

        app.MapPut("/libraries", async (string app, List<LibraryRef> libraries, AppRegistry registry, KernelDbContext db, CancellationToken ct) =>
        {
            if (await registry.GetAsync(app, ct) is null) return Results.NotFound();
            foreach (var l in libraries)
            {
                var exists = await (from v in db.CodeLibraryVersions join lib in db.CodeLibraries on v.LibraryId equals lib.Id
                                    where lib.Key == l.Key && v.Version == l.Version select v.Id).AnyAsync(ct);
                if (!exists) return AuthEndpoints.Problem([$"Kütüphane versiyonu bulunamadı: {l.Key} {l.Version}"]);
            }
            if (libraries.GroupBy(l => l.Key).Any(g => g.Count() > 1)) return AuthEndpoints.Problem(["Bir kütüphanenin yalnız bir versiyonu kullanılabilir."]);
            var workspace = await db.AppWorkspaces.FirstOrDefaultAsync(w => w.AppKey == app, ct);
            if (workspace is null) db.AppWorkspaces.Add(workspace = new AppWorkspace { AppKey = app });
            workspace.Libraries = JsonSerializer.Serialize(libraries, Json);
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        // Unsaved editor contents → diagnostics (the editor marks them).
        app.MapPost("/check", async (string app, FilesCheck r, AppRegistry registry, CodeBuildService builds, CancellationToken ct) =>
            await registry.GetAsync(app, ct) is null ? Results.NotFound() : Results.Ok(await builds.CheckAsync(app, r.Files, ct)));

        app.MapPost("/complete", async (string app, CompletionRequest r, AppRegistry registry, CodeBuildService builds, CancellationToken ct) =>
            await registry.GetAsync(app, ct) is null ? Results.NotFound() : Results.Ok(await builds.CompleteAsync(app, r.Files, r.Path, r.Line, r.Column, ct)));

        app.MapPost("/build", async (string app, CodeBuildService builds, CancellationToken ct) =>
        {
            var result = await builds.BuildAsync(app, ct);
            return result.Success ? Results.Ok(result) : Results.Json(result, statusCode: StatusCodes.Status400BadRequest);
        });

        // ── Libraries ──────────────────────────────────────────────────────

        var libs = api.MapGroup("/libraries");

        libs.MapGet("/", async (KernelDbContext db, CancellationToken ct) =>
        {
            var versions = (await db.CodeLibraryVersions.AsNoTracking().Select(v => new { v.LibraryId, v.Version, v.CreatedAt }).ToListAsync(ct))
                .ToLookup(v => v.LibraryId);
            var list = await db.CodeLibraries.AsNoTracking().OrderBy(l => l.Key).ToListAsync(ct);
            return list.Select(l => new
            {
                l.Key,
                l.Name,
                l.Description,
                versions = versions[l.Id].OrderByDescending(v => v.CreatedAt).Select(v => v.Version),
            });
        });

        libs.MapPost("/", async (LibraryCreate r, KernelDbContext db, CancellationToken ct) =>
        {
            if (!LibraryKey().IsMatch(r.Key ?? "")) return AuthEndpoints.Problem(["Kütüphane anahtarı geçersiz (küçük harf, rakam, _)."]);
            if (string.IsNullOrWhiteSpace(r.Name)) return AuthEndpoints.Problem(["Ad gerekli."]);
            if (await db.CodeLibraries.AnyAsync(l => l.Key == r.Key, ct)) return AuthEndpoints.Problem(["Bu anahtar kullanılıyor."]);
            db.CodeLibraries.Add(new CodeLibrary { Key = r.Key!, Name = r.Name.Trim(), Description = r.Description?.Trim() });
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        libs.MapGet("/{key}", async (string key, KernelDbContext db, CancellationToken ct) =>
        {
            var lib = await db.CodeLibraries.AsNoTracking().FirstOrDefaultAsync(l => l.Key == key, ct);
            if (lib is null) return Results.NotFound();
            var files = await db.CodeLibraryFiles.AsNoTracking().Where(f => f.LibraryId == lib.Id).OrderBy(f => f.Path).Select(f => new SourceFile(f.Path, f.Content)).ToListAsync(ct);
            var versions = await db.CodeLibraryVersions.AsNoTracking().Where(v => v.LibraryId == lib.Id).OrderByDescending(v => v.CreatedAt)
                .Select(v => new { v.Version, v.Hash, v.CreatedAt }).ToListAsync(ct);
            return Results.Ok(new { lib.Key, lib.Name, lib.Description, files, versions });
        });

        libs.MapPut("/{key}/files", async (string key, FileSave f, KernelDbContext db, IRequestContext request, TimeProvider time, CancellationToken ct) =>
        {
            var lib = await db.CodeLibraries.FirstOrDefaultAsync(l => l.Key == key, ct);
            if (lib is null) return Results.NotFound();
            if (!FilePath().IsMatch(f.Path ?? "")) return AuthEndpoints.Problem(["Dosya yolu geçersiz (örn. Metin.cs)."]);
            var file = await db.CodeLibraryFiles.FirstOrDefaultAsync(x => x.LibraryId == lib.Id && x.Path == f.Path, ct);
            if (file is null) db.CodeLibraryFiles.Add(file = new CodeLibraryFile { LibraryId = lib.Id, Path = f.Path!, Content = f.Content ?? "" });
            else file.Content = f.Content ?? "";
            file.UpdatedAt = time.GetUtcNow().UtcDateTime;
            file.UpdatedBy = request.UserId;
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        libs.MapDelete("/{key}/files", async (string key, string path, KernelDbContext db, CancellationToken ct) =>
        {
            var lib = await db.CodeLibraries.FirstOrDefaultAsync(l => l.Key == key, ct);
            if (lib is null) return Results.NotFound();
            var removed = await db.CodeLibraryFiles.Where(x => x.LibraryId == lib.Id && x.Path == path).ExecuteDeleteAsync(ct);
            return removed == 0 ? Results.NotFound() : Results.NoContent();
        });

        libs.MapPost("/{key}/check", (string key, FilesCheck r, CodeBuildService builds) => Results.Ok(builds.CheckLibrary(key, r.Files)));

        libs.MapPost("/{key}/complete", async (string key, CompletionRequest r, CancellationToken ct) =>
            Results.Ok(await CodeBuildService.CompleteLibraryAsync(r.Files, r.Path, r.Line, r.Column, ct)));

        libs.MapPost("/{key}/publish", async (string key, LibraryPublish r, CodeBuildService builds, CancellationToken ct) =>
        {
            var result = await builds.PublishLibraryAsync(key, r.Version, ct);
            return result.Success ? Results.Ok(result) : Results.Json(result, statusCode: StatusCodes.Status400BadRequest);
        });

        return endpoints;
    }
}
