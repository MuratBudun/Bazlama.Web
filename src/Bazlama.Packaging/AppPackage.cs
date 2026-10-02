using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Bazlama.Compiler;

namespace Bazlama.Packaging;

public sealed record PackagedLibrary(string Key, string Version, string Hash);

/// <summary>manifest.json of a .bzapp file.</summary>
public sealed record PackageManifest
{
    public int Format { get; init; } = 1;
    public required string Key { get; init; }
    public required string Name { get; init; }
    public required string Version { get; init; }
    /// <summary>The platform that exported it; an import refuses a newer major version.</summary>
    public required string PlatformVersion { get; init; }
    /// <summary>The SDK the code was compiled against.</summary>
    public required string SdkVersion { get; init; }
    public DateTime ExportedAt { get; init; }
    public string? ExportedBy { get; init; }
    /// <summary>SHA-256 of the compiled app code (deterministic: the importing side must get the same).</summary>
    public string? BuildHash { get; init; }
    public IReadOnlyList<PackagedLibrary> Libraries { get; init; } = [];
    /// <summary>Path in the package → SHA-256 of its content.</summary>
    public IReadOnlyDictionary<string, string> Files { get; init; } = new Dictionary<string, string>();
}

public sealed record LibrarySource(string Key, string Name, string? Description, string Version, string Hash, IReadOnlyList<SourceFile> Files);

/// <summary>The content of a .bzapp: the app definition, its code and the code libraries it uses.</summary>
public sealed record AppPackage(PackageManifest Manifest, string Definition, IReadOnlyList<SourceFile> Code, IReadOnlyList<LibrarySource> Libraries);

/// <summary>
/// The .bzapp file: a zip of manifest.json, metadata/app.json, code/… and libs/&lt;key&gt;/&lt;version&gt;/….
/// Every file's SHA-256 is in the manifest; a changed or missing file makes the package invalid.
/// </summary>
public static class PackageFormat
{
    public const string Extension = ".bzapp";
    const string ManifestPath = "manifest.json";
    const string DefinitionPath = "metadata/app.json";

    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static string Sha256(string content) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content)));

    public static byte[] Write(AppPackage package)
    {
        var entries = new Dictionary<string, string> { [DefinitionPath] = package.Definition };
        foreach (var f in package.Code) entries[$"code/{f.Path}"] = f.Content;
        foreach (var l in package.Libraries)
        {
            entries[$"libs/{l.Key}/{l.Version}/library.json"] = JsonSerializer.Serialize(new { l.Key, l.Name, l.Description }, Json);
            foreach (var f in l.Files) entries[$"libs/{l.Key}/{l.Version}/src/{f.Path}"] = f.Content;
        }
        var manifest = package.Manifest with { Files = entries.ToDictionary(e => e.Key, e => Sha256(e.Value)) };

        using var stream = new MemoryStream();
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            Add(zip, ManifestPath, JsonSerializer.Serialize(manifest, Json));
            foreach (var (path, content) in entries.OrderBy(e => e.Key, StringComparer.Ordinal)) Add(zip, path, content);
        }
        return stream.ToArray();
    }

    static void Add(ZipArchive zip, string path, string content)
    {
        // A fixed time keeps the bytes of the same package the same.
        var entry = zip.CreateEntry(path, CompressionLevel.Optimal);
        entry.LastWriteTime = new DateTimeOffset(2000, 1, 1, 0, 0, 0, TimeSpan.Zero);
        using var writer = new StreamWriter(entry.Open(), new UTF8Encoding(false));
        writer.Write(content);
    }

    /// <summary>Reads and verifies a package; errors are for the user (Turkish).</summary>
    public static (AppPackage? Package, IReadOnlyList<string> Errors) Read(byte[] bytes)
    {
        var errors = new List<string>();
        Dictionary<string, string> files;
        try
        {
            using var zip = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read);
            if (zip.Entries.Count > 2000) return (null, ["Paket çok fazla dosya içeriyor."]);
            files = [];
            foreach (var e in zip.Entries.Where(e => !e.FullName.EndsWith('/')))
            {
                if (e.Length > 5_000_000) return (null, [$"Paketteki dosya çok büyük: {e.FullName}"]);
                using var reader = new StreamReader(e.Open(), Encoding.UTF8);
                files[e.FullName.Replace('\\', '/')] = reader.ReadToEnd();
            }
        }
        catch (InvalidDataException)
        {
            return (null, ["Dosya bir .bzapp paketi değil (zip okunamadı)."]);
        }

        if (!files.TryGetValue(ManifestPath, out var manifestJson)) return (null, ["Pakette manifest.json yok."]);
        PackageManifest manifest;
        try
        {
            manifest = JsonSerializer.Deserialize<PackageManifest>(manifestJson, Json) ?? throw new JsonException();
        }
        catch (JsonException)
        {
            return (null, ["manifest.json okunamadı."]);
        }
        if (manifest.Format != 1) return (null, [$"Paket biçimi desteklenmiyor: {manifest.Format}"]);

        foreach (var (path, hash) in manifest.Files)
        {
            if (!files.TryGetValue(path, out var content)) errors.Add($"Paketten dosya eksik: {path}");
            else if (!string.Equals(Sha256(content), hash, StringComparison.OrdinalIgnoreCase)) errors.Add($"Dosya değiştirilmiş (özet tutmuyor): {path}");
        }
        foreach (var extra in files.Keys.Where(p => p != ManifestPath && !manifest.Files.ContainsKey(p))) errors.Add($"Manifest'te olmayan dosya: {extra}");
        if (!files.ContainsKey(DefinitionPath)) errors.Add("Pakette uygulama tanımı (metadata/app.json) yok.");
        if (errors.Count > 0) return (null, errors);

        var code = files.Where(f => f.Key.StartsWith("code/", StringComparison.Ordinal))
            .Select(f => new SourceFile(f.Key["code/".Length..], f.Value)).OrderBy(f => f.Path, StringComparer.Ordinal).ToList();
        var libraries = new List<LibrarySource>();
        foreach (var l in manifest.Libraries)
        {
            var prefix = $"libs/{l.Key}/{l.Version}/";
            if (!files.TryGetValue(prefix + "library.json", out var info)) return (null, [$"Kütüphane bilgisi eksik: {l.Key} {l.Version}"]);
            var meta = JsonSerializer.Deserialize<LibraryInfo>(info, Json)!;
            var sources = files.Where(f => f.Key.StartsWith(prefix + "src/", StringComparison.Ordinal))
                .Select(f => new SourceFile(f.Key[(prefix.Length + 4)..], f.Value)).OrderBy(f => f.Path, StringComparer.Ordinal).ToList();
            libraries.Add(new LibrarySource(l.Key, meta.Name, meta.Description, l.Version, l.Hash, sources));
        }
        return (new AppPackage(manifest, files[DefinitionPath], code, libraries), []);
    }

    sealed record LibraryInfo(string Key, string Name, string? Description);
}
