using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Completion;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Host.Mef;
using Microsoft.CodeAnalysis.Text;

namespace Bazlama.Compiler;

/// <summary>A completion suggestion for the editor. Kind is Roslyn's tag (Class, Method, Property, Keyword…).</summary>
public sealed record CompletionEntry(string Label, string InsertText, string FilterText, string Kind, string SortText);

/// <summary>
/// Completion with Roslyn's CompletionService over an in-memory workspace of the (unsaved) files,
/// the same references as compilation (SDK, generated entity classes, libraries).
/// </summary>
public static class CodeCompletion
{
    public static async Task<IReadOnlyList<CompletionEntry>> CompleteAsync(
        IReadOnlyList<SourceFile> files, string path, int line, int column, IEnumerable<MetadataReference>? references, CancellationToken ct)
    {
        using var workspace = new AdhocWorkspace(MefHostServices.DefaultHost);
        var project = workspace.AddProject(ProjectInfo.Create(
            ProjectId.CreateNewId(), VersionStamp.Default, "Completion", "Completion", LanguageNames.CSharp,
            compilationOptions: AppCompiler.Options,
            parseOptions: new CSharpParseOptions(LanguageVersion.Latest),
            metadataReferences: [.. AppCompiler.References, .. references ?? []]));
        Document? target = null;
        foreach (var f in files)
        {
            var doc = workspace.AddDocument(project.Id, f.Path, SourceText.From(f.Content));
            if (f.Path == path) target = doc;
        }
        if (target is null) return [];

        var text = await target.GetTextAsync(ct);
        if (line < 1 || line > text.Lines.Count) return [];
        var lineInfo = text.Lines[line - 1];
        var position = Math.Min(lineInfo.Start + Math.Max(0, column - 1), lineInfo.End);
        var service = CompletionService.GetService(target);
        if (service is null) return [];
        var list = await service.GetCompletionsAsync(target, position, cancellationToken: ct);
        return [.. list.ItemsList
            .Take(400)
            .Select(i => new CompletionEntry(
                i.DisplayTextPrefix + i.DisplayText + i.DisplayTextSuffix,
                i.DisplayText,
                i.FilterText,
                i.Tags.FirstOrDefault() ?? "Text",
                i.SortText))];
    }
}
