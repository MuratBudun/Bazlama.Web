using Bazlama.Engine.Metadata;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Bazlama.Compiler;

/// <summary>
/// The app's code against its definition (BZ0003): every form class belongs to a form of the app
/// and takes that form's entity, and every tool of a form's menu has its method. Found while
/// compiling, so a broken menu item cannot be published.
/// </summary>
static class FormCodeCheck
{
    const string Code = "BZ0003";

    /// <summary>
    /// The forms' code classes as the designer needs them: where each class is, where it ends
    /// (a new method goes in before that), and the methods a tool may call.
    /// </summary>
    public static IReadOnlyList<FormCodeOutline> Outline(CSharpCompilation compilation, AppDefinition app)
    {
        var formAttribute = compilation.GetTypeByMetadataName("Bazlama.Sdk.FormAttribute");
        var formCode = compilation.GetTypeByMetadataName("Bazlama.Sdk.FormCode`1");
        var context = compilation.GetTypeByMetadataName("Bazlama.Sdk.IAppContext");
        var result = new List<FormCodeOutline>();
        if (formAttribute is null || formCode is null || context is null) return result;

        foreach (var type in compilation.GetSymbolsWithName(_ => true, SymbolFilter.Type).OfType<INamedTypeSymbol>())
        {
            var key = type.GetAttributes().FirstOrDefault(a => SymbolEqualityComparer.Default.Equals(a.AttributeClass, formAttribute))?.ConstructorArguments.FirstOrDefault().Value as string;
            if (key is null || app.Form(key) is null || result.Any(r => r.Form == key) || Record(type, formCode) is not { } record) continue;
            if (type.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() is not TypeDeclarationSyntax declaration) continue;
            var at = declaration.Identifier.GetLocation().GetLineSpan();
            var end = declaration.CloseBraceToken.GetLocation().GetLineSpan().StartLinePosition;
            var methods = type.GetMembers().OfType<IMethodSymbol>()
                .Where(m => m is { MethodKind: MethodKind.Ordinary, DeclaredAccessibility: Accessibility.Public, IsStatic: false, Parameters: [var first, var second] }
                    && compilation.ClassifyConversion(record, first.Type).IsImplicit
                    && SymbolEqualityComparer.Default.Equals(second.Type, context))
                .Select(m => (Method: m, Span: m.Locations[0].GetLineSpan()))
                // A partial class may be spread over files: a method says where it is itself.
                .Select(x => new FormMethod(x.Method.Name, x.Span.Path, x.Span.StartLinePosition.Line + 1, x.Span.StartLinePosition.Character + 1))
                .OrderBy(m => m.Path == at.Path ? 0 : 1).ThenBy(m => m.Line)
                .ToList();
            result.Add(new FormCodeOutline(key, type.Name, record.Name, at.Path, at.StartLinePosition.Line + 1, at.StartLinePosition.Character + 1, end.Line + 1, end.Character + 1, methods));
        }
        return result;
    }

    public static IEnumerable<CodeDiagnostic> Run(CSharpCompilation compilation, AppDefinition app)
    {
        var formAttribute = compilation.GetTypeByMetadataName("Bazlama.Sdk.FormAttribute");
        var entityAttribute = compilation.GetTypeByMetadataName("Bazlama.Sdk.EntityAttribute");
        var formCode = compilation.GetTypeByMetadataName("Bazlama.Sdk.FormCode`1");
        var context = compilation.GetTypeByMetadataName("Bazlama.Sdk.IAppContext");
        if (formAttribute is null || entityAttribute is null || formCode is null || context is null) yield break;

        var classes = new Dictionary<string, INamedTypeSymbol>();
        foreach (var type in compilation.GetSymbolsWithName(_ => true, SymbolFilter.Type).OfType<INamedTypeSymbol>())
        {
            var key = type.GetAttributes().FirstOrDefault(a => SymbolEqualityComparer.Default.Equals(a.AttributeClass, formAttribute))?.ConstructorArguments.FirstOrDefault().Value as string;
            if (key is null) continue;
            var form = app.Form(key);
            var record = Record(type, formCode);
            if (form is null) yield return At(type, $"[Form(\"{key}\")]: uygulamada bu anahtarla bir form yok.");
            else if (record is null) yield return At(type, $"{type.Name}: form kodu FormCode<{EntityCodeGenerator.ClassName(app.Entity(form.Entity)!)}> sınıfından türemeli.");
            else if (EntityKey(record, entityAttribute) != form.Entity)
                yield return At(type, $"{type.Name}: '{key}' formu {EntityCodeGenerator.ClassName(app.Entity(form.Entity)!)} kaydıyla çalışır; FormCode<{record.Name}> olamaz.");
            else if (!classes.TryAdd(key, type)) yield return At(type, $"'{key}' formunun kodu birden fazla sınıfta: {classes[key].Name} ve {type.Name}.");
        }

        foreach (var form in app.Forms)
        {
            if (form.Tools.Count == 0 || app.Entity(form.Entity) is not { } entity) continue;
            var record = EntityCodeGenerator.ClassName(entity);
            if (!classes.TryGetValue(form.Key, out var type))
            {
                yield return new CodeDiagnostic("", 1, 1, 1, 1, "error", Code,
                    $"'{form.Key}' formunun araçları için kod yok: [Form(\"{form.Key}\")] ile işaretli bir FormCode<{record}> sınıfı gerekli.");
                continue;
            }
            foreach (var tool in form.Tools)
            {
                var found = type.GetMembers(tool.Method).OfType<IMethodSymbol>().Any(m =>
                    m is { DeclaredAccessibility: Accessibility.Public, IsStatic: false, Parameters: [var first, var second] }
                    && compilation.ClassifyConversion(Record(type, formCode)!, first.Type).IsImplicit
                    && SymbolEqualityComparer.Default.Equals(second.Type, context));
                if (!found)
                    yield return At(type, $"'{form.Key}' formunun '{tool.Label}' aracı {type.Name}.{tool.Method}({record} record, IAppContext context) metodunu çağırır; bu metot yok.");
            }
        }
    }

    /// <summary>The T of the FormCode&lt;T&gt; a class derives from.</summary>
    static ITypeSymbol? Record(INamedTypeSymbol type, INamedTypeSymbol formCode)
    {
        for (var b = type.BaseType; b is not null; b = b.BaseType)
            if (SymbolEqualityComparer.Default.Equals(b.OriginalDefinition, formCode)) return b.TypeArguments[0];
        return null;
    }

    static string? EntityKey(ITypeSymbol record, INamedTypeSymbol entityAttribute) =>
        record.GetAttributes().FirstOrDefault(a => SymbolEqualityComparer.Default.Equals(a.AttributeClass, entityAttribute))?.ConstructorArguments.FirstOrDefault().Value as string;

    static CodeDiagnostic At(INamedTypeSymbol type, string message)
    {
        var span = type.Locations[0].GetMappedLineSpan();
        return new CodeDiagnostic(span.Path ?? "", span.StartLinePosition.Line + 1, span.StartLinePosition.Character + 1,
            span.EndLinePosition.Line + 1, span.EndLinePosition.Character + 1, "error", Code, message);
    }
}

/// <summary>A public method of a form's code class that a tool may call: (record, IAppContext). Positions are 1-based.</summary>
public sealed record FormMethod(string Name, string Path, int Line, int Column);

/// <summary>
/// A form's code class: its file and position, the position of its closing brace, and the
/// methods a tool of the form may call.
/// </summary>
public sealed record FormCodeOutline(string Form, string Class, string Record, string Path, int Line, int Column, int EndLine, int EndColumn, IReadOnlyList<FormMethod> Methods);
