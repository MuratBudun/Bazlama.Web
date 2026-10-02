using System.Text.Json;
using System.Text.RegularExpressions;
using Bazlama.Compiler;
using Bazlama.Engine;
using Bazlama.Engine.Metadata;
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
public sealed record DevApp(string Key, string Name, string? Version, int FileCount, BuildInfo? ActiveBuild, bool Loaded, bool Stale, bool Installed, bool HasDraft);
public sealed record AppCreate(string Key, string Name, string? Description);
public sealed record PublishRequest(string Version, bool ConfirmDestructive);

/// <summary>/api/development: app code workspaces, compiling, code libraries.</summary>
public static partial class DevelopmentModule
{
    [GeneratedRegex(@"^[A-Za-z0-9_\-]+(/[A-Za-z0-9_\-]+)*\.cs$")]
    private static partial Regex FilePath();

    [GeneratedRegex("^[a-z][a-z0-9_]{0,29}$")]
    private static partial Regex LibraryKey();

    [GeneratedRegex("^[a-z][a-z0-9_]{0,19}$")]
    private static partial Regex AppKey();

    static string? DraftName(string json)
    {
        try
        {
            return JsonDocument.Parse(json).RootElement.TryGetProperty("name", out var n) ? n.GetString() : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Validation messages of a draft (an unreadable one gives its JSON error).</summary>
    static IReadOnlyList<string> Validate(string json)
    {
        try
        {
            return MetadataValidator.Validate(AppDefinition.Parse(json));
        }
        catch (JsonException e)
        {
            return [$"Tanım okunamadı: {e.Message}"];
        }
    }

    /// <summary>The draft with the version to publish.</summary>
    static async Task<(AppDefinition? Definition, string? Error)> DraftAsync(KernelDbContext db, string app, string version, CancellationToken ct)
    {
        var json = await db.AppDrafts.AsNoTracking().Where(d => d.AppKey == app).Select(d => d.Definition).FirstOrDefaultAsync(ct);
        if (json is null) return (null, "Yayınlanacak taslak yok: tanımda değişiklik yapın.");
        try
        {
            var draft = AppDefinition.Parse(json);
            return (new AppDefinition
            {
                Key = draft.Key,
                Name = draft.Name,
                Version = version,
                Description = draft.Description,
                Icon = draft.Icon,
                Entities = draft.Entities,
            }, null);
        }
        catch (JsonException e)
        {
            return (null, $"Taslak okunamadı: {e.Message}");
        }
    }

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
            var drafts = await db.AppDrafts.AsNoTracking().ToDictionaryAsync(d => d.AppKey, d => d.Definition, ct);
            var installed = apps.Values.Select(a =>
            {
                var build = builds.GetValueOrDefault(a.Key);
                var loaded = host.Get(a.Key);
                return new DevApp(a.Key, a.Name, a.Version, counts.GetValueOrDefault(a.Key), build, loaded is not null,
                    build is not null && (build.AppVersion != a.Version || loaded is null), true, drafts.ContainsKey(a.Key));
            });
            // Apps that exist only as a draft (never published).
            var draftOnly = drafts.Where(d => !apps.ContainsKey(d.Key)).Select(d =>
                new DevApp(d.Key, DraftName(d.Value) ?? d.Key, null, counts.GetValueOrDefault(d.Key), null, false, false, false, true));
            return installed.Concat(draftOnly).OrderBy(a => a.Name);
        });

        api.MapPost("/apps", async (AppCreate r, AppRegistry registry, KernelDbContext db, IRequestContext request, TimeProvider time, CancellationToken ct) =>
        {
            if (!AppKey().IsMatch(r.Key ?? "")) return AuthEndpoints.Problem(["App anahtarı geçersiz (küçük harf, rakam, _; en fazla 20 karakter)."]);
            if (string.IsNullOrWhiteSpace(r.Name)) return AuthEndpoints.Problem(["Ad gerekli."]);
            if (await registry.GetAsync(r.Key!, ct) is not null || await db.AppDrafts.AnyAsync(d => d.AppKey == r.Key, ct))
                return AuthEndpoints.Problem(["Bu anahtarla bir uygulama zaten var."]);
            var definition = new AppDefinition { Key = r.Key!, Name = r.Name.Trim(), Version = "0.0.0", Description = r.Description?.Trim(), Entities = [] };
            db.AppDrafts.Add(new AppDraft { AppKey = r.Key!, Definition = definition.ToJson(), UpdatedAt = time.GetUtcNow().UtcDateTime, UpdatedBy = request.UserId });
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        var app = api.MapGroup("/apps/{app}");

        app.MapGet("/workspace", async (string app, AppRegistry registry, CodeBuildService builds, KernelDbContext db, AppCodeHost host, CancellationToken ct) =>
        {
            var def = await builds.EditingDefinitionAsync(app, ct);
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

        app.MapPut("/files", async (string app, FileSave f, CodeBuildService builds, KernelDbContext db, IRequestContext request, TimeProvider time, CancellationToken ct) =>
        {
            if (await builds.EditingDefinitionAsync(app, ct) is null) return Results.NotFound();
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

        app.MapPut("/libraries", async (string app, List<LibraryRef> libraries, CodeBuildService builds, KernelDbContext db, CancellationToken ct) =>
        {
            if (await builds.EditingDefinitionAsync(app, ct) is null) return Results.NotFound();
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
        app.MapPost("/check", async (string app, FilesCheck r, CodeBuildService builds, CancellationToken ct) =>
            await builds.EditingDefinitionAsync(app, ct) is null ? Results.NotFound() : Results.Ok(await builds.CheckAsync(app, r.Files, ct)));

        app.MapPost("/complete", async (string app, CompletionRequest r, CodeBuildService builds, CancellationToken ct) =>
            await builds.EditingDefinitionAsync(app, ct) is null ? Results.NotFound() : Results.Ok(await builds.CompleteAsync(app, r.Files, r.Path, r.Line, r.Column, ct)));

        // ── Draft definition (the designers) and publishing ─────────────

        app.MapGet("/draft", async (string app, AppRegistry registry, KernelDbContext db, CancellationToken ct) =>
        {
            var installed = await registry.GetAsync(app, ct);
            var draft = await db.AppDrafts.AsNoTracking().FirstOrDefaultAsync(d => d.AppKey == app, ct);
            if (draft is null && installed is null) return Results.NotFound();
            var json = draft?.Definition ?? installed!.ToJson();
            return Results.Ok(new
            {
                definition = JsonDocument.Parse(json).RootElement,
                isDraft = draft is not null,
                installedVersion = installed?.Version,
                installed = installed is null ? (JsonElement?)null : JsonDocument.Parse(installed.ToJson()).RootElement,
                errors = Validate(json),
                updatedAt = draft?.UpdatedAt,
            });
        });

        app.MapPut("/draft", async (string app, JsonElement definition, AppRegistry registry, KernelDbContext db, IRequestContext request, TimeProvider time, CancellationToken ct) =>
        {
            var draft = await db.AppDrafts.FirstOrDefaultAsync(d => d.AppKey == app, ct);
            if (draft is null && await registry.GetAsync(app, ct) is null) return Results.NotFound();
            var json = definition.GetRawText();
            if (definition.ValueKind != JsonValueKind.Object || (definition.TryGetProperty("key", out var k) && k.GetString() != app))
                return AuthEndpoints.Problem(["Tanım bu uygulamaya ait değil."]);
            if (draft is null) db.AppDrafts.Add(draft = new AppDraft { AppKey = app, Definition = json });
            else draft.Definition = json;
            draft.UpdatedAt = time.GetUtcNow().UtcDateTime;
            draft.UpdatedBy = request.UserId;
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { errors = Validate(json) });
        });

        app.MapDelete("/draft", async (string app, AppRegistry registry, KernelDbContext db, CancellationToken ct) =>
        {
            if (await registry.GetAsync(app, ct) is null) return AuthEndpoints.Problem(["Yayınlanmamış bir uygulamanın taslağı atılamaz."]);
            await db.AppDrafts.Where(d => d.AppKey == app).ExecuteDeleteAsync(ct);
            return Results.NoContent();
        });

        app.MapPost("/publish/plan", async (string app, PublishRequest r, KernelDbContext db, AppInstaller installer, CodeBuildService builds, CancellationToken ct) =>
        {
            var (definition, error) = await DraftAsync(db, app, r.Version, ct);
            if (definition is null) return AuthEndpoints.Problem([error!]);
            var plan = await installer.PlanAsync(definition, ct);
            var files = await builds.FilesAsync(app, ct);
            var code = files.Count == 0 ? null : await builds.CheckAgainstAsync(definition, files, await builds.LibrariesOfAsync(app, ct), ct);
            return Results.Ok(new { plan, code });
        });

        // The draft becomes a version: the code must compile against it, then it is installed (the code is rebuilt).
        app.MapPost("/publish", async (string app, PublishRequest r, KernelDbContext db, AppInstaller installer, CodeBuildService builds, CancellationToken ct) =>
        {
            var (definition, error) = await DraftAsync(db, app, r.Version, ct);
            if (definition is null) return AuthEndpoints.Problem([error!]);
            var files = await builds.FilesAsync(app, ct);
            if (files.Count > 0)
            {
                var code = await builds.CheckAgainstAsync(definition, files, await builds.LibrariesOfAsync(app, ct), ct);
                if (!code.Success) return Results.Json(new { errors = new[] { "Kod yeni tanımla derlenmiyor; önce kodu düzeltin." }, code }, statusCode: StatusCodes.Status400BadRequest);
            }
            var result = await installer.InstallAsync(definition, r.ConfirmDestructive, ct);
            if (!result.Installed)
                return Results.Json(new { errors = result.Plan.Errors.Count > 0 ? result.Plan.Errors : ["Veri kaybına yol açan değişiklikler onay bekliyor."], plan = result.Plan }, statusCode: StatusCodes.Status400BadRequest);
            await db.AppDrafts.Where(d => d.AppKey == app).ExecuteDeleteAsync(ct);
            SessionStore.PermissionsChanged();
            return Results.Ok(new { plan = result.Plan });
        });

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
