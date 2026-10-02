using System.Text.Json;
using Bazlama.Compiler;
using Bazlama.Engine;
using Bazlama.Engine.Metadata;
using Bazlama.Kernel;
using Bazlama.Kernel.Code;
using Bazlama.Kernel.Data;
using Microsoft.EntityFrameworkCore;

namespace Bazlama.Packaging;

public sealed record LibraryStatus(string Key, string Version, string Status);
public sealed record CodeStatus(int FileCount, bool Success, IReadOnlyList<CodeDiagnostic> Diagnostics);

/// <summary>What importing a package would do; <see cref="Errors"/> (and the plan's) block it.</summary>
public sealed record ImportPreview(PackageManifest? Manifest, InstallPlan? Plan, IReadOnlyList<LibraryStatus> Libraries, CodeStatus? Code, IReadOnlyList<string> Errors)
{
    public bool CanImport => Errors.Count == 0 && Plan is { Errors.Count: 0 } && Code is null or { Success: true };
}

public sealed record ImportResult(bool Imported, ImportPreview Preview, string? BuildHash, bool? HashMatches);

/// <summary>Exports an installed app as a .bzapp and imports one (another installation, Test, Production).</summary>
public sealed class PackageService(
    KernelDbContext db,
    AppInstaller installer,
    CodeBuildService builds,
    PlatformInfo platform,
    IRequestContext request,
    TimeProvider time)
{
    static readonly string SdkVersion = typeof(Sdk.Record).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    // ── Export ─────────────────────────────────────────────────────────────

    /// <summary>The installed version with the code it runs (its active build) and the libraries of that build.</summary>
    public async Task<(byte[]? Bytes, string? FileName, string? Error)> ExportAsync(string appKey, CancellationToken ct)
    {
        var row = await db.Apps.AsNoTracking().FirstOrDefaultAsync(a => a.Key == appKey, ct);
        if (row is null) return (null, null, "Uygulama kurulu değil.");
        var build = await builds.ActiveBuildAsync(appKey, ct);
        var hasCode = await db.AppCodeFiles.AnyAsync(f => f.AppKey == appKey, ct);
        if (hasCode && (build is null || build.Value.AppVersion != row.Version))
            return (null, null, "Uygulamanın kodu bu versiyon için derlenmemiş: önce Geliştirme'de derleyin.");

        var libraries = new List<LibrarySource>();
        foreach (var l in build?.Libraries ?? [])
        {
            var v = await (from version in db.CodeLibraryVersions join lib in db.CodeLibraries on version.LibraryId equals lib.Id
                           where lib.Key == l.Key && version.Version == l.Version
                           select new { lib.Name, lib.Description, version.Sources, version.Hash }).FirstAsync(ct);
            libraries.Add(new LibrarySource(l.Key, v.Name, v.Description, l.Version, v.Hash, JsonSerializer.Deserialize<List<SourceFile>>(v.Sources, JsonSerializerOptions.Web) ?? []));
        }

        var manifest = new PackageManifest
        {
            Key = row.Key,
            Name = row.Name,
            Version = row.Version,
            PlatformVersion = platform.Version,
            SdkVersion = SdkVersion,
            ExportedAt = time.GetUtcNow().UtcDateTime,
            ExportedBy = request.UserName,
            BuildHash = build?.Hash,
            Libraries = [.. libraries.Select(l => new PackagedLibrary(l.Key, l.Version, l.Hash))],
        };
        var bytes = PackageFormat.Write(new AppPackage(manifest, row.Metadata, build?.Files ?? [], libraries));
        return (bytes, $"{row.Key}-{row.Version}{PackageFormat.Extension}", null);
    }

    // ── Import ─────────────────────────────────────────────────────────────

    sealed record Prepared(AppPackage Package, AppDefinition Definition, ImportPreview Preview, IReadOnlyList<(LibrarySource Source, byte[] Image)> NewLibraries);

    public async Task<ImportPreview> PreviewAsync(byte[] bytes, CancellationToken ct) => (await PrepareAsync(bytes, ct)).Preview;

    async Task<Prepared> PrepareAsync(byte[] bytes, CancellationToken ct)
    {
        var (package, readErrors) = PackageFormat.Read(bytes);
        if (package is null) return Fail(null, readErrors);
        var m = package.Manifest;
        var errors = new List<string>();
        if (Major(m.PlatformVersion) > Major(platform.Version))
            errors.Add($"Paket daha yeni bir platform sürümünden ({m.PlatformVersion}); bu kurulum {platform.Version}.");
        if (Major(m.SdkVersion) != Major(SdkVersion))
            errors.Add($"Paketin SDK sürümü ({m.SdkVersion}) bu kurulumunkiyle ({SdkVersion}) uyumsuz.");

        AppDefinition definition;
        try
        {
            definition = AppDefinition.Parse(package.Definition);
        }
        catch (JsonException e)
        {
            return Fail(m, [$"Uygulama tanımı okunamadı: {e.Message}"]);
        }
        if (definition.Key != m.Key || definition.Version != m.Version) errors.Add("Manifest ile uygulama tanımı uyuşmuyor (anahtar/versiyon).");

        // Libraries: an installed version must be the same build; a new one must compile to the packaged hash.
        var statuses = new List<LibraryStatus>();
        var newLibraries = new List<(LibrarySource, byte[])>();
        var images = new List<byte[]>();
        foreach (var l in package.Libraries)
        {
            var installed = await (from v in db.CodeLibraryVersions join lib in db.CodeLibraries on v.LibraryId equals lib.Id
                                   where lib.Key == l.Key && v.Version == l.Version
                                   select new { v.Hash, v.Image }).FirstOrDefaultAsync(ct);
            if (installed is not null)
            {
                if (!string.Equals(installed.Hash, l.Hash, StringComparison.OrdinalIgnoreCase))
                {
                    statuses.Add(new(l.Key, l.Version, "conflict"));
                    errors.Add($"Kütüphane {l.Key} {l.Version} bu kurulumda farklı içerikle var.");
                }
                else statuses.Add(new(l.Key, l.Version, "installed"));
                images.Add(installed.Image);
                continue;
            }
            var compiled = CodeBuildService.CompileLibrary(l.Key, l.Files);
            if (!compiled.Success || !string.Equals(compiled.Hash, l.Hash, StringComparison.OrdinalIgnoreCase))
            {
                statuses.Add(new(l.Key, l.Version, "conflict"));
                errors.Add($"Kütüphane {l.Key} {l.Version} derlenemedi ya da paketteki özetle aynı sonucu vermedi.");
                continue;
            }
            statuses.Add(new(l.Key, l.Version, "new"));
            newLibraries.Add((l, compiled.Image!));
            images.Add(compiled.Image!);
        }

        var plan = await installer.PlanAsync(definition, ct);
        CodeStatus? code = null;
        if (package.Code.Count > 0)
        {
            var check = await builds.CheckAgainstAsync(definition, package.Code, [.. package.Libraries.Select(l => new LibraryRef(l.Key, l.Version))], ct, images);
            code = new CodeStatus(package.Code.Count, check.Success, check.Diagnostics);
        }
        return new Prepared(package, definition, new ImportPreview(m, plan, statuses, code, errors), newLibraries);
    }

    static Prepared Fail(PackageManifest? m, IReadOnlyList<string> errors) =>
        new(null!, null!, new ImportPreview(m, null, [], null, errors), []);

    /// <summary>
    /// Installs the package: new library versions, the app's code into its workspace, the app
    /// version (schema change); the code is then compiled here and its hash compared with the
    /// exporting side's.
    /// </summary>
    public async Task<ImportResult> ImportAsync(byte[] bytes, bool confirmDestructive, CancellationToken ct)
    {
        var p = await PrepareAsync(bytes, ct);
        if (!p.Preview.CanImport || (p.Preview.Plan!.HasDestructive && !confirmDestructive)) return new(false, p.Preview, null, null);

        var now = time.GetUtcNow().UtcDateTime;
        foreach (var (source, image) in p.NewLibraries)
        {
            var library = await db.CodeLibraries.FirstOrDefaultAsync(l => l.Key == source.Key, ct);
            if (library is null) db.CodeLibraries.Add(library = new CodeLibrary { Key = source.Key, Name = source.Name, Description = source.Description });
            db.CodeLibraryVersions.Add(new CodeLibraryVersion
            {
                LibraryId = library.Id,
                Version = source.Version,
                Sources = JsonSerializer.Serialize(source.Files, JsonSerializerOptions.Web),
                Image = image,
                Hash = source.Hash,
                CreatedAt = now,
                CreatedBy = request.UserId,
            });
        }

        // The workspace becomes the package's code (what the build after the install compiles).
        var key = p.Definition.Key;
        await db.AppCodeFiles.Where(f => f.AppKey == key).ExecuteDeleteAsync(ct);
        db.AppCodeFiles.AddRange(p.Package.Code.Select(f => new AppCodeFile { AppKey = key, Path = f.Path, Content = f.Content, UpdatedAt = now, UpdatedBy = request.UserId }));
        var workspace = await db.AppWorkspaces.FirstOrDefaultAsync(w => w.AppKey == key, ct);
        if (workspace is null) db.AppWorkspaces.Add(workspace = new AppWorkspace { AppKey = key });
        workspace.Libraries = JsonSerializer.Serialize(p.Package.Libraries.Select(l => new LibraryRef(l.Key, l.Version)), JsonSerializerOptions.Web);
        await db.AppDrafts.Where(d => d.AppKey == key).ExecuteDeleteAsync(ct);
        await db.SaveChangesAsync(ct);

        var installed = await installer.InstallAsync(p.Definition, confirmDestructive, ct); // the install listener compiles the code
        if (!installed.Installed) return new(false, p.Preview with { Plan = installed.Plan }, null, null);
        if (p.Package.Code.Count == 0) return new(true, p.Preview, null, null);
        var build = await builds.ActiveBuildAsync(key, ct);
        var hash = build is { } b && b.AppVersion == p.Definition.Version ? b.Hash : null;
        return new(true, p.Preview, hash, hash is null ? null : string.Equals(hash, p.Package.Manifest.BuildHash, StringComparison.OrdinalIgnoreCase));
    }

    static int Major(string version) => int.TryParse(version.Split('.')[0], out var n) ? n : 0;
}
