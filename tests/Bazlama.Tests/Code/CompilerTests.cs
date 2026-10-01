using Bazlama.Compiler;
using Bazlama.Tests.Engine;

namespace Bazlama.Tests.Code;

public sealed class CompilerTests
{
    static CompileOutput Compile(string code) =>
        AppCompiler.Compile("Test", [new SourceFile(EntityCodeGenerator.FileName, EntityCodeGenerator.Generate(Samples.App("siparis"))), new SourceFile("Code.cs", code)]);

    [Fact]
    public void Generated_entity_classes_compile_with_typed_properties_and_choice_constants()
    {
        var output = Compile("""
            public class Check
            {
                public bool Draft(Siparis s) => s.Durum == Siparis.DurumValues.Taslak && s.Tarih is DateOnly && s.Musteri is Guid;
                public decimal? Amount(Kalem k) => k.Miktar * k.BirimFiyat;
            }
            """);
        Assert.True(output.Success, string.Join("\n", output.Diagnostics.Select(d => d.Message)));
        Assert.Empty(output.Diagnostics); // no warnings either (the generated file opts into nullable)
    }

    [Theory]
    [InlineData("System.IO.File.ReadAllText(\"c:/secret.txt\")", "System.IO.File")]
    [InlineData("System.Environment.Exit(0)", "System.Environment")]
    [InlineData("typeof(string).GetMethods()", "System.Type")]
    [InlineData("System.Threading.Thread.Sleep(10)", "System.Threading.Thread")]
    [InlineData("System.AppDomain.CurrentDomain.ToString()", "System.AppDomain")]
    public void System_apis_are_refused(string expression, string name)
    {
        var output = Compile($$"""
            public class Bad { public object Run() { return {{expression}}; } }
            """);
        Assert.False(output.Success);
        var error = Assert.Single(output.Diagnostics, d => d.Code == "BZ0001");
        Assert.Contains(name, error.Message);
        Assert.Equal("Code.cs", error.Path);
        Assert.Equal(1, error.Line);
    }

    [Fact]
    public void Tasks_and_cancellation_are_allowed()
    {
        var output = Compile("""
            public class Ok { public async Task<int> Run(System.Threading.CancellationToken ct) { await Task.Delay(1, ct); return 1; } }
            """);
        Assert.True(output.Success, string.Join("\n", output.Diagnostics.Select(d => d.Message)));
    }

    [Fact]
    public void Compilation_is_deterministic_and_errors_are_positioned()
    {
        const string code = "public class A { public int X => 1; }";
        Assert.Equal(Compile(code).Hash, Compile(code).Hash);

        var broken = Compile("public class A\n{\n    public int X => ;\n}");
        var error = broken.Diagnostics.First(d => d.Severity == "error");
        Assert.Equal(("Code.cs", 3), (error.Path, error.Line));
    }
}
