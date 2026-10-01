using System.Text.Json.Nodes;
using Bazlama.Engine.Metadata;
using Bazlama.Engine.Schema;

namespace Bazlama.Tests.Engine;

public static class Samples
{
    /// <summary>samples/apps/&lt;name&gt;.json from the repository.</summary>
    public static string Json(string name)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "Bazlama.slnx"))) dir = dir.Parent;
        return File.ReadAllText(Path.Combine(dir!.FullName, "samples", "apps", $"{name}.json"));
    }

    public static JsonObject Node(string name) => JsonNode.Parse(Json(name))!.AsObject();

    public static AppDefinition App(string name) => AppDefinition.Parse(Json(name));
}

public sealed class MetadataTests
{
    [Fact]
    public void The_sample_app_is_valid() => Assert.Empty(MetadataValidator.Validate(Samples.App("siparis")));

    [Fact]
    public void Invalid_definitions_are_explained()
    {
        var app = Samples.Node("siparis");
        app["key"] = "Sipariş";
        var entities = app["entities"]!.AsArray();
        var fields = entities[0]!["fields"]!.AsArray();
        fields.Add(new JsonObject { ["key"] = "id", ["label"] = "Id" });
        fields.Add(new JsonObject { ["key"] = "ref", ["label"] = "Ref", ["type"] = "reference", ["reference"] = "yok" });
        fields.Add(new JsonObject { ["key"] = "tutar", ["label"] = "Tutar", ["type"] = "decimal", ["precision"] = 4, ["scale"] = 6 });
        fields.Add(new JsonObject { ["key"] = "secim", ["label"] = "Seçim", ["type"] = "choice" });

        var errors = MetadataValidator.Validate(AppDefinition.Parse(app.ToJsonString()));
        Assert.Contains(errors, e => e.StartsWith("App anahtarı geçersiz"));
        Assert.Contains(errors, e => e.Contains("alan 'id': bu ad sistem kolonu için ayrılmış"));
        Assert.Contains(errors, e => e.Contains("referans verilen entity bulunamadı: 'yok'"));
        Assert.Contains(errors, e => e.Contains("alan 'tutar': ondalık hassasiyeti geçersiz"));
        Assert.Contains(errors, e => e.Contains("alan 'secim': seçim alanının seçenekleri olmalı"));
    }

    [Fact]
    public void Details_inherit_scope_and_period_and_get_a_parent_column()
    {
        var app = Samples.App("siparis");
        var kalem = app.Entity("kalem")!;
        Assert.Equal(EntityScope.Location, app.EffectiveScope(kalem));
        Assert.True(app.EffectivePeriodBound(kalem));

        var table = SchemaBuilder.Build(app, kalem);
        Assert.Equal("app_siparis_kalem", table.Name);
        Assert.Equal(["company_id", "location_id", "period_id", "parent_id"], table.Columns.Select(c => c.Name).Skip(1).Take(4));
        Assert.Contains(table.ForeignKeys, f => f.Column == "parent_id" && f.RefTable == "app_siparis_siparis");
        Assert.Contains(table.ForeignKeys, f => f.Column == "urun" && f.RefTable == "app_siparis_urun");
    }

    [Fact]
    public void A_first_install_creates_tables_then_indexes_and_foreign_keys()
    {
        var plan = SchemaDiff.Compare(null, Samples.App("siparis"));
        Assert.Empty(plan.Errors);
        Assert.False(plan.HasDestructive);
        var kinds = plan.Changes.Select(c => c.Kind).ToList();
        Assert.Equal(4, kinds.Count(k => k == ChangeKind.CreateTable));
        Assert.True(kinds.LastIndexOf(ChangeKind.CreateTable) < kinds.IndexOf(ChangeKind.AddForeignKey));
    }

    [Fact]
    public void Upgrades_add_and_drop_columns_and_refuse_type_and_scope_changes()
    {
        var v1 = Samples.App("siparis");
        var node = Samples.Node("siparis");
        node["version"] = "1.1.0";
        var siparis = node["entities"]!.AsArray()[2]!.AsObject();
        var fields = siparis["fields"]!.AsArray();
        fields.RemoveAt(5); // aciklama
        siparis["form"] = null;
        fields.Add(new JsonObject { ["key"] = "oncelik", ["label"] = "Öncelik", ["type"] = "integer" });

        var plan = SchemaDiff.Compare(v1, AppDefinition.Parse(node.ToJsonString()));
        Assert.Empty(plan.Errors);
        Assert.Contains(plan.Changes, c => c.Kind == ChangeKind.AddColumn && c.Column == "oncelik" && !c.Destructive);
        Assert.Contains(plan.Changes, c => c.Kind == ChangeKind.DropColumn && c.Column == "aciklama" && c.Destructive);

        fields[0]!["type"] = "integer";
        siparis["scope"] = "company";
        var refused = SchemaDiff.Compare(v1, AppDefinition.Parse(node.ToJsonString()));
        Assert.Contains(refused.Errors, e => e.Contains("alan 'siparis_no': tipi değiştirilemez"));
        Assert.Contains(refused.Errors, e => e.Contains("kapsam değiştirilemez"));
    }
}
