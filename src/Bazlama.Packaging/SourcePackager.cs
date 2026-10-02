using System.Text.Json;
using Bazlama.Compiler;
using Bazlama.Engine.Metadata;

namespace Bazlama.Packaging;

/// <summary>
/// Packs an app kept as source files (e.g. in source control) into a .bzapp, without a database:
/// <code>
/// app.json                          the definition (its version is the package's)
/// code/**/*.cs                      the app's code
/// libs/&lt;key&gt;/&lt;version&gt;/library.json   { "name": …, "description": … }
/// libs/&lt;key&gt;/&lt;version&gt;/src/**/*.cs     a code library version the code uses
/// </code>
/// Libraries and code are compiled here (deterministically), so the package carries the same
/// hashes an installation gets when it compiles them again on import.
/// </summary>
public static class SourcePackager
{
    sealed record LibraryInfo(string? Name, string? Description);

    public static (byte[]? Bytes, string? FileName, IReadOnlyList<string> Errors) Pack(string folder, string platformVersion, DateTime now, string? by = null)
    {
        var errors = new List<string>();
        var definitionPath = Path.Combine(folder, "app.json");
        if (!File.Exists(definitionPath)) return (null, null, [$"Klasörde app.json yok: {folder}"]);

        AppDefinition app;
        try
        {
            app = AppDefinition.Parse(AppDefinition.Upgrade(File.ReadAllText(definitionPath)));
        }
        catch (JsonException e)
        {
            return (null, null, [$"app.json okunamadı: {e.Message}"]);
        }
        errors.AddRange(MetadataValidator.Validate(app));

        // Libraries, in key order (the order the code is compiled with on import).
        var libraries = new List<(LibrarySource Source, byte[] Image)>();
        var libsDir = Path.Combine(folder, "libs");
        if (Directory.Exists(libsDir))
        {
            foreach (var keyDir in Directory.GetDirectories(libsDir).OrderBy(d => d, StringComparer.Ordinal))
            {
                var key = Path.GetFileName(keyDir);
                var versions = Directory.GetDirectories(keyDir);
                if (versions.Length != 1)
                {
                    errors.Add($"Kütüphane {key}: tek bir versiyon klasörü olmalı (libs/{key}/<versiyon>).");
                    continue;
                }
                var version = Path.GetFileName(versions[0]);
                var infoPath = Path.Combine(versions[0], "library.json");
                var info = File.Exists(infoPath) ? JsonSerializer.Deserialize<LibraryInfo>(File.ReadAllText(infoPath), JsonSerializerOptions.Web) : null;
                var files = SourceFiles(Path.Combine(versions[0], "src"));
                var compiled = CodeBuildService.CompileLibrary(key, files);
                if (!compiled.Success)
                {
                    errors.AddRange(compiled.Diagnostics.Where(d => d.Severity == "error").Select(d => $"libs/{key}/{version}/src/{d.Path}:{d.Line}: {d.Message}"));
                    continue;
                }
                libraries.Add((new LibrarySource(key, info?.Name ?? key, info?.Description, version, compiled.Hash!, files), compiled.Image!));
            }
        }

        var code = SourceFiles(Path.Combine(folder, "code"));
        string? buildHash = null;
        if (code.Count > 0 && errors.Count == 0)
        {
            var compiled = CodeBuildService.CompileApp(app, code, libraries.Select(l => l.Image));
            if (compiled.Success) buildHash = compiled.Hash;
            else errors.AddRange(compiled.Diagnostics.Where(d => d.Severity == "error").Select(d => $"code/{d.Path}:{d.Line}: {d.Message}"));
        }
        if (errors.Count > 0) return (null, null, errors);

        var manifest = new PackageManifest
        {
            Key = app.Key,
            Name = app.Name,
            Version = app.Version,
            PlatformVersion = platformVersion,
            SdkVersion = PackageService.SdkVersion,
            ExportedAt = now,
            ExportedBy = by,
            BuildHash = buildHash,
            Libraries = [.. libraries.Select(l => new PackagedLibrary(l.Source.Key, l.Source.Version, l.Source.Hash))],
        };
        var bytes = PackageFormat.Write(new AppPackage(manifest, app.ToJson(), code, [.. libraries.Select(l => l.Source)]));
        return (bytes, $"{app.Key}-{app.Version}{PackageFormat.Extension}", []);
    }

    /// <summary>The .cs files under a folder, with paths relative to it ("/" separated), in a stable order.</summary>
    static List<SourceFile> SourceFiles(string dir) =>
        !Directory.Exists(dir)
            ? []
            : [.. Directory.EnumerateFiles(dir, "*.cs", SearchOption.AllDirectories)
                .Select(f => new SourceFile(Path.GetRelativePath(dir, f).Replace('\\', '/'), File.ReadAllText(f).Replace("\r\n", "\n")))
                .OrderBy(f => f.Path, StringComparer.Ordinal)];
}
