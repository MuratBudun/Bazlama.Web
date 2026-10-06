using System.Security.Cryptography;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Bazlama.Compiler;

public sealed record SourceFile(string Path, string Content);

/// <summary>A compiler message, positioned for the editor (1-based lines and columns).</summary>
public sealed record CodeDiagnostic(string Path, int Line, int Column, int EndLine, int EndColumn, string Severity, string Code, string Message);

public sealed record CompileOutput(bool Success, byte[]? Image, string? Hash, IReadOnlyList<CodeDiagnostic> Diagnostics);

/// <summary>
/// Compiles app and library code with Roslyn: deterministic (the same sources give the same
/// bytes and hash), against a fixed set of references (the BCL basics and Bazlama.Sdk), and with
/// a check that refuses APIs app code must not reach (files, network, processes, reflection…).
/// .NET has no sandbox: this is a guard rail for trusted developers, not isolation.
/// </summary>
public static class AppCompiler
{
    static readonly string[] Allowed =
    [
        "System.Private.CoreLib", "System.Runtime", "netstandard", "System.Collections", "System.Linq",
        "System.Text.RegularExpressions", "System.Memory", "System.Runtime.Numerics", "System.ComponentModel.Annotations",
    ];

    /// <summary>What every compilation references (also used for completion).</summary>
    public static IReadOnlyList<MetadataReference> References => BaseReferences.Value;

    /// <summary>The options of every compilation (also used for completion).</summary>
    public static CSharpCompilationOptions Options { get; } = new(
        OutputKind.DynamicallyLinkedLibrary,
        optimizationLevel: OptimizationLevel.Release,
        nullableContextOptions: NullableContextOptions.Enable,
        allowUnsafe: false,
        deterministic: true);

    static readonly Lazy<IReadOnlyList<MetadataReference>> BaseReferences = new(() =>
    {
        var trusted = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator);
        var refs = trusted
            .Where(p => Allowed.Contains(Path.GetFileNameWithoutExtension(p), StringComparer.OrdinalIgnoreCase))
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();
        refs.Add(MetadataReference.CreateFromFile(typeof(Bazlama.Sdk.Record).Assembly.Location));
        return refs;
    });

    /// <summary>Namespaces app code cannot use (with the exceptions it may).</summary>
    static readonly string[] ForbiddenNamespaces =
    [
        "System.IO", "System.Net", "System.Reflection", "System.Runtime.InteropServices", "System.Runtime.Loader",
        "System.Diagnostics", "System.Security", "System.Resources", "System.Runtime.Serialization", "Microsoft.Win32",
        "System.Threading",
    ];
    static readonly string[] AllowedNamespaces = ["System.Diagnostics.CodeAnalysis", "System.Threading.Tasks"];
    static readonly HashSet<string> AllowedTypes = ["System.Threading.CancellationToken", "System.Threading.CancellationTokenSource", "System.Threading.Interlocked"];
    static readonly HashSet<string> ForbiddenTypes =
    [
        "System.Environment", "System.AppDomain", "System.Activator", "System.GC", "System.Type", "System.Console",
        "System.Runtime.CompilerServices.RuntimeHelpers", "System.Runtime.CompilerServices.Unsafe",
    ];

    /// <param name="check">More checks on the compilation (an app's code against its definition).</param>
    public static CompileOutput Compile(string assemblyName, IEnumerable<SourceFile> sources, IEnumerable<MetadataReference>? references = null, bool emit = true,
        Func<CSharpCompilation, IEnumerable<CodeDiagnostic>>? check = null)
    {
        var parse = new CSharpParseOptions(LanguageVersion.Latest);
        var trees = sources.Select(s => CSharpSyntaxTree.ParseText(s.Content, parse, path: s.Path)).ToList();
        var compilation = CSharpCompilation.Create(
            assemblyName,
            trees,
            BaseReferences.Value.Concat(references ?? []),
            Options);

        var diagnostics = compilation.GetDiagnostics()
            .Where(d => d.Severity >= DiagnosticSeverity.Warning)
            .Select(ToDiagnostic)
            .ToList();
        diagnostics.AddRange(ForbiddenApis(compilation, trees));
        if (check is not null) diagnostics.AddRange(check(compilation));

        var failed = diagnostics.Any(d => d.Severity == "error");
        if (failed || !emit) return new CompileOutput(!failed, null, null, Sort(diagnostics));

        using var stream = new MemoryStream();
        var result = compilation.Emit(stream);
        if (!result.Success)
        {
            diagnostics.AddRange(result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Select(ToDiagnostic));
            return new CompileOutput(false, null, null, Sort(diagnostics));
        }
        var image = stream.ToArray();
        return new CompileOutput(true, image, Convert.ToHexString(SHA256.HashData(image)), Sort(diagnostics));
    }

    static IReadOnlyList<CodeDiagnostic> Sort(List<CodeDiagnostic> list) =>
        [.. list.DistinctBy(d => (d.Path, d.Line, d.Column, d.Code, d.Message)).OrderBy(d => d.Path).ThenBy(d => d.Line).ThenBy(d => d.Column)];

    static CodeDiagnostic ToDiagnostic(Diagnostic d)
    {
        var span = d.Location.GetMappedLineSpan();
        return new CodeDiagnostic(
            span.Path ?? "",
            span.StartLinePosition.Line + 1, span.StartLinePosition.Character + 1,
            span.EndLinePosition.Line + 1, span.EndLinePosition.Character + 1,
            d.Severity == DiagnosticSeverity.Error ? "error" : "warning",
            d.Id,
            d.GetMessage(System.Globalization.CultureInfo.InvariantCulture));
    }

    /// <summary>Every name the code mentions is resolved; forbidden namespaces and types are errors (BZ0001).</summary>
    static IEnumerable<CodeDiagnostic> ForbiddenApis(CSharpCompilation compilation, IEnumerable<SyntaxTree> trees)
    {
        // One error per forbidden type and line ("File.ReadAllText" names File twice).
        var reported = new HashSet<(string, int, string)>();
        foreach (var tree in trees)
        {
            var model = compilation.GetSemanticModel(tree);
            foreach (var node in tree.GetRoot().DescendantNodes().OfType<SimpleNameSyntax>())
            {
                // Using directives only bring names into scope; their uses are checked where they are used.
                if (node.Ancestors().Any(a => a is UsingDirectiveSyntax)) continue;
                var info = model.GetSymbolInfo(node);
                var symbol = info.Symbol ?? info.CandidateSymbols.FirstOrDefault();
                if (symbol is null || Forbidden(symbol) is not { } name) continue;
                var span = node.GetLocation().GetMappedLineSpan();
                if (!reported.Add((span.Path, span.StartLinePosition.Line, name))) continue;
                yield return new CodeDiagnostic(span.Path, span.StartLinePosition.Line + 1, span.StartLinePosition.Character + 1,
                    span.EndLinePosition.Line + 1, span.EndLinePosition.Character + 1, "error", "BZ0001",
                    $"'{name}' app kodunda kullanılamaz (dosya, ağ, işlem, reflection gibi sistem API'leri kapalıdır).");
            }
        }
    }

    static string? Forbidden(ISymbol symbol)
    {
        var type = symbol switch
        {
            ITypeSymbol t => t,
            IMethodSymbol { MethodKind: MethodKind.Constructor } m => m.ContainingType,
            _ => symbol.ContainingType,
        };
        if (symbol is INamespaceSymbol ns) return null; // namespaces alone do nothing
        if (type is null) return null;
        while (type is IArrayTypeSymbol array) type = array.ElementType;
        var full = type.OriginalDefinition.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat).Replace("global::", "");
        if (full.Contains('<')) full = full[..full.IndexOf('<')];
        if (ForbiddenTypes.Contains(full)) return full;
        if (AllowedTypes.Contains(full)) return null;
        var nsName = type.ContainingNamespace?.ToDisplayString() ?? "";
        if (AllowedNamespaces.Any(a => nsName == a || nsName.StartsWith(a + ".", StringComparison.Ordinal))) return null;
        return ForbiddenNamespaces.Any(f => nsName == f || nsName.StartsWith(f + ".", StringComparison.Ordinal)) ? full : null;
    }
}
