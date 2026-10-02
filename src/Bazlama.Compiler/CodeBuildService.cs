using System.Text.Json;
using Bazlama.Engine;
using Bazlama.Engine.Metadata;
using Bazlama.Kernel;
using Bazlama.Kernel.Code;
using Bazlama.Kernel.Data;
using Microsoft.CodeAnalysis;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Bazlama.Compiler;

public sealed record LibraryRef(string Key, string Version);
public sealed record BuildResult(bool Success, int? Number, string? Hash, IReadOnlyList<CodeDiagnostic> Diagnostics, IReadOnlyList<string> Errors);

/// <summary>Compiles app workspaces and code libraries, stores builds and loads the active ones.</summary>
public sealed class CodeBuildService(KernelDbContext db, AppRegistry registry, AppCodeHost host, IRequestContext request, TimeProvider time, ILogger<CodeBuildService> log)
{
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static string AppAssemblyName(string appKey) => $"App.{EntityCodeGenerator.Pascal(appKey)}";
    public static string LibraryAssemblyName(string key) => $"Lib.{EntityCodeGenerator.Pascal(key)}";

    // ── Apps ───────────────────────────────────────────────────────────────

    public async Task<IReadOnlyList<SourceFile>> FilesAsync(string appKey, CancellationToken ct) =>
        await db.AppCodeFiles.AsNoTracking().Where(f => f.AppKey == appKey).OrderBy(f => f.Path)
            .Select(f => new SourceFile(f.Path, f.Content)).ToListAsync(ct);

    public async Task<IReadOnlyList<LibraryRef>> LibrariesOfAsync(string appKey, CancellationToken ct)
    {
        var json = await db.AppWorkspaces.Where(w => w.AppKey == appKey).Select(w => w.Libraries).FirstOrDefaultAsync(ct);
        return json is null ? [] : JsonSerializer.Deserialize<List<LibraryRef>>(json, Json) ?? [];
    }

    /// <summary>
    /// The definition being worked on: the draft when there is one (and it parses), otherwise the
    /// installed one. Code is checked and completed against it, so new fields can be used at once.
    /// </summary>
    public async Task<AppDefinition?> EditingDefinitionAsync(string appKey, CancellationToken ct)
    {
        var draft = await db.AppDrafts.AsNoTracking().Where(d => d.AppKey == appKey).Select(d => d.Definition).FirstOrDefaultAsync(ct);
        if (draft is not null)
        {
            try
            {
                return AppDefinition.Parse(draft);
            }
            catch (JsonException)
            {
                // An unreadable draft: fall back to what is installed.
            }
        }
        return await registry.GetAsync(appKey, ct);
    }

    /// <summary>Diagnostics for (possibly unsaved) files, without storing anything.</summary>
    public async Task<CompileOutput> CheckAsync(string appKey, IReadOnlyList<SourceFile> files, CancellationToken ct)
    {
        var app = await EditingDefinitionAsync(appKey, ct) ?? throw new InvalidOperationException($"App bulunamadı: {appKey}");
        return await CheckAgainstAsync(app, files, await LibrariesOfAsync(appKey, ct), ct);
    }

    /// <summary>Does this code compile against this definition and these library versions? (Publish, import.)</summary>
    public async Task<CompileOutput> CheckAgainstAsync(AppDefinition app, IReadOnlyList<SourceFile> files, IReadOnlyList<LibraryRef> libraries, CancellationToken ct, IReadOnlyList<byte[]>? extraLibraryImages = null)
    {
        var (refs, missing) = await LibraryReferencesAsync(libraries, ct, extraLibraryImages);
        var output = AppCompiler.Compile(AppAssemblyName(app.Key), Sources(app, files), refs, emit: false);
        return missing.Count == 0 ? output : output with { Success = false, Diagnostics = [.. missing.Select(m => Problem(m)), .. output.Diagnostics] };
    }

    /// <summary>Completion at a position of (possibly unsaved) app files.</summary>
    public async Task<IReadOnlyList<CompletionEntry>> CompleteAsync(string appKey, IReadOnlyList<SourceFile> files, string path, int line, int column, CancellationToken ct)
    {
        var app = await EditingDefinitionAsync(appKey, ct) ?? throw new InvalidOperationException($"App bulunamadı: {appKey}");
        var (refs, _) = await LibraryReferencesAsync(await LibrariesOfAsync(appKey, ct), ct);
        return await CodeCompletion.CompleteAsync([.. Sources(app, files)], path, line, column, refs, ct);
    }

    public static Task<IReadOnlyList<CompletionEntry>> CompleteLibraryAsync(IReadOnlyList<SourceFile> files, string path, int line, int column, CancellationToken ct) =>
        CodeCompletion.CompleteAsync(files, path, line, column, null, ct);

    /// <summary>Compiles the saved workspace; on success stores the build, makes it active and loads it.</summary>
    public async Task<BuildResult> BuildAsync(string appKey, CancellationToken ct)
    {
        var app = await registry.GetAsync(appKey, ct);
        if (app is null) return new(false, null, null, [], ["App henüz yayınlanmadı: önce tanımı yayınlayın."]);
        var files = await FilesAsync(appKey, ct);
        var libraries = await LibrariesOfAsync(appKey, ct);
        var (refs, missing) = await LibraryReferencesAsync(libraries, ct);
        if (missing.Count > 0) return new(false, null, null, [], missing);

        var output = AppCompiler.Compile(AppAssemblyName(appKey), Sources(app, files), refs);
        if (!output.Success)
        {
            // The editor checks against the draft; code written for it may not fit the published version.
            var editing = await EditingDefinitionAsync(appKey, ct);
            if (editing is not null && editing.ToJson() != app.ToJson()
                && AppCompiler.Compile(AppAssemblyName(appKey), Sources(editing, files), refs, emit: false).Success)
                return new(false, null, null, output.Diagnostics,
                    [$"Kod taslaktaki tanıma göre yazılmış; yayındaki v{app.Version} ile derlenmiyor. Derle yayındaki versiyonu derler: taslağı yayınlayın (yayınlama kodu yeni tanımla derleyip etkinleştirir) ya da denemek için Önizle'yi kullanın."]);
            return new(false, null, null, output.Diagnostics, ["Derleme hataları var."]);
        }

        var number = (await db.AppBuilds.Where(b => b.AppKey == appKey).MaxAsync(b => (int?)b.Number, ct) ?? 0) + 1;
        await db.AppBuilds.Where(b => b.AppKey == appKey && b.IsActive).ExecuteUpdateAsync(u => u.SetProperty(b => b.IsActive, false), ct);
        db.AppBuilds.Add(new AppBuild
        {
            AppKey = appKey,
            Number = number,
            AppVersion = app.Version,
            Image = output.Image!,
            Hash = output.Hash!,
            Sources = JsonSerializer.Serialize(files, Json),
            Libraries = JsonSerializer.Serialize(libraries, Json),
            IsActive = true,
            CreatedAt = time.GetUtcNow().UtcDateTime,
            CreatedBy = request.UserId,
        });
        await db.SaveChangesAsync(ct);
        host.Load(appKey, number, app.Version, output.Image!, output.Hash!, await LibraryImagesAsync(libraries, ct));
        log.LogInformation("App {App} build {Number} ({Hash}) is active", appKey, number, output.Hash);
        return new(true, number, output.Hash, output.Diagnostics, []);
    }

    /// <summary>
    /// Compiles the saved workspace against a draft and loads it for the draft's preview. The
    /// assembly is the app's own (same namespace and names), loaded under the preview key; nothing
    /// is stored. A failed compile unloads the preview's code.
    /// </summary>
    public async Task<CompileOutput?> LoadPreviewAsync(AppDefinition draft, CancellationToken ct)
    {
        var previewKey = AppDefinition.PreviewKey(draft.Key);
        var files = await FilesAsync(draft.Key, ct);
        if (files.Count == 0)
        {
            host.Unload(previewKey);
            return null;
        }
        var libraries = await LibrariesOfAsync(draft.Key, ct);
        var (refs, missing) = await LibraryReferencesAsync(libraries, ct);
        var output = missing.Count > 0
            ? new CompileOutput(false, null, null, [.. missing.Select(m => Problem(m))])
            : AppCompiler.Compile(AppAssemblyName(draft.Key), Sources(draft, files), refs);
        if (output.Success) host.Load(previewKey, 0, "preview", output.Image!, output.Hash!, await LibraryImagesAsync(libraries, ct));
        else host.Unload(previewKey);
        return output;
    }

    /// <summary>
    /// The app's metadata changed (a new version was installed): its code is compiled again against
    /// the new entity classes. If that fails, the code is unloaded until it is fixed.
    /// </summary>
    public async Task RebuildAsync(string appKey, CancellationToken ct)
    {
        if (!await db.AppCodeFiles.AnyAsync(f => f.AppKey == appKey, ct)) return;
        var result = await BuildAsync(appKey, ct);
        if (!result.Success)
        {
            host.Unload(appKey);
            log.LogWarning("App {App}: code did not compile against the new version; it is unloaded until fixed", appKey);
        }
    }

    /// <summary>At startup: every app's active build, if it was built for the installed version.</summary>
    public async Task LoadActiveAsync(CancellationToken ct)
    {
        var apps = await registry.AllAsync(ct);
        var builds = await db.AppBuilds.AsNoTracking().Where(b => b.IsActive).ToListAsync(ct);
        foreach (var b in builds)
        {
            if (!apps.TryGetValue(b.AppKey, out var app)) continue;
            if (b.AppVersion != app.Version)
            {
                await RebuildAsync(b.AppKey, ct);
                continue;
            }
            var libraries = JsonSerializer.Deserialize<List<LibraryRef>>(b.Libraries, Json) ?? [];
            host.Load(b.AppKey, b.Number, b.AppVersion, b.Image, b.Hash, await LibraryImagesAsync(libraries, ct));
        }
    }

    static IEnumerable<SourceFile> Sources(AppDefinition app, IEnumerable<SourceFile> files) =>
        [new SourceFile(EntityCodeGenerator.FileName, EntityCodeGenerator.Generate(app)), .. files];

    static CodeDiagnostic Problem(string message) => new("", 1, 1, 1, 1, "error", "BZ0002", message);

    // ── Libraries ──────────────────────────────────────────────────────────

    /// <param name="extraImages">Library images not installed yet (an import being checked).</param>
    async Task<(List<MetadataReference> Refs, List<string> Missing)> LibraryReferencesAsync(IReadOnlyList<LibraryRef> libraries, CancellationToken ct, IReadOnlyList<byte[]>? extraImages = null)
    {
        if (extraImages is { Count: > 0 }) return ([.. extraImages.Select(i => (MetadataReference)MetadataReference.CreateFromImage(i))], []);
        var refs = new List<MetadataReference>();
        var missing = new List<string>();
        foreach (var l in libraries)
        {
            var image = await LibraryImageAsync(l, ct);
            if (image is null) missing.Add($"Kütüphane bulunamadı: {l.Key} {l.Version}");
            else refs.Add(MetadataReference.CreateFromImage(image));
        }
        return (refs, missing);
    }

    async Task<IReadOnlyList<byte[]>> LibraryImagesAsync(IReadOnlyList<LibraryRef> libraries, CancellationToken ct)
    {
        var images = new List<byte[]>();
        foreach (var l in libraries)
            if (await LibraryImageAsync(l, ct) is { } image) images.Add(image);
        return images;
    }

    Task<byte[]?> LibraryImageAsync(LibraryRef l, CancellationToken ct) =>
        (from v in db.CodeLibraryVersions join lib in db.CodeLibraries on v.LibraryId equals lib.Id
         where lib.Key == l.Key && v.Version == l.Version
         select v.Image).FirstOrDefaultAsync(ct);

    public CompileOutput CheckLibrary(string key, IReadOnlyList<SourceFile> files) =>
        AppCompiler.Compile(LibraryAssemblyName(key), files, emit: false);

    /// <summary>A library version from its sources (deterministic: the same sources give the same image and hash).</summary>
    public static CompileOutput CompileLibrary(string key, IReadOnlyList<SourceFile> files) =>
        AppCompiler.Compile(LibraryAssemblyName(key), files);

    /// <summary>The active build of an app: its compiled sources, libraries and hash (export).</summary>
    public async Task<(IReadOnlyList<SourceFile> Files, IReadOnlyList<LibraryRef> Libraries, string Hash, string AppVersion)?> ActiveBuildAsync(string appKey, CancellationToken ct)
    {
        var b = await db.AppBuilds.AsNoTracking().FirstOrDefaultAsync(x => x.AppKey == appKey && x.IsActive, ct);
        if (b is null) return null;
        return (JsonSerializer.Deserialize<List<SourceFile>>(b.Sources, Json) ?? [], JsonSerializer.Deserialize<List<LibraryRef>>(b.Libraries, Json) ?? [], b.Hash, b.AppVersion);
    }

    /// <summary>Compiles the library's saved files as a new (immutable) version.</summary>
    public async Task<BuildResult> PublishLibraryAsync(string key, string version, CancellationToken ct)
    {
        var library = await db.CodeLibraries.FirstOrDefaultAsync(l => l.Key == key, ct);
        if (library is null) return new(false, null, null, [], ["Kütüphane bulunamadı."]);
        if (!System.Text.RegularExpressions.Regex.IsMatch(version ?? "", @"^\d+\.\d+\.\d+$")) return new(false, null, null, [], ["Versiyon 1.0.0 biçiminde olmalı."]);
        var versions = await db.CodeLibraryVersions.Where(v => v.LibraryId == library.Id).Select(v => v.Version).ToListAsync(ct);
        if (versions.Any(v => AppInstaller.CompareVersions(version!, v) <= 0))
            return new(false, null, null, [], [$"Yeni versiyon mevcut versiyonlardan ({string.Join(", ", versions)}) büyük olmalı."]);

        var files = await db.CodeLibraryFiles.AsNoTracking().Where(f => f.LibraryId == library.Id).OrderBy(f => f.Path)
            .Select(f => new SourceFile(f.Path, f.Content)).ToListAsync(ct);
        if (files.Count == 0) return new(false, null, null, [], ["Kütüphanede dosya yok."]);
        var output = AppCompiler.Compile(LibraryAssemblyName(key), files);
        if (!output.Success) return new(false, null, null, output.Diagnostics, ["Derleme hataları var."]);
        db.CodeLibraryVersions.Add(new CodeLibraryVersion
        {
            LibraryId = library.Id,
            Version = version!,
            Sources = JsonSerializer.Serialize(files, Json),
            Image = output.Image!,
            Hash = output.Hash!,
            CreatedAt = time.GetUtcNow().UtcDateTime,
            CreatedBy = request.UserId,
        });
        await db.SaveChangesAsync(ct);
        return new(true, null, output.Hash, output.Diagnostics, []);
    }
}

/// <summary>Loads the active builds when the host starts.</summary>
public sealed class AppCodeLoader(IServiceProvider services, ILogger<AppCodeLoader> log) : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        try
        {
            await using var scope = services.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<CodeBuildService>().LoadActiveAsync(ct);
        }
        catch (Exception e)
        {
            log.LogError(e, "Loading app code failed");
        }
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}

/// <summary>A new app version changes the entity classes: its code is compiled again.</summary>
public sealed class RebuildOnInstall(CodeBuildService builds) : IAppInstallListener
{
    public Task AppInstalledAsync(AppDefinition app, CancellationToken ct) => builds.RebuildAsync(app.Key, ct);
}

public static class CompilerModule
{
    public static IServiceCollection AddCompilerModule(this IServiceCollection services)
    {
        services.AddSingleton<AppCodeHost>();
        services.AddScoped<IAppCode, CompiledAppCode>();
        services.AddScoped<CodeBuildService>();
        services.AddScoped<ActionRunner>();
        services.AddScoped<PreviewService>();
        services.AddScoped<IAppInstallListener, RebuildOnInstall>();
        services.AddHostedService<AppCodeLoader>();
        return services;
    }
}
