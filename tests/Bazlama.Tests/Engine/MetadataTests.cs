using System.Text.Json;
using System.Text.Json.Nodes;
using Bazlama.Engine.Metadata;
using Bazlama.Engine.Schema;

namespace Bazlama.Tests.Engine;

public static class Samples
{
    /// <summary>samples/apps/&lt;name&gt; in the repository: the app's definition, code and libraries.</summary>
    public static string Folder(string name)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "Bazlama.slnx"))) dir = dir.Parent;
        return Path.Combine(dir!.FullName, "samples", "apps", name);
    }

    /// <summary>samples/apps/&lt;name&gt;/app.json.</summary>
    public static string Json(string name) => File.ReadAllText(Path.Combine(Folder(name), "app.json"));

    /// <summary>
    /// The sample to install and change in a test, without its forms' tools: they need the
    /// sample's own code, and these tests bring theirs (see <see cref="Full"/>).
    /// </summary>
    public static JsonObject Node(string name)
    {
        var app = Full(name);
        foreach (var form in app["forms"]!.AsArray()) form!.AsObject().Remove("tools");
        return app;
    }

    /// <summary>The sample as it is in the repository.</summary>
    public static JsonObject Full(string name) => JsonNode.Parse(Json(name))!.AsObject();

    public static AppDefinition App(string name) => AppDefinition.Parse(Json(name));

    /// <summary>Takes a field out of its entity's lists, forms and title (before the field is dropped).</summary>
    public static void Unuse(JsonObject app, string entity, string field)
    {
        bool Of(JsonNode? x) => x!["entity"]!.GetValue<string>() == entity;
        void Remove(JsonArray keys)
        {
            foreach (var k in keys.Where(k => k!.GetValue<string>() == field).ToList()) keys.Remove(k);
        }
        foreach (var list in app["lists"]!.AsArray().Where(Of))
        {
            Remove(list!["columns"]!.AsArray());
            if (list["sortField"]?.GetValue<string>() == field) list.AsObject().Remove("sortField");
        }
        foreach (var form in app["forms"]!.AsArray().Where(Of))
            foreach (var section in form!["sections"]!.AsArray())
                Remove(section!["fields"]!.AsArray());
        var e = app["entities"]!.AsArray().First(x => x!["key"]!.GetValue<string>() == entity)!.AsObject();
        if (e["titleField"]?.GetValue<string>() == field) e.Remove("titleField");
    }
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
    public void Forms_are_checked_against_their_entity()
    {
        var app = Samples.Node("siparis");
        var forms = app["forms"]!.AsArray();
        forms.Add(new JsonObject { ["key"] = "musteri", ["name"] = "Kopya", ["entity"] = "musteri", ["sections"] = new JsonArray(new JsonObject { ["fields"] = new JsonArray("unvan") }) });
        forms.Add(new JsonObject { ["key"] = "hizli", ["name"] = "", ["entity"] = "yok" });
        forms.Add(new JsonObject
        {
            ["key"] = "kisa",
            ["name"] = "Kısa sipariş",
            ["entity"] = "siparis",
            ["sections"] = new JsonArray(
                new JsonObject { ["fields"] = new JsonArray("siparis_no", "tutar"), ["columns"] = 4 },
                new JsonObject { ["fields"] = new JsonArray("siparis_no") }),
        });
        forms.Add(new JsonObject { ["key"] = "bos", ["name"] = "Boş", ["entity"] = "urun", ["sections"] = new JsonArray(new JsonObject { ["fields"] = new JsonArray() }) });

        var errors = MetadataValidator.Validate(AppDefinition.Parse(app.ToJsonString()));
        Assert.Contains("Form anahtarı birden fazla kez kullanılmış: 'musteri'.", errors);
        Assert.Contains("Form 'hizli': ad gerekli.", errors);
        Assert.Contains("Form 'hizli': entity bulunamadı: 'yok'.", errors);
        Assert.Contains("Form 'kisa': formdaki alan bulunamadı: 'tutar'.", errors);
        Assert.Contains("Form 'kisa': bölüm sütun sayısı 1 ile 3 arasında olmalı.", errors);
        Assert.Contains("Form 'kisa': alan formda birden fazla kez var: 'siparis_no'.", errors);
        Assert.Contains("Form 'bos': en az bir alan içermeli.", errors);
    }

    [Fact]
    public void A_form_field_may_span_columns_of_its_section()
    {
        var app = Samples.Node("siparis");
        var sections = app["forms"]!.AsArray().Single(f => f!["key"]!.GetValue<string>() == "siparis")!["sections"]!.AsArray();
        // A key alone, or the key with its width.
        sections[0]!["fields"] = new JsonArray("siparis_no", new JsonObject { ["field"] = "musteri", ["span"] = 2 }, "tarih", "teslim", "durum", "toplam");

        var parsed = AppDefinition.Parse(app.ToJsonString());
        Assert.Empty(MetadataValidator.Validate(parsed));
        var fields = parsed.Form("siparis")!.Sections[0].Fields;
        Assert.Equal(["siparis_no", "musteri", "tarih", "teslim", "durum", "toplam"], fields.Select(f => f.Field));
        Assert.Equal([null, 2, null, null, null, null], fields.Select(f => f.Span));

        // Written back the same way: plain keys stay plain.
        var written = JsonNode.Parse(parsed.ToJson())!["forms"]!.AsArray().Single(f => f!["key"]!.GetValue<string>() == "siparis")!["sections"]![0]!["fields"]!.AsArray();
        Assert.Equal(JsonValueKind.String, written[0]!.GetValueKind());
        Assert.Equal("musteri", written[1]!["field"]!.GetValue<string>());
        Assert.Equal(2, written[1]!["span"]!.GetValue<int>());

        // Wider than the section: refused.
        sections[0]!["fields"]![1]!["span"] = 3;
        Assert.Contains("Form 'siparis': 'musteri' alanının genişliği 1 ile bölümün sütun sayısı (2) arasında olmalı.",
            MetadataValidator.Validate(AppDefinition.Parse(app.ToJsonString())));
    }

    [Fact]
    public void Forms_and_lists_inside_entities_become_app_forms_and_lists()
    {
        // The shape before app-level forms and lists: one of each inside an entity.
        var app = Samples.Node("siparis");
        var musteri = app["entities"]!.AsArray()[0]!.AsObject();
        musteri["form"] = new JsonObject { ["sections"] = new JsonArray(new JsonObject { ["title"] = "Genel", ["fields"] = new JsonArray("unvan", "sehir") }) };
        var urun = app["entities"]!.AsArray()[1]!.AsObject();
        urun["form"] = new JsonObject { ["sections"] = new JsonArray(new JsonObject { ["fields"] = new JsonArray("ad") }) };
        urun["list"] = new JsonObject { ["columns"] = new JsonArray("kod", "ad"), ["sortField"] = "ad", ["sortDescending"] = true };
        app["forms"]!.AsArray()[0]!["name"] = "Mevcut";
        var lists = app["lists"]!.AsArray();
        lists.Remove(lists.First(l => l!["key"]!.GetValue<string>() == "urun"));

        var parsed = AppDefinition.Parse(app.ToJsonString());
        Assert.Empty(MetadataValidator.Validate(parsed));
        // An app form with the same key wins; the other one moves.
        Assert.Equal("Mevcut", parsed.Form("musteri")!.Name);
        var moved = parsed.Form("urun")!;
        Assert.Equal(("Ürün", "urun"), (moved.Name, moved.Entity));
        Assert.Equal(["ad"], moved.Sections.Single().Fields.Select(f => f.Field));
        // A list is named after the entity's plural.
        var list = parsed.List("urun")!;
        Assert.Equal(("Ürünler", "urun", "ad", true), (list.Name, list.Entity, list.SortField, list.SortDescending));
        Assert.Equal(["kod", "ad"], list.Columns);
        var upgraded = JsonNode.Parse(AppDefinition.Upgrade(app.ToJsonString()))!["entities"]!.AsArray();
        Assert.DoesNotContain(upgraded, e => e!.AsObject().ContainsKey("form") || e.AsObject().ContainsKey("list"));
        Assert.Equal("{ broken", AppDefinition.Upgrade("{ broken"));
    }

    [Fact]
    public void Lists_and_the_menu_are_checked()
    {
        var app = Samples.Node("siparis");
        app["lists"]!.AsArray().Add(new JsonObject
        {
            ["key"] = "hatali",
            ["name"] = "Hatalı",
            ["entity"] = "siparis",
            ["columns"] = new JsonArray("siparis_no", "yok", "siparis_no"),
            ["sortField"] = "yok",
            ["form"] = "musteri",
        });
        app["lists"]!.AsArray().Add(new JsonObject { ["key"] = "bos", ["name"] = "", ["entity"] = "urun", ["columns"] = new JsonArray() });
        var menu = app["menu"]!.AsArray();
        menu.Add(new JsonObject { ["label"] = "Kalemler", ["list"] = "kalem" });
        menu.Add(new JsonObject { ["label"] = "İkisi", ["list"] = "urun", ["form"] = "siparis" });
        menu.Add(new JsonObject { ["label"] = "Kayıp", ["list"] = "yok" });
        menu.Add(new JsonObject
        {
            ["label"] = "Derin",
            ["items"] = new JsonArray(new JsonObject { ["label"] = "2", ["items"] = new JsonArray(new JsonObject { ["label"] = "3", ["items"] = new JsonArray() }) }),
        });

        var errors = MetadataValidator.Validate(AppDefinition.Parse(app.ToJsonString()));
        Assert.Contains("Liste 'hatali': listedeki alan bulunamadı: 'yok'.", errors);
        Assert.Contains("Liste 'hatali': sütun birden fazla kez var: 'siparis_no'.", errors);
        Assert.Contains("Liste 'hatali': sıralama alanı bulunamadı: 'yok'.", errors);
        Assert.Contains("Liste 'hatali': form başka bir entity'nin: 'musteri'.", errors);
        Assert.Contains("Liste 'bos': ad gerekli.", errors);
        Assert.Contains("Liste 'bos': en az bir sütun içermeli.", errors);
        Assert.Contains("Menü 'Kalemler': detay entity'nin listesi menüde açılamaz ('kalem').", errors);
        Assert.Contains("Menü 'İkisi': bir grup (alt öğeler), bir liste ya da bir form olmalı.", errors);
        Assert.Contains("Menü 'Kayıp': liste bulunamadı: 'yok'.", errors);
        Assert.Contains("Menü '3': menü en fazla 3 seviye olabilir.", errors);
    }

    [Fact]
    public void Modals_have_fields_of_their_own_and_forms_have_tools()
    {
        // The sample has both; they survive a round trip.
        var sample = Samples.App("siparis");
        Assert.Equal(["TeslimOner", "MusteriOzeti", "NotEkle", "TeslimatPlanla", "MusteriDegistir", "NedeniyleIptalEt"], sample.Form("siparis")!.Tools.Select(t => t.Method));
        var again = AppDefinition.Parse(sample.ToJson());
        Assert.Equal(["baslangic", "bitis", "yalniz_onayli"], again.Modal("tarih_araligi")!.Fields.Select(f => f.Key));
        Assert.Equal(2, again.Modal("tarih_araligi")!.Sections[0].Fields[2].Span);
        Assert.Equal("Göster", again.Modal("tarih_araligi")!.OkText);
        Assert.Equal(sample.ToJson(), sample.WithVersion(sample.Version).ToJson());
        Assert.Equal(["tarih_araligi", "siparis_notu", "teslimat", "musteri_sec", "iptal_nedeni", "kapsam"], sample.AsPreview().Modals.Select(m => m.Key));

        var app = Samples.Full("siparis");
        var form = app["forms"]!.AsArray().Single(f => f!["key"]!.GetValue<string>() == "siparis")!;
        form["tools"]!.AsArray().Add(new JsonObject { ["label"] = "Kötü", ["method"] = "2 kelime" });
        form["tools"]!.AsArray().Add(new JsonObject { ["label"] = "Tekrar", ["method"] = "TeslimOner" });
        // An entity may not hold organization fields: its scope does that.
        app["entities"]!.AsArray()[0]!["fields"]!.AsArray().Add(new JsonObject { ["key"] = "firma", ["label"] = "Firma", ["type"] = "company" });
        var modals = app["modals"]!.AsArray();
        modals.Add(new JsonObject
        {
            ["key"] = "secim",
            ["name"] = "Seçim",
            ["fields"] = new JsonArray(
                new JsonObject { ["key"] = "firma", ["label"] = "Firma", ["type"] = "company", ["required"] = true },
                new JsonObject { ["key"] = "donem", ["label"] = "Dönem", ["type"] = "period" },
                new JsonObject { ["key"] = "urun", ["label"] = "Ürün", ["type"] = "reference", ["reference"] = "yok" }),
            ["sections"] = new JsonArray(new JsonObject { ["fields"] = new JsonArray("donem", new JsonObject { ["field"] = "kayip", ["span"] = 5 }) }),
        });
        modals.Add(new JsonObject { ["key"] = "musteri", ["name"] = "", ["fields"] = new JsonArray() });

        var errors = MetadataValidator.Validate(AppDefinition.Parse(app.ToJsonString()));
        Assert.Contains("Form 'siparis': araç 'Kötü' için metot adı geçersiz: '2 kelime' (bir C# metot adı olmalı).", errors);
        Assert.Contains("Form 'siparis': aynı metot birden fazla araçta: 'TeslimOner'.", errors);
        Assert.Contains("Entity 'musteri', alan 'firma': firma, lokasyon, plant ve dönem alanları yalnız modallarda kullanılır (entity'nin kapsamı bunları kendisi tutar).", errors);
        Assert.Contains("Modal 'secim', alan 'urun': referans verilen entity bulunamadı: 'yok'.", errors);
        Assert.Contains("Modal 'secim': yerleşimdeki alan bulunamadı: 'kayip'.", errors);
        Assert.Contains("Modal 'secim': 'kayip' alanının genişliği 1 ile bölümün sütun sayısı (2) arasında olmalı.", errors);
        Assert.Contains("Modal 'secim': zorunlu alan yerleşimde yok: 'firma'.", errors);
        Assert.Contains("Modal 'musteri': bu anahtar bir entity'de kullanılıyor.", errors);
        Assert.Contains("Modal 'musteri': ad gerekli.", errors);
        Assert.Contains("Modal 'musteri': en az bir alan tanımlanmalı.", errors);
        Assert.DoesNotContain(errors, e => e.StartsWith("Modal 'tarih_araligi'"));
        Assert.DoesNotContain(errors, e => e.Contains("alan 'donem'"));
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
        node["version"] = "2.2.0";
        var siparis = node["entities"]!.AsArray()[2]!.AsObject();
        var fields = siparis["fields"]!.AsArray();
        fields.RemoveAt(5); // aciklama
        Samples.Unuse(node, "siparis", "aciklama");
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
