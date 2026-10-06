using System.Collections.Concurrent;
using System.IO.Compression;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Net.Http.Headers;

namespace Bazlama.Host;

/// <summary>
/// Serves the web UI's files under /assets compressed (Brotli or gzip), compressing each file
/// once and keeping the result in memory. Their names carry a content hash, so a file never
/// changes and the browser may keep it for good. Without the cache the server would compress
/// the 3.9 MB code editor again for every new browser.
/// </summary>
sealed class AssetCompression(RequestDelegate next, IWebHostEnvironment environment)
{
    public const string Prefix = "/assets";
    public const string Forever = "public, max-age=31536000, immutable";

    static readonly HashSet<string> Compressible = new(StringComparer.OrdinalIgnoreCase) { ".js", ".css", ".svg", ".json", ".map", ".ttf", ".html", ".txt" };
    static readonly FileExtensionContentTypeProvider ContentTypes = new();

    sealed record Compressed(byte[] Bytes, DateTimeOffset Modified, long Length);
    readonly ConcurrentDictionary<(string Path, string Encoding), Lazy<Task<Compressed>>> cache = new();

    public async Task InvokeAsync(HttpContext context)
    {
        var request = context.Request;
        if (!(HttpMethods.IsGet(request.Method) || HttpMethods.IsHead(request.Method))
            || !request.Path.StartsWithSegments(Prefix)
            || !Compressible.Contains(Path.GetExtension(request.Path.Value!))
            || Encoding(request) is not { } encoding)
        {
            await next(context);
            return;
        }
        var file = environment.WebRootFileProvider.GetFileInfo(request.Path.Value!);
        if (!file.Exists || file.IsDirectory || file.Length < 1024)
        {
            await next(context);
            return;
        }

        var key = (request.Path.Value!, encoding);
        var entry = await cache.GetOrAdd(key, _ => new(() => CompressAsync(file, encoding))).Value;
        if (entry.Modified != file.LastModified || entry.Length != file.Length)
        {
            // Replaced on disk (a new build with the same name): compress it again.
            cache[key] = new(() => CompressAsync(file, encoding));
            entry = await cache[key].Value;
        }

        var response = context.Response;
        var etag = $"\"{entry.Modified.ToUnixTimeSeconds():x}-{entry.Length:x}-{encoding}\"";
        response.Headers.ETag = etag;
        response.Headers.CacheControl = Forever;
        response.Headers.Vary = HeaderNames.AcceptEncoding;
        if (request.Headers.IfNoneMatch.ToString().Contains(etag, StringComparison.Ordinal))
        {
            response.StatusCode = StatusCodes.Status304NotModified;
            return;
        }
        response.ContentType = ContentTypes.TryGetContentType(file.Name, out var type) ? type : "application/octet-stream";
        response.Headers.ContentEncoding = encoding;
        response.ContentLength = entry.Bytes.Length;
        if (!HttpMethods.IsHead(request.Method)) await response.Body.WriteAsync(entry.Bytes, context.RequestAborted);
    }

    /// <summary>"br" when the browser takes it, else "gzip", else null.</summary>
    static string? Encoding(HttpRequest request)
    {
        var accepted = request.Headers.AcceptEncoding.ToString();
        return accepted.Contains("br", StringComparison.OrdinalIgnoreCase) ? "br"
            : accepted.Contains("gzip", StringComparison.OrdinalIgnoreCase) ? "gzip"
            : null;
    }

    static async Task<Compressed> CompressAsync(Microsoft.Extensions.FileProviders.IFileInfo file, string encoding)
    {
        using var output = new MemoryStream();
        await using (var source = file.CreateReadStream())
        await using (Stream compressor = encoding == "br"
            ? new BrotliStream(output, CompressionLevel.Optimal, leaveOpen: true)
            : new GZipStream(output, CompressionLevel.Optimal, leaveOpen: true))
            await source.CopyToAsync(compressor);
        return new Compressed(output.ToArray(), file.LastModified, file.Length);
    }
}
