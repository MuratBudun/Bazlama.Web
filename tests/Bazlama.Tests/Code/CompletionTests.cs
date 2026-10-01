using Bazlama.Compiler;
using Bazlama.Tests.Engine;

namespace Bazlama.Tests.Code;

public sealed class CompletionTests
{
    static readonly SourceFile Generated = new(EntityCodeGenerator.FileName, EntityCodeGenerator.Generate(Samples.App("siparis")));

    static async Task<IReadOnlyList<string>> At(string code, string marker = "|")
    {
        var lines = code.Split('\n');
        var line = Array.FindIndex(lines, l => l.Contains(marker));
        var column = lines[line].IndexOf(marker, StringComparison.Ordinal) + 1;
        var file = new SourceFile("Code.cs", code.Replace(marker, ""));
        var items = await CodeCompletion.CompleteAsync([Generated, file], "Code.cs", line + 1, column, null, TestContext.Current.CancellationToken);
        return [.. items.Select(i => i.InsertText)];
    }

    [Fact]
    public async Task Members_of_entity_classes_and_choice_constants_are_offered()
    {
        var members = await At("public class C { void M(Siparis s) { s.| } }");
        Assert.Contains("SiparisNo", members);
        Assert.Contains("Musteri", members);
        Assert.Contains("Durum", members);

        var choices = await At("public class C { string M() => Siparis.DurumValues.| ; }");
        Assert.Contains("Taslak", choices);
        Assert.Contains("Onaylandi", choices);
    }

    [Fact]
    public async Task Sdk_types_are_offered_where_a_type_is_expected()
    {
        var types = await At("public class C : | { }");
        Assert.Contains("EntityEvents", types);
        Assert.Contains("Siparis", types);
    }
}
